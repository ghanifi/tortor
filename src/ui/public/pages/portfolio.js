// src/ui/public/pages/portfolio.js
window.PortfolioPage = {
  async render(container) {
    try {
      const data = await apiGet('/api/portfolio');
      if (!data) return;
      const { positions, cash } = data;

      container.innerHTML = `
        <div class="card" style="margin-bottom:16px">
          <div class="card-title">💼 Portfolio</div>
          <div style="color:var(--muted);font-size:12px;margin-bottom:12px">
            Cash: <strong style="color:var(--text)">${fmt$(cash)}</strong>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th class="right">Qty</th>
                  <th class="right">Invested ($)</th>
                  <th class="right">Current ($)</th>
                  <th class="right">P&amp;L ($)</th>
                  <th class="right">P&amp;L (%)</th>
                </tr>
              </thead>
              <tbody>
                ${positions.length === 0
                  ? '<tr><td colspan="6" style="color:var(--subtle);padding-top:12px">No open positions</td></tr>'
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
          <div class="card-title">Manual Trade</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="trade-symbol" class="input-field" placeholder="Symbol (e.g. TSLA)" style="width:120px">
            <input id="trade-amount" class="input-field" type="number" placeholder="Amount ($)" style="width:100px">
            <button class="btn-primary" onclick="PortfolioPage.executeTrade('buy')">Buy</button>
            <button class="btn-danger" onclick="PortfolioPage.executeTrade('sell')">Sell</button>
            <span id="trade-status" style="color:var(--muted);font-size:12px"></span>
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div style="color:var(--red)">Error: ${err.message}</div>`;
    }
  },

  async executeTrade(action) {
    const symbol = document.getElementById('trade-symbol').value.trim().toUpperCase();
    const amount = parseFloat(document.getElementById('trade-amount').value);
    const statusEl = document.getElementById('trade-status');

    if (!symbol) { statusEl.textContent = 'Enter a symbol'; return; }
    if (!amount || amount <= 0) { statusEl.textContent = 'Enter a valid amount'; return; }
    if (!confirm(`Confirm ${action === 'buy' ? 'BUY' : 'SELL'} ${symbol} (${fmt$(amount)})?`)) return;

    statusEl.textContent = 'Processing...';
    try {
      await apiPost('/api/trade', { symbol, action, amount });
      statusEl.style.color = 'var(--green)';
      statusEl.textContent = 'Order submitted';
      setTimeout(() => window.PortfolioPage.render(document.getElementById('content')), 1500);
    } catch (err) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'Error: ' + err.message;
    }
  }
};
