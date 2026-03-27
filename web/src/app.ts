import {
  MAX_POINTS,
  drawLiveForecastChart,
  latest10sGarchSigma,
  latest10sGarchSigmaUpdatedAtMs,
  layoutPriceChartCanvas,
  liveRangeColW,
  loadForecasts10sSigma,
  refreshLiveForecastRangeLabel,
  shiftLiveChartAfterRingBufferPop,
  tryActivatePendingTunnel,
  type SavedForecast,
} from "./graphs/liveForecast10sChart";
import {
  dailyPointsFromApi,
  dateKeyUtc,
  drawSevenDayChart,
  layoutChart7dCanvas,
  splitForecastRows,
  type DailyPoint,
} from "./graphs/sevenDayChart";

const POLL_MS = 10_000;
/** σ is polled periodically from backend and applied to the next realized step. */
const prices: number[] = [];
/**
 * `forwardForecastSigma[i]` = lagged GARCH σ for the move from anchor `prices[i]` to actual `prices[i+1]`
 * (same idea as 7d: band from previous close, drawn at the slot where the outcome lands).
 */
const forwardForecastSigma: (number | null)[] = [];
/** Frozen band bounds for each realized step i (anchor=prices[i], outcome=prices[i+1]). */
const forwardForecastLow: (number | null)[] = [];
const forwardForecastHigh: (number | null)[] = [];
/** Frozen pixel width per band so older bands don't change thickness when `n` changes. */
const forwardForecastColW: (number | null)[] = [];
/** Extra column after last spot: σ from latest JSON, anchor = last close (shown until next poll). */
let pendingForwardBand:
  | { anchorPrice: number; sigma: number; low: number; high: number; colW: number }
  | null = null;
/**
 * σ observed on the previous poll. When a new price arrives, we freeze the previous step's
 * band to the σ that was available on that prior poll (so older bands never change).
 */
let sigmaFromPreviousPoll: number | null = null;
const BINANCE_SYMBOL = "BTCUSDT";
const BINANCE_PAIR = "BTC/USDT";
const BINANCE_7D_URL = `https://api.binance.com/api/v3/klines?symbol=${BINANCE_SYMBOL}&interval=1d&limit=7`;
const CUSUM_JSON_URL = "/cusum.json";
const API_BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE ??
  "http://127.0.0.1:8000";
const WS_BASE = API_BASE.startsWith("https://")
  ? API_BASE.replace(/^https:/, "wss:")
  : API_BASE.replace(/^http:/, "ws:");

const FORECASTS_JSON_URL = `${API_BASE}/forecasts?symbol=${encodeURIComponent(BINANCE_PAIR)}&timeframe=1h`;
const ERRORS_24H_JSON_URL = `${API_BASE}/errors?symbol=${encodeURIComponent(BINANCE_PAIR)}&series=24h&limit=30`;
const CUSUM_POLL_MS = 60_000;
/** 7d Binance klines + saved forecasts: schedule reloads at these UTC hours only. */
const SEVEN_DAY_UTC_RELOAD_HOURS = [0, 12] as const;

const wsStatusEl = document.getElementById("ws-status");
const liveChartPriceEl = document.getElementById("live-chart-price");
const lastRefreshEl = document.getElementById("last-refresh");
const marketEl = document.getElementById("market-value");
const rest7dStatusEl = document.getElementById("rest-7d-status");
const vol24hSigmaEl = document.getElementById("vol-24h-sigma");
const ydayBandEl = document.getElementById("yday-band");
const signalListEl = document.getElementById("signal-list") as HTMLUListElement | null;
const cusumStatusEl = document.getElementById("cusum-status");
const errors24hListEl = document.getElementById("errors-24h-list") as HTMLUListElement | null;

/** Rows exported from Python (e.g. web/public/cusum.json). */
type CusumSignalRow = {
  timestamp: string;
  /** -1 sell, 0 neutral/hold, 1 buy — matches `cusum_signal` from pipeline. */
  cusum_signal: number;
  /** Optional short note (e.g. spread pair label). */
  detail?: string;
};

let lastSevenDayDisplay: DailyPoint[] = [];
let lastSavedForecasts: SavedForecast[] = [];

async function loadSavedForecasts(): Promise<SavedForecast[]> {
  // Prefer backend API; fall back to static export if running frontend standalone.
  const tryUrls = [FORECASTS_JSON_URL, "/forecasts.json"];
  for (const url of tryUrls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const payload = (await res.json()) as { forecasts?: SavedForecast[] };
      return Array.isArray(payload.forecasts) ? payload.forecasts : [];
    } catch {
      // try next
    }
  }
  return [];
}

function getLiveForecastSeries() {
  return {
    prices,
    forwardForecastSigma,
    forwardForecastLow,
    forwardForecastHigh,
    pendingForwardBand,
  };
}

