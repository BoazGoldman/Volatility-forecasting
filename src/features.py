import numpy as np
import pandas as pd


def add_log_returns(df):
    df = df.copy()
    df["log_returns"] = np.log(df["close"] / df["close"].shift(1))
    df = df.dropna(subset=["log_returns"])
    return df


def pair_log_returns(df):
    df = df.copy()
    df["log_returns1"] = np.log(df["close_1"] / df["close_1"].shift(1))
    df["log_returns2"] = np.log(df["close_2"] / df["close_2"].shift(1))
    df = df.dropna(subset=["log_returns1", "log_returns2"])
    return df


def two_coins_spread(df1: pd.DataFrame, df2: pd.DataFrame):
    left = df1[["timestamp", "close"]].rename(columns={"close": "close_1"})
    right = df2[["timestamp", "close"]].rename(columns={"close": "close_2"})

    merged = left.merge(right, on="timestamp", how="inner")
    merged["two_coins_spread"] = np.log(merged["close_1"]) - np.log(merged["close_2"])
    return merged


def k_cal(index: int) -> float:
    k_list = [0.25, 0.5, 0.75]
    return k_list[index]


def h_cal(index: int):
    h_list = [2.0, 3.0, 4.0, 5.0, 6.0]
    return h_list[index]
