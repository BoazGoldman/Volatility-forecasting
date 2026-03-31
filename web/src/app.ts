import type { SavedForecast } from "./graphs/forecastTypes";
import {
  dailyPointsFromApi,
  dateKeyUtc,
  drawSevenDayChart,
  layoutChart7dCanvas,
  resizeSevenDayChart,
  splitForecastRows,
  type DailyPoint,
} from "./graphs/sevenDayChart";
import {
  drawOneHourChart,
  hourlyPointsFromApi,
  layoutChart1hCanvas,
  resizeOneHourChart,
  type HourlyPoint,
} from "./graphs/oneHourChart";

const BINANCE_SYMBOL = "BTCUSDT";
const BINANCE_PAIR = "BTC/USDT";
const API_BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE ??
  "http://127.0.0.1:8000";

const MARKET_DAILY_URL = `${API_BASE}/market/daily?symbol=${encodeURIComponent(BINANCE_SYMBOL)}&days=7`;
const MARKET_HOURLY_URL = `${API_BASE}/market/hourly?symbol=${encodeURIComponent(BINANCE_SYMBOL)}&hours=12`;
/** 7d Binance klines + saved forecasts: schedule reloads at these UTC hours only. */
const SEVEN_DAY_UTC_RELOAD_HOURS = [0, 12] as const;

const chartTitleEl = document.getElementById("chart-title");
const rest7dStatusEl = document.getElementById("rest-7d-status");
const rest1hStatusEl = document.getElementById("rest-1h-status");
const vol1hSigmaEl = document.getElementById("vol-1h-sigma");
const inBound1hEl = document.getElementById("in-bound-1h");
const lastUpdated1hEl = document.getElementById("last-updated-1h");
const forecastSuccessRate1hEl = document.getElementById("forecast-success-rate-1h");
const vol24hSigmaEl = document.getElementById("vol-24h-sigma");
const ydayBandEl = document.getElementById("yday-band");
const lastUpdated7dEl = document.getElementById("last-updated-7d");
const forecastSuccessRateEl = document.getElementById("forecast-success-rate");
const graphSelectEl = document.getElementById("graph-select") as HTMLSelectElement | null;
const graph7dEl = document.getElementById("graph-7d");
const graph1hEl = document.getElementById("graph-1h");

let lastSevenDayDisplay: DailyPoint[] = [];
let lastOneHourDisplay: HourlyPoint[] = [];
let lastSavedForecasts7d: SavedForecast[] = [];
let lastSavedForecasts1h: SavedForecast[] = [];
let activeGraph: "1h" | "7d" = "1h";
let sevenDayHasLoaded = false;
let oneHourHasLoaded = false;
let oneHourLoadInFlight: Promise<void> | null = null;
let oneHourForecastRefreshInFlight: Promise<void> | null = null;
let sevenDayLoadInFlight: Promise<void> | null = null;

function formatLocalUpdateTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(new Date(ms));
}

