// src/analysis/spread-logger.js
// Phase 1 instrumentation — logs bid/ask spreads per cycle to a CSV.
// STRATEGY LOGIC UNCHANGED: this module only reads and records data.
'use strict';

const axios = require('axios');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const httpsAgent    = new https.Agent({ rejectUnauthorized: false });
const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

const DATA_DIR   = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const LOG_DIR    = path.join(DATA_DIR, 'logs');
const SPREAD_CSV = path.join(LOG_DIR, 'spread_log.csv');

// Mirrors regime.js YAHOO_SYMBOL_MAP (kept local to avoid circular deps)
const YAHOO_SYM = {
  BTC: 'BTC-USD', ETH: 'ETH-USD', XRP: 'XRP-USD', ADA: 'ADA-USD',
  SOL: 'SOL-USD', DOT: 'DOT-USD', BNB: 'BNB-USD', AVAX: 'AVAX-USD',
  DOGE: 'DOGE-USD', DOGECOIN: 'DOGE-USD',
  'RR.L': 'RR.L', 'VOD.L': 'VOD.L', 'BP.L': 'BP.L', 'VOW3.DE': 'VOW3.DE',
};

function toYahoo(sym) { return YAHOO_SYM[sym] || sym; }

function ensureCSV() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(SPREAD_CSV)) {
    fs.writeFileSync(SPREAD_CSV,
      'timestamp,symbol,bid,ask,spread_pct,bid_size,ask_size,note\n');
  }
}

// Returns { [etoroSymbol]: { bid, ask, bidSize, askSize, price } }
async function fetchSpreadData(symbols) {
  const yahooSyms = [...new Set(symbols.map(toYahoo))];
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${yahooSyms.join(',')}&fields=bid,ask,bidSize,askSize,regularMarketPrice`;
  const res = await axios.get(url, { headers: YAHOO_HEADERS, timeout: 10000, httpsAgent });
  const results = res.data.quoteResponse?.result || [];

  const out = {};
  for (const q of results) {
    const etoroSym = symbols.find(s => toYahoo(s) === q.symbol) || q.symbol;
    // bid/ask of 0 means unavailable (market closed or crypto) — treat as null
    out[etoroSym] = {
      bid:     (q.bid     > 0) ? q.bid     : null,
      ask:     (q.ask     > 0) ? q.ask     : null,
      bidSize: q.bidSize ?? null,
      askSize: q.askSize ?? null,
      price:   q.regularMarketPrice ?? null,
    };
  }
  return out;
}

// Fetches spread data and appends rows to spread_log.csv.
// Returns the raw spread map (for reuse in the same cycle).
async function logSpreads(symbols) {
  ensureCSV();
  const ts = new Date().toISOString();
  let data;
  try {
    data = await fetchSpreadData(symbols);
  } catch (err) {
    console.warn('[SpreadLogger] Fetch failed:', err.message);
    return {};
  }

  const rows = [];
  for (const sym of symbols) {
    const d = data[sym];
    if (!d) continue;
    const { bid, ask, bidSize, askSize } = d;

    let spread_pct = '';
    let note = 'Yahoo bid/ask — taban maliyet; gercek eToro maliyeti bunun ustunde';
    if (bid != null && ask != null && bid > 0) {
      spread_pct = ((ask - bid) / bid * 100).toFixed(4);
    } else {
      note = 'bid/ask yok (piyasa kapali veya crypto)';
    }
    rows.push(
      `${ts},${sym},${bid ?? ''},${ask ?? ''},${spread_pct},${bidSize ?? ''},${askSize ?? ''},"${note}"`
    );
  }
  if (rows.length) fs.appendFileSync(SPREAD_CSV, rows.join('\n') + '\n');
  return data;
}

module.exports = { logSpreads, fetchSpreadData, SPREAD_CSV };
