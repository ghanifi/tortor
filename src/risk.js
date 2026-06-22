function check({ symbol, action, state, config, portfolioValue, assetValue }) {
  const position = state.positions[symbol] || {};
  const riskState = state.risk;
  const safety = config.safety;
  const strategy = config.strategy;

  if (riskState.trades_paused) {
    return { approved: false, reason: 'Drawdown stop active — buys paused' };
  }

  if (action === 'buy') {
    if (riskState.daily_trades_today >= (strategy.max_daily_trades || 10)) {
      return { approved: false, reason: `Daily trade limit (${strategy.max_daily_trades}) reached` };
    }

    if (position.last_trade_at) {
      const cooldownMs = (strategy.cooldown_hours || 2) * 60 * 60 * 1000;
      const elapsed = Date.now() - new Date(position.last_trade_at).getTime();
      if (elapsed < cooldownMs) {
        const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
        return { approved: false, reason: `Cooldown active (${remaining}min remaining)` };
      }
    }

    const maxExposure = (safety.max_exposure_pct || 30) / 100;
    const perAssetBudget = config.budget?.per_asset?.[symbol] || 0;
    if (assetValue + perAssetBudget > portfolioValue * maxExposure) {
      return { approved: false, reason: `Max exposure exceeded (${safety.max_exposure_pct}%)` };
    }
  }

  return { approved: true, reason: null };
}

function updateAfterTrade(state, symbol) {
  state.risk.daily_trades_today += 1;
  if (!state.positions[symbol]) state.positions[symbol] = {};
  state.positions[symbol].last_trade_at = new Date().toISOString();
  return state;
}

function checkDrawdown(state, currentPortfolioValue) {
  if (currentPortfolioValue > state.risk.portfolio_peak_value) {
    state.risk.portfolio_peak_value = currentPortfolioValue;
  }
  if (state.risk.portfolio_peak_value > 0) {
    const drawdownPct = ((state.risk.portfolio_peak_value - currentPortfolioValue) / state.risk.portfolio_peak_value) * 100;
    if (drawdownPct >= 20) {
      state.risk.trades_paused = true;
    }
  }
  return state;
}

function resetDailyCounters(state) {
  const today = new Date().toDateString();
  if (state.risk.last_reset !== today) {
    state.risk.daily_trades_today = 0;
    state.risk.last_reset = today;
    state.risk.trades_paused = false;
  }
  return state;
}

module.exports = { check, updateAfterTrade, checkDrawdown, resetDailyCounters };
