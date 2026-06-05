const { decide, calcNewAvgCost } = require('../src/strategies/dca');

const stockThresholds = { buy: -7, sell: [7, 10, 13] };
const indicators = { rsi: 30, macd: { histogram: -0.5 }, bollinger: null, signal: 'bullish' };

describe('decide — hold zone', () => {
  test('holds when change is 0', () => {
    const result = decide({ change: 0, thresholds: stockThresholds, indicators });
    expect(result.action).toBe('hold');
  });

  test('holds when change is -5 (above buy threshold)', () => {
    const result = decide({ change: -5, thresholds: stockThresholds, indicators });
    expect(result.action).toBe('hold');
  });
});

describe('decide — buy zone', () => {
  test('buys at exactly -7%', () => {
    const result = decide({ change: -7, thresholds: stockThresholds, indicators });
    expect(result.action).toBe('buy');
    expect(result.portion).toBe(1.0);
  });

  test('buys at -12% (deeper dip)', () => {
    const result = decide({ change: -12, thresholds: stockThresholds, indicators });
    expect(result.action).toBe('buy');
  });

  test('holds at buy threshold when RSI > 55 (not oversold)', () => {
    const result = decide({
      change: -7,
      thresholds: stockThresholds,
      indicators: { ...indicators, rsi: 60 }
    });
    expect(result.action).toBe('hold');
  });
});

describe('decide — sell zone', () => {
  test('sells 25% at first sell threshold', () => {
    const result = decide({ change: 7, thresholds: stockThresholds, indicators });
    expect(result.action).toBe('sell');
    expect(result.portion).toBe(0.25);
  });

  test('sells 50% at second threshold', () => {
    const result = decide({ change: 10, thresholds: stockThresholds, indicators });
    expect(result.action).toBe('sell');
    expect(result.portion).toBe(0.5);
  });

  test('sells 100% at third threshold', () => {
    const result = decide({ change: 13, thresholds: stockThresholds, indicators });
    expect(result.action).toBe('sell');
    expect(result.portion).toBe(1.0);
  });
});

describe('decide — edge zone', () => {
  test('returns edge when within 2% of buy threshold', () => {
    const result = decide({ change: -5.5, thresholds: stockThresholds, indicators: { rsi: 45 } });
    expect(result.action).toBe('edge');
  });

  test('returns edge when within 2% of first sell threshold', () => {
    const result = decide({ change: 5.5, thresholds: stockThresholds, indicators: { rsi: 45 } });
    expect(result.action).toBe('edge');
  });
});

describe('calcNewAvgCost', () => {
  test('returns new price when old qty is 0', () => {
    expect(calcNewAvgCost(0, 0, 2, 250)).toBe(250);
  });

  test('correctly weights existing and new position', () => {
    expect(calcNewAvgCost(2, 275, 1, 248)).toBeCloseTo(266, 0);
  });
});
