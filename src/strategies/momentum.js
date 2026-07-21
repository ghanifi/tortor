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
 * PANIC is the only trigger that can realize a loss. Every other trigger is
 * loss-protected: if selling now would close below avg_cost, the trigger is
 * skipped and the position is held instead.
 *
 * @param {object} params
 * @param {{ stop_price?: number, pyramid_level?: number, entry_at?: string, avg_cost?: number }} params.pos
 * @param {number} params.currentPrice
 * @param {{ trend: string }} params.assetRegime
 * @param {string} params.currentMarketState
 * @param {string|null} params.prevMarketState
 * @param {number} [params.minHoldMinutes=60] - minimum hold time before trend-break exit fires
 * @returns {{ exit: boolean, type?: 'hard'|'soft', portion?: number, reason?: string, _skipped?: string }}
 */
function checkExitTrigger({ pos, currentPrice, assetRegime, currentMarketState, prevMarketState, minHoldMinutes = 60 }) {
  // PANIC: hard exit — no AI gate, immediate full close. The only trigger
  // allowed to realize a loss.
  if (currentMarketState === 'PANIC') {
    return { exit: true, type: 'hard', portion: 1, reason: 'Market state: PANIC → full position closed' };
  }

  // Loss protection: no trigger below this point may sell below avg_cost.
  const wouldRealizeLoss = pos.avg_cost != null && currentPrice < pos.avg_cost;

  // Trigger 1: ATR trailing stop — hard exit, no AI gate
  if (pos.stop_price && currentPrice < pos.stop_price) {
    if (wouldRealizeLoss) {
      return { exit: false, _skipped: `ATR stop hit but loss-protection active (price $${currentPrice.toFixed(2)} < avg cost $${pos.avg_cost.toFixed(2)})` };
    }
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

    if (wouldRealizeLoss) {
      return { exit: false, _skipped: `Trend broken but loss-protection active (price $${currentPrice.toFixed(2)} < avg cost $${pos.avg_cost.toFixed(2)})` };
    }

    return { exit: true, type: 'soft', portion: 1, reason: 'Trend broken (EMA50 < EMA200)' };
  }

  // Trigger 3: Market deterioration (RISK_OFF transition) — soft exit, AI gate may apply
  if (prevMarketState !== 'RISK_OFF' && currentMarketState === 'RISK_OFF') {
    if (wouldRealizeLoss) {
      return { exit: false, _skipped: `RISK_OFF but loss-protection active (price $${currentPrice.toFixed(2)} < avg cost $${pos.avg_cost.toFixed(2)})` };
    }
    return { exit: true, type: 'soft', portion: 1, reason: 'Market state: RISK_OFF → position closed' };
  }

  return { exit: false };
}

module.exports = { decideMomentum, checkExitTrigger };
