// src/ui/public/pages/log.js
window.LogPage = {
  _activeTab: 'decisions',

  render(container) {
    if (window._activeSSE) { window._activeSSE.close(); window._activeSSE = null; }

    container.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <button id="tab-decisions" class="btn-primary"  onclick="LogPage.showTab('decisions')">🧠 Kararlar</button>
        <button id="tab-rawlog"    class="btn-secondary" onclick="LogPage.showTab('rawlog')">📝 Ham Log</button>
      </div>

      <!-- Decisions tab -->
      <div id="tab-decisions-panel">
        <div class="card" style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
            <div class="card-title" style="margin-bottom:0">Son Kararlar</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <input id="dec-filter-sym"  class="input-field" placeholder="Sembol filtrele" style="width:110px" oninput="LogPage.renderDecisions()">
              <select id="dec-filter-act" class="input-field" style="width:110px" onchange="LogPage.renderDecisions()">
                <option value="">Tüm kararlar</option>
                <option value="buy">Alım</option>
                <option value="sell">Satım</option>
                <option value="hold">Bekle</option>
              </select>
              <button class="btn-secondary" onclick="LogPage.loadDecisions()">↻ Yenile</button>
            </div>
          </div>
        </div>
        <div id="decisions-table-wrap"></div>
      </div>

      <!-- Raw log tab -->
      <div id="tab-rawlog-panel" style="display:none">
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
      </div>
    `;

    this.showTab(this._activeTab);
    this.loadDecisions();
    this._startSSE();
  },

  showTab(tab) {
    this._activeTab = tab;
    document.getElementById('tab-decisions-panel').style.display = tab === 'decisions' ? '' : 'none';
    document.getElementById('tab-rawlog-panel').style.display    = tab === 'rawlog'    ? '' : 'none';
    document.getElementById('tab-decisions').className = tab === 'decisions' ? 'btn-primary' : 'btn-secondary';
    document.getElementById('tab-rawlog').className    = tab === 'rawlog'    ? 'btn-primary' : 'btn-secondary';
  },

  _decisions: [],

  async loadDecisions() {
    try {
      const data = await apiGet('/api/decisions?limit=300');
      this._decisions = data || [];
      this.renderDecisions();
    } catch (err) {
      document.getElementById('decisions-table-wrap').innerHTML =
        `<div style="color:var(--red)">Hata: ${err.message}</div>`;
    }
  },

  renderDecisions() {
    const symFilter = (document.getElementById('dec-filter-sym')?.value || '').toUpperCase();
    const actFilter = document.getElementById('dec-filter-act')?.value || '';

    const rows = this._decisions.filter(d => {
      if (symFilter && !d.symbol?.includes(symFilter)) return false;
      if (actFilter && d.decision !== actFilter) return false;
      return true;
    });

    if (!rows.length) {
      document.getElementById('decisions-table-wrap').innerHTML =
        '<div style="color:var(--muted);padding:16px;text-align:center">Henüz karar kaydı yok</div>';
      return;
    }

    const fmtFilter = (val) => {
      if (val === 'PASS') return '<span style="color:var(--green)">✓</span>';
      if (val === 'FAIL') return '<span style="color:var(--red)">✗</span>';
      return '<span style="color:var(--muted)">—</span>';
    };

    const fmtDecision = (d) => {
      if (d.decision === 'buy')  return `<span style="color:var(--green);font-weight:600">ALIM L${d.tranche || '?'}</span>`;
      if (d.decision === 'sell') return `<span style="color:var(--red);font-weight:600">SATIM</span>`;
      return `<span style="color:var(--muted)">bekle</span>`;
    };

    const fmtNum = (v, dec = 1) => v != null ? Number(v).toFixed(dec) : '—';
    const fmtPct = (v) => v != null ? (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%' : '—';

    // Store AI payloads in a side-array keyed by row index.
    // This avoids embedding JSON with double-quotes inside onclick="..." HTML attributes,
    // which would break the attribute parser.
    this._aiData = [];

    const html = `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="border-bottom:1px solid var(--border);color:var(--muted);text-align:left">
              <th style="padding:6px 8px;white-space:nowrap">Zaman</th>
              <th style="padding:6px 8px">Sembol</th>
              <th style="padding:6px 8px;text-align:right">Fiyat</th>
              <th style="padding:6px 8px;text-align:right">Değ%</th>
              <th style="padding:6px 8px">Piyasa</th>
              <th style="padding:6px 8px;text-align:right">Breadth</th>
              <th style="padding:6px 8px">Trend</th>
              <th style="padding:6px 8px;text-align:right">ADX</th>
              <th style="padding:6px 8px;text-align:right">Final</th>
              <th style="padding:6px 8px;text-align:right">RS</th>
              <th style="padding:6px 8px;text-align:right" title="Teknik skor — üzerine gel: RSI/MACD/Vol/ATR alt kırılımı">Tek.</th>
              <th style="padding:6px 8px;text-align:right">RSI</th>
              <th style="padding:6px 8px;text-align:center" title="Piyasa / Breadth / Trend / ADX / RS / Teknik / Earnings / Korelasyon / AI">Filtreler</th>
              <th style="padding:6px 8px">Karar</th>
              <th style="padding:6px 8px;max-width:200px">Sebep</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((d, idx) => {
              const f = d.filters || {};
              const ts = d.ts ? new Date(d.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '—';
              const date = d.ts ? new Date(d.ts).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }) : '';
              const rowColor = d.decision === 'buy' ? 'background:rgba(0,255,0,0.03)' :
                               d.decision === 'sell' ? 'background:rgba(255,0,0,0.03)' : '';

              // Store AI payload by index — no JSON in onclick attribute
              let aiBtn = fmtFilter(f.ai_audit);
              if (d.ai_prompt) {
                this._aiData[idx] = { prompt: d.ai_prompt, verdict: d.ai_verdict, reason: d.ai_reason };
                aiBtn = `<span style="cursor:pointer;letter-spacing:0" onclick="LogPage.showAiPrompt(${idx})" title="AI sorgusunu gör">${fmtFilter(f.ai_audit)}🔍</span>`;
              }

              return `<tr style="border-bottom:1px solid var(--border);${rowColor}">
                <td style="padding:6px 8px;white-space:nowrap;color:var(--muted)">${date}<br>${ts}</td>
                <td style="padding:6px 8px;font-weight:600">${d.symbol || '—'}</td>
                <td style="padding:6px 8px;text-align:right">$${fmtNum(d.price, 2)}</td>
                <td style="padding:6px 8px;text-align:right;color:${d.change_pct >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtPct(d.change_pct)}</td>
                <td style="padding:6px 8px;white-space:nowrap">
                  <span style="font-size:10px;padding:1px 5px;border-radius:3px;background:${d.market_state === 'RISK_ON' ? 'rgba(0,200,0,0.15)' : 'rgba(255,165,0,0.15)'}">${d.market_state || '—'}</span>
                </td>
                <td style="padding:6px 8px;text-align:right">${d.breadth_count != null ? d.breadth_count + '/11' : '—'}</td>
                <td style="padding:6px 8px">${d.trend || '—'}</td>
                <td style="padding:6px 8px;text-align:right">${fmtNum(d.adx)}</td>
                <td style="padding:6px 8px;text-align:right;font-weight:${d.final_score >= 85 ? '700' : 'normal'};color:${d.final_score >= 85 ? 'var(--green)' : d.final_score >= 70 ? 'var(--accent)' : 'inherit'}">${d.final_score != null ? d.final_score : '—'}</td>
                <td style="padding:6px 8px;text-align:right">${fmtNum(d.rs_score)}</td>
                <td style="padding:6px 8px;text-align:right;cursor:default" title="${d.tech_score != null ? `RSI:${d.tech_rsi_pts ?? '?'}  MACD:${d.tech_macd_pts ?? '?'}  Vol:${d.tech_vol_pts ?? '?'}  ATR:${d.tech_atr_pts ?? '?'}` : ''}">${fmtNum(d.tech_score, 0)}</td>
                <td style="padding:6px 8px;text-align:right">${fmtNum(d.rsi)}</td>
                <td style="padding:6px 8px;text-align:center;white-space:nowrap;letter-spacing:2px">
                  ${fmtFilter(f.market_state)}${fmtFilter(f.breadth)}${fmtFilter(f.trend)}${fmtFilter(f.adx)}${fmtFilter(f.rs_score)}${fmtFilter(f.tech_score)}${fmtFilter(f.earnings)}${fmtFilter(f.correlation)}${aiBtn}
                </td>
                <td style="padding:6px 8px">${fmtDecision(d)}</td>
                <td style="padding:6px 8px;color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(d.fail_reason || d.ai_reason || '').replace(/"/g, '&quot;')}">${d.fail_reason || d.ai_reason || '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
    document.getElementById('decisions-table-wrap').innerHTML = html;
  },

  _startSSE() {
    const panel = document.getElementById('log-panel');
    const statusEl = document.getElementById('log-status');
    if (!panel || !statusEl) return;

    const es = new EventSource('/api/logs');
    window._activeSSE = es;

    es.onopen = () => { statusEl.textContent = '● Canlı'; statusEl.style.color = 'var(--green)'; };

    es.onmessage = (e) => {
      const line = JSON.parse(e.data);
      const div = document.createElement('div');
      const isError  = line.includes('[ERROR]') || line.toLowerCase().includes('error') || line.toLowerCase().includes('hata');
      const isTrade  = line.includes('[Trade]') || line.includes('BUY') || line.includes('SELL');
      const isCycle  = line.includes('Cycle start') || line.includes('[Bot] Starting');
      const isMarket = line.includes('[MarketState]') || line.includes('RISK_');
      div.className = 'log-line' + (isError ? ' error' : '') + (isTrade ? ' trade' : '') + (isCycle ? ' cycle' : '') + (isMarket ? ' market' : '');
      div.textContent = line;
      panel.appendChild(div);
      while (panel.children.length > 500) panel.removeChild(panel.firstChild);
      panel.scrollTop = panel.scrollHeight;
    };

    es.onerror = () => { statusEl.textContent = '● Bağlantı kesildi'; statusEl.style.color = 'var(--red)'; };
  },

  showAiPrompt(idx) {
    const data = this._aiData[idx];
    if (!data) return;
    const existing = document.getElementById('ai-prompt-modal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'ai-prompt-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px';
    modal.innerHTML = `
      <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;max-width:600px;width:100%;max-height:80vh;overflow-y:auto;padding:20px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div style="font-weight:600;font-size:13px">🤖 AI Sorgusu</div>
          <button onclick="document.getElementById('ai-prompt-modal').remove()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px">✕</button>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Gönderilen prompt:</div>
        <pre style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:12px;font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--text)">${(data.prompt || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
          <span style="font-size:11px;color:var(--muted)">Yanıt: </span>
          <span style="font-weight:600;color:${data.verdict === 'BUY' ? 'var(--green)' : 'var(--red)'}">${data.verdict ?? '—'}</span>
          <span style="font-size:11px;color:var(--muted);margin-left:8px">${(data.reason || '').replace(/</g,'&lt;')}</span>
        </div>
      </div>
    `;
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  },

  clearDisplay() {
    const panel = document.getElementById('log-panel');
    if (panel) panel.innerHTML = '';
  }
};
