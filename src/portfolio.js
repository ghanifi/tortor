// src/portfolio.js
function calcChange(currentPrice, avgCost) {
  if (!avgCost) return null;
  return ((currentPrice - avgCost) / avgCost) * 100;
}

function calcPnL(quantity, avgCost, currentPrice) {
  return quantity * (currentPrice - avgCost);
}

function calcTotalPortfolioValue(positions, prices, cash) {
  let total = cash;
  for (const [symbol, pos] of Object.entries(positions)) {
    const price = prices[symbol];
    if (price && pos.quantity) total += pos.quantity * price;
  }
  return total;
}

function allocateBudget(symbol, allSymbols, availableCash, config) {
  const reserve = config.safety?.min_cash_reserve || 0;
  const spendable = availableCash - reserve;
  if (spendable <= 0) return 0;

  const perAsset = config.budget?.per_asset || {};
  if (perAsset[symbol] !== undefined) {
    return Math.min(perAsset[symbol], spendable);
  }

  // Equal split among unlimited assets
  const limitedTotal = Object.keys(perAsset)
    .filter(s => allSymbols.includes(s))
    .reduce((sum, s) => sum + perAsset[s], 0);
  const unlimitedSymbols = allSymbols.filter(s => perAsset[s] === undefined);
  if (unlimitedSymbols.length === 0) return 0;

  const remainingForUnlimited = Math.max(0, spendable - limitedTotal);
  return remainingForUnlimited / unlimitedSymbols.length;
}

/**
 * ATR-based position sizing (Layer 8).
 *
 * Sizes the position so that if the ATR stop fires, the account loses exactly
 * `riskPerTradePct`% of total account value — no more.
 *
 * Formula:
 *   riskAmount       = totalAccountValue × riskPerTradePct / 100
 *   stopDistance     = atr × atrStopMultiplier
 *   totalPositionVal = riskAmount × (currentPrice / stopDistance)
 *   trancheBudget    = totalPositionVal × trancheSize
 *
 * Capped at available spendable cash.
 *
 * @param {object} p
 * @param {number} p.totalAccountValue  - cash + portfolio market value
 * @param {number} p.currentPrice
 * @param {number} p.atr                - Average True Range
 * @param {number} p.atrStopMultiplier  - e.g. 2.0
 * @param {number} p.riskPerTradePct    - e.g. 0.75  (means 0.75%)
 * @param {number} p.trancheSize        - e.g. 0.4 for first tranche
 * @param {number} p.availableCash
 * @param {number} p.minCashReserve
 * @returns {number} dollar budget for this tranche
 */
function calcPositionBudget({ totalAccountValue, currentPrice, atr, atrStopMultiplier,
                               riskPerTradePct, trancheSize, availableCash, minCashReserve }) {
  const spendable = Math.max(0, availableCash - minCashReserve);
  if (spendable <= 0 || atr <= 0 || currentPrice <= 0) return 0;

  const riskAmount      = totalAccountValue * (riskPerTradePct / 100);
  const stopDistance    = atr * atrStopMultiplier;
  const totalPosition   = riskAmount * (currentPrice / stopDistance);
  const trancheBudget   = totalPosition * trancheSize;

  return Math.min(trancheBudget, spendable);
}

module.exports = { calcChange, calcPnL, calcTotalPortfolioValue, allocateBudget, calcPositionBudget };
