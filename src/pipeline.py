from src.data_loader import DataLoader
import pandas as pd
from typing import Callable
import src.features as features
from src.features import add_log_returns, pair_log_returns
from src.model import volatility_baseline_model, garch_model
from src.evaluation import error_calculation, mae_print, rmse_print
from src.signal import CusumSignal


# ----------------------DATA PIPELINES-------------------------------
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


def run_pair_pipeline(
    feature_functions: list[Callable] | None = None,
    symbol1: str = "BTC/USDT",
    exchange_name1: str = "binance",
    timeframe1: str = "1m",
    limit1: int = 2000,
    symbol2: str = "DOGE/USDT",
    exchange_name2: str = "binance",
    timeframe2: str = "1m",
    limit2: int = 2000,
):

    df1 = DataLoader(
        symbol=symbol1, exchange_name=exchange_name1, timeframe=timeframe1, limit=limit1
    ).load()

    df2 = DataLoader(
        symbol=symbol2, exchange_name=exchange_name2, timeframe=timeframe2, limit=limit2
    ).load()

    df = features.two_coins_spread(df1, df2)
    df = df.dropna(subset=["close_1", "close_2"])
    df = df.sort_values("timestamp").reset_index(drop=True)

    if feature_functions is not None:
        for fn in feature_functions:
            df = fn(df)

    return df


# ----------------------SIGNAL PIPELINES-----------------------------------
def run_cusum_pipeline(df: pd.DataFrame, k_index: int = 0, h_index: int = 0):

    cusum = CusumSignal(df, k_index=k_index, h_index=h_index)
    signals: list[int] = []
    s_pos_vals: list[float] = []
    s_neg_vals: list[float] = []

    i = 0
    while i < len(df):
        relative_return = float(df.iloc[i]["log_returns2"] - df.iloc[i]["log_returns1"])
        signal = cusum.update(relative_return)
        signals.append(signal)
        s_pos_vals.append(cusum.s_pos)
        s_neg_vals.append(cusum.s_neg)
        i += 1

    df["relative_return"] = df["log_returns2"] - df["log_returns1"]
    df["cusum_signal"] = signals
    df["cusum_pos"] = s_pos_vals
    df["cusum_neg"] = s_neg_vals

    print(
        df[
            ["timestamp", "relative_return", "cusum_pos", "cusum_neg", "cusum_signal"]
        ].tail()
    )
    return df


def ohlcv_1s_to_10s(df: pd.DataFrame) -> pd.DataFrame:
    """Binance has 1s klines, not 10s; aggregate OHLCV into 10-second bars."""
    if df.empty:
        return df.copy()

    work = df.sort_values("timestamp").set_index("timestamp")
    agg = (
        work.resample("10s", label="right", closed="right")
        .agg(
            {
                "open": "first",
                "high": "max",
                "low": "min",
                "close": "last",
                "volume": "sum",
            }
        )
        .dropna(subset=["close"])
    )
    return agg.reset_index()


def run_garch_pipeline(
    symbol: str = "BTC/USDT",
    exchange_name: str = "binance",
    timeframe: str = "1h",
    limit: int = 2000,
    baseline_window_step: int = 480,
    garch_horizon_step: int = 24,
    garch_p: int = 1,
    garch_o: int = 0,
    garch_q: int = 1,
    garch_dist: str = "normal",
    garch_mean: str = "Constant",
    eval_window_step: int = 24,
    eval_target_shift_steps: int = 24,
    preprocess: Callable[[pd.DataFrame], pd.DataFrame] | None = None,
):
    """
    Load OHLCV for `timeframe`, optionally reshape with `preprocess` (e.g. `ohlcv_1s_to_10s`
    when `timeframe='1s'`), then shared baseline + GARCH + eval path.
    """
    df = run_data_pipeline(
        feature_functions=None,
        symbol=symbol,
        exchange_name=exchange_name,
        timeframe=timeframe,
        limit=limit,
    )
    if preprocess is not None:
        df = preprocess(df)
    df = add_log_returns(df)

    df = volatility_baseline_model(df, window_step=baseline_window_step)

    df, _res = garch_model(
        df,
        horizon_step=garch_horizon_step,
        p=garch_p,
        o=garch_o,
        q=garch_q,
        dist=garch_dist,
        mean=garch_mean,
    )

    eval_df = error_calculation(
        df,
        window_step=eval_window_step,
        target_shift_steps=eval_target_shift_steps,
    )

    print(
        eval_df[
            [
                "timestamp",
                "baseline_forecast",
                "garch_forecast",
                "actual_volatility",
                "garch_error",
                "baseline_error",
            ]
        ].tail()
    )

    mae_print(eval_df)
    rmse_print(eval_df)
    return eval_df[["timestamp", "garch_forecast"]]


# --------------------------------------TEST PIPELINE----------------------------------------
def run_test_pipeline(
    symbol1: str = "BTC/USDT",
    symbol2: str = "DOGE/USDT",
    timeframe: str = "1m",
    limit: int = 2000,
):

    df = run_pair_pipeline(
        feature_functions=[features.pair_log_returns],
        symbol1=symbol1,
        symbol2=symbol2,
        timeframe1=timeframe,
        timeframe2=timeframe,
        limit1=limit,
        limit2=limit,
    )

    df_forecast = run_garch_pipeline()

    df_joined = pd.merge_asof(df, df_forecast, on="timestamp", direction="backward")

    for k_index in range(3):
        for h_index in range(5):
            new_df = run_cusum_pipeline(
                df_joined.copy(), k_index=k_index, h_index=h_index
            )
            print(f"k_index: {k_index}, h_index: {h_index}")
            print(
                new_df[
                    [
                        "timestamp",
                        "relative_return",
                        "cusum_pos",
                        "cusum_neg",
                        "cusum_signal",
                    ]
                ].tail()
            )
