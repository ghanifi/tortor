// tests/momentum.test.js
const { decideMomentum, checkExitTrigger } = require('../src/strategies/momentum');

const PASS = { allPass: true, failReason: null };
const FAIL = { allPass: false, failReason: 'RS filtresi: 60 < 70 (benchmark\'ın gerisinde)' };

// ── decideMomentum ────────────────────────────────────────────────────────────

describe('decideMomentum — level 0 (no position)', () => {
  test('all filters pass → buy tranche 1', () => {
    const r = decideMomentum({ pyramidLevel: 0, currentPrice: 100, entryPrice: null, level2Price: null, atr: 5, filters: PASS });
    expect(r.action).toBe('buy');
    expect(r.tranche).toBe(1);
  });

  test('filter fails → hold with fail reason', () => {
    const r = decideMomentum({ pyramidLevel: 0, currentPrice: 100, entryPrice: null, level2Price: null, atr: 5, filters: FAIL });
    expect(r.action).toBe('hold');
    expect(r.reason).toBe(FAIL.failReason);
  });
});

describe('decideMomentum — level 1 (waiting for L2 trigger)', () => {
  test('price below entry+ATR → hold', () => {
    const r = decideMomentum({ pyramidLevel: 1, currentPrice: 104, entryPrice: 100, level2Price: null, atr: 5, filters: PASS });
    expect(r.action).toBe('hold');
    // 104 is not > 100+5=105
  });

  test('price exactly at entry+ATR → hold (must be strictly above)', () => {
    const r = decideMomentum({ pyramidLevel: 1, currentPrice: 105, entryPrice: 100, level2Price: null, atr: 5, filters: PASS });
    expect(r.action).toBe('hold');
  });

  test('price above entry+ATR → buy tranche 2', () => {
    const r = decideMomentum({ pyramidLevel: 1, currentPrice: 106, entryPrice: 100, level2Price: null, atr: 5, filters: PASS });
    expect(r.action).toBe('buy');
    expect(r.tranche).toBe(2);
  });
});

describe('decideMomentum — level 2 (waiting for L3 trigger)', () => {
  test('price below level2+ATR → hold', () => {
    const r = decideMomentum({ pyramidLevel: 2, currentPrice: 114, entryPrice: 100, level2Price: 110, atr: 5, filters: PASS });
    expect(r.action).toBe('hold');
  });

  test('price above level2+ATR → buy tranche 3', () => {
    const r = decideMomentum({ pyramidLevel: 2, currentPrice: 116, entryPrice: 100, level2Price: 110, atr: 5, filters: PASS });
    expect(r.action).toBe('buy');
    expect(r.tranche).toBe(3);
  });
});

describe('decideMomentum — level 3 (fully pyramided)', () => {
  test('always hold', () => {
    const r = decideMomentum({ pyramidLevel: 3, currentPrice: 130, entryPrice: 100, level2Price: 110, atr: 5, filters: PASS });
    expect(r.action).toBe('hold');
    expect(r.tranche).toBeNull();
  });
});

// ── checkExitTrigger ──────────────────────────────────────────────────────────

const BULL_REGIME  = { trend: 'BULL', adx: 30, atr: 5 };
const BEAR_REGIME  = { trend: 'BEAR', adx: 25, atr: 5 };

describe('checkExitTrigger — trigger 4 PANIC (highest priority)', () => {
  test('PANIC fires even when price is above stop', () => {
    const r = checkExitTrigger({
      pos: { stop_price: 90 }, currentPrice: 150,
      assetRegime: BULL_REGIME,
      currentMarketState: 'PANIC', prevMarketState: 'RISK_ON'
    });
    expect(r.exit).toBe(true);
    expect(r.portion).toBe(1);
  });

  test('PANIC fires even at a loss (only unconditional exit)', () => {
    const r = checkExitTrigger({
      pos: { stop_price: 90, avg_cost: 100 }, currentPrice: 80,
      assetRegime: BULL_REGIME,
      currentMarketState: 'PANIC', prevMarketState: 'RISK_ON'
    });
    expect(r.exit).toBe(true);
    expect(r.portion).toBe(1);
  });
});

describe('checkExitTrigger — trigger 1 ATR stop', () => {
  test('price below stop_price → exit all', () => {
    const r = checkExitTrigger({
      pos: { stop_price: 95 }, currentPrice: 90,
      assetRegime: BULL_REGIME,
      currentMarketState: 'RISK_ON', prevMarketState: 'RISK_ON'
    });
    expect(r.exit).toBe(true);
    expect(r.portion).toBe(1);
    expect(r.reason).toMatch(/ATR stop/);
  });

  test('ATR stop is skipped when it would realize a loss (loss protection)', () => {
    const r = checkExitTrigger({
      pos: { stop_price: 80, avg_cost: 100 }, currentPrice: 75,
      assetRegime: BULL_REGIME,
      currentMarketState: 'RISK_ON', prevMarketState: 'RISK_ON'
    });
    expect(r.exit).toBe(false);
    expect(r._skipped).toMatch(/loss-protection/);
  });

  test('ATR stop still fires above avg_cost (breakeven/profit lock unaffected)', () => {
    const r = checkExitTrigger({
      pos: { stop_price: 105, avg_cost: 100 }, currentPrice: 103,
      assetRegime: BULL_REGIME,
      currentMarketState: 'RISK_ON', prevMarketState: 'RISK_ON'
    });
    expect(r.exit).toBe(true);
    expect(r.reason).toMatch(/ATR stop/);
  });

  test('price above stop_price → no ATR exit', () => {
    const r = checkExitTrigger({
      pos: { stop_price: 85 }, currentPrice: 100,
      assetRegime: BULL_REGIME,
      currentMarketState: 'RISK_ON', prevMarketState: 'RISK_ON'
    });
    expect(r.exit).toBe(false);
  });
});

