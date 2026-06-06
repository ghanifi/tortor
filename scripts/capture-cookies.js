// scripts/capture-cookies.js
// Görünür Chrome penceresi açar, manuel giriş yapman için bekler,
// giriş sonrası tüm cookie'leri (httpOnly dahil) kaydeder.
//
// Çalıştır: node scripts/capture-cookies.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const COOKIE_FILE = path.join(process.cwd(), 'logs', 'session_cookies.json');
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000; // 3 dakika bekleme süresi

async function main() {
  console.log('🌐 Chrome açılıyor...');
  console.log('   eToro giriş sayfasına gidilecek.');
  console.log('   Kullanıcı adı ve şifreyi kendin gir, giriş yap.');
  console.log('   Giriş başarılı olunca cookie\'ler otomatik kaydedilecek.\n');

  const browser = await chromium.launch({
    channel: 'chrome',   // Gerçek Chrome kullan (Chromium değil)
    headless: false,
    args: ['--start-maximized'],
    ignoreDefaultArgs: ['--enable-automation']  // Bot uyarı banner'ını gizle
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: null
  });

  const page = await context.newPage();

  // logindata API çağrısını dinle — bu başarılı olunca giriş yapılmış demektir
  let loginDetected = false;
  page.on('response', async (response) => {
    if (response.url().includes('/api/logininfo/v1.1/logindata') && response.status() === 200) {
      loginDetected = true;
    }
  });

  await page.goto('https://www.etoro.com/login', { waitUntil: 'domcontentloaded' });

  console.log('⏳ Giriş bekleniyor (maksimum 3 dakika)...');

  // logindata çağrısı başarılı olana kadar bekle
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (!loginDetected && Date.now() < deadline) {
    await page.waitForTimeout(1000);
  }

  if (!loginDetected) {
    console.error('❌ 3 dakika içinde giriş yapılmadı. Script sonlandırılıyor.');
    await browser.close();
    process.exit(1);
  }

  // Biraz bekle (session cookie'lerinin set edilmesi için)
  await page.waitForTimeout(2000);

  // Tüm cookie'leri al (httpOnly dahil — Playwright erişebilir)
  const cookies = await context.cookies(['https://www.etoro.com', 'https://etoro.com']);

  if (!fs.existsSync(path.dirname(COOKIE_FILE))) {
    fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
  }
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));

  console.log(`\n✅ ${cookies.length} cookie kaydedildi → ${COOKIE_FILE}`);
  console.log('\n📋 Kaydedilen cookie\'ler:');
  cookies.forEach(c => {
    const flag = c.httpOnly ? '[httpOnly] ' : '           ';
    const val = c.value.length > 40 ? c.value.substring(0, 40) + '...' : c.value;
    console.log(`  ${flag} ${c.name}: ${val}`);
  });

  await browser.close();
  console.log('\n✅ Tamamlandı! Cookie\'ler kaydedildi, Chrome kapatıldı.');
}

main().catch(err => {
  console.error('Hata:', err.message);
  process.exit(1);
});
