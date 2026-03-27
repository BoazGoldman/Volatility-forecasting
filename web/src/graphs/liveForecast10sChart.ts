/**
 * Short-horizon GARCH live price chart (WS ticks + polled σ): canvas, tunnels, purple head, trail.
 * API timeframe is LIVE_FORECAST_TIMEFRAME (short-horizon live σ).
 */

export const MAX_POINTS = 10;
/** API bar label; must match `TEN_SEC_DB_TIMEFRAME` / DB rows (default 10s). */
export const LIVE_FORECAST_TIMEFRAME = "10s";

export type SavedForecast = { timestamp: string; garch_forecast: number };

const API_BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE ??
  "http://127.0.0.1:8000";
const BINANCE_PAIR = "BTC/USDT";
const LIVE_FORECAST_JSON_URL = `${API_BASE}/forecasts?symbol=${encodeURIComponent(BINANCE_PAIR)}&timeframe=${encodeURIComponent(LIVE_FORECAST_TIMEFRAME)}&newest_first=true&limit=6`;

const MAIN_CHART_HEIGHT = 320;

const CHART_RANGE = "#FFFFFF";
const CHART_PRICE_LINE = "#5E97F6";
const CHART_DOT_OUTSIDE = "#FF5252";

const LIVE_DOT_SHADOW_BLUR = 14;
const LIVE_DOT_OUTLINE_COLOR = "rgba(13, 20, 41, 0.96)";
const LIVE_DOT_OUTLINE_WIDTH = 2;
const LIVE_TIP_DOT_RADIUS = 4.5;
const LIVE_LINE_GLOW_BLUR = 44;
const LIVE_LINE_GLOW_COLOR_OK = "rgba(120, 178, 255, 1)";
const LIVE_LINE_GLOW_COLOR_BAD = "rgba(255, 120, 120, 1)";
const LIVE_LINE_OUTLINE_WIDTH = 5;
const LIVE_TRAIL_STROKE_WIDTH = 2.75;
const LIVE_PURPLE_PATH_STEPS_FROM_END = 5;
const LIVE_NEWEST_X_FRAC = 0.5;
const LIVE_X_SPAN_FRAC = 0.9;
const LIVE_PURPLE_SEG_MS = 1200;

const liveRangeEl = document.getElementById("live-range");
const marketEl = document.getElementById("market-value");
const canvas = document.getElementById("price-chart") as HTMLCanvasElement | null;
const ctx = canvas?.getContext("2d") ?? null;

let livePurpleAnimRaf = 0;
let livePurpleFloatIdx = 0;
let livePurpleLastPerfMs = 0;

export let latest10sGarchSigma: number | null = null;
export let latest10sGarchSigmaUpdatedAtMs = 0;
let latest10sForecastKey: string | null = null;
let pendingTunnelKey: string | null = null;
let pendingTunnelSigma: number | null = null;
let activeTunnelKey: string | null = null;
let activeTunnelSigma: number | null = null;
let activeTunnelAnchorPrice: number | null = null;
let activeTunnelStartIdx: number | null = null;

type TunnelBand = {
  key: string;
  sigma: number;
  anchorPrice: number;
  startIdx: number;
  endIdx: number;
};
const tunnelBands: TunnelBand[] = [];
let liveYViewMin: number | null = null;
let liveYViewMax: number | null = null;

export function refreshLiveForecastRangeLabel(prices: number[]) {
  if (!liveRangeEl) return;
  const s = latest10sGarchSigma;
  const n = prices.length;
  const anchor = n >= 2 ? prices[n - 2] : null;
  if (
    typeof s === "number" &&
    Number.isFinite(s) &&
    s > 0 &&
    typeof anchor === "number" &&
    Number.isFinite(anchor)
  ) {
    const fmt = (x: number) => x.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const low = anchor * (1 - s);
    const high = anchor * (1 + s);
    liveRangeEl.textContent = `range: ${fmt(low)} – ${fmt(high)}`;
  } else {
    liveRangeEl.textContent = "—";
  }
}

