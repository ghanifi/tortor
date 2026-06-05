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
  beforeEach(() => {
    jest.resetModules();
    process.env.BOT_SECRET = 'a'.repeat(64);
  });

  test('returns parsed config with required keys (plaintext password)', () => {
    jest.mock('fs', () => ({
      ...jest.requireActual('fs'),
      readFileSync: (filePath, encoding) => {
        if (filePath.includes('config.json')) {
          return JSON.stringify({
            etoro: { username: 'test@test.com', password: 'plaintext' },
            slack: { webhook_url: '' },
            strategy: { active: 'dca' },
            watchlist: ['TSLA'],
            safety: { dry_run: true }
          });
        }
        return jest.requireActual('fs').readFileSync(filePath, encoding);
      }
    }));
    const { loadConfig } = require('../src/config');
    const config = loadConfig();
    expect(config).toHaveProperty('etoro');
    expect(config).toHaveProperty('slack');
    expect(config).toHaveProperty('strategy');
    expect(config).toHaveProperty('watchlist');
    expect(Array.isArray(config.watchlist)).toBe(true);
    expect(config.etoro.password).toBe('plaintext');
  });

  test('decrypts real encrypted password', () => {
    // Compute the encrypted value inside the mock factory using require to avoid
    // Jest's out-of-scope variable restriction on jest.mock() factories.
    jest.mock('fs', () => {
      const actualCrypto = require('crypto');
      const ALGORITHM = 'aes-256-gcm';
      const key = Buffer.from('a'.repeat(64), 'hex');
      const iv = Buffer.alloc(12, 0); // deterministic iv for test
      const cipher = actualCrypto.createCipheriv(ALGORITHM, key, iv);
      const enc = Buffer.concat([cipher.update('mypassword', 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      const mockEncrypted = 'encrypted:' + Buffer.concat([iv, tag, enc]).toString('base64');
      return {
        ...jest.requireActual('fs'),
        readFileSync: (filePath, encoding) => {
          if (filePath.includes('config.json')) {
            return JSON.stringify({
              etoro: { username: 'test@test.com', password: mockEncrypted },
              slack: {}, strategy: {}, watchlist: [], safety: {}
            });
          }
          return jest.requireActual('fs').readFileSync(filePath, encoding);
        }
      };
    });
    const { loadConfig: loadConfig2 } = require('../src/config');
    const config = loadConfig2();
    expect(config.etoro.password).toBe('mypassword');
  });
});
