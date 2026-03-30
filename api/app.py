from __future__ import annotations

import contextlib
import asyncio
import json
from datetime import datetime, timezone
import os
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from src.storage import read_forecasts

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


def _cors_origins() -> list[str]:
    """
    In production, prefer setting `API_CORS_ORIGINS` to a comma-separated allowlist.
    If unset, we default to common local + Firebase hosting origins.
    """
    raw = _env_str(
        "API_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,https://bg-crypto-sandbox.web.app,https://bg-crypto-sandbox.firebaseapp.com",
    )
    return [o.strip() for o in raw.split(",") if o.strip()]


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
                                    payload = {
                                        "type": "trade",
                                        "symbol": sym,
                                        "price": float(p_raw),
                                        "event_time": datetime.fromtimestamp(
                                            event_ms / 1000, tz=timezone.utc
                                        ).isoformat(),
                                    }
                                    async with self._guard:
                                        self.latest_trade = payload
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

    async def snapshot(self) -> dict[str, Any] | None:
        async with self._guard:
            if self.latest_trade is None:
                return None
            return dict(self.latest_trade)


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


app = FastAPI(title="Volatility Forecasting API", version="0.2.0")
_allow_all = _env_bool("API_CORS_ALLOW_ALL", False)
_origins = ["*"] if _allow_all else _cors_origins()
# Browsers forbid cookies/credentials when `Access-Control-Allow-Origin: *`.
_allow_credentials = False if _origins == ["*"] else True
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=_allow_credentials,
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
            "forecasts": "/forecasts?symbol=BTC/USDT&timeframe=5s_60s&limit=30&newest_first=true",
            "daily_prices": "/market/daily?symbol=BTCUSDT&days=7",
            "ws_price": "/ws/price?symbol=btcusdt&interval_ms=1000",
            "docs": "/docs",
        },
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "time": datetime.now(timezone.utc).isoformat()}


@app.get("/forecasts")
def get_forecasts(
    symbol: str = Query(default="BTC/USDT", description="Forecast series symbol, e.g. BTC/USDT"),
    timeframe: str = Query(default="5s_60s", description="Forecast timeframe key, e.g. 5s_60s"),
    limit: int | None = Query(default=120, ge=1, le=2000),
    newest_first: bool = Query(default=True),
) -> dict[str, Any]:
    """
    Reads forecast rows from the local SQLite DB and returns the JSON shape the frontend expects.
    """
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

    out: list[dict[str, Any]] = []
    if not df.empty:
        # `read_forecasts` already returns `timestamp` as ISO string from SQLite.
        for _, row in df.iterrows():
            ts = row.get("timestamp")
            val = row.get("garch_forecast")
            if ts is None or val is None:
                continue
            try:
                out.append({"timestamp": str(ts), "garch_forecast": float(val)})
            except Exception:
                continue

    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "forecasts": out,
    }


def _fetch_binance_klines(*, symbol: str, interval: str, limit: int) -> list[list[Any]]:
    base = "https://api.binance.com/api/v3/klines"
    qs = urlencode({"symbol": symbol.upper(), "interval": interval, "limit": int(limit)})
    req = Request(f"{base}?{qs}", headers={"User-Agent": "vol-forecast-api/0.2"})
    with urlopen(req, timeout=15) as resp:
        raw = resp.read().decode("utf-8")
    data = json.loads(raw)
    if not isinstance(data, list):
        raise ValueError("Unexpected Binance response shape")
    return data


@app.get("/market/daily")
async def get_daily_prices(
    symbol: str = Query(default="BTCUSDT", description="Binance symbol, e.g. BTCUSDT"),
    days: int = Query(default=7, ge=1, le=60),
) -> dict[str, Any]:
    """
    Returns the last N daily candles (1d) and daily closes.
    Intended for the "last 7 days" graph.
    """
    try:
        klines = await asyncio.to_thread(_fetch_binance_klines, symbol=symbol, interval="1d", limit=days)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Binance fetch failed: {exc}")

    out: list[dict[str, Any]] = []
    for k in klines:
        if not isinstance(k, list) or len(k) < 7:
            continue
        open_time_ms = int(k[0])
        close_price = float(k[4])
        close_time_ms = int(k[6])
        out.append(
            {
                "open_time": datetime.fromtimestamp(open_time_ms / 1000, tz=timezone.utc).isoformat(),
                "close_time": datetime.fromtimestamp(close_time_ms / 1000, tz=timezone.utc).isoformat(),
                "close": close_price,
            }
        )

    return {
        "symbol": symbol.upper(),
        "interval": "1d",
        "days": days,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "candles": out,
    }


@app.websocket("/ws/price")
async def ws_price(
    ws: WebSocket,
    symbol: str = Query(default="btcusdt", description="Binance symbol, lowercase (e.g. btcusdt)"),
    interval_ms: int = Query(default=1000, ge=250, le=10_000),
) -> None:
    stream = f"{symbol.lower()}@trade"
    hub = await _hub_for_stream(stream)
    await hub.acquire()
    interval_s = float(interval_ms) / 1000.0
    loop = asyncio.get_running_loop()
    next_emit = loop.time() + interval_s
    try:
        await ws.accept()
        await ws.send_json(
            {"type": "status", "status": "connected", "source": "binance", "stream": stream}
        )
        # Send an immediate snapshot (if we already have one) so the UI doesn't wait a full interval.
        payload0 = await hub.snapshot()
        if payload0 is not None:
            out0 = dict(payload0)
            out0["symbol"] = symbol.upper()
            out0["server_time"] = datetime.now(timezone.utc).isoformat()
            await ws.send_json(out0)
        while True:
            timeout_s = max(0.0, next_emit - loop.time())
            await asyncio.sleep(timeout_s)

            now = loop.time()
            if now >= next_emit:
                payload = await hub.snapshot()
                if payload is not None:
                    out = dict(payload)
                    out["symbol"] = symbol.upper()
                    out["server_time"] = datetime.now(timezone.utc).isoformat()
                    await ws.send_json(out)
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

