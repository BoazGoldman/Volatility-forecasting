import time
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import os
import math

import pandas as pd

from src.pipeline import ohlcv_1s_to_10s, run_garch_pipeline
from src.live_garch import (
    LiveGarch11,
    fetch_recent_bars,
    fetch_recent_10s_bars,
    floor_dt_to_step,
    latest_closed_10s_return_pct,
    next_10s_boundary_utc,
)
from src.storage import (
    init_forecasts_db,
    keep_latest_n_forecasts,
    keep_only_timestamps,
    read_selected_forecasts,
    read_forecast_at,
    select_three_midnights_plus_latest,
    upsert_forecasts,
    insert_forecast_error,
    keep_latest_n_forecast_errors,
    read_latest_forecast_errors,
)


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_str(name: str, default: str) -> str:
    raw = os.getenv(name)
    if raw is None:
        return default
    val = raw.strip()
    return val if val else default


HOURLY_FORECAST_INTERVAL_SEC = _env_int("HOURLY_FORECAST_INTERVAL_SEC", 3600)
HOURLY_REFIT_INTERVAL_SEC = _env_int("HOURLY_REFIT_INTERVAL_SEC", 7 * 24 * 60 * 60)
HOURLY_FETCH_LIMIT = _env_int("HOURLY_FETCH_LIMIT", 2000)
"""How often to refit the 10s-candle GARCH (each run fetches fresh 1s data). Lower if you want; 10s fits are CPU-heavy."""
TEN_SEC_MODEL_INTERVAL_SEC = _env_int("TEN_SEC_MODEL_INTERVAL_SEC", 10)
TEN_SEC_LOOKBACK_SECONDS = _env_int("TEN_SEC_LOOKBACK_SECONDS", 30)
TEN_SEC_REFIT_INTERVAL_SEC = _env_int("TEN_SEC_REFIT_INTERVAL_SEC", 1800)
TEN_SEC_FETCH_LIMIT_1S = _env_int("TEN_SEC_FETCH_LIMIT_1S", 1000)
TEN_SEC_BOUNDARY_DELAY_MS = _env_int("TEN_SEC_BOUNDARY_DELAY_MS", 300)
TEN_SEC_DB_TIMEFRAME = _env_str("TEN_SEC_DB_TIMEFRAME", "10s")
TEN_SEC_KEEP_ROWS = _env_int("TEN_SEC_KEEP_ROWS", 6)
DB_PATH = _env_str("DB_PATH", "data/forecasts.db")
SYMBOL = _env_str("SYMBOL", "BTC/USDT")
TIMEFRAME = _env_str("TIMEFRAME", "1h")
WEB_FORECAST_JSON = _env_str("WEB_FORECAST_JSON", "web/public/forecasts.json")
WEB_FORECAST_10S_JSON = _env_str("WEB_FORECAST_10S_JSON", "web/public/forecasts_10s.json")
WEB_ERRORS_10S_JSON = _env_str("WEB_ERRORS_10S_JSON", "web/public/errors_10s.json")
WEB_ERRORS_24H_JSON = _env_str("WEB_ERRORS_24H_JSON", "web/public/errors_24h.json")

ERROR_LOG_KEEP_ROWS = _env_int("ERROR_LOG_KEEP_ROWS", 30)
DAILY_ERROR_DELAY_MS = _env_int("DAILY_ERROR_DELAY_MS", 1500)


