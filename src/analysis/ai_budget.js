// src/analysis/ai_budget.js
function canCallAI(state) {
  const usage = state.ai_usage;
  const today = new Date().toDateString();

  if (usage.last_reset !== today) {
    usage.daily_calls = 0;
    usage.last_reset = today;
  }

  if (usage.daily_calls >= usage.daily_limit) {
    return { allowed: false, reason: 'Günlük AI limit doldu' };
  }
  if (usage.monthly_cost_usd >= usage.monthly_budget_usd) {
    return { allowed: false, reason: 'Aylık AI bütçesi doldu' };
  }
  return { allowed: true };
}

function recordCall(state, costUsd) {
  state.ai_usage.daily_calls += 1;
  state.ai_usage.monthly_cost_usd += costUsd;
  return state;
}

function shouldWarnBudget(state) {
  const { monthly_cost_usd, monthly_budget_usd } = state.ai_usage;
  return monthly_cost_usd >= monthly_budget_usd * 0.9;
}

module.exports = { canCallAI, recordCall, shouldWarnBudget };