function updateOneHourKpis(points: HourlyPoint[], forecasts: SavedForecast[]) {
  if (vol1hSigmaEl) vol1hSigmaEl.textContent = "—";
  if (lastUpdated1hEl) lastUpdated1hEl.textContent = "—";
  if (inBound1hEl) {
    inBound1hEl.textContent = "—";
    inBound1hEl.classList.remove("buy", "sell", "neutral");
    inBound1hEl.classList.add("neutral");
  }
  if (forecastSuccessRate1hEl) {
    forecastSuccessRate1hEl.textContent = "—";
    forecastSuccessRate1hEl.classList.remove("buy", "sell", "neutral");
    forecastSuccessRate1hEl.classList.add("neutral");
  }

  if (forecasts.length > 0 && vol1hSigmaEl) {
    const latestForecast = [...forecasts]
      .filter((r) => Number.isFinite(Date.parse(r.timestamp)) && Number.isFinite(Number(r.garch_forecast)))
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .at(-1);
    if (latestForecast) {
      const s = Math.max(Number(latestForecast.garch_forecast), 0);
      if (Number.isFinite(s)) vol1hSigmaEl.textContent = `${(s * 100).toFixed(4)}%`;
      if (lastUpdated1hEl) {
        const ts = Date.parse(latestForecast.timestamp);
        if (Number.isFinite(ts)) lastUpdated1hEl.textContent = formatLocalUpdateTime(ts);
      }
    }
  }

  if (!inBound1hEl) return;
  const realPoints = points.filter((p) => typeof p.close === "number" && Number.isFinite(p.close));
  if (realPoints.length < 2 || forecasts.length === 0) return;

  const latestClose = realPoints[realPoints.length - 1].close as number;
  const prevClose = realPoints[realPoints.length - 2].close as number;
  const latestForecast = [...forecasts]
    .filter((r) => Number.isFinite(Date.parse(r.timestamp)) && Number.isFinite(Number(r.garch_forecast)))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .at(-1);
  if (!latestForecast || !Number.isFinite(prevClose) || !Number.isFinite(latestClose) || prevClose <= 0) return;

  const sigma = Math.max(Number(latestForecast.garch_forecast), 0);
  if (!Number.isFinite(sigma)) return;
  const lo = prevClose * (1 - sigma);
  const hi = prevClose * (1 + sigma);
  const low = Math.min(lo, hi);
  const high = Math.max(lo, hi);

  inBound1hEl.classList.remove("buy", "sell", "neutral");
  if (latestClose >= low && latestClose <= high) {
    inBound1hEl.textContent = "In bound";
    inBound1hEl.classList.add("buy");
  } else {
    inBound1hEl.textContent = "Out of bound";
    inBound1hEl.classList.add("sell");
  }

  if (!forecastSuccessRate1hEl) return;
  const forecastRows = forecasts
    .map((f) => ({ t: Date.parse(f.timestamp), sigma: Math.max(Number(f.garch_forecast), 0) }))
    .filter((f) => Number.isFinite(f.t) && Number.isFinite(f.sigma))
    .sort((a, b) => a.t - b.t);
  if (forecastRows.length === 0) return;

  let j = 0;
  let total = 0;
  let inside = 0;
  for (let i = 1; i < realPoints.length; i += 1) {
    const t = realPoints[i].open_time;
    const prev = realPoints[i - 1].close as number;
    const curr = realPoints[i].close as number;
    if (!Number.isFinite(t) || !Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) continue;
    while (j + 1 < forecastRows.length && forecastRows[j + 1].t <= t) j += 1;
    if (forecastRows[j].t > t) continue;
    const s = forecastRows[j].sigma;
    const low = prev * (1 - s);
    const high = prev * (1 + s);
    total += 1;
    if (curr >= Math.min(low, high) && curr <= Math.max(low, high)) inside += 1;
  }
  if (total === 0) return;
  const rate = (inside / total) * 100;
  forecastSuccessRate1hEl.textContent = `${rate.toFixed(1)}% (${inside}/${total})`;
  forecastSuccessRate1hEl.classList.remove("neutral");
  forecastSuccessRate1hEl.classList.add(rate >= 50 ? "buy" : "sell");
}

async function loadSavedForecasts(): Promise<SavedForecast[]> {
  const DAILY_FORECAST_TIMEFRAME = "1h_24h_at_00utc";
  const urlFromApi = `${API_BASE}/forecasts?symbol=${encodeURIComponent(BINANCE_PAIR)}&timeframe=${encodeURIComponent(DAILY_FORECAST_TIMEFRAME)}&newest_first=false&limit=120`;
  const tryUrls = [urlFromApi, "/forecasts_24h.json"];
  for (const url of tryUrls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const payload = (await res.json()) as { forecasts?: SavedForecast[] };
      if (Array.isArray(payload.forecasts)) {
        return payload.forecasts
          .filter((r) => r && typeof r.timestamp === "string" && Number.isFinite(Number(r.garch_forecast)))
          .map((r) => ({ timestamp: r.timestamp, garch_forecast: Number(r.garch_forecast) }));
      }
    } catch {
      // try next
    }
  }
  return [];
}

