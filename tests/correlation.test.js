const { getDailyReturns, pearsonCorrelation, checkCorrelation } = require('../src/analysis/correlation');

describe('getDailyReturns', () => {
  test('returns n-1 returns for n closes', () => {
    const closes = [100, 102, 101, 103, 105];
    const returns = getDailyReturns(closes, 4);
    expect(returns.length).toBe(4);
  });

  test('returns empty array for fewer than 2 closes', () => {
    expect(getDailyReturns([100], 20)).toEqual([]);
    expect(getDailyReturns([], 20)).toEqual([]);
  });
});

describe('pearsonCorrelation', () => {
  test('identical series returns 1.0', () => {
    const r = [0.01, -0.02, 0.03, 0.01, -0.01, 0.02, 0.01, -0.01, 0.03, 0.02,
               0.01, -0.02, 0.03, 0.01, -0.01, 0.02, 0.01, -0.01, 0.03, 0.02];
    expect(pearsonCorrelation(r, r)).toBeCloseTo(1.0, 5);
  });

  test('inverse series returns -1.0', () => {
    const r = [0.01, -0.02, 0.03, 0.01, -0.01, 0.02, 0.01, -0.01, 0.03, 0.02,
               0.01, -0.02, 0.03, 0.01, -0.01, 0.02, 0.01, -0.01, 0.03, 0.02];
    const inv = r.map(v => -v);
    expect(pearsonCorrelation(r, inv)).toBeCloseTo(-1.0, 5);
  });

  test('returns 0 for fewer than 10 data points', () => {
    expect(pearsonCorrelation([0.01, 0.02], [0.01, 0.02])).toBe(0);
  });

  test('returns 0 for zero-variance series', () => {
    const flat = Array(20).fill(0);
    const r = Array(20).fill(0.01);
    expect(pearsonCorrelation(flat, r)).toBe(0);
  });
});

describe('checkCorrelation', () => {
  // Helper: generate 21 closes with known returns
  function closesFromReturns(returns, start = 100) {
    const closes = [start];
    for (const r of returns) closes.push(closes[closes.length - 1] * (1 + r));
    return closes;
  }

  const highReturns = [0.02, -0.01, 0.03, 0.01, -0.02, 0.02, 0.01, -0.01, 0.03, 0.02,
                       0.01, -0.02, 0.03, 0.01, -0.01, 0.02, 0.01, -0.01, 0.03, 0.02];

  test('returns { blocked: false } when no open positions', () => {
    const candidateCloses = closesFromReturns(highReturns);
    const result = checkCorrelation(candidateCloses, {}, {}, 0.85);
    expect(result.blocked).toBe(false);
  });

  test('blocks when candidate is identical to an open position', () => {
    const candidateCloses = closesFromReturns(highReturns);
    const openPositions = { AAPL: { quantity: 1 } };
    const historyMap = { AAPL: { closes: candidateCloses } };
    const result = checkCorrelation(candidateCloses, openPositions, historyMap, 0.85);
    expect(result.blocked).toBe(true);
    expect(result.with).toBe('AAPL');
    expect(result.correlation).toBeGreaterThanOrEqual(0.85);
  });

  test('does not block when correlation is below threshold', () => {
    const candidateCloses = closesFromReturns(highReturns);
    // Uncorrelated: opposite returns
    const uncorrelated = closesFromReturns(highReturns.map(r => -r));
    const openPositions = { MSFT: { quantity: 1 } };
    const historyMap = { MSFT: { closes: uncorrelated } };
    const result = checkCorrelation(candidateCloses, openPositions, historyMap, 0.85);
    expect(result.blocked).toBe(false);
  });

  test('skips positions with quantity 0', () => {
    const candidateCloses = closesFromReturns(highReturns);
    const openPositions = { AAPL: { quantity: 0 } };
    const historyMap = { AAPL: { closes: candidateCloses } };
    const result = checkCorrelation(candidateCloses, openPositions, historyMap, 0.85);
    expect(result.blocked).toBe(false);
  });

  test('skips positions with insufficient history', () => {
    const candidateCloses = closesFromReturns(highReturns);
    const openPositions = { AAPL: { quantity: 1 } };
    const historyMap = { AAPL: { closes: [100, 101] } }; // too short
    const result = checkCorrelation(candidateCloses, openPositions, historyMap, 0.85);
    expect(result.blocked).toBe(false);
  });

  test('returns { blocked: false } when candidate has insufficient data', () => {
    const result = checkCorrelation([100, 101], { AAPL: { quantity: 1 } }, {}, 0.85);
    expect(result.blocked).toBe(false);
  });
});
