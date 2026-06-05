const { check, updateAfterTrade, checkDrawdown, resetDailyCounters } = require('../src/risk');

function makeState(overrides = {}) {
  return {
    positions: {},
    risk: {
      portfolio_peak_value: 5000,
      daily_trades_today: 0,
      trades_paused: false,
      last_reset: new Date().toDateString()
    },
    ...overrides
  };
}

function makeConfig(overrides = {}) {
  return {
    strategy: { cooldown_hours: 2, max_daily_trades: 10 },
    safety: { min_cash_reserve: 100, max_exposure_pct: 30 },
    budget: { per_asset: {} },
    ...overrides
  };
}

describe('check — basic approval', () => {
  test('approves buy with no constraints violated', () => {
    const result = check({ symbol: 'TSLA', action: 'buy', state: makeState(), config: makeConfig(), portfolioValue: 5000, assetValue: 0 });
    expect(result.approved).toBe(true);
  });
});

describe('check — daily trade limit', () => {
  test('blocks when daily limit reached', () => {
    const state = makeState();
    state.risk.daily_trades_today = 10;
    const result = check({ symbol: 'TSLA', action: 'buy', state, config: makeConfig(), portfolioValue: 5000, assetValue: 0 });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/günlük/i);
  });
});

describe('check — cooldown', () => {
  test('blocks buy within cooldown window', () => {
    const state = makeState();
    state.positions['TSLA'] = { last_trade_at: new Date().toISOString() };
    const result = check({ symbol: 'TSLA', action: 'buy', state, config: makeConfig(), portfolioValue: 5000, assetValue: 0 });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/cooldown/i);
  });

  test('approves buy after cooldown expires', () => {
    const state = makeState();
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    state.positions['TSLA'] = { last_trade_at: threeHoursAgo };
    const result = check({ symbol: 'TSLA', action: 'buy', state, config: makeConfig(), portfolioValue: 5000, assetValue: 0 });
    expect(result.approved).toBe(true);
  });
});

describe('check — trades paused', () => {
  test('blocks all buys when paused', () => {
    const state = makeState();
    state.risk.trades_paused = true;
    const result = check({ symbol: 'TSLA', action: 'buy', state, config: makeConfig(), portfolioValue: 5000, assetValue: 0 });
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/drawdown/i);
  });
});

describe('checkDrawdown', () => {
  test('updates peak when portfolio increases', () => {
    const state = makeState();
    checkDrawdown(state, 6000);
    expect(state.risk.portfolio_peak_value).toBe(6000);
  });

  test('pauses trades when drawdown >= 20%', () => {
    const state = makeState();
    state.risk.portfolio_peak_value = 5000;
    checkDrawdown(state, 3900); // 22% drawdown
    expect(state.risk.trades_paused).toBe(true);
  });

  test('does not pause at 19% drawdown', () => {
    const state = makeState();
    state.risk.portfolio_peak_value = 5000;
    checkDrawdown(state, 4100); // 18% drawdown
    expect(state.risk.trades_paused).toBe(false);
  });
});

describe('resetDailyCounters', () => {
  test('resets daily trades counter on new day', () => {
    const state = makeState();
    state.risk.daily_trades_today = 7;
    state.risk.last_reset = 'Mon Jan 01 2000';
    resetDailyCounters(state);
    expect(state.risk.daily_trades_today).toBe(0);
  });

  test('does not reset on same day', () => {
    const state = makeState();
    state.risk.daily_trades_today = 7;
    resetDailyCounters(state);
    expect(state.risk.daily_trades_today).toBe(7);
  });
});