export async function loadForecasts10sSigma(prices: number[]): Promise<void> {
  const now = Date.now();
  const tryUrls = [LIVE_FORECAST_JSON_URL, "/forecasts_10s.json"];
  let rows: SavedForecast[] | null = null;
  for (const url of tryUrls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const payload = (await res.json()) as { forecasts?: SavedForecast[] };
      if (Array.isArray(payload.forecasts) && payload.forecasts.length > 0) {
        rows = payload.forecasts;
        break;
      }
    } catch {
      // try next
    }
  }

  if (!rows || rows.length === 0) {
    latest10sGarchSigma = null;
    latest10sGarchSigmaUpdatedAtMs = now;
    latest10sForecastKey = null;
  } else {
    const top = rows[0];
    const s = top?.garch_forecast;
    latest10sGarchSigma = typeof s === "number" && Number.isFinite(s) ? Math.max(s, 0) : null;
    latest10sGarchSigmaUpdatedAtMs = now;
    const ts = typeof top?.timestamp === "string" ? top.timestamp : "na";
    const sig =
      latest10sGarchSigma !== null && latest10sGarchSigma > 0
        ? String(Math.round(latest10sGarchSigma * 1e8) / 1e8)
        : "none";
    latest10sForecastKey = `${ts}|${sig}`;
  }

  if (marketEl) {
    const s = latest10sGarchSigma;
    marketEl.textContent =
      typeof s === "number" && Number.isFinite(s) && s > 0 ? `${(s * 100).toFixed(4)}%` : "—";
  }

  if (
    latest10sForecastKey &&
    latest10sForecastKey !== activeTunnelKey &&
    typeof latest10sGarchSigma === "number" &&
    Number.isFinite(latest10sGarchSigma) &&
    latest10sGarchSigma > 0
  ) {
    pendingTunnelKey = latest10sForecastKey;
    pendingTunnelSigma = latest10sGarchSigma;
  }

  refreshLiveForecastRangeLabel(prices);
}

/** After dropping the oldest price slot when length > MAX_POINTS. */
export function shiftLiveChartAfterRingBufferPop() {
  if (activeTunnelStartIdx !== null) {
    activeTunnelStartIdx = Math.max(activeTunnelStartIdx - 1, 0);
  }
  for (const b of tunnelBands) {
    b.startIdx -= 1;
    b.endIdx -= 1;
  }
  for (let i = tunnelBands.length - 1; i >= 0; i -= 1) {
    if (tunnelBands[i].endIdx < 0) tunnelBands.splice(i, 1);
  }
  livePurpleFloatIdx = Math.max(0, livePurpleFloatIdx - 1);
}

/**
 * Run on each new spot after arrays updated; mirrors prior `handleNewSpotPrice` tail order
 * (call after draw if you need identical frame ordering — see app handler).
 */
export function tryActivatePendingTunnel(prices: number[]) {
  if (!pendingTunnelKey || pendingTunnelKey === activeTunnelKey) return;
  const sigma = pendingTunnelSigma;
  const n = prices.length;
  const anchor = n >= 2 ? prices[n - 2] : null;
  if (
    typeof sigma === "number" &&
    Number.isFinite(sigma) &&
    sigma > 0 &&
    typeof anchor === "number" &&
    Number.isFinite(anchor)
  ) {
    if (
      activeTunnelKey &&
      activeTunnelSigma !== null &&
      Number.isFinite(activeTunnelSigma) &&
      activeTunnelSigma > 0 &&
      activeTunnelAnchorPrice !== null &&
      Number.isFinite(activeTunnelAnchorPrice) &&
      activeTunnelStartIdx !== null
    ) {
      tunnelBands.push({
        key: activeTunnelKey,
        sigma: activeTunnelSigma,
        anchorPrice: activeTunnelAnchorPrice,
        startIdx: activeTunnelStartIdx,
        endIdx: Math.max(n - 2, activeTunnelStartIdx),
      });
    }
    activeTunnelKey = pendingTunnelKey;
    activeTunnelSigma = sigma;
    activeTunnelAnchorPrice = anchor;
    activeTunnelStartIdx = n - 2;
  } else {
    activeTunnelKey = pendingTunnelKey;
    activeTunnelSigma = null;
    activeTunnelAnchorPrice = null;
    activeTunnelStartIdx = null;
  }
  pendingTunnelKey = null;
  pendingTunnelSigma = null;
}

