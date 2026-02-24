import pandas as pd
import numpy as np

#-------------------------------- GARCH ERROR CALCULATION --------------------------------
def error_calculation(df: pd.DataFrame, window_step: int = 1, target_shift_steps: int = 1,) -> pd.DataFrame:
    df = df.copy()
    df["realized_variance"] = (df["log_returns"] ** 2).rolling(window_step).sum()  
    df["actual_volatility"] = np.sqrt(df["realized_variance"])
    df["actual_volatility"] = df["actual_volatility"].shift(-target_shift_steps)

    df["garch_error"] = (df["garch_forecast"] - df["actual_volatility"]).abs()
    df["baseline_error"] = (df["baseline_forecast"] - df["actual_volatility"]).abs()

    df = df[["timestamp", "baseline_forecast", "actual_volatility", "garch_forecast", "garch_error", "baseline_error"]].dropna().copy()
    return df

def mae_print(df: pd.DataFrame) -> None:
    garch_mae = (df["garch_error"].dropna()).mean()
    baseline_mae = (df["baseline_error"].dropna()).mean()

    print("GARCH MAE:", garch_mae)
    print("Baseline MAE:", baseline_mae)

def rmse_print(df: pd.DataFrame) -> None:
    garch_rmse = np.sqrt((df["garch_error"].dropna() ** 2).mean())
    baseline_rmse = np.sqrt((df["baseline_error"].dropna() ** 2).mean())

    print("GARCH RMSE:", garch_rmse)
    print("Baseline RMSE:", baseline_rmse)
#-----------------------------------------------------------------------------------------

#-------------------------------- OTHER ERROR CALCULATION --------------------------------