function handleNewSpotPrice(close: number) {
  if (!Number.isFinite(close)) return;
  const sigmaForPreviousStep = sigmaFromPreviousPoll;

  prices.push(close);
  forwardForecastSigma.push(null);
  forwardForecastLow.push(null);
  forwardForecastHigh.push(null);
  forwardForecastColW.push(null);
  const nPts = prices.length;
  if (nPts >= 2) {
    forwardForecastSigma[nPts - 2] = sigmaForPreviousStep;
    const anchor = prices[nPts - 2];
    if (sigmaForPreviousStep !== null && sigmaForPreviousStep > 0 && Number.isFinite(anchor)) {
      forwardForecastLow[nPts - 2] = anchor * (1 - sigmaForPreviousStep);
      forwardForecastHigh[nPts - 2] = anchor * (1 + sigmaForPreviousStep);
    }
    layoutPriceChartCanvas();
    const livePriceCanvas = document.getElementById("price-chart") as HTMLCanvasElement | null;
    if (livePriceCanvas) forwardForecastColW[nPts - 2] = liveRangeColW(livePriceCanvas.width, nPts);
  }
  if (prices.length > MAX_POINTS) {
    prices.shift();
    forwardForecastSigma.shift();
    forwardForecastLow.shift();
    forwardForecastHigh.shift();
    forwardForecastColW.shift();
    shiftLiveChartAfterRingBufferPop();
  }
  sigmaFromPreviousPoll =
    latest10sGarchSigma !== null && latest10sGarchSigma > 0 ? latest10sGarchSigma : null;

  const lastClose = prices[prices.length - 1];
  if (latest10sGarchSigma !== null && latest10sGarchSigma > 0 && Number.isFinite(lastClose)) {
    layoutPriceChartCanvas();
    const livePriceCanvas = document.getElementById("price-chart") as HTMLCanvasElement | null;
    const colW = livePriceCanvas ? liveRangeColW(livePriceCanvas.width, prices.length) : 3;
    pendingForwardBand = {
      anchorPrice: lastClose,
      sigma: latest10sGarchSigma,
      low: lastClose * (1 - latest10sGarchSigma),
      high: lastClose * (1 + latest10sGarchSigma),
      colW,
    };
  } else {
    pendingForwardBand = null;
  }

  tryActivatePendingTunnel(prices);
  drawLiveForecastChart(getLiveForecastSeries);

  const timestamp = new Date().toLocaleTimeString();
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (liveChartPriceEl) {
    liveChartPriceEl.textContent = `price: ${fmt(close)}`;
  }
  refreshLiveForecastRangeLabel(prices);

  if (lastRefreshEl) lastRefreshEl.textContent = timestamp;
  if (marketEl) {
    const s = latest10sGarchSigma;
    marketEl.textContent =
      typeof s === "number" && Number.isFinite(s) && s > 0 ? `${(s * 100).toFixed(4)}%` : "—";
  }
}

