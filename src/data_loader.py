import ccxt
import time
import pandas as pd

class DataLoader: 
    def __init__(
    self, 
    symbol: str = "BTC/USDT", 
    exchange_name: str = "binance", 
    timeframe: str = "1d", 
    limit: int = 2000, 
    since: int | None = None, 
    timeout_ms: int = 10000, 
    max_retries: int = 3,
    ):
        self.symbol = symbol
        self.exchange_name = exchange_name
        self.timeframe = timeframe
        self.limit = limit
        self.since = since
        self.timeout_ms = timeout_ms
        self.max_retries = max_retries

        exchange = getattr(ccxt, self.exchange_name)
        self.exchange = exchange({"timeout": self.timeout_ms, "enableRateLimit": True})

    def fetch_ohlcv(self):
            for attempt in range(1, self.max_retries + 1):
                try:
                    ohlcv = self.exchange.fetch_ohlcv(self.symbol, 
                    self.timeframe, 
                    limit=self.limit, 
                    since=self.since
                    )
                    if not ohlcv:
                        raise ValueError(f"No OHLCV data returned for {self.symbol}")
                    return ohlcv
                except Exception as e:
                    if attempt == self.max_retries:
                        raise RuntimeError(f"Failed to fetch OHLCV after {self.max_retries} attempts"
                        ) from e
                    time.sleep(1.5 * attempt)


    def to_dataframe(self, ohlcv):
        df = pd.DataFrame(
            ohlcv,
            columns = ["timestamp", "open", "high", "low", "close", "volume"],
            )
        df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc = True)
        df = df.sort_values(by="timestamp").reset_index(drop=True)
        return df

    def load(self):
        ohlcv = self.fetch_ohlcv()
        df = self.to_dataframe(ohlcv)
        return df