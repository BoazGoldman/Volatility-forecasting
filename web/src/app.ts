type TickMessage = {
  symbol?: string;
  close?: string;
  close_time?: number;
  is_closed?: boolean;
  error?: string;
};

export {};

declare global {
  interface Window {
    __WS_URL__?: string;
    __API_BASE__?: string;
  }
}

const MAX_POINTS = 120;
const prices: number[] = [];
const WS_URL = window.__WS_URL__ ?? "ws://localhost:8000/ws";
const API_BASE = (window.__API_BASE__ ?? "http://localhost:8000").replace(/\/$/, "");

const listEl = document.getElementById("signal-list") as HTMLUListElement | null;
const wsStatusEl = document.getElementById("ws-status");
const lastPriceEl = document.getElementById("last-price");
const lastRefreshEl = document.getElementById("last-refresh");
const marketEl = document.getElementById("market-value");
const canvas = document.getElementById("price-chart") as HTMLCanvasElement | null;
const ctx = canvas?.getContext("2d") ?? null;
const canvas7d = document.getElementById("chart-7d") as HTMLCanvasElement | null;
const ctx7d = canvas7d?.getContext("2d") ?? null;
const rest7dStatusEl = document.getElementById("rest-7d-status");

/** `close: null` = future slot (prediction placeholder, no line yet). */
type DailyPoint = { open_time: number; close: number | null; label?: string };
type SevenDayResponse = {
  symbol?: string;
  points?: { open_time: number; close: number }[];
  error?: string;
};

const MS_PER_DAY = 86_400_000;

function withPredictionSlots(apiPoints: { open_time: number; close: number }[]): DailyPoint[] {
  if (apiPoints.length === 0) return [];
  const normalized: DailyPoint[] = apiPoints.map((p) => ({
    open_time: p.open_time,
    close: p.close,
  }));
  const last = apiPoints[apiPoints.length - 1];
  const tTomorrow = last.open_time + MS_PER_DAY;
  const tDayAfter = last.open_time + 2 * MS_PER_DAY;
  return [
    ...normalized,
    { open_time: tTomorrow, close: null, label: "T+1" },
    { open_time: tDayAfter, close: null, label: "T+2" },
  ];
}

let lastSevenDayDisplay: DailyPoint[] = [];

function layoutChart7dCanvas() {
  if (!canvas7d) return;
  const panel = canvas7d.closest(".chart-panel");
  const raw = panel ? panel.clientWidth - 8 : canvas7d.clientWidth || 720;
  const w = Math.max(260, Math.min(Math.floor(raw), 1200));
  canvas7d.width = w;
  canvas7d.height = 220;
}

function setWsStatus(text: string, klass: "buy" | "sell" | "neutral" = "neutral") {
  if (!wsStatusEl) return;
  wsStatusEl.textContent = text;
  wsStatusEl.classList.remove("buy", "sell", "neutral");
  wsStatusEl.classList.add(klass);
}

function addSignalRow(timestamp: string, value: string, isClosed: boolean) {
  if (!listEl) return;
  const li = document.createElement("li");
  li.className = "signal-item";
  li.innerHTML = `<span class="timestamp">${timestamp}</span><span class="${isClosed ? "buy" : "neutral"}">${value}</span>`;
  listEl.prepend(li);
  while (listEl.children.length > 8) {
    listEl.removeChild(listEl.lastChild as Node);
  }
}

