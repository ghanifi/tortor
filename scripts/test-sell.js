// scripts/test-sell.js
// Chrome extension bridge üzerinden gerçek satış testi.
// Extension content.js /pending-trades'i 10sn'de bir poll eder ve tarayıcıdan execute eder.
//
// Önkoşullar:
//   1. node scripts/watchlist-server.js çalışıyor olmalı (localhost:3737)
//   2. Chrome'da eToro.com açık ve extension yüklü olmalı
//
// Çalıştır: node scripts/test-sell.js

const axios = require('axios');

const SERVER = 'http://localhost:3737';
const POSITION_ID = 2926571040; // OKLO — 2.677571 units, $79.39
const SYMBOL = 'OKLO';
const AMOUNT = 79.39;

const POLL_INTERVAL = 2000;
const TIMEOUT = 60000; // 60 saniye

async function main() {
  // Sunucu hazır mı?
  try {
    const health = await axios.get(`${SERVER}/`, { timeout: 3000 });
    console.log(`✅ Bridge sunucusu çalışıyor: ${health.data.status}`);
  } catch (err) {
    console.error('❌ Bridge sunucusu yanıt vermiyor. node scripts/watchlist-server.js çalışıyor mu?');
    process.exit(1);
  }

  // Satış işlemini kuyruğa ekle
  const trade = { symbol: SYMBOL, action: 'sell', amount: AMOUNT, positionId: POSITION_ID, dryRun: false };
  console.log(`\n🔴 SATIM kuyruğa ekleniyor: ${SYMBOL} — PositionID ${POSITION_ID}`);

  let tradeId;
  try {
    const res = await axios.post(`${SERVER}/pending-trades`, trade, { timeout: 5000 });
    tradeId = res.data.id;
    console.log(`   Trade ID: ${tradeId}`);
  } catch (err) {
    console.error('❌ Kuyruğa eklenemedi:', err.message);
    process.exit(1);
  }

  // Extension'ın işlemi tamamlamasını bekle (en fazla 60 saniye)
  console.log(`\n⏳ Extension yanıtı bekleniyor (max ${TIMEOUT / 1000}s)...`);
  console.log('   [Chrome\'da etoro.com açık ve extension yüklü olmalı]');

  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);
    try {
      const res = await axios.get(`${SERVER}/trade-result/${tradeId}`, { timeout: 3000 });
      const result = res.data.result;
      if (result) {
        if (result.ok) {
          console.log(`\n✅ SATIM BAŞARILI!`);
          console.log(`   Sembol    : ${result.symbol}`);
          console.log(`   Miktar    : $${result.amount}`);
          if (result.raw) console.log(`   HTTP durum: ${result.raw.status}`);
        } else {
          console.log(`\n❌ SATIM BAŞARISIZ:`);
          console.log(`   Hata: ${result.error}`);
          if (result.raw) console.log(`   HTTP durum: ${result.raw.status}`);
        }
        return;
      }
    } catch (_) {}
    process.stdout.write('.');
  }

  console.log('\n\n⏰ Zaman aşımı — extension yanıt vermedi.');
  console.log('   Kontrol listesi:');
  console.log('   - Chrome\'da etoro.com açık mı?');
  console.log('   - Extension yüklü ve etkin mi? (chrome://extensions/)');
  console.log('   - Extension console\'unda hata var mı? (Inspect service worker)');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
