// src/ui/public/pages/portfolio.js
window.PortfolioPage = {
  async render(container) {
    try {
      const data = await apiGet('/api/portfolio');
      if (!data) return;
      const { positions, cash } = data;

      container.innerHTML = `
        <div class="card" style="margin-bottom:16px">
          <div class="card-title">💼 Portföy</div>
          <div style="color:var(--muted);font-size:12px;margin-bottom:12px">
            Nakit: <strong style="color:var(--text)">${fmt$(cash)}</strong>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sembol</th>
                  <th class="right">Adet</th>
                  <th class="right">Yatırım ($)</th>
                  <th class="right">Güncel ($)</th>
                  <th class="right">P&amp;L ($)</th>
                  <th class="right">P&amp;L (%)</th>
                </tr>
              </thead>
              <tbody>
                ${positions.length === 0
                  ? '<tr><td colspan="6" style="color:var(--subtle);padding-top:12px">Açık pozisyon yok</td></tr>'
                  : positions.map(p => `
                    <tr>
                      <td style="font-weight:600">${esc(p.symbol)}</td>
                      <td class="right">${p.quantity != null ? Number(p.quantity).toFixed(4) : '—'}</td>
                      <td class="right">${p.investedUsd != null ? fmt$(p.investedUsd) : '—'}</td>
                      <td class="right">${p.currentValueUsd != null ? fmt$(p.currentValueUsd) : '—'}</td>
                      <td class="right" style="color:${p.pnl == null ? 'inherit' : p.pnl >= 0 ? 'var(--green)' : 'var(--red)'}">${fmt$(p.pnl)}</td>
                      <td class="right" style="color:${p.pnlPct == null ? 'inherit' : p.pnlPct >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtPct(p.pnlPct)}</td>
                    </tr>
                  `).join('')
                }
              </tbody>
            </table>
          </div>
        </div>

        <!-- Manual trade -->
        <div class="card">
          <div class="card-title">Elle İşlem</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="trade-symbol" class="input-field" placeholder="Sembol (ör: TSLA)" style="width:120px">
            <input id="trade-amount" class="input-field" type="number" placeholder="Tutar ($)" style="width:100px">
            <button class="btn-primary" onclick="PortfolioPage.executeTrade('buy')">Alım</button>
            <button class="btn-danger" onclick="PortfolioPage.executeTrade('sell')">Satım</button>
            <span id="trade-status" style="color:var(--muted);font-size:12px"></span>
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div style="color:var(--red)">Hata: ${err.message}</div>`;
    }
  },

  async executeTrade(action) {
    const symbol = document.getElementById('trade-symbol').value.trim().toUpperCase();
    const amount = parseFloat(document.getElementById('trade-amount').value);
    const statusEl = document.getElementById('trade-status');

    if (!symbol) { statusEl.textContent = 'Sembol girin'; return; }
    if (!amount || amount <= 0) { statusEl.textContent = 'Geçerli tutar girin'; return; }
    if (!confirm(`${symbol} için ${action === 'buy' ? 'ALIM' : 'SATIM'} (${fmt$(amount)}) onaylıyor musunuz?`)) return;

    statusEl.textContent = 'İşleniyor...';
    try {
      await apiPost('/api/trade', { symbol, action, amount });
      statusEl.style.color = 'var(--green)';
      statusEl.textContent = 'İşlem gönderildi';
      setTimeout(() => window.PortfolioPage.render(document.getElementById('content')), 1500);
    } catch (err) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'Hata: ' + err.message;
    }
  }
};
