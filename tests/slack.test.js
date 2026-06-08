const SlackNotifier = require('../src/slack');

describe('SlackNotifier.formatCheckReport', () => {
  const notifier = new SlackNotifier(null);

  test('includes connection layer info', () => {
    const msg = notifier.formatCheckReport({
      layer: 1,
      cash: 1000,
      portfolioValue: 5000,
      assets: [],
      totalPnl: 100,
      totalPnlPct: 2,
      aiUsage: { dailyCalls: 5, dailyLimit: 20, monthlyCost: 1, monthlyBudget: 10 },
      risk: { macroEquity: 'bull', macroCrypto: 'bear', paused: false, dailyTrades: 2, maxDailyTrades: 10 }
    });
    expect(msg).toContain('Bağlantı: 1');
    expect(msg).toContain('$1000.00');
    expect(msg).toContain('5/20');
  });

  test('marks buy action correctly in asset line', () => {
    const msg = notifier.formatCheckReport({
      layer: 1,
      cash: 1000,
      portfolioValue: 5000,
      assets: [{ symbol: 'TSLA', price: 248, avgCost: 275, change: -9.7, action: 'buy' }],
      totalPnl: 0,
      totalPnlPct: 0,
      aiUsage: { dailyCalls: 0, dailyLimit: 20, monthlyCost: 0, monthlyBudget: 10 },
      risk: { macroEquity: 'bull', macroCrypto: 'sideways', paused: false, dailyTrades: 0, maxDailyTrades: 10 }
    });
    expect(msg).toContain('TSLA');
    expect(msg).toContain('ALINDI');
  });
});

describe('SlackNotifier.formatTrade', () => {
  const notifier = new SlackNotifier(null);

  test('formats buy trade correctly', () => {
    const msg = notifier.formatTrade({ action: 'buy', symbol: 'TSLA', price: 248, amount: 100, newAvg: 261.5, cashRemaining: 900 });
    expect(msg).toContain('🟢 ALIM — TSLA');
    expect(msg).toContain('$248');
    expect(msg).toContain('$100.00');
  });

  test('formats sell trade correctly', () => {
    const msg = notifier.formatTrade({ action: 'sell', symbol: 'AAPL', price: 195, pnl: 42.75, cashRemaining: 1042.75, tranche: '1/3', reason: 'strong resistance' });
    expect(msg).toContain('🔴 SATIM — AAPL');
    expect(msg).toContain('+$42.75');
  });
});
