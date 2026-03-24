# Volatility Forecasting

Real-time BTC/USDT dashboard with:
- a live WebSocket price stream (1m Binance kline updates),
- a REST endpoint for the last 7 daily candles,
- a frontend chart UI (Vite + TypeScript).

## Project Structure

- `api/server.py` - FastAPI backend (`/ws`, `/api/btc/prices/7d`, `/health`)
- `src/` - Python modeling/signal pipeline code
- `web/` - frontend app (Vite)
- `docker/` - Docker and Caddy deployment files

## Requirements

- Python 3.11+
- Node.js 18+ (or 20+)
- npm

## Local Development

### 1) Backend

From repo root:

```bash
python -m venv .venv
```

Activate venv:

- Windows (PowerShell)
```powershell
.\.venv\Scripts\Activate.ps1
```

- Linux/macOS
```bash
source .venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Run backend:

```bash
uvicorn api.server:app --reload --port 8000
```

Useful endpoints:
- `http://localhost:8000/health`
- `http://localhost:8000/api/btc/prices/7d`
- `ws://localhost:8000/ws`

### 2) Frontend

In a second terminal:

```bash
cd web
npm install
npx vite
```

Open `http://localhost:5173`.

## Build + Firebase Hosting

Build frontend:

```bash
cd web
npx vite build
```

Deploy (Firebase Hosting is configured to publish `web/dist`):

```bash
cd web
firebase deploy --only hosting
```

## Docker

Docker files are under `docker/`.

### Backend only

From repo root:

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

Backend runs on `http://localhost:8000`.

### Backend + Caddy (HTTPS/WSS)

1. Edit `docker/Caddyfile` and replace `api.example.com` with your real domain.
2. Ensure DNS points to your server and ports `80/443` are reachable.
3. Run:

```bash
docker compose -f docker/docker-compose.caddy.yml up -d --build
```

## Config Notes

Frontend runtime config lives in `web/index.html`:
- `window.__WS_URL__` for websocket endpoint
- `window.__API_BASE__` for REST base URL

Examples:
- Local: `ws://localhost:8000/ws`, `http://localhost:8000`
- Production: `wss://your-domain/ws`, `https://your-domain`

## Cleanup / Reproducibility

Ignored generated artifacts include:
- `.venv/`
- `**/__pycache__/`
- `web/node_modules/`
- `web/dist/`

Regenerate anytime with install/build commands above.
