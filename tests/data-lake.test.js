const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Point DATA_DIR to a temp directory for all tests
const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'data-lake-test-'));
process.env.DATA_DIR = tmpDir;

const { logEntry, logExit } = require('../src/analysis/data-lake');

const LAKE_FILE = path.join(tmpDir, 'logs', 'trades.jsonl');

function readLines() {
  return fs.readFileSync(LAKE_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('logEntry', () => {
  test('creates directory and writes a valid JSONL entry record', () => {
    logEntry({
      symbol:     'AAPL',
      tranche:    1,
      price:      150.123456,
      qty:        3.123456789,
      amount:     468.40,
      stopPrice:  145.5,
      reason:     'L1 entry',
      scores: {
        market_state:  'RISK_ON',
        market_score:  72,
        trend:         'BULL',
        adx:           28.7,
        atr:           3.12345,
        rs_score:      85.3,
        tech_score:    78,
        pyramid_level: 1,
      },
    });

    expect(fs.existsSync(LAKE_FILE)).toBe(true);
    const [rec] = readLines();
    expect(rec.type).toBe('entry');
    expect(rec.symbol).toBe('AAPL');
    expect(rec.tranche).toBe(1);
    expect(rec.price).toBe(150.1235);
    expect(rec.qty).toBe(3.123457);
    expect(rec.amount).toBe(468.40);
    expect(rec.stop_price).toBe(145.5);
    expect(rec.reason).toBe('L1 entry');
    expect(rec.scores.market_state).toBe('RISK_ON');
    expect(rec.scores.market_score).toBe(72);
    expect(rec.scores.trend).toBe('BULL');
    expect(rec.scores.adx).toBe(28.70);
    expect(rec.scores.atr).toBe(3.1235);
    expect(rec.scores.rs_score).toBe(85.3);
    expect(rec.scores.tech_score).toBe(78);
    expect(rec.scores.pyramid_level).toBe(1);
    expect(typeof rec.ts).toBe('string');
  });

  test('writes null scores for missing fields', () => {
    logEntry({
      symbol: 'BTC', tranche: 1, price: 60000, qty: 0.01, amount: 600,
      stopPrice: null, reason: 'L1', scores: {},
    });
    const lines = readLines();
    const rec = lines[lines.length - 1];
    expect(rec.scores.adx).toBeNull();
    expect(rec.scores.atr).toBeNull();
    expect(rec.scores.rs_score).toBeNull();
    expect(rec.scores.market_state).toBeNull();
    expect(rec.scores.pyramid_level).toBe(0);
    expect(rec.stop_price).toBeNull();
  });

  test('appends multiple entries without overwriting', () => {
    const before = readLines().length;
    logEntry({ symbol: 'NVDA', tranche: 1, price: 400, qty: 1, amount: 400, stopPrice: 380, reason: 'L1', scores: {} });
    logEntry({ symbol: 'NVDA', tranche: 2, price: 420, qty: 0.5, amount: 210, stopPrice: 400, reason: 'L2', scores: {} });
    expect(readLines().length).toBe(before + 2);
  });
});

describe('logExit', () => {
  test('writes a valid exit record with WIN result', () => {
    logExit({
      symbol: 'AAPL', price: 160, qty: 3, proceeds: 480,
      pnl: 30, pnlPct: 6.67, reason: 'Trend çıkışı', marketState: 'RISK_ON',
    });
    const lines = readLines();
    const rec = lines[lines.length - 1];
    expect(rec.type).toBe('exit');
    expect(rec.symbol).toBe('AAPL');
    expect(rec.price).toBe(160);
    expect(rec.proceeds).toBe(480);
    expect(rec.pnl).toBe(30);
    expect(rec.pnl_pct).toBe(6.67);
    expect(rec.result).toBe('WIN');
    expect(rec.reason).toBe('Trend çıkışı');
    expect(rec.market_state).toBe('RISK_ON');
  });

  test('writes LOSS result for negative pnl', () => {
    logExit({
      symbol: 'ETH', price: 2000, qty: 0.5, proceeds: 1000,
      pnl: -100, pnlPct: -9.09, reason: 'Stop-loss', marketState: 'RISK_NEUTRAL',
    });
    const lines = readLines();
    const rec = lines[lines.length - 1];
    expect(rec.result).toBe('LOSS');
    expect(rec.pnl).toBe(-100);
  });

  test('handles null marketState gracefully', () => {
    logExit({ symbol: 'SMR', price: 10, qty: 5, proceeds: 50, pnl: 5, pnlPct: 11.1, reason: 'Exit', marketState: null });
    const lines = readLines();
    const rec = lines[lines.length - 1];
    expect(rec.market_state).toBeNull();
  });
});
