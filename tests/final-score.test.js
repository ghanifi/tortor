const { calcFinalScore, scoreToTier } = require('../src/analysis/final-score');

describe('calcFinalScore', () => {
  test('returns 0 when all inputs are 0/null', () => {
    const score = calcFinalScore({ rsScore: 0, techScore: 0, marketScore: 0, breadthCount: 0, adx: null });
    expect(score).toBe(0);
  });

  test('returns 100 for perfect inputs', () => {
    const score = calcFinalScore({ rsScore: 100, techScore: 100, marketScore: 100, breadthCount: 11, adx: 50, adxMin: 20 });
    expect(score).toBe(100);
  });

  test('weights: RS 30%, Tech 25%, Market 20%, Breadth 15%, ADX 10%', () => {
    const score = calcFinalScore({ rsScore: 100, techScore: 0, marketScore: 0, breadthCount: 0, adx: null });
    expect(score).toBe(30); // RS only
  });

  test('breadth 0/11 contributes 0', () => {
    const score = calcFinalScore({ rsScore: 0, techScore: 0, marketScore: 0, breadthCount: 0, adx: null });
    expect(score).toBe(0);
  });

  test('breadth 11/11 contributes 15', () => {
    const score = calcFinalScore({ rsScore: 0, techScore: 0, marketScore: 0, breadthCount: 11, adx: null });
    expect(score).toBe(15);
  });

  test('ADX at adxMin contributes 0', () => {
    const score = calcFinalScore({ rsScore: 0, techScore: 0, marketScore: 0, breadthCount: 0, adx: 20, adxMin: 20 });
    expect(score).toBe(0);
  });

  test('ADX at adxMin+30 contributes 10', () => {
    const score = calcFinalScore({ rsScore: 0, techScore: 0, marketScore: 0, breadthCount: 0, adx: 50, adxMin: 20 });
    expect(score).toBe(10);
  });

  test('null adx contributes 0', () => {
    const s1 = calcFinalScore({ rsScore: 50, techScore: 50, marketScore: 50, breadthCount: 5, adx: null });
    const s2 = calcFinalScore({ rsScore: 50, techScore: 50, marketScore: 50, breadthCount: 5, adx: 20, adxMin: 20 });
    expect(s1).toBe(s2);
  });

  test('clamps inputs above 100 to 100', () => {
    const score = calcFinalScore({ rsScore: 200, techScore: 200, marketScore: 200, breadthCount: 100, adx: 200, adxMin: 20 });
    expect(score).toBe(100);
  });

  test('null rsScore defaults to 0', () => {
    const score = calcFinalScore({ rsScore: null, techScore: 0, marketScore: 0, breadthCount: 0, adx: null });
    expect(score).toBe(0);
  });

  test('null marketScore defaults to 50', () => {
    const score = calcFinalScore({ rsScore: 0, techScore: 0, marketScore: null, breadthCount: 0, adx: null });
    expect(score).toBe(10); // 50 * 0.20 = 10
  });

  test('typical strong setup scores above 85', () => {
    const score = calcFinalScore({ rsScore: 95, techScore: 90, marketScore: 95, breadthCount: 10, adx: 40, adxMin: 20 });
    expect(score).toBeGreaterThanOrEqual(85);
  });

  test('weak setup scores below 70', () => {
    const score = calcFinalScore({ rsScore: 30, techScore: 40, marketScore: 40, breadthCount: 3, adx: 22, adxMin: 20 });
    expect(score).toBeLessThan(70);
  });
});

describe('scoreToTier', () => {
  test('score >= strongScore → STRONG_BUY', () => {
    expect(scoreToTier(85, 70, 85)).toBe('STRONG_BUY');
    expect(scoreToTier(95, 70, 85)).toBe('STRONG_BUY');
  });

  test('score >= entryScore and < strongScore → BUY', () => {
    expect(scoreToTier(70, 70, 85)).toBe('BUY');
    expect(scoreToTier(80, 70, 85)).toBe('BUY');
  });

  test('score < entryScore → NO_ENTRY', () => {
    expect(scoreToTier(69, 70, 85)).toBe('NO_ENTRY');
    expect(scoreToTier(0, 70, 85)).toBe('NO_ENTRY');
  });

  test('uses defaults entryScore=70 strongScore=85', () => {
    expect(scoreToTier(85)).toBe('STRONG_BUY');
    expect(scoreToTier(75)).toBe('BUY');
    expect(scoreToTier(65)).toBe('NO_ENTRY');
  });
});
