const { calcChange, calcPnL, calcTotalPortfolioValue, allocateBudget } = require('../src/portfolio');

describe('calcChange', () => {
  test('returns percent change from avg cost', () => {
    expect(calcChange(248, 275)).toBeCloseTo(-9.82, 1);
  });
  test('returns 0 when prices equal', () => {
    expect(calcChange(100, 100)).toBe(0);
  });
  test('returns null when no avg cost', () => {
    expect(calcChange(100, null)).toBeNull();
    expect(calcChange(100, 0)).toBeNull();
  });
});

describe('calcPnL', () => {
  test('calculates profit correctly', () => {
    expect(calcPnL(2, 275, 300)).toBeCloseTo(50);
  });
  test('calculates loss correctly', () => {
    expect(calcPnL(2, 275, 248)).toBeCloseTo(-54);
  });
});

describe('calcTotalPortfolioValue', () => {
  test('sums positions + cash', () => {
    const positions = {
      TSLA: { quantity: 2, avg_cost: 275 },
      BTC:  { quantity: 0.1, avg_cost: 60000 }
    };
    const prices = { TSLA: 300, BTC: 65000 };
    const cash = 500;
    // 2*300 + 0.1*65000 + 500 = 600 + 6500 + 500 = 7600
    expect(calcTotalPortfolioValue(positions, prices, cash)).toBeCloseTo(7600);
  });
});

describe('allocateBudget', () => {
  test('uses per_asset limit if defined', () => {
    const config = { budget: { default: 'equal_split', per_asset: { TSLA: 500 } }, safety: { min_cash_reserve: 100 } };
    const result = allocateBudget('TSLA', ['TSLA', 'AAPL'], 1000, config);
    expect(result).toBe(500);
  });

  test('splits remaining cash equally for unlimited assets', () => {
    // TSLA has limit 200, AAPL and NVDA share (1000 - 100 reserve - 200) = 700 / 2 = 350
    const config = {
      budget: { default: 'equal_split', per_asset: { TSLA: 200 } },
      safety: { min_cash_reserve: 100 }
    };
    const result = allocateBudget('AAPL', ['TSLA', 'AAPL', 'NVDA'], 1000, config);
    expect(result).toBeCloseTo(350);
  });

  test('returns 0 when cash is at reserve', () => {
    const config = { budget: { default: 'equal_split', per_asset: {} }, safety: { min_cash_reserve: 1000 } };
    expect(allocateBudget('TSLA', ['TSLA'], 1000, config)).toBe(0);
  });
});
