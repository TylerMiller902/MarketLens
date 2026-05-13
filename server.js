/**
 * MarketLens — Proxy Server v3.0
 * FMP-only — all data from Financial Modeling Prep stable API
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const FMP_KEY  = process.env.FMP_KEY || 'PASTE_FMP_KEY_HERE';
const FMP_BASE = 'https://financialmodelingprep.com/stable';
// Separate v3 base for endpoints not yet on stable (e.g. intraday historical-chart)
const FMP_V3   = 'https://financialmodelingprep.com/api/v3';
async function fmpV3fn(ep, qs={}) {
  const params = new URLSearchParams({ apikey: FMP_KEY, ...qs });
  const sep = ep.includes('?') ? '&' : '?';
  const url = `${FMP_V3}${ep}${sep}${params}`;
  const r = await fetch(url); const data = await r.json();
  if(data?.['Error Message']) throw new Error(data['Error Message']);
  return data;
}
const fmpV3Safe = async (ep, qs={}) => { try { return await fmpV3fn(ep, qs); } catch { return null; } };

// ── Global safety net (prevents Railway crash on unhandled promise) ───────
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Cache ─────────────────────────────────────────────────
const cache = new Map();
const TTL = {
  quote:    15_000,
  profile:  3_600_000,
  news:       300_000,
  recs:     3_600_000,
  earnings: 3_600_000,
  search:     600_000,
  etf:      3_600_000,
  peers:    1_800_000,
  fmpFin:   3_600_000,
  fmpPrice:   300_000,
  insiders: 1_800_000,
};
const gc = k => { const e=cache.get(k); if(!e)return null; if(Date.now()>e.x){cache.delete(k);return null;} return e.d; };
const sc = (k,d,ttl) => cache.set(k,{d,x:Date.now()+ttl});

// ── FMP fetch ─────────────────────────────────────────────
async function fmp(ep, qs={}) {
  const params = new URLSearchParams({ apikey: FMP_KEY, ...qs });
  const sep = ep.includes('?') ? '&' : '?';
  const url = `${FMP_BASE}${ep}${sep}${params}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'MarketLens/3.0' } });
  if (!r.ok) throw new Error(`FMP ${r.status} ${ep}`);
  const data = await r.json();
  if (data?.['Error Message']) throw new Error(`FMP: ${data['Error Message']}`);
  return data;
}

// Safe fmp — returns null instead of throwing
const fmpSafe = async (ep, qs={}) => { try { return await fmp(ep, qs); } catch { return null; } };

// ── Data helpers ──────────────────────────────────────────
const today  = () => new Date().toISOString().slice(0,10);
const dAgo   = n  => new Date(Date.now()-n*86_400_000).toISOString().slice(0,10);
const dFwd   = n  => new Date(Date.now()+n*86_400_000).toISOString().slice(0,10);
const arr    = d  => Array.isArray(d) ? d : (d ? [d] : []);
const pct    = v  => v != null ? +(v * 100).toFixed(4) : null;  // decimal → percent

// ── Transform FMP quote → Finnhub-compatible format ───────
function transformQuote(q) {
  if (!q) return null;
  return {
    c:  q.price,
    d:  q.change          ?? 0,
    dp: q.changePercentage ?? 0,   // FMP uses changePercentage (not changesPercentage)
    h:  q.dayHigh,
    l:  q.dayLow,
    o:  q.open,
    pc: q.previousClose,
  };
}

// ── Transform FMP profile → Finnhub-compatible format ─────
function transformProfile(p) {
  if (!p) return null;
  return {
    name:                  p.companyName,
    logo:                  p.image,
    exchange:              p.exchange,
    finnhubIndustry:       p.industry || p.sector,
    marketCapitalization:  p.marketCap ? p.marketCap / 1e6 : null,
    description:           p.description,
    employeeTotal:         p.fullTimeEmployees,
    ipo:                   p.ipoDate,
    country:               p.country,
    weburl:                p.website,
    ticker:                p.symbol,
    beta:                  p.beta,
    lastDividend:          p.lastDividend,
    isEtf:                 p.isEtf,
  };
}

// ── Build Finnhub-compatible metrics from FMP data ────────
function buildMetrics(quote, profile, income, km) {
  const q = quote   || {};
  const p = profile || {};
  const i = income  || {};
  const k = km      || {};

  // P/E from earningsYield (quote has no pe field in stable API)
  const pe = k.earningsYield && k.earningsYield > 0
    ? +((1 / k.earningsYield).toFixed(2)) : null;

  // EPS from income statement (not in quote)
  const eps = i.epsDiluted ?? i.eps ?? null;

  // Margins — no ratio fields in stable income statement, calculate manually
  const grossMargin = i.revenue > 0 && i.grossProfit != null
    ? +((i.grossProfit / i.revenue) * 100).toFixed(2) : null;
  const netMargin = i.revenue > 0 && i.netIncome != null
    ? +((i.netIncome / i.revenue) * 100).toFixed(2) : null;

  // P/S = Market Cap / Revenue
  const marketCap = q.marketCap ?? p.marketCap ?? null;
  const ps = marketCap && i.revenue > 0
    ? +(marketCap / i.revenue).toFixed(2) : null;

  // Dividend — profile uses lastDividend (not lastDiv)
  const lastDiv  = p.lastDividend ?? null;
  const divYield = q.price && lastDiv && q.price > 0
    ? +((lastDiv / q.price) * 100).toFixed(4) : null;

  return {
    metric: {
      '52WeekHigh':                q.yearHigh,
      '52WeekLow':                 q.yearLow,
      peBasicExclExtraTTM:         pe,
      epsTTM:                      eps,
      psTTM:                       ps,
      dividendYieldIndicatedAnnual: divYield,
      dividendPerShareAnnual:      lastDiv,
      beta:                        p.beta ?? null,
      grossMarginTTM:              grossMargin,
      netProfitMarginTTM:          netMargin,
      currentRatioAnnual:          k.currentRatio ?? null,
      roeTTM:  k.returnOnEquity != null ? +(k.returnOnEquity * 100).toFixed(2) : null,
      roaTTM:  k.returnOnAssets != null ? +(k.returnOnAssets * 100).toFixed(2) : null,
    }
  };
}

// ── Transform FMP analyst recs → Finnhub array format ─────
function transformRecs(data) {
  return arr(data).map(r => ({
    period:     r.date || '',
    strongBuy:  r.analystRatingsStrongBuy  ?? r.strongBuy  ?? r.analystRatingsBuy        ?? 0,
    buy:        r.analystRatingsBuy        ?? r.buy        ?? r.analystRatingsOverweight  ?? 0,
    hold:       r.analystRatingsHold       ?? r.hold       ?? 0,
    sell:       r.analystRatingsUnderweight?? r.sell       ?? 0,
    strongSell: r.analystRatingsStrongSell ?? r.strongSell ?? r.analystRatingsSell        ?? 0,
  }));
}

// ── Transform FMP price target → Finnhub format ───────────
function transformPriceTarget(data) {
  const d = Array.isArray(data) ? data[0] : data;
  if (!d) return null;
  return {
    targetMean: d.targetConsensus ?? d.targetMean ?? d.priceTarget,
    targetHigh: d.targetHigh,
    targetLow:  d.targetLow,
  };
}

// ── Transform FMP earnings → Finnhub format ───────────────
function transformEarnings(data) {
  return arr(data).map(e => {
    const actual   = e.actualEarningResult ?? e.actual ?? e.eps ?? null;
    const estimate = e.estimatedEarning    ?? e.estimate        ?? null;
    const surp     = actual != null && estimate != null ? actual - estimate : null;
    const surprisePct = surp != null && estimate ? (surp / Math.abs(estimate)) * 100 : null;
    return {
      period:         e.date ? formatEarningPeriod(e.date) : (e.period || ''),
      quarter:        e.date,
      actual,
      estimate,
      surprise:       surp,
      surprisePercent: surprisePct != null ? +surprisePct.toFixed(4) : null,
    };
  });
}

function formatEarningPeriod(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()} Q${q}`;
}

// ── Transform FMP earnings calendar → Finnhub format ──────
function transformEarningsCalendar(data) {
  return {
    earningsCalendar: arr(data).map(e => ({
      date:        e.date,
      hour:        e.time === 'amc' ? 'amc' : 'bmo',
      epsEstimate: e.epsEstimated ?? e.epsEstimate ?? null,
      symbol:      e.symbol,
    }))
  };
}

// ── Transform FMP news → Finnhub format ───────────────────
function transformNews(data) {
  return arr(data).map(n => ({
    headline: n.title    || n.headline,
    source:   n.site     || n.source,
    url:      n.url,
    datetime: n.publishedDate ? Math.floor(new Date(n.publishedDate).getTime()/1000) : (n.datetime || 0),
    image:    n.image,
  }));
}

// ── Transform FMP ETF holdings → Finnhub format ───────────
function transformEtfHoldings(data) {
  const holdings = arr(data?.holdings ?? data).map(h => ({
    symbol:  h.asset    || h.symbol,
    name:    h.name,
    percent: h.weightPercentage ?? h.weight ?? h.percent ?? 0,
  }));
  return { holdings };
}

// ══════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════

// Search
app.get('/api/search', async (req,res) => {
  const q = req.query.q || '';
  if(!q) return res.json({result:[]});
  const ck = `search:${q}`; const hit = gc(ck); if(hit) return res.json(hit);
  try {
    const data = await fmp('/search', { query: q, limit: 10 });
    const items = Array.isArray(data) ? data : (data?.result || data?.results || []);
    const result = {
      result: items
        .filter(r => r.symbol)
        .map(r => ({
          symbol:      r.symbol,
          description: r.name || r.companyName || r.description || r.symbol,
          type:        r.type || 'Stock',
          displaySymbol: r.symbol,
        }))
    };
    sc(ck, result, TTL.search);
    res.json(result);
  } catch(e) {
    console.error('Search error:', e.message);
    res.json({result:[]}); // return empty instead of 500 so frontend handles gracefully
  }
});

// Real-time quote
app.get('/api/quote/:symbol', async (req,res) => {
  const { symbol } = req.params; const ck = `quote:${symbol}`; const hit = gc(ck); if(hit) return res.json(hit);
  try {
    const data = await fmp('/quote', { symbol });
    const q = arr(data)[0];
    const result = transformQuote(q);
    sc(ck, result, TTL.quote);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Market overview — SPY, QQQ, DIA
app.get('/api/market-overview', async (req,res) => {
  const ck = 'market-overview'; const hit = gc(ck); if(hit) return res.json(hit);
  try {
    const [spy, qqq, dia] = await Promise.all([
      fmp('/quote', { symbol: 'SPY' }),
      fmp('/quote', { symbol: 'QQQ' }),
      fmp('/quote', { symbol: 'DIA' }),
    ]);
    const d = {
      SPY: transformQuote(arr(spy)[0]),
      QQQ: transformQuote(arr(qqq)[0]),
      DIA: transformQuote(arr(dia)[0]),
    };
    sc(ck, d, TTL.quote);
    res.json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Main stock batch endpoint ─────────────────────────────
app.get('/api/stock/:symbol', async (req,res) => {
  const { symbol } = req.params;
  const isETF = req.query.etf === '1';
  try {
    // Fetch all data in parallel — includes income + key metrics for stats card
    const [
      quoteRaw, profileRaw, incomeRaw, kmRaw,
      newsRaw, recsRaw, priceTargetRaw,
      earningsRaw, earningsCalRaw, etfRaw,
    ] = await Promise.all([
      fmpSafe('/quote',                          { symbol }),
      fmpSafe('/profile',                        { symbol }),
      fmpSafe('/income-statement',               { symbol, period: 'annual', limit: 1 }),
      fmpSafe('/key-metrics',                    { symbol, period: 'annual', limit: 1 }),
      fmpSafe('/stock-news',                     { tickers: symbol, limit: 10 }),
      fmpSafe('/analyst-stock-recommendations',  { symbol, limit: 5 }),
      fmpSafe('/price-target-consensus',         { symbol }),
      fmpSafe('/earnings-surprises',             { symbol }),
      fmpSafe('/earnings-calendar',              { from: today(), to: dFwd(90), symbol }),
      isETF ? fmpSafe('/etf-holdings',           { symbol }) : Promise.resolve(null),
    ]);

    const quoteData   = arr(quoteRaw)[0]   || null;
    const profileData = arr(profileRaw)[0] || null;
    const incomeData  = arr(incomeRaw)[0]  || null;
    const kmData      = arr(kmRaw)[0]      || null;

    const quote       = transformQuote(quoteData);
    const profile     = transformProfile(profileData);
    const metrics     = buildMetrics(quoteData, profileData, incomeData, kmData);
    const news        = transformNews(newsRaw).slice(0, 6);
    const recs        = transformRecs(recsRaw);
    const priceTarget = transformPriceTarget(priceTargetRaw);
    const earnings    = transformEarnings(earningsRaw).slice(0, 8);
    const earningsCal = transformEarningsCalendar(earningsCalRaw);
    const etfHoldings = isETF ? transformEtfHoldings(etfRaw) : null;

    res.json({ quote, profile, metrics, news, recs, priceTarget, earnings, earningsCal, etfHoldings });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Peers / Competitors ───────────────────────────────────
app.get('/api/peers/:symbol', async (req,res) => {
  const { symbol } = req.params;
  const ck = `peers:${symbol}`; const hit = gc(ck); if(hit) return res.json(hit);
  try {
    // Get peers + main company profile in parallel (for sector matching)
    const [peersRaw, mainProfileRaw] = await Promise.all([
      fmpSafe('/stock-peers',  { symbol }),
      fmpSafe('/profile',      { symbol }),
    ]);

    const mainProfile  = arr(mainProfileRaw)[0] || {};
    const mainSector   = mainProfile.sector   || '';
    const mainIndustry = mainProfile.industry || '';

    // FMP returns: [{symbol, companyName, price, mktCap}, ...]
    const peerObjects = Array.isArray(peersRaw) ? peersRaw : [];

    // Filter out tiny / irrelevant companies (> $1B mktCap)
    const filtered = peerObjects
      .filter(p => p.symbol && p.symbol !== symbol && (p.mktCap||0) > 1_000_000_000)
      .slice(0, 9);

    if (!filtered.length) return res.json([]);

    // Fetch quotes (for today's change) + profiles (for sector matching)
    const [quotes, profiles] = await Promise.all([
      Promise.allSettled(filtered.map(p => fmp('/quote',   { symbol: p.symbol }))),
      Promise.allSettled(filtered.map(p => fmpSafe('/profile', { symbol: p.symbol }))),
    ]);

    let result = filtered.map((peer, i) => {
      const q    = arr(quotes[i].status   === 'fulfilled' ? quotes[i].value   : null)[0];
      const prof = arr(profiles[i].status === 'fulfilled' ? profiles[i].value : null)[0] || {};
      return {
        ticker:   peer.symbol,
        sector:   prof.sector   || '',
        industry: prof.industry || '',
        quote:    transformQuote(q || { price: peer.price, change: 0, changePercentage: 0 }),
        profile:  {
          name:                 peer.companyName,
          logo:                 `https://images.financialmodelingprep.com/symbol/${peer.symbol}.png`,
          marketCapitalization: peer.mktCap ? peer.mktCap / 1e6 : null,
        },
      };
    })
    .filter(p => p.quote?.c);

    // Sort: same industry first → same sector → by market cap
    result.sort((a, b) => {
      const score = x =>
        (x.industry === mainIndustry ? 4 : 0) +
        (x.sector   === mainSector   ? 2 : 0);
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      return (b.profile?.marketCapitalization||0) - (a.profile?.marketCapitalization||0);
    });

    sc(ck, result.slice(0, 7), TTL.peers);
    res.json(result.slice(0, 7));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  FMP FINANCIAL DATA ROUTES (unchanged)
// ══════════════════════════════════════════════════════════

// Financial statements + key metrics
app.get('/api/fmp/financials/:symbol', async (req,res) => {
  const { symbol } = req.params; const ck = `fmp-fin:${symbol}`; const hit = gc(ck); if(hit) return res.json(hit);
  try {
    const [income, balance, cashflow, keyMetrics] = await Promise.all([
      fmp('/income-statement',       { symbol, period: 'annual', limit: 25 }),
      fmp('/balance-sheet-statement',{ symbol, period: 'annual', limit: 25 }),
      fmp('/cash-flow-statement',    { symbol, period: 'annual', limit: 25 }),
      fmpSafe('/key-metrics',        { symbol, period: 'annual', limit: 25 }),
    ]);

    if (!Array.isArray(income) || !income.length) return res.json(null);

    const inc = [...income].reverse();
    const bal = [...balance].reverse();
    const cf  = [...cashflow].reverse();
    const km  = [...(Array.isArray(keyMetrics) ? keyMetrics : [])].reverse();

    const netDebt = bal.map(b => +(((b.totalDebt||0) - (b.cashAndCashEquivalents||0)) / 1e9).toFixed(2));

    const getPE   = k => { const ey = k?.earningsYield; return ey && ey > 0.001 ? +((1/ey).toFixed(2)) : null; };
    const getROIC = k => { const v = k?.returnOnInvestedCapital ?? k?.returnOnCapitalEmployed; if(v==null)return null; const p = Math.abs(v)<5?v*100:v; return p>-200&&p<1000?+p.toFixed(2):null; };

    const parsed = {
      years:           inc.map(i => i.calendarYear || i.date?.slice(0,4) || ''),
      revenue:         inc.map(i => +((i.revenue||0)/1e9).toFixed(2)),
      grossProfit:     inc.map(i => +((i.grossProfit||0)/1e9).toFixed(2)),
      operatingIncome: inc.map(i => +((i.operatingIncome||0)/1e9).toFixed(2)),
      netIncome:       inc.map(i => +((i.netIncome||0)/1e9).toFixed(2)),
      eps:             inc.map(i => +(i.epsdiluted || i.eps || 0).toFixed(2)),
      grossMargin:     inc.map(i=>{if(i.grossProfitRatio!=null&&i.grossProfitRatio!==0)return+((i.grossProfitRatio)*100).toFixed(2);const r=i.revenue||0;return r>0?+((i.grossProfit||0)/r*100).toFixed(2):0;}),
      operatingMargin: inc.map(i=>{if(i.operatingIncomeRatio!=null&&i.operatingIncomeRatio!==0)return+((i.operatingIncomeRatio)*100).toFixed(2);const r=i.revenue||0;return r>0?+((i.operatingIncome||0)/r*100).toFixed(2):0;}),
      netMargin:       inc.map(i=>{if(i.netIncomeRatio!=null&&i.netIncomeRatio!==0)return+((i.netIncomeRatio)*100).toFixed(2);const r=i.revenue||0;return r>0?+((i.netIncome||0)/r*100).toFixed(2):0;}),
      freeCashFlow:    cf.map(c  => +((c.freeCashFlow||0)/1e9).toFixed(2)),
      operatingCF:     cf.map(c  => +((c.operatingCashFlow||0)/1e9).toFixed(2)),
      capex:           cf.map(c  => +((c.capitalExpenditure||0)/1e9).toFixed(2)),
      fcfMargin:       cf.map((c,i) => { const rev=inc[i]?.revenue; return rev ? +((c.freeCashFlow||0)/rev*100).toFixed(2) : 0; }),
      dividendPerShare:cf.map((c,i) => { const sh=inc[i]?.weightedAverageShsOutDil; const paid=Math.abs(c.dividendsPaid||0); return sh&&sh>0 ? +(paid/sh).toFixed(2) : 0; }),
      totalDebt:       bal.map(b => +((b.totalDebt||0)/1e9).toFixed(2)),
      totalEquity:     bal.map(b => +((b.totalStockholdersEquity||0)/1e9).toFixed(2)),
      cash:            bal.map(b => +((b.cashAndCashEquivalents||0)/1e9).toFixed(2)),
      netDebt,
      sharesOutstanding: inc.map(i => +((i.weightedAverageShsOutDil||i.weightedAverageShsOut||0)/1e9).toFixed(3)),
      kmYears:  km.map(k => k.calendarYear || k.date?.slice(0,4) || ''),
      peRatio:  km.map(getPE),
      roic:     km.map(getROIC),
      dividendYieldPct: km.map(k => {
        // FMP uses different field names across plan tiers
        const dy = k.dividendYield ?? k.dividendYieldTTM ?? k.dividendYieldPercentageTTM ?? null;
        if(dy == null || dy === 0) return null;
        // Values >1 are already in %, values <1 are decimals — normalise to %
        return +(Math.abs(dy) < 1 ? dy * 100 : dy).toFixed(4);
      }),
      tableYears:  income.slice(0,4).reverse().map(i => i.calendarYear || i.date?.slice(0,4)),
      tableIncome: [
        { l:'Revenue',          vals: income.slice(0,4).reverse().map(i => `$${((i.revenue||0)/1e9).toFixed(2)}B`) },
        { l:'Gross Profit',     vals: income.slice(0,4).reverse().map(i => `$${((i.grossProfit||0)/1e9).toFixed(2)}B`) },
        { l:'Operating Income', vals: income.slice(0,4).reverse().map(i => `$${((i.operatingIncome||0)/1e9).toFixed(2)}B`) },
        { l:'Net Income',       vals: income.slice(0,4).reverse().map(i => `$${((i.netIncome||0)/1e9).toFixed(2)}B`) },
        { l:'EBITDA',           vals: income.slice(0,4).reverse().map(i => `$${((i.ebitda||0)/1e9).toFixed(2)}B`) },
        { l:'EPS (Diluted)',    vals: income.slice(0,4).reverse().map(i => `$${(i.epsdiluted||i.eps||0).toFixed(2)}`) },
        { l:'Gross Margin',     vals: income.slice(0,4).reverse().map(i => { const r=i.revenue||0; return r>0?`${((i.grossProfit||0)/r*100).toFixed(1)}%`:'—'; }) },
        { l:'Net Margin',       vals: income.slice(0,4).reverse().map(i => { const r=i.revenue||0; return r>0?`${((i.netIncome||0)/r*100).toFixed(1)}%`:'—'; }) },
      ],
      tableBalance: [
        { l:'Total Assets',  vals: balance.slice(0,4).reverse().map(b => `$${((b.totalAssets||0)/1e9).toFixed(2)}B`) },
        { l:'Cash',          vals: balance.slice(0,4).reverse().map(b => `$${((b.cashAndCashEquivalents||0)/1e9).toFixed(2)}B`) },
        { l:'Total Debt',    vals: balance.slice(0,4).reverse().map(b => `$${((b.totalDebt||0)/1e9).toFixed(2)}B`) },
        { l:'Total Equity',  vals: balance.slice(0,4).reverse().map(b => `$${((b.totalStockholdersEquity||0)/1e9).toFixed(2)}B`) },
      ],
      tableCF: [
        { l:'Operating CF',   vals: cashflow.slice(0,4).reverse().map(c => `$${((c.operatingCashFlow||0)/1e9).toFixed(2)}B`) },
        { l:'Free Cash Flow', vals: cashflow.slice(0,4).reverse().map(c => `$${((c.freeCashFlow||0)/1e9).toFixed(2)}B`) },
        { l:'CapEx',          vals: cashflow.slice(0,4).reverse().map(c => `$${((c.capitalExpenditure||0)/1e9).toFixed(2)}B`) },
        { l:'Dividends Paid', vals: cashflow.slice(0,4).reverse().map(c => `$${(Math.abs(c.dividendsPaid||0)/1e9).toFixed(2)}B`) },
      ],
    };

    sc(ck, parsed, TTL.fmpFin);
    res.json(parsed);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Price history — full history + YTD, 1M, 3M, 6M, 1Y, 5Y, 10Y, All
app.get('/api/fmp/prices/:symbol', async (req,res) => {
  const { symbol } = req.params; const ck = `fmp-prices:${symbol}`; const hit = gc(ck); if(hit) return res.json(hit);
  try {
    // fetch=all by using from=1990 and a high limit — upgraded plan gives full history
    const data = await fmp('/historical-price-eod/light', { symbol, from: '1990-01-01', limit: 10000 });
    const historical = Array.isArray(data) ? data : [];
    if (!historical.length) return res.json({});
    const now = Date.now();
    const ytdCutoff = `${new Date().getFullYear()}-01-01`;
    const dAgoStr = n => new Date(now - n*86_400_000).toISOString().slice(0,10);
    const mkRange = cutoff => {
      const filtered = historical.filter(d => d.date >= cutoff).reverse();
      return { prices: filtered.map(d => +(d.price||d.close||0).toFixed(2)), dates: filtered.map(d => d.date) };
    };
    const ph = {
      '1M':  mkRange(dAgoStr(30)),
      '3M':  mkRange(dAgoStr(90)),
      '6M':  mkRange(dAgoStr(180)),
      'YTD': mkRange(ytdCutoff),
      '1Y':  mkRange(dAgoStr(365)),
      '5Y':  mkRange(dAgoStr(1825)),
      '10Y': mkRange(dAgoStr(3650)),
      'All': mkRange('1990-01-01'),
    };
    sc(ck, ph, TTL.fmpPrice);
    res.json(ph);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Insider transactions
// Historical dividend payments → annual yield history
app.get('/api/fmp/dividend-history/:symbol', async (req,res) => {
  const { symbol } = req.params; const ck=`divhist:${symbol}`; const hit=gc(ck); if(hit)return res.json(hit);
  try{
    // FMP stable: /dividends?symbol=AAPL returns array of {date,adjDividend,dividend,...}
    const data = await fmpSafe('/dividends', {symbol});
    // Handle both array response and {historical:[...]} response
    const hist = Array.isArray(data) ? data : (data?.historical||[]);
    const byYear={};
    hist.forEach(d=>{
      const yr=(d.date||'').slice(0,4);
      if(!yr||yr<'1990')return;
      const amt=d.adjDividend??d.dividend??0;
      if(amt>0)byYear[yr]=(byYear[yr]||0)+amt;
    });
    const years=Object.keys(byYear).sort();
    const result={years,dividends:years.map(y=>+byYear[y].toFixed(4))};
    sc(ck,result,TTL.fmpFin);
    res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/fmp/intraday/:symbol', async (req,res) => {
  const { symbol } = req.params; const ck=`intraday:${symbol}`; const hit=gc(ck); if(hit)return res.json(hit);
  try{
    // Use v3 — intraday historical-chart not on stable tier
    const from5 = new Date(Date.now()-5*86_400_000).toISOString().slice(0,10);
    const from1h = new Date(Date.now()-100*86_400_000).toISOString().slice(0,10);
    const [m5, h1] = await Promise.all([
      fmpV3Safe(`/historical-chart/5min/${symbol}`, {from: from5}),
      fmpV3Safe(`/historical-chart/1hour/${symbol}`, {from: from1h}),
    ]);
    const arr5  = Array.isArray(m5)  ? [...m5].sort((a,b)=>a.date<b.date?-1:1)  : [];
    const arr1h = Array.isArray(h1)  ? [...h1].sort((a,b)=>a.date<b.date?-1:1)  : [];

    // 1D: most recent trading day 5-min bars
    const lastDay5 = arr5.length ? arr5[arr5.length-1].date.slice(0,10) : '';
    const day5 = lastDay5 ? arr5.filter(d=>d.date.startsWith(lastDay5)) : [];
    console.log(`[intraday] ${symbol} 5min total=${arr5.length} lastDay=${lastDay5} day5=${day5.length} 1h total=${arr1h.length}`);

    // 1W: last 7 calendar days of hourly bars
    const cutW  = new Date(Date.now()-8*86_400_000).toISOString().slice(0,10);
    const week1h = arr1h.filter(d=>d.date.slice(0,10)>=cutW);

    // 1M: last 32 calendar days of hourly bars (~150 pts for better definition)
    const cutM  = new Date(Date.now()-33*86_400_000).toISOString().slice(0,10);
    const mon1h  = arr1h.filter(d=>d.date.slice(0,10)>=cutM);

    // 3M: last 95 calendar days of hourly bars (~490 pts)
    const cut3M = new Date(Date.now()-96*86_400_000).toISOString().slice(0,10);
    const mon3h  = arr1h.filter(d=>d.date.slice(0,10)>=cut3M);

    const toSeries = arr => ({prices:arr.map(d=>+(d.close||0).toFixed(2)),times:arr.map(d=>d.date)});
    const result = { '1D':toSeries(day5), '1W':toSeries(week1h), '1M':toSeries(mon1h), '3M':toSeries(mon3h) };
    sc(ck, result, 3*60_000);
    res.json(result);
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/fmp/insiders/:symbol', async (req,res) => {
  const { symbol } = req.params; const ck = `fmp-ins:${symbol}`; const hit = gc(ck); if(hit) return res.json(hit);
  try {
    const data = await fmp('/insider-trading', { symbol, limit: 30 });
    const rows = Array.isArray(data) ? data : [];
    const cleaned = rows
      .filter(r => r.transactionType && r.securitiesTransacted)
      .map(r => {
        const isBuy = r.acquistionOrDisposition === 'A' || r.transactionType === 'P-Purchase';
        return { date: r.transactionDate||r.filingDate||'', name: r.reportingName||'Unknown', title: r.typeOfOwner||'', type: isBuy?'Buy':'Sell', shares: Math.abs(r.securitiesTransacted||0), price: r.price||0, value: Math.abs((r.securitiesTransacted||0)*(r.price||0)), isBuy };
      })
      .sort((a,b) => b.date.localeCompare(a.date))
      .slice(0, 20);
    const monthly = {};
    cleaned.forEach(r => {
      const mo = r.date.slice(0,7);
      if (!monthly[mo]) monthly[mo] = { month: mo, buyValue: 0, sellValue: 0 };
      if (r.isBuy) monthly[mo].buyValue += r.value; else monthly[mo].sellValue += r.value;
    });
    const result = { transactions: cleaned, monthly: Object.values(monthly).sort((a,b) => a.month.localeCompare(b.month)).slice(-12) };
    sc(ck, result, TTL.insiders);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Debug — inspect raw FMP field names for any endpoint
// Debug intraday — exposes raw FMP v3 response so we can see what's coming back
app.get('/api/debug-intraday/:symbol', async (req,res) => {
  const { symbol } = req.params;
  try{
    const [m5, h1] = await Promise.all([
      fmpV3Safe(`/historical-chart/5min/${symbol}`),
      fmpV3Safe(`/historical-chart/1hour/${symbol}`),
    ]);
    res.json({
      fiveMin:  { type: typeof m5,  isArray: Array.isArray(m5),  length: Array.isArray(m5)?m5.length:null,  first: Array.isArray(m5)?m5.slice(-3):m5 },
      oneHour:  { type: typeof h1,  isArray: Array.isArray(h1),  length: Array.isArray(h1)?h1.length:null,  first: Array.isArray(h1)?h1.slice(-3):h1 },
    });
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/debug/:symbol', async (req,res) => {
  const { symbol } = req.params;
  try {
    const [q, p, i, k, peers] = await Promise.all([
      fmpSafe('/quote',             { symbol }),
      fmpSafe('/profile',           { symbol }),
      fmpSafe('/income-statement',  { symbol, period: 'annual', limit: 1 }),
      fmpSafe('/key-metrics',       { symbol, period: 'annual', limit: 1 }),
      fmpSafe('/stock-peers',       { symbol }),
    ]);
    res.json({
      quote:      { fields: Object.keys(arr(q)[0]||{}), sample: arr(q)[0] },
      profile:    { fields: Object.keys(arr(p)[0]||{}), sample: arr(p)[0] },
      income:     { fields: Object.keys(arr(i)[0]||{}), sample: arr(i)[0] },
      keyMetrics: { fields: Object.keys(arr(k)[0]||{}), sample: arr(k)[0] },
      peers:      { raw: peers },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Top Stock Biggest Movers ──────────────────────────────
app.get('/api/voo-movers', async (req,res) => {
  const ck='voo-movers'; const hit=gc(ck); if(hit)return res.json(hit);
  try{
    const [gainers,losers]=await Promise.all([
      fmpSafe('/biggest-gainers'),
      fmpSafe('/biggest-losers'),
    ]);
    const isCompany=s=>{
      if(!s.symbol||s.symbol.includes('.')||s.price<5)return false;
      const n=(s.name||s.companyName||'').toLowerCase();
      const bad=['etf','fund','trust',' 2x',' 3x','ultra','bear','bull','leveraged','inverse',
                 'proshares','direxion','ishares','vanguard','spdr','invesco','fidelity',
                 'barclays','wisdomtree','first trust',' lp,',' lp ',' llc'];
      return !bad.some(w=>n.includes(w));
    };
    const fmt=(list,type)=>arr(list).filter(isCompany).slice(0,5).map(s=>({
      ticker:s.symbol,
      name:s.name||s.companyName||s.symbol,
      price:s.price,change:s.change??0,
      changePct:s.changesPercentage??s.changePercentage??0,
      logo:`https://images.financialmodelingprep.com/symbol/${s.symbol}.png`,type,
    }));
    const result=[...fmt(gainers,'gainer'),...fmt(losers,'loser')];
    sc(ck,result,5*60_000); res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
});

// ETF holdings/info not available on FMP Starter — return empty gracefully
app.get('/api/etf-holdings-returns/:symbol', (req,res) => res.json([]));
app.get('/api/etf-info/:symbol',             (req,res) => res.json({}));
app.get('/api/etf-sectors/:symbol',          (req,res) => res.json([]));


app.get('/health', (req,res) => res.json({ status: 'ok', version: '3.0', provider: 'FMP only', cached: cache.size, uptime: process.uptime() }));

// ── SPA fallback ──────────────────────────────────────────
module.exports = app;
if (require.main === module) {
  app.get('*', (req,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.listen(PORT, '0.0.0.0', () => console.log(`✅ MarketLens listening on port ${PORT}`));
} else {
  app.get('*', (req,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
}
