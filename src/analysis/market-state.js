// src/analysis/market-state.js
// Layer 1: Global Market State — scores macro environment 0-100
const axios = require('axios');
const https = require('https');

// Bypass SSL inspection proxy that presents self-signed certs
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

async function fetchYahoo(symbol, range = '1y') {
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=${range}`;
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    timeout: 10000,
    httpsAgent
  });
  const result = res.data?.chart?.result;
  if (!result || !result[0]) throw new Error(`fetchYahoo: no result for ${symbol}`);
  const quote = result[0].indicators.quote[0];
  const closes = (quote.close || []).filter(Boolean);
  if (!closes.length) throw new Error(`fetchYahoo: empty closes for ${symbol}`);
  return closes;
}

async function fetchMarketStateData() {
  const [spy, qqq, vix, dxy, us10y, btc] = await Promise.all([
    fetchYahoo('SPY'),
    fetchYahoo('QQQ'),
    fetchYahoo('^VIX'),
    fetchYahoo('DX-Y.NYB'),
    fetchYahoo('^TNX'),
    fetchYahoo('BTC-USD'),
  ]);

  return {
    spy:   { closes: spy,   price: spy[spy.length - 1] },
    qqq:   { closes: qqq,   price: qqq[qqq.length - 1] },
    vix:   { price: vix[vix.length - 1] },
    dxy:   { closes: dxy,   price: dxy[dxy.length - 1] },
    us10y: { price: us10y[us10y.length - 1], price30dAgo: us10y[Math.max(0, us10y.length - 31)] },
    btc:   { closes: btc,   price: btc[btc.length - 1] },
  };
}

function calcMarketStateScore(data) {
  let score = 0;

  // SPY close > 50-day SMA → +20
  const spy50 = sma(data.spy.closes, 50);
  if (spy50 && data.spy.price > spy50) score += 20;

  // QQQ close > 50-day SMA → +15
  const qqq50 = sma(data.qqq.closes, 50);
  if (qqq50 && data.qqq.price > qqq50) score += 15;

  // VIX: <20 → +20, 20-30 → +10, >30 → +0
  if (data.vix.price < 20) score += 20;
  else if (data.vix.price <= 30) score += 10;

  // DXY close < 20-day SMA (weak dollar = risk-on) → +15
  const dxy20 = sma(data.dxy.closes, 20);
  if (dxy20 && data.dxy.price < dxy20) score += 15;

  // US10Y current ≤ 30 days ago (stable or falling) → +15
  if (data.us10y.price <= data.us10y.price30dAgo) score += 15;

  // BTC bull regime: price > MA50 AND MA50 > MA200 → +15
  const btc50  = sma(data.btc.closes, 50);
  const btc200 = sma(data.btc.closes, 200);
  if (btc50 && btc200 && data.btc.price > btc50 && btc50 > btc200) score += 15;

  let state;
  if (score >= 70)      state = 'RISK_ON';
  else if (score >= 40) state = 'RISK_NEUTRAL';
  else if (score >= 20) state = 'RISK_OFF';
  else                  state = 'PANIC';

  return { state, score };
}

async function getMarketState(state) {
  const ms = state.market_state || {};
  const lastFetch = ms.last_fetch ? new Date(ms.last_fetch).getTime() : 0;
  const cacheMs = 60 * 60 * 1000; // 60 minutes

  if (Date.now() - lastFetch < cacheMs) {
    return { state: ms.state, score: ms.score, last_fetch: ms.last_fetch };
  }

  const data = await fetchMarketStateData();
  const result = calcMarketStateScore(data);
  return { ...result, last_fetch: new Date().toISOString() };
}

module.exports = { fetchMarketStateData, calcMarketStateScore, getMarketState };
