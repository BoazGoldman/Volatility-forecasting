const MAX_POINTS = 6;
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
/** Fractional step past last real index for the “next” forecast column (matches 7d gutter). */
const LIVE_FUTURE_GUTTER = 0.28;
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
const FORECASTS_10S_JSON_URL = `${API_BASE}/forecasts?symbol=${encodeURIComponent(BINANCE_PAIR)}&timeframe=10s&newest_first=true&limit=6`;
const ERRORS_10S_JSON_URL = `${API_BASE}/errors?symbol=${encodeURIComponent(BINANCE_PAIR)}&series=10s&limit=30`;
const ERRORS_24H_JSON_URL = `${API_BASE}/errors?symbol=${encodeURIComponent(BINANCE_PAIR)}&series=24h&limit=30`;
const CUSUM_POLL_MS = 60_000;
const SEVEN_DAY_POLL_MS = 5 * 60_000;
/** Pixel height for both live and 7d chart canvases (must match layout). */
const MAIN_CHART_HEIGHT = 320;

/** GARCH ±σ columns, vertical range ticks, and forecast spokes (matches legend). */
const CHART_RANGE = "#FFFFFF";
const CHART_RANGE_STRIPE = "rgba(255, 255, 255, 0.38)";
/** Price path (live + 7d line). */
const CHART_PRICE_LINE = "#5E97F6";
/** Square/circle markers on price and range bounds. */
const CHART_DOT = "#76C893";
const CHART_DOT_7D = CHART_PRICE_LINE;
/** Live chart: dot when realized price is outside the lagged forecast band. */
const CHART_DOT_OUTSIDE = "#FF5252";
/** Live chart dot styling (keep geometry identical; only add glow/outline). */
const LIVE_DOT_SHADOW_COLOR_INSIDE = "rgba(118, 200, 147, 0.95)";
const LIVE_DOT_SHADOW_COLOR_OUTSIDE = "rgba(255, 82, 82, 0.95)";
const LIVE_DOT_SHADOW_BLUR = 14;
const LIVE_DOT_OUTLINE_COLOR = "rgba(13, 20, 41, 0.96)";
const LIVE_DOT_OUTLINE_WIDTH = 2;

const wsStatusEl = document.getElementById("ws-status");
const liveChartPriceEl = document.getElementById("live-chart-price");
const lastPriceEl = document.getElementById("last-price");
const lastRefreshEl = document.getElementById("last-refresh");
const marketEl = document.getElementById("market-value");
const canvas = document.getElementById("price-chart") as HTMLCanvasElement | null;
const ctx = canvas?.getContext("2d") ?? null;
const canvas7d = document.getElementById("chart-7d") as HTMLCanvasElement | null;
const ctx7d = canvas7d?.getContext("2d") ?? null;
const rest7dStatusEl = document.getElementById("rest-7d-status");
const chart7dLowEl = document.getElementById("chart-7d-low");
const chart7dHighEl = document.getElementById("chart-7d-high");
const vol24hSigmaEl = document.getElementById("vol-24h-sigma");
const ydayBandEl = document.getElementById("yday-band");
const signalListEl = document.getElementById("signal-list") as HTMLUListElement | null;
const cusumStatusEl = document.getElementById("cusum-status");
const errors10sListEl = document.getElementById("errors-10s-list") as HTMLUListElement | null;
const errors24hListEl = document.getElementById("errors-24h-list") as HTMLUListElement | null;

// Client-side 10s error history (kept in-memory) so logs match each UI refresh.
const clientErrors10s: ErrorRow[] = [];

type DailyPoint = { open_time: number; close: number | null; label?: string };
type SavedForecast = { timestamp: string; garch_forecast: number };

const MS_PER_DAY = 86_400_000;

/** Rows exported from Python (e.g. web/public/cusum.json). */
type CusumSignalRow = {
  timestamp: string;
  /** -1 sell, 0 neutral/hold, 1 buy — matches `cusum_signal` from pipeline. */
  cusum_signal: number;
  /** Optional short note (e.g. spread pair label). */
  detail?: string;
};

