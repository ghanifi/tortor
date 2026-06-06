// src/etoro/bridge.js
// Chrome extension üzerinden trade işlemleri.
// Bot → server kuyruğu → extension → eToro API (tarayıcıdan, Datadome yok)

const axios = require('axios');

const BRIDGE_URL = 'http://localhost:3737';
const RESULT_POLL_INTERVAL = 2000; // ms
const RESULT_TIMEOUT = 30000; // 30 saniye

async function isAvailable() {
  try {
    const res = await axios.get(`${BRIDGE_URL}/`, { timeout: 1500 });
    return res.data?.status === 'ok';
  } catch (_) {
    return false;
  }
}

async function queueTrade({ symbol, action, amount, positionId, dryRun }) {
  const res = await axios.post(`${BRIDGE_URL}/pending-trades`, {
    symbol, action, amount, positionId, dryRun: !!dryRun
  }, { timeout: 5000 });
  return res.data.id;
}

async function waitForResult(tradeId) {
  const deadline = Date.now() + RESULT_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, RESULT_POLL_INTERVAL));
    try {
      const res = await axios.get(`${BRIDGE_URL}/trade-result/${tradeId}`, { timeout: 3000 });
      if (res.data.result) return res.data.result;
    } catch (_) {}
  }
  throw new Error(`Trade sonucu ${RESULT_TIMEOUT / 1000}s içinde gelmedi (extension açık mı?)`);
}

async function executeTrade(params) {
  const tradeId = await queueTrade(params);
  const result = await waitForResult(tradeId);
  return result;
}

module.exports = { isAvailable, executeTrade, queueTrade, waitForResult };
