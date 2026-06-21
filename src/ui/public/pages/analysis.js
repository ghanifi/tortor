// src/ui/public/pages/analysis.js — Phase 1 Measurement Report
window.AnalysisPage = {
  _pollTimer: null,

  async render(container) {
    container.innerHTML = `
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div>
            <div class="card-title" style="margin-bottom:2px">🔬 Phase 1 — Measurement Report</div>
            <div style="color:var(--subtle);font-size:12px">Spread, movement and feed validation. Strategy logic is not modified.</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <span id="phase1-status" style="font-size:12px;color:var(--subtle)"></span>
            <button id="btn-run-report" class="btn-primary" onclick="AnalysisPage.runReport()">▶ Run Report</button>
            <button class="btn-secondary" onclick="AnalysisPage.load()">↻ Refresh</button>
          </div>
        </div>
      </div>

      <div id="phase1-note" class="card" style="margin-bottom:12px;display:none">
        <div style="color:#f59e0b;font-size:12px">
          ⚠️ <strong>NOTE:</strong> Yahoo bid/ask is <strong>narrower</strong> than eToro's actual spread.
          The spread_pct below is a "floor cost"; real eToro roundtrip cost is higher.
          bid/ask = N/A when market is closed is normal.
        </div>
      </div>

      <div id="phase1-content">
        <div class="loading">Loading...</div>
      </div>
    `;

    await this.load();
  },

  async load() {
    const statusEl = document.getElementById('phase1-status');
    const contentEl = document.getElementById('phase1-content');
    const noteEl = document.getElementById('phase1-note');
    const btnEl = document.getElementById('btn-run-report');
    if (!contentEl) return;

    try {
      const data = await apiGet('/api/phase1');
      if (!data) return;

      if (data.running) {
        if (statusEl) statusEl.textContent = '⏳ Report running...';
        if (btnEl) { btnEl.textContent = '⏳ Running...'; btnEl.disabled = true; }
        contentEl.innerHTML = '<div class="loading">Calculating report, ~30-60 seconds...</div>';
        this._startPoll();
        return;
      } else {
        if (btnEl) { btnEl.textContent = '▶ Run Report'; btnEl.disabled = false; }
        this._stopPoll();
      }

      if (!data.report && data.spreadLog.length === 0) {
        contentEl.innerHTML = `
          <div class="card" style="color:var(--subtle);text-align:center;padding:32px">
            No report yet. Click <strong>▶ Run Report</strong>.
          </div>`;
        return;
      }

      if (noteEl) noteEl.style.display = '';

      let html = '';

      // ── Feasibility table ─────────────────────────────────────────────
      if (data.report?.feasibility?.length) {
        const genAt = data.report.generatedAt
          ? new Date(data.report.generatedAt).toLocaleString('en-GB') : '—';
        if (statusEl) statusEl.textContent = `Last run: ${genAt}`;

        html += `
          <div class="card" style="margin-bottom:12px">
            <div class="card-title">📊 Feasibility Table</div>
            <div style="font-size:11px;color:var(--subtle);margin-bottom:8px">
              move/cost = avg_1m_move% / roundtrip_spread% &nbsp;|&nbsp;
              <span style="color:#ef4444">❌ &lt; 2 → mathematical loss</span> &nbsp;
              <span style="color:#f59e0b">⚠️ 2-3 → borderline</span> &nbsp;
              <span style="color:#22c55e">✓ &gt; 3 → adequate</span>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th class="right">Spread%</th>
                    <th class="right">Roundtrip%</th>
                    <th class="right">1m Move%</th>
                    <th class="right">5m Move%</th>
                    <th class="right">Move/Cost</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  ${data.report.feasibility.map(r => {
                    const statusColor = r.status === 'loss' ? '#ef4444'
                                      : r.status === 'marginal' ? '#f59e0b'
                                      : r.status === 'ok' ? '#22c55e'
                                      : 'var(--subtle)';
                    return `<tr>
                      <td style="font-weight:600">${esc(r.symbol)}</td>
                      <td class="right">${r.spread_pct    != null ? r.spread_pct.toFixed(4)    : '—'}</td>
                      <td class="right">${r.roundtrip_pct != null ? r.roundtrip_pct.toFixed(4) : '—'}</td>
                      <td class="right">${r.avg_1m_pct    != null ? r.avg_1m_pct.toFixed(4)    : '—'}</td>
                      <td class="right">${r.avg_5m_pct    != null ? r.avg_5m_pct.toFixed(4)    : '—'}</td>
                      <td class="right" style="font-weight:600;color:${statusColor}">${r.ratio != null ? r.ratio.toFixed(2) : '—'}</td>
                      <td style="font-size:12px;color:${statusColor}">${esc(r.verdict || '—')}</td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>`;
      }

      // ── Feed validation ───────────────────────────────────────────────
      if (data.report?.feed && Object.keys(data.report.feed).length) {
        const feedEntries = Object.entries(data.report.feed);
        const hasWarning = feedEntries.some(([, v]) => v.ok === false);
        html += `
          <div class="card" style="margin-bottom:12px">
            <div class="card-title">🔍 Feed Validation ${hasWarning ? '<span style="color:#ef4444">⚠️ Suspicious price detected</span>' : '<span style="color:#22c55e">✓ Clean</span>'}</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Symbol</th><th class="right">Price</th><th>Status</th></tr></thead>
                <tbody>
                  ${feedEntries.map(([sym, v]) => {
                    const color = v.ok === false ? '#ef4444' : v.ok === true ? '#22c55e' : 'var(--subtle)';
                    const icon  = v.ok === false ? '⚠️' : v.ok === true ? '✓' : '—';
                    return `<tr>
                      <td style="font-weight:600">${esc(sym)}</td>
                      <td class="right">${v.price != null ? v.price.toFixed(2) : '—'}</td>
                      <td style="color:${color};font-size:12px">${icon} ${esc(v.note || '')}</td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>`;
      }

      // ── Latest spread records ─────────────────────────────────────────
      if (data.spreadLog.length > 0) {
        // Latest entry per symbol
        const latestBySymbol = {};
        for (const row of data.spreadLog) {
          if (!latestBySymbol[row.symbol]) latestBySymbol[row.symbol] = row;
        }
        html += `
          <div class="card">
            <div class="card-title">📈 Latest Spread Records (newest per symbol)</div>
            <div style="font-size:11px;color:var(--subtle);margin-bottom:8px">
              data/logs/spread_log.csv — appended automatically each cycle
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Time</th><th>Symbol</th><th class="right">Bid</th><th class="right">Ask</th><th class="right">Spread%</th></tr></thead>
                <tbody>
                  ${Object.values(latestBySymbol).map(r => `<tr>
                    <td style="color:var(--muted)">${fmtTime(r.timestamp)}</td>
                    <td style="font-weight:600">${esc(r.symbol)}</td>
                    <td class="right">${r.bid  != null ? r.bid.toFixed(2)  : '—'}</td>
                    <td class="right">${r.ask  != null ? r.ask.toFixed(2)  : '—'}</td>
                    <td class="right" style="font-weight:600">${r.spread_pct != null ? r.spread_pct.toFixed(4) + '%' : '—'}</td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </div>`;
      }

      contentEl.innerHTML = html || '<div class="card" style="color:var(--subtle)">No data — run the report.</div>';

    } catch (err) {
      if (contentEl) contentEl.innerHTML = `<div class="card" style="color:#ef4444">Error: ${esc(err.message)}</div>`;
    }
  },

  async runReport() {
    const btn = document.getElementById('btn-run-report');
    const statusEl = document.getElementById('phase1-status');
    if (btn) { btn.textContent = '⏳ Starting...'; btn.disabled = true; }
    try {
      const res = await apiPost('/api/phase1/run');
      if (!res) return;
      if (statusEl) statusEl.textContent = res.message || 'Report running...';
      this._startPoll();
    } catch (err) {
      alert('Failed to start report: ' + err.message);
      if (btn) { btn.textContent = '▶ Run Report'; btn.disabled = false; }
    }
  },

  _startPoll() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this.load(), 5000);
  },

  _stopPoll() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },
};
