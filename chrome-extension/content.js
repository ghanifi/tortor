// content.js — ISOLATED world
// MAIN world'den gelen mesajları alır, doğrudan localhost:3737'ye gönderir.
// Service worker'a bağımlı değil — her zaman çalışır.

const SERVER = 'http://localhost:3737';

function postToServer(path, body) {
  return fetch(`${SERVER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {
    // Sunucu kapalıysa sessizce geç
  });
}

window.addEventListener('message', (event) => {
  if (!event.data || !event.data.__etoroBot) return;
  if (event.source !== window) return;

  const msg = event.data;

  // API endpoint discovery log
  if (msg.type === 'API_LOG') {
    postToServer('/log', { url: msg.url });
    return;
  }

  if (msg.type === 'API_RESPONSE') {
    const { url, data } = msg;
    const shortUrl = url.replace('https://www.etoro.com', '').split('?')[0];

    // 0. Force sync (DOM'dan)
    if (url === 'force-sync://dom') {
      const symbols = data?.forceSyncSymbols || [];
      if (symbols.length > 0) {
        postToServer('/watchlist', { symbols, source: 'force-sync-dom' });
      }
      return;
    }

    // 0.5 Research/analyst data (price targets, consensus, EPS)
    if (msg._type === 'research') {
      const shortUrl = url.replace('https://www.etoro.com', '').split('?')[0];
      postToServer('/research-data', { url: shortUrl, data });
      return;
    }

    // 1. /api/watchlist/v1/watchlists — birincil kaynak (sayfalama: sadece ilk sayfa gelir)
    if (/watchlist\/v1\/watchlists/i.test(url)) {
      const symbols = extractFromWatchlistApi(data);
      if (symbols.length > 0) {
        postToServer('/watchlist', { symbols, source: 'watchlist-api' });
        return;
      }
      postToServer('/watchlist-raw', { data });
      return;
    }

    // 2. instruments map (MAIN world'den geldi — zaten localStorage'a kaydedildi)
    if (url === 'instruments-map://') {
      const map = data?.instrumentsMap || {};
      if (Object.keys(map).length > 0) {
        postToServer('/instruments-map', { map });
      }
      return;
    }

    // 3. logindata — portfolio snapshot
    if (/logindata/i.test(url)) {
      const portfolio = extractPortfolio(data);
      if (portfolio) postToServer('/portfolio', portfolio);
    }
  }
});

// Popup'tan gelen FORCE_SYNC: MAIN world'deki script'e tetik gönder
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'FORCE_SYNC') {
    sendResponse({ ok: false });
    return;
  }
  window.postMessage({ __etoroBot: true, type: 'FORCE_SYNC' }, '*');
  sendResponse({ ok: true });
  return true;
});

// /api/watchlist/v1/watchlists yanıtından sembol çıkar
// Yapı: { Watchlists: [{ WatchlistType, Items: [{ ItemType, Market: { SymbolName } }] }] }
function extractFromWatchlistApi(data) {
  const symbols = [];
  const watchlists = data?.Watchlists || [];

  for (const wl of watchlists) {
    const isUserList = wl.WatchlistType === 'Default' || wl.WatchlistType === 'Custom' || wl.WatchlistType === 'UserDefined';
    if (!isUserList) continue;

    for (const item of (wl.Items || [])) {
      if (item.ItemType && item.ItemType !== 'Instrument') continue;
      const sym = item.Market?.SymbolName || item.Market?.Symbol || item.SymbolName;
      if (sym && sym.length >= 2 && sym.length <= 12) symbols.push(sym);
    }
  }

  return symbols;
}

// /sapi/trade-real/v2/instruments/private/index → { id: SymbolFull } haritası
function buildInstrumentMap(data) {
  const map = {};
  const instruments = data?.PrivateInstruments || [];
  for (const inst of instruments) {
    const id = String(inst.InstrumentID || inst.InstrumentId || '');
    const sym = inst.SymbolFull || inst.Symbol || '';
    if (id && sym) map[id] = sym;
  }
  // localStorage'a kaydet — watchlist parse'ında kullanılacak
  if (Object.keys(map).length > 0) {
    try { localStorage.setItem('__etoroBot_instrumentsMap', JSON.stringify(map)); } catch (_) {}
  }
  return map;
}

// ── Trade Execution Bridge ────────────────────────────────────────────────────
// Bot'tan gelen trade komutlarını eToro API'si aracılığıyla çalıştırır.
// Extension tarayıcıdan çağırdığı için Datadome yok — tam kimlik doğrulama.

const POLL_INTERVAL = 10000; // 10 saniye

async function pollAndExecuteTrades() {
  try {
    const res = await fetch(`${SERVER}/pending-trades`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const { trades } = await res.json();
    for (const trade of trades) {
      await executeTrade(trade);
    }
  } catch (_) {
    // Sunucu kapalıysa sessizce geç
  }
}

async function executeTrade(trade) {
  const { id, symbol, action, amount, dryRun } = trade;

  // Dry run: sunucuya simüle sonuç gönder
  if (dryRun) {
    await postToServer('/trade-result', {
      id, symbol, action, amount,
      ok: true, simulated: true,
      note: 'dry_run=true — gerçek işlem yapılmadı'
    });
    return;
  }

  // Session headers'ı sunucudan çek (authorization JWT + sessionId + deviceId)
  let sessionHeaders = {};
  try {
    const sRes = await fetch(`${SERVER}/session-headers`, { signal: AbortSignal.timeout(3000) });
    if (sRes.ok) sessionHeaders = await sRes.json();
  } catch (_) {}

  if (!sessionHeaders.authorization) {
    await postToServer('/trade-result', { id, symbol, action, amount, ok: false, error: 'Auth session bulunamadı — sayfa yenilensin' });
    return;
  }

  // Gerçek trade: MAIN world'e devret (sayfanın orijinal fetch'ini kullanır — tam session, Datadome yok)
  return new Promise((resolve) => {
    const onResult = (event) => {
      if (!event.data?.__etoroBot || event.data.type !== 'TRADE_RESULT') return;
      if (event.data.result?.id !== id) return;
      window.removeEventListener('message', onResult);
      const result = event.data.result;
      postToServer('/trade-result', result).then(resolve).catch(resolve);
    };
    window.addEventListener('message', onResult);
    // 30 saniye timeout
    setTimeout(() => {
      window.removeEventListener('message', onResult);
      postToServer('/trade-result', { id, symbol, action, amount, ok: false, error: 'MAIN world timeout (30s)' }).then(resolve).catch(resolve);
    }, 30000);
    // MAIN world'e trade + session headers'ı gönder
    window.postMessage({ __etoroBot: true, type: 'EXECUTE_TRADE', trade, sessionHeaders }, '*');
  });
}

// Polling başlat
setInterval(pollAndExecuteTrades, POLL_INTERVAL);
// İlk kontrolü hemen yap
setTimeout(pollAndExecuteTrades, 2000);

function extractPortfolio(obj) {
  try {
    const api = obj?.AggregatedResult?.ApiResponses;
    if (!api) return null;
    const portfolio = api?.PrivatePortfolio?.Content?.ClientPortfolio;
    if (!portfolio) return null;
    return {
      positions: portfolio.Positions || [],
      credit: portfolio.Credit || 0,
      capturedAt: new Date().toISOString(),
    };
  } catch (_) {
    return null;
  }
}
