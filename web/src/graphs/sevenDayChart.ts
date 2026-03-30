import ApexCharts from "apexcharts";
import type { ApexAxisChartSeries } from "apexcharts";
import type { SavedForecast } from "./liveForecast10sChart";

export type DailyPoint = { open_time: number; close: number | null; label?: string };

const chart7dLowEl = document.getElementById("chart-7d-low");
const chart7dHighEl = document.getElementById("chart-7d-high");

const MS_PER_DAY = 86_400_000;

export function dailyPointsFromApi(apiPoints: { open_time: number; close: number }[]): DailyPoint[] {
  if (apiPoints.length === 0) return [];
  const sorted = [...apiPoints].sort((a, b) => a.open_time - b.open_time);
  const normalized: DailyPoint[] = sorted.map((p) => ({
    open_time: p.open_time,
    close: p.close,
  }));
  const last = sorted[sorted.length - 1];
  const tTomorrow = last.open_time + MS_PER_DAY;
  const d = new Date(tTomorrow);
  const label = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return [...normalized, { open_time: tTomorrow, close: null, label }];
}

export function dateKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function splitForecastRows(forecasts: SavedForecast[]): {
  latest: SavedForecast | null;
  historicalMidnights: SavedForecast[];
} {
  if (forecasts.length === 0) return { latest: null, historicalMidnights: [] };
  const sorted = [...forecasts].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const latest = sorted[sorted.length - 1];
  const midnightRows = sorted.filter((f) => {
    const t = new Date(f.timestamp);
    return t.getUTCHours() === 0 && t.getUTCMinutes() === 0 && t.getUTCSeconds() === 0;
  });
  const historicalMidnights = midnightRows.length >= 3 ? midnightRows.slice(-3) : midnightRows.slice();
  return { latest, historicalMidnights };
}

export function layoutChart7dCanvas() {
  // ApexCharts is responsive; kept for call sites.
}

let chart7d: ApexCharts | null = null;
let chart7dEl: HTMLElement | null = null;
let chart7dReady = false;
let pendingDraw: { points: DailyPoint[]; forecasts: SavedForecast[] } | null = null;

export function resizeSevenDayChart() {
  if (!chart7d || !chart7dReady) return;
  const anyChart = chart7d as unknown as { resize?: () => void };
  try {
    anyChart.resize?.();
  } catch {
    // ignore
  }
}

function formatYLabel2(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toFixed(2);
}

