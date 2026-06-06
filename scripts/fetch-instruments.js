// scripts/fetch-instruments.js
// logindata endpoint'inden InstrumentsMetadata çekerek instruments_map.json oluşturur.
// Çalıştır: node scripts/fetch-instruments.js

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

const AUTH_SESSION_PATH = path.join(process.cwd(), 'logs', 'auth_session.json');
const OUTPUT_PATH = path.join(process.cwd(), 'logs', 'instruments_map.json');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

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
      'Origin': 'https://www.etoro.com',
      'Referer': 'https://www.etoro.com/home',
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

  console.log('logindata çekiliyor (InstrumentsMetadata)...');
  const res = await client.get('/api/logindata/v2/logindata', {
    params: {
      client_request_id: `bot_${Date.now()}`,
      conditionIncludeDisplayableInstruments: false,
      conditionIncludeMarkets: false,
      conditionIncludeMetadata: true,
      conditionIncludeMirrorValidation: false,
      conditionIncludeRates: true
    }
  });

  const api = res.data?.AggregatedResult?.ApiResponses;
  if (!api) {
    console.error('Beklenmeyen yanıt yapısı:', JSON.stringify(res.data).slice(0, 300));
    process.exit(1);
  }

  const metadata = api?.InstrumentsMetadata?.Content || {};
  const rates    = api?.Rates?.Content || {};

  if (!Object.keys(metadata).length) {
    console.error('InstrumentsMetadata boş geldi. Session süresi dolmuş olabilir.');
    process.exit(1);
  }

  // id → symbol map
  const map = {};
  for (const [id, info] of Object.entries(metadata)) {
    const sym = info?.SymbolFull || info?.Symbol || '';
    if (sym) map[id] = sym;
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(map, null, 2));
  console.log(`\n✅ ${Object.keys(map).length} enstrüman kaydedildi → ${OUTPUT_PATH}`);

  // Watchlist sembollerini bul ve güncel fiyatlarını göster
  const watchlist = ['SNDK', 'BLLN', 'SMR', 'ASTS', 'OKLO', 'RR.L'];
  console.log('\n📋 Watchlist sembol → ID → fiyat:');
  for (const sym of watchlist) {
    const entry = Object.entries(map).find(([, s]) => s === sym);
    if (entry) {
      const [id] = entry;
      const rate = rates[id];
      const price = rate ? ((rate.Bid + rate.Ask) / 2).toFixed(4) : '?';
      console.log(`  ${sym.padEnd(8)} → ID: ${id.padEnd(6)}  fiyat: $${price}`);
    } else {
      console.log(`  ${sym.padEnd(8)} → bulunamadı`);
    }
  }

  // Mevcut pozisyonların ID'lerini de göster
  const portfolioPath = path.join(process.cwd(), 'logs', 'portfolio_snapshot.json');
  if (fs.existsSync(portfolioPath)) {
    const portfolio = JSON.parse(fs.readFileSync(portfolioPath, 'utf8'));
    const positionIds = [...new Set((portfolio.positions || []).map(p => String(p.InstrumentID)))];
    if (positionIds.length) {
      console.log('\n💼 Mevcut pozisyon enstrümanları:');
      for (const id of positionIds) {
        console.log(`  ID: ${id.padEnd(6)} → ${map[id] || '?'}`);
      }
    }
  }
}

main().catch(err => {
  const msg = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
  console.error('Hata:', msg);
  process.exit(1);
});
