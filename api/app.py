from __future__ import annotations

import contextlib
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


class _BinanceTradeHub:
    """
    One upstream Binance trade WebSocket per stream; fan out snapshots to many browser clients.
    Avoids N parallel Binance connections when multiple tabs/users are connected.
    """

    def __init__(self, stream: str) -> None:
        self.stream = stream
        self.url = f"wss://stream.binance.com:9443/ws/{stream}"
        self._guard = asyncio.Lock()
        self._consumers = 0
        self._task: asyncio.Task[None] | None = None
        self.latest_trade: dict[str, Any] | None = None
        self.latest_event_ms: int | None = None

    async def acquire(self) -> None:
        async with self._guard:
            self._consumers += 1
            if self._task is None:
                self._task = asyncio.create_task(self._upstream_loop(), name=f"binance-hub-{self.stream}")

    async def release(self) -> None:
        task_to_cancel: asyncio.Task[None] | None = None
        async with self._guard:
            self._consumers = max(0, self._consumers - 1)
            if self._consumers == 0 and self._task is not None:
                task_to_cancel = self._task
                self._task = None
                self.latest_trade = None
                self.latest_event_ms = None
        if task_to_cancel is not None:
            task_to_cancel.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task_to_cancel

    async def _upstream_loop(self) -> None:
        runner = asyncio.current_task()
        backoff = 1.0
        try:
            while True:
                async with self._guard:
                    if self._consumers <= 0:
                        return
                try:
                    async with websockets.connect(
                        self.url, ping_interval=20, ping_timeout=20
                    ) as upstream:
                        backoff = 1.0
                        while True:
                            async with self._guard:
                                if self._consumers <= 0:
                                    return
                            raw = await upstream.recv()
                            try:
                                data = json.loads(raw)
                                p_raw = data.get("p")
                                t_raw = data.get("T")
                                if p_raw is not None and t_raw is not None:
                                    event_ms = int(t_raw)
                                    sym = str(data.get("s", "")).strip().upper()
                                    if not sym:
                                        sym = self.stream.split("@", 1)[0].upper()
                                    self.latest_trade = {
                                        "type": "trade",
                                        "symbol": sym,
                                        "price": float(p_raw),
                                        "event_time": datetime.fromtimestamp(
                                            event_ms / 1000, tz=timezone.utc
                                        ).isoformat(),
                                    }
                                    self.latest_event_ms = event_ms
                            except Exception:
                                continue
                except asyncio.CancelledError:
                    raise
                except Exception:
                    await asyncio.sleep(min(backoff, 30.0))
                    backoff = min(backoff * 1.8, 30.0)
        except asyncio.CancelledError:
            return
        finally:
            async with self._guard:
                if self._task is runner:
                    self._task = None


_trade_hubs: dict[str, _BinanceTradeHub] = {}
_hubs_lock = asyncio.Lock()


async def _hub_for_stream(stream: str) -> _BinanceTradeHub:
    key = stream.lower()
    async with _hubs_lock:
        hub = _trade_hubs.get(key)
        if hub is None:
            hub = _BinanceTradeHub(key)
            _trade_hubs[key] = hub
        return hub


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
    for o in _env_str(
        "API_CORS_ORIGINS",
        "http://localhost:5173,https://bg-crypto-sandbox.web.app,https://bg-crypto-sandbox.firebaseapp.com",
    ).split(",")
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
            "errors": "/errors?series=24h&symbol=BTC/USDT&limit=30",
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
    stream = f"{symbol.lower()}@trade"
    hub = await _hub_for_stream(stream)
    await hub.acquire()
    interval_s = float(min_interval_ms) / 1000.0
    loop = asyncio.get_running_loop()
    next_emit = loop.time() + interval_s
    last_sent_event_ms: int | None = None
    try:
        await ws.accept()
        await ws.send_json(
            {"type": "status", "status": "connected", "source": "binance", "stream": stream}
        )
        while True:
            timeout_s = max(0.0, next_emit - loop.time())
            await asyncio.sleep(timeout_s)

            now = loop.time()
            if now >= next_emit:
                payload = hub.latest_trade
                ev = hub.latest_event_ms
                if payload is not None and ev is not None and ev != last_sent_event_ms:
                    out = dict(payload)
                    out["symbol"] = symbol.upper()
                    await ws.send_json(out)
                    last_sent_event_ms = ev
                while next_emit <= now:
                    next_emit += interval_s
    except WebSocketDisconnect:
        return
    except Exception as exc:
        try:
            await ws.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
        return
    finally:
        await hub.release()