async function loadSavedForecasts1h(): Promise<SavedForecast[]> {
  const HOURLY_FORECAST_TIMEFRAME = "5m_1h";
  const urlFromApi = `${API_BASE}/forecasts?symbol=${encodeURIComponent(BINANCE_PAIR)}&timeframe=${encodeURIComponent(HOURLY_FORECAST_TIMEFRAME)}&newest_first=false&limit=24&include_delta_to_latest=true`;
  const tryUrls = [urlFromApi, "/forecasts_1h.json"];
  for (const url of tryUrls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const payload = (await res.json()) as {
        latest_garch_forecast?: number | null;
        forecasts?: Array<{ timestamp?: string; garch_forecast?: number; delta_to_latest?: number | null }>;
      };
      if (Array.isArray(payload.forecasts)) {
        const parsed = payload.forecasts
          .filter((r) => r && typeof r.timestamp === "string" && Number.isFinite(Number(r.garch_forecast)))
          .map((r) => ({
            timestamp: String(r.timestamp),
            garch_forecast: Number(r.garch_forecast),
            delta_to_latest:
              r.delta_to_latest === null || r.delta_to_latest === undefined
                ? null
                : Number.isFinite(Number(r.delta_to_latest))
                  ? Number(r.delta_to_latest)
                  : null,
          }));
        if (url.endsWith("/forecasts_1h.json") && parsed.length > 0) {
          const latest = parsed[parsed.length - 1]?.garch_forecast;
          if (Number.isFinite(latest)) {
            return parsed.map((r) => ({ ...r, delta_to_latest: r.garch_forecast - (latest as number) }));
          }
        }
        return parsed.slice(-24);
      }
    } catch {
      // try next
    }
  }
  return [];
}

function updateForecastSuccessRate(points: DailyPoint[], forecasts: SavedForecast[]) {
  if (!forecastSuccessRateEl) return;
  forecastSuccessRateEl.textContent = "—";
  forecastSuccessRateEl.classList.remove("buy", "sell", "neutral");
  forecastSuccessRateEl.classList.add("neutral");

  const midnightRows = forecasts.filter((f) => {
    const t = new Date(f.timestamp);
    return (
      Number.isFinite(t.getTime()) &&
      t.getUTCHours() === 0 &&
      t.getUTCMinutes() === 0 &&
      t.getUTCSeconds() === 0
    );
  });
  if (midnightRows.length === 0 || points.length < 2) return;

  let total = 0;
  let inside = 0;

  for (const row of midnightRows) {
    const ts = Date.parse(row.timestamp);
    if (!Number.isFinite(ts)) continue;
    const idx = points.findIndex((p) => p.close !== null && dateKeyUtc(p.open_time) === dateKeyUtc(ts));
    if (idx <= 0) continue;

    const baseClose = points[idx - 1].close;
    const actualClose = points[idx].close;
    const sigma = Math.max(Number(row.garch_forecast), 0);
    if (
      typeof baseClose !== "number" ||
      typeof actualClose !== "number" ||
      !Number.isFinite(baseClose) ||
      !Number.isFinite(actualClose) ||
      !Number.isFinite(sigma) ||
      baseClose <= 0
    ) {
      continue;
    }

    const lo = baseClose * (1 - sigma);
    const hi = baseClose * (1 + sigma);
    const low = Math.min(lo, hi);
    const high = Math.max(lo, hi);
    total += 1;
    if (actualClose >= low && actualClose <= high) inside += 1;
  }

  if (total === 0) return;
  const rate = (inside / total) * 100;
  forecastSuccessRateEl.textContent = `${rate.toFixed(1)}% (${inside}/${total})`;
  forecastSuccessRateEl.classList.remove("neutral");
  forecastSuccessRateEl.classList.add(rate >= 50 ? "buy" : "sell");
}