function dailyPointsFromApi(apiPoints: { open_time: number; close: number }[]): DailyPoint[] {
  if (apiPoints.length === 0) return [];
  const normalized: DailyPoint[] = apiPoints.map((p) => ({
    open_time: p.open_time,
    close: p.close,
  }));
  const last = apiPoints[apiPoints.length - 1];
  const tTomorrow = last.open_time + MS_PER_DAY;
  const d = new Date(tTomorrow);
  const label = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return [...normalized, { open_time: tTomorrow, close: null, label }];
}

/** Start stroke slightly past the last-real dot so lines do not visually cut through it. */
function lineStartAfterDot(x0: number, y0: number, x1: number, y1: number, dotRadius: number): [number, number] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [x0, y0];
  const t = Math.min((dotRadius + 1) / len, 1);
  return [x0 + dx * t, y0 + dy * t];
}

let lastSevenDayDisplay: DailyPoint[] = [];
let lastSavedForecasts: SavedForecast[] = [];
/** Newest-first JSON: σ for log-return vol over the next ~10s bar; used as ± band on spot. */
let latest10sGarchSigma: number | null = null;
let latest10sGarchSigmaUpdatedAtMs = 0;

function dateKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function splitForecastRows(forecasts: SavedForecast[]): {
  latest: SavedForecast | null;
  historicalMidnights: SavedForecast[];
} {
  if (forecasts.length === 0) {
    return { latest: null, historicalMidnights: [] };
  }

  const sorted = [...forecasts].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const latest = sorted[sorted.length - 1];
  const midnightRows = sorted.filter((f) => {
    const t = new Date(f.timestamp);
    return t.getUTCHours() === 0 && t.getUTCMinutes() === 0 && t.getUTCSeconds() === 0;
  });

  /*
   * Last up to 3 UTC midnights as column overlays (each σ is drawn on that calendar day).
   * Do not use slice(-3,-1): that dropped the newest midnight (e.g. Mar 24) so its band
   * never appeared on that day — only “tomorrow” used latest.
   */
  const historicalMidnights =
    midnightRows.length >= 3 ? midnightRows.slice(-3) : midnightRows.slice();

  return { latest, historicalMidnights };
}

