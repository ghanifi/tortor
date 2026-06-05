// tests/config.test.js
const { decrypt, loadConfig } = require('../src/config');
const fs = require('fs');
const path = require('path');

describe('decrypt', () => {
  beforeAll(() => {
    process.env.BOT_SECRET = 'a'.repeat(64); // 32-byte key in hex
  });

  test('round-trips a plaintext value', () => {
    const { encrypt } = require('../src/config');
    const original = 'mysecretpassword';
    const encrypted = encrypt(original);
    expect(encrypted).toMatch(/^encrypted:/);
    expect(decrypt(encrypted)).toBe(original);
  });
});

describe('loadConfig', () => {
  test('returns parsed config object with required keys', () => {
    const config = loadConfig();
    expect(config).toHaveProperty('etoro');
    expect(config).toHaveProperty('slack');
    expect(config).toHaveProperty('strategy');
    expect(config).toHaveProperty('watchlist');
    expect(Array.isArray(config.watchlist)).toBe(true);
  });
});