function drawChart() {
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
    ctx.fillText("Waiting for live data...", 24, height / 2);
    return;
  }

  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const range = Math.max(maxP - minP, 0.000001);

  ctx.beginPath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#6ea8fe";
  prices.forEach((p, i) => {
    const x = pad + ((width - pad * 2) * i) / (prices.length - 1);
    const y = height - pad - ((p - minP) / range) * (height - pad * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const last = prices[prices.length - 1];
  ctx.fillStyle = "#e8ecf8";
  ctx.font = "12px Segoe UI";
  ctx.fillText(`Last: ${last.toFixed(2)}`, pad, 14);
}

function drawSevenDayChart(points: DailyPoint[]) {
  if (!canvas7d || !ctx7d) return;
  const width = canvas7d.width;
  const height = canvas7d.height;
  const padTop = 28;
  const padLeft = 14;
  const padRight = 18;
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
    return;
  }

  const minP = Math.min(...realCloses);
  const maxP = Math.max(...realCloses);
  const range = Math.max(maxP - minP, 0.000001);
  const plotH = height - padTop - bottomPad;
  const plotW = width - padLeft - padRight;
  const n = Math.max(points.length - 1, 1);

  const xAt = (i: number) => padLeft + (plotW * i) / n;
  const yAt = (close: number) => padTop + plotH - ((close - minP) / range) * plotH;

  /* Future slots: faint column + "—" where prediction will go */
  points.forEach((p, i) => {
    if (p.close !== null) return;
    const x = xAt(i);
    ctx7d.save();
    ctx7d.strokeStyle = "rgba(110, 168, 254, 0.25)";
    ctx7d.setLineDash([4, 6]);
    ctx7d.beginPath();
    ctx7d.moveTo(x, padTop);
    ctx7d.lineTo(x, padTop + plotH);
    ctx7d.stroke();
    ctx7d.setLineDash([]);
    ctx7d.fillStyle = "#5c6b8a";
    ctx7d.font = "11px Segoe UI";
    ctx7d.fillText("—", x - 4, padTop + plotH / 2);
    ctx7d.restore();
  });

  /* Line only across real closes (stops before Tomorrow / +2d) */
  ctx7d.beginPath();
  ctx7d.lineWidth = 2;
  ctx7d.strokeStyle = "#f0b90b";
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

  /* Dots on real days */
  points.forEach((p, i) => {
    if (p.close === null) return;
    const x = xAt(i);
    const y = yAt(p.close);
    ctx7d.beginPath();
    ctx7d.fillStyle = "#f0b90b";
    ctx7d.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx7d.fill();
  });

  ctx7d.fillStyle = "#e8ecf8";
  ctx7d.font = "11px Segoe UI";
  ctx7d.fillText(`Low ${minP.toFixed(0)}  High ${maxP.toFixed(0)}`, padLeft, 14);

  ctx7d.fillStyle = "#9eabc9";
  ctx7d.font = width < 420 ? "9px Segoe UI" : "10px Segoe UI";
  points.forEach((p, i) => {
    const x = xAt(i);
    let label: string;
    if (p.label) {
      label = p.label;
    } else {
      const d = new Date(p.open_time);
      label = `${d.getMonth() + 1}/${d.getDate()}`;
    }
    const w = ctx7d.measureText(label).width;
    const minX = padLeft;
    const maxX = width - padRight - w;
    let tx = x - w / 2;
    if (tx < minX) tx = minX;
    if (tx > maxX) tx = maxX;
    ctx7d.fillText(label, tx, height - 18);
  });

  ctx7d.fillStyle = "#6c7a99";
  ctx7d.font = "9px Segoe UI";
  const foot = "Prediction slots (empty for now)";
  let footText = foot;
  ctx7d.font = "9px Segoe UI";
  if (ctx7d.measureText(footText).width > width - padLeft - padRight) {
    footText = "Prediction slots · empty";
  }
  ctx7d.fillText(footText, padLeft, height - 4);
}

async function loadSevenDayPrices() {
  if (!rest7dStatusEl) return;
  rest7dStatusEl.textContent = "Loading...";
  rest7dStatusEl.classList.remove("buy", "sell", "neutral");
  rest7dStatusEl.classList.add("neutral");

  try {
    const res = await fetch(`${API_BASE}/api/btc/prices/7d`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as SevenDayResponse;
    const apiPts = data.points ?? [];
    const displayPts = withPredictionSlots(apiPts);
    lastSevenDayDisplay = displayPts;
    layoutChart7dCanvas();
    drawSevenDayChart(lastSevenDayDisplay);
    rest7dStatusEl.textContent = `${apiPts.length}d history + 2 prediction slots · REST`;
    rest7dStatusEl.classList.remove("neutral");
    rest7dStatusEl.classList.add("buy");
  } catch (e) {
    lastSevenDayDisplay = [];
    layoutChart7dCanvas();
    drawSevenDayChart([]);
    rest7dStatusEl.textContent = "Failed — is backend running?";
    rest7dStatusEl.classList.remove("neutral");
    rest7dStatusEl.classList.add("sell");
    console.error("7d fetch", e);
  }
}

function connect() {
  const ws = new WebSocket(WS_URL);
  setWsStatus("Connecting...", "neutral");

  ws.onopen = () => {
    setWsStatus("Live", "buy");
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data) as TickMessage;
    if (msg.error) {
      setWsStatus("Error", "sell");
      return;
    }

    const close = Number(msg.close);
    if (!Number.isFinite(close)) return;

    prices.push(close);
    if (prices.length > MAX_POINTS) prices.shift();
    drawChart();

    const timestamp = msg.close_time ? new Date(msg.close_time).toLocaleTimeString() : new Date().toLocaleTimeString();
    if (lastPriceEl) lastPriceEl.textContent = close.toFixed(2);
    if (lastRefreshEl) lastRefreshEl.textContent = timestamp;
    if (marketEl && msg.symbol) marketEl.textContent = msg.symbol.replace("USDT", "/USDT");
    addSignalRow(timestamp, `${close.toFixed(2)} ${msg.is_closed ? "(candle closed)" : "(live)"}`, Boolean(msg.is_closed));
  };

  ws.onerror = () => {
    setWsStatus("Socket error", "sell");
  };

  ws.onclose = () => {
    setWsStatus("Reconnecting...", "neutral");
    setTimeout(connect, 1500);
  };
}

drawChart();
void loadSevenDayPrices();
connect();

let resizeChartTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
  if (resizeChartTimer) clearTimeout(resizeChartTimer);
  resizeChartTimer = setTimeout(() => {
    layoutChart7dCanvas();
    drawSevenDayChart(lastSevenDayDisplay);
  }, 120);
});