async function loadSavedForecasts(): Promise<SavedForecast[]> {
  const res = await fetch(FORECASTS_JSON_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = (await res.json()) as { forecasts?: SavedForecast[] };
  return Array.isArray(payload.forecasts) ? payload.forecasts : [];
}

async function loadForecasts10sSigma(): Promise<void> {
  try {
    const res = await fetch(FORECASTS_10S_JSON_URL, { cache: "no-store" });
    if (!res.ok) {
      latest10sGarchSigma = null;
      latest10sGarchSigmaUpdatedAtMs = Date.now();
      return;
    }
    const payload = (await res.json()) as { forecasts?: SavedForecast[] };
    const rows = payload.forecasts;
    if (!Array.isArray(rows) || rows.length === 0) {
      latest10sGarchSigma = null;
      latest10sGarchSigmaUpdatedAtMs = Date.now();
      return;
    }
    const top = rows[0];
    const s = top?.garch_forecast;
    latest10sGarchSigma =
      typeof s === "number" && Number.isFinite(s) ? Math.max(s, 0) : null;
    latest10sGarchSigmaUpdatedAtMs = Date.now();
  } catch {
    latest10sGarchSigma = null;
    latest10sGarchSigmaUpdatedAtMs = Date.now();
  }
}

function handleNewSpotPrice(close: number) {
  if (!Number.isFinite(close)) return;
  const nowMs = Date.now();
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
    if (canvas) forwardForecastColW[nPts - 2] = liveRangeColW(canvas.width, nPts);
  }
  if (prices.length > MAX_POINTS) {
    prices.shift();
    forwardForecastSigma.shift();
    forwardForecastLow.shift();
    forwardForecastHigh.shift();
    forwardForecastColW.shift();
  }
  sigmaFromPreviousPoll =
    latest10sGarchSigma !== null && latest10sGarchSigma > 0 ? latest10sGarchSigma : null;

  const lastClose = prices[prices.length - 1];
  if (latest10sGarchSigma !== null && latest10sGarchSigma > 0 && Number.isFinite(lastClose)) {
    layoutPriceChartCanvas();
    const colW = canvas ? liveRangeColW(canvas.width, prices.length) : 3;
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

  drawChart();

  const timestamp = new Date().toLocaleTimeString();
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (liveChartPriceEl) {
    liveChartPriceEl.textContent = `price: ${fmt(close)}`;
  }
  if (lastPriceEl) {
    lastPriceEl.classList.remove("buy", "sell", "neutral");
    // Realized error vs the previous step's frozen forecast band.
    const n = prices.length;
    let logRow: ErrorRow | null = null;
    if (n >= 2 && sigmaForPreviousStep !== null && sigmaForPreviousStep > 0) {
      const anchor = prices[n - 2];
      const low = anchor * (1 - sigmaForPreviousStep);
      const high = anchor * (1 + sigmaForPreviousStep);
      let outsideFrac = 0;
      let side: "inside" | "above" | "below" = "inside";
      if (close > high) {
        outsideFrac = (close - high) / anchor;
        side = "above";
      } else if (close < low) {
        outsideFrac = (low - close) / anchor;
        side = "below";
      }
      if (side === "inside") {
        lastPriceEl.textContent = "within band";
        lastPriceEl.classList.add("buy");
      } else {
        lastPriceEl.textContent = `${(outsideFrac * 100).toFixed(3)}% ${side} range`;
        lastPriceEl.classList.add("sell");
      }
      logRow = {
        event_time: new Date(nowMs).toISOString(),
        outside_frac: outsideFrac,
        side: side === "inside" ? "inside" : side,
      };
    } else {
      lastPriceEl.textContent = "—";
      lastPriceEl.classList.add("neutral");
      // If forecast/refresh aren't synchronized (no usable σ yet), log a harmless placeholder.
      logRow = { event_time: new Date(nowMs).toISOString(), outside_frac: 0, side: "inside" };
    }

    if (logRow) {
      clientErrors10s.unshift(logRow);
      while (clientErrors10s.length > 30) clientErrors10s.pop();
      renderErrorRows(errors10sListEl, clientErrors10s);
    }
  }
  if (lastRefreshEl) lastRefreshEl.textContent = timestamp;
  if (marketEl) {
    const s = latest10sGarchSigma;
    marketEl.textContent =
      typeof s === "number" && Number.isFinite(s) && s > 0 ? `${(s * 100).toFixed(4)}%` : "—";
  }
}

function startLivePriceWs() {
  const url = `${WS_BASE}/ws/price?symbol=btcusdt&min_interval_ms=500`;
  setWsStatus("Connecting...", "neutral");
  let ws: WebSocket | null = null;
  let lastUiUpdate = 0;
  const MIN_UI_MS = 900;
  const MAX_SIGMA_STALENESS_MS = POLL_MS * 3;

  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => setWsStatus("Live (WS)", "buy");
    ws.onclose = () => {
      setWsStatus("WS reconnecting…", "neutral");
      setTimeout(connect, 1200);
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
          void loadForecasts10sSigma();
        }
        handleNewSpotPrice(p);
      } catch {
        // ignore
      }
    };
  };
  connect();
}

// σ is sampled from backend every POLL_MS and applied to the next realized step.

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

function layoutChart7dCanvas() {
  if (!canvas7d) return;
  const panel = canvas7d.closest(".chart-panel");
  const raw = panel ? panel.clientWidth - 8 : canvas7d.clientWidth || 720;
  const w = Math.max(260, Math.min(Math.floor(raw), 1600));
  canvas7d.width = w;
  canvas7d.height = MAIN_CHART_HEIGHT;
}

function layoutPriceChartCanvas() {
  if (!canvas) return;
  const panel = canvas.closest(".chart-panel");
  const raw = panel ? panel.clientWidth - 8 : canvas.clientWidth || 720;
  const w = Math.max(260, Math.min(Math.floor(raw), 1600));
  canvas.width = w;
  canvas.height = MAIN_CHART_HEIGHT;
}

function setWsStatus(text: string, klass: "buy" | "sell" | "neutral" = "neutral") {
  if (!wsStatusEl) return;
  wsStatusEl.textContent = text;
  wsStatusEl.classList.remove("buy", "sell", "neutral");
  wsStatusEl.classList.add(klass);
}

