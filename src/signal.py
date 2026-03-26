from __future__ import annotations

import pandas as pd

from src.features import h_cal, k_cal


class CusumSignal:
    def __init__(self, df: pd.DataFrame, k_index: int, h_index: int) -> None:
        self.s_pos = 0.0
        self.s_neg = 0.0
        self.df = df
        self.k_index = k_index
        self.h_index = h_index
        self.base_k = k_cal(self.k_index)
        self.base_h = h_cal(self.h_index)
        self.k = self.base_k
        self.h = self.base_h

    def update(self, relative_return: float) -> int:
        self.s_pos = max(0.0, self.s_pos + relative_return - self.k)
        self.s_neg = min(0.0, self.s_neg + relative_return + self.k)

        if self.s_pos > self.h:
            self.s_pos = 0.0
            self.s_neg = 0.0
            return 1
        if self.s_neg < -self.h:
            self.s_pos = 0.0
            self.s_neg = 0.0
            return -1
        return 0

    def refresh_k_h(self, df: pd.DataFrame) -> None:
        volatility = float(df["garch_forecast"].iloc[-1])
        self.k = self.base_k * volatility

        max_scale_h = 8.0
        min_scale_h = 0.01
        self.h = self.base_h * volatility

        if self.h > max_scale_h:
            self.h = max_scale_h
        if self.h < min_scale_h:
            self.h = min_scale_h