function setActiveGraph(next: "1h" | "7d") {
  activeGraph = next;
  const show1h = next === "1h";
  const show7d = next === "7d";
  if (graph1hEl) graph1hEl.classList.toggle("is-hidden", !show1h);
  if (graph7dEl) graph7dEl.classList.toggle("is-hidden", !show7d);

  if (chartTitleEl) {
    chartTitleEl.textContent = show1h ? `${BINANCE_PAIR} (1h)` : `${BINANCE_PAIR} (7d)`;
  }

  if (show1h) {
    requestAnimationFrame(() => {
      if (!oneHourHasLoaded) {
        void loadOneHourPrices();
      } else {
        layoutChart1hCanvas();
        resizeOneHourChart();
        drawOneHourChart(lastOneHourDisplay, lastSavedForecasts1h);
      }
    });
  } else {
    requestAnimationFrame(() => {
      if (!sevenDayHasLoaded) {
        void loadSevenDayPrices();
      } else {
        layoutChart7dCanvas();
        resizeSevenDayChart();
        drawSevenDayChart(lastSevenDayDisplay, lastSavedForecasts7d);
      }
    });
  }
}

async function loadOneHourPrices() {
  if (oneHourLoadInFlight) return oneHourLoadInFlight;
  oneHourLoadInFlight = (async () => {
  if (!rest1hStatusEl) return;
  if (document.visibilityState !== "visible") return;
  rest1hStatusEl.textContent = "Loading...";
  rest1hStatusEl.classList.remove("buy", "sell", "neutral");
  rest1hStatusEl.classList.add("neutral");

  try {
    const res = await fetch(MARKET_HOURLY_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = (await res.json()) as {
      candles?: Array<{ open_time: string; close: number }>;
    };
    const apiPts = (payload.candles ?? [])
      .map((c) => ({ open_time: Date.parse(c.open_time), close: Number(c.close) }))
      .filter((p) => Number.isFinite(p.open_time) && Number.isFinite(p.close))
      .sort((a, b) => a.open_time - b.open_time);
    lastOneHourDisplay = hourlyPointsFromApi(apiPts);
    lastSavedForecasts1h = await loadSavedForecasts1h();
    layoutChart1hCanvas();
    resizeOneHourChart();
    drawOneHourChart(lastOneHourDisplay, lastSavedForecasts1h);
    updateOneHourKpis(lastOneHourDisplay, lastSavedForecasts1h);
    oneHourHasLoaded = true;
    rest1hStatusEl.textContent = "";
  } catch (e) {
    oneHourHasLoaded = false;
    lastOneHourDisplay = [];
    layoutChart1hCanvas();
    drawOneHourChart([], lastSavedForecasts1h);
    updateOneHourKpis([], []);
    rest1hStatusEl.textContent = "Failed — hourly REST unavailable";
    console.error("1h fetch", e);
  }
  })().finally(() => {
    oneHourLoadInFlight = null;
  });
  return oneHourLoadInFlight;
}

async function refreshOneHourForecastsOnly() {
  if (oneHourForecastRefreshInFlight) return oneHourForecastRefreshInFlight;
  oneHourForecastRefreshInFlight = (async () => {
    if (document.visibilityState !== "visible") return;
    if (!oneHourHasLoaded || lastOneHourDisplay.length === 0) return;
    try {
      lastSavedForecasts1h = await loadSavedForecasts1h();
      layoutChart1hCanvas();
      resizeOneHourChart();
      drawOneHourChart(lastOneHourDisplay, lastSavedForecasts1h);
      updateOneHourKpis(lastOneHourDisplay, lastSavedForecasts1h);
      if (rest1hStatusEl) rest1hStatusEl.textContent = "";
    } catch (e) {
      console.error("1h forecast refresh", e);
    }
  })().finally(() => {
    oneHourForecastRefreshInFlight = null;
  });
  return oneHourForecastRefreshInFlight;
}

async function loadSevenDayPrices() {
  if (sevenDayLoadInFlight) return sevenDayLoadInFlight;
  sevenDayLoadInFlight = (async () => {
  if (!rest7dStatusEl) return;
  if (document.visibilityState !== "visible") return;
  rest7dStatusEl.textContent = "Loading...";
  rest7dStatusEl.classList.remove("buy", "sell", "neutral");
  rest7dStatusEl.classList.add("neutral");

  try {
    const res = await fetch(MARKET_DAILY_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = (await res.json()) as {
      candles?: Array<{ open_time: string; close: number }>;
    };
    const apiPts = (payload.candles ?? [])
      .map((c) => ({
        open_time: Date.parse(c.open_time),
        close: Number(c.close),
      }))
      .filter((p) => Number.isFinite(p.open_time) && Number.isFinite(p.close))
      .sort((a, b) => a.open_time - b.open_time);
    const displayPts = dailyPointsFromApi(apiPts);
    lastSavedForecasts7d = await loadSavedForecasts();
    lastSevenDayDisplay = displayPts;
    layoutChart7dCanvas();
    resizeSevenDayChart();
    drawSevenDayChart(lastSevenDayDisplay, lastSavedForecasts7d);
    sevenDayHasLoaded = true;

    updateForecastSuccessRate(lastSevenDayDisplay, lastSavedForecasts7d);

    // 24h σ (latest forecast row) + yesterday in-band/out-of-band check (most recent midnight forecast).
    const { latest, historicalMidnights } = splitForecastRows(lastSavedForecasts7d);
    if (vol24hSigmaEl) {
      if (latest && Number.isFinite(latest.garch_forecast) && latest.garch_forecast >= 0) {
        vol24hSigmaEl.textContent = `${(latest.garch_forecast * 100).toFixed(4)}%`;
      } else {
        vol24hSigmaEl.textContent = "—";
      }
    }
    if (lastUpdated7dEl) {
      const ts = latest ? Date.parse(latest.timestamp) : NaN;
      lastUpdated7dEl.textContent = Number.isFinite(ts) ? formatLocalUpdateTime(ts) : "—";
    }

    if (ydayBandEl) {
      ydayBandEl.classList.remove("buy", "sell", "neutral");
      ydayBandEl.classList.add("neutral");
      ydayBandEl.textContent = "—";

      const lastMidnight = historicalMidnights.length > 0 ? historicalMidnights[historicalMidnights.length - 1] : null;
      if (lastMidnight && lastSevenDayDisplay.length > 1) {
        const ts = Date.parse(lastMidnight.timestamp);
        const k = Number.isFinite(ts) ? dateKeyUtc(ts) : null;
        const idx = k
          ? lastSevenDayDisplay.findIndex((p) => p.close !== null && dateKeyUtc(p.open_time) === k)
          : -1;
        if (idx > 0) {
          const baseClose = lastSevenDayDisplay[idx - 1].close;
          const actualClose = lastSevenDayDisplay[idx].close;
          const sigma = Math.max(Number(lastMidnight.garch_forecast), 0);
          if (typeof baseClose === "number" && typeof actualClose === "number" && Number.isFinite(baseClose) && Number.isFinite(actualClose)) {
            const lo = baseClose * (1 - sigma);
            const hi = baseClose * (1 + sigma);
            const low = Math.min(lo, hi);
            const high = Math.max(lo, hi);
            if (actualClose >= low && actualClose <= high) {
              ydayBandEl.textContent = "Inside band";
              ydayBandEl.classList.remove("neutral");
              ydayBandEl.classList.add("buy");
            } else if (actualClose > high) {
              const outsideFrac = (actualClose - high) / baseClose;
              ydayBandEl.textContent = `${(outsideFrac * 100).toFixed(3)}% above`;
              ydayBandEl.classList.remove("neutral");
              ydayBandEl.classList.add("sell");
            } else if (actualClose < low) {
              const outsideFrac = (low - actualClose) / baseClose;
              ydayBandEl.textContent = `${(outsideFrac * 100).toFixed(3)}% below`;
              ydayBandEl.classList.remove("neutral");
              ydayBandEl.classList.add("sell");
            }
          }
        }
      }
    }

    rest7dStatusEl.textContent = ``;
  } catch (e) {
    sevenDayHasLoaded = false;
    lastSevenDayDisplay = [];
    layoutChart7dCanvas();
    drawSevenDayChart([], lastSavedForecasts7d);
    rest7dStatusEl.textContent = "Failed — market daily REST unavailable";
    if (vol24hSigmaEl) vol24hSigmaEl.textContent = "—";
    if (ydayBandEl) ydayBandEl.textContent = "—";
    if (lastUpdated7dEl) lastUpdated7dEl.textContent = "—";
    if (forecastSuccessRateEl) {
      forecastSuccessRateEl.textContent = "—";
      forecastSuccessRateEl.classList.remove("buy", "sell");
      forecastSuccessRateEl.classList.add("neutral");
    }
    console.error("7d fetch", e);
  }
  })().finally(() => {
    sevenDayLoadInFlight = null;
  });
  return sevenDayLoadInFlight;
}

function msUntilNextSevenDayReloadUtc(): number {
  const d = new Date();
  const elapsedInDayMs =
    (((d.getUTCHours() * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds()) * 1000 +
      d.getUTCMilliseconds());
  const hourMs = 60 * 60 * 1000;
  for (const h of SEVEN_DAY_UTC_RELOAD_HOURS) {
    const slotStartMs = h * hourMs;
    if (slotStartMs > elapsedInDayMs) {
      return slotStartMs - elapsedInDayMs;
    }
  }
  return 24 * hourMs - elapsedInDayMs;
}

function msUntilNextHourBoundaryUtc(): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(now.getUTCHours() + 1, 0, 0, 0);
  return Math.max(1_000, next.getTime() - now.getTime());
}

function msUntilNextFiveMinBoundaryUtc(): number {
  const now = new Date();
  const next = new Date(now);
  const m = now.getUTCMinutes();
  const nextMinuteBucket = Math.floor(m / 5) * 5 + 5;
  next.setUTCMinutes(nextMinuteBucket, 0, 0);
  return Math.max(1_000, next.getTime() - now.getTime());
}

function scheduleSevenDayReloadsTwiceDailyUtc(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    disarm();
    if (document.visibilityState !== "visible") return;
    if (activeGraph !== "7d") return;
    timer = setTimeout(() => {
      timer = null;
      void loadSevenDayPrices();
      arm();
    }, msUntilNextSevenDayReloadUtc());
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") arm();
    else disarm();
  });
  arm();
}

