# MarketLens 📈

Real-time stock analysis platform powered by Finnhub API.

---

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Add your Finnhub key
cp .env.example .env
# Edit .env and set FINNHUB_KEY=your_key

# 3. Run
npm start
# → Open http://localhost:3000
```

Node 18+ required. Your Finnhub key is stored server-side and never exposed to the browser.

---

## Project Structure

```
marketlens/
├── server.js          ← Express proxy server (Finnhub API calls live here)
├── package.json
├── vercel.json        ← Vercel deploy config
├── .env.example       ← Copy to .env and fill in your key
└── public/
    └── index.html     ← The full MarketLens frontend (drop it here)
```

---

## How It Works

```
Browser → /api/stock/AAPL → server.js → Finnhub API
                                ↑
                         Key stays here
                         Cache layer here
                         CORS handled here
```

The browser talks to your server (same origin = no CORS issues).
Your server talks to Finnhub with your API key hidden server-side.
Responses are cached to keep API usage well within the free tier limit.

---

## API Endpoints

| Endpoint | Description | Cache TTL |
|----------|-------------|-----------|
| `GET /api/stock/:symbol` | **Main batch endpoint** — quote, profile, metrics, news, analyst ratings, earnings, upcoming earnings | Per-field |
| `GET /api/candles/:symbol` | Price history for 1M/3M/6M/1Y/5Y | 5 min |
| `GET /api/search?q=` | Symbol search | 10 min |
| `GET /api/market-overview` | SPY/QQQ/DIA for status bar | 15 sec |
| `GET /api/etf-holdings/:symbol` | ETF top holdings | 1 hour |
| `GET /health` | Server health + cache stats | — |

---

## Deploy to Vercel (Free)

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Set your API key as a secret
vercel env add FINNHUB_KEY
# Enter: d47vjm9r01qk80bio9q0d47vjm9r01qk80bio9qg

# Redeploy with the env var
vercel --prod
```

Your app will be live at `https://marketlens-xxx.vercel.app` in ~2 minutes.

---

## Deploy to Railway (Alternative — 1-click)

1. Go to railway.app → New Project → Deploy from GitHub
2. Set `FINNHUB_KEY` environment variable in the Railway dashboard
3. Done — Railway auto-detects Node.js

---

## Finnhub API Tiers

| Plan | Cost | Rate Limit | What's included |
|------|------|------------|-----------------|
| Free | $0 | 60/min | US stocks, quotes, news, basic metrics, earnings |
| Premium | ~$12–$100/mo | Higher | International stocks, full financials, alt data |
| Enterprise | Custom | Unlimited | All data, WebSocket streaming |

Your free key is plenty to start. Upgrade at finnhub.io/pricing when needed.

---

## Frontend Integration

Once deployed, update the frontend's API base URL from the local AI data to your proxy:

```js
// In public/index.html — replace the data fetching with:
const API = '';  // empty = same origin (your server)

async function loadStock(ticker) {
  const [stock, candles] = await Promise.all([
    fetch(`${API}/api/stock/${ticker}`).then(r => r.json()),
    fetch(`${API}/api/candles/${ticker}`).then(r => r.json()),
  ]);
  // stock.quote, stock.profile, stock.metrics, etc.
  // candles['1Y'], candles['5Y'], etc.
}
```
