const { isEarningsBlocked, checkEarningsBlock } = require('../src/analysis/event-engine');

describe('isEarningsBlocked', () => {
  function daysFromNow(n) {
    return new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  }

  test('returns blocked when earnings are 3 days away (within 5-day window)', () => {
    const result = isEarningsBlocked('AAPL', daysFromNow(3));
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Kazanç raporu yakın');
  });

  test('returns blocked on earnings day itself (0 days)', () => {
    const result = isEarningsBlocked('AAPL', daysFromNow(0));
    expect(result.blocked).toBe(true);
  });

  test('returns blocked 1 day after earnings (within daysAfter=2 window)', () => {
    const result = isEarningsBlocked('AAPL', daysFromNow(-1));
    expect(result.blocked).toBe(true);
  });

  test('returns not blocked when earnings are 10 days away', () => {
    const result = isEarningsBlocked('AAPL', daysFromNow(10));
    expect(result.blocked).toBe(false);
  });

  test('returns not blocked 3 days after earnings (beyond daysAfter=2)', () => {
    const result = isEarningsBlocked('AAPL', daysFromNow(-3));
    expect(result.blocked).toBe(false);
  });

  test('returns not blocked when earningsDate is null', () => {
    const result = isEarningsBlocked('AAPL', null);
    expect(result.blocked).toBe(false);
  });

  test('respects custom daysBefore and daysAfter parameters', () => {
    // 7 days out — blocked with daysBefore=10, not blocked with default 5
    const date = daysFromNow(7);
    expect(isEarningsBlocked('AAPL', date, 10, 2).blocked).toBe(true);
    expect(isEarningsBlocked('AAPL', date, 5,  2).blocked).toBe(false);
  });

  test('reason contains date and days-remaining label', () => {
    const date = daysFromNow(4);
    const result = isEarningsBlocked('AAPL', date, 5, 2);
    expect(result.reason).toContain('gün kaldı');
  });

  test('reason contains days-ago label when earnings just passed', () => {
    const date = daysFromNow(-1);
    const result = isEarningsBlocked('AAPL', date, 5, 2);
    expect(result.reason).toContain('gün önce');
  });
});

describe('checkEarningsBlock — crypto symbols', () => {
  test('BTC is never blocked (no earnings)', async () => {
    const result = await checkEarningsBlock('BTC');
    expect(result.blocked).toBe(false);
  });

  test('ETH is never blocked (no earnings)', async () => {
    const result = await checkEarningsBlock('ETH');
    expect(result.blocked).toBe(false);
  });

  test('BTC-USD variant is also skipped', async () => {
    const result = await checkEarningsBlock('BTC-USD');
    expect(result.blocked).toBe(false);
  });
});