describe('checkExitTrigger — trigger 2 trend break', () => {
  test('BEAR trend → exit all', () => {
    // entry_at must be old enough to clear the min_hold guard (default 60min)
    const oldEntry = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
    const r = checkExitTrigger({
      pos: { stop_price: 85, entry_at: oldEntry }, currentPrice: 100,
      assetRegime: BEAR_REGIME,
      currentMarketState: 'RISK_ON', prevMarketState: 'RISK_ON'
    });
    expect(r.exit).toBe(true);
    expect(r.portion).toBe(1);
    expect(r.reason).toMatch(/Trend/);
  });

  test('BEAR trend but would realize a loss → skipped (loss protection)', () => {
    const oldEntry = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago, clears min-hold
    const r = checkExitTrigger({
      pos: { stop_price: 85, avg_cost: 100, entry_at: oldEntry }, currentPrice: 95,
      assetRegime: BEAR_REGIME,
      currentMarketState: 'RISK_ON', prevMarketState: 'RISK_ON'
    });
    expect(r.exit).toBe(false);
    expect(r._skipped).toMatch(/loss-protection/);
  });
});

describe('checkExitTrigger — trigger 3 state degradation', () => {
  test('RISK_ON → RISK_OFF transition → close full position', () => {
    const r = checkExitTrigger({
      pos: { stop_price: 85 }, currentPrice: 100,
      assetRegime: BULL_REGIME,
      currentMarketState: 'RISK_OFF', prevMarketState: 'RISK_ON'
    });
    expect(r.exit).toBe(true);
    expect(r.portion).toBe(1);
    expect(r.reason).toMatch(/RISK_OFF/);
  });

  test('RISK_OFF → RISK_OFF (already degraded) → no trigger', () => {
    const r = checkExitTrigger({
      pos: { stop_price: 85 }, currentPrice: 100,
      assetRegime: BULL_REGIME,
      currentMarketState: 'RISK_OFF', prevMarketState: 'RISK_OFF'
    });
    expect(r.exit).toBe(false);
  });

  test('RISK_OFF transition but would realize a loss → skipped (loss protection)', () => {
    const r = checkExitTrigger({
      pos: { stop_price: 85, avg_cost: 100 }, currentPrice: 95,
      assetRegime: BULL_REGIME,
      currentMarketState: 'RISK_OFF', prevMarketState: 'RISK_ON'
    });
    expect(r.exit).toBe(false);
    expect(r._skipped).toMatch(/loss-protection/);
  });
});

describe('checkExitTrigger — no trigger', () => {
  test('RISK_ON + BULL + price above stop → no exit', () => {
    const r = checkExitTrigger({
      pos: { stop_price: 85 }, currentPrice: 100,
      assetRegime: BULL_REGIME,
      currentMarketState: 'RISK_ON', prevMarketState: 'RISK_ON'
    });
    expect(r.exit).toBe(false);
  });
});

describe('decideMomentum — L2/L3 respects market state filter', () => {
  const marketFailFilters = { allPass: false, failReason: 'Market state: RISK_NEUTRAL (RISK_ON gerekli)' };

  test('level 1 with non-RISK_ON market state → hold even if price cleared', () => {
    const r = decideMomentum({
      pyramidLevel: 1, currentPrice: 110, entryPrice: 100,
      level2Price: null, atr: 5, filters: marketFailFilters
    });
    expect(r.action).toBe('hold');
    expect(r.reason).toMatch(/Market state/);
  });

  test('level 2 with non-RISK_ON market state → hold even if price cleared', () => {
    const r = decideMomentum({
      pyramidLevel: 2, currentPrice: 125, entryPrice: 100,
      level2Price: 110, atr: 5, filters: marketFailFilters
    });
    expect(r.action).toBe('hold');
    expect(r.reason).toMatch(/Market state/);
  });
});

describe('decideMomentum — null price guards', () => {
  test('level 1 with null entryPrice → hold (no spurious L2 buy)', () => {
    const r = decideMomentum({ pyramidLevel: 1, currentPrice: 150, entryPrice: null, level2Price: null, atr: 5, filters: PASS });
    expect(r.action).toBe('hold');
    expect(r.reason).toMatch(/entry_price/);
  });

  test('level 2 with null level2Price → hold (no spurious L3 buy)', () => {
    const r = decideMomentum({ pyramidLevel: 2, currentPrice: 150, entryPrice: 100, level2Price: null, atr: 5, filters: PASS });
    expect(r.action).toBe('hold');
    expect(r.reason).toMatch(/level2_price/);
  });
});
