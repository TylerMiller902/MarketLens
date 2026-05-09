/**
 * MarketLens — Proxy Server v2.4
 * Added: peers endpoint, price dates, competitors
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const FINNHUB_KEY = process.env.FINNHUB_KEY || 'PASTE_FINNHUB_KEY_HERE';
const FMP_KEY     = process.env.FMP_KEY      || 'PASTE_FMP_KEY_HERE';
const FH_BASE     = 'https://finnhub.io/api/v1';
const FMP_BASE    = 'https://financialmodelingprep.com/stable';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const cache = new Map();
const TTL = {
  quote:      15_000, profile: 86_400_000, metrics:  3_600_000,
  news:       300_000, rec:   3_600_000, target:   3_600_000,
  earnings: 3_600_000, search:  600_000, etf:      3_600_000,
  fmpFin:   3_600_000, fmpPrice:300_000, fmpInsiders:1_800_000,
  peers:    1_800_000,
};
const gc = k => { const e=cache.get(k); if(!e)return null; if(Date.now()>e.x){cache.delete(k);return null;} return e.d; };
const sc = (k,d,ttl) => cache.set(k,{d,x:Date.now()+ttl});

async function fh(ep) {
  const sep=ep.includes('?')?'&':'?';
  const r=await fetch(`${FH_BASE}${ep}${sep}token=${FINNHUB_KEY}`,{headers:{'User-Agent':'MarketLens/2.4'}});
  if(!r.ok) throw new Error(`Finnhub ${r.status}`);
  return r.json();
}
async function fmp(ep) {
  const sep=ep.includes('?')?'&':'?';
  const r=await fetch(`${FMP_BASE}${ep}${sep}apikey=${FMP_KEY}`,{headers:{'User-Agent':'MarketLens/2.4'}});
  if(!r.ok) throw new Error(`FMP ${r.status}`);
  const data=await r.json();
  if(data?.['Error Message']) throw new Error(`FMP: ${data['Error Message']}`);
  return data;
}

const pick = (obj,...keys) => { for(const k of keys){if(obj?.[k]!=null&&obj[k]!==''&&!isNaN(obj[k]))return Number(obj[k]);}return null; };
const today = () => new Date().toISOString().slice(0,10);
const dAgo  = n  => new Date(Date.now()-n*86_400_000).toISOString().slice(0,10);
const dFwd  = n  => new Date(Date.now()+n*86_400_000).toISOString().slice(0,10);

// ══════════════════════════════════════════════════════════
//  FINNHUB ROUTES
// ══════════════════════════════════════════════════════════

app.get('/api/search', async (req,res) => {
  const q=req.query.q||''; const ck=`search:${q}`; const hit=gc(ck); if(hit)return res.json(hit);
  try{ const d=await fh(`/search?q=${encodeURIComponent(q)}`); sc(ck,d,TTL.search); res.json(d); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/quote/:symbol', async (req,res) => {
  const {symbol}=req.params; const ck=`quote:${symbol}`; const hit=gc(ck); if(hit)return res.json(hit);
  try{ const d=await fh(`/quote?symbol=${symbol}`); sc(ck,d,TTL.quote); res.json(d); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/market-overview', async (req,res) => {
  const ck='market-overview'; const hit=gc(ck); if(hit)return res.json(hit);
  try{
    const [SPY,QQQ,DIA]=await Promise.all([fh('/quote?symbol=SPY'),fh('/quote?symbol=QQQ'),fh('/quote?symbol=DIA')]);
    const d={SPY,QQQ,DIA}; sc(ck,d,TTL.quote); res.json(d);
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/stock/:symbol', async (req,res) => {
  const {symbol}=req.params; const isETF=req.query.etf==='1';
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

// ── Competitors / Peers (NEW) ─────────────────────────────
app.get('/api/peers/:symbol', async (req,res) => {
  const {symbol}=req.params; const ck=`peers:${symbol}`; const hit=gc(ck); if(hit)return res.json(hit);
  try{
    const peers = await fh(`/stock/peers?symbol=${symbol}`);
    const filtered = (Array.isArray(peers)?peers:[])
      .filter(p=>p!==symbol&&!p.includes('.')&&p.length<8)
      .slice(0,9);
    if(!filtered.length) return res.json([]);

    const [quotes, profiles] = await Promise.all([
      Promise.allSettled(filtered.map(p=>fh(`/quote?symbol=${p}`))),
      Promise.allSettled(filtered.map(p=>fh(`/stock/profile2?symbol=${p}`))),
    ]);

    const result = filtered.map((ticker,i)=>({
      ticker,
      quote:   quotes[i].status==='fulfilled'?quotes[i].value:null,
      profile: profiles[i].status==='fulfilled'?profiles[i].value:null,
    }))
    .filter(p=>p.quote?.c)
    .sort((a,b)=>(b.profile?.marketCapitalization||0)-(a.profile?.marketCapitalization||0))
    .slice(0,7);

    sc(ck,result,TTL.peers);
    res.json(result);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ══════════════════════════════════════════════════════════
//  FMP ROUTES
// ══════════════════════════════════════════════════════════

app.get('/api/fmp/financials/:symbol', async (req,res) => {
  const {symbol}=req.params; const ck=`fmp-fin:${symbol}`; const hit=gc(ck); if(hit)return res.json(hit);
  try{
    const [income,balance,cashflow,keyMetrics]=await Promise.all([
      fmp(`/income-statement?symbol=${symbol}&period=annual&limit=10`),
      fmp(`/balance-sheet-statement?symbol=${symbol}&period=annual&limit=10`),
      fmp(`/cash-flow-statement?symbol=${symbol}&period=annual&limit=10`),
      fmp(`/key-metrics?symbol=${symbol}&period=annual&limit=10`).catch(()=>[]),
    ]);
    if(!Array.isArray(income)||!income.length) return res.json(null);

    const inc=[...income].reverse();
    const bal=[...balance].reverse();
    const cf =[...cashflow].reverse();
    const km =[...(Array.isArray(keyMetrics)?keyMetrics:[])].reverse();

    const netDebt=bal.map(b=>+(((b.totalDebt||0)-(b.cashAndCashEquivalents||0))/1e9).toFixed(2));

    // P/E via earningsYield (FMP stable doesn't include peRatio directly)
    const getPE = k => { const ey=pick(k,'earningsYield'); return ey&&ey>0.001?+((1/ey).toFixed(2)):null; };
    // ROIC — decimal in stable API
    const getROIC = k => { const v=pick(k,'returnOnInvestedCapital','returnOnCapitalEmployed'); if(v==null)return null; const pct=Math.abs(v)<5?v*100:v; return pct>-200&&pct<1000?+pct.toFixed(2):null; };

    const parsed={
      years:           inc.map(i=>i.calendarYear||i.date?.slice(0,4)||''),
      revenue:         inc.map(i=>+((i.revenue||0)/1e9).toFixed(2)),
      grossProfit:     inc.map(i=>+((i.grossProfit||0)/1e9).toFixed(2)),
      operatingIncome: inc.map(i=>+((i.operatingIncome||0)/1e9).toFixed(2)),
      netIncome:       inc.map(i=>+((i.netIncome||0)/1e9).toFixed(2)),
      eps:             inc.map(i=>+(i.epsdiluted||i.eps||0).toFixed(2)),
      grossMargin:     inc.map(i=>+((i.grossProfitRatio||0)*100).toFixed(2)),
      operatingMargin: inc.map(i=>+((i.operatingIncomeRatio||0)*100).toFixed(2)),
      netMargin:       inc.map(i=>+((i.netIncomeRatio||0)*100).toFixed(2)),
      freeCashFlow:    cf.map(c=>+((c.freeCashFlow||0)/1e9).toFixed(2)),
      operatingCF:     cf.map(c=>+((c.operatingCashFlow||0)/1e9).toFixed(2)),
      capex:           cf.map(c=>+((c.capitalExpenditure||0)/1e9).toFixed(2)),
      fcfMargin:       cf.map((c,i)=>{const rev=inc[i]?.revenue;return rev?+((c.freeCashFlow||0)/rev*100).toFixed(2):0;}),
      dividendPerShare:cf.map((c,i)=>{const sh=inc[i]?.weightedAverageShsOutDil;const paid=Math.abs(c.dividendsPaid||0);return sh&&sh>0?+(paid/sh).toFixed(2):0;}),
      totalDebt:       bal.map(b=>+((b.totalDebt||0)/1e9).toFixed(2)),
      totalEquity:     bal.map(b=>+((b.totalStockholdersEquity||0)/1e9).toFixed(2)),
      cash:            bal.map(b=>+((b.cashAndCashEquivalents||0)/1e9).toFixed(2)),
      netDebt,
      sharesOutstanding:inc.map(i=>+((i.weightedAverageShsOutDil||i.weightedAverageShsOut||0)/1e9).toFixed(3)),
      kmYears:         km.map(k=>k.calendarYear||k.date?.slice(0,4)||''),
      peRatio:         km.map(getPE),
      roic:            km.map(getROIC),
      tableYears: income.slice(0,4).reverse().map(i=>i.calendarYear||i.date?.slice(0,4)),
      tableIncome:[
        {l:'Revenue',          vals:income.slice(0,4).reverse().map(i=>`$${((i.revenue||0)/1e9).toFixed(2)}B`)},
        {l:'Gross Profit',     vals:income.slice(0,4).reverse().map(i=>`$${((i.grossProfit||0)/1e9).toFixed(2)}B`)},
        {l:'Operating Income', vals:income.slice(0,4).reverse().map(i=>`$${((i.operatingIncome||0)/1e9).toFixed(2)}B`)},
        {l:'Net Income',       vals:income.slice(0,4).reverse().map(i=>`$${((i.netIncome||0)/1e9).toFixed(2)}B`)},
        {l:'EBITDA',           vals:income.slice(0,4).reverse().map(i=>`$${((i.ebitda||0)/1e9).toFixed(2)}B`)},
        {l:'EPS (Diluted)',    vals:income.slice(0,4).reverse().map(i=>`$${(i.epsdiluted||i.eps||0).toFixed(2)}`)},
        {l:'Gross Margin',     vals:income.slice(0,4).reverse().map(i=>`${((i.grossProfitRatio||0)*100).toFixed(2)}%`)},
        {l:'Net Margin',       vals:income.slice(0,4).reverse().map(i=>`${((i.netIncomeRatio||0)*100).toFixed(2)}%`)},
      ],
      tableBalance:[
        {l:'Total Assets',  vals:balance.slice(0,4).reverse().map(b=>`$${((b.totalAssets||0)/1e9).toFixed(2)}B`)},
        {l:'Cash',          vals:balance.slice(0,4).reverse().map(b=>`$${((b.cashAndCashEquivalents||0)/1e9).toFixed(2)}B`)},
        {l:'Total Debt',    vals:balance.slice(0,4).reverse().map(b=>`$${((b.totalDebt||0)/1e9).toFixed(2)}B`)},
        {l:'Total Equity',  vals:balance.slice(0,4).reverse().map(b=>`$${((b.totalStockholdersEquity||0)/1e9).toFixed(2)}B`)},
      ],
      tableCF:[
        {l:'Operating CF',   vals:cashflow.slice(0,4).reverse().map(c=>`$${((c.operatingCashFlow||0)/1e9).toFixed(2)}B`)},
        {l:'Free Cash Flow', vals:cashflow.slice(0,4).reverse().map(c=>`$${((c.freeCashFlow||0)/1e9).toFixed(2)}B`)},
        {l:'CapEx',          vals:cashflow.slice(0,4).reverse().map(c=>`$${((c.capitalExpenditure||0)/1e9).toFixed(2)}B`)},
        {l:'Dividends Paid', vals:cashflow.slice(0,4).reverse().map(c=>`$${(Math.abs(c.dividendsPaid||0)/1e9).toFixed(2)}B`)},
      ],
    };
    sc(ck,parsed,TTL.fmpFin);
    res.json(parsed);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// FMP Price history — now returns {prices,dates} per range
app.get('/api/fmp/prices/:symbol', async (req,res) => {
  const {symbol}=req.params; const ck=`fmp-prices:${symbol}`; const hit=gc(ck); if(hit)return res.json(hit);
  try{
    const data=await fmp(`/historical-price-eod/light?symbol=${symbol}`);
    const historical=Array.isArray(data)?data:[];
    if(!historical.length) return res.json({});
    const now=Date.now();
    const getRange=days=>{
      const cutoff=new Date(now-days*86_400_000).toISOString().slice(0,10);
      const filtered=historical.filter(d=>d.date>=cutoff).reverse();
      return{
        prices: filtered.map(d=>+(d.price||d.close||0).toFixed(2)),
        dates:  filtered.map(d=>d.date),
      };
    };
    const ph={
      '1M':getRange(30),'3M':getRange(90),'6M':getRange(180),
      '1Y':getRange(365),'5Y':getRange(1825),
    };
    sc(ck,ph,TTL.fmpPrice);
    res.json(ph);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// Insider transactions
app.get('/api/fmp/insiders/:symbol', async (req,res) => {
  const {symbol}=req.params; const ck=`fmp-ins:${symbol}`; const hit=gc(ck); if(hit)return res.json(hit);
  try{
    const data=await fmp(`/insider-trading?symbol=${symbol}&limit=30`);
    const rows=Array.isArray(data)?data:[];
    const cleaned=rows.filter(r=>r.transactionType&&r.securitiesTransacted).map(r=>{
      const isBuy=r.acquistionOrDisposition==='A'||r.transactionType==='P-Purchase';
      const value=(r.securitiesTransacted||0)*(r.price||0);
      return{date:r.transactionDate||r.filingDate||'',name:r.reportingName||'Unknown',title:r.typeOfOwner||'',type:isBuy?'Buy':'Sell',shares:Math.abs(r.securitiesTransacted||0),price:r.price||0,value:Math.abs(value),isBuy};
    }).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,20);
    const monthly={};
    cleaned.forEach(r=>{const mo=r.date.slice(0,7);if(!monthly[mo])monthly[mo]={month:mo,buyValue:0,sellValue:0};if(r.isBuy)monthly[mo].buyValue+=r.value;else monthly[mo].sellValue+=r.value;});
    const monthlyArr=Object.values(monthly).sort((a,b)=>a.month.localeCompare(b.month)).slice(-12);
    const result={transactions:cleaned,monthly:monthlyArr};
    sc(ck,result,TTL.fmpInsiders);
    res.json(result);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// Debug endpoint
app.get('/api/debug/key-metrics/:symbol', async (req,res) => {
  try{ const data=await fmp(`/key-metrics?symbol=${req.params.symbol}&period=annual&limit=1`); const first=Array.isArray(data)?data[0]:data; res.json({fieldNames:first?Object.keys(first):[],sample:first}); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/health',(req,res)=>res.json({status:'ok',cached:cache.size,uptime:process.uptime()}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
// Export for Vercel serverless, listen for Railway/local
module.exports = app;
if (require.main === module) {
  app.listen(PORT, () => console.log(`\n✅ MarketLens v2.4 → http://localhost:${PORT}\n`));
}
