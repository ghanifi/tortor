// src/analysis/event-engine.js
// Layer 5: Event Engine — blocks new entries near earnings dates.
//
// Prevents entering fresh positions in the 5 days before and 2 days after
// a company's earnings release. Earnings gaps can violate every stop level.
//
// Crypto symbols (no earnings) are always unblocked.
// In-memory cache refreshes every 24 hours per symbol.

const axios = require('axios');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Known crypto base tickers — earnings check skipped for these
const CRYPTO_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'ADA', 'XRP', 'DOGE', 'AVAX', 'DOT', 'MATIC']);

const earningsCache = {};

/**
 * Fetch the next earnings date for a symbol from Yahoo Finance.
 * Returns a Date or null (on error or no data).
 *
 * @param {string} symbol  e.g. 'AAPL', 'NVDA'
 * @returns {Promise<Date|null>}
 */
async function fetchEarningsDate(symbol) {
  const cached = earningsCache[symbol];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.earningsDate;
  }

  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: 6000,
      httpsAgent,
    });

    const result = res.data?.quoteSummary?.result?.[0];
    const rawDates = result?.calendarEvents?.earnings?.earningsDate;
    let earningsDate = null;

    if (Array.isArray(rawDates) && rawDates.length > 0) {
      // Yahoo returns Unix epoch in .raw; pick the first upcoming or most recent date
      const dates = rawDates
        .map(d => (typeof d === 'object' ? d.raw : d))
        .filter(Boolean)
        .map(ts => new Date(ts * 1000))
        .sort((a, b) => a - b);

      // Prefer the nearest future date; fall back to most recent past date
      const now = new Date();
      const future = dates.filter(d => d >= now);
      earningsDate = future.length ? future[0] : dates[dates.length - 1];
    }

    earningsCache[symbol] = { fetchedAt: Date.now(), earningsDate };
    return earningsDate;
  } catch (err) {
    console.warn(`[Events] Earnings fetch failed for ${symbol}:`, err.message);
    earningsCache[symbol] = { fetchedAt: Date.now(), earningsDate: null };
    return null;
  }
}

/**
 * Check whether a new entry should be blocked due to an upcoming/recent earnings event.
 *
 * @param {string}    symbol
 * @param {Date|null} earningsDate   result of fetchEarningsDate()
 * @param {number}    daysBefore     block N days before earnings  (default 5)
 * @param {number}    daysAfter      block M days after  earnings  (default 2)
 * @returns {{ blocked: boolean, reason?: string }}
 */
function isEarningsBlocked(symbol, earningsDate, daysBefore = 5, daysAfter = 2) {
  if (!earningsDate) return { blocked: false };

  const daysUntil = (earningsDate - Date.now()) / (1000 * 60 * 60 * 24);

  if (daysUntil <= daysBefore && daysUntil >= -daysAfter) {
    const label = daysUntil >= 0
      ? `${Math.ceil(daysUntil)} gün kaldı`
      : `${Math.ceil(-daysUntil)} gün önce`;
    return {
      blocked: true,
      reason: `Kazanç raporu yakın: ${earningsDate.toISOString().slice(0, 10)} (${label})`,
    };
  }

  return { blocked: false };
}

/**
 * High-level helper: fetch earnings date then check if entry should be blocked.
 * Returns { blocked, reason?, earningsDate? }
 *
 * @param {string} symbol
 * @param {object} [opts]
 * @param {number} [opts.daysBefore=5]
 * @param {number} [opts.daysAfter=2]
 * @returns {Promise<{ blocked: boolean, reason?: string, earningsDate?: Date }>}
 */
async function checkEarningsBlock(symbol, { daysBefore = 5, daysAfter = 2 } = {}) {
  // Crypto doesn't have earnings
  if (CRYPTO_SYMBOLS.has(symbol.replace('-USD', '').toUpperCase())) {
    return { blocked: false };
  }

  const earningsDate = await fetchEarningsDate(symbol);
  const result = isEarningsBlocked(symbol, earningsDate, daysBefore, daysAfter);
  return { ...result, earningsDate: earningsDate || undefined };
}

module.exports = { fetchEarningsDate, isEarningsBlocked, checkEarningsBlock };
