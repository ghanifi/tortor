// src/strategies/dca.js
const EDGE_BUFFER = 2;

function decide({ change, thresholds, indicators }) {
  const { buy: buyThresh, sell: [sell1, sell2, sell3] } = thresholds;

  // Sell tranches (checked from highest to lowest)
  if (change >= sell3) return { action: 'sell', portion: 1.0,  reason: `+${change.toFixed(1)}% → full exit (tranche 3)` };
  if (change >= sell2) return { action: 'sell', portion: 0.5,  reason: `+${change.toFixed(1)}% → 50% sell (tranche 2)` };
  if (change >= sell1) return { action: 'sell', portion: 0.25, reason: `+${change.toFixed(1)}% → 25% sell (tranche 1)` };

  // Buy zone
  if (change <= buyThresh) {
    if (indicators?.rsi != null && indicators.rsi > 55) {
      return { action: 'hold', portion: 0, reason: `At threshold but RSI=${indicators.rsi.toFixed(0)}, not oversold` };
    }
    return { action: 'buy', portion: 1.0, reason: `${change.toFixed(1)}% dip → DCA buy` };
  }

  // Edge zone (within EDGE_BUFFER% of any threshold, strictly between threshold and boundary)
  if ((change > buyThresh && change < buyThresh + EDGE_BUFFER) || (change > sell1 - EDGE_BUFFER && change < sell1)) {
    return { action: 'edge', portion: 0, reason: `within ${EDGE_BUFFER}% of threshold` };
  }

  return { action: 'hold', portion: 0, reason: `${change.toFixed(1)}% — within range` };
}

function calcNewAvgCost(oldQty, oldAvg, newQty, newPrice) {
  if (oldQty === 0) return newPrice;
  return (oldQty * oldAvg + newQty * newPrice) / (oldQty + newQty);
}

module.exports = { decide, calcNewAvgCost };
