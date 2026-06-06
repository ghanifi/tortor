// scripts/sync-watchlist.js
// Auth session cookie'lerini Playwright'a inject eder, eToro home sayfasını açar,
// watchlist API yanıtını veya DOM'u okur, config.json'u günceller.
//
// Cron veya elle çalıştır: node scripts/sync-watchlist.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AUTH_SESSION_PATH = path.join(process.cwd(), 'logs', 'auth_session.json');
const CONFIG_PATH = path.join(process.cwd(), 'config.json');

// Parse "name=value; name2=value2" cookie string into Playwright cookie objects
function parseCookieString(cookieStr) {
  return cookieStr.split('; ').map(part => {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) return null;
    const name = part.substring(0, eqIdx).trim();
    const value = part.substring(eqIdx + 1).trim();
    if (!name) return null;
    return { name, value, domain: '.etoro.com', path: '/', secure: true, sameSite: 'Lax' };
  }).filter(Boolean);
}

async function syncWatchlist() {
  const session = JSON.parse(fs.readFileSync(AUTH_SESSION_PATH, 'utf8'));
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  console.log('🌐 Playwright başlatılıyor (cookie injection ile)...');

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=IdleDetection']
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: {
      'authorization': session.authorization,
      'accounttype': 'Real',
      'applicationidentifier': 'ReToro',
      'applicationversion': 'v651.1282.0',
      'x-session-id': session.sessionId || '',
      'x-sts-autologin': 'true'
    }
  });

  // Inject session cookies before first navigation
  const cookies = parseCookieString(session.cookieString);
  await context.addCookies(cookies);
  console.log(`  ${cookies.length} cookie inject edildi`);

  // Capture all API responses that look like watchlist data
  let watchlistSymbols = null;
  const capturedResponses = [];

  context.on('response', async response => {
    const url = response.url();
    const isJson = (response.headers()['content-type'] || '').includes('application/json');
    if (!isJson) return;

    // Listen for watchlist / user-lists API responses
    if (/user-list|watchlist|portfolio|instrument/i.test(url)) {
      try {
        const body = await response.json();
        capturedResponses.push({ url, body });
      } catch {}
    }
  });

  const page = await context.newPage();

  // Hide automation flags
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log('  https://www.etoro.com/home sayfasına gidiliyor...');
  try {
    await page.goto('https://www.etoro.com/home', {
      waitUntil: 'networkidle',
      timeout: 30000
    });
  } catch (err) {
    console.warn('  Timeout (normal), devam ediliyor:', err.message);
  }

  // Wait a bit more for async API calls
  await page.waitForTimeout(5000);

  console.log(`  ${capturedResponses.length} API yanıtı yakalandı`);

  // Try to extract symbols from captured API responses
  for (const { url, body } of capturedResponses) {
    console.log('  API:', url.replace('https://www.etoro.com', '').split('?')[0]);

    // Look for lists with instrument symbols
    const instruments = extractInstruments(body);
    if (instruments.length > 0) {
      console.log('  Semboller bulundu:', instruments);
      watchlistSymbols = instruments;
      break;
    }
  }

  // Fallback: try to extract from page DOM
  if (!watchlistSymbols) {
    console.log('  API yanıtında sembol bulunamadı, DOM deneniyor...');
    try {
      watchlistSymbols = await page.evaluate(() => {
        // Try various eToro DOM structures
        const selectors = [
          '[data-etoro-automation-id*="watchlist"] [automation-id*="symbol"]',
          '.watchlist-item .symbol',
          '[automation-id="watchlist-item"] .instrument-name',
          'et-instrument-name',
          '[class*="watchlist"] [class*="symbol"]',
        ];
        const found = new Set();
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(el => {
            const text = el.textContent?.trim();
            if (text && text.length <= 8 && /^[A-Z0-9]+$/.test(text)) found.add(text);
          });
        }

        // Also try window state
        try {
          const state = window.__INITIAL_STATE__ || window.appStore?.getState?.();
          if (state) {
            const str = JSON.stringify(state);
            const matches = str.match(/"SymbolFull":"([A-Z0-9]+)"/g);
            if (matches) matches.forEach(m => {
              const sym = m.match(/"SymbolFull":"([A-Z0-9]+)"/)?.[1];
              if (sym && sym.length <= 6) found.add(sym);
            });
          }
        } catch {}

        return [...found];
      });
    } catch (err) {
      console.warn('  DOM extraction hatası:', err.message);
    }
  }

  await browser.close();

  if (watchlistSymbols && watchlistSymbols.length > 0) {
    config.watchlist = watchlistSymbols;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(`\n✅ config.json güncellendi: watchlist = ${JSON.stringify(watchlistSymbols)}`);
    return watchlistSymbols;
  } else {
    console.log('\n⚠️  Watchlist alınamadı — Datadome engeli veya oturum süresi dolmuş olabilir.');
    console.log('   Mevcut config.json watchlist korunuyor:', config.watchlist);
    return null;
  }
}

function extractInstruments(obj) {
  const symbols = new Set();
  const str = JSON.stringify(obj);

  // Common eToro API patterns
  const patterns = [
    /"SymbolFull":"([A-Z0-9.\-]+)"/g,
    /"symbol":"([A-Z0-9]+)"/g,
    /"instrumentSymbol":"([A-Z0-9]+)"/g,
    /"ticker":"([A-Z0-9]+)"/g,
  ];

  for (const pat of patterns) {
    let m;
    while ((m = pat.exec(str)) !== null) {
      const sym = m[1];
      // Filter: reasonable stock/crypto symbol (2-8 chars, all caps)
      if (sym.length >= 2 && sym.length <= 8 && /^[A-Z0-9]+$/.test(sym)) {
        symbols.add(sym);
      }
    }
  }

  // Only return if looks like a watchlist (not hundreds of instruments)
  if (symbols.size > 0 && symbols.size <= 50) {
    return [...symbols];
  }
  return [];
}

syncWatchlist().catch(err => {
  console.error('Hata:', err.message);
  process.exit(1);
});
