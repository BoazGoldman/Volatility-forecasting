/**
 * Short-horizon GARCH live price chart (WS ticks + polled σ), rendered with ApexCharts.
 * This module intentionally keeps the same exported function names that `app.ts` calls.
 */

import ApexCharts from "apexcharts";

export const MAX_POINTS = 10;
/** API bar label; must match the DB timeframe that `main.py` writes for the live band. */
export const LIVE_FORECAST_TIMEFRAME = "5s_60s";

export type SavedForecast = { timestamp: string; garch_forecast: number };

const API_BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE ??
  "http://127.0.0.1:8000";
const BINANCE_PAIR = "BTC/USDT";
const LIVE_FORECAST_JSON_URL = `${API_BASE}/forecasts?symbol=${encodeURIComponent(BINANCE_PAIR)}&timeframe=${encodeURIComponent(LIVE_FORECAST_TIMEFRAME)}&newest_first=true&limit=30`;

const marketEl = document.getElementById("market-value");

export let latest10sGarchSigma: number | null = null;
export let latest10sGarchSigmaUpdatedAtMs = 0;

export function refreshLiveForecastRangeLabel(_prices: number[]) {
  // The current HTML doesn’t include a `#live-range` element; keep function for compatibility.
}

export async function loadForecasts10sSigma(prices: number[]): Promise<void> {
  const now = Date.now();
  const tryUrls = [LIVE_FORECAST_JSON_URL, "/forecasts_60s.json"];
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
  } else {
    const top = rows[0];
    const s = top?.garch_forecast;
    latest10sGarchSigma = typeof s === "number" && Number.isFinite(s) ? Math.max(s, 0) : null;
    latest10sGarchSigmaUpdatedAtMs = now;
  }

  if (marketEl) {
    const s = latest10sGarchSigma;
    marketEl.textContent =
      typeof s === "number" && Number.isFinite(s) && s > 0 ? `${(s * 100).toFixed(4)}%` : "—";
  }

  refreshLiveForecastRangeLabel(prices);
}

/** After dropping the oldest price slot when length > MAX_POINTS. */
export function shiftLiveChartAfterRingBufferPop() {
  // No internal ring buffer state in ApexCharts; keep for compatibility.
}

/**
 * Kept for compatibility with the previous “tunnel” renderer; ApexCharts version doesn’t animate tunnels.
 * (App code can still call this safely.)
 */
export function tryActivatePendingTunnel(_prices: number[]) {
  // no-op
}

export function layoutPriceChartCanvas() {
  // ApexCharts handles responsive layout; this is kept for call sites.
}

