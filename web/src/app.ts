import {
  MAX_POINTS,
  drawLiveForecastChart,
  latest10sGarchSigma,
  latest10sGarchSigmaUpdatedAtMs,
  loadForecasts10sSigma,
  layoutPriceChartCanvas,
  liveRangeColW,
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
  resizeSevenDayChart,
  splitForecastRows,
  type DailyPoint,
} from "./graphs/sevenDayChart";

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
/**
 * Anchor for the "pending" (next-step) forecast band.
 * We freeze this anchor at the moment we receive a new σ (poll),
 * so the band does NOT recenter on every WS price tick.
 *
 * NOTE: We only re-center this anchor once per poll bucket,
 * so the visible band doesn't re-anchor on every WS tick.
 */
let pendingBandAnchorPrice: number | null = null;
let lastBandRecenterBucket: number | null = null;
const BINANCE_SYMBOL = "BTCUSDT";
const BINANCE_PAIR = "BTC/USDT";
const CUSUM_JSON_URL = "/cusum.json";
const API_BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE ??
  "http://127.0.0.1:8000";
const WS_BASE = API_BASE.startsWith("https://")
  ? API_BASE.replace(/^https:/, "wss:")
  : API_BASE.replace(/^http:/, "ws:");

const MARKET_DAILY_URL = `${API_BASE}/market/daily?symbol=${encodeURIComponent(BINANCE_SYMBOL)}&days=7`;
const CUSUM_POLL_MS = 60_000;
/** Live σ reload cadence (60s band). */
const POLL_MS = 50_000;
/** 7d Binance klines + saved forecasts: schedule reloads at these UTC hours only. */
const SEVEN_DAY_UTC_RELOAD_HOURS = [0, 12] as const;

const wsStatusEl = document.getElementById("ws-status");
const liveChartPriceEl = document.getElementById("live-chart-price");
const sevenDayPriceEl = document.getElementById("seven-day-price");
const lastRefreshEl = document.getElementById("last-refresh");
const marketEl = document.getElementById("market-value");
const rest7dStatusEl = document.getElementById("rest-7d-status");
const vol24hSigmaEl = document.getElementById("vol-24h-sigma");
const ydayBandEl = document.getElementById("yday-band");
const signalListEl = document.getElementById("signal-list") as HTMLUListElement | null;
const cusumStatusEl = document.getElementById("cusum-status");
const errors24hListEl = document.getElementById("errors-24h-list") as HTMLUListElement | null;
const graphSelectEl = document.getElementById("graph-select") as HTMLSelectElement | null;
const graphLiveEl = document.getElementById("graph-live");
const graph7dEl = document.getElementById("graph-7d");
const metricsLiveEl = document.getElementById("metrics-live");
const chartTitleEl = document.getElementById("chart-title");

// Smoothly animate the displayed "price:" label between WS ticks.
let priceLabelRaf = 0;
let priceAnimFrom: number | null = null;
let priceAnimTo: number | null = null;
let priceAnimStartMs = 0;
const PRICE_ANIM_MS = 6000;

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
let activeGraph: "live" | "7d" = "live";
let sevenDayHasLoaded = false;
let wsIsOpen = false;

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

function getLiveForecastSeries() {
  return {
    prices,
    forwardForecastSigma,
    forwardForecastLow,
    forwardForecastHigh,
    pendingForwardBand,
  };
}

function startPriceLabelAnimation(to: number) {
  if (!Number.isFinite(to)) return;
  const now = performance.now();
  if (priceAnimTo === null) {
    priceAnimFrom = to;
    priceAnimTo = to;
    priceAnimStartMs = now;
  } else {
    // Start a new animation from current displayed value.
    const t = PRICE_ANIM_MS > 0 ? Math.min(1, Math.max(0, (now - priceAnimStartMs) / PRICE_ANIM_MS)) : 1;
    const a = priceAnimFrom ?? priceAnimTo;
    const b = priceAnimTo;
    const current = a + (b - a) * t;
    priceAnimFrom = current;
    priceAnimTo = to;
    priceAnimStartMs = now;
  }
  if (!priceLabelRaf) priceLabelRaf = requestAnimationFrame(tickPriceLabel);
}

function tickPriceLabel() {
  priceLabelRaf = 0;
  if (document.visibilityState !== "visible") return;
  if (!liveChartPriceEl) return;
  if (priceAnimTo === null || priceAnimFrom === null) return;

  const now = performance.now();
  const t = PRICE_ANIM_MS > 0 ? Math.min(1, Math.max(0, (now - priceAnimStartMs) / PRICE_ANIM_MS)) : 1;
  const y = priceAnimFrom + (priceAnimTo - priceAnimFrom) * t;
  liveChartPriceEl.textContent = `price: ${y.toFixed(2)}`;

  if (t < 1) priceLabelRaf = requestAnimationFrame(tickPriceLabel);
}

