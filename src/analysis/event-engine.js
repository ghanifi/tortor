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

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// All eToro crypto tickers — earnings check skipped for all of them
const CRYPTO_SYMBOLS = new Set([
  'BTC','ETH','XRP','ADA','SOL','DOT','BNB','AVAX','DOGE','LTC','LINK','UNI',
  'MATIC','ATOM','ALGO','NEAR','FTM','HBAR','ETC','TRX','XLM','VET','SAND',
  'MANA','AXS','ENJ','CHZ','FIL','THETA','CRO','AAVE','COMP','MKR','SNX',
  'APE','GALA','GRT','FLOW','ICP','EGLD','ONE','STX','ZIL','BAT','SHIB',
  'DOGECOIN', // eToro-specific alias
]);

const earningsCache = {};

// ── Yahoo Finance crumb session ────────────────────────────────────────────────
// Yahoo v10 API requires a crumb + session cookie obtained from finance.yahoo.com.
// Session is cached for the lifetime of the process; reset on 401 and retried once.

let _yahooSession = null;

async function getYahooSession() {
  if (_yahooSession) return _yahooSession;

  // Step 1: hit Yahoo Finance to get session cookies
  const cookieRes = await axios.get('https://finance.yahoo.com', {
    headers: { 'User-Agent': YAHOO_UA },
    httpsAgent,
    timeout: 10000,
    maxRedirects: 5,
  });
  const cookies = (cookieRes.headers['set-cookie'] || [])
    .map(c => c.split(';')[0])
    .join('; ');

  // Step 2: exchange cookies for a crumb token
  const crumbRes = await axios.get('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': YAHOO_UA, Cookie: cookies },
    httpsAgent,
    timeout: 6000,
  });

  _yahooSession = { cookies, crumb: String(crumbRes.data).trim() };
  return _yahooSession;
}

/**
 * Fetch the next earnings date for a symbol from Yahoo Finance.
 * Uses crumb + cookie auth required by Yahoo's v10 API.
 * Returns a Date or null (on error or no data).
 */
async function fetchEarningsDate(symbol) {
  const cached = earningsCache[symbol];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.earningsDate;
  }

  try {
    const session = await getYahooSession();
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
                `?modules=calendarEvents&crumb=${encodeURIComponent(session.crumb)}`;

    const res = await axios.get(url, {
      headers: { 'User-Agent': YAHOO_UA, Cookie: session.cookies },
      timeout: 6000,
      httpsAgent,
    });

    const result = res.data?.quoteSummary?.result?.[0];
    const rawDates = result?.calendarEvents?.earnings?.earningsDate;
    let earningsDate = null;

    if (Array.isArray(rawDates) && rawDates.length > 0) {
      const dates = rawDates
        .map(d => (typeof d === 'object' ? d.raw : d))
        .filter(Boolean)
        .map(ts => new Date(ts * 1000))
        .sort((a, b) => a - b);

      const now = new Date();
      const future = dates.filter(d => d >= now);
      earningsDate = future.length ? future[0] : dates[dates.length - 1];
    }

    earningsCache[symbol] = { fetchedAt: Date.now(), earningsDate };
    return earningsDate;

  } catch (err) {
    // On 401: crumb may have expired — reset session so next call re-authenticates
    if (err.response?.status === 401) {
      _yahooSession = null;
      console.warn(`[Events] Earnings 401 for ${symbol} — session reset, will retry next cycle`);
    } else {
      console.warn(`[Events] Earnings fetch failed for ${symbol}: ${err.message}`);
    }
    earningsCache[symbol] = { fetchedAt: Date.now(), earningsDate: null };
    return null;
  }
}

/**
 * Check whether a new entry should be blocked due to an upcoming/recent earnings event.
 */
function isEarningsBlocked(symbol, earningsDate, daysBefore = 5, daysAfter = 2) {
  if (!earningsDate) return { blocked: false };

  const daysUntil = (earningsDate - Date.now()) / (1000 * 60 * 60 * 24);

  if (daysUntil <= daysBefore && daysUntil >= -daysAfter) {
    const label = daysUntil >= 0
      ? `${Math.ceil(daysUntil)} days until`
      : `${Math.ceil(-daysUntil)} days after`;
    return {
      blocked: true,
      reason: `Earnings near: ${earningsDate.toISOString().slice(0, 10)} (${label})`,
    };
  }

  return { blocked: false };
}

/**
 * High-level helper: fetch earnings date then check if entry should be blocked.
 */
async function checkEarningsBlock(symbol, { daysBefore = 5, daysAfter = 2 } = {}) {
  if (CRYPTO_SYMBOLS.has(symbol.replace('-USD', '').toUpperCase())) {
    return { blocked: false };
  }

  const earningsDate = await fetchEarningsDate(symbol);
  const result = isEarningsBlocked(symbol, earningsDate, daysBefore, daysAfter);
  return { ...result, earningsDate: earningsDate || undefined };
}

module.exports = { fetchEarningsDate, isEarningsBlocked, checkEarningsBlock };
