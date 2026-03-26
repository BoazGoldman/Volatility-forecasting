from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
from arch import arch_model

from src.data_loader import DataLoader
from src.pipeline import ohlcv_1s_to_10s
from src.features import add_log_returns


def floor_dt_to_step(dt: datetime, step_seconds: int) -> datetime:
    if dt.tzinfo is None:
        raise ValueError("dt must be timezone-aware")
    if step_seconds <= 0:
        raise ValueError("step_seconds must be positive")
    epoch = dt.timestamp()
    floored = epoch - (epoch % step_seconds)
    return datetime.fromtimestamp(floored, tz=timezone.utc)


@dataclass
class LiveGarch11:
    """
    Lightweight live 1-step σ forecaster for 10s bars.

    We refit parameters occasionally (slow), then update conditional variance per new bar (fast):
      eps_t = r_t - mu
      h_{t+1} = omega + alpha * eps_t^2 + beta * h_t
      sigma_{t+1} = sqrt(h_{t+1}) / 100

    Internals operate on percent returns (log_return * 100) to match `src.model.garch_model`.
    """

    mu: float
    omega: float
    alpha: float
    beta: float
    h_t: float
    last_bar_end: datetime | None = None

    @classmethod
    def fit_from_10s_bars(
        cls,
        bars_10s: pd.DataFrame,
        *,
        mean: str = "Constant",
        dist: str = "normal",
    ) -> "LiveGarch11":
        df = add_log_returns(bars_10s)
        if df.empty:
            raise ValueError("Not enough data to fit GARCH (empty after returns).")

        returns_pct = (df["log_returns"].dropna() * 100).astype(float)
        if len(returns_pct) < 20:
            raise ValueError("Not enough returns to fit GARCH robustly (need >= 20).")

        am = arch_model(returns_pct, vol="GARCH", p=1, o=0, q=1, mean=mean, dist=dist)
        res = am.fit(disp="off")

        params = res.params.to_dict()

        # Mean parameter name varies by mean spec; be tolerant.
        mu = float(params.get("mu", params.get("Const", 0.0)))
        omega = float(params["omega"])
        alpha = float(params.get("alpha[1]", params.get("alpha[0]")))
        beta = float(params.get("beta[1]", params.get("beta[0]")))

        cv = pd.Series(res.conditional_volatility).dropna()
        if cv.empty:
            raise ValueError("Model fit produced no conditional volatility.")
        h_t = float(cv.iloc[-1] ** 2)  # percent^2

        return cls(mu=mu, omega=omega, alpha=alpha, beta=beta, h_t=h_t)

    def update_with_return_pct(self, r_t_pct: float) -> float:
        """Update state with newest percent return; return σ forecast for next 10s bar (fraction)."""
        eps = float(r_t_pct) - self.mu
        h_next = self.omega + self.alpha * (eps**2) + self.beta * self.h_t
        if not np.isfinite(h_next) or h_next <= 0:
            # If numerically unstable, do not update state; return NaN to signal caller.
            return float("nan")
        self.h_t = float(h_next)
        return float(np.sqrt(h_next) / 100.0)

    def sigma_horizon(self, horizon_steps: int) -> float:
        """
        σ for a multi-step horizon, matching `src.model.garch_model` behavior:
        for horizon>1 we aggregate by sqrt(sum of step variances).
        Returns a fraction (not percent).
        """
        if horizon_steps < 1:
            return float("nan")
        if not np.isfinite(self.h_t) or self.h_t <= 0:
            return float("nan")
        if horizon_steps == 1:
            return float(np.sqrt(self.h_t) / 100.0)
        phi = float(self.alpha + self.beta)
        h = float(self.h_t)
        total = 0.0
        for _ in range(horizon_steps):
            total += h
            h = float(self.omega + phi * h)
            if not np.isfinite(h) or h <= 0:
                return float("nan")
        return float(np.sqrt(total) / 100.0)


def fetch_recent_10s_bars(
    *,
    symbol: str,
    exchange_name: str,
    limit_1s: int,
) -> pd.DataFrame:
    """Fetch recent 1s klines and aggregate into 10s OHLCV bars."""
    loader = DataLoader(symbol=symbol, exchange_name=exchange_name, timeframe="1s", limit=limit_1s)
    df_1s = loader.load()
    bars_10s = ohlcv_1s_to_10s(df_1s)
    if not bars_10s.empty:
        bars_10s["timestamp"] = pd.to_datetime(bars_10s["timestamp"], utc=True, errors="coerce")
        bars_10s = bars_10s.dropna(subset=["timestamp"]).sort_values("timestamp").reset_index(drop=True)
    return bars_10s


def fetch_recent_bars(
    *,
    symbol: str,
    exchange_name: str,
    timeframe: str,
    limit: int,
    preprocess=None,
) -> pd.DataFrame:
    """Fetch recent OHLCV and optionally preprocess (e.g. resample)."""
    loader = DataLoader(symbol=symbol, exchange_name=exchange_name, timeframe=timeframe, limit=limit)
    df = loader.load()
    if preprocess is not None:
        df = preprocess(df)
    if not df.empty:
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
        df = df.dropna(subset=["timestamp"]).sort_values("timestamp").reset_index(drop=True)
    return df


def latest_closed_10s_return_pct(
    bars_10s: pd.DataFrame,
    *,
    bar_end: datetime,
) -> tuple[float, float] | None:
    """
    Compute percent log-return for the bar that ended at `bar_end` versus previous 10s bar.
    Returns (return_pct, close_t) or None if bars missing.
    """
    if bars_10s.empty:
        return None
    ts = pd.to_datetime(bars_10s["timestamp"], utc=True, errors="coerce")
    work = bars_10s.assign(timestamp=ts).dropna(subset=["timestamp"]).sort_values("timestamp")

    # Prefer the bar that ended exactly at `bar_end`, but tolerate exchange / fetch lag by
    # falling back to the newest bar with timestamp <= bar_end.
    end_ts = pd.Timestamp(bar_end)
    row_t = work[work["timestamp"] == end_ts].tail(1)
    if row_t.empty:
        row_t = work[work["timestamp"] <= end_ts].tail(1)
        if row_t.empty:
            return None
        end_ts = pd.Timestamp(row_t.iloc[0]["timestamp"])

    row_prev = work[work["timestamp"] == (end_ts - pd.Timedelta(seconds=10))].tail(1)
    if row_prev.empty:
        row_prev = work[work["timestamp"] < end_ts].tail(1)
    if row_prev.empty:
        return None

    close_t = float(row_t.iloc[0]["close"])
    close_prev = float(row_prev.iloc[0]["close"])
    if close_t <= 0 or close_prev <= 0:
        return None

    r = float(np.log(close_t / close_prev) * 100.0)
    return r, close_t


def next_10s_boundary_utc(now: datetime) -> datetime:
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    floored = floor_dt_to_step(now, 10)
    if floored == now.replace(microsecond=0) and now.microsecond == 0:
        # exactly on the boundary -> treat next boundary as +10s
        return floored + timedelta(seconds=10)
    return floored + timedelta(seconds=10)