export function layoutPriceChartCanvas() {
  if (!canvas) return;
  const panel = canvas.closest(".chart-panel");
  const raw = panel ? panel.clientWidth - 8 : canvas.clientWidth || 720;
  const w = Math.max(260, Math.min(Math.floor(raw), 1600));
  canvas.width = w;
  canvas.height = MAIN_CHART_HEIGHT;
}

export function liveRangeColW(canvasWidth: number, nPoints: number): number {
  const pad = 20;
  return Math.max(
    2,
    Math.min(4, ((canvasWidth - pad * 2) / Math.max(nPoints * 5, 14)) * 0.55),
  );
}

export type LiveForecastSeries = {
  prices: number[];
  forwardForecastSigma: (number | null)[];
  forwardForecastLow: (number | null)[];
  forwardForecastHigh: (number | null)[];
  pendingForwardBand: {
    anchorPrice: number;
    sigma: number;
    low: number;
    high: number;
    colW: number;
  } | null;
};

export function drawLiveForecastChart(getSeries: () => LiveForecastSeries) {
  layoutPriceChartCanvas();
  if (!canvas || !ctx) return;
  const series = getSeries();
  const { prices, forwardForecastSigma, forwardForecastLow, forwardForecastHigh, pendingForwardBand } =
    series;
  const width = canvas.width;
  const height = canvas.height;
  const pad = 20;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0d1429";
  ctx.fillRect(0, 0, width, height);

  if (prices.length < 2) {
    liveYViewMin = null;
    liveYViewMax = null;
    if (livePurpleAnimRaf) {
      cancelAnimationFrame(livePurpleAnimRaf);
      livePurpleAnimRaf = 0;
    }
    livePurpleFloatIdx = 0;
    livePurpleLastPerfMs = 0;
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

  for (const b of tunnelBands) {
    const a = b.anchorPrice;
    const s = b.sigma;
    if (!Number.isFinite(a) || !Number.isFinite(s) || s <= 0) continue;
    minP = Math.min(minP, a * (1 - s), a * (1 + s));
    maxP = Math.max(maxP, a * (1 - s), a * (1 + s));
  }
  if (
    activeTunnelAnchorPrice !== null &&
    activeTunnelSigma !== null &&
    Number.isFinite(activeTunnelAnchorPrice) &&
    Number.isFinite(activeTunnelSigma) &&
    activeTunnelSigma > 0
  ) {
    const a = activeTunnelAnchorPrice;
    const s = activeTunnelSigma;
    minP = Math.min(minP, a * (1 - s), a * (1 + s));
    maxP = Math.max(maxP, a * (1 - s), a * (1 + s));
  }
  const padPct = 0.02;
  const padAbs = Math.max((maxP - minP) * padPct, 0.000001);
  minP -= padAbs;
  maxP += padAbs;
  if (liveYViewMin === null || liveYViewMax === null) {
    liveYViewMin = minP;
    liveYViewMax = maxP;
  } else {
    liveYViewMin = Math.min(liveYViewMin, minP);
    liveYViewMax = Math.max(liveYViewMax, maxP);
  }
  minP = liveYViewMin;
  maxP = liveYViewMax;
  const range = Math.max(maxP - minP, 0.000001);
  const plotH = height - pad * 2;
  const yAt = (p: number) => height - pad - ((p - minP) / range) * plotH;

  const n = prices.length;
  const lastIdx = n - 1;
  const purplePathStartIdx = Math.max(0, n - LIVE_PURPLE_PATH_STEPS_FROM_END);
  const purplePathSpan = lastIdx - purplePathStartIdx;
  const plotInnerW = width - pad * 2;
  const stepPx = (plotInnerW * LIVE_X_SPAN_FRAC) / Math.max(MAX_POINTS - 1, 1);
  const centerSlotX = pad + plotInnerW * LIVE_NEWEST_X_FRAC;

  const nowP = performance.now();
  if (lastIdx > 0 && purplePathSpan > 0) {
    if (livePurpleLastPerfMs > 0) {
      livePurpleFloatIdx += (nowP - livePurpleLastPerfMs) / LIVE_PURPLE_SEG_MS;
      while (livePurpleFloatIdx > lastIdx) {
        livePurpleFloatIdx = purplePathStartIdx + (livePurpleFloatIdx - lastIdx);
      }
    }
    livePurpleLastPerfMs = nowP;
    if (!Number.isFinite(livePurpleFloatIdx) || livePurpleFloatIdx < purplePathStartIdx) {
      livePurpleFloatIdx = purplePathStartIdx;
    }
  } else if (lastIdx > 0) {
    livePurpleLastPerfMs = nowP;
    livePurpleFloatIdx = purplePathStartIdx;
  } else {
    livePurpleLastPerfMs = nowP;
  }

  const xAtIdx = (idx: number) => centerSlotX + (idx - livePurpleFloatIdx) * stepPx;
  const xAtFloat = (u: number) => centerSlotX + (u - livePurpleFloatIdx) * stepPx;

  let purpleYRaw: number;
  if (lastIdx <= 0) {
    purpleYRaw = yAt(prices[0]);
  } else {
    const i0 = Math.min(Math.max(0, Math.floor(livePurpleFloatIdx)), lastIdx - 1);
    const localT = livePurpleFloatIdx - i0;
    const i1 = i0 + 1;
    const p0 = prices[i0];
    const p1 = prices[i1];
    if (!Number.isFinite(p0) || !Number.isFinite(p1)) {
      purpleYRaw = yAt(prices[0]);
    } else {
      const y0 = yAt(p0);
      const y1 = yAt(p1);
      purpleYRaw = y0 + (y1 - y0) * localT;
    }
  }
  const plotMidY = pad + plotH / 2;
  const yCamShift = plotMidY - purpleYRaw;
  const yDraw = (p: number) => yAt(p) + yCamShift;
  const purpleMarkerY = plotMidY;

  ctx.strokeStyle = "#253055";
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i += 1) {
    const gy = pad + ((height - pad * 2) * i) / 3 + yCamShift;
    ctx.beginPath();
    ctx.moveTo(pad, gy);
    ctx.lineTo(width - pad, gy);
    ctx.stroke();
  }

  const MIN_BAND_PX = 6;

  type LiveSeg = {
    x0: number;
    y0: number;
    p0: number;
    x1: number;
    y1: number;
    p1: number;
    /** Price path index of the segment end (outcome); tunnel [start,end] uses this for band lookup. */
    outcomeIdx: number;
  };
  const trailSegs: LiveSeg[] = [];
  const fTrail = livePurpleFloatIdx;
  const fFloor = Math.floor(fTrail);
  const fFrac = fTrail - fFloor;

  const bandBoundsForAnchor = (anchorIdx: number): { low: number; high: number } | null => {
    const loF = forwardForecastLow[anchorIdx];
    const hiF = forwardForecastHigh[anchorIdx];
    if (
      loF !== null &&
      hiF !== null &&
      Number.isFinite(loF) &&
      Number.isFinite(hiF)
    ) {
      return { low: Math.min(loF, hiF), high: Math.max(loF, hiF) };
    }
    const sig = forwardForecastSigma[anchorIdx];
    const anchor = prices[anchorIdx];
    if (sig === null || sig <= 0 || !Number.isFinite(anchor)) return null;
    const lo = anchor * (1 - sig);
    const hi = anchor * (1 + sig);
    return { low: Math.min(lo, hi), high: Math.max(lo, hi) };
  };

  /**
   * Same ±σ corridor as the dashed tunnel drawn over this path index (active first, then archived).
   * Tunnels extend [startIdx, endIdx] at fixed anchorPrice/σ — not the same as per-step forwardForecast*,
   * which made red/blue disagree with what you see.
   */
  const bandForOutcomePathIndex = (j: number): { low: number; high: number } | null => {
    if (j < 0 || j > lastIdx) return null;
    // Strictly after anchor index: path slot `activeTunnelStartIdx` is the forecast anchor dot;
    // the first *outcome* for the new σ is at +1. Using active band at the anchor caused blue one tick early.
    if (
      activeTunnelStartIdx !== null &&
      activeTunnelSigma !== null &&
      Number.isFinite(activeTunnelSigma) &&
      activeTunnelSigma > 0 &&
      activeTunnelAnchorPrice !== null &&
      Number.isFinite(activeTunnelAnchorPrice) &&
      j > activeTunnelStartIdx &&
      j <= lastIdx
    ) {
      const a = activeTunnelAnchorPrice;
      const s = activeTunnelSigma;
      const lo = a * (1 - s);
      const hi = a * (1 + s);
      return { low: Math.min(lo, hi), high: Math.max(lo, hi) };
    }
    for (let ti = tunnelBands.length - 1; ti >= 0; ti -= 1) {
      const b = tunnelBands[ti];
      if (j < b.startIdx || j > b.endIdx) continue;
      if (!Number.isFinite(b.sigma) || b.sigma <= 0 || !Number.isFinite(b.anchorPrice)) continue;
      const a = b.anchorPrice;
      const s = b.sigma;
      const lo = a * (1 - s);
      const hi = a * (1 + s);
      return { low: Math.min(lo, hi), high: Math.max(lo, hi) };
    }
    const aidx = Math.max(0, j - 1);
    return bandBoundsForAnchor(aidx);
  };

  const activeTunnelBandFlat = (): { low: number; high: number } | null => {
    if (
      activeTunnelSigma === null ||
      !Number.isFinite(activeTunnelSigma) ||
      activeTunnelSigma <= 0 ||
      activeTunnelAnchorPrice === null ||
      !Number.isFinite(activeTunnelAnchorPrice)
    ) {
      return null;
    }
    const a = activeTunnelAnchorPrice;
    const s = activeTunnelSigma;
    const lo = a * (1 - s);
    const hi = a * (1 + s);
    return { low: Math.min(lo, hi), high: Math.max(lo, hi) };
  };

  /**
   * When a new forecast sits above/below the previous (disjoint tunnels), don't let “inside the old
   * range” turn the stroke blue — keep comparing to the latest corridor until price enters it.
   */
  const bandForTrailStroke = (j: number): { low: number; high: number } | null => {
    const step = bandForOutcomePathIndex(j);
    const active = activeTunnelBandFlat();
    if (!active) return step;
    if (activeTunnelStartIdx !== null && j >= activeTunnelStartIdx && j <= lastIdx) {
      return step;
    }
    if (!step) return active;
    const scale = Math.max(
      Math.abs(step.low),
      Math.abs(step.high),
      Math.abs(active.low),
      Math.abs(active.high),
      1,
    );
    const eps = scale * 1e-9;
    if (step.high < active.low - eps || step.low > active.high + eps) {
      return active;
    }
    return step;
  };

  const headOutcomeIdx =
    lastIdx <= 0 ? 0 : Math.min(Math.max(0, Math.ceil(livePurpleFloatIdx)), lastIdx);
  const trailColorBand = bandForTrailStroke(headOutcomeIdx);

  let pTip: number;
  if (lastIdx <= 0) {
    pTip = prices[0];
  } else {
    const i0 = Math.min(Math.max(0, Math.floor(livePurpleFloatIdx)), lastIdx - 1);
    const localT = livePurpleFloatIdx - i0;
    pTip = prices[i0] + (prices[i0 + 1] - prices[i0]) * localT;
  }

  const tailEndJ = Math.min(purplePathStartIdx, lastIdx);
  for (let j = 1; j <= tailEndJ; j += 1) {
    const p0 = prices[j - 1];
    const p1 = prices[j];
    trailSegs.push({
      x0: xAtIdx(j - 1),
      y0: yDraw(p0),
      p0,
      x1: xAtIdx(j),
      y1: yDraw(p1),
      p1,
      outcomeIdx: j,
    });
  }
  const pathFullEndJ = Math.min(fFloor, lastIdx);
  for (let j = purplePathStartIdx + 1; j <= pathFullEndJ; j += 1) {
    const p0 = prices[j - 1];
    const p1 = prices[j];
    trailSegs.push({
      x0: xAtIdx(j - 1),
      y0: yDraw(p0),
      p0,
      x1: xAtIdx(j),
      y1: yDraw(p1),
      p1,
      outcomeIdx: j,
    });
  }

  if (fFrac > 1e-6 && fFloor < lastIdx && fFloor >= purplePathStartIdx) {
    const p0 = prices[fFloor];
    const p1 = prices[fFloor + 1];
    const pst = p0 + (p1 - p0) * fFrac;
    trailSegs.push({
      x0: xAtFloat(fFloor),
      y0: yDraw(p0),
      p0,
      x1: xAtFloat(fFloor + fFrac),
      y1: yDraw(pst),
      p1: pst,
      outcomeIdx: fFloor + 1,
    });
  }

  const drawTunnel = (
    startIdx: number,
    endIdx: number,
    anchorPrice: number,
    sigma: number,
    opts?: { xEndPx?: number },
  ) => {
    const low = anchorPrice * (1 - sigma);
    const high = anchorPrice * (1 + sigma);
    const yLow = yDraw(low);
    const yHigh = yDraw(high);
    const xStart = xAtIdx(startIdx);
    const xEndRaw = xAtIdx(endIdx);
    const xEnd =
      typeof opts?.xEndPx === "number" && Number.isFinite(opts.xEndPx)
        ? Math.max(xEndRaw, opts.xEndPx)
        : xEndRaw;

    ctx.save();
    ctx.strokeStyle = CHART_RANGE;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(xStart, yLow);
    ctx.lineTo(xEnd, yLow);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(xStart, yHigh);
    ctx.lineTo(xEnd, yHigh);
    ctx.stroke();
    ctx.setLineDash([]);
    if (Math.abs(yHigh - yLow) < MIN_BAND_PX) {
      const mid = (yHigh + yLow) / 2;
      const half = MIN_BAND_PX / 2;
      ctx.beginPath();
      ctx.moveTo(xStart, mid - half);
      ctx.lineTo(xEnd, mid - half);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(xStart, mid + half);
      ctx.lineTo(xEnd, mid + half);
      ctx.stroke();
    }
    ctx.restore();
  };

  for (const b of tunnelBands) {
    if (!Number.isFinite(b.sigma) || b.sigma <= 0) continue;
    if (b.startIdx >= n) continue;
    if (b.endIdx < 0) continue;
    drawTunnel(Math.max(0, b.startIdx), Math.min(n - 1, Math.max(b.endIdx, 0)), b.anchorPrice, b.sigma);
  }

  if (
    activeTunnelSigma !== null &&
    activeTunnelSigma > 0 &&
    activeTunnelAnchorPrice !== null &&
    Number.isFinite(activeTunnelAnchorPrice) &&
    activeTunnelStartIdx !== null &&
    activeTunnelStartIdx >= 0 &&
    activeTunnelStartIdx < n
  ) {
    const tunnelEndIdx = Math.max(n - 1, activeTunnelStartIdx);
    const plotRightX = width - pad;
    drawTunnel(activeTunnelStartIdx, tunnelEndIdx, activeTunnelAnchorPrice, activeTunnelSigma, {
      xEndPx: Math.max(xAtIdx(tunnelEndIdx), plotRightX),
    });
  }

  const strokeTrailSegment = (
    x0: number,
    y0: number,
    p0: number,
    x1: number,
    y1: number,
    p1: number,
    outcomeIdx: number,
  ) => {
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = LIVE_DOT_OUTLINE_COLOR;
    ctx.lineWidth = LIVE_LINE_OUTLINE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();

    const drawSolid = (stroke: string, glow: string) => {
      ctx.save();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = LIVE_TRAIL_STROKE_WIDTH;
      ctx.shadowBlur = LIVE_LINE_GLOW_BLUR;
      ctx.shadowColor = glow;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.restore();
    };

    if (!Number.isFinite(p0) || !Number.isFinite(p1)) {
      drawSolid(CHART_PRICE_LINE, LIVE_LINE_GLOW_COLOR_OK);
      return;
    }

    const band = bandForTrailStroke(outcomeIdx);
    if (band === null) {
      drawSolid(CHART_PRICE_LINE, LIVE_LINE_GLOW_COLOR_OK);
      return;
    }
    const { low, high } = band;

    const inside = (p: number) => p >= low && p <= high;
    const priceScale = Math.max(Math.abs(p0), Math.abs(p1), Math.abs(low), Math.abs(high), 1);
    const flatEps = Math.max(1e-12, priceScale * 1e-12);
    const denom = p1 - p0;
    if (Math.abs(denom) < flatEps) {
      const segBad = !inside((p0 + p1) * 0.5);
      drawSolid(
        segBad ? CHART_DOT_OUTSIDE : CHART_PRICE_LINE,
        segBad ? LIVE_LINE_GLOW_COLOR_BAD : LIVE_LINE_GLOW_COLOR_OK,
      );
      return;
    }

    const ts: number[] = [];
    const pushT = (b: number) => {
      const t = (b - p0) / denom;
      if (t > 1e-9 && t < 1 - 1e-9 && Number.isFinite(t)) ts.push(t);
    };
    pushT(low);
    pushT(high);
    ts.sort((a, b) => a - b);
    const uniq: number[] = [];
    for (const t of ts) {
      if (uniq.length === 0 || Math.abs(t - uniq[uniq.length - 1]) > 1e-6) uniq.push(t);
    }
    const cuts = [0, ...uniq, 1];
    for (let i = 0; i < cuts.length - 1; i += 1) {
      const a = cuts[i];
      const b = cuts[i + 1];
      if (b - a <= 1e-6) continue;
      const mid = (a + b) / 2;
      const pmid = p0 + denom * mid;
      const segBad = !inside(pmid);
      const xa = x0 + (x1 - x0) * a;
      const ya = y0 + (y1 - y0) * a;
      const xb = x0 + (x1 - x0) * b;
      const yb = y0 + (y1 - y0) * b;
      ctx.save();
      ctx.strokeStyle = segBad ? CHART_DOT_OUTSIDE : CHART_PRICE_LINE;
      ctx.lineWidth = LIVE_TRAIL_STROKE_WIDTH;
      ctx.shadowBlur = LIVE_LINE_GLOW_BLUR;
      ctx.shadowColor = segBad ? LIVE_LINE_GLOW_COLOR_BAD : LIVE_LINE_GLOW_COLOR_OK;
      ctx.beginPath();
      ctx.moveTo(xa, ya);
      ctx.lineTo(xb, yb);
      ctx.stroke();
      ctx.restore();
    }
  };

  ctx.lineWidth = LIVE_TRAIL_STROKE_WIDTH;
  ctx.setLineDash([]);
  for (const s of trailSegs) {
    strokeTrailSegment(s.x0, s.y0, s.p0, s.x1, s.y1, s.p1, s.outcomeIdx);
  }

  const headOk =
    trailColorBand === null || !Number.isFinite(pTip)
      ? true
      : pTip >= trailColorBand.low && pTip <= trailColorBand.high;

  if (n >= 1) {
    const tx = centerSlotX;
    const ty = purpleMarkerY;
    if (Number.isFinite(tx) && Number.isFinite(ty)) {
      ctx.save();
      ctx.shadowBlur = LIVE_DOT_SHADOW_BLUR;
      ctx.shadowColor = headOk ? LIVE_LINE_GLOW_COLOR_OK : LIVE_LINE_GLOW_COLOR_BAD;
      ctx.fillStyle = headOk ? CHART_PRICE_LINE : CHART_DOT_OUTSIDE;
      ctx.beginPath();
      ctx.arc(tx, ty, LIVE_TIP_DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = LIVE_DOT_OUTLINE_WIDTH;
      ctx.strokeStyle = LIVE_DOT_OUTLINE_COLOR;
      ctx.stroke();
      ctx.restore();
    }
  }

  if (lastIdx > purplePathStartIdx) {
    if (!livePurpleAnimRaf) {
      livePurpleAnimRaf = requestAnimationFrame(() => {
        livePurpleAnimRaf = 0;
        drawLiveForecastChart(getSeries);
      });
    }
  } else if (livePurpleAnimRaf) {
    cancelAnimationFrame(livePurpleAnimRaf);
    livePurpleAnimRaf = 0;
  }
}
