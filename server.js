/**
 * StockScope — Proxy Server v3.0
 * FMP-only — all data from Financial Modeling Prep stable API
 */

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const session  = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Pool }  = require('pg');
const pgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
let Stripe = null;
try { Stripe = require('stripe'); } catch(e) { console.log('[stripe] package not installed — payments disabled'); }

const STRIPE_SECRET      = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID    = process.env.STRIPE_PRICE_ID   || 'price_1Tbo5QFeM4NPwaTuxX35pcyA';
const STRIPE_WEBHOOK_SEC = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = (Stripe && STRIPE_SECRET) ? Stripe(STRIPE_SECRET) : null;

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Postgres pool (Railway injects DATABASE_URL automatically) ────────────────
const db = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDB(){
  if(!db){ console.log('[DB] No DATABASE_URL — running without database'); return; }
  try{
    await db.query('SELECT 1'); // test connection
    console.log('[DB] Connected successfully');
  }catch(e){
    console.error('[DB] Connection failed:', e.message);
    return;
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid   TEXT PRIMARY KEY,
      sess  JSONB NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);

    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      google_id  TEXT UNIQUE NOT NULL,
      email      TEXT,
      name       TEXT,
      avatar     TEXT,
      plan       TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id     TEXT,
      stripe_subscription_id TEXT,
      plan_expires_at        TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS portfolios (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      positions  JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Migrate existing users table to add plan columns if not present
  if(db){
    await db.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;
    `).catch(()=>{});
  }
  console.log('[DB] Tables ready');
}

// ── Auth config ───────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SESSION_SECRET       = process.env.SESSION_SECRET       || 'stockscope-change-me-in-prod';
const BASE_URL             = process.env.BASE_URL             || 'http://localhost:3000';

// Only register Google strategy if credentials are configured
if(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET){
  passport.use(new GoogleStrategy({
    clientID:     GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL:  `${BASE_URL}/auth/google/callback`,
  }, async (accessToken, refreshToken, profile, done) => {
    if(!db) return done(null, { id: 0, google_id: profile.id, name: profile.displayName, email: profile.emails?.[0]?.value, avatar: profile.photos?.[0]?.value });
    try {
      const { rows } = await db.query(
        `INSERT INTO users (google_id, email, name, avatar)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (google_id) DO UPDATE SET email=$2, name=$3, avatar=$4
         RETURNING *`,
        [profile.id, profile.emails?.[0]?.value||null, profile.displayName||null, profile.photos?.[0]?.value||null]
      );
      done(null, rows[0]);
    } catch(e){ done(e); }
  }));
} else {
  console.log('[Auth] Google OAuth credentials not set — auth disabled');
}

// When no DB: store full user object in session. When DB: store just the ID.
passport.serializeUser((user, done) => {
  if(!db) return done(null, JSON.stringify({id:user.id||0,google_id:user.google_id,name:user.name,email:user.email,avatar:user.avatar}));
  done(null, user.id);
});

passport.deserializeUser(async (data, done) => {
  if(!db){
    try{ done(null, typeof data==='string' ? JSON.parse(data) : data); }
    catch(e){ done(null, null); }
    return;
  }
  try{
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [data]);
    done(null, rows[0] || null);
  } catch(e){ done(e); }
});

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

app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl === '/api/stripe/webhook') req.rawBody = buf;
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,                  // requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,                   // strict limit on auth routes
  message: { error: 'Too many login attempts, please try again later.' },
});
app.use('/api/', apiLimiter);
app.use('/auth/', authLimiter);

// ── Session ───────────────────────────────────────────────────────────────────
const sessionConfig = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, secure: true, sameSite: 'lax' },
};
if(db){
  sessionConfig.store = new pgSession({ pool: db, tableName: 'sessions', createTableIfMissing: true });
}
app.use(session(sessionConfig));
app.use(passport.initialize());
app.use(passport.session());

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res, next) => {
  if(!GOOGLE_CLIENT_ID) return res.redirect('/?auth=fail');
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});
app.get('/auth/google/callback',
  (req, res, next) => {
    if(!GOOGLE_CLIENT_ID) return res.redirect('/?auth=fail');
    next();
  },
  passport.authenticate('google', { failureRedirect: '/?auth=fail' }),
  (req, res) => {
    // passport.authenticate as middleware calls req.logIn automatically
    req.session.save(err => {
      if(err){ console.error('[callback] session save error:', err); return res.redirect('/?auth=fail'); }
      res.redirect('/?auth=success');
    });
  }
);
app.get('/api/auth/debug', (req, res) => {
  res.json({
    googleConfigured: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    clientIdPrefix: GOOGLE_CLIENT_ID ? GOOGLE_CLIENT_ID.slice(0,8)+'...' : 'NOT SET',
    baseUrl: BASE_URL,
    dbConnected: !!db,
    sessionActive: !!req.session,
    user: req.user ? { name: req.user.name, email: req.user.email } : null,
  });
});

app.post('/auth/logout', (req, res) => {
  req.logout(err => { if(err) return res.status(500).json({error:'logout failed'}); res.json({ok:true}); });
});
app.get('/api/auth/me', (req, res) => {
  if(!req.user) return res.json(null);
  const { id, google_id, email, name, avatar, plan } = req.user;
  res.json({ id, googleId: google_id, email, name, avatar, plan: plan||'free' });
});

// ── Portfolio API (server-persisted when logged in) ───────────────────────────
app.get('/api/portfolio', async (req, res) => {
  if(!req.user) return res.status(401).json({ error: 'not logged in' });
  if(!db)       return res.json({ positions: [] });
  const { rows } = await db.query('SELECT positions FROM portfolios WHERE user_id=$1', [req.user.id]);
  res.json({ positions: rows[0]?.positions || [] });
});

app.post('/api/portfolio', async (req, res) => {
  if(!req.user) return res.status(401).json({ error: 'not logged in' });
  if(!db)       return res.json({ ok: true });
  const positions = req.body.positions || [];
  await db.query(
    `INSERT INTO portfolios (user_id, positions, updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (user_id) DO UPDATE SET positions=$2, updated_at=NOW()`,
    [req.user.id, JSON.stringify(positions)]
  );
  res.json({ ok: true });
});

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
  const r = await fetch(url, { headers: { 'User-Agent': 'StockScope/3.0' } });
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
    dp: q.changePercentage ?? q.changesPercentage ?? 0,
    h:  q.dayHigh  ?? q.price,
    l:  q.dayLow   ?? q.price,
    o:  q.open     ?? q.price,
    pc: q.previousClose ?? (q.price - (q.change ?? 0)),
    marketCap: q.marketCap ?? null,
    volume:    q.volume    ?? null,
    avgVolume: q.averageVolume ?? null,
    yearHigh:  q.yearHigh  ?? (q.range ? +q.range.split('-')[1] : null),
    yearLow:   q.yearLow   ?? (q.range ? +q.range.split('-')[0] : null),
    name:      q.companyName ?? null,
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

// Hardcoded top holdings for popular ETFs (Yahoo Finance blocks Railway IPs for quoteSummary)
const ETF_HOLDINGS_CACHE={
  'SPY':[{symbol:'NVDA',name:'NVIDIA Corp',percent:6.51},{symbol:'AAPL',name:'Apple Inc',percent:6.33},{symbol:'MSFT',name:'Microsoft Corp',percent:5.62},{symbol:'AMZN',name:'Amazon.com Inc',percent:3.96},{symbol:'META',name:'Meta Platforms',percent:2.72},{symbol:'GOOGL',name:'Alphabet Inc A',percent:2.04},{symbol:'TSLA',name:'Tesla Inc',percent:1.97},{symbol:'BRK-B',name:'Berkshire Hathaway B',percent:1.84},{symbol:'AVGO',name:'Broadcom Inc',percent:1.72},{symbol:'GOOG',name:'Alphabet Inc C',percent:1.60},{symbol:'JPM',name:'JPMorgan Chase',percent:1.37},{symbol:'LLY',name:'Eli Lilly',percent:1.33},{symbol:'UNH',name:'UnitedHealth Group',percent:1.24},{symbol:'V',name:'Visa Inc',percent:1.16},{symbol:'XOM',name:'Exxon Mobil',percent:1.14}],
  'VOO':[{symbol:'NVDA',name:'NVIDIA Corp',percent:6.51},{symbol:'AAPL',name:'Apple Inc',percent:6.33},{symbol:'MSFT',name:'Microsoft Corp',percent:5.62},{symbol:'AMZN',name:'Amazon.com Inc',percent:3.96},{symbol:'META',name:'Meta Platforms',percent:2.72},{symbol:'GOOGL',name:'Alphabet Inc A',percent:2.04},{symbol:'TSLA',name:'Tesla Inc',percent:1.97},{symbol:'BRK-B',name:'Berkshire Hathaway B',percent:1.84},{symbol:'AVGO',name:'Broadcom Inc',percent:1.72},{symbol:'GOOG',name:'Alphabet Inc C',percent:1.60},{symbol:'JPM',name:'JPMorgan Chase',percent:1.37},{symbol:'LLY',name:'Eli Lilly',percent:1.33},{symbol:'UNH',name:'UnitedHealth Group',percent:1.24},{symbol:'V',name:'Visa Inc',percent:1.16},{symbol:'XOM',name:'Exxon Mobil',percent:1.14}],
  'QQQ':[{symbol:'NVDA',name:'NVIDIA Corp',percent:8.91},{symbol:'AAPL',name:'Apple Inc',percent:7.89},{symbol:'MSFT',name:'Microsoft Corp',percent:7.42},{symbol:'AMZN',name:'Amazon.com Inc',percent:5.38},{symbol:'META',name:'Meta Platforms',percent:4.14},{symbol:'TSLA',name:'Tesla Inc',percent:3.54},{symbol:'GOOGL',name:'Alphabet Inc A',percent:3.01},{symbol:'COST',name:'Costco Wholesale',percent:2.55},{symbol:'GOOG',name:'Alphabet Inc C',percent:2.83},{symbol:'AVGO',name:'Broadcom Inc',percent:2.43},{symbol:'NFLX',name:'Netflix Inc',percent:2.31},{symbol:'AMGN',name:'Amgen Inc',percent:1.71},{symbol:'AMD',name:'Advanced Micro Devices',percent:1.44},{symbol:'INTC',name:'Intel Corp',percent:1.10},{symbol:'ADBE',name:'Adobe Inc',percent:1.08}],
  'DIA':[{symbol:'UNH',name:'UnitedHealth Group',percent:10.12},{symbol:'GS',name:'Goldman Sachs',percent:8.53},{symbol:'MSFT',name:'Microsoft Corp',percent:7.31},{symbol:'HD',name:'Home Depot',percent:6.09},{symbol:'CAT',name:'Caterpillar Inc',percent:5.52},{symbol:'SHW',name:'Sherwin-Williams',percent:5.31},{symbol:'MCD',name:'McDonald\'s Corp',percent:5.02},{symbol:'CRM',name:'Salesforce Inc',percent:4.51},{symbol:'AMGN',name:'Amgen Inc',percent:4.44},{symbol:'AAPL',name:'Apple Inc',percent:3.91},{symbol:'V',name:'Visa Inc',percent:3.87},{symbol:'IBM',name:'IBM Corp',percent:3.61},{symbol:'HON',name:'Honeywell',percent:3.45},{symbol:'TRV',name:'Travelers Companies',percent:3.39},{symbol:'JPM',name:'JPMorgan Chase',percent:3.28}],
  'IWM':[{symbol:'FTAI',name:'FTAI Aviation',percent:0.56},{symbol:'IRDM',name:'Iridium Communications',percent:0.43},{symbol:'FN',name:'Fabrinet',percent:0.42},{symbol:'CSWI',name:'CSW Industrials',percent:0.41},{symbol:'TRNO',name:'Terreno Realty',percent:0.40},{symbol:'MSTR',name:'MicroStrategy',percent:0.39},{symbol:'BXMT',name:'Blackstone Mortgage',percent:0.38},{symbol:'SPSC',name:'SPS Commerce',percent:0.37},{symbol:'SKYW',name:'SkyWest Inc',percent:0.36},{symbol:'MGEE',name:'MGE Energy',percent:0.35}],
  'VTI':[{symbol:'NVDA',name:'NVIDIA Corp',percent:5.91},{symbol:'AAPL',name:'Apple Inc',percent:5.74},{symbol:'MSFT',name:'Microsoft Corp',percent:5.11},{symbol:'AMZN',name:'Amazon.com Inc',percent:3.60},{symbol:'META',name:'Meta Platforms',percent:2.47},{symbol:'GOOGL',name:'Alphabet Inc A',percent:1.85},{symbol:'TSLA',name:'Tesla Inc',percent:1.79},{symbol:'BRK-B',name:'Berkshire Hathaway B',percent:1.67},{symbol:'AVGO',name:'Broadcom Inc',percent:1.56},{symbol:'GOOG',name:'Alphabet Inc C',percent:1.45},{symbol:'JPM',name:'JPMorgan Chase',percent:1.24},{symbol:'LLY',name:'Eli Lilly',percent:1.21},{symbol:'UNH',name:'UnitedHealth Group',percent:1.13},{symbol:'V',name:'Visa Inc',percent:1.05},{symbol:'XOM',name:'Exxon Mobil',percent:1.03}],
  'GLD':[{symbol:'GOLD',name:'Gold Bullion (Physical)',percent:100}],
  'TLT':[{symbol:'T-BONDS',name:'US Treasury 20+ Year Bonds',percent:100}],
};

async function yahooEtfHoldings(symbol){
  const hdrs={'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36','Accept':'application/json','Accept-Language':'en-US,en;q=0.9','Referer':'https://finance.yahoo.com/'};
  const hosts=['query1','query2'];
  for(const host of hosts){
    try{
      const url=`https://${host}.finance.yahoo.com/v11/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=topHoldings&corsDomain=finance.yahoo.com`;
      const r=await fetch(url,{headers:hdrs});
      if(!r.ok) continue;
      const data=await r.json();
      const top=data?.quoteSummary?.result?.[0]?.topHoldings;
      if(!top||!top.holdings?.length) continue;
      const holdings=top.holdings.map(h=>({
        symbol:h.symbol||'',
        name:h.holdingName||h.symbol||'',
        percent:+(((h.holdingPercent?.raw??0)*100).toFixed(2)),
      }));
      return{holdings};
    }catch(e){}
  }
  return{holdings:[]};
}

// ── ETF Holdings via FMP Commercial API ───────────────────
app.get('/api/etf/holdings/:symbol([A-Z0-9.\\-^]+)', async (req,res) => {
  const symbol = req.params.symbol.toUpperCase();
  const ck = `etf-hold:${symbol}`; const hit = gc(ck); if(hit) return res.json(hit);
  try{
    const data = await fmp('/etf/holdings', { symbol });
    const items = arr(data);
    if(!items.length) return res.json({holdings:[], source:'fmp'});
    const holdings = items
      .filter(h => h.asset || h.symbol)
      .map(h => ({
        symbol:  h.asset || h.symbol,
        name:    h.name || h.asset || h.symbol,
        percent: +(h.weightPercentage ?? h.weight ?? 0).toFixed(2),
        shares:  h.sharesNumber || null,
        marketValue: h.marketValue || null,
      }))
      .sort((a,b) => b.percent - a.percent)
      .slice(0, 25);
    const result = { holdings, source: 'fmp', updated: items[0]?.updated || null };
    sc(ck, result, TTL.fmpFin);
    res.json(result);
  } catch(e) {
    const cached = ETF_HOLDINGS_CACHE[symbol];
    if(cached) return res.json({ holdings: cached, source: 'cache', cached: true });
    res.json({ holdings: [], source: 'fmp', error: e.message });
  }
});

// Debug ETF holdings — try multiple endpoint names
app.get('/api/debug-etf/:symbol([A-Z0-9.\\-^]+)', async(req,res)=>{
  const{symbol}=req.params;
  const results={};
  const endpoints=['/etf/holdings','/etf/info','/etf-holder','/etf-holders'];
  for(const ep of endpoints){
    try{
      const d=await fmp(ep,{symbol});
      results[ep]={count:arr(d).length,keys:arr(d)[0]?Object.keys(arr(d)[0]):[],sample:arr(d)[0]};
    }catch(e){results[ep]={error:e.message};}
  }
  res.json(results);
});

// ══════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════

// Search
app.get('/api/search', async (req,res) => {
  const q = req.query.q || '';
  if(!q) return res.json({result:[]});
  const ck = `search:${q.toLowerCase()}`; const hit = gc(ck); if(hit) return res.json(hit);
  try {
    const data = await fmp('/search', { query: q, limit: 20 });
    const items = Array.isArray(data) ? data : (data?.result || data?.results || []);
    const result = {
      result: items
        .filter(r => r.symbol && !r.symbol.match(/\.[A-Z]{2,}$/) && r.symbol.length <= 6)
        .map(r => ({
          symbol:      r.symbol,
          description: r.name || r.companyName || r.description || r.symbol,
          type:        r.type || 'Stock',
          displaySymbol: r.symbol,
        }))
        .slice(0, 10)
    };
    sc(ck, result, TTL.search);
    res.json(result);
  } catch(e) {
    console.error('Search error:', e.message);
    res.json({result:[]});
  }
});

// Real-time quote
app.get('/api/quote/:symbol([A-Z0-9.\\-^]+)', async (req,res) => {
  const { symbol } = req.params; const ck = `quote:${symbol}`; const hit = gc(ck); if(hit) return res.json(hit);
  try {
    const data = await fmp('/profile', { symbol });
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
      fmp('/profile', { symbol: 'SPY' }),
      fmp('/profile', { symbol: 'QQQ' }),
      fmp('/profile', { symbol: 'DIA' }),
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
app.get('/api/stock/:symbol([A-Z0-9.\\-^]+)', async (req,res) => {
  const { symbol } = req.params;
  const isETF = req.query.etf === '1';
  try {
    console.log(`[stock] fetching ${symbol}`);
    const [
      profileRaw, incomeRaw, kmRaw,
      newsRaw, recsRaw, priceTargetRaw,
      earningsRaw, earningsCalRaw,
    ] = await Promise.all([
      fmpSafe('/profile',                        { symbol }),  // price + company info in one call
      fmpSafe('/income-statement',               { symbol, period: 'annual', limit: 1 }),
      fmpSafe('/key-metrics',                    { symbol, period: 'annual', limit: 1 }),
      fmpSafe('/news/stock',                     { symbols: symbol, limit: 10 }),
      fmpSafe('/analyst-stock-recommendations',  { symbol, limit: 5 }),
      fmpSafe('/price-target-consensus',         { symbol }),
      fmpSafe('/earnings-surprises',             { symbol }),
      fmpSafe('/earnings-calendar',              { from: today(), to: dFwd(90), symbol }),
    ]);
    const quoteRaw = profileRaw; // profile contains price+change — no separate quote call needed
    console.log(`[stock] ${symbol} fetched — quote:${!!quoteRaw} profile:${!!profileRaw} news:${!!newsRaw}`);

    const quoteData   = arr(quoteRaw)[0]   || null;
    const profileData = arr(profileRaw)[0] || null;
    const incomeData  = arr(incomeRaw)[0]  || null;
    const kmData      = arr(kmRaw)[0]      || null;

    console.log(`[stock] ${symbol} transforming...`);
    const quote       = transformQuote(quoteData);
    const profile     = transformProfile(profileData);
    const metrics     = buildMetrics(quoteData, profileData, incomeData, kmData);
    const news        = transformNews(newsRaw).slice(0, 6);
    const recs        = transformRecs(recsRaw);
    const priceTarget = transformPriceTarget(priceTargetRaw);
    const earnings    = transformEarnings(earningsRaw).slice(0, 8);
    const earningsCal = transformEarningsCalendar(earningsCalRaw);
    const etfHoldings = null;

    console.log(`[stock] ${symbol} sending response`);
    res.json({ quote, profile, metrics, news, recs, priceTarget, earnings, earningsCal, etfHoldings });
  } catch(e) {
    console.error(`[/api/stock/${symbol}] 500:`, e.message, '\n', e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ── Peers / Competitors ───────────────────────────────────
app.get('/api/peers/:symbol([A-Z0-9.\\-^]+)', async (req,res) => {
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
      Promise.allSettled(filtered.map(p => fmpSafe('/profile', { symbol: p.symbol }))),
      Promise.resolve([]),
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
app.get('/api/fmp/financials/:symbol([A-Z0-9.\\-^]+)', async (req,res) => {
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
      dividendPerShare:cf.map((c,i) => { const sh=inc[i]?.weightedAverageShsOutDil; const paid=Math.abs(c.netDividendsPaid||c.commonDividendsPaid||c.dividendsPaid||0); return sh&&sh>0 ? +(paid/sh).toFixed(2) : 0; }),
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
        { l:'Dividends Paid', vals: cashflow.slice(0,4).reverse().map((c,i) => {
          const raw = c.netDividendsPaid != null ? c.netDividendsPaid
                    : c.commonDividendsPaid != null ? c.commonDividendsPaid
                    : c.dividendsPaid != null ? c.dividendsPaid : null;
          if(raw === null) return '—';
          const v = Math.abs(raw);
          return v > 0 ? `$${(v/1e9).toFixed(2)}B` : '—';
        })},
        { l:'Payout Ratio',   vals: (() => {
          const cfSlice  = cashflow.slice(0,4).reverse();
          const incSlice = income.slice(0,4).reverse();
          return cfSlice.map((c,i) => {
            const divPaid = Math.abs(c.netDividendsPaid||c.commonDividendsPaid||c.dividendsPaid||0);
            if(!divPaid) return '—';
            const ni = incSlice[i]?.netIncome || 0;
            if(ni <= 0) return 'N/M';
            return `${((divPaid/ni)*100).toFixed(1)}%`;
          });
        })()},
      ],
    };

    sc(ck, parsed, TTL.fmpFin);
    res.json(parsed);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Price history — full history + YTD, 1M, 3M, 6M, 1Y, 5Y, 10Y, All
app.get('/api/fmp/prices/:symbol([A-Z0-9.\\-^]+)', async (req,res) => {
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
app.get('/api/fmp/dividend-history/:symbol([A-Z0-9.\\-^]+)', async (req,res) => {
  const { symbol } = req.params; const ck=`divhist:${symbol}`; const hit=gc(ck); if(hit)return res.json(hit);
  try{
    const data = await fmpSafe('/dividends', {symbol});
    const hist = Array.isArray(data) ? data : (data?.historical||[]);
    const byYear={};
    hist.forEach(d=>{
      const yr=(d.date||'').slice(0,4);
      if(!yr||yr<'1990')return;
      const amt=d.adjDividend??d.dividend??0;
      if(amt>0)byYear[yr]=(byYear[yr]||0)+amt;
    });
    const years=Object.keys(byYear).sort();
    // Return last 8 raw payments so client can predict next payout date
    const recent=hist
      .filter(d=>d.date&&(d.adjDividend??d.dividend??0)>0)
      .sort((a,b)=>b.date.localeCompare(a.date))
      .slice(0,8)
      .map(d=>({date:d.date,paymentDate:d.paymentDate||d.date,amount:+(d.adjDividend??d.dividend??0).toFixed(4)}));
    const result={years,dividends:years.map(y=>+byYear[y].toFixed(4)),recent};
    sc(ck,result,TTL.fmpFin);
    res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
});

// ── Yahoo Finance intraday (free, no API key needed) ─────────────────────
async function yahooIntraday(symbol) {
  const hdrs={
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':'application/json, text/plain, */*',
    'Accept-Language':'en-US,en;q=0.9',
    'Referer':'https://finance.yahoo.com/',
    'Origin':'https://finance.yahoo.com',
  };
  const yFetch=async url=>{
    try{
      const r=await fetch(url,{headers:hdrs});
      if(!r.ok) return null;
      return await r.json();
    }catch(e){return null;}
  };
  // Try query1, fall back to query2 if needed
  const yGet=async path=>{
    const d=await yFetch(`https://query1.finance.yahoo.com${path}`);
    if(d?.chart?.result?.[0])return d;
    return yFetch(`https://query2.finance.yahoo.com${path}`);
  };
  // Convert Yahoo UTC timestamp seconds → "YYYY-MM-DD HH:MM:SS" in Eastern Time
  function tsToET(sec){
    const d=new Date(sec*1000);
    try{
      const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(d);
      const g=t=>p.find(x=>x.type===t)?.value||'00';
      return `${g('year')}-${g('month')}-${g('day')} ${g('hour')==='24'?'00':g('hour')}:${g('minute')}:${g('second')}`;
    }catch{return new Date(sec*1000-4*3600000).toISOString().replace('T',' ').slice(0,19);}
  }
  const parseY=data=>{
    const res=data?.chart?.result?.[0];if(!res)return[];
    const ts=res.timestamp||[],cls=res.indicators?.quote?.[0]?.close||[];
    return ts.map((t,i)=>cls[i]!=null?{date:tsToET(t),close:cls[i]}:null).filter(Boolean);
  };
  const [d5m, d15m, d1h, dYtd, d1y]=await Promise.all([
    yGet(`/v8/finance/chart/${symbol}?interval=5m&range=1d`),
    yGet(`/v8/finance/chart/${symbol}?interval=15m&range=5d`),
    yGet(`/v8/finance/chart/${symbol}?interval=60m&range=3mo`),
    yGet(`/v8/finance/chart/${symbol}?interval=60m&range=ytd`),
    yGet(`/v8/finance/chart/${symbol}?interval=60m&range=1y`),
  ]);
  const bars5m=parseY(d5m),bars15m=parseY(d15m),bars1h=parseY(d1h),barsYtd=parseY(dYtd),bars1y=parseY(d1y);
  const toS=arr=>({prices:arr.map(b=>+b.close.toFixed(2)),times:arr.map(b=>b.date)});
  const dAgo=n=>new Date(Date.now()-n*86_400_000).toISOString().slice(0,10);
  return{
    '1D':toS(bars5m),
    '1W':toS(bars15m),
    '1M':toS(bars1h.filter(b=>b.date.slice(0,10)>=dAgo(33))),
    '3M':toS(bars1h.filter(b=>b.date.slice(0,10)>=dAgo(96))),
    'YTD':toS(barsYtd),
    '1Y':toS(bars1y),
  };
}

// Test endpoint — visit /api/test-intraday/AAPL to verify Yahoo Finance works
app.get('/api/test-intraday/:symbol', async (req,res) => {
  const{symbol}=req.params;
  try{
    const url=`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=1d`;
    const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept':'application/json','Referer':'https://finance.yahoo.com/'}});
    const raw=await r.json();
    const result=raw?.chart?.result?.[0];
    const pts=result?.timestamp?.length||0;
    res.json({
      status: pts>0?'✅ Yahoo Finance working':'❌ No data from Yahoo Finance',
      points: pts,
      firstBar: pts>0?{ts:result.timestamp[0],close:result.indicators?.quote?.[0]?.close?.[0]}:null,
      lastBar: pts>0?{ts:result.timestamp[pts-1],close:result.indicators?.quote?.[0]?.close?.[pts-1]}:null,
      error: raw?.chart?.error||null,
    });
  }catch(e){res.json({status:'❌ Fetch failed',error:e.message});}
});

app.get('/api/fmp/intraday/:symbol([A-Z0-9.\\-^]+)', async (req,res) => {
  const{symbol}=req.params;const ck=`intraday:${symbol}`;const hit=gc(ck);if(hit)return res.json(hit);
  try{
    const result=await yahooIntraday(symbol);
    sc(ck,result,3*60_000);
    res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
});

// ── News endpoints ─────────────────────────────────────────────────────────
// ── Yahoo Finance news helper ──────────────────────────────────────────────
async function yahooNews(symbol, count=5){
  const hdrs={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36','Accept':'application/json','Referer':'https://finance.yahoo.com/'};
  try{
    const url=`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=${count}&enableFuzzyQuery=false&enableCeDer=true`;
    const r=await fetch(url,{headers:hdrs});
    const data=await r.json();
    return(data?.news||[]).map(n=>({
      headline:n.title||'',
      source:n.publisher||'',
      url:n.link||'',
      datetime:n.providerPublishTime||0,
    }));
  }catch(e){return[];}
}

// Stock news — Yahoo Finance (single ticker, no plan limits)
app.get('/api/news/stock/:symbol([A-Z0-9.\\-^]+)', async (req,res) => {
  const{symbol}=req.params;const ck=`ynews:${symbol}`;const hit=gc(ck);if(hit)return res.json(hit);
  try{
    const result=await yahooNews(symbol,5);
    sc(ck,result,TTL.news);res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
});

// Market news — aggregate Yahoo Finance news for major market movers
app.get('/api/news/market', async (req,res) => {
  const ck='market-news-y';const hit=gc(ck);if(hit)return res.json(hit);
  try{
    const tks=['SPY','QQQ','NVDA','AAPL','MSFT'];
    const results=await Promise.all(tks.map(t=>yahooNews(t,2)));
    const seen=new Set();
    const result=results.flat()
      .filter(n=>{if(!n.url||seen.has(n.url))return false;seen.add(n.url);return true;})
      .sort((a,b)=>b.datetime-a.datetime)
      .slice(0,5);
    sc(ck,result,TTL.news);res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
});

// Debug news — check what FMP returns
app.get('/api/debug-news', async (req,res) => {
  try{
    const[spy,mkt]=await Promise.all([
      fmpSafe('/news/stock',{symbols:'SPY',limit:2}),
      fmpSafe('/news/stock',{limit:2}),
    ]);
    res.json({spyNews:{type:typeof spy,isArray:Array.isArray(spy),length:Array.isArray(spy)?spy.length:null,sample:Array.isArray(spy)?spy[0]:spy},
              noTickerNews:{type:typeof mkt,isArray:Array.isArray(mkt),length:Array.isArray(mkt)?mkt.length:null,sample:Array.isArray(mkt)?mkt[0]:mkt}});
  }catch(e){res.json({error:e.message});}
});

app.get('/api/fmp/insiders/:symbol([A-Z0-9.\\-^]+)', async (req,res) => {
  const ck='market-news';const hit=gc(ck);if(hit)return res.json(hit);
  try{
    // Fetch from several major tickers individually (avoids comma-encoding issues)
    const tks=['SPY','QQQ','AAPL','MSFT','NVDA'];
    const results=await Promise.all(tks.map(t=>fmpSafe('/news/stock',{symbols:t,limit:2})));
    const raw=results.flatMap(d=>arr(d));
    // Deduplicate by URL and transform
    const seen=new Set();
    const result=raw
      .filter(n=>{if(!n.url||seen.has(n.url))return false;seen.add(n.url);return true;})
      .map(n=>({headline:n.title||n.headline,source:n.site||n.source,url:n.url,
        datetime:n.publishedDate?Math.floor(new Date(n.publishedDate).getTime()/1000):(n.datetime||0),
        image:n.image}))
      .sort((a,b)=>b.datetime-a.datetime)
      .slice(0,5);
    sc(ck,result,TTL.news);res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
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
      fmpSafe('/profile',             { symbol }),
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

app.get('/api/etf-holdings-returns/:symbol', (req,res) => res.json([]));
app.get('/api/etf-info/:symbol',             (req,res) => res.json({}));
app.get('/api/etf-sectors/:symbol',          (req,res) => res.json([]));


// Debug screener — try bulk/batch endpoints
app.get('/api/debug-screener', async (req,res) => {
  const results={};
  const tests=[
    ['/batch-quote-short',{symbols:'AAPL,MSFT,NVDA'}],
    ['/profile/batch',{symbols:'AAPL,MSFT,NVDA'}],
    ['/batch-profile',{symbols:'AAPL,MSFT,NVDA'}],
    ['/bulk/profile',{part:'0'}],
    ['/company-screener',{marketCapMin:100000000000,limit:10}],
    ['/market-capitalization-batch',{symbols:'AAPL,MSFT,NVDA'}],
    ['/prices/batch',{symbols:'AAPL,MSFT,NVDA'}],
  ];
  for(const[ep,qs] of tests){
    try{
      const d=await fmp(ep,qs);
      results[ep]={ok:true,count:Array.isArray(d)?d.length:1,keys:(Array.isArray(d)?d[0]:d)?Object.keys(Array.isArray(d)?d[0]:d).slice(0,6):[]};
    }catch(e){results[ep]={error:e.message};}
  }
  res.json(results);
});

// Debug raw FMP quote
app.get('/api/debug-quote/:symbol', async(req,res)=>{
  const{symbol}=req.params;
  const results={};
  const tests=[
    ['/quote',{symbol}],
    ['/quote-short',{symbol}],
    ['/batch-quote',{symbols:symbol}],
    ['/batch-quote-short',{symbols:symbol}],
    ['/historical-price-eod/light',{symbol,limit:1}],
    ['/profile',{symbol}],
  ];
  for(const[ep,qs] of tests){
    try{
      const d=await fmp(ep,qs);
      results[ep]={ok:true,count:Array.isArray(d)?d.length:1,keys:Array.isArray(d)?Object.keys(d[0]||{}):Object.keys(d||{})};
    }catch(e){results[ep]={error:e.message};}
  }
  res.json(results);
});

// Market Cap Rank — batch quotes for top stocks sorted by live market cap
const TOP_STOCKS=['AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AVGO','WMT',
  'JPM','LLY','V','MA','XOM','ORCL','COST','UNH','NFLX','JNJ','HD','AMD','CRM','BAC',
  'PG','ABBV','PLTR','TMUS','KO','PEP','ADBE','TXN','ACN','MRK','PM','WFC','TMO','ABT',
  'GE','DHR','IBM','VZ','CSCO','MCD','INTU','AMGN','SPGI','AXP','HON','ISRG','BKNG',
  'LOW','LMT','RTX','BLK','CB','SYK','VRTX','ADI','REGN','BMY','NOW','T','SCHW','PLD',
  'MU','ELV','CI','ETN','PANW','SBUX','GILD','UPS','MDT','KLAC','DUK','SO','PGR','MS',
  'GS','C','ADP','ZTS','EOG','TJX','COF','WM','ITW','LRCX','CME','APD','NKE','QCOM',
  'WELL','DE','INTC','TGT','AMT','COP','USB','ICE','MMC','PH','EMR','PYPL'];

app.get('/api/market-cap-rank', async (req,res) => {
  const ck='mkt-cap-rank'; const hit=gc(ck); if(hit)return res.json(hit);
  try{
    // Individual parallel calls — FMP stable only supports one symbol at a time
    const quotes=await Promise.all(TOP_STOCKS.map(sym=>fmpSafe('/profile',{symbol:sym})));
    const all=quotes.map(r=>arr(r)[0]).filter(s=>s?.symbol&&(s?.marketCap||0)>0);
    all.sort((a,b)=>(b.marketCap||0)-(a.marketCap||0));
    const result=all.slice(0,100).map((s,i)=>({
      rank:i+1,
      symbol:s.symbol,
      name:s.name||s.symbol,
      marketCap:s.marketCap||0,
      price:s.price||0,
      change:+(s.changePercentage??s.changesPercentage??0).toFixed(2),
    }));
    sc(ck,result,1_800_000);
    res.json(result);
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/debug-cashflow/:symbol', async (req,res) => {
  const { symbol } = req.params;
  try {
    const cf = await fmp('/cash-flow-statement', { symbol, period: 'annual', limit: 2 });
    const row = arr(cf)[0] || {};
    // Return all fields so we can see exactly what FMP sends
    res.json({
      symbol,
      allFields: Object.keys(row),
      dividendRelated: Object.entries(row).filter(([k]) => k.toLowerCase().includes('div') || k.toLowerCase().includes('payment') || k.toLowerCase().includes('sharehold')),
      raw: row
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/clear-cache', (req, res) => {
  const size = cache.size;
  cache.clear();
  res.json({ ok: true, cleared: size });
});

app.get('/health', (req,res) => res.json({ status: 'ok', version: '3.0', provider: 'FMP only', cached: cache.size, uptime: process.uptime() }));

// ── SPA fallback ──────────────────────────────────────────
// ── Stripe ────────────────────────────────────────────────────────────────────

// Create checkout session
app.post('/api/stripe/checkout', async (req, res) => {
  if(!req.user) return res.status(401).json({error:'Not logged in'});
  if(!stripe) return res.status(500).json({error:'Stripe not configured'});
  try{
    let customerId = req.user.stripe_customer_id;
    if(!customerId && db){
      const customer = await stripe.customers.create({
        email: req.user.email||undefined,
        name:  req.user.name||undefined,
        metadata:{ userId: String(req.user.id) }
      });
      customerId = customer.id;
      await db.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2',[customerId,req.user.id]);
    }
    const session = await stripe.checkout.sessions.create({
      customer: customerId||undefined,
      customer_email: !customerId ? req.user.email||undefined : undefined,
      mode: 'subscription',
      line_items:[{ price: STRIPE_PRICE_ID, quantity: 1 }],
      automatic_tax: { enabled: true },
      success_url: `${BASE_URL}/?upgraded=1`,
      cancel_url:  `${BASE_URL}/`,
      metadata:{ userId: String(req.user.id) },
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// Customer portal
app.post('/api/stripe/portal', async (req, res) => {
  if(!req.user) return res.status(401).json({error:'Not logged in'});
  if(!stripe) return res.status(500).json({error:'Stripe not configured'});
  if(!req.user.stripe_customer_id) return res.status(400).json({error:'No subscription found'});
  try{
    const session = await stripe.billingPortal.sessions.create({
      customer: req.user.stripe_customer_id,
      return_url: BASE_URL,
    });
    res.json({ url: session.url });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// Stripe webhook
app.post('/api/stripe/webhook', async (req, res) => {
  if(!stripe) return res.json({received:true});
  let event;
  try{
    if(STRIPE_WEBHOOK_SEC){
      event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], STRIPE_WEBHOOK_SEC);
    } else { event = req.body; }
  }catch(e){ return res.status(400).json({error:`Webhook error: ${e.message}`}); }
  if(!db) return res.json({received:true});
  try{
    if(event.type==='checkout.session.completed'){
      const s = event.data.object;
      const userId = s.metadata?.userId;
      if(userId) await db.query(
        `UPDATE users SET plan='pro', stripe_customer_id=$1, stripe_subscription_id=$2 WHERE id=$3`,
        [s.customer, s.subscription, userId]
      );
    }
    if(event.type==='customer.subscription.deleted'||event.type==='customer.subscription.paused'){
      const sub = event.data.object;
      await db.query(`UPDATE users SET plan='free', stripe_subscription_id=NULL WHERE stripe_subscription_id=$1`,[sub.id]);
    }
    if(event.type==='invoice.payment_succeeded'){
      await db.query(`UPDATE users SET plan='pro' WHERE stripe_customer_id=$1`,[event.data.object.customer]);
    }
  }catch(e){ console.error('[stripe webhook]',e.message); }
  res.json({received:true});
});

app.get('/api/user/plan', (req, res) => {
  if(!req.user) return res.json({plan:'free'});
  res.json({plan: req.user.plan||'free'});
});

// ── Legal pages ───────────────────────────────────────────────────────────────
app.get('/privacy', (req,res) => res.sendFile(path.join(__dirname, 'public', 'legal.html')));
app.get('/terms',   (req,res) => res.sendFile(path.join(__dirname, 'public', 'legal.html')));

if (require.main === module) {
  initDB().then(() => {
    app.get('*', (req,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ StockScope v4.2 (Accounts) listening on port ${PORT}`);
      console.log(`   Auth: ${GOOGLE_CLIENT_ID ? 'Google OAuth enabled' : 'No Google credentials — auth disabled'}`);
      console.log(`   DB:   ${db ? 'Postgres connected' : 'No DB — local mode'}`);
    });
  }).catch(e => { console.error('[startup]', e); process.exit(1); });
} else {
  app.get('*', (req,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
}

module.exports = app;
