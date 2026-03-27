import type { SavedForecast } from "./liveForecast10sChart";

/** Pixel height for 7d chart canvas (must match layout). */
const MAIN_CHART_HEIGHT = 320;

/** GARCH ±σ columns, vertical range ticks, and forecast spokes (matches legend). */
const CHART_RANGE = "#FFFFFF";
/** Price path (7d line). */
const CHART_PRICE_LINE = "#5E97F6";
/** Square/circle markers on price and range bounds. */
const CHART_DOT_7D = CHART_PRICE_LINE;

const canvas7d = document.getElementById("chart-7d") as HTMLCanvasElement | null;
const ctx7d = canvas7d?.getContext("2d") ?? null;
const chart7dLowEl = document.getElementById("chart-7d-low");
const chart7dHighEl = document.getElementById("chart-7d-high");

export type DailyPoint = { open_time: number; close: number | null; label?: string };

const MS_PER_DAY = 86_400_000;

export function dailyPointsFromApi(apiPoints: { open_time: number; close: number }[]): DailyPoint[] {
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
function lineStartAfterDot(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  dotRadius: number,
): [number, number] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [x0, y0];
  const t = Math.min((dotRadius + 1) / len, 1);
  return [x0 + dx * t, y0 + dy * t];
}

export function dateKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function splitForecastRows(forecasts: SavedForecast[]): {
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

export function layoutChart7dCanvas() {
  if (!canvas7d) return;
  const panel = canvas7d.closest(".chart-panel");
  const raw = panel ? panel.clientWidth - 8 : canvas7d.clientWidth || 720;
  const w = Math.max(260, Math.min(Math.floor(raw), 1600));
  canvas7d.width = w;
  canvas7d.height = MAIN_CHART_HEIGHT;
}

export function drawSevenDayChart(points: DailyPoint[], lastSavedForecasts: SavedForecast[]) {
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
