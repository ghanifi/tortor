// src/ui/public/pages/history.js
window.HistoryPage = {
  async render(container) {
    try {
      const trades = await apiGet('/api/history');
      if (!trades) return;

      // Summary
      const totalPnl = trades.filter(t => t.action === 'sell')
        .reduce((sum, t) => sum + (t.pnl || 0), 0);
      const buyCount = trades.filter(t => t.action === 'buy').length;
      const sellCount = trades.filter(t => t.action === 'sell').length;

      container.innerHTML = `
        <!-- Summary -->
        <div class="stats-grid" style="margin-bottom:16px">
          <div class="stat-card">
            <div class="stat-label">Toplam Alım</div>
            <div class="stat-value">${buyCount}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Toplam Satım</div>
            <div class="stat-value">${sellCount}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Gerçekleşmiş P&amp;L</div>
            <div class="stat-value ${totalPnl >= 0 ? 'green' : 'red'}">${fmt$(totalPnl)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Toplam İşlem</div>
            <div class="stat-value">${trades.length}</div>
          </div>
        </div>

        <!-- Table -->
        <div class="card">
          <div class="card-title">📋 İşlem Geçmişi</div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tarih</th>
                  <th>Sembol</th>
                  <th>Tip</th>
                  <th class="right">Tutar</th>
                  <th class="right">Fiyat</th>
                  <th class="right">P&amp;L</th>
                  <th>Neden</th>
                </tr>
              </thead>
              <tbody>
                ${trades.length === 0
                  ? '<tr><td colspan="7" style="color:var(--subtle);padding-top:12px">İşlem geçmişi yok</td></tr>'
                  : trades.map(t => `
                    <tr>
                      <td style="color:var(--muted)">${fmtTime(t.ts)}</td>
                      <td style="font-weight:600">${t.symbol}</td>
                      <td><span class="badge badge-${t.action}">${t.action === 'buy' ? 'ALIŞ' : 'SATIŞ'}</span></td>
                      <td class="right">${fmt$(t.amount)}</td>
                      <td class="right">${fmt$(t.price)}</td>
                      <td class="right" style="color:${t.pnl == null ? 'inherit' : t.pnl >= 0 ? 'var(--green)' : 'var(--red)'}">${t.pnl != null ? fmt$(t.pnl) : '—'}</td>
                      <td style="color:var(--muted);font-size:11px;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.reason || ''}</td>
                    </tr>
                  `).join('')
                }
              </tbody>
            </table>
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div style="color:var(--red)">Hata: ${err.message}</div>`;
    }
  }
};
