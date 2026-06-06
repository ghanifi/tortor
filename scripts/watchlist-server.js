// scripts/watchlist-server.js
// Chrome extension ve console snippet'lerinden veri alan yerel HTTP sunucusu.
// Endpoints:
//   POST /session   → logs/auth_session.json güncelle (JWT + cookie otomatik yenileme)
//   POST /watchlist → config.json watchlist güncelle
//   POST /portfolio → (opsiyonel) ham portfolio verisi logla
//   GET  /          → sağlık kontrolü
//
// Çalıştır: node scripts/watchlist-server.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3737;
const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const AUTH_SESSION_PATH = path.join(process.cwd(), 'logs', 'auth_session.json');

// Extension'a refresh sinyali göndermek için flag
let refreshFlag = false;
let researchSyncFlag = false;

// Trade queue
const tradeQueue = [];  // pending trades waiting for extension
const tradeResults = {}; // id → result

// logs/ klasörü yoksa oluştur
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const server = http.createServer((req, res) => {
  // Chrome Private Network Access preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    res.writeHead(405, corsHeaders());
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  // ── GET /pending-trades: Extension kuyruktaki işlemleri çeker ──────────────
  if (req.method === 'GET' && req.url === '/pending-trades') {
    const trades = [...tradeQueue];
    tradeQueue.length = 0; // clear after sending
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ trades }));
    return;
  }

  // ── GET /trade-result/:id: Bot sonucu bekler ─────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/trade-result/')) {
    const id = req.url.replace('/trade-result/', '');
    const result = tradeResults[id] || null;
    if (result) delete tradeResults[id]; // consume once
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ result }));
    return;
  }

  // ── GET /research-cache: Bot için tüm research verilerini döndür ────────────
  if (req.method === 'GET' && req.url === '/research-cache') {
    const cache = {};
    try {
      const files = fs.readdirSync(logsDir).filter(f => f.startsWith('research_') && f.endsWith('.json'));
      for (const file of files) {
        try {
          const entry = JSON.parse(fs.readFileSync(path.join(logsDir, file), 'utf8'));
          const key = entry.apiUrl || file;
          cache[key] = entry;
        } catch (_) {}
      }
    } catch (_) {}
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true, count: Object.keys(cache).length, cache }));
    return;
  }

  // ── GET /should-refresh: Extension'ın refresh yapması gerekiyor mu? ────────
  if (req.method === 'GET' && req.url === '/should-refresh') {
    const flag = refreshFlag;
    if (flag) {
      refreshFlag = false;
      console.log('   ↺ Extension\'a refresh sinyali gönderildi');
    }
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ refresh: flag }));
    return;
  }

  // ── GET /should-research-sync: Extension research sync yapması gerekiyor mu? ─
  if (req.method === 'GET' && req.url === '/should-research-sync') {
    const flag = researchSyncFlag;
    if (flag) {
      researchSyncFlag = false;
      console.log('   🔬 Extension\'a research sync sinyali gönderildi');
    }
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ sync: flag }));
    return;
  }

  // ── GET /session-headers: Extension için mevcut auth bilgilerini döndür ────
  if (req.method === 'GET' && req.url === '/session-headers') {
    const session = safeReadJson(AUTH_SESSION_PATH) || {};
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({
      authorization: session.authorization || '',
      sessionId: session.sessionId || '',
      deviceId: session.deviceId || '',
    }));
    return;
  }

  // Sağlık kontrolü
  if (req.method === 'GET' && req.url === '/') {
    const config = safeReadJson(CONFIG_PATH);
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({
      status: 'ok',
      port: PORT,
      watchlist: config?.watchlist || [],
      time: new Date().toISOString()
    }));
    return;
  }

  // POST endpoint'leri — body oku
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);
      handlePost(req.url, payload, res);
    } catch (err) {
      res.writeHead(400, corsHeaders());
      res.end(JSON.stringify({ error: 'invalid JSON: ' + err.message }));
    }
  });
});

