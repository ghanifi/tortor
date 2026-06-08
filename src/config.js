// src/config.js
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const secret = process.env.BOT_SECRET;
  if (!secret || secret.length !== 64) {
    throw new Error('BOT_SECRET env var must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(secret, 'hex');
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, tag, encrypted]);
  return 'encrypted:' + combined.toString('base64');
}

function decrypt(encryptedValue) {
  if (!encryptedValue.startsWith('encrypted:')) return encryptedValue;
  const key = getKey();
  const data = Buffer.from(encryptedValue.replace('encrypted:', ''), 'base64');
  const iv = data.slice(0, 12);
  const tag = data.slice(12, 28);
  const encrypted = data.slice(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted, null, 'utf8') + decipher.final('utf8');
}

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const PLACEHOLDER = 'encrypted:REPLACE_AFTER_RUNNING_npm_run_encrypt';
  const decryptField = (obj, field) => {
    const val = obj?.[field];
    if (val?.startsWith('encrypted:') && val !== PLACEHOLDER) {
      obj[field] = decrypt(val);
    }
  };
  decryptField(raw.etoro, 'password');
  decryptField(raw.etoro, 'publicApiKey');
  decryptField(raw.etoro, 'userApiKey');
  return raw;
}

module.exports = { loadConfig, encrypt, decrypt };
