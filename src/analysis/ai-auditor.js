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

  return { verdict, reason: auditReason, costUsd: ESTIMATED_COST_USD };
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

module.exports = { auditTrade, buildPrompt, ESTIMATED_COST_USD };
