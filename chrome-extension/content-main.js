// content-main.js — MAIN world (page JS context'ine erişim var)
// fetch() ve XHR'ı intercept eder, ilginç API yanıtlarını ISOLATED world'e iletir.

(function () {
  'use strict';

  const WATCHED_PATTERNS = /watchlist|logindata|instruments\/private\/index/i;
  // Research page endpoints — analyst ratings, price targets, EPS estimates
  const RESEARCH_PATTERNS = /research|analyst|consensus|price.?target|eps|estimate|fundamental/i;
  // Log ALL API calls (for endpoint discovery when debugging)
  const LOG_ALL_APIS = true;

  // Filter out noise URLs (monitoring pings, analytics, Datadome, CDN assets)
  const NOISE_PATTERNS = /etorologsapi|dd-js|maintenance\.etoro|analytics|google|facebook|hotjar|cdn|\.css|\.js\b|\.png|\.svg|\.woff/i;
  function isInterestingUrl(url) {
    if (!url || !url.includes('etoro.com/')) return false;
    if (NOISE_PATTERNS.test(url)) return false;
    return true;
  }

  // --- XHR response body helper (instruments map için) ---
  function tryBuildInstrumentsMap(data) {
    try {
      const instruments = data?.PrivateInstruments || [];
      if (!instruments.length) return;
      const map = {};
      for (const inst of instruments) {
        const id = String(inst.InstrumentID || inst.InstrumentId || '');
        const sym = inst.SymbolFull || inst.Symbol || '';
        if (id && sym) map[id] = sym;
      }
      if (Object.keys(map).length > 0) {
        localStorage.setItem('__etoroBot_instrumentsMap', JSON.stringify(map));
        // Sadece map'i gönder, full data değil
        window.postMessage({ __etoroBot: true, type: 'API_RESPONSE', url: 'instruments-map://', data: { instrumentsMap: map } }, '*');
      }
    } catch (_) {}
  }

  // --- fetch intercept ---
  const _fetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await _fetch.call(this, input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';

    if (WATCHED_PATTERNS.test(url) || RESEARCH_PATTERNS.test(url)) {
      response.clone().json().then(data => {
        if (/instruments\/private\/index/i.test(url)) {
          tryBuildInstrumentsMap(data);
        } else if (RESEARCH_PATTERNS.test(url)) {
          window.postMessage({ __etoroBot: true, type: 'API_RESPONSE', url, data, _type: 'research' }, '*');
        } else {
          window.postMessage({ __etoroBot: true, type: 'API_RESPONSE', url, data }, '*');
        }
      }).catch(() => {});
    } else if (LOG_ALL_APIS && isInterestingUrl(url)) {
      window.postMessage({ __etoroBot: true, type: 'API_LOG', url }, '*');
    }
    return response;
  };

  // --- EXECUTE_TRADE: ISOLATED world'den gelen trade isteğini MAIN world'de execute et ---
  // MAIN world sayfanın orijinal fetch()'ini kullanır — tam session cookie, Datadome yok.
  window.addEventListener('message', async (event) => {
    if (!event.data || !event.data.__etoroBot || event.data.type !== 'EXECUTE_TRADE') return;
    const { trade, sessionHeaders } = event.data;
    const { id, symbol, action, amount, positionId: pid } = trade;

    const authHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'authorization': sessionHeaders?.authorization || '',
      'accounttype': 'Real',
      'applicationidentifier': 'ReToro',
      'applicationversion': 'v651.1282.0',
      'x-session-id': sessionHeaders?.sessionId || '',
      'x-sts-deviceid': sessionHeaders?.deviceId || '',
      'x-sts-autologin': 'true',
      'x-sts-clienttime': new Date().toISOString().substring(0, 19),
    };

    try {
      if (action === 'buy') {
        // instrumentId localStorage map'ten
        let instrumentId = null;
        try {
          const mapStr = localStorage.getItem('__etoroBot_instrumentsMap');
          if (mapStr) {
            const map = JSON.parse(mapStr);
            instrumentId = Object.entries(map).find(([, sym]) => sym === symbol)?.[0];
          }
        } catch (_) {}
        if (!instrumentId) {
          window.postMessage({ __etoroBot: true, type: 'TRADE_RESULT', result: { id, ok: false, symbol, action, amount, error: `Instrument ID bulunamadı: ${symbol}` } }, '*');
          return;
        }
        const res = await _fetch('https://www.etoro.com/api/trade-real/v3/positions', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ InstrumentID: parseInt(instrumentId), IsBuy: true, Leverage: 1, Amount: amount, TakeProfitRate: null, StopLossRate: null }),
        });
        const text = await res.text();
        const data = text.startsWith('<') ? { error: 'HTML yanıt (Datadome?)' } : JSON.parse(text);
        window.postMessage({ __etoroBot: true, type: 'TRADE_RESULT', result: {
          id, ok: data.IsSucceeded === true || data.PositionID != null,
          symbol, action, amount, positionId: data.PositionID, openRate: data.OpenRate,
          raw: { status: res.status, data }
        }}, '*');
      } else {
        // Satış
        if (!pid) {
          window.postMessage({ __etoroBot: true, type: 'TRADE_RESULT', result: { id, ok: false, symbol, action, amount, error: 'positionId gerekli' } }, '*');
          return;
        }
        const res = await _fetch(`https://www.etoro.com/api/trade-real/v3/positions/${pid}`, {
          method: 'DELETE',
          headers: authHeaders,
        });
        const text = await res.text();
        const data = text.startsWith('<') ? { error: 'HTML yanıt (Datadome?)' } : JSON.parse(text);
        window.postMessage({ __etoroBot: true, type: 'TRADE_RESULT', result: {
          id, ok: data.IsSucceeded === true,
          symbol, action, amount, positionId: pid,
          raw: { status: res.status, data }
        }}, '*');
      }
    } catch (err) {
      window.postMessage({ __etoroBot: true, type: 'TRADE_RESULT', result: { id, ok: false, symbol, action, amount, error: err.message } }, '*');
    }
  });

  // --- FORCE_SYNC: DOM'dan watchlist sembollerini çek ---
  window.addEventListener('message', (event) => {
    if (!event.data || !event.data.__etoroBot || event.data.type !== 'FORCE_SYNC') return;

    const symbols = new Set();

    // 1. En güvenilir: href="/markets/SYMBOL" → sembol URL'den
    document.querySelectorAll('a[href^="/markets/"]').forEach(a => {
      const sym = a.getAttribute('href').replace('/markets/', '').trim();
      if (sym && sym.length >= 1 && sym.length <= 12 && /^[A-Z0-9.]+$/.test(sym)) {
        symbols.add(sym);
      }
    });

    // 2. [automation-id="trade-item-name"] metin içeriği
    if (symbols.size === 0) {
      document.querySelectorAll('[automation-id="trade-item-name"]').forEach(el => {
        const text = el.textContent?.trim();
        if (text && text.length >= 1 && text.length <= 12 && /^[A-Z0-9.]+$/.test(text)) {
          symbols.add(text);
        }
      });
    }

    // 3. Watchlist satırlarındaki sembol elementleri
    if (symbols.size === 0) {
      document.querySelectorAll('[automation-id="watchlist-grid-instruments-list"] .symbol').forEach(el => {
        const text = el.textContent?.trim();
        if (text && /^[A-Z0-9.]+$/.test(text)) symbols.add(text);
      });
    }

    if (symbols.size > 0) {
      window.postMessage({
        __etoroBot: true,
        type: 'API_RESPONSE',
        url: 'force-sync://dom',
        data: { forceSyncSymbols: [...symbols] }
      }, '*');
    } else {
      console.warn('[eToro Bot] FORCE_SYNC: DOM\'da sembol bulunamadı. Watchlist sayfasında mısınız?');
    }
  });

  // --- XMLHttpRequest intercept ---
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._etoroUrl = url;
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const url = this._etoroUrl || '';
    if (WATCHED_PATTERNS.test(url) || RESEARCH_PATTERNS.test(url)) {
      this.addEventListener('load', () => {
        try {
          const data = JSON.parse(this.responseText);
          if (/instruments\/private\/index/i.test(url)) {
            tryBuildInstrumentsMap(data);
          } else if (RESEARCH_PATTERNS.test(url)) {
            window.postMessage({ __etoroBot: true, type: 'API_RESPONSE', url, data, _type: 'research' }, '*');
          } else {
            window.postMessage({ __etoroBot: true, type: 'API_RESPONSE', url, data }, '*');
          }
        } catch (_) {}
      });
    } else if (LOG_ALL_APIS && isInterestingUrl(url)) {
      this.addEventListener('load', () => {
        window.postMessage({ __etoroBot: true, type: 'API_LOG', url }, '*');
      });
    }
    return _send.apply(this, arguments);
  };
})();
