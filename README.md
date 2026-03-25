# Volatility Forecasting

Frontend-only BTC/USDT dashboard with Binance REST:
- current BTC/USDT price (polled every few seconds),
- 7-day daily close chart,
- two empty future slots (`T+1`, `T+2`) for future prediction display.

## Project Structure

- `web/` - frontend app (Vite + TypeScript)
- `src/` - Python research/modeling code (not used by website runtime)

## Requirements

- Node.js 18+ (or 20+)
- npm

## Local Development

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

- No backend is required for website runtime.
- If you add predictions/signals server-side later, you can re-introduce an API/WebSocket service.
