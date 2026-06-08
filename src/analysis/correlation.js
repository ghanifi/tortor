// src/analysis/correlation.js
// Layer 7: Correlation Engine — prevents over-concentration in correlated assets

/**
 * Calculate daily returns from a closes array (last `period` days).
 * @param {number[]} closes
 * @param {number} period
 * @returns {number[]}
 */
function getDailyReturns(closes, period = 20) {
  const slice = closes.slice(-(period + 1));
  if (slice.length < 2) return [];
  return slice.slice(1).map((c, i) => (slice[i] !== 0 ? (c - slice[i]) / slice[i] : 0));
}

/**
 * Pearson correlation coefficient between two equal-length return series.
 * Returns 0 if series are too short or have zero variance.
 * @param {number[]} r1
 * @param {number[]} r2
 * @returns {number} -1 to 1
 */
function pearsonCorrelation(r1, r2) {
  const n = Math.min(r1.length, r2.length);
  if (n < 10) return 0;

  const a = r1.slice(-n);
  const b = r2.slice(-n);

  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;

  let num = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num  += da * db;
    varA += da * da;
    varB += db * db;
  }

  if (varA === 0 || varB === 0) return 0;
  return num / Math.sqrt(varA * varB);
}

/**
 * Check whether a candidate symbol is too correlated with any open position.
 *
 * @param {number[]} candidateCloses - candidate symbol's closes
 * @param {{ [sym]: { quantity: number } }} openPositions - state.positions
 * @param {{ [sym]: { closes: number[] } }} historyMap - pre-fetched histories
 * @param {number} maxCorrelation - threshold (default 0.85)
 * @returns {{ blocked: boolean, correlation?: number, with?: string }}
 */
function checkCorrelation(candidateCloses, openPositions, historyMap, maxCorrelation = 0.85) {
  const candidateReturns = getDailyReturns(candidateCloses);
  if (candidateReturns.length < 10) return { blocked: false };

  for (const [sym, pos] of Object.entries(openPositions)) {
    if (!pos.quantity || pos.quantity <= 0) continue;
    const hist = historyMap[sym];
    if (!hist || hist.closes.length < 21) continue;

    const existingReturns = getDailyReturns(hist.closes);
    const corr = pearsonCorrelation(candidateReturns, existingReturns);

    if (corr >= maxCorrelation) {
      return { blocked: true, correlation: corr, with: sym };
    }
  }

  return { blocked: false };
}

module.exports = { getDailyReturns, pearsonCorrelation, checkCorrelation };
