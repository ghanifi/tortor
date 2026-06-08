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
      return { action: 'hold', tranche: null, reason: filters.failReason || 'Filtre geçilemedi' };
    }
    return { action: 'buy', tranche: 1, reason: 'Momentum giriş L1 — tüm filtreler geçti' };
  }

  // Level 1 → Level 2: price must clear entry + 1×ATR
  if (pyramidLevel === 1) {
    const trigger = entryPrice + atr;
    if (currentPrice > trigger) {
      return {
        action: 'buy', tranche: 2,
        reason: `Piramit L2 — fiyat ${trigger.toFixed(2)} üzerinde ($${currentPrice.toFixed(2)})`
      };
    }
    return { action: 'hold', tranche: null, reason: `Piramit L2 bekleniyor — hedef $${trigger.toFixed(2)}` };
  }

  // Level 2 → Level 3: price must clear level2 + 1×ATR
  if (pyramidLevel === 2) {
    const trigger = level2Price + atr;
    if (currentPrice > trigger) {
      return {
        action: 'buy', tranche: 3,
        reason: `Piramit L3 — fiyat ${trigger.toFixed(2)} üzerinde ($${currentPrice.toFixed(2)})`
      };
    }
    return { action: 'hold', tranche: null, reason: `Piramit L3 bekleniyor — hedef $${trigger.toFixed(2)}` };
  }

  // Level 3: fully pyramided, no more entries
  return { action: 'hold', tranche: null, reason: 'Tam piramit — L3 tamamlandı' };
}

/**
 * Check exit triggers in priority order.
 * Returns first trigger that fires, or { exit: false }.
 *
 * @param {object} params
 * @param {{ stop_price?: number, pyramid_level?: number }} params.pos
 * @param {number} params.currentPrice
 * @param {{ trend: string }} params.assetRegime
 * @param {string} params.currentMarketState
 * @param {string|null} params.prevMarketState
 * @returns {{ exit: boolean, portion?: number, reason?: string }}
 */
function checkExitTrigger({ pos, currentPrice, assetRegime, currentMarketState, prevMarketState }) {
  // Trigger 4 (highest priority): PANIC emergency exit
  if (currentMarketState === 'PANIC') {
    return { exit: true, portion: 1, reason: 'Market state: PANIC → tüm pozisyon kapatıldı' };
  }

  // Trigger 1: ATR stop (hard floor)
  if (pos.stop_price && currentPrice < pos.stop_price) {
    return {
      exit: true, portion: 1,
      reason: `ATR stop tetiklendi ($${pos.stop_price.toFixed(2)})`
    };
  }

  // Trigger 2: Trend break (EMA50 < EMA200)
  if (assetRegime.trend !== 'BULL') {
    return { exit: true, portion: 1, reason: 'Trend kırıldı (EMA50 < EMA200)' };
  }

  // Trigger 3: Market state degradation
  if (prevMarketState !== 'RISK_OFF' && currentMarketState === 'RISK_OFF') {
    return { exit: true, portion: 0.5, reason: 'Market state: RISK_OFF → pozisyon %50 küçültüldü' };
  }

  return { exit: false };
}

module.exports = { decideMomentum, checkExitTrigger };
