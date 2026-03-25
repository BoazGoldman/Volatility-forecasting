import time
from datetime import datetime, timezone
import json
from pathlib import Path
import os

import pandas as pd

from src.pipeline import ohlcv_1s_to_10s, run_garch_pipeline
from src.storage import (
    init_forecasts_db,
    keep_latest_n_forecasts,
    keep_only_timestamps,
    read_selected_forecasts,
    select_three_midnights_plus_latest,
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


SLEEP_SECONDS = _env_int("SLEEP_SECONDS", 3600)
"""How often to refit the 10s-candle GARCH (each run fetches fresh 1s data). Lower if you want; 10s fits are CPU-heavy."""
TEN_SEC_MODEL_INTERVAL_SEC = _env_int("TEN_SEC_MODEL_INTERVAL_SEC", 30)
TEN_SEC_DB_TIMEFRAME = _env_str("TEN_SEC_DB_TIMEFRAME", "10s")
TEN_SEC_KEEP_ROWS = _env_int("TEN_SEC_KEEP_ROWS", 6)
DB_PATH = _env_str("DB_PATH", "data/forecasts.db")
SYMBOL = _env_str("SYMBOL", "BTC/USDT")
TIMEFRAME = _env_str("TIMEFRAME", "1h")
WEB_FORECAST_JSON = _env_str("WEB_FORECAST_JSON", "web/public/forecasts.json")
WEB_FORECAST_10S_JSON = _env_str("WEB_FORECAST_10S_JSON", "web/public/forecasts_10s.json")


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


def run_hourly_forecast_once() -> None:
    started_at = datetime.now(timezone.utc).isoformat()
    print(f"[{started_at}] Running hourly forecast...")

    df = run_garch_pipeline(
        symbol=SYMBOL,
        exchange_name="binance",
        timeframe=TIMEFRAME,
        limit=2000,
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


def run_ten_second_bar_forecast_once() -> None:
    started_at = datetime.now(timezone.utc).isoformat()
    print(f"[{started_at}] Running 10s-bar GARCH (from 1s klines)...")

    df = run_garch_pipeline(
        symbol=SYMBOL,
        exchange_name="binance",
        timeframe="1s",
        limit=1000,
        preprocess=ohlcv_1s_to_10s,
        baseline_window_step=30,
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


def run_hourly_forecast_loop() -> None:
    init_forecasts_db(DB_PATH)

    next_hourly = 0.0
    next_10s_model = 0.0

    while True:
        now = time.monotonic()

        if now >= next_10s_model:
            try:
                run_ten_second_bar_forecast_once()
            except Exception as exc:
                print(f"10s-bar forecast run failed: {exc}")
            next_10s_model = now + TEN_SEC_MODEL_INTERVAL_SEC

        if now >= next_hourly:
            try:
                run_hourly_forecast_once()
            except Exception as exc:
                print(f"Hourly forecast run failed: {exc}")
            next_hourly = now + SLEEP_SECONDS

        sleep_for = min(next_10s_model, next_hourly) - time.monotonic()
        if sleep_for > 0:
            time.sleep(min(sleep_for, 15.0))


def main() -> None:
    run_hourly_forecast_loop()


if __name__ == "__main__":
    main()
