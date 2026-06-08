// src/ui/public/pages/log.js
window.LogPage = {
  render(container) {
    // Close any existing SSE connection before creating a new one
    if (window._activeSSE) {
      window._activeSSE.close();
      window._activeSSE = null;
    }

    container.innerHTML = `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div class="card-title" style="margin-bottom:0">📝 Bot Log</div>
          <div style="display:flex;gap:8px;align-items:center">
            <span id="log-status" style="color:var(--subtle);font-size:11px">Bağlanıyor...</span>
            <button class="btn-secondary" onclick="LogPage.clearDisplay()">Ekranı Temizle</button>
          </div>
        </div>
        <div id="log-panel" class="log-panel"></div>
      </div>
    `;

    const panel = document.getElementById('log-panel');
    const statusEl = document.getElementById('log-status');

    const es = new EventSource('/api/logs');
    window._activeSSE = es;

    es.onopen = () => {
      statusEl.textContent = '● Canlı';
      statusEl.style.color = 'var(--green)';
    };

    es.onmessage = (e) => {
      const line = JSON.parse(e.data);
      const div = document.createElement('div');
      const isError   = line.includes('[ERROR]') || line.toLowerCase().includes('error') || line.toLowerCase().includes('hata');
      const isTrade   = line.includes('[Trade]') || line.includes('ALIŞ') || line.includes('SATIM') || line.includes('BUY') || line.includes('SELL');
      const isCycle   = line.includes('Cycle start') || line.includes('[Bot] Starting');
      const isMarket  = line.includes('[MarketState]') || line.includes('RISK_');
      div.className = 'log-line' +
        (isError  ? ' error'  : '') +
        (isTrade  ? ' trade'  : '') +
        (isCycle  ? ' cycle'  : '') +
        (isMarket ? ' market' : '');
      div.textContent = line;
      panel.appendChild(div);
      while (panel.children.length > 500) panel.removeChild(panel.firstChild);
      panel.scrollTop = panel.scrollHeight;
    };

    es.onerror = () => {
      statusEl.textContent = '● Bağlantı kesildi';
      statusEl.style.color = 'var(--red)';
    };
  },

  clearDisplay() {
    const panel = document.getElementById('log-panel');
    if (panel) panel.innerHTML = '';
  }
};
