const { detectEquityRegime, detectCryptoRegime, detectAssetRegime, applyRegimeAdjustments, sma } = require('../src/analysis/regime');

describe('sma', () => {
  test('returns null if not enough values', () => {
    expect(sma([1, 2, 3], 5)).toBeNull();
  });
  test('calculates correctly', () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
  });
});

describe('detectEquityRegime', () => {
  test('bull when price > MA200 and MA50 > MA200', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 100 + i * 0.5);
    expect(detectEquityRegime(closes)).toBe('bull');
  });

  test('bear when price < MA200', () => {
    const closes = Array.from({ length: 250 }, (_, i) => 300 - i * 0.5);
    expect(detectEquityRegime(closes)).toBe('bear');
  });

  test('sideways with insufficient data', () => {
    expect(detectEquityRegime([100, 101, 102])).toBe('sideways');
  });
});

describe('detectCryptoRegime', () => {
  test('bear when dominance rising by more than 1', () => {
    expect(detectCryptoRegime(55, 53)).toBe('bear');
  });
  test('bull when dominance falling by more than 1', () => {
    expect(detectCryptoRegime(50, 52)).toBe('bull');
  });
  test('sideways within 1% change', () => {
    expect(detectCryptoRegime(50, 50.5)).toBe('sideways');
  });
});

describe('detectAssetRegime', () => {
  test('bull trend for rising prices', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const result = detectAssetRegime(closes);
    expect(result.trend).toBe('bull');
  });

  test('returns trend and volatility fields', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const result = detectAssetRegime(closes);
    expect(result).toHaveProperty('trend');
    expect(result).toHaveProperty('volatility');
  });
});

describe('applyRegimeAdjustments', () => {
  const baseThresholds = { buy: -7, sell: [7, 10, 13] };

  test('bear macro tightens buy threshold', () => {
    const result = applyRegimeAdjustments(baseThresholds, 'bear', 'sideways', 'stocks', { trend: 'sideways' });
    expect(result.thresholds.buy).toBeLessThan(baseThresholds.buy);
    expect(result.budgetMultiplier).toBeLessThan(1);
  });

  test('bull macro keeps base thresholds', () => {
    const result = applyRegimeAdjustments(baseThresholds, 'bull', 'bull', 'stocks', { trend: 'bull' });
    expect(result.thresholds.buy).toBe(baseThresholds.buy);
    expect(result.budgetMultiplier).toBe(1.0);
  });
});
