// src/analysis/relative-strength.js
// Layer 3: Relative Strength — dual-window: 20-day (60%) + 63-day (40%) vs benchmark
const axios = require('axios');
const https = require('https');

// Bypass SSL inspection proxy that presents self-signed certs
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const CRYPTO_SYMBOLS = new Set(['BTC', 'ETH', 'XRP', 'ADA', 'SOL', 'DOT', 'BNB', 'AVAX']);

function getExchangeBenchmark(symbol) {
  if (symbol.endsWith('.L')) return '^FTSE';
  if (symbol === 'BTC' || symbol === 'BTC-USD') return 'SPY';      // BTC vs equities
  if (CRYPTO_SYMBOLS.has(symbol) || symbol.endsWith('-USD')) return 'BTC-USD'; // alts vs BTC
  return 'SPY';
}

function calcRelativeStrength(assetReturn, benchmarkReturn) {
  const raw_rs = assetReturn - benchmarkReturn;
  return Math.min(100, Math.max(0, 50 + raw_rs * 8));
}

async function fetchBenchmarkReturns(symbols) {
  const returns = {};
  await Promise.all(symbols.map(async sym => {
    const encoded = encodeURIComponent(sym);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=4mo`;
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 10000,
        httpsAgent
      });
      const closes = (res.data.chart.result[0].indicators.quote[0].close || []).filter(Boolean);
      if (closes.length >= 21) {
        const ret20 = ((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100;
        const ret63 = closes.length >= 64
          ? ((closes[closes.length - 1] - closes[closes.length - 64]) / closes[closes.length - 64]) * 100
          : ret20;
        returns[sym] = ret20 * 0.6 + ret63 * 0.4;
      } else {
        returns[sym] = 0;
      }
    } catch (err) {
      console.warn(`[RS] Benchmark ${sym} fetch failed:`, err.message);
      returns[sym] = 0;
    }
  }));
  return returns;
}

module.exports = { getExchangeBenchmark, calcRelativeStrength, fetchBenchmarkReturns };
