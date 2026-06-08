const { calcBreadthScore } = require('../src/analysis/breadth');

function makeCloses(length, price = 100) {
  return Array.from({ length }, () => price);
}

// Helper: 60 closes where last price is above or below a flat 50-day MA
function aboveMa50Closes()  { return makeCloses(60, 110); } // all = 110, ma50 = 110 → not above (equal)
function clearlyAbove()     { const c = makeCloses(60, 100); c[c.length - 1] = 120; return c; } // last > ma50
function clearlyBelow()     { const c = makeCloses(60, 100); c[c.length - 1] = 80;  return c; } // last < ma50

describe('calcBreadthScore', () => {
  test('all 11 sectors above MA50 → count=11, state=BROAD', () => {
    const histories = {};
    const { SECTOR_ETFS } = require('../src/analysis/breadth');
    SECTOR_ETFS.forEach(s => { histories[s] = clearlyAbove(); });
    const result = calcBreadthScore(histories);
    expect(result.count).toBe(11);
    expect(result.state).toBe('BROAD');
  });

  test('all 11 sectors below MA50 → count=0, state=WEAK', () => {
    const histories = {};
    const { SECTOR_ETFS } = require('../src/analysis/breadth');
    SECTOR_ETFS.forEach(s => { histories[s] = clearlyBelow(); });
    const result = calcBreadthScore(histories);
    expect(result.count).toBe(0);
    expect(result.state).toBe('WEAK');
  });

  test('7 above, 4 below → state=BROAD', () => {
    const { SECTOR_ETFS } = require('../src/analysis/breadth');
    const histories = {};
    SECTOR_ETFS.forEach((s, i) => {
      histories[s] = i < 7 ? clearlyAbove() : clearlyBelow();
    });
    const result = calcBreadthScore(histories);
    expect(result.count).toBe(7);
    expect(result.state).toBe('BROAD');
  });

  test('5 above → state=NARROW', () => {
    const { SECTOR_ETFS } = require('../src/analysis/breadth');
    const histories = {};
    SECTOR_ETFS.forEach((s, i) => {
      histories[s] = i < 5 ? clearlyAbove() : clearlyBelow();
    });
    const result = calcBreadthScore(histories);
    expect(result.count).toBe(5);
    expect(result.state).toBe('NARROW');
  });

  test('3 above → state=WEAK', () => {
    const { SECTOR_ETFS } = require('../src/analysis/breadth');
    const histories = {};
    SECTOR_ETFS.forEach((s, i) => {
      histories[s] = i < 3 ? clearlyAbove() : clearlyBelow();
    });
    const result = calcBreadthScore(histories);
    expect(result.count).toBe(3);
    expect(result.state).toBe('WEAK');
  });

  test('null/insufficient data sectors are skipped (not counted)', () => {
    const { SECTOR_ETFS } = require('../src/analysis/breadth');
    const histories = {};
    SECTOR_ETFS.forEach((s, i) => {
      if (i === 0) histories[s] = null;         // null → skipped
      else if (i === 1) histories[s] = [100];   // too short → skipped
      else histories[s] = clearlyAbove();
    });
    const result = calcBreadthScore(histories);
    // 9 valid above-MA sectors
    expect(result.count).toBe(9);
    expect(result.total).toBe(9);
    expect(result.state).toBe('BROAD');
  });

  test('boundary: exactly 4 sectors → NARROW not WEAK', () => {
    const { SECTOR_ETFS } = require('../src/analysis/breadth');
    const histories = {};
    SECTOR_ETFS.forEach((s, i) => {
      histories[s] = i < 4 ? clearlyAbove() : clearlyBelow();
    });
    const result = calcBreadthScore(histories);
    expect(result.count).toBe(4);
    expect(result.state).toBe('NARROW');
  });

  test('boundary: exactly 6 sectors → NARROW not BROAD', () => {
    const { SECTOR_ETFS } = require('../src/analysis/breadth');
    const histories = {};
    SECTOR_ETFS.forEach((s, i) => {
      histories[s] = i < 6 ? clearlyAbove() : clearlyBelow();
    });
    const result = calcBreadthScore(histories);
    expect(result.count).toBe(6);
    expect(result.state).toBe('NARROW');
  });

  test('returns sector breakdown in result', () => {
    const { SECTOR_ETFS } = require('../src/analysis/breadth');
    const histories = {};
    SECTOR_ETFS.forEach(s => { histories[s] = clearlyAbove(); });
    const result = calcBreadthScore(histories);
    expect(result.sectors).toBeDefined();
    expect(result.sectors['XLK']).toHaveProperty('aboveMa50', true);
  });
});
