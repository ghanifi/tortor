// src/analysis/data-lake.js
// Layer 12: Trade data lake — records every entry/exit with full layer scores.
// Used to train ML models once enough trades accumulate.
//
// Format: newline-delimited JSON (JSONL) in DATA_DIR/logs/trades.jsonl
// Each line is one event: type 'entry' or 'exit'.
// ML pipeline joins entry + exit by symbol to compute outcomes.

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const LOG_DIR   = path.join(DATA_DIR, 'logs');
const LAKE_FILE = path.join(LOG_DIR, 'trades.jsonl');

function ensureDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Log a trade entry (buy) with all layer scores.
 *
 * @param {object} p
 * @param {string} p.symbol
 * @param {number} p.tranche         1 | 2 | 3
 * @param {number} p.price
 * @param {number} p.qty
 * @param {number} p.amount          dollar value spent
 * @param {number} p.stopPrice
 * @param {string} p.reason
 * @param {object} p.scores
 *   @param {string} p.scores.market_state   'RISK_ON' | ...
 *   @param {number} p.scores.market_score   0–100
 *   @param {string} p.scores.trend          'BULL' | 'BEAR' | 'SIDEWAYS'
 *   @param {number|null} p.scores.adx
 *   @param {number|null} p.scores.atr
 *   @param {number|null} p.scores.rs_score  0–100
 *   @param {number}      p.scores.tech_score 0–100
 *   @param {number}      p.scores.pyramid_level
 */
function logEntry({ symbol, tranche, price, qty, amount, stopPrice, reason, scores }) {
  ensureDir();
  const record = {
    ts:     new Date().toISOString(),
    type:   'entry',
    symbol,
    tranche,
    price:  Number(price.toFixed(4)),
    qty:    Number(qty.toFixed(6)),
    amount: Number(amount.toFixed(2)),
    stop_price: stopPrice != null ? Number(stopPrice.toFixed(4)) : null,
    reason,
    scores: {
      market_state:   scores.market_state   ?? null,
      market_score:   scores.market_score   ?? null,
      trend:          scores.trend          ?? null,
      adx:            scores.adx            != null ? Number(scores.adx.toFixed(2))       : null,
      atr:            scores.atr            != null ? Number(scores.atr.toFixed(4))       : null,
      rs_score:       scores.rs_score       != null ? Number(scores.rs_score.toFixed(1))  : null,
      tech_score:     scores.tech_score     != null ? Number(scores.tech_score.toFixed(0)): null,
      pyramid_level:  scores.pyramid_level  ?? 0,
    },
  };
  fs.appendFileSync(LAKE_FILE, JSON.stringify(record) + '\n');
}

/**
 * Log a trade exit (sell) with outcome data.
 *
 * @param {object} p
 * @param {string} p.symbol
 * @param {number} p.price
 * @param {number} p.qty
 * @param {number} p.proceeds        dollar value received
 * @param {number} p.pnl             dollar P&L
 * @param {number} p.pnlPct          % P&L vs avg cost
 * @param {string} p.reason
 * @param {string} p.marketState
 */
function logExit({ symbol, price, qty, proceeds, pnl, pnlPct, reason, marketState }) {
  ensureDir();
  const record = {
    ts:           new Date().toISOString(),
    type:         'exit',
    symbol,
    price:        Number(price.toFixed(4)),
    qty:          Number(qty.toFixed(6)),
    proceeds:     Number(proceeds.toFixed(2)),
    pnl:          Number(pnl.toFixed(2)),
    pnl_pct:      Number(pnlPct.toFixed(2)),
    result:       pnl >= 0 ? 'WIN' : 'LOSS',
    reason,
    market_state: marketState ?? null,
  };
  fs.appendFileSync(LAKE_FILE, JSON.stringify(record) + '\n');
}

module.exports = { logEntry, logExit };
