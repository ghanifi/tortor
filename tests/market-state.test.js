// tests/market-state.test.js
const { calcMarketStateScore, getMarketState } = require('../src/analysis/market-state');

// Helper: array of N identical values
function flat(val, n) { return Array.from({ length: n }, () => val); }

// All-bullish data: every condition met → score = 100
const bullData = {
  spy:   { closes: flat(100, 60), price: 110 },     // price 110 > sma50 100 → +20
  qqq:   { closes: flat(200, 60), price: 220 },     // +15
  vix:   { price: 15 },                             // <20 → +20
  dxy:   { closes: flat(105, 30), price: 103 },     // price < sma20 → +15
  us10y: { price: 4.2, price30dAgo: 4.5 },          // falling → +15
  btc: {
    closes: [...flat(50000, 150), ...flat(60000, 50)],
    price: 65000,                                   // price>ma50>ma200 → +15
  },
};

describe('calcMarketStateScore', () => {
  test('all conditions met → score 100, RISK_ON', () => {
    const { state, score } = calcMarketStateScore(bullData);
    expect(score).toBe(100);
    expect(state).toBe('RISK_ON');
  });

  test('VIX 20-30 adds only +10', () => {
    const { score } = calcMarketStateScore({ ...bullData, vix: { price: 25 } });
    expect(score).toBe(90); // 100 - 10 (VIX bonus reduced from +20 to +10)
  });

  test('VIX > 30 adds +0', () => {
    const { score } = calcMarketStateScore({ ...bullData, vix: { price: 35 } });
    expect(score).toBe(80); // 100 - 20 (VIX contributes nothing)
  });

  test('score 40-69 → RISK_NEUTRAL', () => {
    // Strip SPY, QQQ, BTC points: price below SMA
    const bearish = {
      ...bullData,
      spy:   { closes: flat(100, 60), price: 90 },  // price < sma50 → 0
      qqq:   { closes: flat(200, 60), price: 190 }, // 0
      vix:   { price: 25 },                         // +10
      btc:   { closes: flat(50000, 200), price: 45000 }, // price<ma50 → 0
    };
    // Score: 0+0+10+15+15+0 = 40
    const { state, score } = calcMarketStateScore(bearish);
    expect(score).toBe(40);
    expect(state).toBe('RISK_NEUTRAL');
  });

  test('score 20-39 → RISK_OFF', () => {
    const data = {
      spy:   { closes: flat(100, 60), price: 90 },
      qqq:   { closes: flat(200, 60), price: 190 },
      vix:   { price: 25 },                         // +10
      dxy:   { closes: flat(105, 30), price: 103 }, // +15
      us10y: { price: 4.5, price30dAgo: 4.2 },      // rising → 0
      btc:   { closes: flat(50000, 200), price: 45000 }, // 0
    };
    // Score: 0+0+10+15+0+0 = 25
    const { state, score } = calcMarketStateScore(data);
    expect(score).toBe(25);
    expect(state).toBe('RISK_OFF');
  });

  test('score < 20 → PANIC', () => {
    const data = {
      spy:   { closes: flat(100, 60), price: 90 },
      qqq:   { closes: flat(200, 60), price: 190 },
      vix:   { price: 35 },
      dxy:   { closes: flat(105, 30), price: 106 },
      us10y: { price: 4.5, price30dAgo: 4.2 },
      btc:   { closes: flat(50000, 200), price: 45000 },
    };
    const { state, score } = calcMarketStateScore(data);
    expect(score).toBe(0);
    expect(state).toBe('PANIC');
  });
});

describe('getMarketState cache', () => {
  test('returns cached state when last_fetch is within 60 minutes', async () => {
    const recentState = {
      market_state: {
        state: 'RISK_ON',
        score: 82,
        last_fetch: new Date().toISOString(), // just now
      }
    };
    const result = await getMarketState(recentState);
    expect(result.state).toBe('RISK_ON');
    expect(result.score).toBe(82);
  });

  test('returns cached state when last_fetch is 30 minutes ago', async () => {
    const freshState = {
      market_state: {
        state: 'RISK_NEUTRAL',
        score: 55,
        last_fetch: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
      }
    };
    const result = await getMarketState(freshState);
    expect(result.state).toBe('RISK_NEUTRAL');
    expect(result.score).toBe(55);
  });

  test('cache returns last_fetch field', async () => {
    const ts = new Date().toISOString();
    const cachedState = { market_state: { state: 'RISK_ON', score: 75, last_fetch: ts } };
    const result = await getMarketState(cachedState);
    expect(result.last_fetch).toBe(ts);
  });
});
