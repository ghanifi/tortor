// src/analysis/technical-score.js
// Layer 6: Technical Engine — composite score from RSI, MACD, Volume, ATR expansion
const { calculateRSI, calculateMACD, calculateATR } = require('./indicators');

/**
 * Calculate a 0–100 technical score for a single asset.
 *
 * Breakdown (max 100):
 *   RSI        0–30  → bullish zone (50–70): +30, borderline (40–50): +15, else 0
 *   MACD       0–30  → histogram > 0: +30, else 0
 *   Volume     0–20  → current > 1.2× avg20: +20, > avg: +10, else 0
 *   ATR expand 0–20  → ATR(7) > ATR(28) × 1.1: +20, else 0
 *
 * @param {number[]} closes
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} volumes
 * @returns {{ score: number, rsi: number|null, macd: number|null, volumeExpanding: boolean, atrExpanding: boolean }}
 */
function calcTechnicalScore(closes, highs, lows, volumes) {
  let score = 0;

  // ── RSI (0–30) ───────────────────────────────────────────────────────────────
  const rsi = calculateRSI(closes);
  if (rsi !== null) {
    if (rsi >= 50 && rsi <= 70)      score += 30; // bullish zone
    else if (rsi >= 40 && rsi < 50)  score += 15; // borderline
    // rsi < 40 or rsi > 70: 0 (weak or overbought)
  }

  // ── MACD Histogram (0–30) ────────────────────────────────────────────────────
  const macd = calculateMACD(closes);
  const macdHistogram = macd?.histogram ?? null;
  if (macdHistogram !== null && macdHistogram > 0) score += 30;

  // ── Volume Expansion (0–20) ──────────────────────────────────────────────────
  let volumeExpanding = false;
  if (volumes && volumes.length >= 21) {
    const avg20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const curVol = volumes[volumes.length - 1];
    if (curVol > 0 && avg20 > 0) {
      if (curVol > avg20 * 1.2)   { score += 20; volumeExpanding = true; }
      else if (curVol > avg20)     { score += 10; volumeExpanding = true; }
    }
  }

  // ── ATR Expansion (0–20) ─────────────────────────────────────────────────────
  // Recent momentum > historical baseline
  let atrExpanding = false;
  if (closes.length >= 30) {
    const atrShort = calculateATR(highs, lows, closes, 7);
    const atrLong  = calculateATR(highs, lows, closes, 28);
    if (atrShort && atrLong && atrShort > atrLong * 1.1) {
      score += 20;
      atrExpanding = true;
    }
  }

  return { score, rsi, macdHistogram, volumeExpanding, atrExpanding };
}

module.exports = { calcTechnicalScore };
