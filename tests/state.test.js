// tests/state.test.js
const fs = require('fs');
const path = require('path');

// Use a temp file for tests — must use mockTEST_STATE_PATH prefix for jest.mock hoisting
const mockStatePath = path.join(__dirname, 'tmp_state.json');

jest.mock('path', () => ({
  ...jest.requireActual('path'),
  join: (...args) => {
    if (args[args.length - 1] === 'state.json') return mockStatePath;
    return jest.requireActual('path').join(...args);
  }
}));

const { loadState, saveState, DEFAULT_STATE } = require('../src/state');

afterEach(() => {
  if (fs.existsSync(mockStatePath)) fs.unlinkSync(mockStatePath);
  jest.resetModules();
});

test('loadState returns DEFAULT_STATE when file does not exist', () => {
  const state = loadState();
  expect(state.positions).toEqual({});
  expect(state.risk.daily_trades_today).toBe(0);
});

test('saveState and loadState round-trip correctly', () => {
  const state = loadState();
  state.positions['TSLA'] = { avg_cost: 250, quantity: 2 };
  saveState(state);
  const loaded = loadState();
  expect(loaded.positions['TSLA'].avg_cost).toBe(250);
});
