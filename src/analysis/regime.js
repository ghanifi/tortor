// src/analysis/regime.js
const axios = require('axios');

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

async function fetchSP500History() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=1y';
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    timeout: 10000
  });
  const closes = res.data.chart.result[0].indicators.quote[0].close;
  return closes.filter(Boolean);
}

async function fetchBTCDominanceHistory() {
  const url = 'https://api.coingecko.com/api/v3/global';
  const res = await axios.get(url, { timeout: 10000 });
  const current = res.data.data.market_cap_percentage.btc;
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

module.exports = {
  sma,
  fetchSP500History,
  fetchBTCDominanceHistory,
  detectEquityRegime,
  detectCryptoRegime,
  detectAssetRegime,
  applyRegimeAdjustments
};
