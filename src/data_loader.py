from __future__ import annotations

import time
from typing import Any

import ccxt
import pandas as pd


class DataLoader:
    def __init__(
        self,
        *,
        symbol: str = "BTC/USDT",
        exchange_name: str = "binance",
        timeframe: str = "1d",
        limit: int = 2000,
        since: int | None = None,
        timeout_ms: int = 10_000,
        max_retries: int = 3,
    ) -> None:
        self.symbol = symbol
        self.exchange_name = exchange_name
        self.timeframe = timeframe
        self.limit = limit
        self.since = since
        self.timeout_ms = timeout_ms
        self.max_retries = max_retries

        exchange_cls: Any = getattr(ccxt, self.exchange_name)
        self.exchange = exchange_cls({"timeout": self.timeout_ms, "enableRateLimit": True})

    def fetch_ohlcv(self) -> list[list[float]]:
        for attempt in range(1, self.max_retries + 1):
            try:
                ohlcv = self.exchange.fetch_ohlcv(
                    self.symbol,
                    self.timeframe,
                    limit=self.limit,
                    since=self.since,
                )
                if not ohlcv:
                    raise ValueError(f"No OHLCV data returned for {self.symbol}")
                return ohlcv
            except Exception as exc:
                if attempt == self.max_retries:
                    raise RuntimeError(
                        f"Failed to fetch OHLCV after {self.max_retries} attempts"
                    ) from exc
                time.sleep(1.5 * attempt)
        raise RuntimeError("Unreachable")

    def to_dataframe(self, ohlcv: list[list[float]]) -> pd.DataFrame:
        df = pd.DataFrame(
            ohlcv,
            columns=["timestamp", "open", "high", "low", "close", "volume"],
        )
        df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
        return df.sort_values(by="timestamp").reset_index(drop=True)

    def load(self) -> pd.DataFrame:
        return self.to_dataframe(self.fetch_ohlcv())