function liveRangeColW(canvasWidth: number, nPoints: number): number {
  const pad = 20;
  return Math.max(
    2,
    Math.min(4, ((canvasWidth - pad * 2) / Math.max(nPoints * 5, 14)) * 0.55),
  );
}

function drawChart() {
  layoutPriceChartCanvas();
  if (!canvas || !ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  const pad = 20;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0d1429";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#253055";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = pad + ((height - pad * 2) * i) / 3;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }

  if (prices.length < 2) {
    ctx.fillStyle = "#9eabc9";
    ctx.font = "13px Segoe UI";
    ctx.fillText("Waiting for Binance REST data...", 24, height / 2);
    return;
  }

  let minP = Math.min(...prices);
  let maxP = Math.max(...prices);
  const nPre = prices.length;
  for (let i = 0; i < nPre - 1; i += 1) {
    const sig = forwardForecastSigma[i];
    if (sig === null || sig <= 0) continue;
    const anchor = prices[i];
    if (!Number.isFinite(anchor)) continue;
    minP = Math.min(minP, anchor * (1 - sig), anchor * (1 + sig));
    maxP = Math.max(maxP, anchor * (1 - sig), anchor * (1 + sig));
  }
  if (pendingForwardBand !== null && pendingForwardBand.sigma > 0) {
    const a = pendingForwardBand.anchorPrice;
    const s = pendingForwardBand.sigma;
    if (Number.isFinite(a)) {
      minP = Math.min(minP, a * (1 - s), a * (1 + s));
      maxP = Math.max(maxP, a * (1 - s), a * (1 + s));
    }
  }
  const padPct = 0.02;
  const padAbs = Math.max((maxP - minP) * padPct, 0.000001);
  minP -= padAbs;
  maxP += padAbs;
  const range = Math.max(maxP - minP, 0.000001);
  const plotH = height - pad * 2;
  const yAt = (p: number) => height - pad - ((p - minP) / range) * plotH;

  const n = prices.length;
  const lastIdx = n - 1;
  const hasPending =
    pendingForwardBand !== null &&
    pendingForwardBand.sigma > 0 &&
    Number.isFinite(pendingForwardBand.anchorPrice);
  /* Future column uses index n; span must be > n or it clips past the right pad. */
  const xSpan = hasPending
    ? Math.max(n + LIVE_FUTURE_GUTTER, 1e-6)
    : Math.max(lastIdx, 1e-6);
  const xAtIdx = (idx: number) => pad + ((width - pad * 2) * idx) / xSpan;
  const defaultColW = liveRangeColW(width, n);
  const dotSide = 8;
  const liveDotRadius = 5.2;
  const MIN_BAND_PX = 6; // purely visual minimum so tiny σ doesn't collapse to a 1px line
  /* Band from anchor prices[i] (7d-style) drawn at x of actual outcome prices[i+1]. */
  for (let i = 0; i < n - 1; i += 1) {
    const low = forwardForecastLow[i];
    const high = forwardForecastHigh[i];
    if (low === null || high === null) continue;
    const colW = forwardForecastColW[i] ?? defaultColW;
    const x = xAtIdx(i + 1);
    const yHi = yAt(high);
    const yLo = yAt(low);
    const midY = (yHi + yLo) / 2;
    const hBandRaw = Math.abs(yLo - yHi);
    const bandH = Math.max(hBandRaw, MIN_BAND_PX);
    let topY = midY - bandH / 2;
    topY = Math.max(pad, Math.min(topY, height - pad - bandH));
    const left = x - colW / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, topY, colW, bandH);
    ctx.clip();

    ctx.strokeStyle = CHART_RANGE_STRIPE;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    const stride = 4;
    for (let s = left - bandH; s <= left + colW + bandH; s += stride) {
      ctx.beginPath();
      ctx.moveTo(s, topY);
      ctx.lineTo(s + bandH, topY + bandH);
      ctx.stroke();
    }
    ctx.restore();

    // Single range line (avoid the two vertical edges of a rectangle frame).
    ctx.strokeStyle = CHART_RANGE;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, topY);
    ctx.lineTo(x, topY + bandH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Range endpoints (ticks) for this step.
    ctx.strokeStyle = CHART_RANGE;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    const capLen = Math.max(6, dotSide);
    ctx.beginPath();
    ctx.moveTo(x - capLen / 2, yLo);
    ctx.lineTo(x + capLen / 2, yLo);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - capLen / 2, yHi);
    ctx.lineTo(x + capLen / 2, yHi);
    ctx.stroke();
  }

  /* Segment i-1 → i: actual price path. */
  ctx.strokeStyle = CHART_PRICE_LINE;
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  for (let i = 1; i < n; i += 1) {
    ctx.beginPath();
    ctx.moveTo(xAtIdx(i - 1), yAt(prices[i - 1]));
    ctx.lineTo(xAtIdx(i), yAt(prices[i]));
    ctx.stroke();
  }

  /* Future column: stripy band + one pair of red spokes from last anchor (7d tomorrow style). */
  if (hasPending && pendingForwardBand !== null) {
    const anchor = pendingForwardBand.anchorPrice;
    const sig = pendingForwardBand.sigma;
    const low = pendingForwardBand.low;
    const high = pendingForwardBand.high;
    const xFuture = xAtIdx(n);
    const yLow = yAt(low);
    const yHigh = yAt(high);
    const midY = (yLow + yHigh) / 2;
    const hBandRaw = Math.abs(yHigh - yLow);
    const bandH = Math.max(hBandRaw, MIN_BAND_PX);
    let topY = midY - bandH / 2;
    topY = Math.max(pad, Math.min(topY, height - pad - bandH));
    const colW = pendingForwardBand.colW || defaultColW;
    const left = xFuture - colW / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, topY, colW, bandH);
    ctx.clip();
    ctx.strokeStyle = CHART_RANGE_STRIPE;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    const stride = 4;
    for (let s = left - bandH; s <= left + colW + bandH; s += stride) {
      ctx.beginPath();
      ctx.moveTo(s, topY);
      ctx.lineTo(s + bandH, topY + bandH);
      ctx.stroke();
    }
    ctx.restore();
    // Single range line (avoid the two vertical edges of a rectangle frame).
    ctx.strokeStyle = CHART_RANGE;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(xFuture, topY);
    ctx.lineTo(xFuture, topY + bandH);
    ctx.stroke();
    ctx.setLineDash([]);

    const xNow = xAtIdx(lastIdx);
    const yNow = yAt(prices[lastIdx]);
    const [sxLo, syLo] = lineStartAfterDot(xNow, yNow, xFuture, yLow, liveDotRadius);
    const [sxHi, syHi] = lineStartAfterDot(xNow, yNow, xFuture, yHigh, liveDotRadius);
    ctx.save();
    ctx.strokeStyle = CHART_RANGE;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(sxLo, syLo);
    ctx.lineTo(xFuture, yLow);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sxHi, syHi);
    ctx.lineTo(xFuture, yHigh);
    ctx.stroke();
    ctx.setLineDash([]);
    // Range endpoints: ticks + same color as range lines.
    ctx.strokeStyle = CHART_RANGE;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    const capLen = Math.max(6, dotSide);
    ctx.beginPath();
    ctx.moveTo(xFuture - capLen / 2, yLow);
    ctx.lineTo(xFuture + capLen / 2, yLow);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(xFuture - capLen / 2, yHigh);
    ctx.lineTo(xFuture + capLen / 2, yHigh);
    ctx.stroke();
    ctx.restore();
  }

  /** Dots on each tick (round); outside the one-step band → CHART_DOT_OUTSIDE. */
  for (let k = 0; k < n; k += 1) {
    let inside = true;
    if (k >= 1) {
      const sigStep = forwardForecastSigma[k - 1];
      const anchorStep = prices[k - 1];
      const spot = prices[k];
      if (sigStep !== null && sigStep > 0 && Number.isFinite(anchorStep) && Number.isFinite(spot)) {
        const lo = anchorStep * (1 - sigStep);
        const hi = anchorStep * (1 + sigStep);
        const loB = Math.min(lo, hi);
        const hiB = Math.max(lo, hi);
        inside = spot >= loB && spot <= hiB;
      }
    }
    const cx = xAtIdx(k);
    const cy = yAt(prices[k]);

    ctx.save();
    ctx.shadowBlur = LIVE_DOT_SHADOW_BLUR;
    ctx.shadowColor = inside ? LIVE_DOT_SHADOW_COLOR_INSIDE : LIVE_DOT_SHADOW_COLOR_OUTSIDE;
    ctx.fillStyle = inside ? CHART_DOT : CHART_DOT_OUTSIDE;
    ctx.beginPath();
    ctx.arc(cx, cy, liveDotRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = LIVE_DOT_OUTLINE_WIDTH;
    ctx.strokeStyle = LIVE_DOT_OUTLINE_COLOR;
    ctx.stroke();
    ctx.restore();
  }
}