function handleNewSpotPrice(close: number) {
  if (!Number.isFinite(close)) return;
  const sigmaForPreviousStep = sigmaFromPreviousPoll;

  /** Same Binance snapshot re-emitted on the 1s tick — refresh labels without growing the series. */
  const prevClose = prices.length > 0 ? prices[prices.length - 1] : null;
  const sameAsLast = prevClose !== null && close === prevClose;

  if (!sameAsLast) {
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
  }
  sigmaFromPreviousPoll =
    latest10sGarchSigma !== null && latest10sGarchSigma > 0 ? latest10sGarchSigma : null;

  const lastClose = prices[prices.length - 1];
  const anchor = pendingBandAnchorPrice;
  if (
    latest10sGarchSigma !== null &&
    latest10sGarchSigma > 0 &&
    Number.isFinite(lastClose) &&
    anchor !== null &&
    Number.isFinite(anchor)
  ) {
    layoutPriceChartCanvas();
    const livePriceCanvas = document.getElementById("price-chart") as HTMLCanvasElement | null;
    const colW = livePriceCanvas ? liveRangeColW(livePriceCanvas.width, prices.length) : 3;
    pendingForwardBand = {
      anchorPrice: anchor,
      sigma: latest10sGarchSigma,
      low: anchor * (1 - latest10sGarchSigma),
      high: anchor * (1 + latest10sGarchSigma),
      colW,
    };
  } else {
    pendingForwardBand = null;
  }

  // Only update the visible LIVE UI while the live graph is selected.
  // We still keep the internal ring buffer warm so switching back to live is instant.
  if (activeGraph === "live") {
    tryActivatePendingTunnel(prices);
    drawLiveForecastChart(getLiveForecastSeries);

    const timestamp = new Date().toLocaleTimeString();
    startPriceLabelAnimation(close);
    refreshLiveForecastRangeLabel(prices);

    if (lastRefreshEl) lastRefreshEl.textContent = timestamp;
    if (marketEl) {
      const s = latest10sGarchSigma;
      marketEl.textContent =
        typeof s === "number" && Number.isFinite(s) && s > 0 ? `${(s * 100).toFixed(4)}%` : "—";
    }
  }
}