function formatDateUtcShort(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const month = d.toLocaleString(undefined, { month: "short", timeZone: "UTC" });
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${month} ${day} (UTC)`;
}

function nearestCloseFromSeries(w: any, x: number): { x: number; y: number } | null {
  const s0 = w?.config?.series?.[0]?.data;
  if (!Array.isArray(s0) || s0.length === 0) return null;
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  for (const pt of s0) {
    const px = typeof pt?.x === "number" ? pt.x : Number(pt?.x);
    const py = typeof pt?.y === "number" ? pt.y : Number(pt?.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    const d = Math.abs(px - x);
    if (d < bestDist) {
      bestDist = d;
      best = { x: px, y: py };
    }
  }
  return best;
}

function safeMinMax(nums: number[]): { min: number; max: number } | null {
  const xs = nums.filter((n) => Number.isFinite(n));
  if (xs.length === 0) return null;
  return { min: Math.min(...xs), max: Math.max(...xs) };
}

function ensure7dChart(): ApexCharts | null {
  if (chart7d && chart7dEl && document.body.contains(chart7dEl)) return chart7d;
  chart7dReady = false;
  chart7d?.destroy();
  chart7d = null;

  const el = document.getElementById("chart-7d");
  if (!el) return null;
  chart7dEl = el;

  const options: ApexCharts.ApexOptions = {
    chart: {
      type: "line",
      height: "100%",
      animations: { enabled: false },
      background: "#0d1429",
      toolbar: { show: false },
      zoom: { enabled: false },
      foreColor: "#9eabc9",
    },
    grid: {
      borderColor: "#253055",
      padding: { left: 8, right: 8, top: 6, bottom: 6 },
    },
    legend: { show: false },
    dataLabels: { enabled: false },
    markers: {
      size: 3,
      strokeWidth: 0,
      hover: { size: 5 },
    },
    xaxis: {
      type: "datetime",
      labels: { datetimeUTC: true },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    // Use array form to match later updates.
    yaxis: [
      {
        decimalsInFloat: 2,
        tickAmount: 9,
        labels: { formatter: formatYLabel2 },
      },
    ],
    tooltip: {
      theme: "dark",
      custom: ({ seriesIndex, dataPointIndex, w }: any) => {
        const sx = w?.globals?.seriesX?.[seriesIndex]?.[dataPointIndex];
        const x = typeof sx === "number" ? sx : Number(sx);
        const close = Number.isFinite(x) ? nearestCloseFromSeries(w, x) : null;
        const dateLabel = close ? formatDateUtcShort(close.x) : Number.isFinite(x) ? formatDateUtcShort(x) : "";
        const closeLabel = close ? close.y.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";
        return `
          <div class="apexcharts-tooltip-title">${dateLabel}</div>
          <div class="apexcharts-tooltip-series-group apexcharts-active" style="display:flex;">
            <span class="apexcharts-tooltip-marker" style="background-color:#5E97F6;"></span>
            <div class="apexcharts-tooltip-text">
              <div class="apexcharts-tooltip-y-group">
                <span class="apexcharts-tooltip-text-y-label">Close: </span>
                <span class="apexcharts-tooltip-text-y-value">${closeLabel}</span>
              </div>
            </div>
          </div>
        `;
      },
    },
    stroke: { curve: "straight", width: 2 },
    fill: { type: "solid", opacity: 1 },
    series: [],
  };

  chart7d = new ApexCharts(el, options);
  void chart7d.render().then(() => {
    chart7dReady = true;
    const p = pendingDraw;
    if (p) {
      pendingDraw = null;
      // Draw on next frame so layout is stable.
      requestAnimationFrame(() => drawSevenDayChart(p.points, p.forecasts));
    }
  });
  return chart7d;
}

type BandBox = { x0: number; x1: number; lo: number; hi: number; startLo: number; startHi: number };

function buildBandBoxes(points: DailyPoint[], forecasts: SavedForecast[]): BandBox[] {
  if (forecasts.length === 0 || points.length === 0) return [];
  const { latest, historicalMidnights } = splitForecastRows(forecasts);
  const boxes: BandBox[] = [];

  const push = (x0: number, x1: number, low: number, high: number, startLow?: number, startHigh?: number) => {
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || !Number.isFinite(low) || !Number.isFinite(high)) return;
    const lo = Math.min(low, high);
    const hi = Math.max(low, high);
    const sLo = startLow !== undefined && Number.isFinite(startLow) ? startLow : lo;
    const sHi = startHigh !== undefined && Number.isFinite(startHigh) ? startHigh : hi;
    boxes.push({ x0, x1, lo, hi, startLo: sLo, startHi: sHi });
  };

  for (const fp of historicalMidnights) {
    const ts = Date.parse(fp.timestamp);
    if (!Number.isFinite(ts)) continue;
    const k = dateKeyUtc(ts);
    const idx = points.findIndex((p) => p.close !== null && dateKeyUtc(p.open_time) === k);
    // Forecast at day D 00:00 applies to day D move, anchored on day D-1 close.
    if (idx <= 0) continue;
    const baseClose = points[idx - 1].close as number;
    if (!Number.isFinite(baseClose)) continue;
    const sigma = Math.max(fp.garch_forecast, 0);
    // Historical: keep as a day-sized box on day D.
    push(points[idx].open_time, points[idx].open_time + MS_PER_DAY, baseClose * (1 - sigma), baseClose * (1 + sigma));
  }

  // Latest/current forecast: prefer to place it on the last real day slot (today),
  // anchored on yesterday's close. If we can't match it to a real day, fall back
  // to the synthetic "tomorrow" slot.
  if (latest) {
    const ts = Date.parse(latest.timestamp);
    const k = Number.isFinite(ts) ? dateKeyUtc(ts) : null;
    const idx = k ? points.findIndex((p) => p.close !== null && dateKeyUtc(p.open_time) === k) : -1;
    if (idx > 0) {
      const baseClose = points[idx - 1].close as number;
      if (Number.isFinite(baseClose)) {
        const sigma = Math.max(latest.garch_forecast, 0);
        // Latest (today): draw a forward "tunnel" centered on *yesterday's close*,
        // spanning the previous slot (yesterday) through the next slot (tomorrow).
        const x0 = points[idx - 1].open_time;
        const x1 = points[idx].open_time + MS_PER_DAY;
        push(x0, x1, baseClose * (1 - sigma), baseClose * (1 + sigma), baseClose * (1 - sigma), baseClose * (1 + sigma));
      }
    } else {
      const futureIdx = points.findIndex((p) => p.close === null);
      const lastReal = [...points].reverse().find((p) => p.close !== null)?.close ?? null;
      if (futureIdx >= 0 && lastReal !== null && Number.isFinite(lastReal)) {
        const sigma = Math.max(latest.garch_forecast, 0);
        // Fallback: if we can't match "today", place a day-sized box at the future slot.
        push(
          points[futureIdx].open_time,
          points[futureIdx].open_time + MS_PER_DAY,
          lastReal * (1 - sigma),
          lastReal * (1 + sigma),
        );
      }
    }
  }

  return boxes;
}

export function drawSevenDayChart(points: DailyPoint[], lastSavedForecasts: SavedForecast[]) {
  const chart = ensure7dChart();
  if (!chart) return;
  if (!chart7dReady) {
    pendingDraw = { points, forecasts: lastSavedForecasts };
    return;
  }

  const closes = points
    .filter((p) => p.close !== null && Number.isFinite(p.close))
    .map((p) => ({ x: p.open_time, y: p.close as number }))
    .sort((a, b) => a.x - b.x);

  const boxes = buildBandBoxes(points, lastSavedForecasts);

  const lastCloseMarker =
    closes.length > 0
      ? [
          {
            seriesIndex: 0,
            dataPointIndex: closes.length - 1,
            size: 6,
            fillColor: "#5E97F6",
            strokeColor: "#FFFFFF",
            strokeWidth: 2,
            shape: "circle",
          },
        ]
      : [];

  // "Camera" framing: show the entire 7d window (including the full last day),
  // and include any forecast-band boxes.
  const xCandidates: number[] = [];
  for (const p of points) if (Number.isFinite(p.open_time)) xCandidates.push(p.open_time);
  for (const c of closes) if (Number.isFinite(c.x)) xCandidates.push(c.x);
  for (const b of boxes) {
    if (Number.isFinite(b.x0)) xCandidates.push(b.x0);
    if (Number.isFinite(b.x1)) xCandidates.push(b.x1);
  }

  let xMin = xCandidates.length > 0 ? Math.min(...xCandidates) : undefined;
  let xMax = xCandidates.length > 0 ? Math.max(...xCandidates) : undefined;

  // If the max x corresponds to a day open, extend to end-of-day so the last day is fully visible.
  if (xMax !== undefined) xMax += MS_PER_DAY;

  // Small padding so the first/last day isn't flush against the frame.
  if (xMin !== undefined && xMax !== undefined && xMax > xMin) {
    const padX = Math.max((xMax - xMin) * 0.02, MS_PER_DAY * 0.05);
    xMin -= padX;
    xMax += padX;
  }

  // Y scale: fit the entire plotted graph in the camera view (closes + ALL band boxes).
  const closeYs = closes.map((c) => c.y);
  const yCandidates: number[] = [...closeYs];
  for (const b of boxes) yCandidates.push(b.lo, b.hi);
  const mm = safeMinMax(yCandidates);

  // Build series: one close line + ONE rangeArea series per band box.
  const series: ApexAxisChartSeries = [];
  series.push({ name: "Close", type: "line", data: closes } as any);
  boxes.forEach((b, i) => {
    series.push(
      {
        name: `Band ${i + 1}`,
        type: "rangeArea",
        data: [
          { x: b.x0, y: [b.startLo, b.startHi] },
          { x: b.x1, y: [b.lo, b.hi] },
        ],
      } as any,
    );
  });

  const colors = ["#5E97F6", ...boxes.map(() => "#FFFFFF")];
  const strokeWidths = [2, ...boxes.map(() => 1)];
  const fillOpacities = [1, ...boxes.map(() => 0.14)];

  if (mm) {
    // Hard "camera" range requested: show the full 53k..73k window.
    // If data exceeds that window, expand to include everything.
    const targetMin = 53_000;
    const targetMax = 73_000;
    const yMin = Math.min(targetMin, mm.min);
    const yMax = Math.max(targetMax, mm.max);
    if (chart7dLowEl) chart7dLowEl.textContent = yMin.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (chart7dHighEl) chart7dHighEl.textContent = yMax.toLocaleString(undefined, { maximumFractionDigits: 0 });
    void chart.updateOptions(
      {
        colors,
        stroke: { curve: "straight", width: strokeWidths },
        fill: { type: "solid", opacity: fillOpacities },
        markers: {
          size: 3,
          strokeWidth: 0,
          hover: { size: 5 },
          discrete: lastCloseMarker as any,
        },
        xaxis: {
          min: xMin,
          max: xMax,
          type: "datetime",
          labels: { datetimeUTC: true },
          axisBorder: { show: false },
          axisTicks: { show: false },
        },
        // Use array form so Apex applies bounds reliably with multi-series.
        yaxis: [
          {
            min: yMin,
            max: yMax,
            decimalsInFloat: 2,
            tickAmount: 9,
            forceNiceScale: false,
            labels: { formatter: formatYLabel2 },
          },
        ],
      },
      true,
      false,
    );
  } else {
    if (chart7dLowEl) chart7dLowEl.textContent = "—";
    if (chart7dHighEl) chart7dHighEl.textContent = "—";
    void chart.updateOptions(
      {
        colors,
        stroke: { curve: "straight", width: strokeWidths },
        fill: { type: "solid", opacity: fillOpacities },
        markers: {
          size: 3,
          strokeWidth: 0,
          hover: { size: 5 },
          discrete: lastCloseMarker as any,
        },
        xaxis: {
          min: xMin,
          max: xMax,
          type: "datetime",
          labels: { datetimeUTC: true },
          axisBorder: { show: false },
          axisTicks: { show: false },
        },
        yaxis: [
          {
            decimalsInFloat: 2,
            labels: { formatter: formatYLabel2 },
          },
        ],
      },
      true,
      false,
    );
  }

  void chart.updateSeries(series as any, false);
}
