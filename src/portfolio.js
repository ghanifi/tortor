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

module.exports = { calcChange, calcPnL, calcTotalPortfolioValue, allocateBudget };
