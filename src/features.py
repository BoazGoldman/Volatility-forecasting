import numpy as np

def add_log_returns(df):
    df = df.copy()
    df["log_returns"] = np.log(df["close"] / df["close"].shift(1))
    df = df.dropna(subset = ["log_returns"]) 
    return df