export function liveRangeColW(_canvasWidth: number, _nPoints: number): number {
  // Previously used for canvas band width; irrelevant for ApexCharts.
  return 3;
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

let liveChart: ApexCharts | null = null;
let liveChartEl: HTMLElement | null = null;
let liveChartReady = false;
let liveYViewMin: number | null = null;
let liveYViewMax: number | null = null;
let liveXCounter = 0;
let lastSeenSpot: number | null = null;

// “Camera follow” + smooth tip animation (line only)
let latestInputSeries: LiveForecastSeries | null = null;
type BandSeg = { x0: number; x1: number; lo: number; hi: number };
let bandSegs: BandSeg[] = [];
let cachedBand: { x: number; y: [number, number] }[] = [];
let lastBandKey: string | null = null;
let bandStartX: number | null = null;
const BAND_FUTURE_SECONDS = 50;
let activeBandLo: number | null = null;
let activeBandHi: number | null = null;

let tipStartPrice: number | null = null;
let tipTargetPrice: number | null = null;
let tipAnimStartMs = 0;
const TIP_ANIM_MS = 6200;
// Crawl: keep newest point off-screen by this many x-steps.
const TIP_X_LAG_STEPS = 1;

let camXMin: number | null = null;
let camXMax: number | null = null;
let camYMin: number | null = null;
let camYMax: number | null = null;
const CAM_LAG = 0.16; // 0..1 (higher = snappier, lower = more lag)

let rafId = 0;

function formatYLabel2(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(2);
}

function ensureLiveChart(): ApexCharts | null {
  if (liveChart && liveChartEl && document.body.contains(liveChartEl)) return liveChart;
  liveChartReady = false;
  liveChart?.destroy();
  liveChart = null;
  liveYViewMin = null;
  liveYViewMax = null;
  liveXCounter = 0;
  lastSeenSpot = null;
  latestInputSeries = null;
  bandSegs = [];
  cachedBand = [];
  lastBandKey = null;
  bandStartX = null;
  activeBandLo = null;
  activeBandHi = null;
  tipStartPrice = null;
  tipTargetPrice = null;
  tipAnimStartMs = 0;
  camXMin = null;
  camXMax = null;
  camYMin = null;
  camYMax = null;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;

  const el = document.getElementById("price-chart");
  if (!el) return null;
  liveChartEl = el;

  const options: ApexCharts.ApexOptions = {
    chart: {
      type: "line",
      height: "100%",
      animations: {
        enabled: false,
      },
      background: "#0d1429",
      toolbar: { show: false },
      zoom: { enabled: false },
      foreColor: "#9eabc9",
    },
    grid: {
      borderColor: "#253055",
      strokeDashArray: 0,
      padding: { left: 8, right: 8, top: 6, bottom: 0 },
    },
    legend: { show: false },
    dataLabels: { enabled: false },
    stroke: { curve: "smooth", width: [2, 2, 2] },
    fill: {
      type: ["solid", "solid", "solid"],
      opacity: [1, 1, 0.18],
    },
    markers: { size: 0 },
    xaxis: {
      type: "numeric",
      labels: { show: false },
      axisBorder: { show: false },
      axisTicks: { show: false },
      tooltip: { enabled: false },
    },
    yaxis: {
      decimalsInFloat: 2,
      labels: {
        formatter: formatYLabel2,
      },
    },
    tooltip: { theme: "dark" },
    series: [
      { name: "Spot (in range)", type: "line", data: [] },
      { name: "Spot (out of range)", type: "line", data: [] },
      { name: "Forecast band", type: "rangeArea", data: [] },
    ],
    colors: ["#5E97F6", "#ff4d4f", "#FFFFFF"],
  };

  liveChart = new ApexCharts(el, options);
  void liveChart.render().then(() => {
    liveChartReady = true;
    if (!rafId) rafId = requestAnimationFrame(tickRaf);
  });

  return liveChart;
}

function safeMinMax(xs: number[]): { min: number; max: number } | null {
  const vals = xs.filter((x) => Number.isFinite(x));
  if (vals.length === 0) return null;
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothStep(t: number): number {
  // 0..1 -> eased 0..1
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function bandKeyFrom(series: LiveForecastSeries): string {
  // Key the band ONLY off forecast refreshes (σ poll), not on every new price tick.
  // This keeps the range visually anchored until a new forecast arrives.
  // Additionally, force a recenter/recompute once per 60 seconds.
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const pending = series.pendingForwardBand;
  const pLow = pending?.low ?? NaN;
  const pHigh = pending?.high ?? NaN;
  const pSigma = pending?.sigma ?? NaN;
  const pAnchor = pending?.anchorPrice ?? NaN;
  return `${minuteBucket}|${Math.round(pAnchor * 100) / 100}|${Math.round(pSigma * 1e10) / 1e10}|${Math.round(pLow * 100) / 100}|${Math.round(pHigh * 100) / 100}`;
}

function tickRaf(nowMs: number) {
  rafId = 0;
  const chart = liveChart;
  if (!chart || !liveChartReady) {
    rafId = requestAnimationFrame(tickRaf);
    return;
  }
  const series = latestInputSeries;
  if (!series || series.prices.length === 0) {
    rafId = requestAnimationFrame(tickRaf);
    return;
  }

  const { prices } = series;
  const newest = prices[prices.length - 1];
  if (!Number.isFinite(newest)) {
    rafId = requestAnimationFrame(tickRaf);
    return;
  }

  // Monotonic x counter advances only when the *actual* newest changes.
  if (lastSeenSpot === null || newest !== lastSeenSpot) {
    liveXCounter += 1;
    lastSeenSpot = newest;
  }
  const xAtIdx = (i: number) => liveXCounter - (prices.length - 1 - i);
  const xHidden = xAtIdx(prices.length - 1);
  const xPrev = prices.length >= 2 ? xAtIdx(prices.length - 2) : xHidden;

  // Animate only the tip price AND its x-position, crawling from prev -> hidden.
  let crawlT = 1;
  if (tipStartPrice !== null && tipTargetPrice !== null && tipAnimStartMs > 0) {
    crawlT = (nowMs - tipAnimStartMs) / TIP_ANIM_MS;
  }
  const t01 = smoothStep(Math.max(0, Math.min(1, crawlT)));
  const tip = prices.length >= 2 ? lerp(prices[prices.length - 2], newest, t01) : newest;
  const tipX = prices.length >= 2 ? lerp(xPrev, xHidden, t01) : xHidden;

  // Build spot series: hide the newest real point; replace with crawling synthetic tip.
  // Then split into 2 series: blue (inside band) and red (outside band).
  const spot: { x: number; y: number }[] = [];
  const lastVisibleIdx = Math.max(0, prices.length - 2);
  for (let i = 0; i <= lastVisibleIdx; i += 1) {
    spot.push({ x: xAtIdx(i), y: prices[i] });
  }
  // Only add a crawling point if we have at least 2 points.
  if (prices.length >= 2) {
    spot.push({ x: tipX, y: tip });
  }

  const bandLo = activeBandLo;
  const bandHi = activeBandHi;
  const bandEndX = bandStartX !== null ? bandStartX + BAND_FUTURE_SECONDS : null;

  const inRangeSeries: { x: number; y: number | null }[] = [];
  const outRangeSeries: { x: number; y: number | null }[] = [];

  const canClassify =
    bandStartX !== null &&
    bandEndX !== null &&
    bandLo !== null &&
    bandHi !== null &&
    Number.isFinite(bandLo) &&
    Number.isFinite(bandHi);
  const lo = canClassify ? Math.min(bandLo as number, bandHi as number) : null;
  const hi = canClassify ? Math.max(bandLo as number, bandHi as number) : null;

  const isInsideAt = (x: number, y: number): boolean => {
    if (!canClassify || lo === null || hi === null) return true;
    // Only colorize within the band’s forward window; outside that, keep blue.
    if (x < (bandStartX as number) || x > (bandEndX as number)) return true;
    return y >= lo && y <= hi;
  };

  // Build two series with "gaps" (nulls), but duplicate the boundary point on transitions
  // so the stroke doesn’t look like it got deleted.
  // IMPORTANT: we compute the *crossing point* on the band edge, so red starts only
  // after crossing the limit (no red inside the band).
  let prevInside: boolean | null = null;
  let prevPoint: { x: number; y: number } | null = null;
  for (const p of spot) {
    const inside = isInsideAt(p.x, p.y);
    if (prevInside !== null && prevPoint !== null && inside !== prevInside) {
      // Glue with a computed crossing point on the band edge (lo/hi).
      // If we can’t compute it robustly, fall back to the previous point.
      const dx = p.x - prevPoint.x;
      const dy = p.y - prevPoint.y;
      let crossX = prevPoint.x;
      let crossY = prevPoint.y;

      if (canClassify && lo !== null && hi !== null && Number.isFinite(dy) && Math.abs(dy) > 1e-12) {
        const prevY = prevPoint.y;
        const currY = p.y;
        // Pick which boundary we crossed: high if moving above, low if moving below.
        const boundary =
          currY > hi || prevY > hi
            ? hi
            : currY < lo || prevY < lo
              ? lo
              : currY >= prevY
                ? hi
                : lo;
        const t = (boundary - prevY) / (currY - prevY); // can be outside [0,1] if noisy; clamp
        const t01 = Math.max(0, Math.min(1, t));
        crossX = prevPoint.x + dx * t01;
        crossY = boundary;
      }

      if (inside) {
        // outside -> inside: red ends at boundary, blue starts at boundary
        outRangeSeries.push({ x: crossX, y: crossY });
        inRangeSeries.push({ x: crossX, y: crossY });
      } else {
        // inside -> outside: blue ends at boundary, red starts at boundary
        inRangeSeries.push({ x: crossX, y: crossY });
        outRangeSeries.push({ x: crossX, y: crossY });
      }
    }

    inRangeSeries.push({ x: p.x, y: inside ? p.y : null });
    outRangeSeries.push({ x: p.x, y: inside ? null : p.y });
    prevInside = inside;
    prevPoint = p;
  }

  // Camera follow: keep the hidden newest off-screen by TIP_X_LAG_STEPS.
  // The window max follows the crawling point, not the hidden one.
  const windowW = MAX_POINTS + 2;
  const halfW = windowW / 2;
  // Center the tip horizontally.
  let targetXMin = tipX - halfW;
  let targetXMax = tipX + halfW;
  // Clamp at 0 so early startup doesn't go negative.
  if (targetXMin < 0) {
    targetXMax -= targetXMin;
    targetXMin = 0;
  }
  camXMin = camXMin === null ? targetXMin : lerp(camXMin, targetXMin, CAM_LAG);
  camXMax = camXMax === null ? targetXMax : lerp(camXMax, targetXMax, CAM_LAG);

  // Y camera: center around tip, span based on latest band width (or recent range).
  const bandYs: number[] = [];
  for (const b of cachedBand) bandYs.push(b.y[0], b.y[1]);
  const mmBand = safeMinMax(bandYs);
  const mmSpot = safeMinMax(prices);
  let span = 1.0;
  if (mmBand) span = Math.max(span, (mmBand.max - mmBand.min) * 0.7);
  if (mmSpot) span = Math.max(span, (mmSpot.max - mmSpot.min) * 0.9);
  span = Math.max(span, Math.max(Math.abs(tip) * 0.0025, 10)); // avoid tiny/flat view
  const targetYMin = tip - span;
  const targetYMax = tip + span;
  camYMin = camYMin === null ? targetYMin : lerp(camYMin, targetYMin, CAM_LAG);
  camYMax = camYMax === null ? targetYMax : lerp(camYMax, targetYMax, CAM_LAG);

  void chart.updateOptions(
    {
      xaxis: { min: camXMin, max: camXMax },
      // Keep label formatter when updating min/max (Apex replaces yaxis config).
      yaxis: {
        min: camYMin,
        max: camYMax,
        decimalsInFloat: 2,
        labels: { formatter: formatYLabel2 },
      },
    },
    false,
    false,
  );

  // Update only the LINE series (band is static and updated on draw calls).
  void chart.updateSeries(
    [
      { name: "Spot (in range)", type: "line", data: inRangeSeries },
      { name: "Spot (out of range)", type: "line", data: outRangeSeries },
      { name: "Forecast band", type: "rangeArea", data: cachedBand },
    ],
    false,
  );

  rafId = requestAnimationFrame(tickRaf);
}

export function drawLiveForecastChart(getSeries: () => LiveForecastSeries) {
  const chart = ensureLiveChart();
  if (!chart || !liveChartReady) return;

  const { prices, pendingForwardBand } = getSeries();
  if (prices.length === 0) return;

  const snapshot = getSeries();
  latestInputSeries = snapshot;

  // Use a monotonic x-axis so the ring-buffer shift doesn't “teleport” the chart.
  const newest = prices.length > 0 ? prices[prices.length - 1] : null;
  // Update forecast band only when inputs change (no animation).
  const nextBandKey = bandKeyFrom(snapshot);
  if (nextBandKey !== lastBandKey) {
    lastBandKey = nextBandKey;

    // Forward range: from the moment the forecast is loaded, project BAND_FUTURE_SECONDS ahead.
    // IMPORTANT: we do not advance liveXCounter here; RAF tick does that on real price changes.
    if (
      pendingForwardBand &&
      Number.isFinite(pendingForwardBand.low) &&
      Number.isFinite(pendingForwardBand.high)
    ) {
      const newStartX = liveXCounter;
      const lo = Math.min(pendingForwardBand.low, pendingForwardBand.high);
      const hi = Math.max(pendingForwardBand.low, pendingForwardBand.high);

      // Keep the previous (active) band visible up to the new band's start.
      if (
        bandStartX !== null &&
        activeBandLo !== null &&
        activeBandHi !== null &&
        newStartX > bandStartX
      ) {
        bandSegs.push({
          x0: bandStartX,
          x1: newStartX,
          lo: Math.min(activeBandLo, activeBandHi),
          hi: Math.max(activeBandLo, activeBandHi),
        });
      }

      // Start the new active band.
      bandStartX = newStartX;
      activeBandLo = lo;
      activeBandHi = hi;

      // Cap number of historical segments so we don't grow forever.
      if (bandSegs.length > 6) bandSegs = bandSegs.slice(bandSegs.length - 6);

      // Materialize to rangeArea points; insert a gap between segments.
      const segs: BandSeg[] = [
        ...bandSegs,
        { x0: bandStartX, x1: bandStartX + BAND_FUTURE_SECONDS, lo, hi },
      ];
      const out: { x: number; y: [number, number] }[] = [];
      for (const s of segs) {
        out.push({ x: s.x0, y: [s.lo, s.hi] });
        out.push({ x: s.x1, y: [s.lo, s.hi] });
        out.push({ x: s.x1, y: [null as unknown as number, null as unknown as number] });
      }
      cachedBand = out;
    } else {
      bandStartX = null;
      activeBandLo = null;
      activeBandHi = null;
      bandSegs = [];
      cachedBand = [];
    }
  }

  // Start/retarget the tip animation when the newest observed spot changes.
  if (newest !== null && Number.isFinite(newest)) {
    const nowMs = performance.now();
    if (tipTargetPrice === null) {
      tipStartPrice = newest;
      tipTargetPrice = newest;
      tipAnimStartMs = nowMs;
    } else if (newest !== tipTargetPrice) {
      // Retarget smoothly from the current animated tip.
      let tipNow = tipTargetPrice;
      if (snapshot.prices.length >= 2) {
        const prev = snapshot.prices[snapshot.prices.length - 2];
        const t = (nowMs - tipAnimStartMs) / TIP_ANIM_MS;
        const t01 = smoothStep(Math.max(0, Math.min(1, t)));
        tipNow = lerp(prev, tipTargetPrice, t01);
      }
      tipStartPrice = tipNow;
      tipTargetPrice = newest;
      tipAnimStartMs = nowMs;
    }
  }
}
