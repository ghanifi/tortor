// src/etoro/http.js
// NOTE: Verify these endpoints using Chrome DevTools → Network tab while logged in to eToro.
// Endpoints may have changed. Update BASE_URL, paths, and request bodies as needed.
const axios = require('axios');

const BASE_URL = 'https://www.etoro.com';
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.etoro.com',
  'Referer': 'https://www.etoro.com/portfolio'
};

class EToroHTTPClient {
  constructor() {
    this.session = axios.create({ baseURL: BASE_URL, headers: DEFAULT_HEADERS, timeout: 15000 });
    this.cookieStr = '';
  }

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
    // Return raw set-cookie headers for storage
    return res.headers['set-cookie'] || [];
  }

  async getLoginData() {
    // Returns portfolio + account info in one call
    const res = await this.session.get('/api/logininfo/v1.1/logindata', {
      params: { client_request_id: Date.now() }
    });
    return res.data;
  }

  async getInstrumentRates(symbols) {
    // symbols: array e.g. ['TSLA', 'AAPL']
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
