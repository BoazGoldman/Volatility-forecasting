# Volatility Forecasting

BTC/USDT volatility forecasting loop + dashboard:
- current BTC/USDT price (via WebSocket),
- 7-day daily close chart,
- server-generated GARCH “range” overlays (from `main.py`) exported as JSON.

## Project Structure

- `web/` - frontend app (Vite + TypeScript, Firebase Hosting)
- `src/` - Python data/model pipeline code
- `main.py` - long-running forecast loop (writes SQLite + exports JSON to `web/public/`)
- `api/` - FastAPI backend (Uvicorn)
- `docker/docker-compose.yml` - runs loop + API on a server

## Requirements

- Node.js 18+ (or 20+)
- npm
- Docker (for running the loop on a server)

## Local Development

```bash
cd web
npm install
npx vite
```

Open `http://localhost:5173`.

Start the API (in another terminal, from repo root):

```bash
.\.venv\Scripts\python -m uvicorn api.app:app --host 127.0.0.1 --port 8000 --reload
```

## Server (Docker Compose)

This runs:
- `forecast-loop` (long-lived loop that generates SQLite + JSON exports)
- `api` (FastAPI + Uvicorn that serves forecasts/errors and WS price stream)

Generated artifacts:
- `data/forecasts.db` (SQLite)
- `web/public/forecasts.json`
- `web/public/forecasts_10s.json`

Run:

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

Stop:

```bash
docker compose -f docker/docker-compose.yml down
```

## Build + Firebase Hosting

Build frontend:

```bash
cd web
npm run build
```

Deploy (Firebase Hosting publishes `web/dist`):

```bash
cd web
firebase deploy --only hosting
```

`firebase deploy` also runs `npm run build` automatically via predeploy.

## Data Source

Frontend uses:
- Backend WebSocket price stream: `/ws/price` (backend proxies Binance WS)
- Binance REST for 7-day candles (daily): `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=7`

## Firebase files

- **Firestore rules/indexes** live in `web/firebase/` and are referenced by `web/firebase.json`.
- **Service account key** should NOT be committed. If you need one locally, place it at:
  - `web/firebase/firebase-key.json`
  - See `web/firebase/firebase-key.example.json` for the expected shape.

## Notes

- Website runtime is static (Firebase Hosting). The loop is a separate server-side process.
- Generated runtime artifacts (DB, JSON exports) are ignored by git.
