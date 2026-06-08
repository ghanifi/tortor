// src/ui/public/pages/settings.js
window.SettingsPage = {
  _config: null,

  _esc(s) { return String(s).replace(/'/g, "\\'").replace(/"/g, '&quot;'); },

  async render(container) {
    try {
      const config = await apiGet('/api/config');
      if (!config) return;
      this._config = JSON.parse(JSON.stringify(config)); // deep copy

      const watchlist = config.watchlist || [];
      const th = config.thresholds || {};
      const s = th.stocks || { buy: -7, sell: [7, 10, 13] };
      const c = th.crypto || { buy: -12, sell: [10, 15, 20] };
      const budget = config.budget || {};
      const safety = config.safety || {};
      const strategy = config.strategy || {};

      container.innerHTML = `
        <!-- Watchlist -->
        <div class="card" style="margin-bottom:16px">
          <div class="card-title">📋 Watchlist</div>
          <div id="watchlist-tags" class="tags-wrap">
            ${watchlist.map(sym => `
              <span class="tag">
                ${sym}
                <span class="tag-remove" onclick="SettingsPage.removeTag('${SettingsPage._esc(sym)}')">✕</span>
              </span>
            `).join('')}
          </div>
          <div class="add-row">
            <input id="new-symbol" class="input-field" placeholder="Sembol ekle (örn: TSLA)" style="flex:1">
            <button class="btn-primary" onclick="SettingsPage.addTag()">+ Ekle</button>
          </div>
        </div>

        <!-- Thresholds -->
        <div class="card" style="margin-bottom:16px">
          <div class="card-title">📉 Eşikler (Thresholds)</div>
          <div class="grid-2">
            <div>
              <div class="section-label">Hisseler</div>
              <div class="threshold-row">
                <span class="threshold-name">Alım eşiği</span>
                <input id="s-buy" class="input-field small" value="${s.buy}">
                <span class="threshold-unit">%</span>
              </div>
              <div class="threshold-row">
                <span class="threshold-name">Satış T1</span>
                <input id="s-sell-0" class="input-field small" value="${s.sell?.[0] ?? 7}">
                <span class="threshold-unit">%</span>
              </div>
              <div class="threshold-row">
                <span class="threshold-name">Satış T2</span>
                <input id="s-sell-1" class="input-field small" value="${s.sell?.[1] ?? 10}">
                <span class="threshold-unit">%</span>
              </div>
              <div class="threshold-row">
                <span class="threshold-name">Satış T3</span>
                <input id="s-sell-2" class="input-field small" value="${s.sell?.[2] ?? 13}">
                <span class="threshold-unit">%</span>
              </div>
            </div>
            <div>
              <div class="section-label">Kripto</div>
              <div class="threshold-row">
                <span class="threshold-name">Alım eşiği</span>
                <input id="c-buy" class="input-field small" value="${c.buy}">
                <span class="threshold-unit">%</span>
              </div>
              <div class="threshold-row">
                <span class="threshold-name">Satış T1</span>
                <input id="c-sell-0" class="input-field small" value="${c.sell?.[0] ?? 10}">
                <span class="threshold-unit">%</span>
              </div>
              <div class="threshold-row">
                <span class="threshold-name">Satış T2</span>
                <input id="c-sell-1" class="input-field small" value="${c.sell?.[1] ?? 15}">
                <span class="threshold-unit">%</span>
              </div>
              <div class="threshold-row">
                <span class="threshold-name">Satış T3</span>
                <input id="c-sell-2" class="input-field small" value="${c.sell?.[2] ?? 20}">
                <span class="threshold-unit">%</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Budget + Risk -->
        <div class="grid-2" style="margin-bottom:16px">
          <div class="card">
            <div class="card-title">💰 Budget</div>
            <div class="field-row">
              <span class="field-label">Nakit rezerv (min)</span>
              <input id="min-cash" class="input-field small" value="${safety.min_cash_reserve ?? 100}">
              <span style="color:var(--subtle);font-size:11px">$</span>
            </div>
            <div class="field-row">
              <span class="field-label">Max exposure</span>
              <input id="max-exposure" class="input-field small" value="${safety.max_exposure_pct ?? 30}">
              <span style="color:var(--subtle);font-size:11px">%</span>
            </div>
            <div class="section-label" style="margin-top:8px">Per-asset override ($)</div>
            <div id="per-asset-rows">
              ${Object.entries(budget.per_asset || {}).map(([sym, amt]) => `
                <div class="field-row per-asset-row" data-sym="${sym}">
                  <input class="input-field" value="${SettingsPage._esc(sym)}" style="width:70px" readonly>
                  <input class="input-field pa-amount" type="number" value="${amt}" style="width:80px">
                  <button class="btn-secondary" style="padding:4px 8px" onclick="SettingsPage.removePerAsset('${SettingsPage._esc(sym)}')">✕</button>
                </div>
              `).join('')}
            </div>
            <div class="add-row" style="margin-top:6px">
              <input id="pa-symbol" class="input-field" placeholder="SEMBOL" style="width:70px">
              <input id="pa-amount" class="input-field" type="number" placeholder="Miktar $" style="flex:1">
              <button class="btn-secondary" onclick="SettingsPage.addPerAsset()">+</button>
            </div>
          </div>
          <div class="card">
            <div class="card-title">🛡️ Risk</div>
            <div class="field-row">
              <span class="field-label">Drawdown stop</span>
              <input id="drawdown-stop" class="input-field small" value="${strategy.drawdown_stop_pct ?? 20}">
              <span style="color:var(--subtle);font-size:11px">%</span>
            </div>
            <div class="field-row">
              <span class="field-label">Cooldown</span>
              <input id="cooldown" class="input-field small" value="${strategy.cooldown_hours ?? 2}">
              <span style="color:var(--subtle);font-size:11px">saat</span>
            </div>
            <div class="field-row">
              <span class="field-label">Max günlük işlem</span>
              <input id="max-daily" class="input-field small" value="${strategy.max_daily_trades ?? 10}">
              <span style="color:var(--subtle);font-size:11px">adet</span>
            </div>
          </div>
        </div>

        <!-- Save -->
        <div style="display:flex;justify-content:flex-end;align-items:center;gap:12px">
          <span id="save-status" style="color:var(--muted);font-size:12px"></span>
          <button class="btn-primary" onclick="SettingsPage.save()">💾 Kaydet</button>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div style="color:var(--red)">Hata: ${err.message}</div>`;
    }
  },

  addPerAsset() {
    const sym = document.getElementById('pa-symbol').value.trim().toUpperCase();
    const amt = parseFloat(document.getElementById('pa-amount').value);
    if (!sym || !amt || amt <= 0) return;
    if (!this._config.budget) this._config.budget = {};
    if (!this._config.budget.per_asset) this._config.budget.per_asset = {};
    this._config.budget.per_asset[sym] = amt;
    document.getElementById('pa-symbol').value = '';
    document.getElementById('pa-amount').value = '';
    const row = document.createElement('div');
    row.className = 'field-row per-asset-row';
    row.dataset.sym = sym;
    row.innerHTML = `
      <input class="input-field" value="${SettingsPage._esc(sym)}" style="width:70px" readonly>
      <input class="input-field pa-amount" type="number" value="${amt}" style="width:80px">
      <button class="btn-secondary" style="padding:4px 8px" onclick="SettingsPage.removePerAsset('${SettingsPage._esc(sym)}')">✕</button>
    `;
    document.getElementById('per-asset-rows').appendChild(row);
  },

  removePerAsset(sym) {
    if (this._config.budget?.per_asset) delete this._config.budget.per_asset[sym];
    const row = document.querySelector(`.per-asset-row[data-sym="${sym}"]`);
    if (row) row.remove();
  },

  addTag() {
    const input = document.getElementById('new-symbol');
    const sym = input.value.trim().toUpperCase();
    if (!sym) return;
    if (!this._config.watchlist) this._config.watchlist = [];
    if (this._config.watchlist.includes(sym)) { input.value = ''; return; }
    this._config.watchlist.push(sym);
    input.value = '';
    // Re-render just the tags section
    document.getElementById('watchlist-tags').innerHTML = this._config.watchlist.map(s => `
      <span class="tag">${s} <span class="tag-remove" onclick="SettingsPage.removeTag('${SettingsPage._esc(s)}')">✕</span></span>
    `).join('');
  },

  removeTag(sym) {
    this._config.watchlist = (this._config.watchlist || []).filter(s => s !== sym);
    document.getElementById('watchlist-tags').innerHTML = this._config.watchlist.map(s => `
      <span class="tag">${s} <span class="tag-remove" onclick="SettingsPage.removeTag('${SettingsPage._esc(s)}')">✕</span></span>
    `).join('');
  },

  async save() {
    const statusEl = document.getElementById('save-status');

    // Validate all numeric inputs before saving
    const numericIds = ['s-buy', 's-sell-0', 's-sell-1', 's-sell-2',
                        'c-buy', 'c-sell-0', 'c-sell-1', 'c-sell-2',
                        'min-cash', 'max-exposure', 'drawdown-stop', 'cooldown', 'max-daily'];
    for (const id of numericIds) {
      const val = parseFloat(document.getElementById(id).value);
      if (isNaN(val)) {
        statusEl.style.color = 'var(--red)';
        statusEl.textContent = `Hata: "${id}" için geçerli sayı girin`;
        return;
      }
    }

    statusEl.textContent = 'Kaydediliyor...';
    statusEl.style.color = 'var(--muted)';

    const updates = {
      watchlist: this._config.watchlist,
      thresholds: {
        stocks: {
          buy: parseFloat(document.getElementById('s-buy').value),
          sell: [
            parseFloat(document.getElementById('s-sell-0').value),
            parseFloat(document.getElementById('s-sell-1').value),
            parseFloat(document.getElementById('s-sell-2').value),
          ]
        },
        crypto: {
          buy: parseFloat(document.getElementById('c-buy').value),
          sell: [
            parseFloat(document.getElementById('c-sell-0').value),
            parseFloat(document.getElementById('c-sell-1').value),
            parseFloat(document.getElementById('c-sell-2').value),
          ]
        }
      },
      safety: {
        ...this._config.safety,
        min_cash_reserve: parseFloat(document.getElementById('min-cash').value),
        max_exposure_pct: parseFloat(document.getElementById('max-exposure').value),
      },
      budget: {
        ...this._config.budget,
        per_asset: Object.fromEntries(
          [...document.querySelectorAll('.per-asset-row')].map(row => [
            row.dataset.sym,
            parseFloat(row.querySelector('.pa-amount').value)
          ])
        )
      },
      strategy: {
        ...this._config.strategy,
        drawdown_stop_pct: parseFloat(document.getElementById('drawdown-stop').value),
        cooldown_hours: parseFloat(document.getElementById('cooldown').value),
        max_daily_trades: parseInt(document.getElementById('max-daily').value, 10),
      }
    };

    try {
      await apiPost('/api/config', updates);
      statusEl.style.color = 'var(--green)';
      statusEl.textContent = '✓ Kaydedildi';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    } catch (err) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'Hata: ' + err.message;
    }
  }
};
