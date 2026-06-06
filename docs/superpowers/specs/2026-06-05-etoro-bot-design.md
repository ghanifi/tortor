# eToro Trading Bot — Design Spec
**Date:** 2026-06-05  
**Status:** Approved (v3 — final)

---

## Overview

A Node.js service that monitors an eToro portfolio and watchlist, automatically buying on dips and selling on gains. Decisions are driven by a layered signal stack: market regime context (macro + per-asset), technical indicators, DCA/gradual-exit strategy, AI visual edge filtering, and a risk engine. Runs 24/7 on Windows via PM2. Sends detailed Slack notifications every 10 minutes.

---

## Phased Roadmap

| Phase | Scope |
|-------|-------|
| **v1 (now)** | Full system: fallback chain, strategy engine, technical indicators, AI edge analysis, risk engine, market regime layer |
| **v2** | Portfolio correlation engine (sector exposure, correlation matrix, cluster limits) |
| **v3** | Execution optimization (slippage estimation, liquidity check, spread-aware sizing) |

---

## Architecture (v1)

```
etoro-bot/
├── src/
│   ├── index.js              # Entry point, scheduler
│   ├── config.js             # Config loader + password decryption
│   ├── etoro/
│   │   ├── client.js         # Fallback chain manager
│   │   ├── http.js           # Layer 1: HTTP API (cookie-based)
│   │   ├── dom.js            # Layer 2: Playwright DOM
│   │   └── playwright.js     # Layer 3: Full browser automation
│   ├── strategies/
│   │   ├── dca.js            # Default: DCA buy + gradual sell
│   │   ├── momentum.js       # Future
│   │   └── mean_reversion.js # Future
│   ├── analysis/
│   │   ├── indicators.js     # RSI, MACD, Bollinger Bands
│   │   ├── regime.js         # Market regime detection
│   │   ├── ai_chart.js       # AI visual analysis (edge cases only)
│   │   └── ai_budget.js      # AI API quota tracker
│   ├── risk.js               # Risk engine
│   ├── portfolio.js          # Position and balance tracking
│   └── slack.js              # Notification system
├── config.json
├── state.json
├── ecosystem.config.js       # PM2 config
└── package.json
```

---

## Decision Pipeline

Every 10-minute cycle runs each asset through this pipeline in order:

```
1. regime.js      → macro tone (bull/bear/sideways) + asset-specific tone
2. indicators.js  → RSI, MACD, Bollinger signal
3. strategies/    → preliminary action (buy/sell/hold) + portion
4. ai_chart.js    → override/confirm only if in edge zone AND budget available
5. risk.js        → validate: cooldown, exposure, drawdown, daily limit
6. client.js      → execute if approved
7. slack.js       → report
```

---

## Fallback Chain

**Layer 1 — HTTP API**
- Direct HTTP calls to eToro (reverse-engineered endpoints)
- Session cookies in `state.json`
- Fastest; fails when cookies expire or endpoints change

**Layer 2 — Playwright DOM**
- Headed Chrome, credential login, DOM read + button clicks
- Fails when DOM structure changes

**Layer 3 — Playwright Full Automation**
- Full retry logic, captures error screenshot, sends to Slack

**Transition:**
```
try HTTP → error/timeout →
try DOM  → error/timeout →
try Full Automation → error → Slack emergency + 30min wait
```

---

## Market Regime Layer (`regime.js`)

Two-tier detection. Macro sets the overall tone; asset-specific fine-tunes it.

### Macro Regime (shared across all assets)
Data sources (free APIs, fetched once per cycle):
- **S&P 500** (Yahoo Finance) — equity market tone
- **Bitcoin Dominance** (CoinGecko free API) — crypto market tone

Detection logic:
```
S&P 500 50-day MA vs 200-day MA:
  price > 200MA and 50MA > 200MA  →  bull
  price < 200MA                   →  bear
  otherwise                       →  sideways

BTC Dominance trend (7-day):
  rising dominance   →  crypto bear (alt selling)
  falling dominance  →  crypto bull
```

### Asset-Specific Regime
Calculated from the asset's own price history (last 30 days):
```
rolling_std_dev (14-day) / avg_price  →  volatility score
price vs own 50-day MA               →  trend direction
ATR (14)                             →  true range context
```

### Regime → Strategy Adjustment

| Macro | Asset | Effect |
|-------|-------|--------|
| Bull | Bull | Normal thresholds, full budget |
| Bull | Bear/Sideways | Tighten buy threshold by 2%, reduce budget 50% |
| Bear | Any | Tighten buy threshold by 3%, reduce budget 30%, skip watchlist buys |
| Sideways | Any | Widen thresholds by 1%, reduce AI calls (noise zone) |

