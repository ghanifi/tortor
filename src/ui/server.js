// src/ui/server.js
'use strict';

const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadConfig } = require('../config');
const { loadState, saveState } = require('../state');
const EToroClient = require('../etoro/client');

const app = express();
const PORT = parseInt(process.env.UI_PORT || '3000', 10);
const PASSWORD = process.env.UI_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  console.warn('[UI] SESSION_SECRET not set — sessions will be invalidated on restart');
  return crypto.randomBytes(32).toString('hex');
})();
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const BOT_LOG = path.join(LOG_DIR, 'bot.log');
const TRADES_LOG = path.join(LOG_DIR, 'trades.jsonl');

// Lazy EToroClient — only created on first manual trade call
let _etoroClient = null;
function getEtoroClient() {
  if (!_etoroClient) _etoroClient = new EToroClient(loadConfig());
  return _etoroClient;
}

// Config helpers — never expose encrypted fields
const CONFIG_PUBLIC_FIELDS = ['watchlist', 'thresholds', 'budget', 'safety', 'strategy', 'ai', 'crypto_scanner'];
function readPublicConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const result = {};
  for (const f of CONFIG_PUBLIC_FIELDS) if (raw[f] !== undefined) result[f] = raw[f];
  return result;
}
function writeConfigFields(updates) {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const f of CONFIG_PUBLIC_FIELDS) {
    if (updates[f] !== undefined) raw[f] = updates[f];
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
}

// Middleware
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Auth middleware — protects API routes and redirects browser requests to /login.html
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Oturum açılmamış' });
  return res.redirect('/login.html');
}

// Login / logout (no auth required)
app.post('/login', (req, res) => {
  const provided = req.body.password || '';
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(PASSWORD, 'utf8');
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (match) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Hatalı şifre' });
});
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Serve login.html without auth
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});
app.get('/style.css', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'style.css'));
});

// All routes below require auth
app.use(requireAuth);
app.use(express.static(PUBLIC_DIR));

// ── API: State ──────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  res.json(loadState());
});

// ── API: Config ─────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json(readPublicConfig());
});

app.post('/api/config', (req, res) => {
  try {
    writeConfigFields(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Bot controls ────────────────────────────────────────────────────────
app.post('/api/bot/stop', (req, res) => {
  const pidFile = path.join(process.cwd(), 'bot.pid');
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 1) throw new Error('Geçersiz PID');
    process.kill(pid, 'SIGTERM');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Bot durdurulamadı: ' + err.message });
  }
});

app.post('/api/bot/dry-run', (req, res) => {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    raw.safety = raw.safety || {};
    raw.safety.dry_run = !raw.safety.dry_run;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2));
    res.json({ ok: true, dry_run: raw.safety.dry_run });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Risk reset ──────────────────────────────────────────────────────────
app.post('/api/risk/reset', (req, res) => {
  try {
    const state = loadState();
    state.risk.trades_paused = false;
    // Set peak to current portfolio value so drawdown resets to 0%
    // Note: positions are keyed by symbol, so destructure [sym, p]
    const portfolioVal = Object.entries(state.positions).reduce((sum, [sym, p]) => {
      const price = state.prices?.[sym] || 0;
      return sum + (p.quantity || 0) * price;
    }, 0) + (state.cash || 0);
    if (portfolioVal > 0) state.risk.portfolio_peak_value = portfolioVal;
    saveState(state);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Portfolio ───────────────────────────────────────────────────────────
app.get('/api/portfolio', (req, res) => {
  const state = loadState();
  const positions = Object.entries(state.positions)
    .filter(([symbol, pos]) => pos.quantity > 0 && !/^\d+$/.test(symbol))  // skip numeric phantom keys
    .map(([symbol, pos]) => {
      const currentPrice = state.prices?.[symbol] ?? null;
      // Use eToro's USD P&L when available — avoids GBX/pence → USD confusion for UK stocks
      const pnlUsd = pos.etoro_pnl_usd ?? null;
      const pnlPct = (currentPrice && pos.avg_cost)
        ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : null;
      // USD cost basis: use what bot invested, or back-calculate from eToro pnl + pct
      const investedUsd = pos.invested_usd
        ?? (pnlUsd != null && pnlPct ? pnlUsd / (pnlPct / 100) : null);
      const currentValueUsd = investedUsd != null ? investedUsd + pnlUsd : null;
      return { symbol, quantity: pos.quantity, avgCost: pos.avg_cost, currentPrice, pnl: pnlUsd, pnlPct, investedUsd, currentValueUsd };
    });
  res.json({ positions, cash: state.cash || 0 });
});

// ── API: Manual trade ────────────────────────────────────────────────────────
app.post('/api/trade', async (req, res) => {
  const { symbol, action, amount } = req.body;
  if (!symbol || !action || !amount) {
    return res.status(400).json({ error: 'symbol, action, amount zorunlu' });
  }
  try {
    const client = getEtoroClient();
    if (action === 'buy') {
      await client.buyAsset({ symbol, amount: Number(amount) });
    } else if (action === 'sell') {
      const state = loadState();
      const pos = state.positions[symbol];
      if (!pos) return res.status(400).json({ error: `${symbol} pozisyonu bulunamadı` });
      await client.sellPosition({ positionIds: pos.positionIds, instrumentId: pos.instrumentId });
    } else {
      return res.status(400).json({ error: 'action: buy veya sell olmalı' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: SSE Log stream ──────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send last 200 lines on connect
  if (fs.existsSync(BOT_LOG)) {
    const lines = fs.readFileSync(BOT_LOG, 'utf8').split('\n').filter(Boolean).slice(-200);
    for (const line of lines) res.write(`data: ${JSON.stringify(line)}\n\n`);
  }

  let lastSize = fs.existsSync(BOT_LOG) ? fs.statSync(BOT_LOG).size : 0;
  const interval = setInterval(() => {
    if (!fs.existsSync(BOT_LOG)) return;
    const size = fs.statSync(BOT_LOG).size;
    if (size > lastSize) {
      const fd = fs.openSync(BOT_LOG, 'r');
      const buf = Buffer.alloc(size - lastSize);
      fs.readSync(fd, buf, 0, size - lastSize, lastSize);
      fs.closeSync(fd);
      buf.toString('utf8').split('\n').filter(Boolean)
        .forEach(line => res.write(`data: ${JSON.stringify(line)}\n\n`));
      lastSize = size;
    }
  }, 1000);

  req.on('close', () => clearInterval(interval));
});

// ── API: Decision log ────────────────────────────────────────────────────────
app.get('/api/decisions', (req, res) => {
  const DECISIONS_FILE = path.join(LOG_DIR, 'decisions.jsonl');
  const limit = Math.min(parseInt(req.query.limit || '300', 10), 1000);
  if (!fs.existsSync(DECISIONS_FILE)) return res.json([]);
  const lines = fs.readFileSync(DECISIONS_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const records = lines.slice(-limit)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .reverse();
  res.json(records);
});

// ── API: Trade history ───────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  if (!fs.existsSync(TRADES_LOG)) return res.json([]);
  const trades = fs.readFileSync(TRADES_LOG, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    // Exclude ML data-lake records (type: 'entry'/'exit') — show only real trade actions
    .filter(r => r && (r.action === 'buy' || r.action === 'sell'))
    .reverse();
  res.json(trades);
});

// Start
if (require.main === module) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  app.listen(PORT, () => console.log(`[UI] Server listening on :${PORT}`));
}

module.exports = { app };
