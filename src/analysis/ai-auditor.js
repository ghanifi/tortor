// src/analysis/ai-auditor.js
// Layer 14: AI Auditor — final gate before a new entry (tranche 1).
//
// After all quantitative filters pass, Claude Haiku reviews the full setup
// and returns BUY or SKIP with a one-sentence reason. This catches edge cases
// the rule-based layers miss: unusual sector context, overextended setups,
// conflicting signals that individually pass but together look weak.
//
// Fails open: if the API call errors, the trade is allowed through.
// Cost estimate: ~$0.0005 per call (300 input + 60 output tokens, Haiku pricing).

const Anthropic = require('@anthropic-ai/sdk');

const ESTIMATED_COST_USD = 0.0005;

/**
 * Ask Claude Haiku to audit a proposed tranche-1 entry.
 *
 * @param {object} p
 * @param {string} p.symbol
 * @param {number} p.price
 * @param {string} p.reason           — momentum decision reason
 * @param {object} p.scores           — layer scores
 * @param {string} p.model            — e.g. 'claude-haiku-4-5-20251001'
 * @returns {Promise<{ verdict: 'BUY'|'SKIP', reason: string, costUsd: number }>}
 */
async function auditTrade({ symbol, price, reason, scores, model = 'claude-haiku-4-5-20251001' }) {
  const client = new Anthropic();

  const prompt = buildPrompt({ symbol, price, reason, scores });

  const response = await client.messages.create({
    model,
    max_tokens: 80,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = (response.content[0]?.text || '').trim();
  const verdict = text.toUpperCase().startsWith('BUY') ? 'BUY' : 'SKIP';
  // Everything after the first word is the reason
  const auditReason = text.replace(/^(BUY|SKIP)[.:,\s]*/i, '').trim() || text;

  return { verdict, reason: auditReason, prompt, costUsd: ESTIMATED_COST_USD };
}

/**
 * Build a compact prompt that fits well within 300 input tokens.
 */
function buildPrompt({ symbol, price, reason, scores }) {
  const s = scores || {};
  const lines = [
    `You are a systematic momentum trader reviewing a proposed new position.`,
    `Respond with exactly "BUY" or "SKIP" on the first line, followed by one sentence of reasoning (max 20 words).`,
    ``,
    `Symbol: ${symbol} @ $${Number(price).toFixed(2)}`,
    `Market state: ${s.market_state ?? 'N/A'} (score ${s.market_score ?? 'N/A'}/100)`,
    `Trend: ${s.trend ?? 'N/A'} | ADX: ${s.adx != null ? Number(s.adx).toFixed(1) : 'N/A'}`,
    `ATR: ${s.atr != null ? Number(s.atr).toFixed(2) : 'N/A'}`,
    `RS score: ${s.rs_score != null ? Number(s.rs_score).toFixed(0) : 'N/A'}/100`,
    `Technical score: ${s.tech_score != null ? Number(s.tech_score).toFixed(0) : 'N/A'}/100`,
    `Entry reason: ${reason}`,
  ];
  return lines.join('\n');
}

/**
 * Ask Claude Haiku whether to SELL an open profitable position now or HOLD for better exit.
 * Called when a soft exit trigger (trend-break / RISK_OFF) fires on a profitable position.
 * Fails open: returns SELL on API error so the trade always has a fallback.
 *
 * @param {object} p
 * @param {string} p.symbol
 * @param {number} p.price
 * @param {number} p.avgCost
 * @param {number} p.profitPct        — (price - avgCost) / avgCost * 100
 * @param {string} p.trend            — 'BULL' | 'BEAR' | 'SIDEWAYS'
 * @param {number|null} p.adx
 * @param {number|null} p.atr
 * @param {string} p.marketState      — 'RISK_ON' | 'RISK_NEUTRAL' | 'RISK_OFF'
 * @param {string} p.exitReason       — the trigger that fired
 * @param {string} [p.model]
 * @returns {Promise<{ verdict: 'SELL'|'HOLD', reason: string, prompt: string, costUsd: number }>}
 */
async function queryExitDirection({ symbol, price, avgCost, profitPct, trend, adx, atr, marketState, exitReason, model = 'claude-haiku-4-5-20251001' }) {
  const client = new Anthropic();
  const prompt = buildExitPrompt({ symbol, price, avgCost, profitPct, trend, adx, atr, marketState, exitReason });

  const response = await client.messages.create({
    model,
    max_tokens: 80,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = (response.content[0]?.text || '').trim();
  const verdict = text.toUpperCase().startsWith('HOLD') ? 'HOLD' : 'SELL';
  const reason = text.replace(/^(SELL|HOLD)[.:,\s]*/i, '').trim() || text;

  return { verdict, reason, prompt, costUsd: ESTIMATED_COST_USD };
}

function buildExitPrompt({ symbol, price, avgCost, profitPct, trend, adx, atr, marketState, exitReason }) {
  const lines = [
    `You are managing an open profitable trading position. A sell signal just triggered.`,
    `Decide: should we exit NOW to lock in profit, or HOLD for a better exit price?`,
    `Respond with exactly "SELL" or "HOLD" on the first line, then one sentence of reasoning (max 20 words).`,
    ``,
    `Symbol: ${symbol} @ $${Number(price).toFixed(4)}`,
    `Entry avg cost: $${Number(avgCost).toFixed(4)} | Current profit: +${Number(profitPct).toFixed(2)}%`,
    `Sell trigger: ${exitReason}`,
    `Trend: ${trend ?? 'N/A'} | ADX: ${adx != null ? Number(adx).toFixed(1) : 'N/A'} | ATR: ${atr != null ? Number(atr).toFixed(4) : 'N/A'}`,
    `Market: ${marketState ?? 'N/A'}`,
    ``,
    `HOLD only if there is strong evidence the price will recover and yield significantly more profit.`,
    `SELL if the trend break is confirmed, momentum is fading, or profit is already substantial.`,
  ];
  return lines.join('\n');
}

module.exports = { auditTrade, buildPrompt, queryExitDirection, buildExitPrompt, ESTIMATED_COST_USD };
