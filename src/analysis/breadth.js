// src/analysis/breadth.js
// Layer 4: Market Breadth Engine
//
// Measures how broad the equity rally is by checking how many of the 11 SPDR
// sector ETFs are trading above their 50-day SMA.
//
// A narrow rally (e.g. only tech leading) is fragile; breadth confirms that
// multiple sectors are participating and the move has healthy underpinning.
//
// Score: count of sectors above 50-day SMA (0–11)
// State thresholds:
//   BROAD  : ≥ 7 sectors above 50d SMA  (≥ 64%)
//   NARROW : 4–6 sectors                 (36–55%)
//   WEAK   : ≤ 3 sectors                 (≤ 27%)
//
// Cache: stored in state.breadth_state, refreshed once per hour.

const axios = require('axios');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const SECTOR_ETFS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLC', 'XLY', 'XLP', 'XLRE', 'XLB', 'XLU'];
const CACHE_MINUTES = 60;

function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Fetch 3-month daily closes for a single sector ETF.
 * Returns an array of closing prices or null on failure.
 */
async function fetchSectorCloses(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=3mo`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 8000,
      httpsAgent,
    });
    const quote = res.data?.chart?.result?.[0]?.indicators?.quote?.[0];
    const closes = (quote?.close || []).filter(Boolean);
    return closes.length ? closes : null;
  } catch {
    return null;
  }
}

/**
 * Fetch all 11 sector ETF histories in parallel.
 * Returns a map of { symbol: closes[] | null }.
 */
async function fetchSectorHistories() {
  const results = await Promise.all(SECTOR_ETFS.map(s => fetchSectorCloses(s)));
  const map = {};
  SECTOR_ETFS.forEach((s, i) => { map[s] = results[i]; });
  return map;
}

/**
 * Calculate breadth score from sector histories.
 *
 * @param {Object} sectorHistories  { XLK: closes[], XLF: closes[], ... }
 * @returns {{ score: number, count: number, total: number, sectors: object, state: string }}
 */
function calcBreadthScore(sectorHistories) {
  const sectors = {};
  let count = 0;
  let total = 0;

  for (const [sym, closes] of Object.entries(sectorHistories)) {
    if (!closes || closes.length < 50) {
      sectors[sym] = null; // insufficient data
      continue;
    }
    total++;
    const ma50  = sma(closes, 50);
    const price = closes[closes.length - 1];
    const above = price > ma50;
    sectors[sym] = { price: +price.toFixed(2), ma50: +ma50.toFixed(2), aboveMa50: above };
    if (above) count++;
  }

  let state;
  if (count >= 7)      state = 'BROAD';
  else if (count >= 4) state = 'NARROW';
  else                 state = 'WEAK';

  return { score: count, count, total, sectors, state };
}

/**
 * Get breadth state with 60-minute cache stored in state.breadth_state.
 *
 * @param {object} appState  The bot's runtime state object (from loadState())
 * @returns {Promise<{ score: number, count: number, total: number, state: string, last_fetch: string }>}
 */
async function getBreadthState(appState) {
  const cached = appState.breadth_state || {};
  const lastFetch = cached.last_fetch ? new Date(cached.last_fetch).getTime() : 0;
  const cacheMs = CACHE_MINUTES * 60 * 1000;

  if (Date.now() - lastFetch < cacheMs) {
    return {
      score: cached.score, count: cached.count, total: cached.total,
      state: cached.state, last_fetch: cached.last_fetch,
    };
  }

  const histories = await fetchSectorHistories();
  const result = calcBreadthScore(histories);
  return { ...result, last_fetch: new Date().toISOString() };
}

module.exports = { fetchSectorHistories, calcBreadthScore, getBreadthState, SECTOR_ETFS };
