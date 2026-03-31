import ApexCharts from "apexcharts";
import type { ApexAxisChartSeries } from "apexcharts";
import type { SavedForecast } from "./forecastTypes";

export type HourlyPoint = { open_time: number; close: number | null };

const MS_PER_HOUR = 3_600_000;

export function hourlyPointsFromApi(apiPoints: { open_time: number; close: number }[]): HourlyPoint[] {
  const normalized = [...apiPoints]
    .sort((a, b) => a.open_time - b.open_time)
    .map((p) => ({ open_time: p.open_time, close: Number.isFinite(p.close) ? p.close : null }));
  if (normalized.length === 0) return normalized;
  const last = normalized[normalized.length - 1];
  // Add one synthetic "future" slot so the latest tunnel can project ahead.
  return [...normalized, { open_time: last.open_time + MS_PER_HOUR, close: null }];
}

export function hourKeyUtc(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}`;
}

export function layoutChart1hCanvas() {
  // ApexCharts handles responsive layout; kept for call sites.
}

let chart1h: ApexCharts | null = null;
let chart1hEl: HTMLElement | null = null;
let chart1hReady = false;
let pendingDraw: { points: HourlyPoint[]; forecasts: SavedForecast[] } | null = null;

export function resizeOneHourChart() {
  if (!chart1h || !chart1hReady) return;
  const anyChart = chart1h as unknown as { resize?: () => void };
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

function formatHourLocalShort(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  const month = d.toLocaleString(undefined, { month: "short" });
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  return `${month} ${day} ${hour}:00`;
}

function localTimeZoneAbbrev(ms: number): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZoneName: "short",
    }).formatToParts(new Date(ms));
    const tz = parts.find((p) => p.type === "timeZoneName")?.value;
    return tz && tz.trim().length > 0 ? tz : "local";
  } catch {
    return "local";
  }
}

function isSameLocalHour(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours()
  );
}

function closeSeriesIndexFromConfig(w: any): number {
  const series = w?.config?.series;
  if (!Array.isArray(series)) return 0;
  const byName = series.findIndex((s: any) => String(s?.name ?? "").toLowerCase() === "close");
  if (byName >= 0) return byName;
  return Math.max(0, series.length - 1);
}

function safeMinMax(nums: number[]): { min: number; max: number } | null {
  const xs = nums.filter((n) => Number.isFinite(n));
  if (xs.length === 0) return null;
  return { min: Math.min(...xs), max: Math.max(...xs) };
}

function ensure1hChart(): ApexCharts | null {
  if (chart1h && chart1hEl && document.body.contains(chart1hEl)) return chart1h;
  chart1hReady = false;
  chart1h?.destroy();
  chart1h = null;

  const el = document.getElementById("chart-1h");
  if (!el) return null;
  chart1hEl = el;

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
    // Keep marker styling consistent from first render to avoid startup flicker/races.
    markers: {
      size: 4,
      strokeColors: "#FFFFFF",
      strokeWidth: 2,
      hover: { size: 6 },
      discrete: [],
    },
    xaxis: {
      type: "datetime",
      labels: { datetimeUTC: false },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    yaxis: [{ decimalsInFloat: 2, labels: { formatter: formatYLabel2 } }],
    tooltip: {
      theme: "dark",
      // Snap by x-position so hovering above/below a close point still shows the box.
      shared: false,
      intersect: false,
      followCursor: false,
      custom: ({ seriesIndex, dataPointIndex, w }: any) => {
        const closeSeriesIndex = closeSeriesIndexFromConfig(w);
        if (seriesIndex !== closeSeriesIndex || dataPointIndex < 0) return "";
        const pt = w?.config?.series?.[closeSeriesIndex]?.data?.[dataPointIndex];
        const close =
          Number.isFinite(Number(pt?.x)) && Number.isFinite(Number(pt?.y))
            ? { x: Number(pt.x), y: Number(pt.y) }
            : null;
        const dateLabel = close ? `${formatHourLocalShort(close.x)} (${localTimeZoneAbbrev(close.x)})` : "";
        const closeLabel = close ? close.y.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—";
        const valueLabel = close && isSameLocalHour(close.x, Date.now()) ? "Current hour price: " : "Close: ";
        return `
          <div class="apexcharts-tooltip-title">${dateLabel}</div>
          <div class="apexcharts-tooltip-series-group apexcharts-active" style="display:flex;">
            <span class="apexcharts-tooltip-marker" style="background-color:#5E97F6;"></span>
            <div class="apexcharts-tooltip-text">
              <div class="apexcharts-tooltip-y-group">
                <span class="apexcharts-tooltip-text-y-label">${valueLabel}</span>
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

  chart1h = new ApexCharts(el, options);
  void chart1h.render().then(() => {
    chart1hReady = true;
    const p = pendingDraw;
    if (p) {
      pendingDraw = null;
      requestAnimationFrame(() => drawOneHourChart(p.points, p.forecasts));
    }
  });
  return chart1h;
}

