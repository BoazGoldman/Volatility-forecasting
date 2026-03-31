export type SavedForecast = {
  timestamp: string;
  garch_forecast: number;
  delta_to_latest?: number | null;
};
