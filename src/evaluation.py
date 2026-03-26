from __future__ import annotations

import numpy as np
import pandas as pd


def error_calculation(
    df: pd.DataFrame,
    *,
    window_step: int = 1,
    target_shift_steps: int = 1,
) -> pd.DataFrame:
    df = df.copy()
    df["realized_variance"] = (df["log_returns"] ** 2).rolling(window_step).sum()
    df["actual_volatility"] = np.sqrt(df["realized_variance"]).shift(-target_shift_steps)
    df["garch_error"] = (df["garch_forecast"] - df["actual_volatility"]).abs()
    df["baseline_error"] = (df["baseline_forecast"] - df["actual_volatility"]).abs()

    cols = [
        "timestamp",
        "baseline_forecast",
        "actual_volatility",
        "garch_forecast",
        "garch_error",
        "baseline_error",
    ]
    return df[cols].dropna().copy()


def mae_print(df: pd.DataFrame) -> None:
    print("GARCH MAE:", (df["garch_error"].dropna()).mean())
    print("Baseline MAE:", (df["baseline_error"].dropna()).mean())


def rmse_print(df: pd.DataFrame) -> None:
    print("GARCH RMSE:", np.sqrt((df["garch_error"].dropna() ** 2).mean()))
    print("Baseline RMSE:", np.sqrt((df["baseline_error"].dropna() ** 2).mean()))