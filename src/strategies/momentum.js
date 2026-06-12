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
    if (!entryPrice) return { action: 'hold', tranche: null, reason: 'Piramit L2: entry_price eksik' };
    if (!filters.allPass && filters.failReason?.includes('Market state')) {
      return { action: 'hold', tranche: null, reason: filters.failReason };
    }
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
    if (!level2Price) return { action: 'hold', tranche: null, reason: 'Piramit L3: level2_price eksik' };
    if (!filters.allPass && filters.failReason?.includes('Market state')) {
      return { action: 'hold', tranche: null, reason: filters.failReason };
    }
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
 * @param {{ stop_price?: number, pyramid_level?: number, entry_at?: string }} params.pos
 * @param {number} params.currentPrice
 * @param {{ trend: string }} params.assetRegime
 * @param {string} params.currentMarketState
 * @param {string|null} params.prevMarketState
 * @param {number} [params.minHoldMinutes=60] - minimum hold time before trend-break exit fires
 * @returns {{ exit: boolean, portion?: number, reason?: string }}
 */
function checkExitTrigger({ pos, currentPrice, assetRegime, currentMarketState, prevMarketState, minHoldMinutes = 60, inProfit = false }) {
  // PANIC: tek istisna — her koşulda acil çıkış
  if (currentMarketState === 'PANIC') {
    return { exit: true, portion: 1, reason: 'Market state: PANIC → tüm pozisyon kapatıldı' };
  }

  // TEMEL KURAL: Zararda satış yasak.
  // Fiyat ort. maliyetin altındaysa hiçbir çıkış tetiklenmez — pozisyon tutulur.
  // (avg_cost bilinmiyorsa bu blok atlanır, aşağıdaki tetikleyiciler çalışır.)
  if (pos.avg_cost && currentPrice < pos.avg_cost) {
    return {
      exit: false,
      _skipped: `Zararda ($${currentPrice.toFixed(2)} < ort. maliyet $${pos.avg_cost.toFixed(2)}) — zarar realizasyonu engellendi`,
    };
  }

  // Trigger 1: ATR trailing stop — karda veya başabaş fiyatta tetiklenir
  if (pos.stop_price && currentPrice < pos.stop_price) {
    return {
      exit: true, portion: 1,
      reason: `ATR stop tetiklendi ($${pos.stop_price.toFixed(2)})`,
    };
  }

  // Trigger 2: Trend break (EMA50 < EMA200)
  if (assetRegime.trend !== 'BULL') {
    const holdMs = pos.entry_at ? Date.now() - new Date(pos.entry_at).getTime() : Infinity;
    const minHoldMs = minHoldMinutes * 60 * 1000;

    if (holdMs < minHoldMs) {
      const heldMin = Math.round(holdMs / 60000);
      return { exit: false, _skipped: `Trend kırıldı ama min hold ${minHoldMinutes}dk (${heldMin}dk tutuldu)` };
    }

    // Karda ise trend break'i ATR stop'a bırak (kazananları erken kesme)
    if (inProfit) {
      return { exit: false, _skipped: `Trend kırıldı ama karda — ATR stop ($${pos.stop_price?.toFixed(2) ?? '?'}) bekliyor` };
    }

    return { exit: true, portion: 1, reason: 'Trend kırıldı (EMA50 < EMA200)' };
  }

  // Trigger 3: Piyasa bozulması (RISK_OFF geçişi)
  if (prevMarketState !== 'RISK_OFF' && currentMarketState === 'RISK_OFF') {
    return { exit: true, portion: 1, reason: 'Market state: RISK_OFF → pozisyon kapatıldı' };
  }

  return { exit: false };
}

module.exports = { decideMomentum, checkExitTrigger };
