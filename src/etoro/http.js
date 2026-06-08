// src/etoro/http.js
// NOTE: Endpoints verified from Chrome DevTools → Network tab (2026-06-05).
// Auth uses Bearer JWT in 'authorization' header + session cookies.
// Run `node scripts/refresh-session.js` to update the auth session.
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://www.etoro.com';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const AUTH_SESSION_PATH = path.join(DATA_DIR, 'logs', 'auth_session.json');

// Matches the mobile Chrome session observed in the real browser
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9,tr-TR;q=0.8,tr;q=0.7,en-US;q=0.6',
  'Origin': 'https://www.etoro.com',
  'Referer': 'https://www.etoro.com/home',
  'accounttype': 'Real',
  'applicationidentifier': 'ReToro',
  'applicationversion': 'v651.1282.0'
};

// Bypass SSL inspection proxy that presents self-signed certs
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

class EToroHTTPClient {
  constructor() {
    this.session = axios.create({ baseURL: BASE_URL, headers: DEFAULT_HEADERS, timeout: 15000, httpsAgent });
    this.cookieStr = '';

    // Inject current client time with every request (eToro requires this)
    this.session.interceptors.request.use(config => {
      config.headers['x-sts-clienttime'] = new Date().toISOString().substring(0, 19);
      return config;
    });
  }

  // Load auth session captured from a real browser (logs/auth_session.json).
  // Returns true if session was loaded, false if file is missing.
  loadAuthSession() {
    try {
      if (!fs.existsSync(AUTH_SESSION_PATH)) {
        console.warn('[HTTP] No auth session file — run: node scripts/refresh-session.js');
        return false;
      }
      const data = JSON.parse(fs.readFileSync(AUTH_SESSION_PATH, 'utf8'));

      if (data.cookieString) {
        this.session.defaults.headers['Cookie'] = data.cookieString;
        this.cookieStr = data.cookieString;
      }
      if (data.authorization) {
        this.session.defaults.headers['authorization'] = data.authorization;
      }
      if (data.sessionId) {
        this.session.defaults.headers['x-session-id'] = data.sessionId;
      }
      if (data.deviceId) {
        this.session.defaults.headers['x-sts-deviceid'] = data.deviceId;
        this.session.defaults.headers['x-sts-autologin'] = 'true';
      }

      const ageHours = (Date.now() - new Date(data.capturedAt).getTime()) / 3600000;
      if (ageHours > 20) {
        console.warn(`[HTTP] Auth session is ${ageHours.toFixed(0)}h old — may need refresh`);
      }
      return true;
    } catch (err) {
      console.error('[HTTP] Failed to load auth session:', err.message);
      return false;
    }
  }

  // Legacy: set cookies from Playwright-captured array format
  setCookies(cookies) {
    this.cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    this.session.defaults.headers['Cookie'] = this.cookieStr;
  }

  async login(username, password) {
    const res = await this.session.post('/api/sts/v2/login', {
      login: username,
      password,
      redirectTo: '/portfolio',
      client_request_id: `bot_${Date.now()}`
    }, { withCredentials: true });
    return res.headers['set-cookie'] || [];
  }

  async getLoginData() {
    // v2 endpoint with required condition params (verified 2026-06-05)
    const res = await this.session.get('/api/logindata/v2/logindata', {
      params: {
        client_request_id: `bot_${Date.now()}`,
        conditionIncludeDisplayableInstruments: false,
        conditionIncludeMarkets: false,
        conditionIncludeMetadata: true,
        conditionIncludeMirrorValidation: false,
        conditionIncludeRates: true
      }
    });
    return res.data;
  }

  async getInstrumentRates(symbols) {
    const res = await this.session.get('/api/trade-real/v3/instruments', {
      params: { InstrumentIDs: symbols.join(',') }
    });
    return res.data;
  }

  async getPriceHistory(instrumentId, period = 'OneDay', candles = 30) {
    const res = await this.session.get(`/api/trade-real/v3/instruments/${instrumentId}/candles`, {
      params: { Period: period, Candles: candles }
    });
    return res.data;
  }

  async openPosition({ instrumentId, isBuy, amount, leverage = 1 }) {
    const res = await this.session.post('/api/trade-real/v3/positions', {
      InstrumentID: instrumentId,
      IsBuy: isBuy,
      Leverage: leverage,
      Amount: amount,
      TakeProfitRate: null,
      StopLossRate: null
    });
    return res.data;
  }

  async closePosition(positionId) {
    const res = await this.session.delete(`/api/trade-real/v3/positions/${positionId}`);
    return res.data;
  }

  async getPortfolioPositions() {
    const res = await this.session.get('/api/trade-real/v3/positions', {
      params: { client_request_id: Date.now() }
    });
    return res.data;
  }
}

module.exports = EToroHTTPClient;
