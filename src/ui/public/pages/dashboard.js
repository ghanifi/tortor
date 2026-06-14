// src/ui/public/pages/dashboard.js
window.DashboardPage = {
  _refreshTimer: null,

  async render(container) {
    try {
      const [state, config] = await Promise.all([
        apiGet('/api/state'),
        apiGet('/api/config'),
      ]);
      if (!state) return;

      // Calculate portfolio value from positions
      // Use eToro's USD P&L where available to avoid GBX→USD confusion for UK stocks
      const openPositions = Object.entries(state.positions || {})
        .filter(([, p]) => p.quantity > 0);
      let portfolioVal = 0;
      let totalPnl = 0;
      for (const [sym, p] of openPositions) {
        const pnlUsd = p.etoro_pnl_usd ?? null;
        const pnlPct = (state.prices?.[sym] && p.avg_cost)
          ? ((state.prices[sym] - p.avg_cost) / p.avg_cost) : null;
        const investedUsd = p.invested_usd
          ?? (pnlUsd != null && pnlPct ? pnlUsd / pnlPct : null);
        if (investedUsd != null && pnlUsd != null) {
          portfolioVal += investedUsd + pnlUsd;
          totalPnl += pnlUsd;
        } else {
          // Fallback for positions with no eToro pnl data yet (USD instruments only)
          const price = state.prices?.[sym] || p.avg_cost || 0;
          const cost = (p.quantity || 0) * (p.avg_cost || 0);
          portfolioVal += (p.quantity || 0) * price;
          totalPnl += (p.quantity || 0) * price - cost;
        }
      }
      const cash = state.cash || 0;
      const totalCost = portfolioVal - totalPnl;
      const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

      const dryRun = config?.safety?.dry_run ?? true;
      const risk = state.risk || {};
      const peakVal = risk.portfolio_peak_value || 0;
      const totalVal = portfolioVal + cash;
      const drawdownPct = peakVal > 0 ? ((peakVal - totalVal) / peakVal) * 100 : 0;

      // Last decisions from most recent cycle
      const decisions = state.last_decisions || [];

      // Last check age
      const lastCheckAge = state.last_check
        ? Math.round((Date.now() - new Date(state.last_check).getTime()) / 60000)
        : null;

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

        <!-- Last cycle decisions -->
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div class="card-title" style="margin-bottom:0">Son Döngü — Watchlist Durumu</div>
            <div style="display:flex;align-items:center;gap:10px">
              ${lastCheckAge !== null ? `<span style="color:var(--muted);font-size:11px">
                ${lastCheckAge === 0 ? 'az önce' : lastCheckAge + ' dk önce'}
              </span>` : ''}
              <span id="dash-refresh-dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--green)" title="30s'de bir yenileniyor"></span>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sembol</th>
                  <th class="right">Fiyat</th>
                  <th class="right">Değişim</th>
                  <th>Karar</th>
                  <th>Piyasa</th>
                  <th>Neden</th>
                </tr>
              </thead>
              <tbody>
                ${decisions.length === 0
                  ? '<tr><td colspan="6" style="color:var(--subtle);padding-top:12px">Henüz döngü verisi yok — bir sonraki döngü bekleniyor...</td></tr>'
                  : decisions.map(d => {
                    const chgColor = d.change == null ? 'inherit' : d.change >= 0 ? 'var(--green)' : 'var(--red)';
                    const badge = d.blocked
                      ? `<span class="badge" style="background:#92400e;color:#fef3c7">BLOKE</span>`
                      : d.action === 'buy'
                        ? `<span class="badge badge-buy">ALIŞ</span>`
                        : d.action === 'sell'
                          ? `<span class="badge badge-sell">SATIŞ</span>`
                          : `<span class="badge">BEKLE</span>`;
                    const marketDot = d.exchange === 'CRYPTO'
                      ? `<span style="color:var(--accent);font-size:11px">⟳ CRYPTO</span>`
                      : d.market_open
                        ? `<span style="color:var(--green);font-size:11px">● ${esc(d.exchange)} Açık</span>`
                        : `<span style="color:var(--red);font-size:11px">● ${esc(d.exchange)} Kapalı</span>`;
                    return `<tr>
                      <td style="font-weight:600">${esc(d.symbol)}</td>
                      <td class="right">${fmt$(d.price)}</td>
                      <td class="right" style="color:${chgColor}">${fmtPct(d.change)}</td>
                      <td>${badge}</td>
                      <td>${marketDot}</td>
                      <td style="color:var(--muted);font-size:11px;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(d.reason || '')}">${esc(d.reason || '—')}</td>
                    </tr>`;
                  }).join('')
                }
              </tbody>
            </table>
          </div>
        </div>
      `;

      // Near miss list — last cycle holds that almost qualified
      await DashboardPage._renderNearMiss(container, config);

      // Auto-refresh every 30s while on dashboard
      clearInterval(DashboardPage._refreshTimer);
      DashboardPage._refreshTimer = setInterval(() => {
        const content = document.getElementById('content');
        if (content) DashboardPage.render(content);
      }, 30000);

    } catch (err) {
      container.innerHTML = `<div style="color:var(--red)">Hata: ${err.message}</div>`;
    }
  },

  async _renderNearMiss(container, config) {
    const entryScore = config?.strategy?.entry_score ?? 70;
    const nearMissMin = entryScore - 5; // default 65

    let recentDecisions = [];
    try { recentDecisions = await apiGet('/api/decisions?limit=300'); } catch { return; }
    if (!recentDecisions?.length) return;

    // Find the most recent cycle timestamp
    const latestCycleTs = recentDecisions[0]?.cycle_ts;
    if (!latestCycleTs) return;

    // Filter: same cycle, decision=hold, final_score in [nearMissMin, entryScore)
    const nearMisses = recentDecisions.filter(d =>
      d.cycle_ts === latestCycleTs &&
      d.decision === 'hold' &&
      d.final_score != null &&
      d.final_score >= nearMissMin &&
      d.final_score < entryScore
    );

    if (!nearMisses.length) return;

    const section = document.createElement('div');
    section.className = 'card';
    section.style.marginTop = '16px';
    section.innerHTML = `
      <div class="card-title" style="margin-bottom:8px">
        🔍 Near Miss — Eşiğe Yakın (${nearMissMin}–${entryScore - 1})
        <span style="color:var(--muted);font-size:11px;font-weight:normal;margin-left:8px">Son döngü · izle, eşiği düşürme</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Sembol</th>
              <th class="right">Final</th>
              <th class="right">RS</th>
              <th class="right" title="RSI/MACD/Vol/ATR — üzerine gel">Teknik</th>
              <th class="right">Piyasa</th>
              <th class="right">Breadth</th>
              <th>Neden</th>
            </tr>
          </thead>
          <tbody>
            ${nearMisses.map(d => {
              const techTip = d.tech_score != null
                ? `RSI:${d.tech_rsi_pts ?? '?'} MACD:${d.tech_macd_pts ?? '?'} Vol:${d.tech_vol_pts ?? '?'} ATR:${d.tech_atr_pts ?? '?'}`
                : '';
              return `<tr>
                <td style="font-weight:600">${esc(d.symbol)}</td>
                <td class="right" style="color:var(--accent);font-weight:600">${d.final_score}</td>
                <td class="right">${d.rs_score != null ? Number(d.rs_score).toFixed(1) : '—'}</td>
                <td class="right" style="cursor:default" title="${techTip}">${d.tech_score ?? '—'}</td>
                <td class="right">${d.market_score ?? '—'}</td>
                <td class="right">${d.breadth_count != null ? d.breadth_count + '/11' : '—'}</td>
                <td style="color:var(--muted);font-size:11px;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(d.fail_reason || '')}">${esc(d.fail_reason || '—')}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
    container.appendChild(section);
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
      const content = document.getElementById('content');
      if (content) DashboardPage.render(content);
    } catch (err) {
      alert('Hata: ' + err.message);
    }
  }
};
