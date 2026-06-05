const { calculateRSI, calculateMACD, calculateBollinger, calculateATR, analyzeSignals } = require('../src/analysis/indicators');

// 30 days of mock prices: trending up from 100 to 130
const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
const highs  = closes.map(v => v + 2);
const lows   = closes.map(v => v - 2);

describe('calculateRSI', () => {
  test('returns null when not enough data', () => {
    expect(calculateRSI([100, 101, 102], 14)).toBeNull();
  });

  test('returns a number between 0 and 100 with enough data', () => {
    const result = calculateRSI(closes, 14);
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(100);
  });

  test('trending up prices have RSI > 50', () => {
    const result = calculateRSI(closes, 14);
    expect(result).toBeGreaterThan(50);
  });
});

describe('calculateMACD', () => {
  test('returns null with fewer than 26 closes', () => {
    expect(calculateMACD(closes.slice(0, 20))).toBeNull();
  });

  test('returns macd, signal, histogram', () => {
    const result = calculateMACD(closes);
    expect(result).toHaveProperty('macd');
    expect(result).toHaveProperty('signal');
    expect(result).toHaveProperty('histogram');
  });
});

describe('calculateBollinger', () => {
  test('returns null with fewer than 20 closes', () => {
    expect(calculateBollinger(closes.slice(0, 10))).toBeNull();
  });

  test('upper > middle > lower', () => {
    const result = calculateBollinger(closes);
    expect(result.upper).toBeGreaterThan(result.middle);
    expect(result.middle).toBeGreaterThan(result.lower);
  });
});

describe('analyzeSignals', () => {
  test('returns a signal string', () => {
    const result = analyzeSignals(closes, highs, lows);
    expect(['bullish', 'bearish', 'neutral']).toContain(result.signal);
  });

  test('returns rsi, macd, bollinger, atr fields', () => {
    const result = analyzeSignals(closes, highs, lows);
    expect(result).toHaveProperty('rsi');
    expect(result).toHaveProperty('macd');
    expect(result).toHaveProperty('bollinger');
    expect(result).toHaveProperty('atr');
  });
});
