// src/analysis/research.js
// Reads cached research data from the bridge server and extracts
// analyst consensus signals (buy/hold/sell counts, price targets).
//
// The actual eToro research API endpoints are discovered at runtime —
// whatever structure arrives is normalized here.

const axios = require('axios');
const https = require('https');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const BRIDGE_URL = 'http://localhost:3737';

// Fetch all cached research data from the server.
// Returns { '/api/research/.../SNDK': { apiUrl, data, savedAt }, ... }
async function fetchResearchCache() {
  try {
    const res = await axios.get(`${BRIDGE_URL}/research-cache`, { timeout: 3000, httpsAgent });
    return res.data?.cache || {};
  } catch (_) {
    return {};
  }
}

// Extract analyst consensus from a research API response.
// Tries multiple known eToro response shapes — new shapes can be added as
// the actual endpoints are discovered.
// Returns: { buy, hold, sell, total, priceTarget, priceTargetLow, priceTargetHigh }
// or null if the data doesn't contain recognizable analyst fields.
function extractConsensus(data) {
  if (!data || typeof data !== 'object') return null;

  // Shape 1: { Ratings: { Buy, Hold, Sell }, PriceTarget: { Consensus, Low, High } }
  if (data.Ratings && (data.Ratings.Buy != null || data.Ratings.Hold != null)) {
    const { Buy = 0, Hold = 0, Sell = 0 } = data.Ratings;
    return {
      buy: Buy, hold: Hold, sell: Sell, total: Buy + Hold + Sell,
      priceTarget: data.PriceTarget?.Consensus || null,
      priceTargetLow: data.PriceTarget?.Low || null,
      priceTargetHigh: data.PriceTarget?.High || null,
    };
  }

  // Shape 2: { consensus: { buy, hold, sell }, priceTarget: { average, low, high } }
  if (data.consensus && (data.consensus.buy != null || data.consensus.hold != null)) {
    const { buy = 0, hold = 0, sell = 0 } = data.consensus;
    return {
      buy, hold, sell, total: buy + hold + sell,
      priceTarget: data.priceTarget?.average || data.priceTarget?.consensus || null,
      priceTargetLow: data.priceTarget?.low || null,
      priceTargetHigh: data.priceTarget?.high || null,
    };
  }

  // Shape 3: flat array of analyst ratings [{ rating: 'Buy'|'Hold'|'Sell', targetPrice }]
  if (Array.isArray(data)) {
    let buy = 0, hold = 0, sell = 0, targets = [];
    for (const a of data) {
      const r = (a.rating || a.Rating || '').toLowerCase();
      if (r === 'buy' || r === 'outperform' || r === 'overweight') buy++;
      else if (r === 'hold' || r === 'neutral' || r === 'equalweight') hold++;
      else if (r === 'sell' || r === 'underperform' || r === 'underweight') sell++;
      const t = a.targetPrice || a.TargetPrice || a.priceTarget;
      if (t) targets.push(Number(t));
    }
    if (buy + hold + sell > 0) {
      return {
        buy, hold, sell, total: buy + hold + sell,
        priceTarget: targets.length ? targets.reduce((a, b) => a + b, 0) / targets.length : null,
        priceTargetLow: targets.length ? Math.min(...targets) : null,
        priceTargetHigh: targets.length ? Math.max(...targets) : null,
      };
    }
  }

  // Shape 4: nested under a symbol or instrument key — recurse one level
  for (const key of Object.keys(data)) {
    const val = data[key];
    if (val && typeof val === 'object') {
      const result = extractConsensus(val);
      if (result) return result;
    }
  }

  return null;
}

// Build a map of { SYMBOL: consensus } from the server's research cache.
// Each consensus object: { buy, hold, sell, total, priceTarget, consensusSignal }
// consensusSignal: 'bullish' | 'bearish' | 'neutral'
async function loadResearchSignals() {
  const cache = await fetchResearchCache();
  const signals = {};

  for (const [url, entry] of Object.entries(cache)) {
    // Try to extract symbol from URL: /markets/sndk/research or /api/.../SNDK/...
    const symbolMatch = url.match(/\/markets\/([a-z0-9._-]+)\/|\/([A-Z0-9._-]{1,12})\//i);
    const symbol = symbolMatch ? (symbolMatch[1] || symbolMatch[2]).toUpperCase() : null;
    if (!symbol) continue;

    const consensus = extractConsensus(entry.data);
    if (!consensus || consensus.total === 0) continue;

    const buyPct = consensus.buy / consensus.total;
    const sellPct = consensus.sell / consensus.total;
    const consensusSignal = buyPct >= 0.6 ? 'bullish' : sellPct >= 0.5 ? 'bearish' : 'neutral';

    signals[symbol] = { ...consensus, buyPct, sellPct, consensusSignal, updatedAt: entry.savedAt };
  }

  return signals;
}

module.exports = { loadResearchSignals, extractConsensus };