type BandBox = { x0: number; x1: number; lo: number; hi: number; deltaToLatest: number | null };

function buildBandBoxes(points: HourlyPoint[], forecasts: SavedForecast[]): BandBox[] {
  if (forecasts.length === 0 || points.length < 2) return [];
  const byHourLatest = new Map<string, SavedForecast>();
  const sortedAll = [...forecasts].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const row of sortedAll) {
    const ts = Date.parse(row.timestamp);
    if (!Number.isFinite(ts)) continue;
    // Asc order + overwrite => keep latest forecast within each hour bucket.
    byHourLatest.set(hourKeyUtc(ts), row);
  }
  const sortedRows = [...byHourLatest.values()]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .slice(-24);
  const boxes: BandBox[] = [];
  const realPoints = points.filter((p) => p.close !== null && Number.isFinite(p.close));
  if (realPoints.length === 0) return [];
  const sortedReal = [...realPoints].sort((a, b) => a.open_time - b.open_time);

  // Anchor each forecast to the most recent available candle at or before its timestamp.
  // This keeps bands pinned to the expected point even when forecasts are emitted at HH:05, HH:10, etc.
  const anchorAtOrBefore = (ts: number): HourlyPoint | null => {
    let lo = 0;
    let hi = sortedReal.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = sortedReal[mid].open_time;
      if (v <= ts) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best >= 0 ? sortedReal[best] : null;
  };

  for (let i = 0; i < sortedRows.length; i += 1) {
    const fp = sortedRows[i];
    const ts = Date.parse(fp.timestamp);
    if (!Number.isFinite(ts)) continue;
    const isLatest = i === sortedRows.length - 1;
    let x0: number;
    let x1: number;
    let baseClose: number;

    if (isLatest) {
      const lastReal = sortedReal[sortedReal.length - 1];
      if (!lastReal || !Number.isFinite(lastReal.open_time) || !Number.isFinite(lastReal.close as number)) continue;
      // Place latest forecast on the last real slot (same behavior as before).
      x0 = lastReal.open_time;
      x1 = x0 + MS_PER_HOUR;
      baseClose = lastReal.close as number;
    } else {
      const anchor = anchorAtOrBefore(ts);
      if (!anchor) continue;
      x0 = anchor.open_time;
      x1 = x0 + MS_PER_HOUR;
      baseClose = anchor.close as number;
    }

    if (!Number.isFinite(baseClose)) continue;
    const sigma = Math.max(Number(fp.garch_forecast), 0);
    if (!Number.isFinite(sigma)) continue;
    boxes.push({
      x0,
      x1,
      lo: baseClose * (1 - sigma),
      hi: baseClose * (1 + sigma),
      deltaToLatest:
        fp.delta_to_latest === null || fp.delta_to_latest === undefined
          ? null
          : Number.isFinite(Number(fp.delta_to_latest))
            ? Number(fp.delta_to_latest)
            : null,
    });
  }
  return boxes;
}

