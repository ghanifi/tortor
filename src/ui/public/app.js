// src/ui/public/app.js
// Global router, fetch wrapper, shared utilities

// ── Fetch wrapper ────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) { window.location.href = '/login.html'; return null; }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}
async function apiGet(path)       { return api('GET', path); }
async function apiPost(path, body){ return api('POST', path, body); }

// ── HTML escape ─────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

// ── Formatters ───────────────────────────────────────────
function fmt$(n) { return n != null ? '$' + Number(n).toFixed(2) : '—'; }
function fmtPct(n) { return n != null ? (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '%' : '—'; }
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('tr-TR', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}

// ── Sidebar last-check update ────────────────────────────
async function updateLastCheck() {
  try {
    const state = await apiGet('/api/state');
    if (!state) return;
    const el = document.getElementById('last-check-time');
    if (el && state.last_check) {
      const d = new Date(state.last_check);
      el.textContent = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    }
  } catch {}
}

// ── Stop bot ─────────────────────────────────────────────
async function stopBot() {
  if (!confirm('Botu durdurmak istediğinizden emin misiniz?')) return;
  try {
    await apiPost('/api/bot/stop');
    document.getElementById('bot-status').textContent = '● Durduruldu';
    document.getElementById('bot-status').style.color = '#ef4444';
  } catch (err) {
    alert('Hata: ' + err.message);
  }
}

// ── Router ───────────────────────────────────────────────
const PAGES = {
  dashboard: () => window.DashboardPage.render(content),
  portfolio: () => window.PortfolioPage.render(content),
  settings:  () => window.SettingsPage.render(content),
  log:       () => window.LogPage.render(content),
  history:   () => window.HistoryPage.render(content),
};

const content = document.getElementById('content');

function navigate(route) {
  // Stop any active SSE connection from previous page
  if (window._activeSSE) { window._activeSSE.close(); window._activeSSE = null; }
  // Stop dashboard auto-refresh timer when leaving dashboard
  if (window.DashboardPage?._refreshTimer) { clearInterval(window.DashboardPage._refreshTimer); window.DashboardPage._refreshTimer = null; }

  // Update active nav item
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.route === route);
  });

  content.innerHTML = '<div class="loading">Yükleniyor...</div>';
  const fn = PAGES[route] || PAGES.dashboard;
  fn();
}

// Initial render from hash or default
window.addEventListener('load', () => {
  updateLastCheck();
  setInterval(updateLastCheck, 30000);
  const route = window.location.hash.replace('#/', '') || 'dashboard';
  navigate(route);
});
