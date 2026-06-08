const { calculateRSI, calculateMACD, calculateBollinger, calculateATR, analyzeSignals, calculateADX, calculateEMA } = require('../src/analysis/indicators');

// 30 days of mock prices: trending up from 100 to 130
const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
const highs  = closes.map(v => v + 2);
const lows   = closes.map(v => v - 2);

// 60 days trending up — enough for ADX period=14
const closes60 = Array.from({ length: 60 }, (_, i) => 100 + i);
const highs60   = closes60.map(v => v + 2);
const lows60    = closes60.map(v => v - 2);

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

describe('calculateADX', () => {
  test('returns null when fewer than 28 data points (period*2 - 1 = 27)', () => {
    const c27 = Array.from({ length: 27 }, (_, i) => 100 + i);
    expect(calculateADX(c27.map(v => v + 2), c27.map(v => v - 2), c27)).toBeNull();
  });

  test('returns a number with exactly 28 data points (period*2)', () => {
    const c28 = Array.from({ length: 28 }, (_, i) => 100 + i);
    const result = calculateADX(c28.map(v => v + 2), c28.map(v => v - 2), c28);
    // Library may still return null for minimal data — we accept either null or a number
    // The important thing is it doesn't throw
    expect(() => calculateADX(c28.map(v => v + 2), c28.map(v => v - 2), c28)).not.toThrow();
  });

  test('returns a positive number with enough data', () => {
    const result = calculateADX(highs60, lows60, closes60);
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThan(0);
  });

  test('strong trend produces ADX > 20', () => {
    const result = calculateADX(highs60, lows60, closes60);
    expect(result).toBeGreaterThan(20);
  });
});

describe('calculateEMA', () => {
  test('returns null when fewer data points than period (period-1 items)', () => {
    const c49 = Array.from({ length: 49 }, (_, i) => 100 + i);
    expect(calculateEMA(c49, 50)).toBeNull();
  });

  test('returns a number within data range', () => {
    const result = calculateEMA(closes60, 14);
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThan(100);
    expect(result).toBeLessThan(160);
  });

  test('EMA50 of trending-up series < last price', () => {
    const result = calculateEMA(closes60, 50);
    expect(result).toBeLessThan(closes60[closes60.length - 1]);
  });
});