function handlePost(url, payload, res) {
  // ── /pending-trades: Bot trade kuyruğa ekler ────────────────────────────
  if (url === '/pending-trades') {
    const trade = { id: `t_${Date.now()}`, ...payload, queuedAt: new Date().toISOString() };
    tradeQueue.push(trade);
    console.log(`\n🔄 Trade kuyruğa eklendi: ${trade.action?.toUpperCase()} ${trade.symbol} $${trade.amount} (dry:${trade.dryRun})`);
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true, id: trade.id }));
    return;
  }

  // ── /trade-result: Extension işlem sonucunu bildirir ────────────────────
  if (url === '/trade-result') {
    const { id } = payload;
    if (!id) { res.writeHead(400, corsHeaders()); res.end(JSON.stringify({ error: 'id required' })); return; }
    tradeResults[id] = { ...payload, receivedAt: new Date().toISOString() };
    const ok = payload.ok ? '✅' : '❌';
    const sim = payload.simulated ? ' [SİMÜLE]' : '';
    console.log(`\n${ok} Trade sonucu${sim}: ${payload.action?.toUpperCase()} ${payload.symbol} $${payload.amount}`);
    if (payload.error) console.log(`   Hata: ${payload.error}`);
    if (payload.positionId) console.log(`   Position ID: ${payload.positionId}`);
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── /session: Auth session yenile ─────────────────────────────────────────
  if (url === '/session') {
    const { authorization, cookieString, sessionId, deviceId, capturedAt } = payload;
    if (!authorization) {
      res.writeHead(400, corsHeaders());
      res.end(JSON.stringify({ error: 'authorization field required' }));
      return;
    }

    const existing = safeReadJson(AUTH_SESSION_PATH) || {};
    const session = {
      ...existing,
      capturedAt: capturedAt || new Date().toISOString(),
      authorization,
      cookieString: cookieString || existing.cookieString || '',
      sessionId: sessionId || existing.sessionId || '',
      deviceId: deviceId || existing.deviceId || '',
    };

    fs.writeFileSync(AUTH_SESSION_PATH, JSON.stringify(session, null, 2));
    console.log(`\n🔑 Auth session güncellendi: ${session.capturedAt}`);

    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true, capturedAt: session.capturedAt }));
    return;
  }

  // ── /watchlist: Watchlist güncelle ───────────────────────────────────────
  if (url === '/watchlist') {
    const { symbols, source } = payload;
    if (!Array.isArray(symbols) || symbols.length === 0) {
      res.writeHead(400, corsHeaders());
      res.end(JSON.stringify({ error: 'symbols must be a non-empty array' }));
      return;
    }

    const config = safeReadJson(CONFIG_PATH);
    if (!config) {
      res.writeHead(500, corsHeaders());
      res.end(JSON.stringify({ error: 'config.json okunamadı' }));
      return;
    }

    const old = config.watchlist || [];
    const changed = JSON.stringify(old.sort()) !== JSON.stringify([...symbols].sort());

    config.watchlist = symbols;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

    if (changed) {
      console.log(`\n📋 Watchlist güncellendi${source ? ` (kaynak: ${source.split('?')[0]})` : ''}:`);
      console.log(`   Önceki : ${JSON.stringify(old)}`);
      console.log(`   Yeni   : ${JSON.stringify(symbols)}`);
    } else {
      console.log(`\n📋 Watchlist değişmedi: ${JSON.stringify(symbols)}`);
    }

    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true, watchlist: symbols, changed }));
    return;
  }

  // ── POST /refresh: eToro sekmesini yenile (bot veya dış araçtan) ──────────
  if (url === '/refresh') {
    refreshFlag = true;
    console.log('\n   ↺ Refresh isteği alındı — extension\'a bildirilecek');
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true, queued: true }));
    return;
  }

  // ── POST /research-sync: Research sync tetikle (popup butonundan) ──────────
  if (url === '/research-sync') {
    researchSyncFlag = true;
    console.log('\n   🔬 Research sync isteği alındı — extension\'a bildirilecek');
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true, queued: true }));
    return;
  }

  // ── /log: Debug — hangi API URL'leri yakalanıyor ─────────────────────────
  if (url === '/log') {
    const u = (payload.url || '').replace('https://www.etoro.com','');
    const keys = (payload.keys || []).join(', ');
    if (u) console.log(`   📡  ${u}   [${keys}]`);
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── /instruments-map: InstrumentID → SymbolFull haritasını kaydet ────────
  if (url === '/instruments-map') {
    const mapPath = path.join(logsDir, 'instruments_map.json');
    const count = Object.keys(payload.map || {}).length;
    fs.writeFileSync(mapPath, JSON.stringify(payload.map, null, 2));
    console.log(`\n🗺️  Instruments map kaydedildi: ${count} enstrüman`);
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true, count }));
    return;
  }

  // ── /watchlist-raw: Ham watchlist (ID'ler) → sembol dönüşümü ─────────────
  if (url === '/watchlist-raw') {
    fs.writeFileSync(path.join(logsDir, 'watchlist_raw.json'), JSON.stringify(payload.data, null, 2));

    const rawWatchlists = payload.data?.Watchlists || [];
    const symbols = [];

    for (const wl of rawWatchlists) {
      // "Recently Invested" gibi sistem listelerini atla, sadece kullanıcı listelerini al
      const isUserList = wl.WatchlistType === 'Default' || wl.WatchlistType === 'Custom' || wl.WatchlistType === 'UserDefined';
      if (!isUserList) continue;

      for (const item of (wl.Items || [])) {
        // Sadece Instrument tipindeki item'ları al (CopyTrader/SmartPortfolio değil)
        if (item.ItemType && item.ItemType !== 'Instrument') continue;
        const sym = item.Market?.SymbolName || item.Market?.Symbol || item.SymbolName;
        if (sym && sym.length >= 2 && sym.length <= 12) symbols.push(sym);
      }
    }

    if (symbols.length > 0) {
      const config = safeReadJson(CONFIG_PATH);
      const old = config.watchlist || [];
      const changed = JSON.stringify(old.sort()) !== JSON.stringify([...symbols].sort());
      config.watchlist = symbols;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      if (changed) {
        console.log(`\n📋 Watchlist güncellendi:`);
        console.log(`   Önceki : ${JSON.stringify(old)}`);
        console.log(`   Yeni   : ${JSON.stringify(symbols)}`);
      }
    } else {
      console.log(`\n⚠️  Watchlist'ten sembol çıkarılamadı. Watchlist tipleri: ${rawWatchlists.map(w=>w.WatchlistType).join(', ')}`);
    }

    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true, symbols }));
    return;
  }

  // ── /portfolio: Portfolio verisi (opsiyonel loglama) ─────────────────────
  if (url === '/portfolio') {
    const portfolioLogPath = path.join(logsDir, 'portfolio_snapshot.json');
    fs.writeFileSync(portfolioLogPath, JSON.stringify({ ...payload, savedAt: new Date().toISOString() }, null, 2));
    console.log(`\n📊 Portfolio snapshot kaydedildi`);
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── /research-data: Analyst ratings / price targets from eToro research page ──
  if (url === '/research-data') {
    const { url: apiUrl, data } = payload;
    // Save raw data keyed by URL path so we can explore what's available
    const safeKey = (apiUrl || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const researchPath = path.join(logsDir, `research_${safeKey}.json`);
    fs.writeFileSync(researchPath, JSON.stringify({ apiUrl, data, savedAt: new Date().toISOString() }, null, 2));
    console.log(`\n🔬 Research data kaydedildi: ${apiUrl}`);
    res.writeHead(200, corsHeaders());
    res.end(JSON.stringify({ ok: true, apiUrl }));
    return;
  }

  res.writeHead(404, corsHeaders());
  res.end(JSON.stringify({ error: 'not found' }));
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
  };
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 eToro Bot Bridge sunucusu başladı`);
  console.log(`   Port    : ${PORT}`);
  console.log(`   Adres   : http://localhost:${PORT}/`);
  console.log('\n📌 Chrome extension kurulumu için:');
  console.log('   1. chrome://extensions/ aç');
  console.log('   2. "Geliştirici modu" aç (sağ üst)');
  console.log('   3. "Paketlenmemiş öğe yükle" → chrome-extension/ klasörünü seç');
  console.log('\n   Extension kurulduktan sonra eToro\'yu aç — her şey otomatik!');
  console.log('\n   Çıkmak için Ctrl+C\n');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} zaten kullanımda.`);
    process.exit(1);
  } else {
    console.error('Server hatası:', err);
  }
});
