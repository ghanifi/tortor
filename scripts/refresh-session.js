// scripts/refresh-session.js
// eToro session süresi dolduğunda (bot 401/403 alıyorsa) bu scripti çalıştır.
// Chrome DevTools'tan kopyalanan header'larla auth_session.json'u günceller.
//
// Çalıştır: node scripts/refresh-session.js
//
// ADIMLAR:
// 1. Chrome'da eToro'ya giriş yap (www.etoro.com)
// 2. F12 → Network sekmesi
// 3. Sayfayı yenile (F5)
// 4. Sol listede "logindata" isteğini bul
// 5. Tıkla → sağda "Headers" sekmesine geç
// 6. "Request Headers" bölümünden şunları kopyala:
//    - cookie: (tüm değeri)
//    - authorization: (tüm JWT değeri)
//    - x-session-id: değeri
//    - x-sts-deviceid: değeri
// 7. Bu scripti çalıştır ve yapıştır

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const AUTH_SESSION_PATH = path.join(process.cwd(), 'logs', 'auth_session.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  console.log('\n=== eToro Session Yenileme ===\n');
  console.log('Chrome DevTools → Network → logindata isteği → Headers sekmesi\n');
  console.log('Her değeri ayrı satıra yapıştırın, boş bırakmak için Enter basın.\n');

  const authorization = (await ask('authorization (eyJ... ile başlar): ')).trim();
  const cookieString = (await ask('cookie (OptanonAlertBoxClosed= ile başlar): ')).trim();
  const sessionId = (await ask('x-session-id: ')).trim();
  const deviceId = (await ask('x-sts-deviceid: ')).trim();

  rl.close();

  if (!authorization || !cookieString) {
    console.error('\n❌ authorization ve cookie zorunlu. Çıkılıyor.');
    process.exit(1);
  }

  // Validate JWT format
  if (!authorization.startsWith('eyJ')) {
    console.error('\n❌ authorization değeri eyJ ile başlamalı (JWT token). Tekrar dene.');
    process.exit(1);
  }

  const session = {
    capturedAt: new Date().toISOString(),
    sessionId: sessionId || undefined,
    deviceId: deviceId || undefined,
    authorization,
    cookieString
  };

  // Remove undefined fields
  Object.keys(session).forEach(k => session[k] === undefined && delete session[k]);

  fs.mkdirSync(path.dirname(AUTH_SESSION_PATH), { recursive: true });
  fs.writeFileSync(AUTH_SESSION_PATH, JSON.stringify(session, null, 2));

  console.log('\n✅ Session kaydedildi:', AUTH_SESSION_PATH);
  console.log('   Tarihi:', session.capturedAt);

  // Quick test
  console.log('\n🔍 API bağlantısı test ediliyor...');
  try {
    const EToroHTTPClient = require('../src/etoro/http');
    const client = new EToroHTTPClient();
    client.loadAuthSession();
    const data = await client.getLoginData();
    const summary = data.AggregatedResult?.ResponseSummary;
    console.log(`✅ Başarılı! CID: ${summary?.Cid}, Hesap: ${summary?.AccountType}`);
    const positions = data.AggregatedResult?.ApiResponses?.PrivatePortfolio?.Content?.ClientPortfolio?.Positions;
    console.log(`   Portföyde ${positions?.length || 0} pozisyon var.`);
  } catch (err) {
    console.error('❌ API testi başarısız:', err.response?.status, err.message);
    console.log('   Session kaydedildi fakat bağlantı çalışmıyor. Cookie/JWT doğru mu?');
  }
}

main().catch(err => {
  console.error('Hata:', err.message);
  rl.close();
  process.exit(1);
});
