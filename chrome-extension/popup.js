// popup.js

const SERVER = 'http://localhost:3737';

function relativeTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s önce`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}dk önce`;
  const hr = Math.floor(min / 60);
  return `${hr}sa önce`;
}

async function checkServer() {
  try {
    const res = await fetch(`${SERVER}/`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

async function refresh() {
  // Sunucu durumu
  const online = await checkServer();
  const dot = document.getElementById('serverDot');
  const text = document.getElementById('serverText');
  dot.className = `dot ${online ? 'dot-green' : 'dot-red'}`;
  text.textContent = online ? 'Çalışıyor' : 'Kapalı';

  // Extension storage'dan son sync zamanları
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
    if (!status) return;
    document.getElementById('lastAuth').textContent = relativeTime(status.lastAuthSync);
    document.getElementById('lastWatchlist').textContent = relativeTime(status.lastWatchlistSync);
    document.getElementById('lastRefresh').textContent = status.lastRefresh
      ? `${relativeTime(status.lastRefresh)} (${status.lastRefreshReason || ''})`
      : '—';
    document.getElementById('lastResearch').textContent = relativeTime(status.lastResearchSync);

    const container = document.getElementById('watchlistTags');
    if (status.watchlist && status.watchlist.length > 0) {
      container.innerHTML = status.watchlist
        .map(s => `<span class="tag">${s}</span>`)
        .join('');
    }
  });
}

// "Watchlist Senkronize Et" butonu
document.getElementById('forceSync').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: '*://*.etoro.com/*' });
  if (!tabs.length) {
    alert('eToro.com sekmesi açık değil');
    return;
  }

  // Önce aktif sekmeyi dene, yoksa ilk eToro sekmesini kullan
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = (activeTab?.url?.includes('etoro.com')) ? activeTab : tabs[0];

  chrome.tabs.sendMessage(tab.id, { type: 'FORCE_SYNC' }, (resp) => {
    if (chrome.runtime.lastError) {
      // Content script yüklü değil — sayfayı yenile, otomatik sync olacak
      chrome.tabs.reload(tab.id);
      document.getElementById('lastWatchlist').textContent = 'Sayfa yenileniyor...';
      return;
    }
    setTimeout(refresh, 1500);
  });
});

// "Research Şimdi Tara" butonu — doğrudan sunucuya POST eder (service worker'a bağımlı değil)
document.getElementById('forceResearch').addEventListener('click', async () => {
  try {
    const res = await fetch(`${SERVER}/research-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      document.getElementById('lastResearch').textContent = 'Sync kuyruğa alındı...';
    } else {
      alert('Sunucu hatası: ' + res.status);
    }
  } catch (_) {
    alert('Sunucu bağlantısı kurulamadı. node scripts/watchlist-server.js çalışıyor mu?');
  }
});

// İlk yükleme + 5 saniyede bir otomatik yenile
refresh();
setInterval(refresh, 5000);
