from __future__ import annotations

import pandas as pd
from arch import arch_model


def volatility_baseline_model(df: pd.DataFrame, *, window_step: int = 1) -> pd.DataFrame:
    df = df.copy()
    df["baseline_forecast"] = df["log_returns"].rolling(window_step).std()
    return df.dropna(subset=["baseline_forecast"])


def garch_model(
    df: pd.DataFrame,
    horizon_step: int = 1,
    p: int = 1,
    o: int = 1,
    q: int = 1,
    dist: str = "normal",
    mean: str = "Constant",
) -> tuple[pd.DataFrame, object]:

    df = df.copy()
    returns = df["log_returns"].dropna() * 100
    am = arch_model(returns, vol="GARCH", p=p, o=o, q=q, mean=mean, dist=dist)
    res = am.fit(disp="off")

    cond_vol = (res.conditional_volatility / 100).rename("garch_volatility")
    df = df.join(cond_vol, how="left")

    fvar_df = res.forecast(horizon=horizon_step, start=0).variance

    if horizon_step == 1:
        fvar = fvar_df["h.1"]

    else:
        cols = [f"h.{i:02d}" for i in range(1, horizon_step + 1)]
        fvar = fvar_df[cols].sum(axis=1)

    fvol = (fvar**0.5) / 100

    df = df.join(fvol.rename("garch_forecast"), how="left")
    df = df.dropna(subset=["garch_forecast"])
    return df, res
