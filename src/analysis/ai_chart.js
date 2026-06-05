// src/analysis/ai_chart.js
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

// Cost estimate: claude-haiku ~$0.0004 per call with image
const ESTIMATED_COST_PER_CALL = 0.0004;

async function analyzeChart({ screenshotPath, symbol, changePct, rsi, macd, regime }) {
  const client = new Anthropic();
  const imageData = fs.readFileSync(screenshotPath).toString('base64');

  const prompt = [
    `Trading chart for ${symbol}.`,
    `Change from avg cost: ${changePct.toFixed(1)}%.`,
    `RSI: ${rsi != null ? rsi.toFixed(0) : 'N/A'}.`,
    `MACD histogram: ${macd?.histogram != null ? macd.histogram.toFixed(2) : 'N/A'}.`,
    `Market regime: ${regime}.`,
    `Should I buy, sell, or hold? Start your answer with exactly one of: buy / sell / hold. Then one brief reason.`
  ].join(' ');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
        { type: 'text', text: prompt }
      ]
    }]
  });

  const text = response.content[0].text.toLowerCase().trim();
  let action = 'hold';
  if (text.startsWith('buy')) action = 'buy';
  else if (text.startsWith('sell')) action = 'sell';

  return { action, reason: response.content[0].text, cost: ESTIMATED_COST_PER_CALL };
}

module.exports = { analyzeChart, ESTIMATED_COST_PER_CALL };
