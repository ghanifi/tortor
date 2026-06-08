// src/analysis/final-score.js
// Composite entry score replacing the old DCA buy/sell thresholds.
//
// Combines all momentum layer signals into a single 0-100 score.
// Hard gates (market state, trend direction) are evaluated separately in index.js.
// This score is for the "how strong is this setup?" question, not "is the trend up?".
//
// Weights (sum = 1.0):
//   RS Score       30%  — outperformance vs benchmark is the core momentum signal
//   Technical      25%  — RSI/MACD/Volume/ATR confirms the entry timing
//   Market State   20%  — macro backdrop quality
//   Breadth        15%  — how many sectors are participating
//   ADX strength   10%  — how much trend strength above the minimum threshold
//
// Thresholds (configurable):
//   entry_score      70  → BUY (normal position)
//   strong_buy_score 85  → Strong Buy (larger L1 tranche)

/**
 * Calculate composite final score from all layer inputs.
 *
 * @param {object} p
 * @param {number|null} p.rsScore        0–100
 * @param {number|null} p.techScore      0–100
 * @param {number|null} p.marketScore    0–100
 * @param {number|null} p.breadthCount   0–11 (sectors above MA50)
 * @param {number|null} p.adx            raw ADX value
 * @param {number}      [p.adxMin=20]    minimum ADX threshold (for normalization baseline)
 * @returns {number} 0–100
 */
function calcFinalScore({ rsScore, techScore, marketScore, breadthCount, adx, adxMin = 20 }) {
  const rs      = clamp(rsScore    ?? 0, 0, 100);
  const tech    = clamp(techScore  ?? 0, 0, 100);
  const mkt     = clamp(marketScore ?? 50, 0, 100);
  const breadth = clamp(((breadthCount ?? 0) / 11) * 100, 0, 100);

  // ADX normalized: adxMin → 0, adxMin+30 → 100, capped at 100
  const adxNorm = adx != null ? clamp(((adx - adxMin) / 30) * 100, 0, 100) : 0;

  return Math.round(
    rs      * 0.30 +
    tech    * 0.25 +
    mkt     * 0.20 +
    breadth * 0.15 +
    adxNorm * 0.10
  );
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Determine entry tier from final score.
 *
 * @param {number} score        0–100
 * @param {number} entryScore   gate for normal buy
 * @param {number} strongScore  gate for strong buy
 * @returns {'STRONG_BUY' | 'BUY' | 'NO_ENTRY'}
 */
function scoreToTier(score, entryScore = 70, strongScore = 85) {
  if (score >= strongScore) return 'STRONG_BUY';
  if (score >= entryScore)  return 'BUY';
  return 'NO_ENTRY';
}

module.exports = { calcFinalScore, scoreToTier };
