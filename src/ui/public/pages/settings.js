// src/ui/public/pages/settings.js
window.SettingsPage = {
  _config: null,

  _esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, "&#39;").replace(/"/g, '&quot;'); },

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
      const ai = config.ai || {};
      const cs = config.crypto_scanner || {};

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
            <input id="new-symbol" class="input-field" placeholder="Add symbol (e.g. TSLA)" style="flex:1">
            <button class="btn-primary" onclick="SettingsPage.addTag()">+ Add</button>
          </div>
        </div>

        <!-- Final Score -->
        <div class="card" style="margin-bottom:16px">
          <div class="card-title">🎯 Final Score</div>
          <div style="color:var(--muted);font-size:11px;margin-bottom:12px">
            Market(30%) + RS(25%) + Technical(20%) + Breadth(15%) + ADX(10%) → 0–100
          </div>
          <div class="grid-2">
            <div>
              <div class="field-row">
                <span class="field-label" title="Symbols scoring above this threshold are bought">Buy threshold</span>
                <input id="entry-score" class="input-field small" type="number" value="${strategy.entry_score ?? 70}">
                <span style="color:var(--subtle);font-size:11px">/100</span>
              </div>
            </div>
            <div>
              <div class="field-row">
                <span class="field-label" title="Symbols scoring above this get a larger position">Strong Buy threshold</span>
                <input id="strong-buy-score" class="input-field small" type="number" value="${strategy.strong_buy_score ?? 85}">
                <span style="color:var(--subtle);font-size:11px">/100</span>
              </div>
            </div>
          </div>
        </div>

        <!-- AI Decision -->
        <div class="card" style="margin-bottom:16px">
          <div class="card-title">🤖 AI Decision</div>
          <div class="grid-2">
            <div>
              <div class="field-row">
                <span class="field-label" title="disabled: AI off | gate: final gate only | override: also query near-misses">AI mode</span>
                <select id="ai-mode" class="input-field small" onchange="SettingsPage._toggleAiMinScore()">
                  <option value="disabled" ${(strategy.ai_mode ?? 'override') === 'disabled' ? 'selected' : ''}>disabled — off</option>
                  <option value="gate"     ${(strategy.ai_mode ?? 'override') === 'gate'     ? 'selected' : ''}>gate — final gate</option>
                  <option value="override" ${(strategy.ai_mode ?? 'override') === 'override' ? 'selected' : ''}>override — query near-misses too</option>
                </select>
              </div>
            </div>
            <div id="ai-min-score-row" style="${(strategy.ai_mode ?? 'override') === 'disabled' ? 'opacity:0.35;pointer-events:none' : ''}">
              <div class="field-row">
                <span class="field-label" title="Minimum Final Score for AI to be queried (override and gate modes)">AI min score</span>
                <input id="ai-min-score" class="input-field small" type="number" value="${strategy.ai_min_score ?? 50}">
                <span style="color:var(--subtle);font-size:11px">/100</span>
              </div>
            </div>
          </div>
          <div class="field-row" style="margin-top:8px">
            <span class="field-label" title="Maximum AI queries per day">AI daily limit</span>
            <input id="ai-daily-limit" class="input-field small" type="number" value="${ai.daily_call_limit ?? 200}">
            <span style="color:var(--subtle);font-size:11px">calls/day</span>
          </div>
          <div style="color:var(--muted);font-size:11px;margin-top:8px">
            <b>gate:</b> AI approves/rejects after all filters pass &nbsp;|&nbsp;
            <b>override:</b> AI can promote near-misses above min score to BUY
          </div>
        </div>

        <!-- Crypto Scanner -->
        <div class="card" style="margin-bottom:16px">
          <div class="card-title">🔍 Crypto Scanner</div>
          <div style="color:var(--muted);font-size:11px;margin-bottom:12px">
            Scans ~45 cryptos each cycle, scores RS+Volume+ADX+BTC strength+RSI, auto-buys top N candidates.
          </div>
          <div class="field-row">
            <span class="field-label">Scanner enabled</span>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input id="cs-enabled" type="checkbox" ${cs.enabled !== false ? 'checked' : ''}>
              <span style="font-size:12px;color:var(--muted)">on</span>
            </label>
          </div>
          <div class="grid-2" style="margin-top:8px">
            <div>
              <div class="field-row">
                <span class="field-label" title="Max simultaneous open crypto scanner positions">Max positions</span>
                <input id="cs-max-positions" class="input-field small" type="number" value="${cs.max_positions ?? 3}">
              </div>
              <div class="field-row">
                <span class="field-label" title="Coins scoring above this are bought (0-100)">Min score</span>
                <input id="cs-min-score" class="input-field small" type="number" value="${cs.min_score ?? 65}">
                <span style="color:var(--subtle);font-size:11px">/100</span>
              </div>
            </div>
            <div>
              <div class="field-row">
                <span class="field-label" title="How many coins are selected as buy candidates">Top N</span>
                <input id="cs-top-n" class="input-field small" type="number" value="${cs.top_n ?? 5}">
              </div>
              <div class="field-row">
                <span class="field-label" title="No buys when BTC 1H price is below EMA50">BTC EMA gate</span>
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                  <input id="cs-btc-gate" type="checkbox" ${cs.btc_ema_gate !== false ? 'checked' : ''}>
                  <span style="font-size:12px;color:var(--muted)">active</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- Budget + Risk -->
        <div class="grid-2" style="margin-bottom:16px">
          <div class="card">
            <div class="card-title">💰 Budget</div>
            <div class="field-row">
              <span class="field-label">Min cash reserve</span>
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
              <input id="pa-symbol" class="input-field" placeholder="SYMBOL" style="width:70px">
              <input id="pa-amount" class="input-field" type="number" placeholder="Amount $" style="flex:1">
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
              <span style="color:var(--subtle);font-size:11px">hours</span>
            </div>
            <div class="field-row">
              <span class="field-label">Max daily trades</span>
              <input id="max-daily" class="input-field small" value="${strategy.max_daily_trades ?? 10}">
              <span style="color:var(--subtle);font-size:11px">trades</span>
            </div>
          </div>
        </div>

        <!-- Strategy Filters -->
        <div class="card" style="margin-bottom:16px">
          <div class="card-title">⚙️ Strategy Filters</div>
          <div class="grid-2">
            <div>
              <div class="field-row">
                <span class="field-label" title="Minimum market state required to buy">Min market state</span>
                <select id="min-global-state" class="input-field small">
                  <option value="RISK_ON"      ${(strategy.min_global_state ?? 'RISK_ON') === 'RISK_ON'      ? 'selected' : ''}>RISK_ON</option>
                  <option value="RISK_NEUTRAL" ${(strategy.min_global_state ?? 'RISK_ON') === 'RISK_NEUTRAL' ? 'selected' : ''}>RISK_NEUTRAL</option>
                </select>
              </div>
              <div class="field-row">
                <span class="field-label" title="Minimum ADX value (trend strength)">ADX threshold</span>
                <input id="adx-threshold" class="input-field small" type="number" value="${strategy.adx_threshold ?? 20}">
              </div>
              <div class="field-row">
                <span class="field-label" title="Minimum RS score (0-100)">RS score threshold</span>
                <input id="rs-threshold" class="input-field small" type="number" value="${strategy.rs_threshold ?? 70}">
              </div>
              <div class="field-row">
                <span class="field-label" title="Minimum technical score (RSI+MACD+Vol+ATR)">Technical threshold</span>
                <input id="technical-threshold" class="input-field small" type="number" value="${strategy.technical_threshold ?? 65}">
              </div>
            </div>
            <div>
              <div class="field-row">
                <span class="field-label" title="Correlation block threshold (0-1)">Max correlation</span>
                <input id="correlation-max" class="input-field small" type="number" step="0.05" value="${strategy.correlation_max ?? 0.85}">
              </div>
              <div class="field-row">
                <span class="field-label" title="Min sectors above MA50 (out of 11)">Min breadth sectors</span>
                <input id="breadth-min-sectors" class="input-field small" type="number" value="${strategy.breadth_min_sectors ?? 4}">
              </div>
              <div class="field-row">
                <span class="field-label" title="Days before earnings report to block entry">Earnings block before</span>
                <input id="earnings-days-before" class="input-field small" type="number" value="${strategy.earnings_days_before ?? 5}">
                <span style="color:var(--subtle);font-size:11px">days</span>
              </div>
              <div class="field-row">
                <span class="field-label" title="Days after earnings report to block entry">Earnings block after</span>
                <input id="earnings-days-after" class="input-field small" type="number" value="${strategy.earnings_days_after ?? 2}">
                <span style="color:var(--subtle);font-size:11px">days</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Save -->
        <div style="display:flex;justify-content:flex-end;align-items:center;gap:12px">
          <span id="save-status" style="color:var(--muted);font-size:12px"></span>
          <button class="btn-primary" onclick="SettingsPage.save()">💾 Save</button>
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div style="color:var(--red)">Error: ${err.message}</div>`;
    }
  },

  _toggleAiMinScore() {
    const mode = document.getElementById('ai-mode').value;
    const row  = document.getElementById('ai-min-score-row');
    if (row) row.style.cssText = mode === 'disabled' ? 'opacity:0.35;pointer-events:none' : '';
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
    this._renderTags();
    this._saveWatchlist();
  },

  removeTag(sym) {
    this._config.watchlist = (this._config.watchlist || []).filter(s => s !== sym);
    this._renderTags();
    this._saveWatchlist();
  },

  _renderTags() {
    document.getElementById('watchlist-tags').innerHTML = (this._config.watchlist || []).map(s => `
      <span class="tag">${s} <span class="tag-remove" onclick="SettingsPage.removeTag('${SettingsPage._esc(s)}')">✕</span></span>
    `).join('');
  },

  async _saveWatchlist() {
    try {
      await apiPost('/api/config', { watchlist: this._config.watchlist });
      const statusEl = document.getElementById('save-status');
      if (statusEl) {
        statusEl.style.color = 'var(--green)';
        statusEl.textContent = '✓ Watchlist saved';
        setTimeout(() => { statusEl.textContent = ''; }, 2000);
      }
    } catch (err) {
      const statusEl = document.getElementById('save-status');
      if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = 'Error: ' + err.message; }
    }
  },

  async save() {
    const statusEl = document.getElementById('save-status');

    // Validate all numeric inputs before saving
    const numericIds = ['entry-score', 'strong-buy-score', 'ai-min-score', 'ai-daily-limit',
                        'min-cash', 'max-exposure', 'drawdown-stop', 'cooldown', 'max-daily',
                        'adx-threshold', 'correlation-max', 'breadth-min-sectors',
                        'earnings-days-before', 'earnings-days-after',
                        'cs-max-positions', 'cs-min-score', 'cs-top-n'];
    for (const id of numericIds) {
      const val = parseFloat(document.getElementById(id).value);
      if (isNaN(val)) {
        statusEl.style.color = 'var(--red)';
        statusEl.textContent = `Error: enter a valid number for "${id}"`;
        return;
      }
    }

    for (const input of document.querySelectorAll('.pa-amount')) {
      if (isNaN(parseFloat(input.value))) {
        statusEl.style.color = 'var(--red)';
        statusEl.textContent = 'Error: enter a valid number for per-asset amount';
        return;
      }
    }

    statusEl.textContent = 'Saving...';
    statusEl.style.color = 'var(--muted)';

    // Re-fetch config to get current dry_run value (may have changed via dashboard toggle)
    const freshConfig = await apiGet('/api/config');
    if (!freshConfig) { statusEl.textContent = ''; return; }

    const updates = {
      watchlist: this._config.watchlist,
      safety: {
        ...freshConfig.safety,
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
      ai: {
        ...this._config.ai,
        daily_call_limit: parseInt(document.getElementById('ai-daily-limit').value, 10),
      },
      crypto_scanner: {
        ...this._config.crypto_scanner,
        enabled:       document.getElementById('cs-enabled').checked,
        max_positions: parseInt(document.getElementById('cs-max-positions').value, 10),
        min_score:     parseInt(document.getElementById('cs-min-score').value, 10),
        top_n:         parseInt(document.getElementById('cs-top-n').value, 10),
        btc_ema_gate:  document.getElementById('cs-btc-gate').checked,
      },
      strategy: {
        ...this._config.strategy,
        entry_score:           parseFloat(document.getElementById('entry-score').value),
        strong_buy_score:      parseFloat(document.getElementById('strong-buy-score').value),
        ai_mode:               document.getElementById('ai-mode').value,
        ai_min_score:          parseFloat(document.getElementById('ai-min-score').value),
        drawdown_stop_pct:     parseFloat(document.getElementById('drawdown-stop').value),
        cooldown_hours:        parseFloat(document.getElementById('cooldown').value),
        max_daily_trades:      parseInt(document.getElementById('max-daily').value, 10),
        min_global_state:      document.getElementById('min-global-state').value,
        adx_threshold:         parseFloat(document.getElementById('adx-threshold').value),
        correlation_max:       parseFloat(document.getElementById('correlation-max').value),
        breadth_min_sectors:   parseInt(document.getElementById('breadth-min-sectors').value, 10),
        earnings_days_before:  parseInt(document.getElementById('earnings-days-before').value, 10),
        earnings_days_after:   parseInt(document.getElementById('earnings-days-after').value, 10),
      }
    };

    try {
      await apiPost('/api/config', updates);
      statusEl.style.color = 'var(--green)';
      statusEl.textContent = '✓ Saved';
      setTimeout(() => { statusEl.textContent = ''; }, 3000);
    } catch (err) {
      statusEl.style.color = 'var(--red)';
      statusEl.textContent = 'Error: ' + err.message;
    }
  }
};
