/**
 * MarketLens — Proxy Server v2
 * Finnhub (free) for real-time data + FMP (Starter) for financial statements & price history
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── API Keys ──────────────────────────────────────────────
const FINNHUB_KEY  = process.env.FINNHUB_KEY || 'PASTE_FINNHUB_KEY_HERE';
const FMP_KEY      = process.env.FMP_KEY      || 'PASTE_FMP_KEY_HERE';
const FH_BASE      = 'https://finnhub.io/api/v1';
const FMP_BASE     = 'https://financialmodelingprep.com/api/v3';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Cache ─────────────────────────────────────────────────
const cache = new Map();
const TTL = {
  quote:       15_000,
  profile:  86_400_000,
  metrics:   3_600_000,
  news:        300_000,
  candle:      300_000,
  rec:       3_600_000,
  target:    3_600_000,
  earnings:  3_600_000,
  search:      600_000,
  etf:       3_600_000,
  fmpFin:    3_600_000,
  fmpPrice:    300_000,
};
const gc = k => { const e=cache.get(k); if(!e)return null; if(Date.now()>e.x){cache.delete(k);return null;} return e.d; };
const sc = (k,d,ttl) => cache.set(k,{d,x:Date.now()+ttl});

// ── Fetch helpers ─────────────────────────────────────────
async function fh(ep) {
  const sep = ep.includes('?')?'&':'?';
  const r = await fetch(`${FH_BASE}${ep}${sep}token=${FINNHUB_KEY}`,{headers:{'User-Agent':'MarketLens/2.0'}});
  if(!r.ok) throw new Error(`Finnhub ${r.status}`);
  return r.json();
}
async function fmp(ep) {
  const sep = ep.includes('?')?'&':'?';
  const r = await fetch(`${FMP_BASE}${ep}${sep}apikey=${FMP_KEY}`,{headers:{'User-Agent':'MarketLens/2.0'}});
  if(!r.ok) throw new Error(`FMP ${r.status}`);
  return r.json();
}

// ── Date helpers ──────────────────────────────────────────
const today  = () => new Date().toISOString().slice(0,10);
const dAgo   = n  => new Date(Date.now()-n*86_400_000).toISOString().slice(0,10);
const dFwd   = n  => new Date(Date.now()+n*86_400_000).toISOString().slice(0,10);

// ══════════════════════════════════════════════════════════
//  FINNHUB ROUTES  (real-time data)
// ══════════════════════════════════════════════════════════

// Search
app.get('/api/search', async (req,res) => {
  const q=req.query.q||''; const ck=`search:${q}`;
  const hit=gc(ck); if(hit)return res.json(hit);
  try{ const d=await fh(`/search?q=${encodeURIComponent(q)}`); sc(ck,d,TTL.search); res.json(d); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Real-time quote
app.get('/api/quote/:symbol', async (req,res) => {
  const {symbol}=req.params; const ck=`quote:${symbol}`;
  const hit=gc(ck); if(hit)return res.json(hit);
  try{ const d=await fh(`/quote?symbol=${symbol}`); sc(ck,d,TTL.quote); res.json(d); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Company profile
app.get('/api/profile/:symbol', async (req,res) => {
  const {symbol}=req.params; const ck=`profile:${symbol}`;
  const hit=gc(ck); if(hit)return res.json(hit);
  try{ const d=await fh(`/stock/profile2?symbol=${symbol}`); sc(ck,d,TTL.profile); res.json(d); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Key metrics
app.get('/api/metrics/:symbol', async (req,res) => {
  const {symbol}=req.params; const ck=`metrics:${symbol}`;
  const hit=gc(ck); if(hit)return res.json(hit);
  try{ const d=await fh(`/stock/metric?symbol=${symbol}&metric=all`); sc(ck,d,TTL.metrics); res.json(d); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Company news
app.get('/api/news/:symbol', async (req,res) => {
  const {symbol}=req.params;
  const from=req.query.from||dAgo(60), to=req.query.to||today();
  const ck=`news:${symbol}:${from}:${to}`;
  const hit=gc(ck); if(hit)return res.json(hit);
  try{ const d=await fh(`/company-news?symbol=${symbol}&from=${from}&to=${to}`); sc(ck,d,TTL.news); res.json(d); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Analyst recommendations
app.get('/api/recommendations/:symbol', async (req,res) => {
  const {symbol}=req.params; const ck=`rec:${symbol}`;
  const hit=gc(ck); if(hit)return res.json(hit);
  try{ const d=await fh(`/stock/recommendation?symbol=${symbol}`); sc(ck,d,TTL.rec); res.json(d); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Price target
app.get('/api/price-target/:symbol', async (req,res) => {
  const {symbol}=req.params; const ck=`target:${symbol}`;
  const hit=gc(ck); if(hit)return res.json(hit);
  try{ const d=await fh(`/stock/price-target?symbol=${symbol}`); sc(ck,d,TTL.target); res.json(d); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Earnings history
app.get('/api/earnings/:symbol', async (req,res) => {
  const {symbol}=req.params; const ck=`earnings:${symbol}`;
  const hit=gc(ck); if(hit)return res.json(hit);
  try{ const d=await fh(`/stock/earnings?symbol=${symbol}&limit=8`); sc(ck,d,TTL.earnings); res.json(d); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Earnings calendar
app.get('/api/earnings-calendar/:symbol', async (req,res) => {
  const {symbol}=req.params;
  const from=today(), to=dFwd(90);
  const ck=`earncal:${symbol}`;
  const hit=gc(ck); if(hit)return res.json(hit);
  try{ const d=await fh(`/calendar/earnings?from=${from}&to=${to}&symbol=${symbol}`); sc(ck,d,TTL.earnings); res.json(d); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// ETF holdings
app.get('/api/etf-holdings/:symbol', async (req,res) => {
  const {symbol}=req.params; const ck=`etf:${symbol}`;
  const hit=gc(ck); if(hit)return res.json(hit);
  try{ const d=await fh(`/etf/holdings?symbol=${symbol}`); sc(ck,d,TTL.etf); res.json(d); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// Market overview pills
app.get('/api/market-overview', async (req,res) => {
  const ck='market-overview';
  const hit=gc(ck); if(hit)return res.json(hit);
  try{
    const [SPY,QQQ,DIA]=await Promise.all([fh('/quote?symbol=SPY'),fh('/quote?symbol=QQQ'),fh('/quote?symbol=DIA')]);
    const d={SPY,QQQ,DIA}; sc(ck,d,TTL.quote); res.json(d);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// Batch Finnhub endpoint — all real-time data in one call
app.get('/api/stock/:symbol', async (req,res) => {
  const {symbol}=req.params;
  const isETF=req.query.etf==='1';
  try{
    const calls=[
      fh(`/quote?symbol=${symbol}`),
      fh(`/stock/profile2?symbol=${symbol}`),
      fh(`/stock/metric?symbol=${symbol}&metric=all`),
      fh(`/company-news?symbol=${symbol}&from=${dAgo(60)}&to=${today()}`),
      fh(`/stock/recommendation?symbol=${symbol}`),
      fh(`/stock/price-target?symbol=${symbol}`),
      fh(`/stock/earnings?symbol=${symbol}&limit=8`),
      fh(`/calendar/earnings?from=${today()}&to=${dFwd(90)}&symbol=${symbol}`),
    ];
    if(isETF) calls.push(fh(`/etf/holdings?symbol=${symbol}`));
    const settled=await Promise.allSettled(calls);
    const [quote,profile,metrics,news,recs,priceTarget,earnings,earningsCal,etfHoldings]=settled.map(r=>r.status==='fulfilled'?r.value:null);
    res.json({quote,profile,metrics,news:(news||[]).slice(0,6),recs,priceTarget,earnings,earningsCal,etfHoldings});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ══════════════════════════════════════════════════════════
//  FMP ROUTES  (financial statements + price history)
// ══════════════════════════════════════════════════════════

// FMP Financial statements — income, balance sheet, cash flow
app.get('/api/fmp/financials/:symbol', async (req,res) => {
  const {symbol}=req.params;
  const ck=`fmp-fin:${symbol}`;
  const hit=gc(ck); if(hit)return res.json(hit);
  try{
    const [income,balance,cashflow]=await Promise.all([
      fmp(`/income-statement/${symbol}?period=annual&limit=10`),
      fmp(`/balance-sheet-statement/${symbol}?period=annual&limit=10`),
      fmp(`/cash-flow-statement/${symbol}?period=annual&limit=10`),
    ]);

    if(!Array.isArray(income)||!income.length) return res.json(null);

    // FMP returns newest first — reverse to oldest first for chart ordering
    const inc=[...income].reverse();
    const bal=[...balance].reverse();
    const cf =[...cashflow].reverse();

    const parsed={
      years:          inc.map(i=>i.calendarYear||i.date?.slice(0,4)||''),
      revenue:        inc.map(i=>+((i.revenue||0)/1e9).toFixed(2)),
      grossProfit:    inc.map(i=>+((i.grossProfit||0)/1e9).toFixed(2)),
      operatingIncome:inc.map(i=>+((i.operatingIncome||0)/1e9).toFixed(2)),
      netIncome:      inc.map(i=>+((i.netIncome||0)/1e9).toFixed(2)),
      eps:            inc.map(i=>+(i.epsdiluted||i.eps||0).toFixed(2)),
      grossMargin:    inc.map(i=>+((i.grossProfitRatio||0)*100).toFixed(2)),
      operatingMargin:inc.map(i=>+((i.operatingIncomeRatio||0)*100).toFixed(2)),
      netMargin:      inc.map(i=>+((i.netIncomeRatio||0)*100).toFixed(2)),
      freeCashFlow:   cf.map(c=>+((c.freeCashFlow||0)/1e9).toFixed(2)),
      operatingCF:    cf.map(c=>+((c.operatingCashFlow||0)/1e9).toFixed(2)),
      capex:          cf.map(c=>+((c.capitalExpenditure||0)/1e9).toFixed(2)),
      fcfMargin:      cf.map((c,i)=>{
        const rev=inc[i]?.revenue;
        return rev?+((c.freeCashFlow||0)/rev*100).toFixed(2):0;
      }),
      dividendPerShare: cf.map((c,i)=>{
        const shares=inc[i]?.weightedAverageShsOutDil;
        const paid=Math.abs(c.dividendsPaid||0);
        return shares&&shares>0?+(paid/shares).toFixed(2):0;
      }),
      totalDebt:      bal.map(b=>+((b.totalDebt||0)/1e9).toFixed(2)),
      totalEquity:    bal.map(b=>+((b.totalStockholdersEquity||0)/1e9).toFixed(2)),
      cash:           bal.map(b=>+((b.cashAndCashEquivalents||0)/1e9).toFixed(2)),
      // Raw 4-year tables for the Financials section
      tableYears: income.slice(0,4).reverse().map(i=>i.calendarYear||i.date?.slice(0,4)),
      tableIncome: [
        {l:'Revenue',          vals:income.slice(0,4).reverse().map(i=>`$${((i.revenue||0)/1e9).toFixed(2)}B`)},
        {l:'Gross Profit',     vals:income.slice(0,4).reverse().map(i=>`$${((i.grossProfit||0)/1e9).toFixed(2)}B`)},
        {l:'Operating Income', vals:income.slice(0,4).reverse().map(i=>`$${((i.operatingIncome||0)/1e9).toFixed(2)}B`)},
        {l:'Net Income',       vals:income.slice(0,4).reverse().map(i=>`$${((i.netIncome||0)/1e9).toFixed(2)}B`)},
        {l:'EBITDA',           vals:income.slice(0,4).reverse().map(i=>`$${((i.ebitda||0)/1e9).toFixed(2)}B`)},
        {l:'EPS (Diluted)',    vals:income.slice(0,4).reverse().map(i=>`$${(i.epsdiluted||i.eps||0).toFixed(2)}`)},
        {l:'Gross Margin',     vals:income.slice(0,4).reverse().map(i=>`${((i.grossProfitRatio||0)*100).toFixed(2)}%`)},
        {l:'Net Margin',       vals:income.slice(0,4).reverse().map(i=>`${((i.netIncomeRatio||0)*100).toFixed(2)}%`)},
      ],
      tableBalance: [
        {l:'Total Assets',    vals:balance.slice(0,4).reverse().map(b=>`$${((b.totalAssets||0)/1e9).toFixed(2)}B`)},
        {l:'Cash',            vals:balance.slice(0,4).reverse().map(b=>`$${((b.cashAndCashEquivalents||0)/1e9).toFixed(2)}B`)},
        {l:'Total Debt',      vals:balance.slice(0,4).reverse().map(b=>`$${((b.totalDebt||0)/1e9).toFixed(2)}B`)},
        {l:'Total Equity',    vals:balance.slice(0,4).reverse().map(b=>`$${((b.totalStockholdersEquity||0)/1e9).toFixed(2)}B`)},
      ],
      tableCF: [
        {l:'Operating CF',    vals:cashflow.slice(0,4).reverse().map(c=>`$${((c.operatingCashFlow||0)/1e9).toFixed(2)}B`)},
        {l:'Free Cash Flow',  vals:cashflow.slice(0,4).reverse().map(c=>`$${((c.freeCashFlow||0)/1e9).toFixed(2)}B`)},
        {l:'CapEx',           vals:cashflow.slice(0,4).reverse().map(c=>`$${((c.capitalExpenditure||0)/1e9).toFixed(2)}B`)},
        {l:'Dividends Paid',  vals:cashflow.slice(0,4).reverse().map(c=>`$${(Math.abs(c.dividendsPaid||0)/1e9).toFixed(2)}B`)},
      ],
    };

    sc(ck,parsed,TTL.fmpFin);
    res.json(parsed);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// FMP Price history — daily close prices for all chart ranges
app.get('/api/fmp/prices/:symbol', async (req,res) => {
  const {symbol}=req.params;
  const ck=`fmp-prices:${symbol}`;
  const hit=gc(ck); if(hit)return res.json(hit);
  try{
    const data=await fmp(`/historical-price-full/${symbol}?serietype=line`);
    const historical=data?.historical||[];
    if(!historical.length) return res.json({});

    const now=Date.now();
    const getRange=days=>{
      const cutoff=new Date(now-days*86_400_000).toISOString().slice(0,10);
      return historical
        .filter(d=>d.date>=cutoff)
        .reverse()
        .map(d=>+d.close.toFixed(2));
    };

    const ph={
      '1M':getRange(30),
      '3M':getRange(90),
      '6M':getRange(180),
      '1Y':getRange(365),
      '5Y':getRange(1825),
    };

    sc(ck,ph,TTL.fmpPrice);
    res.json(ph);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── Health check ──────────────────────────────────────────
app.get('/health', (req,res)=>res.json({status:'ok',cached:cache.size,uptime:process.uptime()}));

// ── SPA fallback ──────────────────────────────────────────
app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT,()=>{
  console.log(`\n✅ MarketLens v2 running → http://localhost:${PORT}`);
  console.log(`   Finnhub: ${FINNHUB_KEY.slice(0,8)}...`);
  console.log(`   FMP:     ${FMP_KEY.slice(0,8)}...\n`);
});
