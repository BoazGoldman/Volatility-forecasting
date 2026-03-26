from __future__ import annotations

import os
import asyncio
import json
from datetime import datetime, timezone
from typing import Any

import pandas as pd
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from src.storage import read_forecasts, read_latest_forecast_errors

import websockets


def _env_str(name: str, default: str) -> str:
    raw = os.getenv(name)
    if raw is None:
        return default
    val = raw.strip()
    return val if val else default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    val = raw.strip().lower()
    if val in {"1", "true", "yes", "y", "on"}:
        return True
    if val in {"0", "false", "no", "n", "off"}:
        return False
    return default


DB_PATH = _env_str("DB_PATH", "data/forecasts.db")
DEFAULT_SYMBOL = _env_str("SYMBOL", "BTC/USDT")
DEFAULT_TIMEFRAME = _env_str("TIMEFRAME", "1h")

ALLOW_CORS = _env_bool("API_ALLOW_CORS", True)
ALLOWED_ORIGINS = [
    o.strip()
    for o in _env_str("API_CORS_ORIGINS", "http://localhost:5173").split(",")
    if o.strip()
]

app = FastAPI(title="Volatility Forecasting API", version="0.1.0")

if ALLOW_CORS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS if ALLOWED_ORIGINS else ["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.get("/")
def root() -> dict[str, Any]:
    return {
        "name": "Volatility Forecasting API",
        "ok": True,
        "endpoints": {
            "health": "/health",
            "forecasts": "/forecasts?symbol=BTC/USDT&timeframe=1h",
            "errors": "/errors?series=10s&symbol=BTC/USDT&limit=30",
            "docs": "/docs",
        },
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "time": datetime.now(timezone.utc).isoformat()}


@app.get("/forecasts")
def get_forecasts(
    symbol: str = Query(default=DEFAULT_SYMBOL),
    timeframe: str = Query(default=DEFAULT_TIMEFRAME),
    limit: int | None = Query(default=None, ge=1, le=500),
    newest_first: bool = Query(default=False),
) -> dict[str, Any]:
    try:
        df = read_forecasts(
            db_path=DB_PATH,
            symbol=symbol,
            timeframe=timeframe,
            limit=limit,
            newest_first=newest_first,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"DB read failed: {exc}")

    payload: dict[str, Any] = {
        "symbol": symbol,
        "timeframe": timeframe,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "forecasts": [],
    }
    if df.empty:
        return payload

    out = []
    for _, row in df.iterrows():
        ts = pd.to_datetime(row["timestamp"], utc=True, errors="coerce")
        val = row["garch_forecast"]
        if pd.isna(ts) or pd.isna(val):
            continue
        out.append({"timestamp": ts.isoformat(), "garch_forecast": float(val)})
    payload["forecasts"] = out
    return payload


@app.get("/errors")
def get_errors(
    series: str = Query(description="Error series name, e.g. '10s' or '24h'"),
    symbol: str = Query(default=DEFAULT_SYMBOL),
    limit: int = Query(default=30, ge=1, le=500),
) -> dict[str, Any]:
    try:
        df = read_latest_forecast_errors(
            db_path=DB_PATH, symbol=symbol, series=series, limit=limit
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"DB read failed: {exc}")

    payload: dict[str, Any] = {
        "symbol": symbol,
        "series": series,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "errors": [],
    }
    if df.empty:
        return payload

    out = []
    for _, row in df.iterrows():
        t = pd.to_datetime(row["event_time"], utc=True, errors="coerce")
        out.append(
            {
                "event_time": None if pd.isna(t) else t.isoformat(),
                "outside_frac": None
                if pd.isna(row["outside_frac"])
                else float(row["outside_frac"]),
                "side": None if pd.isna(row["side"]) else str(row["side"]),
            }
        )
    payload["errors"] = out
    return payload


@app.websocket("/ws/price")
async def ws_price(
    ws: WebSocket,
    symbol: str = Query(default="btcusdt", description="Binance symbol, lowercase (e.g. btcusdt)"),
    min_interval_ms: int = Query(default=500, ge=100, le=10_000),
) -> None:
    await ws.accept()
    stream = f"{symbol.lower()}@trade"
    url = f"wss://stream.binance.com:9443/ws/{stream}"

    last_sent = 0.0
    try:
        async with websockets.connect(url, ping_interval=20, ping_timeout=20) as upstream:
            await ws.send_json(
                {"type": "status", "status": "connected", "source": "binance", "stream": stream}
            )
            while True:
                msg = await upstream.recv()
                now = asyncio.get_event_loop().time() * 1000.0
                if now - last_sent < float(min_interval_ms):
                    continue
                last_sent = now

                try:
                    data = json.loads(msg)
                    p_raw = data.get("p")
                    t_raw = data.get("T")
                    if p_raw is None or t_raw is None:
                        continue
                    price = float(p_raw)
                    event_ms = int(t_raw)
                except Exception:
                    continue

                await ws.send_json(
                    {
                        "type": "trade",
                        "symbol": symbol.upper(),
                        "price": price,
                        "event_time": datetime.fromtimestamp(event_ms / 1000, tz=timezone.utc).isoformat(),
                    }
                )
    except WebSocketDisconnect:
        return
    except Exception as exc:
        try:
            await ws.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
        return