function drawSevenDayChart(points: DailyPoint[]) {
  if (!canvas7d || !ctx7d) return;
  const width = canvas7d.width;
  const height = canvas7d.height;
  const padTop = 22;
  const padLeft = 14;
  const padRight = 14;
  const bottomPad = 48;

  ctx7d.clearRect(0, 0, width, height);
  ctx7d.fillStyle = "#0d1429";
  ctx7d.fillRect(0, 0, width, height);

  ctx7d.strokeStyle = "#253055";
  ctx7d.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const y = padTop + ((height - padTop - bottomPad) * i) / 3;
    ctx7d.beginPath();
    ctx7d.moveTo(padLeft, y);
    ctx7d.lineTo(width - padRight, y);
    ctx7d.stroke();
  }

  const realCloses = points.map((p) => p.close).filter((c): c is number => c !== null && Number.isFinite(c));

  if (realCloses.length === 0) {
    ctx7d.fillStyle = "#9eabc9";
    ctx7d.font = "13px Segoe UI";
    ctx7d.fillText("No daily data yet.", padLeft + 8, height / 2);
    if (chart7dLowEl) chart7dLowEl.textContent = "—";
    if (chart7dHighEl) chart7dHighEl.textContent = "—";
    return;
  }

  let minP = Math.min(...realCloses);
  let maxP = Math.max(...realCloses);

  // Expand Y-scale so forecast ranges are visible on the same chart.
  if (lastSavedForecasts.length > 0) {
    const { latest, historicalMidnights } = splitForecastRows(lastSavedForecasts);

    historicalMidnights.forEach((fp) => {
      const ts = Date.parse(fp.timestamp);
      if (!Number.isFinite(ts)) return;
      const k = dateKeyUtc(ts);
      const idx = points.findIndex((p) => p.close !== null && dateKeyUtc(p.open_time) === k);
      if (idx <= 0) return;
      const baseClose = points[idx - 1].close as number;
      const sigma = Math.max(fp.garch_forecast, 0);
      const low = baseClose * (1 - sigma);
      const high = baseClose * (1 + sigma);
      minP = Math.min(minP, low);
      maxP = Math.max(maxP, high);
    });

    const lastRealClose = [...points].reverse().find((p) => p.close !== null)?.close ?? null;
    if (latest && lastRealClose !== null && Number.isFinite(lastRealClose)) {
      const sigma = Math.max(latest.garch_forecast, 0);
      const low = lastRealClose * (1 - sigma);
      const high = lastRealClose * (1 + sigma);
      minP = Math.min(minP, low);
      maxP = Math.max(maxP, high);
    }
  }

  const padPct = 0.03;
  const padAbs = Math.max((maxP - minP) * padPct, 0.000001);
  minP -= padAbs;
  maxP += padAbs;
  const range = Math.max(maxP - minP, 0.000001);
  const plotH = height - padTop - bottomPad;
  const plotW = width - padLeft - padRight;
  const lastIdx = Math.max(points.length - 1, 0);
  const rightXGutterSteps = 0.14;
  const xSpan = Math.max(lastIdx + rightXGutterSteps, 1e-6);
  const xAt = (i: number) => padLeft + (plotW * i) / xSpan;
  const yAt = (close: number) => padTop + plotH - ((close - minP) / range) * plotH;

  /* Line only across real closes (stops before future slot) */
  ctx7d.beginPath();
  ctx7d.lineWidth = 2;
  ctx7d.strokeStyle = CHART_PRICE_LINE;
  let started = false;
  points.forEach((p, i) => {
    if (p.close === null) {
      started = false;
      return;
    }
    const x = xAt(i);
    const y = yAt(p.close);
    if (!started) {
      ctx7d.moveTo(x, y);
      started = true;
    } else {
      ctx7d.lineTo(x, y);
    }
  });
  ctx7d.stroke();

  // For days where we have a saved midnight forecast, clamp the dot onto that day's forecast range.
  const rangeByIdx = new Map<number, { low: number; high: number }>();
  if (lastSavedForecasts.length > 0) {
    const { historicalMidnights } = splitForecastRows(lastSavedForecasts);
    historicalMidnights.forEach((fp) => {
      const ts = Date.parse(fp.timestamp);
      if (!Number.isFinite(ts)) return;
      const k = dateKeyUtc(ts);
      const idx = points.findIndex((p) => p.close !== null && dateKeyUtc(p.open_time) === k);
      if (idx <= 0) return;
      const baseClose = points[idx - 1].close;
      if (baseClose === null || !Number.isFinite(baseClose)) return;
      const sigma = Math.max(fp.garch_forecast, 0);
      const lo = baseClose * (1 - sigma);
      const hi = baseClose * (1 + sigma);
      rangeByIdx.set(idx, { low: Math.min(lo, hi), high: Math.max(lo, hi) });
    });
  }

  /* Overlay saved forecasts: recent midnights on matching dates + latest range on tomorrow. */
  if (lastSavedForecasts.length > 0) {
    const { latest, historicalMidnights } = splitForecastRows(lastSavedForecasts);

    historicalMidnights.forEach((fp) => {
      const ts = Date.parse(fp.timestamp);
      if (!Number.isFinite(ts)) return;
      const k = dateKeyUtc(ts);
      const idx = points.findIndex((p) => p.close !== null && dateKeyUtc(p.open_time) === k);
      if (idx <= 0) return;
      const baseClose = points[idx - 1].close as number;
      const sigma = Math.max(fp.garch_forecast, 0);
      const low = baseClose * (1 - sigma);
      const high = baseClose * (1 + sigma);
      const x = xAt(idx);
      const yLow = yAt(low);
      const yHigh = yAt(high);

      ctx7d.save();
      ctx7d.strokeStyle = CHART_RANGE;
      ctx7d.lineWidth = 2;
      ctx7d.setLineDash([4, 4]);
      ctx7d.beginPath();
      ctx7d.moveTo(x, yLow);
      ctx7d.lineTo(x, yHigh);
      ctx7d.stroke();
      ctx7d.setLineDash([]);
      ctx7d.fillStyle = CHART_RANGE;
      ctx7d.beginPath();
      ctx7d.arc(x, yLow, 3, 0, Math.PI * 2);
      ctx7d.fill();
      ctx7d.beginPath();
      ctx7d.arc(x, yHigh, 3, 0, Math.PI * 2);
      ctx7d.fill();
      ctx7d.restore();
    });

    const futureIdx = points.findIndex((p) => p.close === null);
    const lastRealIdx = (() => {
      for (let i = points.length - 1; i >= 0; i -= 1) {
        if (points[i].close !== null) return i;
      }
      return -1;
    })();
    const lastReal = lastRealIdx >= 0 ? (points[lastRealIdx].close as number) : null;

    if (latest && futureIdx >= 0 && lastReal !== null && Number.isFinite(lastReal)) {
      const sigma = Math.max(latest.garch_forecast, 0);
      const low = lastReal * (1 - sigma);
      const high = lastReal * (1 + sigma);
      const x = xAt(futureIdx);
      const yLow = yAt(low);
      const yHigh = yAt(high);
      const xNow = xAt(lastRealIdx);
      const yNow = yAt(lastReal);
      const yellowDotR = 3.5;
      const [sxLow, syLow] = lineStartAfterDot(xNow, yNow, x, yLow, yellowDotR);
      const [sxHigh, syHigh] = lineStartAfterDot(xNow, yNow, x, yHigh, yellowDotR);

      ctx7d.save();
      ctx7d.strokeStyle = CHART_RANGE;
      ctx7d.lineWidth = 2;
      ctx7d.setLineDash([4, 4]);
      ctx7d.beginPath();
      ctx7d.moveTo(sxLow, syLow);
      ctx7d.lineTo(x, yLow);
      ctx7d.stroke();
      ctx7d.beginPath();
      ctx7d.moveTo(sxHigh, syHigh);
      ctx7d.lineTo(x, yHigh);
      ctx7d.stroke();
      ctx7d.setLineDash([]);
      ctx7d.fillStyle = CHART_RANGE;
      ctx7d.beginPath();
      ctx7d.arc(x, yLow, 3, 0, Math.PI * 2);
      ctx7d.fill();
      ctx7d.beginPath();
      ctx7d.arc(x, yHigh, 3, 0, Math.PI * 2);
      ctx7d.fill();
      ctx7d.restore();
    }
  }

  /* Dots on real days (drawn last so ranges don't cover them) */
  points.forEach((p, i) => {
    if (p.close === null) return;
    const x = xAt(i);
    const y = yAt(p.close);
    ctx7d.save();
    ctx7d.shadowBlur = 10;
    ctx7d.shadowColor = "rgba(214, 236, 255, 0.95)";
    ctx7d.beginPath();
    ctx7d.fillStyle = CHART_DOT_7D;
    ctx7d.arc(x, y, 4.4, 0, Math.PI * 2);
    ctx7d.fill();
    ctx7d.shadowBlur = 0;
    ctx7d.lineWidth = 2;
    ctx7d.strokeStyle = "rgba(13, 20, 41, 0.95)";
    ctx7d.stroke();
    ctx7d.restore();
  });

  if (chart7dLowEl) {
    chart7dLowEl.textContent = minP.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  if (chart7dHighEl) {
    chart7dHighEl.textContent = maxP.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  ctx7d.fillStyle = "#9eabc9";
  ctx7d.font = width < 420 ? "9px Segoe UI" : "10px Segoe UI";
  points.forEach((p, i) => {
    const x = xAt(i);
    let label: string;
    if (p.label) {
      label = p.label;
    } else {
      const d = new Date(p.open_time);
      // Use UTC to match Binance daily candle boundaries (00:00 UTC).
      label = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    }
    const w = ctx7d.measureText(label).width;
    const minX = padLeft;
    const maxX = width - padRight - w;
    let tx = x - w / 2;
    if (tx < minX) tx = minX;
    if (tx > maxX) tx = maxX;
    ctx7d.fillText(label, tx, height - 18);
  });
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
    try {
      lastSavedForecasts = await loadSavedForecasts();
    } catch {
      lastSavedForecasts = [];
    }
    lastSevenDayDisplay = displayPts;
    layoutChart7dCanvas();
    drawSevenDayChart(lastSevenDayDisplay);

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
    if (chart7dLowEl) chart7dLowEl.textContent = "—";
    if (chart7dHighEl) chart7dHighEl.textContent = "—";
    lastSevenDayDisplay = [];
    layoutChart7dCanvas();
    drawSevenDayChart([]);
    rest7dStatusEl.textContent = "Failed — Binance REST unavailable";
    rest7dStatusEl.classList.remove("neutral");
    rest7dStatusEl.classList.add("sell");
    if (vol24hSigmaEl) vol24hSigmaEl.textContent = "—";
    if (ydayBandEl) ydayBandEl.textContent = "—";
    console.error("7d fetch", e);
  }
}

async function loadCurrentPrice() {
  try {
    await loadForecasts10sSigma();
  } catch (e) {
    pendingForwardBand = null;
    if (liveChartPriceEl) liveChartPriceEl.textContent = "—";
    setWsStatus("Forecast fetch error", "sell");
    console.error("price fetch", e);
  }
}

drawChart();
void loadSevenDayPrices();
void loadCurrentPrice();
void loadCusumSignals();
setInterval(() => {
  void loadSevenDayPrices();
}, SEVEN_DAY_POLL_MS);
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
    drawChart();
    layoutChart7dCanvas();
    drawSevenDayChart(lastSevenDayDisplay);
  }, 120);
});

startLivePriceWs();