/**
 * MarketLens — Finnhub Proxy Server
 * Node.js / Express
 *
 * Run:  node server.js
 * Deploy: Vercel, Railway, Render, Fly.io — any Node host
 *
 * Set env var: FINNHUB_KEY=your_key_here
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const FINNHUB_KEY  = process.env.FINNHUB_KEY || 'PASTE_YOUR_KEY_HERE';
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory cache (keeps free tier calls comfortable) ───
const cache = new Map();
const TTL = {
  quote: 15_000, profile: 86_400_000, metrics: 3_600_000,
  news: 300_000, candle: 300_000, rec: 3_600_000,
  target: 3_600_000, earnings: 3_600_000, search: 600_000, etf: 3_600_000,
};
const getCache = k => { const e = cache.get(k); if (!e) return null; if (Date.now() > e.x) { cache.delete(k); return null; } return e.d; };
const setCache = (k, d, ttl) => cache.set(k, { d, x: Date.now() + ttl });

// ── Finnhub helper ────────────────────────────────────────
async function fh(endpoint) {
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${FINNHUB_BASE}${endpoint}${sep}token=${FINNHUB_KEY}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'MarketLens/1.0' } });
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  return r.json();
}

// ── Helpers ───────────────────────────────────────────────
const today  = () => new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const daysFwd = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const tsNow  = () => Math.floor(Date.now() / 1000);
const tsAgo  = n => tsNow() - n * 86400;

const proxy = (ttlKey, endpoint) => async (req, res) => {
  const k = endpoint(req.params, req.query);
  const hit = getCache(k.key);
  if (hit) return res.json(hit);
  try { const d = await fh(k.url); setCache(k.key, d, TTL[ttlKey]); res.json(d); }
  catch (e) { res.status(500).json({ error: e.message }); }
};

// ── Routes ────────────────────────────────────────────────

// Search
app.get('/api/search', async (req, res) => {
  const q = req.query.q || '';
  const ck = `search:${q}`;
  const hit = getCache(ck);
  if (hit) return res.json(hit);
  try { const d = await fh(`/search?q=${encodeURIComponent(q)}`); setCache(ck, d, TTL.search); res.json(d); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Real-time quote
app.get('/api/quote/:symbol', proxy('quote', ({ symbol }) => ({ key: `quote:${symbol}`, url: `/quote?symbol=${symbol}` })));

// Company profile
app.get('/api/profile/:symbol', proxy('profile', ({ symbol }) => ({ key: `profile:${symbol}`, url: `/stock/profile2?symbol=${symbol}` })));

// Key metrics (PE, margins, beta, 52W, etc.)
app.get('/api/metrics/:symbol', proxy('metrics', ({ symbol }) => ({ key: `metrics:${symbol}`, url: `/stock/metric?symbol=${symbol}&metric=all` })));

// Company news
app.get('/api/news/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const from = req.query.from || daysAgo(60);
  const to   = req.query.to   || today();
  const ck = `news:${symbol}:${from}:${to}`;
  const hit = getCache(ck);
  if (hit) return res.json(hit);
  try { const d = await fh(`/company-news?symbol=${symbol}&from=${from}&to=${to}`); setCache(ck, d, TTL.news); res.json(d); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Analyst recommendations
app.get('/api/recommendations/:symbol', proxy('rec', ({ symbol }) => ({ key: `rec:${symbol}`, url: `/stock/recommendation?symbol=${symbol}` })));

// Price target
app.get('/api/price-target/:symbol', proxy('target', ({ symbol }) => ({ key: `target:${symbol}`, url: `/stock/price-target?symbol=${symbol}` })));

// Earnings history
app.get('/api/earnings/:symbol', proxy('earnings', ({ symbol }) => ({ key: `earnings:${symbol}`, url: `/stock/earnings?symbol=${symbol}&limit=8` })));

// Upcoming earnings calendar
app.get('/api/earnings-calendar/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const from = today(), to = daysFwd(90);
  const ck = `earncal:${symbol}`;
  const hit = getCache(ck);
  if (hit) return res.json(hit);
  try { const d = await fh(`/calendar/earnings?from=${from}&to=${to}&symbol=${symbol}`); setCache(ck, d, TTL.earnings); res.json(d); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ETF holdings
app.get('/api/etf-holdings/:symbol', proxy('etf', ({ symbol }) => ({ key: `etf:${symbol}`, url: `/etf/holdings?symbol=${symbol}` })));

// Price candles — all ranges at once
app.get('/api/candles/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const ck = `candles:${symbol}`;
  const hit = getCache(ck);
  if (hit) return res.json(hit);
  try {
    const ranges = [
      { r: '1M', days: 30,   res: 'D' },
      { r: '3M', days: 90,   res: 'D' },
      { r: '6M', days: 180,  res: 'D' },
      { r: '1Y', days: 365,  res: 'W' },
      { r: '5Y', days: 1825, res: 'M' },
    ];
    const results = await Promise.allSettled(
      ranges.map(({ r, days, res }) =>
        fh(`/stock/candle?symbol=${symbol}&resolution=${res}&from=${tsAgo(days)}&to=${tsNow()}`)
          .then(d => [r, d?.s === 'ok' ? d.c : []])
      )
    );
    const ph = {};
    results.forEach(res => { if (res.status === 'fulfilled') ph[res.value[0]] = res.value[1]; });
    setCache(ck, ph, TTL.candle);
    res.json(ph);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BATCH: loads entire stock page in one request ─────────
// This is the main endpoint the frontend calls.
// Uses Promise.allSettled so partial failures don't crash everything.
app.get('/api/stock/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const isETF = req.query.etf === '1';

  try {
    const calls = [
      fh(`/quote?symbol=${symbol}`),
      fh(`/stock/profile2?symbol=${symbol}`),
      fh(`/stock/metric?symbol=${symbol}&metric=all`),
      fh(`/company-news?symbol=${symbol}&from=${daysAgo(60)}&to=${today()}`),
      fh(`/stock/recommendation?symbol=${symbol}`),
      fh(`/stock/price-target?symbol=${symbol}`),
      fh(`/stock/earnings?symbol=${symbol}&limit=8`),
      fh(`/calendar/earnings?from=${today()}&to=${daysFwd(90)}&symbol=${symbol}`),
    ];
    if (isETF) calls.push(fh(`/etf/holdings?symbol=${symbol}`));

    const settled = await Promise.allSettled(calls);
    const [quote, profile, metrics, news, recs, priceTarget, earnings, earningsCal, etfHoldings] =
      settled.map(r => r.status === 'fulfilled' ? r.value : null);

    res.json({ quote, profile, metrics, news: (news || []).slice(0, 6), recs, priceTarget, earnings, earningsCal, etfHoldings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Market overview (status bar pills)
app.get('/api/market-overview', async (req, res) => {
  const ck = 'market-overview';
  const hit = getCache(ck);
  if (hit) return res.json(hit);
  try {
    const [SPY, QQQ, DIA] = await Promise.all([
      fh('/quote?symbol=SPY'), fh('/quote?symbol=QQQ'), fh('/quote?symbol=DIA')
    ]);
    const d = { SPY, QQQ, DIA };
    setCache(ck, d, TTL.quote);
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Health / cache stats
app.get('/health', (req, res) => res.json({ status: 'ok', cached: cache.size, uptime: process.uptime() }));

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n✅ MarketLens proxy running → http://localhost:${PORT}`);
  console.log(`   Key: ${FINNHUB_KEY.slice(0, 8)}...`);
  console.log(`   Cache TTLs: quote ${TTL.quote/1000}s, candles ${TTL.candle/1000}s\n`);
});
