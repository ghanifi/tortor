// tests/relative-strength.test.js
const { calcRelativeStrength, getExchangeBenchmark } = require('../src/analysis/relative-strength');

describe('calcRelativeStrength', () => {
  test('+5% outperformance → score 90', () => {
    // raw_rs = 10 - 5 = +5 → 50 + 5*8 = 90
    expect(calcRelativeStrength(10, 5)).toBe(90);
  });

  test('equal returns → score 50', () => {
    expect(calcRelativeStrength(5, 5)).toBe(50);
  });

  test('-5% underperformance → score 10', () => {
    // raw_rs = 0 - 5 = -5 → 50 + (-5)*8 = 10
    expect(calcRelativeStrength(0, 5)).toBe(10);
  });

  test('extreme negative → clamped to 0', () => {
    // raw_rs = -20 → 50 + (-20)*8 = -110 → 0
    expect(calcRelativeStrength(-20, 0)).toBe(0);
  });

  test('extreme positive → clamped to 100', () => {
    // raw_rs = +20 → 50 + 20*8 = 210 → 100
    expect(calcRelativeStrength(20, 0)).toBe(100);
  });

  test('zero returns → score 50', () => {
    expect(calcRelativeStrength(0, 0)).toBe(50);
  });
});

describe('getExchangeBenchmark', () => {
  test('UK stocks (.L suffix) → ^FTSE', () => {
    expect(getExchangeBenchmark('RR.L')).toBe('^FTSE');
    expect(getExchangeBenchmark('VOD.L')).toBe('^FTSE');
    expect(getExchangeBenchmark('BP.L')).toBe('^FTSE');
  });

  test('BTC uses SPY as benchmark (vs equities, not itself)', () => {
    expect(getExchangeBenchmark('BTC')).toBe('SPY');
    expect(getExchangeBenchmark('BTC-USD')).toBe('SPY');
  });

  test('altcoins use BTC-USD as benchmark', () => {
    expect(getExchangeBenchmark('ETH')).toBe('BTC-USD');
    expect(getExchangeBenchmark('SOL')).toBe('BTC-USD');
    expect(getExchangeBenchmark('ETH-USD')).toBe('BTC-USD');
  });

  test('US stocks → SPY', () => {
    expect(getExchangeBenchmark('AAPL')).toBe('SPY');
    expect(getExchangeBenchmark('NVDA')).toBe('SPY');
    expect(getExchangeBenchmark('SNDK')).toBe('SPY');
  });
});
