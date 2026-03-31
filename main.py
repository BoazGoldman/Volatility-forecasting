from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from src.live_garch import LiveGarch11, fetch_recent_bars, floor_dt_to_step
from src.storage import (
    init_forecasts_db,
    keep_only_timestamps,
    read_selected_forecasts,
    upsert_forecasts,
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


DB_PATH = _env_str("DB_PATH", "data/forecasts.db")
SYMBOL = _env_str("SYMBOL", "BTC/USDT")

KEEP_LAST_N = _env_int("KEEP_LAST_N", 30)

# Daily 24h-forward model (runs hourly on 1h boundaries, forecasts next 24 hours)
HOURLY_TIMEFRAME = _env_str("HOURLY_TIMEFRAME", "1h")
DAILY_MIDNIGHT_DELAY_MS = _env_int("DAILY_MIDNIGHT_DELAY_MS", 2500)
DAILY_FETCH_LIMIT_1H = _env_int("DAILY_FETCH_LIMIT_1H", 3000)
DAILY_DB_TIMEFRAME = _env_str("DAILY_DB_TIMEFRAME", "1h_24h_at_00utc")
WEB_FORECAST_24H_JSON = _env_str("WEB_FORECAST_24H_JSON", "web/public/forecasts_24h.json")

# 1h-forward model sampled every 5 minutes (built on 5m bars)
FIVE_MIN_STEP_SECONDS = _env_int("FIVE_MIN_STEP_SECONDS", 5 * 60)
FIVE_MIN_TIMEFRAME = _env_str("FIVE_MIN_TIMEFRAME", "5m")
FIVE_MIN_FETCH_LIMIT_5M = _env_int("FIVE_MIN_FETCH_LIMIT_5M", 3000)
FIVE_MIN_HORIZON_STEPS = _env_int("FIVE_MIN_HORIZON_STEPS", 12)  # 12 * 5m = 60m
FIVE_MIN_BOUNDARY_DELAY_MS = _env_int("FIVE_MIN_BOUNDARY_DELAY_MS", 1200)
FIVE_MIN_REFIT_INTERVAL_SEC = _env_int("FIVE_MIN_REFIT_INTERVAL_SEC", 8 * 60 * 60)
FIVE_MIN_DB_TIMEFRAME = _env_str("FIVE_MIN_DB_TIMEFRAME", "5m_1h")
WEB_FORECAST_1H_JSON = _env_str("WEB_FORECAST_1H_JSON", "web/public/forecasts_1h.json")
ROUND_HOUR_RETRY_WINDOW_SEC = _env_int("ROUND_HOUR_RETRY_WINDOW_SEC", 5 * 60)
ROUND_HOUR_RETRY_INTERVAL_SEC = _env_int("ROUND_HOUR_RETRY_INTERVAL_SEC", 20)
MIDNIGHT_RETRY_WINDOW_SEC = _env_int("MIDNIGHT_RETRY_WINDOW_SEC", 30 * 60)
MIDNIGHT_RETRY_INTERVAL_SEC = _env_int("MIDNIGHT_RETRY_INTERVAL_SEC", 30)


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


def _keep_hourly_rounds_plus_latest(*, db_path: str, symbol: str, timeframe: str) -> None:
    """
    Keep only round-hour forecasts (HH:00:00) plus the latest row for a series.
    """
    df = read_selected_forecasts(db_path=db_path, symbol=symbol, timeframe=timeframe)
    if df.empty:
        return

    work = df.copy()
    work["ts"] = pd.to_datetime(work["timestamp"], utc=True, errors="coerce")
    work = work.dropna(subset=["ts"]).sort_values("ts")
    if work.empty:
        return

    latest_ts = work.iloc[-1]["ts"]
    keep_ts: set[str] = set()
    for ts in work["ts"]:
        if ts.minute == 0 and ts.second == 0:
            keep_ts.add(ts.isoformat())
    keep_ts.add(latest_ts.isoformat())

    keep_only_timestamps(
        db_path=db_path,
        symbol=symbol,
        timeframe=timeframe,
        timestamps_iso=sorted(keep_ts),
    )


def _has_forecast_timestamp(*, db_path: str, symbol: str, timeframe: str, forecast_time_iso: str) -> bool:
    df = read_selected_forecasts(db_path=db_path, symbol=symbol, timeframe=timeframe)
    if df.empty:
        return False
    ts = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    target = pd.to_datetime(forecast_time_iso, utc=True, errors="coerce")
    if pd.isna(target):
        return False
    return bool((ts == target).any())


def _keep_midnights_plus_latest(*, db_path: str, symbol: str, timeframe: str) -> None:
    """
    Keep only midnight forecasts (00:00:00 UTC) plus the latest row.
    """
    df = read_selected_forecasts(db_path=db_path, symbol=symbol, timeframe=timeframe)
    if df.empty:
        return

    work = df.copy()
    work["ts"] = pd.to_datetime(work["timestamp"], utc=True, errors="coerce")
    work = work.dropna(subset=["ts"]).sort_values("ts")
    if work.empty:
        return

    latest_ts = work.iloc[-1]["ts"]
    keep_ts: set[str] = set()
    for ts in work["ts"]:
        if ts.hour == 0 and ts.minute == 0 and ts.second == 0:
            keep_ts.add(ts.isoformat())
    keep_ts.add(latest_ts.isoformat())

    keep_only_timestamps(
        db_path=db_path,
        symbol=symbol,
        timeframe=timeframe,
        timestamps_iso=sorted(keep_ts),
    )


def _write_one_hour_forecast_at(*, forecast_time_utc: datetime) -> tuple[bool, str]:
    try:
        bars_5m = fetch_recent_bars(
            symbol=SYMBOL,
            exchange_name="binance",
            timeframe=FIVE_MIN_TIMEFRAME,
            limit=FIVE_MIN_FETCH_LIMIT_5M,
        )
    except Exception as exc:
        return False, f"fetch failed: {exc}"

    if bars_5m.empty:
        return False, "fetch returned empty bars"

    try:
        model = LiveGarch11.fit_from_10s_bars(bars_5m)
    except Exception as exc:
        return False, f"fit failed: {exc}"

    sigma_1h = model.sigma_horizon(FIVE_MIN_HORIZON_STEPS)
    if not pd.notna(sigma_1h) or not (sigma_1h > 0):
        return False, f"invalid sigma: {sigma_1h}"

    df_out = pd.DataFrame([{"timestamp": forecast_time_utc.isoformat(), "garch_forecast": float(sigma_1h)}])
    upsert_forecasts(df_out, db_path=DB_PATH, symbol=SYMBOL, timeframe=FIVE_MIN_DB_TIMEFRAME)
    _keep_hourly_rounds_plus_latest(
        db_path=DB_PATH,
        symbol=SYMBOL,
        timeframe=FIVE_MIN_DB_TIMEFRAME,
    )
    _export_forecasts_json(
        out_path=WEB_FORECAST_1H_JSON,
        symbol=SYMBOL,
        timeframe=FIVE_MIN_DB_TIMEFRAME,
        extra={
            "source_timeframe": FIVE_MIN_TIMEFRAME,
            "horizon_steps": FIVE_MIN_HORIZON_STEPS,
            "horizon_minutes": int((FIVE_MIN_HORIZON_STEPS * FIVE_MIN_STEP_SECONDS) / 60),
            "cadence_seconds": FIVE_MIN_STEP_SECONDS,
            "kept_forecasts": KEEP_LAST_N,
            "refit_interval_sec": FIVE_MIN_REFIT_INTERVAL_SEC,
        },
    )
    return True, f"wrote σ={float(sigma_1h):.6f}"


def _write_daily_24h_forecast_at(*, forecast_time_utc: datetime) -> tuple[bool, str]:
    try:
        bars_1h = fetch_recent_bars(
            symbol=SYMBOL,
            exchange_name="binance",
            timeframe=HOURLY_TIMEFRAME,
            limit=DAILY_FETCH_LIMIT_1H,
        )
    except Exception as exc:
        return False, f"fetch failed: {exc}"

    if bars_1h.empty:
        return False, "fetch returned empty bars"

    try:
        model = LiveGarch11.fit_from_10s_bars(bars_1h)
    except Exception as exc:
        return False, f"fit failed: {exc}"

    sigma_24h = model.sigma_horizon(24)
    if not pd.notna(sigma_24h) or not (sigma_24h > 0):
        return False, f"invalid sigma: {sigma_24h}"

    df_out = pd.DataFrame([{"timestamp": forecast_time_utc.isoformat(), "garch_forecast": float(sigma_24h)}])
    upsert_forecasts(df_out, db_path=DB_PATH, symbol=SYMBOL, timeframe=DAILY_DB_TIMEFRAME)
    _keep_midnights_plus_latest(db_path=DB_PATH, symbol=SYMBOL, timeframe=DAILY_DB_TIMEFRAME)
    _export_forecasts_json(
        out_path=WEB_FORECAST_24H_JSON,
        symbol=SYMBOL,
        timeframe=DAILY_DB_TIMEFRAME,
        extra={
            "source_timeframe": HOURLY_TIMEFRAME,
            "horizon_steps": 24,
            "run_time_utc": "hourly",
            "kept_forecasts": KEEP_LAST_N,
        },
    )
    return True, f"wrote σ={float(sigma_24h):.6f}"


def _next_boundary_utc(now: datetime, *, step_seconds: int) -> datetime:
    floored = floor_dt_to_step(now, step_seconds)
    if floored == now.replace(microsecond=0) and now.microsecond == 0:
        return floored + timedelta(seconds=step_seconds)
    return floored + timedelta(seconds=step_seconds)


def run_hourly_24h_forecast_tick() -> None:
    """
    Every hour (on hour boundary):
      - fit a GARCH(1,1) on 1h bars
      - compute σ over next 24 hours (24 steps)
      - write one row at forecast_time = current UTC hour
      - keep only 00:00 rows plus the latest hourly row
    """
    now_utc = datetime.now(timezone.utc)
    hour_slot = floor_dt_to_step(now_utc, 60 * 60)
    # Run shortly after each hour boundary.
    if now_utc < hour_slot + timedelta(milliseconds=DAILY_MIDNIGHT_DELAY_MS):
        return

    ok, msg = _write_daily_24h_forecast_at(forecast_time_utc=hour_slot)
    if ok:
        print(f"24h@1h: wrote {hour_slot.isoformat()} {msg}")
    else:
        print(f"24h@1h: {msg}")


def run_five_minute_1h_forecast_tick(live: LiveGarch11 | None, *, force_refit: bool) -> LiveGarch11 | None:
    """
    Every 5 minutes:
      - fit/update a GARCH(1,1) on 5m bars
      - write σ forecast for the next 1h (12 x 5m steps)
      - keep last KEEP_LAST_N rows
    """
    now_utc = datetime.now(timezone.utc)
    slot_end = floor_dt_to_step(now_utc, FIVE_MIN_STEP_SECONDS)

    try:
        bars_5m = fetch_recent_bars(
            symbol=SYMBOL,
            exchange_name="binance",
            timeframe=FIVE_MIN_TIMEFRAME,
            limit=FIVE_MIN_FETCH_LIMIT_5M,
        )
    except Exception as exc:
        print(f"1h@5m tick: fetch failed: {exc}")
        return live

    if bars_5m.empty:
        return live

    if force_refit or live is None:
        try:
            live = LiveGarch11.fit_from_10s_bars(bars_5m)
            print("1h@5m (5m bars): refit ok")
        except Exception as exc:
            print(f"1h@5m (5m bars): refit failed: {exc}")
            return None

    sigma_1h = live.sigma_horizon(FIVE_MIN_HORIZON_STEPS)
    if not pd.notna(sigma_1h) or not (sigma_1h > 0):
        return live

    forecast_time = slot_end + timedelta(seconds=FIVE_MIN_STEP_SECONDS)
    df_out = pd.DataFrame([{"timestamp": forecast_time.isoformat(), "garch_forecast": float(sigma_1h)}])
    upsert_forecasts(df_out, db_path=DB_PATH, symbol=SYMBOL, timeframe=FIVE_MIN_DB_TIMEFRAME)
    _keep_hourly_rounds_plus_latest(
        db_path=DB_PATH,
        symbol=SYMBOL,
        timeframe=FIVE_MIN_DB_TIMEFRAME,
    )
    _export_forecasts_json(
        out_path=WEB_FORECAST_1H_JSON,
        symbol=SYMBOL,
        timeframe=FIVE_MIN_DB_TIMEFRAME,
        extra={
            "source_timeframe": FIVE_MIN_TIMEFRAME,
            "horizon_steps": FIVE_MIN_HORIZON_STEPS,
            "horizon_minutes": int((FIVE_MIN_HORIZON_STEPS * FIVE_MIN_STEP_SECONDS) / 60),
            "cadence_seconds": FIVE_MIN_STEP_SECONDS,
            "kept_forecasts": KEEP_LAST_N,
            "refit_interval_sec": FIVE_MIN_REFIT_INTERVAL_SEC,
        },
    )
    print(f"1h@5m: wrote forecast for {forecast_time.isoformat()} σ={float(sigma_1h):.6f}")
    return live


def run_forecast_loop() -> None:
    init_forecasts_db(DB_PATH)

    last_five_min_refit_at = -1e18
    live_1h_from_5m: LiveGarch11 | None = None

    # Force a quick "catch up" run on startup (but still boundary aligned).
    next_five_min_wall = datetime.now(timezone.utc)
    next_daily_hour_wall = datetime.now(timezone.utc)
    verified_hour: datetime | None = None
    retry_hour: datetime | None = None
    retry_deadline: datetime | None = None
    next_retry_at: datetime | None = None
    retry_attempts = 0
    verified_midnight: datetime | None = None
    retry_midnight: datetime | None = None
    retry_midnight_deadline: datetime | None = None
    next_midnight_retry_at: datetime | None = None
    midnight_retry_attempts = 0

    while True:
        now_mono = time.monotonic()
        now_utc = datetime.now(timezone.utc)

        # 1h-from-5m cadence: run shortly after each 5-minute boundary.
        if now_utc >= next_five_min_wall:
            force_refit_5m = (now_mono - last_five_min_refit_at) >= FIVE_MIN_REFIT_INTERVAL_SEC
            live_1h_from_5m = run_five_minute_1h_forecast_tick(live_1h_from_5m, force_refit=force_refit_5m)
            if force_refit_5m and live_1h_from_5m is not None:
                last_five_min_refit_at = now_mono
            next_5m_boundary = _next_boundary_utc(now_utc, step_seconds=FIVE_MIN_STEP_SECONDS)
            next_five_min_wall = next_5m_boundary + timedelta(milliseconds=FIVE_MIN_BOUNDARY_DELAY_MS)

        # Verify each round-hour forecast exists; retry within a short window if missing.
        hour_floor = floor_dt_to_step(now_utc, 60 * 60)
        hour_iso = hour_floor.isoformat()
        if verified_hour is None or hour_floor > verified_hour:
            if _has_forecast_timestamp(
                db_path=DB_PATH,
                symbol=SYMBOL,
                timeframe=FIVE_MIN_DB_TIMEFRAME,
                forecast_time_iso=hour_iso,
            ):
                print(f"hourly_write_verified: forecast_time={hour_iso}")
                verified_hour = hour_floor
                retry_hour = None
            elif retry_hour != hour_floor:
                retry_hour = hour_floor
                retry_deadline = hour_floor + timedelta(seconds=ROUND_HOUR_RETRY_WINDOW_SEC)
                next_retry_at = now_utc
                retry_attempts = 0

        if retry_hour is not None and verified_hour != retry_hour:
            has_hour = _has_forecast_timestamp(
                db_path=DB_PATH,
                symbol=SYMBOL,
                timeframe=FIVE_MIN_DB_TIMEFRAME,
                forecast_time_iso=retry_hour.isoformat(),
            )
            if has_hour:
                if retry_attempts > 0:
                    print(
                        f"hourly_write_recovered: forecast_time={retry_hour.isoformat()} attempts={retry_attempts}"
                    )
                else:
                    print(f"hourly_write_verified: forecast_time={retry_hour.isoformat()}")
                verified_hour = retry_hour
                retry_hour = None
            elif (
                retry_deadline is not None
                and next_retry_at is not None
                and now_utc <= retry_deadline
                and now_utc >= next_retry_at
            ):
                ok, msg = _write_one_hour_forecast_at(forecast_time_utc=retry_hour)
                retry_attempts += 1
                next_retry_at = now_utc + timedelta(seconds=max(1, ROUND_HOUR_RETRY_INTERVAL_SEC))
                if ok:
                    print(
                        f"hourly_write_recovered: forecast_time={retry_hour.isoformat()} attempts={retry_attempts} {msg}"
                    )
                    verified_hour = retry_hour
                    retry_hour = None
            elif retry_deadline is not None and now_utc > retry_deadline:
                print(
                    "hourly_write_failed_after_retries: "
                    f"forecast_time={retry_hour.isoformat()} attempts={retry_attempts} "
                    f"window_sec={ROUND_HOUR_RETRY_WINDOW_SEC}"
                )
                retry_hour = None

        # Verify each UTC midnight daily forecast exists; retry in a larger window if missing.
        day_floor = floor_dt_to_step(now_utc, 24 * 60 * 60)
        day_iso = day_floor.isoformat()
        if verified_midnight is None or day_floor > verified_midnight:
            if _has_forecast_timestamp(
                db_path=DB_PATH,
                symbol=SYMBOL,
                timeframe=DAILY_DB_TIMEFRAME,
                forecast_time_iso=day_iso,
            ):
                print(f"daily_midnight_write_verified: forecast_time={day_iso}")
                verified_midnight = day_floor
                retry_midnight = None
            elif retry_midnight != day_floor:
                retry_midnight = day_floor
                retry_midnight_deadline = day_floor + timedelta(seconds=MIDNIGHT_RETRY_WINDOW_SEC)
                next_midnight_retry_at = now_utc
                midnight_retry_attempts = 0

        if retry_midnight is not None and verified_midnight != retry_midnight:
            has_midnight = _has_forecast_timestamp(
                db_path=DB_PATH,
                symbol=SYMBOL,
                timeframe=DAILY_DB_TIMEFRAME,
                forecast_time_iso=retry_midnight.isoformat(),
            )
            if has_midnight:
                if midnight_retry_attempts > 0:
                    print(
                        "daily_midnight_write_recovered: "
                        f"forecast_time={retry_midnight.isoformat()} attempts={midnight_retry_attempts}"
                    )
                else:
                    print(f"daily_midnight_write_verified: forecast_time={retry_midnight.isoformat()}")
                verified_midnight = retry_midnight
                retry_midnight = None
            elif (
                retry_midnight_deadline is not None
                and next_midnight_retry_at is not None
                and now_utc <= retry_midnight_deadline
                and now_utc >= next_midnight_retry_at
            ):
                ok, msg = _write_daily_24h_forecast_at(forecast_time_utc=retry_midnight)
                midnight_retry_attempts += 1
                next_midnight_retry_at = now_utc + timedelta(seconds=max(1, MIDNIGHT_RETRY_INTERVAL_SEC))
                if ok:
                    print(
                        "daily_midnight_write_recovered: "
                        f"forecast_time={retry_midnight.isoformat()} attempts={midnight_retry_attempts} {msg}"
                    )
                    verified_midnight = retry_midnight
                    retry_midnight = None
            elif retry_midnight_deadline is not None and now_utc > retry_midnight_deadline:
                print(
                    "daily_midnight_write_failed_after_retries: "
                    f"forecast_time={retry_midnight.isoformat()} attempts={midnight_retry_attempts} "
                    f"window_sec={MIDNIGHT_RETRY_WINDOW_SEC}"
                )
                retry_midnight = None

        # 24h horizon on hourly cadence.
        if now_utc >= next_daily_hour_wall:
            run_hourly_24h_forecast_tick()
            next_hour_boundary = _next_boundary_utc(now_utc, step_seconds=60 * 60)
            next_daily_hour_wall = next_hour_boundary + timedelta(milliseconds=DAILY_MIDNIGHT_DELAY_MS)

        # Sleep until next scheduled event (cap to stay responsive).
        sleep_to_five_min = max(0.0, (next_five_min_wall - datetime.now(timezone.utc)).total_seconds())
        # Ensure we wake up around next hourly daily-forecast slot.
        sleep_to_daily_hour = max(
            0.0,
            (
                next_daily_hour_wall
                - datetime.now(timezone.utc)
            ).total_seconds(),
        )
        time.sleep(min(sleep_to_five_min, sleep_to_daily_hour, 10.0))


def main() -> None:
    run_forecast_loop()


if __name__ == "__main__":
    main()