scheduleSevenDayReloadsTwiceDailyUtc();

function scheduleOneHourGraphReloadHourlyUtc(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    disarm();
    if (document.visibilityState !== "visible") return;
    timer = setTimeout(() => {
      timer = null;
      void loadOneHourPrices();
      arm();
    }, msUntilNextHourBoundaryUtc());
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      // Catch up immediately after tab resumes instead of waiting for next hour boundary.
      void loadOneHourPrices();
      arm();
    } else {
      disarm();
    }
  });
  arm();
}

scheduleOneHourGraphReloadHourlyUtc();

function scheduleOneHourForecastRangeRefreshEveryFiveMinUtc(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    disarm();
    if (document.visibilityState !== "visible") return;
    timer = setTimeout(() => {
      timer = null;
      void refreshOneHourForecastsOnly();
      arm();
    }, msUntilNextFiveMinBoundaryUtc());
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      // Refresh forecast band immediately on resume, then continue 5m cadence.
      void refreshOneHourForecastsOnly();
      arm();
    } else {
      disarm();
    }
  });
  arm();
}

scheduleOneHourForecastRangeRefreshEveryFiveMinUtc();

function preloadNonLiveGraphs(): void {
  if (document.visibilityState !== "visible") return;
  if (!oneHourHasLoaded) void loadOneHourPrices();
  if (!sevenDayHasLoaded) void loadSevenDayPrices();
}

let resizeChartTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  if (resizeChartTimer) clearTimeout(resizeChartTimer);
  resizeChartTimer = setTimeout(() => {
    if (activeGraph === "1h") {
      layoutChart1hCanvas();
      drawOneHourChart(lastOneHourDisplay, lastSavedForecasts1h);
    } else {
      layoutChart7dCanvas();
      drawSevenDayChart(lastSevenDayDisplay, lastSavedForecasts7d);
    }
  }, 120);
});

if (graphSelectEl) {
  graphSelectEl.addEventListener("change", () => {
    const v = graphSelectEl.value === "7d" ? "7d" : "1h";
    setActiveGraph(v);
  });
  setActiveGraph(graphSelectEl.value === "7d" ? "7d" : "1h");
} else {
  setActiveGraph("1h");
}

// Preload non-live data at site startup so tab switches are instant.
preloadNonLiveGraphs();