export function drawOneHourChart(points: HourlyPoint[], forecasts: SavedForecast[]) {
  const chart = ensure1hChart();
  if (!chart) return;
  if (!chart1hReady) {
    pendingDraw = { points, forecasts };
    return;
  }

  const visiblePoints = points.slice(-12);

  const closes = visiblePoints
    .filter((p) => p.close !== null && Number.isFinite(p.close))
    .map((p) => ({ x: p.open_time, y: p.close as number }))
    .sort((a, b) => a.x - b.x);

  const boxes = buildBandBoxes(visiblePoints, forecasts);

  const xCandidates: number[] = [];
  for (const p of visiblePoints) if (Number.isFinite(p.open_time)) xCandidates.push(p.open_time);
  for (const c of closes) if (Number.isFinite(c.x)) xCandidates.push(c.x);
  for (const b of boxes) {
    if (Number.isFinite(b.x0)) xCandidates.push(b.x0);
    if (Number.isFinite(b.x1)) xCandidates.push(b.x1);
  }
  let xMin = xCandidates.length > 0 ? Math.min(...xCandidates) : undefined;
  let xMax = xCandidates.length > 0 ? Math.max(...xCandidates) : undefined;
  // Always keep one full future empty slot after the latest close.
  const lastCloseX = closes.length > 0 ? closes[closes.length - 1].x : undefined;
  if (lastCloseX !== undefined) {
    const fullFutureSlotEnd = lastCloseX + MS_PER_HOUR;
    xMax = xMax === undefined ? fullFutureSlotEnd : Math.max(xMax, fullFutureSlotEnd);
  }
  if (xMin !== undefined && xMax !== undefined && xMax > xMin) {
    const padX = Math.max((xMax - xMin) * 0.01, MS_PER_HOUR * 0.03);
    xMin -= padX;
    xMax += padX;
  }

  const yCandidates: number[] = closes.map((c) => c.y);
  for (const b of boxes) yCandidates.push(b.lo, b.hi);
  const mm = safeMinMax(yCandidates);
  const yBounds = (() => {
    if (!mm) return null;
    const span = Math.max(mm.max - mm.min, Math.abs(mm.max) * 0.0008, 1);
    const pad = Math.max(span * 0.06, 6);
    return { min: mm.min - pad - 1_500, max: mm.max + pad };
  })();

  const series: ApexAxisChartSeries = [];
  boxes.forEach((b, i) => {
    const d = Number(b.deltaToLatest);
    const deltaLabel = Number.isFinite(d) ? ` · Δlatest ${(d * 100).toFixed(4)}%` : "";
    series.push({
      name: `Band ${i + 1}${deltaLabel}`,
      type: "rangeArea",
      data: [
        { x: b.x0, y: [b.lo, b.hi] },
        { x: b.x1, y: [b.lo, b.hi] },
      ],
    } as any);
  });
  // Draw close line/points LAST so they stay above forecast bands.
  series.push({ name: "Close", type: "line", data: closes } as any);
  const closeSeriesIndex = Math.max(0, series.length - 1);

  const colors = [...boxes.map(() => "#FFFFFF"), "#5E97F6"];
  const strokeWidths = [...boxes.map(() => 1), 2];
  const fillOpacities = [...boxes.map(() => 0.14), 1];
  // Show only the latest 12 marker dots.
  const markerStart = Math.max(0, closes.length - 12);
  const markerIndices = Array.from({ length: closes.length - markerStart }, (_, k) => markerStart + k);
  const closeMarkers = markerIndices.map((i) => ({
    seriesIndex: closeSeriesIndex,
    dataPointIndex: i,
    size: 5,
    fillColor: "#5E97F6",
    strokeColor: "#FFFFFF",
    strokeWidth: 2,
    shape: "circle",
  }));

  const nextOptions: ApexCharts.ApexOptions = {
    colors,
    stroke: { curve: "straight", width: strokeWidths },
    fill: { type: "solid", opacity: fillOpacities },
    markers: {
      size: 0,
      strokeColors: "#FFFFFF",
      strokeWidth: 2,
      hover: { size: 7 },
      discrete: closeMarkers as any,
    },
    tooltip: {
      shared: false,
      intersect: false,
      followCursor: false,
      enabledOnSeries: [closeSeriesIndex],
    },
    xaxis: {
      min: xMin,
      max: xMax,
      type: "datetime",
      labels: { datetimeUTC: false },
      axisBorder: { show: false },
      axisTicks: { show: false },
    },
    yaxis: yBounds
      ? [
          {
            min: yBounds.min,
            max: yBounds.max,
            decimalsInFloat: 2,
            forceNiceScale: false,
            labels: { formatter: formatYLabel2 },
          },
        ]
      : [{ decimalsInFloat: 2, labels: { formatter: formatYLabel2 } }],
  };

  // Final marker pass: re-apply dots after full series/options render so they
  // reliably appear on first load even if Apex drops early marker paints.
  const finalMarkerOptions: ApexCharts.ApexOptions = {
    markers: {
      size: 0,
      strokeColors: "#FFFFFF",
      strokeWidth: 2,
      hover: { size: 7 },
      discrete: closeMarkers as any,
    },
  };

  void chart
    .updateSeries(series as any, false)
    .then(() => chart.updateOptions(nextOptions, true, false))
    .then(() => chart.updateOptions(finalMarkerOptions, false, false));
}