function startLivePriceWs() {
  const url = `${WS_BASE}/ws/price?symbol=btcusdt&interval_ms=5000`;
  setWsStatus("Connecting...", "neutral");
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let visibilityHideTimer: ReturnType<typeof setTimeout> | null = null;
  /** Exponential backoff (ms) after drops / Wi‑Fi flaps — caps load on the API. */
  let reconnectDelayMs = 1200;
  const RECONNECT_DELAY_MAX_MS = 30_000;
  const HIDDEN_DISCONNECT_MS = 15_000;
  let lastUiUpdate = 0;
  /** Server emits ~1/s; keep below tick interval so seconds are not dropped. */
  const MIN_UI_MS = 400;
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
      wsIsOpen = true;
      if (activeGraph === "live") setWsStatus("Live (WS)", "buy");
    };
    ws.onclose = () => {
      ws = null;
      wsIsOpen = false;
      if (document.visibilityState === "visible") {
        if (activeGraph === "live") setWsStatus("WS reconnecting…", "neutral");
        scheduleReconnect();
      } else {
        if (activeGraph === "live") setWsStatus("WS paused (tab in background)", "neutral");
      }
    };
    ws.onerror = () => {
      wsIsOpen = false;
      if (activeGraph === "live") setWsStatus("WS error", "sell");
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string; price?: number };
        if (msg.type !== "trade") return;
        const p = Number(msg.price);
        const now = Date.now();
        if (now - lastUiUpdate < MIN_UI_MS) return;
        lastUiUpdate = now;
        // Ensure σ doesn't go stale while WS prices keep flowing (e.g., if the polling interval was paused).
        if (
          latest10sGarchSigmaUpdatedAtMs > 0 &&
          MAX_SIGMA_STALENESS_MS > 0 &&
          now - latest10sGarchSigmaUpdatedAtMs > MAX_SIGMA_STALENESS_MS
        ) {
          void loadCurrentPrice();
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
  // Signals panel is optional; if removed from HTML, don't fetch.
  if (!signalListEl || !cusumStatusEl) return;
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

function latestSevenDayClose(): number | null {
  for (let i = lastSevenDayDisplay.length - 1; i >= 0; i -= 1) {
    const c = lastSevenDayDisplay[i]?.close;
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return null;
}

function setActiveGraph(next: "live" | "7d") {
  activeGraph = next;

  const showLive = next === "live";
  if (graphLiveEl) graphLiveEl.classList.toggle("is-hidden", !showLive);
  if (graph7dEl) graph7dEl.classList.toggle("is-hidden", showLive);
  if (metricsLiveEl) metricsLiveEl.classList.toggle("is-hidden", !showLive);
  if (liveChartPriceEl) liveChartPriceEl.classList.toggle("is-hidden", !showLive);
  if (sevenDayPriceEl) sevenDayPriceEl.classList.toggle("is-hidden", showLive);

  if (chartTitleEl) chartTitleEl.textContent = showLive ? `${BINANCE_PAIR} $` : `${BINANCE_PAIR} (7d)`;

  if (showLive) {
    // Keep WS status visible + relevant.
    if (wsIsOpen) setWsStatus("Live (WS)", "buy");
    else setWsStatus("Connecting...", "neutral");
    // Pull σ immediately on entering the live view (don't wait for the next poll tick).
    void loadCurrentPrice();
    layoutPriceChartCanvas();
    drawLiveForecastChart(getLiveForecastSeries);
  } else {
    // 7d: remove the live marker + show latest daily close.
    setWsStatus("", "neutral");
    const p = latestSevenDayClose();
    if (sevenDayPriceEl) sevenDayPriceEl.textContent = p !== null ? `price: ${p.toFixed(2)}` : "—";
    // Stop any in-flight live animation so it doesn't keep running.
    if (priceLabelRaf) cancelAnimationFrame(priceLabelRaf);
    priceLabelRaf = 0;
    priceAnimFrom = null;
    priceAnimTo = null;

    // 7d: only load on demand. Also, force a resize once visible so ApexCharts doesn't render at 0x0.
    requestAnimationFrame(() => {
      if (!sevenDayHasLoaded) {
        sevenDayHasLoaded = true;
        void loadSevenDayPrices();
      } else {
        layoutChart7dCanvas();
        resizeSevenDayChart();
        drawSevenDayChart(lastSevenDayDisplay, lastSavedForecasts);
      }
    });
  }
}

async function loadSevenDayPrices() {
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
    lastSavedForecasts = await loadSavedForecasts();
    lastSevenDayDisplay = displayPts;
    layoutChart7dCanvas();
    resizeSevenDayChart();
    drawSevenDayChart(lastSevenDayDisplay, lastSavedForecasts);

    // When viewing 7d, keep the header price synced to the latest daily close.
    if (activeGraph === "7d" && sevenDayPriceEl) {
      const p = latestSevenDayClose();
      sevenDayPriceEl.textContent = p !== null ? `price: ${p.toFixed(2)}` : "—";
    }

    renderErrorRows(errors24hListEl, []);

    // 24h σ (latest forecast row) + yesterday in-band/out-of-band check (most recent midnight forecast).
    const { latest, historicalMidnights } = splitForecastRows(lastSavedForecasts);
    if (vol24hSigmaEl) {
      if (latest && Number.isFinite(latest.garch_forecast) && latest.garch_forecast >= 0) {
        vol24hSigmaEl.textContent = `${(latest.garch_forecast * 100).toFixed(4)}%`;
      } else {
        vol24hSigmaEl.textContent = "—";
      }
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
    rest7dStatusEl.classList.remove("neutral");
    rest7dStatusEl.classList.add("buy");
  } catch (e) {
    lastSevenDayDisplay = [];
    layoutChart7dCanvas();
    drawSevenDayChart([], lastSavedForecasts);
    rest7dStatusEl.textContent = "Failed — market daily REST unavailable";
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

async function loadCurrentPrice() {
  if (document.visibilityState !== "visible") return;

  // Pull latest σ (60s band) from API/static JSON.
  await loadForecasts10sSigma(prices);

  // Anchor the "pending" band only once per poll bucket so it doesn't recenter on every WS tick.
  if (prices.length > 0) {
    const now = Date.now();
    const bucket = Math.floor(now / POLL_MS);
    if (lastBandRecenterBucket !== bucket) {
      pendingBandAnchorPrice = prices[prices.length - 1];
      lastBandRecenterBucket = bucket;
    }
  }

  // Recompute the pending band immediately (even if no new WS tick arrived yet).
  if (prices.length > 0) handleNewSpotPrice(prices[prices.length - 1]);
}

drawLiveForecastChart(getLiveForecastSeries);
scheduleSevenDayReloadsTwiceDailyUtc();
void loadCusumSignals();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let cusumTimer: ReturnType<typeof setInterval> | null = null;
function startActiveTimers() {
  if (pollTimer === null) {
    void loadCurrentPrice();
    pollTimer = setInterval(() => void loadCurrentPrice(), POLL_MS);
  }
  if (cusumTimer === null) cusumTimer = setInterval(() => void loadCusumSignals(), CUSUM_POLL_MS);
}
function stopActiveTimers() {
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
  if (cusumTimer !== null) clearInterval(cusumTimer);
  cusumTimer = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") startActiveTimers();
  else stopActiveTimers();
});
if (document.visibilityState === "visible") startActiveTimers();

let resizeChartTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  if (resizeChartTimer) clearTimeout(resizeChartTimer);
  resizeChartTimer = setTimeout(() => {
    if (activeGraph === "live") {
      layoutPriceChartCanvas();
      drawLiveForecastChart(getLiveForecastSeries);
    } else {
      layoutChart7dCanvas();
      drawSevenDayChart(lastSevenDayDisplay, lastSavedForecasts);
    }
  }, 120);
});

startLivePriceWs();

if (graphSelectEl) {
  graphSelectEl.addEventListener("change", () => {
    const v = graphSelectEl.value === "7d" ? "7d" : "live";
    setActiveGraph(v);
  });
  // Ensure DOM reflects default selection on initial load.
  setActiveGraph(graphSelectEl.value === "7d" ? "7d" : "live");
} else {
  setActiveGraph("live");
}