function startLivePriceWs() {
  const url = `${WS_BASE}/ws/price?symbol=btcusdt&min_interval_ms=1000`;
  setWsStatus("Connecting...", "neutral");
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let visibilityHideTimer: ReturnType<typeof setTimeout> | null = null;
  /** Exponential backoff (ms) after drops / Wi‑Fi flaps — caps load on the API. */
  let reconnectDelayMs = 1200;
  const RECONNECT_DELAY_MAX_MS = 30_000;
  const HIDDEN_DISCONNECT_MS = 15_000;
  let lastUiUpdate = 0;
  const MIN_UI_MS = 900;
  const MAX_SIGMA_STALENESS_MS = POLL_MS * 3;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (document.visibilityState !== "visible") return;
    clearReconnectTimer();
    const jitter = 200 + Math.floor(Math.random() * 400);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs + jitter);
    reconnectDelayMs = Math.min(
      Math.floor(reconnectDelayMs * 1.85),
      RECONNECT_DELAY_MAX_MS,
    );
  };

  const disconnect = () => {
    clearReconnectTimer();
    if (ws !== null) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };

  const connect = () => {
    if (document.visibilityState !== "visible") return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      reconnectDelayMs = 1200;
      setWsStatus("Live (WS)", "buy");
    };
    ws.onclose = () => {
      ws = null;
      if (document.visibilityState === "visible") {
        setWsStatus("WS reconnecting…", "neutral");
        scheduleReconnect();
      } else {
        setWsStatus("WS paused (tab in background)", "neutral");
      }
    };
    ws.onerror = () => setWsStatus("WS error", "sell");
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string; price?: number };
        if (msg.type !== "trade") return;
        const p = Number(msg.price);
        const now = Date.now();
        if (now - lastUiUpdate < MIN_UI_MS) return;
        lastUiUpdate = now;
        // Ensure σ doesn't go stale while WS prices keep flowing (e.g., if the polling interval was paused).
        if (now - latest10sGarchSigmaUpdatedAtMs > MAX_SIGMA_STALENESS_MS) {
          void loadForecasts10sSigma(prices);
        }
        handleNewSpotPrice(p);
      } catch {
        // ignore
      }
    };
  };

  const onVisibility = () => {
    if (visibilityHideTimer !== null) {
      clearTimeout(visibilityHideTimer);
      visibilityHideTimer = null;
    }
    if (document.visibilityState === "visible") {
      reconnectDelayMs = 1200;
      if (ws === null || ws.readyState === WebSocket.CLOSED) {
        setWsStatus("Connecting...", "neutral");
        clearReconnectTimer();
        connect();
      }
    } else {
      visibilityHideTimer = setTimeout(() => {
        visibilityHideTimer = null;
        disconnect();
        setWsStatus("WS paused (tab in background)", "neutral");
      }, HIDDEN_DISCONNECT_MS);
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  onVisibility();
}

function cusumClass(signal: number): "buy" | "sell" | "neutral" {
  if (signal > 0) return "buy";
  if (signal < 0) return "sell";
  return "neutral";
}

function cusumLabel(signal: number): string {
  if (signal > 0) return "Buy";
  if (signal < 0) return "Sell";
  return "Neutral";
}

function renderCusumSignals(rows: CusumSignalRow[]) {
  if (!signalListEl) return;

  signalListEl.innerHTML = "";

  if (rows.length === 0) {
    const li = document.createElement("li");
    li.className = "signal-item";
    li.innerHTML = '<span class="timestamp">—</span><span class="neutral">Cusum signals — future feature<span>';
    signalListEl.appendChild(li);
    if (cusumStatusEl) cusumStatusEl.textContent = "Cusum · coming later";
    return;
  }

  const sorted = [...rows].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const cap = 12;
  for (const row of sorted.slice(0, cap)) {
    const li = document.createElement("li");
    li.className = "signal-item";
    const cls = cusumClass(row.cusum_signal);
    const when = row.timestamp;
    const suffix = row.detail ? ` · ${row.detail}` : "";
    li.innerHTML = `<span class="timestamp">${when}</span><span class="${cls}">${cusumLabel(row.cusum_signal)}${suffix}</span>`;
    signalListEl.appendChild(li);
  }
  if (cusumStatusEl) cusumStatusEl.textContent = `Cusum · ${rows.length} loaded`;
}

async function loadCusumSignals() {
  try {
    const res = await fetch(CUSUM_JSON_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = (await res.json()) as { signals?: CusumSignalRow[] };
    const signals = Array.isArray(payload.signals) ? payload.signals : [];
    renderCusumSignals(signals);
  } catch {
    renderCusumSignals([]);
  }
}

type ErrorRow = { event_time: string; outside_frac: number | null; side: string | null };

function renderErrorRows(listEl: HTMLUListElement | null, rows: ErrorRow[]) {
  if (!listEl) return;
  listEl.innerHTML = "";
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="timestamp">—</span><span class="neutral">No errors yet</span>`;
    listEl.appendChild(li);
    return;
  }
  for (const r of rows.slice(0, 30)) {
    const t = new Date(r.event_time);
    const when = Number.isFinite(t.getTime()) ? t.toLocaleTimeString() : r.event_time;
    const outside = r.outside_frac;
    const isOk = r.side === "inside" || outside === 0 || outside === null;
    const msg =
      isOk || outside === null
        ? "within band"
        : `${(outside * 100).toFixed(3)}% ${r.side}`;
    const li = document.createElement("li");
    const cls = isOk ? "buy" : "sell";
    li.innerHTML = `<span class="timestamp">${when}</span><span class="${cls}">${msg}</span>`;
    listEl.appendChild(li);
  }
}

async function loadErrorLog(url: string): Promise<ErrorRow[]> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  const payload = (await res.json()) as { errors?: ErrorRow[] };
  return Array.isArray(payload.errors) ? payload.errors : [];
}

function setWsStatus(text: string, klass: "buy" | "sell" | "neutral" = "neutral") {
  if (!wsStatusEl) return;
  wsStatusEl.textContent = text;
  wsStatusEl.classList.remove("buy", "sell", "neutral");
  wsStatusEl.classList.add(klass);
}

async function loadSevenDayPrices() {
  if (!rest7dStatusEl) return;
  rest7dStatusEl.textContent = "Loading...";
  rest7dStatusEl.classList.remove("buy", "sell", "neutral");
  rest7dStatusEl.classList.add("neutral");

  try {
    const res = await fetch(BINANCE_7D_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as Array<[number, string, string, string, string, string]>;
    const apiPts = raw.map((row) => ({
      open_time: Number(row[0]),
      close: Number(row[4]),
    }));
    const displayPts = dailyPointsFromApi(apiPts);
    lastSavedForecasts = await loadSavedForecasts();
    lastSevenDayDisplay = displayPts;
    layoutChart7dCanvas();
    drawSevenDayChart(lastSevenDayDisplay, lastSavedForecasts);

    try {
      const rows = await loadErrorLog(ERRORS_24H_JSON_URL);
      renderErrorRows(errors24hListEl, rows);
    } catch {
      renderErrorRows(errors24hListEl, []);
    }

    // 24h σ (latest forecast row) + yesterday in-band/out-of-band check (most recent midnight forecast).
    if (vol24hSigmaEl) {
      const { latest } = splitForecastRows(lastSavedForecasts);
      const s = latest?.garch_forecast;
      vol24hSigmaEl.textContent =
        typeof s === "number" && Number.isFinite(s) && s > 0 ? `${(s * 100).toFixed(4)}%` : "—";
    }
    if (ydayBandEl) {
      ydayBandEl.classList.remove("buy", "sell", "neutral");
      const pts = lastSevenDayDisplay;
      const lastRealIdx = (() => {
        for (let i = pts.length - 1; i >= 0; i -= 1) if (pts[i].close !== null) return i;
        return -1;
      })();
      // Yesterday is the day before the latest real close point.
      const yIdx = lastRealIdx - 1;
      if (yIdx >= 1 && pts[yIdx].close !== null) {
        const yClose = pts[yIdx].close;
        const base = pts[yIdx - 1].close;
        const k = dateKeyUtc(pts[yIdx].open_time);
        const { historicalMidnights } = splitForecastRows(lastSavedForecasts);
        const fp = historicalMidnights.find((r) => dateKeyUtc(Date.parse(r.timestamp)) === k);
        const sigma = fp ? Math.max(fp.garch_forecast, 0) : null;
        if (base !== null && Number.isFinite(base) && sigma !== null && sigma > 0) {
          const low = base * (1 - sigma);
          const high = base * (1 + sigma);
          if (yClose >= Math.min(low, high) && yClose <= Math.max(low, high)) {
            ydayBandEl.textContent = "within band";
            ydayBandEl.classList.add("buy");
          } else {
            const hi = Math.max(low, high);
            const lo = Math.min(low, high);
            const outside = yClose > hi ? (yClose - hi) / base : (lo - yClose) / base;
            const side = yClose > hi ? "above" : "below";
            ydayBandEl.textContent = `${(outside * 100).toFixed(3)}% ${side}`;
            ydayBandEl.classList.add("sell");
          }
        } else {
          ydayBandEl.textContent = "—";
          ydayBandEl.classList.add("neutral");
        }
      } else {
        ydayBandEl.textContent = "—";
        ydayBandEl.classList.add("neutral");
      }
    }

    rest7dStatusEl.textContent = ``;
    rest7dStatusEl.classList.remove("neutral");
    rest7dStatusEl.classList.add("buy");
  } catch (e) {
    lastSevenDayDisplay = [];
    layoutChart7dCanvas();
    drawSevenDayChart([], lastSavedForecasts);
    rest7dStatusEl.textContent = "Failed — Binance REST unavailable";
    rest7dStatusEl.classList.remove("neutral");
    rest7dStatusEl.classList.add("sell");
    if (vol24hSigmaEl) vol24hSigmaEl.textContent = "—";
    if (ydayBandEl) ydayBandEl.textContent = "—";
    console.error("7d fetch", e);
  }
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

function scheduleSevenDayReloadsTwiceDailyUtc(): void {
  const arm = () => {
    setTimeout(() => {
      void loadSevenDayPrices();
      arm();
    }, msUntilNextSevenDayReloadUtc());
  };
  arm();
}

async function loadCurrentPrice() {
  try {
    await loadForecasts10sSigma(prices);
  } catch (e) {
    pendingForwardBand = null;
    if (liveChartPriceEl) liveChartPriceEl.textContent = "—";
    setWsStatus("Forecast fetch error", "sell");
    console.error("price fetch", e);
  }
}

drawLiveForecastChart(getLiveForecastSeries);
void loadSevenDayPrices();
scheduleSevenDayReloadsTwiceDailyUtc();
void loadCurrentPrice();
void loadCusumSignals();
setInterval(() => {
  void loadCurrentPrice();
}, POLL_MS);
setInterval(() => {
  void loadCusumSignals();
}, CUSUM_POLL_MS);

let resizeChartTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  if (resizeChartTimer) clearTimeout(resizeChartTimer);
  resizeChartTimer = setTimeout(() => {
    layoutPriceChartCanvas();
    drawLiveForecastChart(getLiveForecastSeries);
    layoutChart7dCanvas();
    drawSevenDayChart(lastSevenDayDisplay, lastSavedForecasts);
  }, 120);
});

startLivePriceWs();