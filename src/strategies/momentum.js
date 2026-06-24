// src/strategies/momentum.js
// Layer 9: Pyramiding entry decisions
// Layer 10: Exit trigger evaluation

/**
 * Evaluate pyramid entry.
 * @param {object} params
 * @param {number} params.pyramidLevel  - 0=no position, 1=L1 held, 2=L2 held, 3=full
 * @param {number} params.currentPrice
 * @param {number|null} params.entryPrice   - price at L1 entry
 * @param {number|null} params.level2Price  - price at L2 entry
 * @param {number} params.atr
 * @param {{ allPass: boolean, failReason: string|null }} params.filters
 * @returns {{ action: 'buy'|'hold', tranche: 1|2|3|null, reason: string }}
 */
function decideMomentum({ pyramidLevel, currentPrice, entryPrice, level2Price, atr, filters }) {
  // Level 0 → Level 1: initial entry
  if (pyramidLevel === 0) {
    if (!filters.allPass) {
      return { action: 'hold', tranche: null, reason: filters.failReason || 'Filter not passed' };
    }
    return { action: 'buy', tranche: 1, reason: 'Momentum entry L1 — all filters passed' };
  }

  // Level 1 → Level 2: price must clear entry + 1×ATR
  if (pyramidLevel === 1) {
    if (!entryPrice) return { action: 'hold', tranche: null, reason: 'Pyramid L2: entry_price missing' };
    if (!filters.allPass && filters.failReason?.includes('Market state')) {
      return { action: 'hold', tranche: null, reason: filters.failReason };
    }
    const trigger = entryPrice + atr;
    if (currentPrice > trigger) {
      return {
        action: 'buy', tranche: 2,
        reason: `Pyramid L2 — price above ${trigger.toFixed(2)} ($${currentPrice.toFixed(2)})`
      };
    }
    return { action: 'hold', tranche: null, reason: `Pyramid L2 waiting — target $${trigger.toFixed(2)}` };
  }

  // Level 2 → Level 3: price must clear level2 + 1×ATR
  if (pyramidLevel === 2) {
    if (!level2Price) return { action: 'hold', tranche: null, reason: 'Pyramid L3: level2_price missing' };
    if (!filters.allPass && filters.failReason?.includes('Market state')) {
      return { action: 'hold', tranche: null, reason: filters.failReason };
    }
    const trigger = level2Price + atr;
    if (currentPrice > trigger) {
      return {
        action: 'buy', tranche: 3,
        reason: `Pyramid L3 — price above ${trigger.toFixed(2)} ($${currentPrice.toFixed(2)})`
      };
    }
    return { action: 'hold', tranche: null, reason: `Pyramid L3 waiting — target $${trigger.toFixed(2)}` };
  }

  // Level 3: fully pyramided, no more entries
  return { action: 'hold', tranche: null, reason: 'Full pyramid — L3 complete' };
}

/**
 * Check exit triggers in priority order.
 * Returns first trigger that fires, or { exit: false }.
 *
 * @param {object} params
 * @param {{ stop_price?: number, pyramid_level?: number, entry_at?: string }} params.pos
 * @param {number} params.currentPrice
 * @param {{ trend: string }} params.assetRegime
 * @param {string} params.currentMarketState
 * @param {string|null} params.prevMarketState
 * @param {number} [params.minHoldMinutes=60] - minimum hold time before trend-break exit fires
 * @param {number} [params.maxLossPct=0.30]   - hard backstop: exit if loss exceeds this fraction
 * @returns {{ exit: boolean, type?: 'hard'|'soft', portion?: number, reason?: string }}
 */
function checkExitTrigger({ pos, currentPrice, assetRegime, currentMarketState, prevMarketState, minHoldMinutes = 60, maxLossPct = 0.30 }) {
  // PANIC: hard exit — no AI gate, immediate full close
  if (currentMarketState === 'PANIC') {
    return { exit: true, type: 'hard', portion: 1, reason: 'Market state: PANIC → full position closed' };
  }

  // Trigger 0: Max-loss backstop — catches ATR gap (e.g. illiquid crypto overnight crash).
  // Fires BEFORE ATR stop so TRX-type gaps don't silently exceed the stop level.
  if (pos.avg_cost && maxLossPct > 0) {
    const lossFrac = (currentPrice - pos.avg_cost) / pos.avg_cost;
    if (lossFrac < -maxLossPct) {
      return {
        exit: true, type: 'hard', portion: 1,
        reason: `Max loss: ${(lossFrac * 100).toFixed(1)}% < -${(maxLossPct * 100).toFixed(0)}% limit`,
      };
    }
  }

  // Trigger 1: ATR trailing stop — hard exit, fires regardless of profit/loss, no AI gate
  if (pos.stop_price && currentPrice < pos.stop_price) {
    return {
      exit: true, type: 'hard', portion: 1,
      reason: `ATR stop triggered ($${pos.stop_price.toFixed(2)})`,
    };
  }

  // Trigger 2: Trend break (EMA50 < EMA200) — soft exit, AI gate may apply
  if (assetRegime.trend !== 'BULL') {
    const holdMs = pos.entry_at ? Date.now() - new Date(pos.entry_at).getTime() : 0;
    const minHoldMs = minHoldMinutes * 60 * 1000;

    if (holdMs < minHoldMs) {
      const heldMin = Math.round(holdMs / 60000);
      return { exit: false, _skipped: `Trend broke but min hold ${minHoldMinutes}min (held ${heldMin}min)` };
    }

    return { exit: true, type: 'soft', portion: 1, reason: 'Trend broken (EMA50 < EMA200)' };
  }

  // Trigger 3: Market deterioration (RISK_OFF transition) — soft exit, AI gate may apply
  if (prevMarketState !== 'RISK_OFF' && currentMarketState === 'RISK_OFF') {
    return { exit: true, type: 'soft', portion: 1, reason: 'Market state: RISK_OFF → position closed' };
  }

  return { exit: false };
}

module.exports = { decideMomentum, checkExitTrigger };
