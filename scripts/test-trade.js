// scripts/test-trade.js
// Gerçek alış/satış testi — HTTP katmanı üzerinden.
// Çalıştır: node scripts/test-trade.js
// NOT: Bu script gerçek para kullanır. dry_run değil.

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

const AUTH_SESSION_PATH = path.join(process.cwd(), 'logs', 'auth_session.json');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const INSTRUMENT_ID = 9956;   // OKLO
const SYMBOL        = 'OKLO';
const BUY_AMOUNT    = 25;      // $25 — eToro minimum

async function main() {
  const session = JSON.parse(fs.readFileSync(AUTH_SESSION_PATH, 'utf8'));

  const client = axios.create({
    baseURL: 'https://www.etoro.com',
    timeout: 20000,
    httpsAgent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-GB,en;q=0.9',
      'Content-Type': 'application/json',
      'Origin': 'https://www.etoro.com',
      'Referer': 'https://www.etoro.com/portfolio',
      'accounttype': 'Real',
      'applicationidentifier': 'ReToro',
      'applicationversion': 'v651.1282.0',
      'authorization': session.authorization,
      'Cookie': session.cookieString,
      'x-session-id': session.sessionId || '',
      'x-sts-deviceid': session.deviceId || '',
      'x-sts-autologin': 'true',
      'x-sts-clienttime': new Date().toISOString().substring(0, 19),
    }
  });

  // ── ALIM ────────────────────────────────────────────────────────────────────
  console.log(`\n🟢 ALIM: ${SYMBOL} — $${BUY_AMOUNT}`);
  let positionId = null;

  try {
    const buyRes = await client.post('/api/trade-real/v3/positions', {
      InstrumentID: INSTRUMENT_ID,
      IsBuy: true,
      Leverage: 1,
      Amount: BUY_AMOUNT,
      TakeProfitRate: null,
      StopLossRate: null,
    });

    const r = buyRes.data;
    console.log('Ham yanıt:', JSON.stringify(r, null, 2));

    if (r.IsSucceeded === true || r.PositionID != null) {
      positionId = r.PositionID;
      console.log(`✅ ALIM başarılı — PositionID: ${positionId}  OpenRate: ${r.OpenRate}`);
    } else {
      console.error('❌ ALIM başarısız:', JSON.stringify(r));
      process.exit(1);
    }
  } catch (err) {
    const data = err.response?.data;
    console.error('❌ ALIM hatası:', data ? JSON.stringify(data) : err.message);
    process.exit(1);
  }

  // ── 3 SANIYE BEKLE ──────────────────────────────────────────────────────────
  console.log('\n⏳ 3 saniye bekleniyor...');
  await new Promise(r => setTimeout(r, 3000));

  // ── SATIM ───────────────────────────────────────────────────────────────────
  console.log(`\n🔴 SATIM: PositionID ${positionId}`);

  try {
    const sellRes = await client.delete(`/api/trade-real/v3/positions/${positionId}`);
    const r = sellRes.data;
    console.log('Ham yanıt:', JSON.stringify(r, null, 2));

    if (r.IsSucceeded === true) {
      console.log(`✅ SATIM başarılı — P&L: ${r.Profit ?? '?'}`);
    } else {
      console.error('❌ SATIM başarısız:', JSON.stringify(r));
    }
  } catch (err) {
    const data = err.response?.data;
    console.error('❌ SATIM hatası:', data ? JSON.stringify(data) : err.message);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
