from __future__ import annotations

import sqlite3
import os
from pathlib import Path

import pandas as pd


def _connect(db_path: str) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    journal_mode = (os.getenv("SQLITE_JOURNAL_MODE") or "WAL").strip().upper()
    # WAL is best for concurrency on Linux servers, but some Docker Desktop bind mounts can error with it.
    conn.execute(f"PRAGMA journal_mode={journal_mode};")
    return conn


def init_forecasts_db(db_path: str) -> None:
    with _connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS forecasts (
                symbol TEXT NOT NULL,
                timeframe TEXT NOT NULL,
                forecast_time TEXT NOT NULL,
                garch_forecast REAL NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (symbol, timeframe, forecast_time)
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_forecasts_lookup
            ON forecasts(symbol, timeframe, forecast_time DESC)
            """
        )

        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS forecast_errors (
                symbol TEXT NOT NULL,
                series TEXT NOT NULL,
                event_time TEXT NOT NULL,
                anchor_price REAL,
                actual_price REAL,
                sigma REAL,
                low REAL,
                high REAL,
                outside_frac REAL,
                side TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (symbol, series, event_time)
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_forecast_errors_lookup
            ON forecast_errors(symbol, series, event_time DESC)
            """
        )


def upsert_forecasts(
    df: pd.DataFrame,
    db_path: str,
    symbol: str,
    timeframe: str,
) -> int:
    if df.empty:
        return 0

    rows: list[tuple[str, str, str, float]] = []
    for _, row in df.iterrows():
        ts = pd.to_datetime(row["timestamp"], utc=True, errors="coerce")
        val = row["garch_forecast"]
        if pd.isna(ts) or pd.isna(val):
            continue
        rows.append((symbol, timeframe, ts.isoformat(), float(val)))

    if not rows:
        return 0

    with _connect(db_path) as conn:
        conn.executemany(
            """
            INSERT INTO forecasts(symbol, timeframe, forecast_time, garch_forecast)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(symbol, timeframe, forecast_time)
            DO UPDATE SET
                garch_forecast = excluded.garch_forecast,
                updated_at = datetime('now')
            """,
            rows,
        )
    return len(rows)


def select_three_midnights_plus_latest(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df.copy()

    out = df.copy()
    out["timestamp"] = pd.to_datetime(out["timestamp"], utc=True, errors="coerce")
    out = out.dropna(subset=["timestamp", "garch_forecast"]).sort_values("timestamp")
    if out.empty:
        return out

    midnight_rows = out[
        (out["timestamp"].dt.hour == 0)
        & (out["timestamp"].dt.minute == 0)
        & (out["timestamp"].dt.second == 0)
    ].tail(3)

    latest_row = out.tail(1)
    selected = pd.concat([midnight_rows, latest_row], ignore_index=True)
    selected = selected.drop_duplicates(subset=["timestamp"], keep="last")
    return selected.sort_values("timestamp").tail(4).copy()


def keep_only_timestamps(
    db_path: str,
    symbol: str,
    timeframe: str,
    timestamps_iso: list[str],
) -> int:
    with _connect(db_path) as conn:
        if not timestamps_iso:
            cur = conn.execute(
                "DELETE FROM forecasts WHERE symbol = ? AND timeframe = ?",
                (symbol, timeframe),
            )
            return cur.rowcount

        placeholders = ",".join("?" for _ in timestamps_iso)
        sql = f"""
            DELETE FROM forecasts
            WHERE symbol = ?
              AND timeframe = ?
              AND forecast_time NOT IN ({placeholders})
        """
        params = [symbol, timeframe, *timestamps_iso]
        cur = conn.execute(sql, params)
        return cur.rowcount


def read_selected_forecasts(db_path: str, symbol: str, timeframe: str) -> pd.DataFrame:
    with _connect(db_path) as conn:
        return pd.read_sql_query(
            """
            SELECT forecast_time AS timestamp, garch_forecast
            FROM forecasts
            WHERE symbol = ? AND timeframe = ?
            ORDER BY forecast_time ASC
            """,
            conn,
            params=(symbol, timeframe),
        )


def read_forecast_at(
    *, db_path: str, symbol: str, timeframe: str, forecast_time_iso: str
) -> float | None:
    """Return garch_forecast for exact forecast_time (ISO), or None."""
    with _connect(db_path) as conn:
        cur = conn.execute(
            """
            SELECT garch_forecast
            FROM forecasts
            WHERE symbol = ? AND timeframe = ? AND forecast_time = ?
            """,
            (symbol, timeframe, forecast_time_iso),
        )
        row = cur.fetchone()
        if not row:
            return None
        val = row[0]
        try:
            return float(val)
        except Exception:
            return None


def keep_latest_n_forecasts(
    db_path: str, symbol: str, timeframe: str, n: int
) -> int:
    """Keep only the `n` most recent rows (by forecast_time) for this series."""
    if n < 1:
        return 0

    with _connect(db_path) as conn:
        cur = conn.execute(
            """
            DELETE FROM forecasts
            WHERE symbol = ?
              AND timeframe = ?
              AND forecast_time NOT IN (
                SELECT forecast_time
                FROM forecasts
                WHERE symbol = ?
                  AND timeframe = ?
                ORDER BY forecast_time DESC
                LIMIT ?
              )
            """,
            (symbol, timeframe, symbol, timeframe, n),
        )
        return cur.rowcount


def insert_forecast_error(
    *,
    db_path: str,
    symbol: str,
    series: str,
    event_time_iso: str,
    anchor_price: float | None,
    actual_price: float | None,
    sigma: float | None,
    low: float | None,
    high: float | None,
    outside_frac: float | None,
    side: str | None,
) -> None:
    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO forecast_errors(
              symbol, series, event_time,
              anchor_price, actual_price, sigma, low, high,
              outside_frac, side
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, series, event_time)
            DO UPDATE SET
              anchor_price = excluded.anchor_price,
              actual_price = excluded.actual_price,
              sigma = excluded.sigma,
              low = excluded.low,
              high = excluded.high,
              outside_frac = excluded.outside_frac,
              side = excluded.side,
              created_at = datetime('now')
            """,
            (
                symbol,
                series,
                event_time_iso,
                anchor_price,
                actual_price,
                sigma,
                low,
                high,
                outside_frac,
                side,
            ),
        )


def read_latest_forecast_errors(
    *, db_path: str, symbol: str, series: str, limit: int = 30
) -> pd.DataFrame:
    with _connect(db_path) as conn:
        return pd.read_sql_query(
            """
            SELECT
              event_time,
              anchor_price,
              actual_price,
              sigma,
              low,
              high,
              outside_frac,
              side,
              created_at
            FROM forecast_errors
            WHERE symbol = ? AND series = ?
            ORDER BY event_time DESC
            LIMIT ?
            """,
            conn,
            params=(symbol, series, limit),
        )


def keep_latest_n_forecast_errors(
    *, db_path: str, symbol: str, series: str, n: int = 30
) -> int:
    if n < 1:
        return 0
    with _connect(db_path) as conn:
        cur = conn.execute(
            """
            DELETE FROM forecast_errors
            WHERE symbol = ?
              AND series = ?
              AND event_time NOT IN (
                SELECT event_time
                FROM forecast_errors
                WHERE symbol = ?
                  AND series = ?
                ORDER BY event_time DESC
                LIMIT ?
              )
            """,
            (symbol, series, symbol, series, n),
        )
        return cur.rowcount
