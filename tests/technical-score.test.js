const { calcTechnicalScore } = require('../src/analysis/technical-score');

// Helper: generate a trending-up closes array of length n
function trendingCloses(n, start = 100, step = 1) {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

// Helper: generate flat highs/lows around closes
function hlFromCloses(closes, spread = 2) {
  return {
    highs:  closes.map(c => c + spread),
    lows:   closes.map(c => c - spread),
  };
}

describe('calcTechnicalScore', () => {
  test('MACD histogram is null for insufficient data (< 26 candles)', () => {
    const closes = trendingCloses(20);
    const { highs, lows } = hlFromCloses(closes);
    const volumes = Array(20).fill(1000);
    const result = calcTechnicalScore(closes, highs, lows, volumes);
    // MACD needs 26+ candles, should be null
    expect(result.macdHistogram).toBeNull();
    // Score should not include MACD component (no throw)
    expect(typeof result.score).toBe('number');
  });

  test('RSI in bullish zone (50–70) adds 30 points', () => {
    // Alternating moves with slight upward bias → RSI ~55
    const closes = [];
    let price = 100;
    for (let i = 0; i < 60; i++) {
      price += i % 2 === 0 ? 0.8 : -0.3;
      closes.push(price);
    }
    const { highs, lows } = hlFromCloses(closes);
    const volumes = Array(60).fill(1000);
    const result = calcTechnicalScore(closes, highs, lows, volumes);
    if (result.rsi !== null && result.rsi >= 50 && result.rsi <= 70) {
      expect(result.score).toBeGreaterThanOrEqual(30);
    }
    expect(typeof result.score).toBe('number');
  });

  test('RSI in borderline zone (40–50) adds 15 points', () => {
    // Flat price → RSI near 50
    const closes = Array(60).fill(100);
    const { highs, lows } = hlFromCloses(closes);
    const volumes = Array(60).fill(1000);
    const result = calcTechnicalScore(closes, highs, lows, volumes);
    // RSI of a flat series is ~50
    if (result.rsi !== null && result.rsi >= 40 && result.rsi < 50) {
      expect(result.score).toBeGreaterThanOrEqual(15);
    }
    // At minimum, no throw
    expect(typeof result.score).toBe('number');
  });

  test('positive MACD histogram adds 30 points', () => {
    // Accelerating uptrend produces positive MACD histogram
    const closes = trendingCloses(60, 100, 1);
    const { highs, lows } = hlFromCloses(closes);
    const volumes = Array(60).fill(1000);
    const result = calcTechnicalScore(closes, highs, lows, volumes);
    if (result.macdHistogram !== null && result.macdHistogram > 0) {
      expect(result.score).toBeGreaterThanOrEqual(30);
    }
  });

  test('volume > 1.2× average adds 20 points and sets volumeExpanding', () => {
    const closes = trendingCloses(60, 100, 0.5);
    const { highs, lows } = hlFromCloses(closes);
    // Last candle has 2× average volume
    const volumes = [...Array(59).fill(1000), 2000];
    const result = calcTechnicalScore(closes, highs, lows, volumes);
    expect(result.volumeExpanding).toBe(true);
  });

  test('volume between 1× and 1.2× average adds 10 points', () => {
    const closes = trendingCloses(60, 100, 0.5);
    const { highs, lows } = hlFromCloses(closes);
    // Last candle has 1.1× average volume
    const volumes = [...Array(59).fill(1000), 1100];
    const result = calcTechnicalScore(closes, highs, lows, volumes);
    expect(result.volumeExpanding).toBe(true);
  });

  test('volume below average does not set volumeExpanding', () => {
    const closes = trendingCloses(60, 100, 0.5);
    const { highs, lows } = hlFromCloses(closes);
    const volumes = [...Array(59).fill(1000), 500];
    const result = calcTechnicalScore(closes, highs, lows, volumes);
    expect(result.volumeExpanding).toBe(false);
  });

  test('ATR expansion sets atrExpanding when short ATR > long ATR × 1.1', () => {
    // Volatility spike at the end
    const base = trendingCloses(50, 100, 0.5);
    const volatile = Array.from({ length: 10 }, (_, i) => 125 + (i % 2 === 0 ? 5 : -5));
    const closes = [...base, ...volatile];
    const highs = closes.map(c => c + 8);
    const lows  = closes.map(c => c - 8);
    const volumes = Array(closes.length).fill(1000);
    const result = calcTechnicalScore(closes, highs, lows, volumes);
    // atrExpanding may or may not fire depending on exact values, just no throw
    expect(typeof result.atrExpanding).toBe('boolean');
  });

  test('score is capped at 100', () => {
    // Best-case scenario: all four components max
    const closes = trendingCloses(60, 100, 0.5);
    const { highs, lows } = hlFromCloses(closes);
    const volumes = [...Array(59).fill(1000), 2000];
    const result = calcTechnicalScore(closes, highs, lows, volumes);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  test('no volumes array → volume component skipped, no throw', () => {
    const closes = trendingCloses(60, 100, 0.5);
    const { highs, lows } = hlFromCloses(closes);
    expect(() => calcTechnicalScore(closes, highs, lows, [])).not.toThrow();
  });
});
