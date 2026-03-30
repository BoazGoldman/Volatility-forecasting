from __future__ import annotations

import json
import math
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from src.live_garch import LiveGarch11, fetch_recent_bars, floor_dt_to_step
from src.storage import init_forecasts_db, keep_latest_n_forecasts, read_selected_forecasts, upsert_forecasts


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


DB_PATH = _env_str("DB_PATH", "data/forecasts.db")
SYMBOL = _env_str("SYMBOL", "BTC/USDT")

KEEP_LAST_N = _env_int("KEEP_LAST_N", 30)

# 60s-forward model (runs every minute; built on 5s candles; 12 steps = 60 seconds)
MINUTE_STEP_SECONDS = 60  # scheduling cadence / write frequency
FAST_STEP_SECONDS = 5
FAST_HORIZON_STEPS = 12
MINUTE_BOUNDARY_DELAY_MS = _env_int("MINUTE_BOUNDARY_DELAY_MS", 600)
MINUTE_FETCH_LIMIT_1S = _env_int("MINUTE_FETCH_LIMIT_1S", 7200)
MINUTE_REFIT_INTERVAL_SEC = _env_int("MINUTE_REFIT_INTERVAL_SEC", 15 * 60)
MINUTE_DB_TIMEFRAME = _env_str("MINUTE_DB_TIMEFRAME", "5s_60s")
WEB_FORECAST_60S_JSON = _env_str("WEB_FORECAST_60S_JSON", "web/public/forecasts_60s.json")

# Daily 24h-forward model (runs at 00:00 UTC only, forecasts next 24 hours)
HOURLY_TIMEFRAME = _env_str("HOURLY_TIMEFRAME", "1h")
DAILY_MIDNIGHT_DELAY_MS = _env_int("DAILY_MIDNIGHT_DELAY_MS", 2500)
DAILY_FETCH_LIMIT_1H = _env_int("DAILY_FETCH_LIMIT_1H", 3000)
DAILY_DB_TIMEFRAME = _env_str("DAILY_DB_TIMEFRAME", "1h_24h_at_00utc")
WEB_FORECAST_24H_JSON = _env_str("WEB_FORECAST_24H_JSON", "web/public/forecasts_24h.json")


