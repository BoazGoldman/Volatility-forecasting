from src.data_loader import DataLoader
from typing import Callable


def run_data_pipeline(
    feature_functions: list[Callable] | None = None,
    symbol: str = "BTC/USDT",
    exchange_name: str = "binance",
    timeframe: str = "1d",
    limit: int = 2000,
):

    loader = DataLoader(
        symbol=symbol,
        exchange_name=exchange_name,
        timeframe=timeframe,
        limit=limit,
    )

    df = loader.load()

    if feature_functions is not None:
       for feature_fn in feature_functions:
           df = feature_fn(df)

    return df