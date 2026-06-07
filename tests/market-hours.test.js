const { isMarketOpen, getExchange } = require('../src/market-hours');

describe('getExchange', () => {
  test('crypto symbols return CRYPTO', () => {
    expect(getExchange('BTC')).toBe('CRYPTO');
    expect(getExchange('ETH')).toBe('CRYPTO');
    expect(getExchange('SOL')).toBe('CRYPTO');
  });
  test('.L suffix returns LSE', () => {
    expect(getExchange('RR.L')).toBe('LSE');
    expect(getExchange('BP.L')).toBe('LSE');
  });
  test('regular symbols return NYSE', () => {
    expect(getExchange('OKLO')).toBe('NYSE');
    expect(getExchange('ASTS')).toBe('NYSE');
    expect(getExchange('TSLA')).toBe('NYSE');
  });
});

describe('isMarketOpen - Crypto', () => {
  test('BTC always open, even on weekend', () => {
    const sunday = new Date('2025-01-05T03:00:00Z');
    const result = isMarketOpen('BTC', sunday);
    expect(result.open).toBe(true);
    expect(result.exchange).toBe('CRYPTO');
  });
});

describe('isMarketOpen - NYSE', () => {
  // January 2025 = EST (UTC-5). NYSE: 09:30–16:00 ET = 14:30–21:00 UTC
  const wednesdayOpen     = new Date('2025-01-08T15:00:00Z'); // 10:00 ET ✓
  const wednesdayPreOpen  = new Date('2025-01-08T13:00:00Z'); // 08:00 ET ✗
  const wednesdayPostClose= new Date('2025-01-08T21:30:00Z'); // 16:30 ET ✗
  const saturday          = new Date('2025-01-11T15:00:00Z'); // Sat ✗
  const sunday            = new Date('2025-01-12T15:00:00Z'); // Sun ✗

  test('open during trading hours', () => {
    const r = isMarketOpen('OKLO', wednesdayOpen);
    expect(r.open).toBe(true);
    expect(r.exchange).toBe('NYSE');
    expect(r.reason).toBeNull();
  });
  test('closed before open', () => {
    const r = isMarketOpen('OKLO', wednesdayPreOpen);
    expect(r.open).toBe(false);
    expect(r.reason).toMatch(/NYSE/);
  });
  test('closed after close', () => {
    expect(isMarketOpen('OKLO', wednesdayPostClose).open).toBe(false);
  });
  test('closed on Saturday', () => {
    const r = isMarketOpen('OKLO', saturday);
    expect(r.open).toBe(false);
    expect(r.reason).toBe('hafta sonu');
  });
  test('closed on Sunday', () => {
    expect(isMarketOpen('TSLA', sunday).open).toBe(false);
  });
});

describe('isMarketOpen - LSE', () => {
  // January 2025 = GMT (UTC+0). LSE: 08:00–16:30 GMT
  const wednesdayOpen     = new Date('2025-01-08T10:00:00Z'); // 10:00 GMT ✓
  const wednesdayPreOpen  = new Date('2025-01-08T07:00:00Z'); // 07:00 GMT ✗
  const wednesdayPostClose= new Date('2025-01-08T17:00:00Z'); // 17:00 GMT ✗
  const saturday          = new Date('2025-01-11T10:00:00Z'); // Sat ✗

  test('open during trading hours', () => {
    const r = isMarketOpen('RR.L', wednesdayOpen);
    expect(r.open).toBe(true);
    expect(r.exchange).toBe('LSE');
    expect(r.reason).toBeNull();
  });
  test('closed before open', () => {
    const r = isMarketOpen('RR.L', wednesdayPreOpen);
    expect(r.open).toBe(false);
    expect(r.reason).toMatch(/LSE/);
  });
  test('closed after close', () => {
    expect(isMarketOpen('RR.L', wednesdayPostClose).open).toBe(false);
  });
  test('closed on weekend', () => {
    expect(isMarketOpen('RR.L', saturday).open).toBe(false);
  });
});
