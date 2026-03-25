# Volatility Forecasting

BTC/USDT volatility forecasting loop + dashboard:
- current BTC/USDT price (polled every few seconds),
- 7-day daily close chart,
- server-generated GARCH “range” overlays (from `main.py`) exported as JSON.

## Project Structure

- `web/` - frontend app (Vite + TypeScript, Firebase Hosting)
- `src/` - Python data/model pipeline code
- `main.py` - long-running forecast loop (writes SQLite + exports JSON to `web/public/`)
- `docker-compose.yml` - runs the forecast loop on a server

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

## Forecast Loop (Docker)

This runs the long-lived loop that generates:
- `data/forecasts.db` (SQLite)
- `web/public/forecasts.json`
- `web/public/forecasts_10s.json`

Run:

```bash
docker compose up -d --build
```

Stop:

```bash
docker compose down
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

Frontend calls Binance REST directly:
- Current price: `https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT`
- 7-day candles: `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=7`

## Notes

- Website runtime is static (Firebase Hosting). The loop is a separate server-side process.
- Generated runtime artifacts (DB, JSON exports) are ignored by git.
