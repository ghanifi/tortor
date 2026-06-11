// src/analysis/regime.js
const axios = require('axios');
const https = require('https');
const { calculateADX, calculateATR, calculateEMA } = require('./indicators');

// Bypass SSL inspection proxy that presents self-signed certs
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

async function fetchSP500History() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1y';
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    timeout: 10000,
    httpsAgent
  });
  const closes = res.data.chart.result[0].indicators.quote[0].close;
  return closes.filter(Boolean);
}

async function fetchBTCDominanceHistory() {
  const url = 'https://api.alternative.me/v2/global/';
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    timeout: 10000,
    httpsAgent
  });
  // alternative.me returns a ratio (0.625 = 62.5%); convert to percentage for consistency
  const current = res.data.data.bitcoin_percentage_of_market_cap * 100;
  return { current, weekAgo: current };
}

function detectEquityRegime(closes) {
  const price = closes[closes.length - 1];
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  if (!ma50 || !ma200) return 'sideways';
  if (price > ma200 && ma50 > ma200) return 'bull';
  if (price < ma200) return 'bear';
  return 'sideways';
}

function detectCryptoRegime(btcDominanceCurrent, btcDominanceWeekAgo) {
  if (btcDominanceWeekAgo === null || btcDominanceWeekAgo === undefined) return 'sideways';
  const change = btcDominanceCurrent - btcDominanceWeekAgo;
  if (change > 1) return 'bear';
  if (change < -1) return 'bull';
  return 'sideways';
}

function detectAssetRegime(closes) {
  if (closes.length < 14) return { trend: 'sideways', volatility: 'normal' };
  const period = Math.min(50, closes.length);
  const ma = sma(closes, period);
  const price = closes[closes.length - 1];
  const trend = price > ma ? 'bull' : price < ma ? 'bear' : 'sideways';

  const recent = closes.slice(-14);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length;
  const stdDev = Math.sqrt(variance);
  const volatility = (stdDev / mean) > 0.03 ? 'high' : 'normal';

  return { trend, volatility };
}

function applyRegimeAdjustments(baseThresholds, macroEquity, macroCrypto, assetClass, assetRegime) {
  const thresholds = {
    buy: baseThresholds.buy,
    sell: [...baseThresholds.sell]
  };
  let budgetMultiplier = 1.0;
  const macro = assetClass === 'crypto' ? macroCrypto : macroEquity;

  if (macro === 'bear') {
    thresholds.buy -= 3;
    budgetMultiplier *= 0.7;
  } else if (macro === 'sideways') {
    thresholds.buy -= 1;
    budgetMultiplier *= 0.9;
  }

  if (assetRegime.trend === 'bear') {
    thresholds.buy -= 2;
    budgetMultiplier *= 0.8;
  }

  return { thresholds, budgetMultiplier };
}

function detectAssetRegimeV3(closes, highs, lows) {
  if (closes.length < 14) return { trend: 'SIDEWAYS', adx: null, atr: null };

  const ema50  = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);

  let trend;
  if (ema50 && ema200 && ema50 > ema200)      trend = 'BULL';
  else if (ema50 && ema200 && ema50 < ema200) trend = 'BEAR';
  else                                         trend = 'SIDEWAYS';

  const adx = calculateADX(highs, lows, closes);
  const atr = calculateATR(highs, lows, closes);

  return { trend, adx, atr };
}

// Yahoo Finance symbol overrides for non-standard tickers
const YAHOO_SYMBOL_MAP = {
  // Crypto — eToro display names → Yahoo Finance tickers
  'BTC': 'BTC-USD',
  'ETH': 'ETH-USD',
  'XRP': 'XRP-USD',
  'ADA': 'ADA-USD',
  'SOL': 'SOL-USD',
  'DOT': 'DOT-USD',
  'BNB': 'BNB-USD',
  'AVAX': 'AVAX-USD',
  'DOGECOIN': 'DOGE-USD',  // eToro returns "DOGECOIN" as instrument symbol
  'DOGE': 'DOGE-USD',
  // London Stock Exchange (eToro suffix .L → Yahoo suffix .L)
  'RR.L': 'RR.L',
  'VOD.L': 'VOD.L',
  'BP.L': 'BP.L',
  // Frankfurt (eToro .DE → Yahoo .DE)
  'VOW3.DE': 'VOW3.DE',
};

// Fetch current prices for a list of ticker symbols from Yahoo Finance.
// Returns { TSLA: 312.5, AAPL: 189.3, BTC: 67200, ... }
// Silently skips symbols that fail.
async function fetchSymbolPrices(symbols) {
  const prices = {};
  await Promise.all(symbols.map(async sym => {
    const yahooSym = YAHOO_SYMBOL_MAP[sym] || sym;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=5d`;
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 8000,
        httpsAgent
      });
      const closes = res.data.chart.result[0].indicators.quote[0].close.filter(Boolean);
      if (closes.length) prices[sym] = closes[closes.length - 1];
    } catch (err) {
      console.warn(`[Prices] ${sym} fetch failed:`, err.message);
    }
  }));
  return prices;
}

// Fetch 3-month OHLCV history for a single symbol.
// Returns { closes, highs, lows, opens, volumes } arrays (nulls filtered out).
// Used to compute RSI, MACD, Bollinger bands.
async function fetchSymbolHistory(symbol, range = '3mo') {
  const yahooSym = YAHOO_SYMBOL_MAP[symbol] || symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=${range}`;
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    timeout: 8000,
    httpsAgent
  });
  const quote = res.data.chart.result[0].indicators.quote[0];
  // Filter out null candles (non-trading days sometimes appear)
  const raw = (quote.close || []).map((c, i) => ({
    c, h: (quote.high || [])[i], l: (quote.low || [])[i],
    o: (quote.open || [])[i], v: (quote.volume || [])[i]
  })).filter(d => d.c != null && d.h != null && d.l != null);

  return {
    closes:  raw.map(d => d.c),
    highs:   raw.map(d => d.h),
    lows:    raw.map(d => d.l),
    opens:   raw.map(d => d.o),
    volumes: raw.map(d => d.v),
  };
}

// Batch-fetch OHLCV history for multiple symbols in parallel.
// Returns { SNDK: { closes, highs, lows, ... }, AAPL: {...}, ... }
// Silently skips symbols that fail.
async function fetchSymbolHistories(symbols, range = '3mo') {
  const result = {};
  await Promise.all(symbols.map(async sym => {
    try {
      result[sym] = await fetchSymbolHistory(sym, range);
    } catch (err) {
      console.warn(`[History] ${sym} fetch failed:`, err.message);
    }
  }));
  return result;
}

module.exports = {
  sma,
  fetchSP500History,
  fetchBTCDominanceHistory,
  fetchSymbolPrices,
  fetchSymbolHistory,
  fetchSymbolHistories,
  detectEquityRegime,
  detectCryptoRegime,
  detectAssetRegime,
  detectAssetRegimeV3,
  applyRegimeAdjustments
};