def _export_forecasts_json(*, out_path: str, symbol: str, timeframe: str, extra: dict | None = None) -> None:
    df = read_selected_forecasts(db_path=DB_PATH, symbol=symbol, timeframe=timeframe)
    payload: dict = {
        "symbol": symbol,
        "timeframe": timeframe,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "forecasts": [],
    }
    if extra:
        payload.update(extra)

    if not df.empty:
        payload["forecasts"] = [
            {
                "timestamp": pd.to_datetime(row["timestamp"], utc=True).isoformat(),
                "garch_forecast": float(row["garch_forecast"]),
            }
            for _, row in df.iterrows()
            if pd.notna(pd.to_datetime(row["timestamp"], utc=True, errors="coerce"))
            and pd.notna(row["garch_forecast"])
        ]

    target = Path(out_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _resample_ohlcv(df_1s: pd.DataFrame, *, step_seconds: int) -> pd.DataFrame:
    if df_1s.empty:
        return df_1s.copy()

    work = df_1s.copy()
    work["timestamp"] = pd.to_datetime(work["timestamp"], utc=True, errors="coerce")
    work = work.dropna(subset=["timestamp"]).sort_values("timestamp")
    if work.empty:
        return work

    work = work.set_index("timestamp")
    rule = f"{int(step_seconds)}s"
    agg = {
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
    }
    if "volume" in work.columns:
        agg["volume"] = "sum"

    out = work.resample(rule, label="right", closed="right").agg(agg).dropna(subset=["close"])
    out = out.reset_index()
    return out


def _iter_closed_returns_pct(
    bars: pd.DataFrame,
    *,
    since_exclusive: datetime | None,
    until_inclusive: datetime,
    step_seconds: int,
) -> list[tuple[datetime, float]]:
    """
    Return a list of (bar_end_utc, return_pct) for each closed bar boundary in (since, until].
    Uses consecutive close-to-close returns, so replaying these updates keeps GARCH state consistent
    even if we only run the loop once per minute.
    """
    if bars.empty:
        return []
    ts = pd.to_datetime(bars["timestamp"], utc=True, errors="coerce")
    work = bars.assign(timestamp=ts).dropna(subset=["timestamp"]).sort_values("timestamp")
    if work.empty:
        return []

    end_ts = pd.Timestamp(until_inclusive)
    work = work[work["timestamp"] <= end_ts]
    if work.empty:
        return []

    if since_exclusive is not None:
        start_ts = pd.Timestamp(since_exclusive)
        work = work[work["timestamp"] > start_ts]
        # We still need the previous bar close to compute the first return.
        prev_row = bars.copy()
        prev_row["timestamp"] = pd.to_datetime(prev_row["timestamp"], utc=True, errors="coerce")
        prev_row = prev_row.dropna(subset=["timestamp"]).sort_values("timestamp")
        prev_row = prev_row[prev_row["timestamp"] <= start_ts].tail(1)
        if prev_row.empty:
            return []
        work = pd.concat([prev_row, work], ignore_index=True).sort_values("timestamp")

    rows = []
    closes = work[["timestamp", "close"]].dropna()
    closes = closes[closes["close"].astype(float) > 0]
    if len(closes) < 2:
        return []

    # Iterate consecutive bars; skip any gaps (non-consecutive timestamps).
    prev_t = pd.to_datetime(closes.iloc[0]["timestamp"], utc=True).to_pydatetime()
    prev_c = float(closes.iloc[0]["close"])
    for i in range(1, len(closes)):
        t = pd.to_datetime(closes.iloc[i]["timestamp"], utc=True).to_pydatetime()
        c = float(closes.iloc[i]["close"])
        if c <= 0 or prev_c <= 0:
            prev_t, prev_c = t, c
            continue
        if abs((t - prev_t).total_seconds() - float(step_seconds)) > 1e-6:
            prev_t, prev_c = t, c
            continue
        r_pct = float(math.log(c / prev_c) * 100.0)
        rows.append((t, r_pct))
        prev_t, prev_c = t, c

    # Keep only boundaries <= until_inclusive, and > since_exclusive.
    out: list[tuple[datetime, float]] = []
    for t, r in rows:
        if t <= until_inclusive and (since_exclusive is None or t > since_exclusive):
            out.append((t, r))
    return out


def _next_boundary_utc(now: datetime, *, step_seconds: int) -> datetime:
    floored = floor_dt_to_step(now, step_seconds)
    if floored == now.replace(microsecond=0) and now.microsecond == 0:
        return floored + timedelta(seconds=step_seconds)
    return floored + timedelta(seconds=step_seconds)


def run_minute_60s_forecast_tick(live: LiveGarch11 | None, *, force_refit: bool) -> LiveGarch11 | None:
    """
    Every minute:
      - fit/update a GARCH(1,1) on 5s bars
      - replay each closed 5s return since last run (catch up)
      - write σ forecast for the NEXT 60s (12 steps ahead)
      - keep last KEEP_LAST_N rows
    """
    now_utc = datetime.now(timezone.utc)
    minute_end = floor_dt_to_step(now_utc, MINUTE_STEP_SECONDS)
    fast_end = floor_dt_to_step(now_utc, FAST_STEP_SECONDS)

    try:
        bars_1s = fetch_recent_bars(
            symbol=SYMBOL, exchange_name="binance", timeframe="1s", limit=MINUTE_FETCH_LIMIT_1S
        )
        bars_5s = _resample_ohlcv(bars_1s, step_seconds=FAST_STEP_SECONDS)
    except Exception as exc:
        print(f"60s tick: fetch/resample failed: {exc}")
        return live

    if force_refit or live is None:
        try:
            live = LiveGarch11.fit_from_10s_bars(bars_5s)
            # Seed last_bar_end to the newest available 5s bar_end so we don't double replay.
            if not bars_5s.empty:
                last_ts = pd.to_datetime(bars_5s["timestamp"].iloc[-1], utc=True, errors="coerce")
                if pd.notna(last_ts):
                    live.last_bar_end = last_ts.to_pydatetime()
            print("60s (5s bars): refit ok")
        except Exception as exc:
            print(f"60s (5s bars): refit failed: {exc}")
            return None

    # Catch up: replay every closed 5s return since last_bar_end, up through `fast_end`.
    last_end = live.last_bar_end
    returns = _iter_closed_returns_pct(
        bars_5s,
        since_exclusive=last_end,
        until_inclusive=fast_end,
        step_seconds=FAST_STEP_SECONDS,
    )
    if not returns:
        # Nothing new to update; still allow writing once per minute if we're at a new minute.
        if last_end is not None and minute_end <= floor_dt_to_step(last_end, MINUTE_STEP_SECONDS):
            return live
    else:
        for t_end, r_pct in returns:
            sigma_next = live.update_with_return_pct(r_pct)
            if pd.notna(sigma_next) and sigma_next > 0:
                live.last_bar_end = t_end

    sigma_60s = live.sigma_horizon(FAST_HORIZON_STEPS)
    if not pd.notna(sigma_60s) or not (sigma_60s > 0):
        return live

    forecast_time = minute_end + timedelta(seconds=MINUTE_STEP_SECONDS)
    df_out = pd.DataFrame([{"timestamp": forecast_time.isoformat(), "garch_forecast": float(sigma_60s)}])
    upsert_forecasts(df_out, db_path=DB_PATH, symbol=SYMBOL, timeframe=MINUTE_DB_TIMEFRAME)
    keep_latest_n_forecasts(DB_PATH, symbol=SYMBOL, timeframe=MINUTE_DB_TIMEFRAME, n=KEEP_LAST_N)
    _export_forecasts_json(
        out_path=WEB_FORECAST_60S_JSON,
        symbol=SYMBOL,
        timeframe=MINUTE_DB_TIMEFRAME,
        extra={
            "bar_seconds": FAST_STEP_SECONDS,
            "horizon_steps": FAST_HORIZON_STEPS,
            "horizon_seconds": FAST_STEP_SECONDS * FAST_HORIZON_STEPS,
            "cadence_seconds": MINUTE_STEP_SECONDS,
            "kept_forecasts": KEEP_LAST_N,
            "refit_interval_sec": MINUTE_REFIT_INTERVAL_SEC,
        },
    )
    print(f"60s (5s bars): wrote forecast for {forecast_time.isoformat()} σ={float(sigma_60s):.6f}")
    return live


def run_daily_midnight_24h_forecast() -> None:
    """
    At 00:00 UTC only:
      - fit a GARCH(1,1) on 1h bars
      - compute σ over next 24 hours (24 steps)
      - write one row at forecast_time = midnight (00:00 UTC)
      - keep last KEEP_LAST_N rows
    """
    now_utc = datetime.now(timezone.utc)
    midnight = floor_dt_to_step(now_utc, 24 * 60 * 60)
    # Only run at (or shortly after) midnight.
    if now_utc < midnight + timedelta(milliseconds=DAILY_MIDNIGHT_DELAY_MS):
        return

    try:
        bars_1h = fetch_recent_bars(
            symbol=SYMBOL, exchange_name="binance", timeframe=HOURLY_TIMEFRAME, limit=DAILY_FETCH_LIMIT_1H
        )
    except Exception as exc:
        print(f"24h@00:00: fetch failed: {exc}")
        return

    try:
        model = LiveGarch11.fit_from_10s_bars(bars_1h)
    except Exception as exc:
        print(f"24h@00:00: fit failed: {exc}")
        return

    sigma_24h = model.sigma_horizon(24)
    if not pd.notna(sigma_24h) or not (sigma_24h > 0):
        return

    df_out = pd.DataFrame([{"timestamp": midnight.isoformat(), "garch_forecast": float(sigma_24h)}])
    upsert_forecasts(df_out, db_path=DB_PATH, symbol=SYMBOL, timeframe=DAILY_DB_TIMEFRAME)
    keep_latest_n_forecasts(DB_PATH, symbol=SYMBOL, timeframe=DAILY_DB_TIMEFRAME, n=KEEP_LAST_N)
    _export_forecasts_json(
        out_path=WEB_FORECAST_24H_JSON,
        symbol=SYMBOL,
        timeframe=DAILY_DB_TIMEFRAME,
        extra={
            "source_timeframe": HOURLY_TIMEFRAME,
            "horizon_steps": 24,
            "run_time_utc": "00:00",
            "kept_forecasts": KEEP_LAST_N,
        },
    )
    print(f"24h@00:00: wrote {midnight.isoformat()} σ={float(sigma_24h):.6f}")


def run_forecast_loop() -> None:
    init_forecasts_db(DB_PATH)

    last_minute_refit_at = -1e18
    live_60s: LiveGarch11 | None = None

    # Force a quick "catch up" run on startup (but still boundary aligned).
    next_minute_wall = datetime.now(timezone.utc)
    last_midnight_run: datetime | None = None

    while True:
        now_mono = time.monotonic()
        now_utc = datetime.now(timezone.utc)

        # 60s cadence: run shortly after each minute boundary.
        if now_utc >= next_minute_wall:
            force_refit = (now_mono - last_minute_refit_at) >= MINUTE_REFIT_INTERVAL_SEC
            live_60s = run_minute_60s_forecast_tick(live_60s, force_refit=force_refit)
            if force_refit and live_60s is not None:
                last_minute_refit_at = now_mono
            next_boundary = _next_boundary_utc(now_utc, step_seconds=MINUTE_STEP_SECONDS)
            next_minute_wall = next_boundary + timedelta(milliseconds=MINUTE_BOUNDARY_DELAY_MS)

        # Midnight-only 24h horizon: run once per day.
        midnight = floor_dt_to_step(now_utc, 24 * 60 * 60)
        if last_midnight_run is None or midnight > last_midnight_run:
            before = last_midnight_run
            run_daily_midnight_24h_forecast()
            # If we were past the delay window, treat as completed for this midnight.
            if datetime.now(timezone.utc) >= midnight + timedelta(milliseconds=DAILY_MIDNIGHT_DELAY_MS):
                last_midnight_run = midnight
            else:
                last_midnight_run = before

        # Sleep until next scheduled event (cap to stay responsive).
        sleep_to_minute = max(0.0, (next_minute_wall - datetime.now(timezone.utc)).total_seconds())
        # Ensure we wake up around midnight even if minute timer is far.
        next_midnight = midnight + timedelta(days=1)
        sleep_to_midnight = max(
            0.0,
            (
                next_midnight
                + timedelta(milliseconds=DAILY_MIDNIGHT_DELAY_MS)
                - datetime.now(timezone.utc)
            ).total_seconds(),
        )
        time.sleep(min(sleep_to_minute, sleep_to_midnight, 10.0))


def main() -> None:
    run_forecast_loop()


if __name__ == "__main__":
    main()