Regime is logged in every Slack report and stored in `state.json`.

---

## Strategy Engine (Plugin-based)

Each strategy in `/strategies/` exports:
```js
export function decide(asset, indicators, regime, state) {
  // returns: { action: 'buy'|'sell'|'hold', portion: 0–1, reason: string }
}
```

### Default Strategy: DCA + Gradual Exit

**Asset-class thresholds (before regime adjustment):**
```
stocks:  buy -7%,  sell tranches at +7% / +10% / +13%
crypto:  buy -12%, sell tranches at +10% / +15% / +20%
```

**Buy (DCA):**
```
change <= buy_threshold  →  BUY
  new_avg_cost = weighted average (old + new position)
```

**Sell (3 tranches):**
```
change >= sell_1  →  SELL 25% of position
change >= sell_2  →  SELL 50% of remaining
change >= sell_3  →  SELL 100% of remaining
```

**Edge zone (±2% of any threshold):**
```
→ request AI visual analysis if budget allows
→ AI result: weighted signal (not sole decider)
```

---

## Technical Indicators (`indicators.js`)

| Indicator | Role |
|-----------|------|
| RSI (14) | Overbought/oversold confirmation |
| MACD | Trend direction confirmation |
| Bollinger Bands | Volatility context, band position |
| ATR (14) | Volatility magnitude (fed to regime layer) |

Indicators are **confirmation filters**, not primary triggers:
- Price at buy threshold + RSI < 35 → stronger buy signal
- Price at buy threshold + RSI > 55 → hold, wait for clearer signal

---

## AI Visual Chart Analysis (`ai_chart.js`)

Activated only when:
1. Asset is in edge zone (within 2% of a threshold)
2. AI daily call limit not exceeded
3. AI monthly budget not exceeded

Process:
1. Playwright screenshots eToro chart for the asset
2. Screenshot + context sent to `claude-haiku-4-5` (cheapest capable model)
3. Prompt: *"Chart for [ASSET]. Change from avg cost: [X]%. RSI=[Y], MACD=[Z], Regime=[R]. Buy, sell, or hold? Be concise."*
4. Response parsed as contributing signal (not override)

### AI Budget Management (`ai_budget.js`)

Tracked in `state.json`:
```json
"ai_usage": {
  "daily_calls": 12,
  "daily_limit": 20,
  "monthly_cost_usd": 1.45,
  "monthly_budget_usd": 10.00,
  "last_reset": "2026-06-01"
}
```

Rules:
- `daily_calls >= daily_limit` → skip AI, note in Slack
- `monthly_cost >= budget * 0.9` → Slack warning + reduce daily limit by 50%
- `monthly_cost >= budget` → AI disabled until next month, Slack alert

---

## Risk Engine (`risk.js`)

Every trade must pass all checks before execution:

| Rule | Default | Config key |
|------|---------|------------|
| Per-asset cooldown | 2 hours | `cooldown_hours` |
| Max daily trades | 10 | `max_daily_trades` |
| Max exposure per asset | 30% of portfolio | `max_exposure_pct` |
| Drawdown stop | Pause all buys if portfolio down >20% from peak | `drawdown_stop_pct` |
| Cash reserve | Never trade below this | `min_cash_reserve` |

Blocked trades are logged and reported in Slack with reason.

---

## Budget Allocation

```
Per-asset limit set in config  →  use that limit
No limit set                   →  remaining_cash / count_of_unlimited_assets
```

Regime adjustments (e.g. "reduce budget 50% in bear") apply on top of this calculation.

---

## Configuration (`config.json`)

```json
{
  "etoro": {
    "username": "guvenbas@gmail.com",
    "password": "encrypted:xxxxx"
  },
  "slack": {
    "webhook_url": "https://hooks.slack.com/..."
  },
  "ai": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5-20251001",
    "daily_call_limit": 20,
    "monthly_budget_usd": 10.00
  },
  "strategy": {
    "active": "dca",
    "check_interval_minutes": 10,
    "cooldown_hours": 2,
    "max_daily_trades": 10,
    "drawdown_stop_pct": 20,
    "asset_classes": {
      "BTC": "crypto",
      "ETH": "crypto"
    }
  },
  "thresholds": {
    "stocks": { "buy": -7, "sell": [7, 10, 13] },
    "crypto": { "buy": -12, "sell": [10, 15, 20] }
  },
  "budget": {
    "default": "equal_split",
    "per_asset": {
      "TSLA": 500,
      "BTC": 1000
    }
  },
  "watchlist": ["TSLA", "AAPL", "BTC", "NVDA", "AMZN"],
  "safety": {
    "min_cash_reserve": 100,
    "max_exposure_pct": 30,
    "dry_run": true
  }
}
```

