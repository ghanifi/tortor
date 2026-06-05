const { canCallAI, recordCall, shouldWarnBudget } = require('../src/analysis/ai_budget');

function makeState(overrides = {}) {
  return {
    ai_usage: {
      daily_calls: 0,
      daily_limit: 20,
      monthly_cost_usd: 0,
      monthly_budget_usd: 10,
      last_reset: new Date().toDateString(),
      ...overrides
    }
  };
}

test('canCallAI returns allowed when under limits', () => {
  const state = makeState();
  expect(canCallAI(state).allowed).toBe(true);
});

test('canCallAI blocks when daily limit reached', () => {
  const state = makeState({ daily_calls: 20 });
  expect(canCallAI(state).allowed).toBe(false);
  expect(canCallAI(state).reason).toMatch(/günlük/i);
});

test('canCallAI blocks when monthly budget exhausted', () => {
  const state = makeState({ monthly_cost_usd: 10 });
  expect(canCallAI(state).allowed).toBe(false);
  expect(canCallAI(state).reason).toMatch(/aylık/i);
});

test('recordCall increments daily_calls and monthly_cost_usd', () => {
  const state = makeState();
  const updated = recordCall(state, 0.0003);
  expect(updated.ai_usage.daily_calls).toBe(1);
  expect(updated.ai_usage.monthly_cost_usd).toBeCloseTo(0.0003);
});

test('shouldWarnBudget true at 90% of monthly budget', () => {
  const state = makeState({ monthly_cost_usd: 9.1, monthly_budget_usd: 10 });
  expect(shouldWarnBudget(state)).toBe(true);
});

test('shouldWarnBudget false below 90%', () => {
  const state = makeState({ monthly_cost_usd: 5, monthly_budget_usd: 10 });
  expect(shouldWarnBudget(state)).toBe(false);
});

test('canCallAI resets daily_calls on new day', () => {
  const state = makeState({ daily_calls: 20, last_reset: 'Mon Jan 01 2000' });
  expect(canCallAI(state).allowed).toBe(true);
  expect(state.ai_usage.daily_calls).toBe(0);
});
