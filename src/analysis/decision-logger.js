// src/analysis/decision-logger.js
// Structured per-symbol decision log — one record per symbol per cycle.
// Written to DATA_DIR/logs/decisions.jsonl (append).
// Used by /api/decisions UI endpoint and for debugging.

const fs   = require('fs');
const path = require('path');

const DATA_DIR     = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const LOG_DIR      = path.join(DATA_DIR, 'logs');
const DECISIONS_FILE = path.join(LOG_DIR, 'decisions.jsonl');
const MAX_LINES    = 5000; // rotate after this many lines

function ensureDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Append one decision record to decisions.jsonl.
 *
 * @param {object} r
 * @param {string} r.cycleTs        ISO timestamp of the cycle start
 * @param {string} r.symbol
 * @param {number} r.price
 * @param {number|null} r.changePct  % change vs avg cost (null if no position)
 *
 * Layer data:
 * @param {string} r.marketState     'RISK_ON' | 'RISK_NEUTRAL' | ...
 * @param {number} r.marketScore
 * @param {number} r.breadthCount    how many sectors above MA50
 * @param {string} r.breadthState    'BROAD' | 'NARROW' | 'WEAK'
 * @param {string|null} r.trend      'BULL' | 'BEAR' | 'SIDEWAYS'
 * @param {number|null} r.adx
 * @param {number|null} r.atr
 * @param {number|null} r.rsScore
 * @param {number|null} r.techScore
 * @param {number|null} r.rsi        from tech score breakdown
 * @param {number|null} r.macdHistogram
 * @param {boolean|null} r.volumeExpanding
 * @param {boolean|null} r.atrExpanding
 *
 * Filter results:
 * @param {object} r.filters         { market_state, breadth, trend, adx, rs_score, tech_score, earnings, correlation }
 *                                   each value: 'PASS' | 'FAIL' | 'SKIP'
 *
 * Decision:
 * @param {string}      r.decision   'buy' | 'sell' | 'hold'
 * @param {number|null} r.tranche    1 | 2 | 3 | null
 * @param {number}      r.pyramidLevel
 * @param {string|null} r.failReason
 * @param {string|null} r.aiVerdict  'BUY' | 'SKIP' | null (null = not called)
 * @param {string|null} r.aiReason
 */
function logDecision(r) {
  ensureDir();
  const record = {
    ts:               new Date().toISOString(),
    cycle_ts:         r.cycleTs,
    symbol:           r.symbol,
    price:            r.price   != null ? +Number(r.price).toFixed(4)   : null,
    change_pct:       r.changePct != null ? +Number(r.changePct).toFixed(2) : null,
    market_state:     r.marketState    ?? null,
    market_score:     r.marketScore    ?? null,
    breadth_count:    r.breadthCount   ?? null,
    breadth_state:    r.breadthState   ?? null,
    trend:            r.trend          ?? null,
    adx:              r.adx    != null ? +Number(r.adx).toFixed(1)  : null,
    atr:              r.atr    != null ? +Number(r.atr).toFixed(4)  : null,
    rs_score:         r.rsScore  != null ? +Number(r.rsScore).toFixed(1)  : null,
    tech_score:       r.techScore != null ? +Number(r.techScore).toFixed(0) : null,
    rsi:              r.rsi    != null ? +Number(r.rsi).toFixed(1)   : null,
    macd_histogram:   r.macdHistogram != null ? +Number(r.macdHistogram).toFixed(4) : null,
    volume_expanding: r.volumeExpanding ?? null,
    atr_expanding:    r.atrExpanding    ?? null,
    filters:          r.filters ?? {},
    pyramid_level:    r.pyramidLevel ?? 0,
    decision:         r.decision,
    tranche:          r.tranche   ?? null,
    fail_reason:      r.failReason ?? null,
    ai_verdict:       r.aiVerdict  ?? null,
    ai_reason:        r.aiReason   ?? null,
  };
  fs.appendFileSync(DECISIONS_FILE, JSON.stringify(record) + '\n');
}

/**
 * Read the most recent N decision records (from end of file).
 * @param {number} [limit=200]
 * @returns {object[]}
 */
function readRecentDecisions(limit = 200) {
  if (!fs.existsSync(DECISIONS_FILE)) return [];
  const lines = fs.readFileSync(DECISIONS_FILE, 'utf8')
    .split('\n').filter(Boolean);
  return lines.slice(-limit).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean).reverse(); // newest first
}

module.exports = { logDecision, readRecentDecisions };
