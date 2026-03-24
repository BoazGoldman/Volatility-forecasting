import asyncio
import json
from typing import Any

import httpx
import websockets
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BINANCE_STREAM = "wss://stream.binance.com:9443/ws/btcusdt@kline_1m"
BINANCE_REST_KLINES = "https://api.binance.com/api/v3/klines"


@app.get("/")
async def root():
    return {
        "status": "ok",
        "message": "Backend is running",
        "ws_endpoint": "/ws",
        "rest": {"btc_7d": "/api/btc/prices/7d"},
    }

@app.get("/health")
async def health():
    return {"status": "healthy"}


def _parse_kline_row(row: list[Any]) -> dict[str, Any]:
    """Binance kline array: [openTime, open, high, low, close, volume, ...]."""
    open_time_ms = int(row[0])
    return {
        "open_time": open_time_ms,
        "open": float(row[1]),
        "high": float(row[2]),
        "low": float(row[3]),
        "close": float(row[4]),
        "volume": float(row[5]),
    }


@app.get("/api/btc/prices/7d")
async def btc_prices_last_7_days():
    """
    Daily OHLCV for BTC/USDT for the last 7 daily candles (Binance spot).
    """
    params = {"symbol": "BTCUSDT", "interval": "1d", "limit": 7}
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(BINANCE_REST_KLINES, params=params)
            resp.raise_for_status()
            raw = resp.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"Binance request failed: {e}") from e

    points = [_parse_kline_row(row) for row in raw]
    return {
        "symbol": "BTCUSDT",
        "pair": "BTC/USDT",
        "interval": "1d",
        "count": len(points),
        "points": points,
    }


@app.websocket("/ws")
async def ws_proxy(client: WebSocket):
    await client.accept()
    try:
        async with websockets.connect(BINANCE_STREAM, ping_interval=20, ping_timeout=20) as binance_ws:
            while True:
                raw = await binance_ws.recv()
                data = json.loads(raw)

                # kline payload is inside "k"
                k = data.get("k", {})
                payload = {
                    "symbol": data.get("s"),
                    "open_time": k.get("t"),
                    "close_time": k.get("T"),
                    "close": k.get("c"),
                    "is_closed": k.get("x"),
                }
                await client.send_json(payload)
    except WebSocketDisconnect:
        return
    except Exception as e:
        await client.send_json({"error": str(e)})
        await client.close()