`dry_run: true` is the **default** — must be explicitly set to `false` for live trading.

---

## State (`state.json`)

```json
{
  "session": {
    "cookies": [...],
    "expires_at": "2026-06-06T10:00:00Z"
  },
  "positions": {
    "TSLA": { "avg_cost": 275.00, "quantity": 2, "last_trade_at": "2026-06-05T10:00:00Z" },
    "BTC":  { "avg_cost": 60000, "quantity": 0.05, "last_trade_at": "2026-06-05T08:30:00Z" }
  },
  "regime": {
    "macro_equity": "bull",
    "macro_crypto": "bear",
    "updated_at": "2026-06-05T14:30:00Z"
  },
  "risk": {
    "portfolio_peak_value": 5420.00,
    "daily_trades_today": 3,
    "trades_paused": false
  },
  "ai_usage": {
    "daily_calls": 12,
    "daily_limit": 20,
    "monthly_cost_usd": 1.45,
    "monthly_budget_usd": 10.00,
    "last_reset": "2026-06-01"
  },
  "last_check": "2026-06-05T14:30:00Z",
  "active_layer": 1
}
```

---

## Slack Notifications

### 10-minute check report
```
🤖 eToro Bot — 14:30 Kontrol

📡 Bağlantı: HTTP API (Katman 1)
🌍 Regime: Makro=Bull/CryptoBear | S&P +0.3% | BTC Dom +1.2%
💰 Nakit: $1,240.50 | Portföy: $5,380.00
🤖 AI: 12/20 günlük | $1.45/$10.00 aylık
⚠️ Risk: Normal | Peak'den: -0.7% | Günlük işlem: 3/10

📊 Snapshot:
  TSLA  $248.30  avg $275.00  -9.7%  ⏳ bekle (eşik -9%, regime: bull, RSI:31)
  AAPL  $195.10  avg $178.00  +9.6%  ✅ 25% satıldı (1. tranche)
  BTC   $67,200  avg $60,000  +12%   🔍 edge zone → AI bekleniyor
  NVDA  $890.00  avg $980.00  -8.9%  🚫 cooldown (47dk kaldı)

📈 Toplam P&L: +$87.20 (+1.6%)
```

### Trade executed
```
🟢 ALIM — TSLA (DCA)
   Fiyat: $248 | $100 harcandı | RSI:28 ✓ | Regime: bull ✓
   Yeni avg: $261.50 | Kalan nakit: $1,140.50

🔴 SATIM — AAPL (Tranche 1/3 — %25)
   Fiyat: $195 | AI sinyal: "resistance zone, partial exit recommended"
   Kâr bu tranche: +$42.75 | Kalan: %75 pozisyon
```

### Risk block
```
🚫 BLOKE — NVDA alımı engellendi
   Neden: Cooldown aktif (47dk kaldı)
   Sinyal: DCA buy | Fiyat: $875
```

### AI budget warning
```
⚠️ AI BÜTÇE — %91 doldu ($9.10/$10.00)
   AI analiz devre dışı → sadece teknik indikatörler aktif
```

### Error
```
🚨 HATA — Tüm katmanlar başarısız
   Son başarılı: 2 saat önce | [screenshot.png]
   30 dk sonra tekrar denenecek
```

---

## Tech Stack

| Component | Choice |
|-----------|--------|
| Runtime | Node.js 20+ |
| Browser automation | Playwright |
| HTTP client | axios |
| Scheduler | node-cron |
| Process manager | PM2 |
| Technical indicators | technicalindicators (npm) |
| Market data | Yahoo Finance (yfinance-api) + CoinGecko free API |
| AI visual analysis | Anthropic SDK — claude-haiku-4-5 |
| Notifications | Slack Incoming Webhooks |
| Config encryption | Node.js crypto (AES-256) |

---

## Deployment (Windows)

- PM2: `pm2 start ecosystem.config.js`
- Auto-start on reboot: `pm2 startup` + `pm2 save`
- Chromium bundled via Playwright (no separate install)
- Logs: `~/.pm2/logs/` with rotation

---

## Rollout Plan

1. **Phase 1 — Paper trading:** `dry_run: true`, validate signals + Slack output, no real money
2. **Phase 2 — Live single asset:** 1 asset, small budget ($100 limit), monitor closely
3. **Phase 3 — Full production:** All watchlist, full config
4. **v2:** Portfolio correlation engine
5. **v3:** Execution optimization layer
