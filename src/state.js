// src/state.js
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(process.cwd(), 'state.json');

const DEFAULT_STATE = {
  session: { cookies: [], expires_at: null },
  positions: {},
  regime: { macro_equity: 'sideways', macro_crypto: 'sideways', updated_at: null },
  risk: { portfolio_peak_value: 0, daily_trades_today: 0, trades_paused: false, last_reset: null },
  ai_usage: { daily_calls: 0, daily_limit: 20, monthly_cost_usd: 0, monthly_budget_usd: 10, last_reset: null },
  last_check: null,
  active_layer: 1
};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return JSON.parse(JSON.stringify(DEFAULT_STATE));
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

module.exports = { loadState, saveState, DEFAULT_STATE };
