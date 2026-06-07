// src/ui/public/pages/dashboard.js
window.DashboardPage = {
  async render(container) {
    try {
      const [state, config] = await Promise.all([
        apiGet('/api/state'),
        apiGet('/api/config'),
      ]);
      if (!state) return;

      // Calculate portfolio value from positions
      const openPositions = Object.entries(state.positions || {})
        .filter(([, p]) => p.quantity > 0);
      const portfolioVal = openPositions.reduce((sum, [sym, p]) => {
        return sum + (p.quantity || 0) * (state.prices?.[sym] || p.avg_cost || 0);
      }, 0);
      const cash = state.cash || 0;
      const totalVal = portfolioVal + cash;

      // P&L
      const totalCost = openPositions.reduce((sum, [, p]) => {
        return sum + (p.quantity || 0) * (p.avg_cost || 0);
      }, 0);
      const totalPnl = portfolioVal - totalCost;
      const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

      const dryRun = config?.safety?.dry_run ?? true;
      const risk = state.risk || {};
      const peakVal = risk.portfolio_peak_value || 0;
      const drawdownPct = peakVal > 0 ? ((peakVal - totalVal) / peakVal) * 100 : 0;

      // Build recent decisions from positions (last_trade_at)
      const decisions = Object.entries(state.positions || {})
        .filter(([, p]) => p.last_trade_at)
        .sort((a, b) => new Date(b[1].last_trade_at) - new Date(a[1].last_trade_at))
        .slice(0, 10);

      container.innerHTML = `
        <!-- Stats row -->
        <div class="stats-grid" style="margin-bottom:16px">
          <div class="stat-card">
            <div class="stat-label">Nakit</div>
            <div class="stat-value">${fmt$(cash)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Portföy</div>
            <div class="stat-value">${fmt$(portfolioVal)}</div>
            <div class="stat-sub">${openPositions.length} pozisyon</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Toplam P&amp;L</div>
            <div class="stat-value ${totalPnl >= 0 ? 'green' : 'red'}">${fmt$(totalPnl)}</div>
            <div class="stat-sub" style="color:${totalPnl >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtPct(totalPnlPct)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Regime</div>
            <div class="stat-value" style="font-size:13px;margin-top:6px">${state.regime?.macro_equity || '—'} / ${state.regime?.macro_crypto || '—'}</div>
            <div class="stat-sub">equity / crypto</div>
          </div>
        </div>

        <!-- Controls row -->
        <div class="grid-2" style="margin-bottom:16px">
          <div class="toggle-row">
            <div>
              <div class="toggle-label">Dry Run Modu</div>
              <div class="toggle-sub">Gerçek işlem yapılmaz</div>
            </div>
            <button id="dry-run-toggle" class="toggle ${dryRun ? 'on' : ''}" onclick="DashboardPage.toggleDryRun()">
              <span class="toggle-thumb"></span>
            </button>
          </div>
          <div class="toggle-row">
            <div>
              <div class="toggle-label">Drawdown Stop</div>
              <div class="toggle-sub" style="color:${risk.trades_paused ? 'var(--red)' : 'var(--green)'}">
                ${risk.trades_paused ? '⚠️ Aktif — alımlar durduruldu' : `Normal — peak ${fmt$(peakVal)}`}
              </div>
              <div class="toggle-sub">Drawdown: ${fmtPct(drawdownPct)}</div>
            </div>
            <button class="btn-secondary" onclick="DashboardPage.resetDrawdown()">Reset</button>
          </div>
        </div>

        <!-- Recent decisions -->
        <div class="card">
          <div class="card-title">Son Kararlar</div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sembol</th>
                  <th class="right">Avg Maliyet</th>
                  <th class="right">Güncel Fiyat</th>
                  <th class="right">Değişim</th>
                  <th class="right">Son İşlem</th>
                </tr>
              </thead>
              <tbody>
                ${decisions.length === 0 ? '<tr><td colspan="5" style="color:var(--subtle);padding-top:12px">Henüz işlem yok</td></tr>' :
                  decisions.map(([sym, p]) => {
                    const price = state.prices?.[sym] || null;
                    const chgPct = (price && p.avg_cost) ? ((price - p.avg_cost) / p.avg_cost) * 100 : null;
                    return `<tr>
                      <td style="font-weight:600">${sym}</td>
                      <td class="right">${fmt$(p.avg_cost)}</td>
                      <td class="right">${fmt$(price)}</td>
                      <td class="right" style="color:${chgPct == null ? 'inherit' : chgPct >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtPct(chgPct)}</td>
                      <td class="right" style="color:var(--muted)">${fmtTime(p.last_trade_at)}</td>
                    </tr>`;
                  }).join('')
                }
              </tbody>
            </table>
          </div>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div style="color:var(--red)">Hata: ${err.message}</div>`;
    }
  },

  async toggleDryRun() {
    try {
      const result = await apiPost('/api/bot/dry-run');
      if (!result) return;
      const btn = document.getElementById('dry-run-toggle');
      if (btn) btn.classList.toggle('on', result.dry_run);
    } catch (err) {
      alert('Hata: ' + err.message);
    }
  },

  async resetDrawdown() {
    try {
      await apiPost('/api/risk/reset');
      window.DashboardPage.render(document.getElementById('content'));
    } catch (err) {
      alert('Hata: ' + err.message);
    }
  }
};
