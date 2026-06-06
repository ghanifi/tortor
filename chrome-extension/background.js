// background.js — Service Worker
// 1. webRequest ile auth header'larını yakalar → localhost:3737/session
// 2. Periyodik alarm ile eToro sekmesini otomatik yeniler (auth + watchlist sync)
// 3. Her 30 dakikada bir watchlist sembollerinin research sayfalarını tarar

'use strict';

const SERVER = 'http://localhost:3737';
const LOGINDATA_URL = '*://*.etoro.com/api/logindata/v2/*';
const REFRESH_ALARM = 'etoro-refresh';
const RESEARCH_ALARM = 'etoro-research-sync';
const REFRESH_INTERVAL_MIN = 30;
const RESEARCH_INTERVAL_MIN = 30;
const RESEARCH_TAB_WAIT_MS = 10000; // research sayfasının API çağrılarını tamamlaması için bekleme süresi

// ── Alarmları Kur ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  setupAlarms();
});

chrome.alarms.get(REFRESH_ALARM, (alarm) => {
  if (!alarm) setupAlarms();
});

function setupAlarms() {
  chrome.alarms.create(REFRESH_ALARM, {
    delayInMinutes: REFRESH_INTERVAL_MIN,
    periodInMinutes: REFRESH_INTERVAL_MIN,
  });
  // Research sync ilk çalışmayı 2 dakika sonra başlat (sayfa yüklenmesini bekle)
  chrome.alarms.create(RESEARCH_ALARM, {
    delayInMinutes: 2,
    periodInMinutes: RESEARCH_INTERVAL_MIN,
  });
  console.log('[eToro Bot] Alarmlar kuruldu: refresh=' + REFRESH_INTERVAL_MIN + 'dk, research=' + RESEARCH_INTERVAL_MIN + 'dk');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) refreshEToroTab('alarm');
  if (alarm.name === RESEARCH_ALARM) syncResearchData();
});

// ── Research Sync ─────────────────────────────────────────────────────────────
// Her sembolün research sayfasını arka plan sekmesinde açar, content script API
// çağrılarını yakalar ve sunucuya iletir. Sekme veri alındıktan sonra kapanır.

async function getWatchlistFromServer() {
  try {
    const res = await fetch(`${SERVER}/`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json();
    return data.watchlist || [];
  } catch (_) {
    return [];
  }
}

async function syncResearchData() {
  const watchlist = await getWatchlistFromServer();
  if (!watchlist.length) {
    console.log('[Research] Watchlist boş, atlanıyor');
    return;
  }

  console.log(`[Research] ${watchlist.length} sembol için research sync başladı: ${watchlist.join(', ')}`);

  for (const symbol of watchlist) {
    let tab = null;
    try {
      const url = `https://www.etoro.com/markets/${symbol.toLowerCase()}/research`;
      tab = await chrome.tabs.create({ url, active: false });
      // Sayfanın yüklenmesini ve API çağrılarını tamamlamasını bekle
      await sleep(RESEARCH_TAB_WAIT_MS);
    } catch (err) {
      console.warn(`[Research] ${symbol} sekmesi açılamadı:`, err.message);
    } finally {
      if (tab?.id) {
        try { await chrome.tabs.remove(tab.id); } catch (_) {}
      }
    }
    // Semboller arası kısa bekleme (rate limiting)
    await sleep(2000);
  }

  const now = new Date().toISOString();
  chrome.storage.local.get('status', ({ status }) => {
    chrome.storage.local.set({ status: { ...(status || {}), lastResearchSync: now } });
  });
  console.log('[Research] Sync tamamlandı:', now);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Sunucu /refresh endpoint'inden tetikleme — bot seans sona ermeden önce yenileyebilir
async function checkServerRefreshRequest() {
  try {
    const res = await fetch(`${SERVER}/should-refresh`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    const data = await res.json();
    if (data.refresh) {
      console.log('[eToro Bot] Sunucu refresh isteği aldı');
      refreshEToroTab('server-request');
    }
  } catch (_) {}
}

// eToro sekmesini bul ve yenile
async function refreshEToroTab(reason) {
  const tabs = await chrome.tabs.query({ url: '*://*.etoro.com/*' });
  if (tabs.length === 0) {
    console.log('[eToro Bot] Refresh: eToro sekmesi bulunamadı');
    return;
  }

  // Watchlist sayfasını veya ilk eToro sekmesini yenile
  const watchlistTab = tabs.find(t => t.url?.includes('/watchlists'));
  const target = watchlistTab || tabs[0];

  chrome.tabs.reload(target.id, { bypassCache: false });
  console.log(`[eToro Bot] Sekme yenilendi (${reason}): ${target.url?.split('?')[0]}`);

  // Storage'a kaydet
  chrome.storage.local.get('status', ({ status }) => {
    chrome.storage.local.set({
      status: {
        ...(status || {}),
        lastRefresh: new Date().toISOString(),
        lastRefreshReason: reason,
        updatedAt: new Date().toISOString(),
      }
    });
  });
}

// Sunucu kontrol döngüsü: her 5 dakikada bir /should-refresh ve /should-research-sync sorgula
setInterval(checkServerRequests, 5 * 60 * 1000);

async function checkServerRequests() {
  await checkServerRefreshRequest();
  await checkServerResearchRequest();
}

async function checkServerResearchRequest() {
  try {
    const res = await fetch(`${SERVER}/should-research-sync`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    const data = await res.json();
    if (data.sync) {
      console.log('[eToro Bot] Sunucu research sync isteği aldı');
      syncResearchData();
    }
  } catch (_) {}
}

// ── Auth Header Yakalama ──────────────────────────────────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = {};
    for (const h of (details.requestHeaders || [])) {
      headers[h.name.toLowerCase()] = h.value;
    }

    const authorization = headers['authorization'] || '';
    if (!authorization) return;

    const session = {
      capturedAt: new Date().toISOString(),
      authorization,
      cookieString: headers['cookie'] || '',
      sessionId: headers['x-session-id'] || '',
      deviceId: headers['x-sts-deviceid'] || '',
    };

    fetch(`${SERVER}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session),
    })
      .then(() => {
        console.log('[eToro Bot] Auth session senkronize edildi:', session.capturedAt);
        chrome.storage.local.get('status', ({ status }) => {
          chrome.storage.local.set({
            status: { ...(status || {}), lastAuthSync: session.capturedAt, authOk: true, updatedAt: session.capturedAt }
          });
        });
      })
      .catch(err => {
        console.warn('[eToro Bot] Auth sync başarısız:', err.message);
        chrome.storage.local.get('status', ({ status }) => {
          chrome.storage.local.set({ status: { ...(status || {}), authOk: false } });
        });
      });
  },
  { urls: [LOGINDATA_URL] },
  ['requestHeaders']
);

// ── Popup'tan gelen status isteği ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'GET_STATUS') return false;
  chrome.storage.local.get('status', ({ status }) => {
    sendResponse(status || {});
  });
  return true;
});