def export_forecasts_json(
    db_path: str,
    out_path: str,
    symbol: str,
    timeframe: str,
    *,
    forecasts_newest_first: bool = False,
    extra: dict | None = None,
) -> None:
    df = read_selected_forecasts(db_path=db_path, symbol=symbol, timeframe=timeframe)
    payload: dict = {
        "symbol": symbol,
        "timeframe": timeframe,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "forecasts": [],
    }
    if extra:
        payload.update(extra)
    if not df.empty:
        rows = [
            {
                "timestamp": pd.to_datetime(row["timestamp"], utc=True).isoformat(),
                "garch_forecast": float(row["garch_forecast"]),
            }
            for _, row in df.iterrows()
        ]
        if forecasts_newest_first:
            rows.reverse()
        payload["forecasts"] = rows

    target = Path(out_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def export_errors_json(*, series: str, out_path: str) -> None:
    df = read_latest_forecast_errors(db_path=DB_PATH, symbol=SYMBOL, series=series, limit=ERROR_LOG_KEEP_ROWS)
    payload = {
        "symbol": SYMBOL,
        "series": series,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "errors": [],
    }
    if not df.empty:
        payload["errors"] = [
            {
                "event_time": pd.to_datetime(row["event_time"], utc=True).isoformat(),
                "outside_frac": None if pd.isna(row["outside_frac"]) else float(row["outside_frac"]),
                "side": None if pd.isna(row["side"]) else str(row["side"]),
            }
            for _, row in df.iterrows()
        ]
    target = Path(out_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def run_daily_24h_error_tick(*, last_scored_day: datetime | None) -> datetime | None:
    """
    Once per day (after 00:00 UTC), score yesterday's daily close vs the midnight 24h band.

    Uses:
      - daily candles (1d) for closes (yesterday close and day-before close)
      - forecast σ stored at `forecast_time = yesterday 00:00 UTC` in the `1h` forecast series
        (that's the row the 7d chart uses as "midnight forecast").
    Writes to error series "24h" and exports `errors_24h.json`.
    """
    now_utc = datetime.now(timezone.utc)
    today_midnight = floor_dt_to_step(now_utc, 24 * 60 * 60)
    # We can only score "yesterday" after today's midnight has passed.
    if now_utc < today_midnight + timedelta(milliseconds=DAILY_ERROR_DELAY_MS):
        return last_scored_day

    day_to_score = today_midnight - timedelta(days=1)  # yesterday 00:00
    if last_scored_day is not None and day_to_score <= last_scored_day:
        return last_scored_day

    try:
        bars_1d = fetch_recent_bars(
            symbol=SYMBOL, exchange_name="binance", timeframe="1d", limit=10
        )
    except Exception as exc:
        print(f"24h daily error: fetch 1d failed: {exc}")
        return last_scored_day

    if bars_1d.empty:
        return last_scored_day

    # Find yesterday candle and previous candle by open timestamp (00:00 UTC).
    ts = pd.to_datetime(bars_1d["timestamp"], utc=True, errors="coerce")
    work = bars_1d.assign(timestamp=ts).dropna(subset=["timestamp"]).sort_values("timestamp")
    y_row = work[work["timestamp"] == pd.Timestamp(day_to_score)].tail(1)
    prev_row = work[work["timestamp"] == pd.Timestamp(day_to_score - timedelta(days=1))].tail(1)
    if y_row.empty or prev_row.empty:
        return last_scored_day

    y_close = float(y_row.iloc[0]["close"])
    base_close = float(prev_row.iloc[0]["close"])
    if y_close <= 0 or base_close <= 0:
        return last_scored_day

    sigma = read_forecast_at(
        db_path=DB_PATH,
        symbol=SYMBOL,
        timeframe=TIMEFRAME,
        forecast_time_iso=day_to_score.isoformat(),
    )
    if sigma is None or not (sigma > 0):
        return last_scored_day

    low = base_close * (1 - sigma)
    high = base_close * (1 + sigma)
    lo = min(low, high)
    hi = max(low, high)
    side = "inside"
    outside_frac = 0.0
    if y_close > hi:
        side = "above"
        outside_frac = (y_close - hi) / base_close
    elif y_close < lo:
        side = "below"
        outside_frac = (lo - y_close) / base_close

    try:
        insert_forecast_error(
            db_path=DB_PATH,
            symbol=SYMBOL,
            series="24h",
            event_time_iso=day_to_score.isoformat(),
            anchor_price=base_close,
            actual_price=y_close,
            sigma=sigma,
            low=lo,
            high=hi,
            outside_frac=outside_frac,
            side=side,
        )
        keep_latest_n_forecast_errors(
            db_path=DB_PATH, symbol=SYMBOL, series="24h", n=ERROR_LOG_KEEP_ROWS
        )
        export_errors_json(series="24h", out_path=WEB_ERRORS_24H_JSON)
        print(
            f"24h daily error: {day_to_score.date().isoformat()} "
            f"{'within band' if side == 'inside' else f'{outside_frac*100:.3f}% {side}'}"
        )
    except Exception as exc:
        print(f"24h daily error: write/export failed: {exc}")
        return last_scored_day

    return day_to_score


def run_hourly_forecast_once() -> None:
    started_at = datetime.now(timezone.utc).isoformat()
    print(f"[{started_at}] Running hourly forecast...")

    df = run_garch_pipeline(
        symbol=SYMBOL,
        exchange_name="binance",
        timeframe=TIMEFRAME,
        limit=HOURLY_FETCH_LIMIT,
        garch_horizon_step=24,
    )
    selected_rows = select_three_midnights_plus_latest(df)
    if selected_rows.empty:
        print("No valid forecast rows found in this run. DB unchanged.")
        return

    upserted = upsert_forecasts(
        selected_rows,
        db_path=DB_PATH,
        symbol=SYMBOL,
        timeframe=TIMEFRAME,
    )
    keep_ts = [
        pd.to_datetime(ts, utc=True).isoformat()
        for ts in selected_rows["timestamp"].tolist()
    ]
    removed = keep_only_timestamps(
        DB_PATH,
        symbol=SYMBOL,
        timeframe=TIMEFRAME,
        timestamps_iso=keep_ts,
    )
    export_forecasts_json(
        db_path=DB_PATH,
        out_path=WEB_FORECAST_JSON,
        symbol=SYMBOL,
        timeframe=TIMEFRAME,
    )
    print(selected_rows)
    print(f"DB upserts: {upserted}, pruned: {removed}, path: {DB_PATH}")


def _export_hourly_forecasts_json(extra: dict | None = None) -> None:
    export_forecasts_json(
        db_path=DB_PATH,
        out_path=WEB_FORECAST_JSON,
        symbol=SYMBOL,
        timeframe=TIMEFRAME,
        extra=extra,
    )


def _keep_three_midnights_plus_latest_hourly(latest_ts_iso: str) -> None:
    df_existing = read_selected_forecasts(DB_PATH, symbol=SYMBOL, timeframe=TIMEFRAME)
    if df_existing.empty:
        keep_only_timestamps(
            DB_PATH, symbol=SYMBOL, timeframe=TIMEFRAME, timestamps_iso=[latest_ts_iso]
        )
        return

    df_existing["timestamp"] = pd.to_datetime(
        df_existing["timestamp"], utc=True, errors="coerce"
    )
    df_existing = df_existing.dropna(subset=["timestamp"]).sort_values("timestamp")
    midnights = df_existing[
        (df_existing["timestamp"].dt.hour == 0)
        & (df_existing["timestamp"].dt.minute == 0)
        & (df_existing["timestamp"].dt.second == 0)
    ].tail(3)

    keep_ts = [ts.isoformat() for ts in midnights["timestamp"].tolist()]
    keep_ts.append(latest_ts_iso)
    keep_only_timestamps(DB_PATH, symbol=SYMBOL, timeframe=TIMEFRAME, timestamps_iso=keep_ts)


def run_hourly_live_forecast_tick(
    live: LiveGarch11 | None,
    *,
    force_refit: bool,
) -> LiveGarch11 | None:
    """
    Produce a fresh 24h (24-step) σ each hour, but only refit params weekly.

    - Refit: fit GARCH(1,1) params on recent 1h bars (slow, weekly).
    - Hourly tick: update conditional variance with latest closed 1h return (fast),
      then output σ over the next 24 hours as sqrt(sum of step variances).
    """
    now_utc = datetime.now(timezone.utc)
    bar_end = floor_dt_to_step(now_utc, 60 * 60)

    try:
        bars_1h = fetch_recent_bars(
            symbol=SYMBOL,
            exchange_name="binance",
            timeframe=TIMEFRAME,
            limit=HOURLY_FETCH_LIMIT,
        )
    except Exception as exc:
        print(f"1h live tick: fetch failed: {exc}")
        return live

    if force_refit or live is None:
        try:
            live = LiveGarch11.fit_from_10s_bars(bars_1h)  # works for any bar size
            if not bars_1h.empty:
                last_ts = pd.to_datetime(
                    bars_1h["timestamp"].iloc[-1], utc=True, errors="coerce"
                )
                if pd.notna(last_ts):
                    live.last_bar_end = last_ts.to_pydatetime()
            print("1h live: refit ok")
        except Exception as exc:
            print(f"1h live: refit failed: {exc}")
            return None

    if live.last_bar_end is not None and bar_end <= live.last_bar_end:
        return live

    # Compute percent log-return for the latest closed hour.
    ts = pd.to_datetime(bars_1h["timestamp"], utc=True, errors="coerce")
    work = bars_1h.assign(timestamp=ts).dropna(subset=["timestamp"]).sort_values("timestamp")
    end_ts = pd.Timestamp(bar_end)
    row_t = work[work["timestamp"] == end_ts].tail(1)
    row_prev = work[work["timestamp"] == (end_ts - pd.Timedelta(hours=1))].tail(1)
    if row_t.empty or row_prev.empty:
        return live

    close_t = float(row_t.iloc[0]["close"])
    close_prev = float(row_prev.iloc[0]["close"])
    if close_t <= 0 or close_prev <= 0:
        return live

    r_pct = float(math.log(close_t / close_prev) * 100.0)
    live.update_with_return_pct(r_pct)
    sigma_24h = live.sigma_horizon(24)
    if not pd.notna(sigma_24h) or not (sigma_24h > 0):
        return live

    ts_iso = bar_end.isoformat()
    df_out = pd.DataFrame([{"timestamp": ts_iso, "garch_forecast": float(sigma_24h)}])
    upsert_forecasts(df_out, db_path=DB_PATH, symbol=SYMBOL, timeframe=TIMEFRAME)
    _keep_three_midnights_plus_latest_hourly(ts_iso)
    _export_hourly_forecasts_json(
        extra={
            "mode": "live_garch11",
            "horizon_steps": 24,
            "forecast_interval_sec": HOURLY_FORECAST_INTERVAL_SEC,
            "refit_interval_sec": HOURLY_REFIT_INTERVAL_SEC,
        }
    )

    live.last_bar_end = bar_end
    print(f"1h live: wrote 24h σ at {ts_iso} σ={sigma_24h:.6f}")
    return live


def run_ten_second_bar_forecast_once() -> None:
    started_at = datetime.now(timezone.utc).isoformat()
    print(f"[{started_at}] Running 10s-bar GARCH (from 1s klines)...")

    baseline_window_10s_bars = max(1, TEN_SEC_LOOKBACK_SECONDS // 10)
    df = run_garch_pipeline(
        symbol=SYMBOL,
        exchange_name="binance",
        timeframe="1s",
        limit=1000,
        preprocess=ohlcv_1s_to_10s,
        baseline_window_step=baseline_window_10s_bars,
        garch_horizon_step=1,
        eval_window_step=1,
        eval_target_shift_steps=1,
    )
    latest = df.tail(1)
    if latest.empty or latest["garch_forecast"].isna().all():
        print("No 10s forecast row to save.")
        return

    upserted = upsert_forecasts(
        latest,
        db_path=DB_PATH,
        symbol=SYMBOL,
        timeframe=TEN_SEC_DB_TIMEFRAME,
    )
    pruned = keep_latest_n_forecasts(
        DB_PATH,
        symbol=SYMBOL,
        timeframe=TEN_SEC_DB_TIMEFRAME,
        n=TEN_SEC_KEEP_ROWS,
    )
    export_forecasts_json(
        db_path=DB_PATH,
        out_path=WEB_FORECAST_10S_JSON,
        symbol=SYMBOL,
        timeframe=TEN_SEC_DB_TIMEFRAME,
        forecasts_newest_first=True,
        extra={
            "source_timeframe": "1s",
            "bar_seconds": 10,
            "garch_horizon_steps": 1,
            "kept_forecasts": TEN_SEC_KEEP_ROWS,
        },
    )
    print(latest)
    print(
        f"10s DB upserts: {upserted}, pruned older rows: {pruned}, "
        f"keeping last {TEN_SEC_KEEP_ROWS}"
    )


def _export_latest_10s_sigma_to_web() -> None:
    export_forecasts_json(
        db_path=DB_PATH,
        out_path=WEB_FORECAST_10S_JSON,
        symbol=SYMBOL,
        timeframe=TEN_SEC_DB_TIMEFRAME,
        forecasts_newest_first=True,
        extra={
            "source_timeframe": "1s",
            "bar_seconds": 10,
            "garch_horizon_steps": 1,
            "kept_forecasts": TEN_SEC_KEEP_ROWS,
            "mode": "live_garch11",
            "refit_interval_sec": TEN_SEC_REFIT_INTERVAL_SEC,
            "boundary_delay_ms": TEN_SEC_BOUNDARY_DELAY_MS,
        },
    )


def run_ten_second_live_forecast_tick(
    live: LiveGarch11 | None,
    *,
    force_refit: bool,
) -> LiveGarch11 | None:
    """
    Run one boundary-aligned live tick:
      - refit occasionally (slow)
      - update variance with newest closed 10s return (fast)
      - write σ forecast for NEXT 10s bar to DB + JSON
    """
    now_utc = datetime.now(timezone.utc)
    bar_end = floor_dt_to_step(now_utc, 10)

    try:
        bars_10s = fetch_recent_10s_bars(
            symbol=SYMBOL, exchange_name="binance", limit_1s=TEN_SEC_FETCH_LIMIT_1S
        )
    except Exception as exc:
        print(f"10s live tick: fetch failed: {exc}")
        return live

    if force_refit or live is None:
        try:
            live = LiveGarch11.fit_from_10s_bars(bars_10s)
            # Seed last_bar_end so we don't immediately double-count the last bar.
            if not bars_10s.empty:
                last_ts = pd.to_datetime(bars_10s["timestamp"].iloc[-1], utc=True, errors="coerce")
                if pd.notna(last_ts):
                    live.last_bar_end = last_ts.to_pydatetime()
            print("10s live: refit ok")
        except Exception as exc:
            print(f"10s live: refit failed: {exc}")
            return None

    if live.last_bar_end is not None and bar_end <= live.last_bar_end:
        return live

    rr = latest_closed_10s_return_pct(bars_10s, bar_end=bar_end)
    if rr is None:
        return live

    r_pct, close_t = rr

    # If we already had a sigma for this bar_end (from previous tick), log realized error now.
    if hasattr(live, "_prev_sigma_next") and hasattr(live, "_prev_anchor_close") and hasattr(live, "_prev_forecast_for"):
        try:
            prev_for: datetime = getattr(live, "_prev_forecast_for")
            prev_sigma: float | None = getattr(live, "_prev_sigma_next")
            prev_anchor: float | None = getattr(live, "_prev_anchor_close")
            if prev_sigma is not None and prev_anchor is not None and prev_for == bar_end:
                low = prev_anchor * (1 - prev_sigma)
                high = prev_anchor * (1 + prev_sigma)
                side = "inside"
                outside_frac = 0.0
                if close_t > max(low, high):
                    side = "above"
                    outside_frac = (close_t - max(low, high)) / prev_anchor
                elif close_t < min(low, high):
                    side = "below"
                    outside_frac = (min(low, high) - close_t) / prev_anchor
                insert_forecast_error(
                    db_path=DB_PATH,
                    symbol=SYMBOL,
                    series="10s",
                    event_time_iso=bar_end.isoformat(),
                    anchor_price=prev_anchor,
                    actual_price=close_t,
                    sigma=prev_sigma,
                    low=min(low, high),
                    high=max(low, high),
                    outside_frac=outside_frac,
                    side=side,
                )
                keep_latest_n_forecast_errors(
                    db_path=DB_PATH, symbol=SYMBOL, series="10s", n=ERROR_LOG_KEEP_ROWS
                )
                export_errors_json(series="10s", out_path=WEB_ERRORS_10S_JSON)
        except Exception as exc:
            print(f"10s live: error log failed: {exc}")
    sigma_next = live.update_with_return_pct(r_pct)
    if not pd.notna(sigma_next) or not (sigma_next > 0):
        return live

    forecast_time = bar_end + timedelta(seconds=10)
    df_out = pd.DataFrame(
        [{"timestamp": forecast_time.isoformat(), "garch_forecast": float(sigma_next)}]
    )
    upserted = upsert_forecasts(
        df_out,
        db_path=DB_PATH,
        symbol=SYMBOL,
        timeframe=TEN_SEC_DB_TIMEFRAME,
    )
    keep_latest_n_forecasts(
        DB_PATH, symbol=SYMBOL, timeframe=TEN_SEC_DB_TIMEFRAME, n=TEN_SEC_KEEP_ROWS
    )
    _export_latest_10s_sigma_to_web()

    live.last_bar_end = bar_end
    if upserted:
        print(f"10s live: wrote forecast for {forecast_time.isoformat()} σ={sigma_next:.6f}")

    # Remember what we just forecasted so we can score it once that bar closes.
    setattr(live, "_prev_forecast_for", forecast_time)
    setattr(live, "_prev_sigma_next", float(sigma_next))
    setattr(live, "_prev_anchor_close", float(close_t))
    return live


def run_hourly_forecast_loop() -> None:
    init_forecasts_db(DB_PATH)

    next_hourly_forecast = 0.0
    last_hourly_refit_at = -1e18
    next_10s_wall = datetime.now(timezone.utc)
    last_refit_at = -1e18
    live: LiveGarch11 | None = None
    live_hourly: LiveGarch11 | None = None
    last_daily_scored: datetime | None = None

    while True:
        now_mono = time.monotonic()
        now_utc = datetime.now(timezone.utc)

        # Boundary-aligned 10s tick (run shortly after each 10s boundary).
        if now_utc >= next_10s_wall:
            force_refit = (now_mono - last_refit_at) >= TEN_SEC_REFIT_INTERVAL_SEC
            live = run_ten_second_live_forecast_tick(live, force_refit=force_refit)
            if force_refit and live is not None:
                last_refit_at = now_mono
            # schedule next boundary tick
            next_boundary = next_10s_boundary_utc(now_utc)
            next_10s_wall = next_boundary + timedelta(milliseconds=TEN_SEC_BOUNDARY_DELAY_MS)

        if now_mono >= next_hourly_forecast:
            force_refit_hourly = (now_mono - last_hourly_refit_at) >= HOURLY_REFIT_INTERVAL_SEC
            live_hourly = run_hourly_live_forecast_tick(
                live_hourly, force_refit=force_refit_hourly
            )
            if force_refit_hourly and live_hourly is not None:
                last_hourly_refit_at = now_mono
            next_hourly_forecast = now_mono + HOURLY_FORECAST_INTERVAL_SEC

        # Daily scoring of yesterday's 24h band (runs after 00:00 UTC).
        try:
            last_daily_scored = run_daily_24h_error_tick(last_scored_day=last_daily_scored)
        except Exception as exc:
            print(f"24h daily error tick failed: {exc}")

        # Sleep until next scheduled event (cap to stay responsive).
        sleep_to_hourly = max(0.0, next_hourly_forecast - time.monotonic())
        sleep_to_10s = max(0.0, (next_10s_wall - datetime.now(timezone.utc)).total_seconds())
        sleep_for = min(sleep_to_hourly, sleep_to_10s, 15.0)
        if sleep_for > 0:
            time.sleep(sleep_for)


def main() -> None:
    run_hourly_forecast_loop()


if __name__ == "__main__":
    main()
