# eToro Bot v3 — Momentum Institutional Architecture Design Spec

**Date:** 2026-06-08
**Status:** Approved

---

## Goal

Replace the DCA (dip-buying) strategy with a momentum-based institutional architecture. Core philosophy: **buy strength, not weakness**. The system waits for genuinely strong setups and stays out most of the time. Existing positions are closed manually before the new system goes live.

## Architecture

Approach B — clean replacement. `src/strategies/dca.js` is retired (kept but unused). New analysis modules added alongside existing infrastructure (state, config, portfolio, risk, market-hours). `src/index.js` decision loop rewritten.

**Phase 1 scope (this spec):** Layers 1–3 (Global Market State, Regime Engine, Relative Strength) + Layer 9 (Pyramiding entry) + Layer 10 (Exit Engine).

Layers 4–8, 11–14 are deferred to future phases.

## File Structure

```
src/analysis/market-state.js       CREATE  Layer 1: Global Market State scoring
src/analysis/relative-strength.js  CREATE  Layer 3: RS score per asset
src/strategies/momentum.js         CREATE  Layer 9: Pyramiding entry decisions
src/analysis/indicators.js         MODIFY  Add ADX + ATR calculations
src/analysis/regime.js             MODIFY  Layer 2: add ADX-based filtering
src/index.js                       MODIFY  Replace DCA loop with momentum loop
src/state.js                       MODIFY  Add pyramid tracking to DEFAULT_STATE
config.json                        MODIFY  Add momentum strategy parameters
tests/market-state.test.js         CREATE
tests/relative-strength.test.js    CREATE
tests/momentum.test.js             CREATE
```

`src/strategies/dca.js` — kept, not called.

---

## Layer 1: Global Market State (`src/analysis/market-state.js`)

### Data Sources (all via Yahoo Finance)

| Symbol | Represents |
|--------|-----------|
| SPY | S&P 500 ETF |
| QQQ | Nasdaq ETF |
| ^VIX | Volatility index |
| DX-Y.NYB | US Dollar index (DXY) |
| ^TNX | US 10-year treasury yield |
| BTC-USD | Bitcoin |

### Scoring (max 100 points)

| Indicator | Condition | Points |
|-----------|-----------|--------|
| SPY | Close > 50-day SMA | +20 |
| QQQ | Close > 50-day SMA | +15 |
| VIX | < 20 | +20 |
| VIX | 20–30 | +10 |
| VIX | > 30 | +0 |
| DXY | Close < 20-day SMA (weak dollar = risk-on) | +15 |
| US10Y | Current yield ≤ yield 30 days ago (stable/falling) | +15 |
| BTC | Bull regime (price > MA50 and MA50 > MA200) | +15 |

### State Thresholds

```
score ≥ 70  → RISK_ON
score ≥ 40  → RISK_NEUTRAL
score ≥ 20  → RISK_OFF
score < 20  → PANIC
```

### Rules Per State

```
RISK_ON      → normal operation
RISK_NEUTRAL → no new entries; hold existing positions
RISK_OFF     → no new entries; reduce existing positions by 50%
PANIC        → no new entries; close ALL positions immediately
```

### Cache Behavior

Recalculated once per hour. The bot runs every 10 minutes — each cycle checks `state.market_state.last_fetch`. If more than 60 minutes have passed, refetch and recalculate. Otherwise use cached state from `state.json`.

### Output saved to state.json

```json
{
  "market_state": {
    "state": "RISK_ON",
    "score": 82,
    "last_fetch": "2026-06-08T14:00:00.000Z"
  }
}
```

### Module interface

```js
// market-state.js exports:
async function fetchMarketStateData()  // fetches all 6 symbols from Yahoo Finance
function calcMarketStateScore(data)    // pure function, returns { state, score }
async function getMarketState(state)   // checks cache, fetches if stale, returns { state, score }
```

---

## Layer 2: Regime Engine (`src/analysis/regime.js` modified)

Per-asset filter using 90-day OHLCV history (already fetched each cycle).

### New indicators added to `src/analysis/indicators.js`

**ADX (Average Directional Index) — period 14:**
```
Measures trend strength, not direction.
ADX > 20 = trend present
ADX > 40 = strong trend
```

**ATR (Average True Range) — period 14:**
```
Measures volatility. Used for stop placement and pyramid triggers.
ATR = average of true ranges over last 14 candles
TrueRange = max(high-low, |high-prevClose|, |low-prevClose|)
```

### Regime output per asset

```js
function detectAssetRegimeV3(closes, highs, lows) {
  // returns { trend: 'BULL'|'BEAR'|'SIDEWAYS', adx: number, atr: number }
}
```

### Filter rule

Both conditions must be true to allow entry:
```
EMA50 > EMA200   (uptrend)
AND
ADX > 20         (trend has strength)
```

If either fails → `action: 'hold'`, reason: `"Regime filtresi: EMA/ADX koşulu sağlanmadı"`

---

## Layer 3: Relative Strength (`src/analysis/relative-strength.js`)

Compares asset's 20-day return against its benchmark. Measures whether the asset is outperforming its market.

### Benchmarks

| Asset type | Benchmark |
|-----------|-----------|
| US stocks (default) | SPY |
| UK stocks (symbol ends in `.L`) | `^FTSE` |
| Crypto (BTC, ETH, SOL, etc.) | `BTC-USD` |

### Calculation

```
raw_rs = asset_20day_return - benchmark_20day_return

// Normalize to 0–100:
// raw_rs = +5% → score ≈ 90
// raw_rs =  0% → score ≈ 50
// raw_rs = -5% → score ≈ 10
// Clamp: min 0, max 100
score = clamp(50 + (raw_rs * 8), 0, 100)
```

### Benchmark caching

SPY, ^FTSE, BTC-USD returns are fetched once per cycle and reused for all assets in that cycle. No extra API calls per asset.

### Filter rule

```
RS score ≥ 70 required for entry
```

If RS < 70 → `action: 'hold'`, reason: `"RS filtresi: ${score.toFixed(0)} < 70 (benchmark'ın gerisinde)"`

### Module interface

```js
function getExchangeBenchmark(symbol)          // returns 'SPY' | '^FTSE' | 'BTC-USD'
function calcRelativeStrength(assetReturn, benchmarkReturn)  // returns 0–100
async function fetchBenchmarkReturns(symbols)  // fetches 20-day returns for needed benchmarks
```

---

## Combined Entry Filter

All four conditions must pass before any buy action:

```
1. market_state.state === 'RISK_ON'
2. regime.trend === 'BULL'  (EMA50 > EMA200)
3. regime.adx > 20
4. relative_strength >= 70
```

If all pass → momentum.js evaluates pyramid entry.
If any fail → hold, log which filter failed.

---

## Layer 9: Pyramiding (`src/strategies/momentum.js`)

Replaces DCA. Builds positions in three tranches as price confirms the move.

### Entry logic

```
Level 0 → Level 1: all 4 filters pass + no current position
  buy: 40% of allocated budget
  set: entry_price = current_price
       stop_price  = current_price - (atr_stop_multiplier × ATR)
       pyramid_level = 1

Level 1 → Level 2: current_price > entry_price + 1×ATR
  buy: 30% of allocated budget
  update: stop_price = level2_price - (atr_stop_multiplier × ATR)
          pyramid_level = 2

Level 2 → Level 3: current_price > level2_price + 1×ATR
  buy: 30% of allocated budget
  update: stop_price = level3_price - (atr_stop_multiplier × ATR)
          pyramid_level = 3
```

`level2_price` and `level3_price` are stored in state per position.

### Budget allocation

Uses existing `allocateBudget()`. The tranche sizes (40/30/30) are applied to whatever budget that function returns.

### Config parameters

```json
"strategy": {
  "active": "momentum",
  "pyramid_sizes": [0.4, 0.3, 0.3],
  "atr_stop_multiplier": 2.0,
  "atr_period": 14,
  "adx_threshold": 20,
  "rs_threshold": 70,
  "min_global_state": "RISK_ON"
}
```

### Module interface

```js
function decideMomentum({ pyramidLevel, currentPrice, entryPrice, level2Price, atr, filters })
// returns { action: 'buy'|'sell'|'hold', tranche: 1|2|3|null, reason: string }
```

---

## Layer 10: Exit Engine (in `src/index.js`)

Four exit triggers, checked on every cycle for every open position:

### 1. ATR Stop (hard floor)
```
if current_price < position.stop_price → sell ALL
reason: `ATR stop tetiklendi ($${stop_price.toFixed(2)})`
```

### 2. Trend Break
```
if EMA50 < EMA200 → sell ALL
reason: `Trend kırıldı (EMA50 < EMA200)`
```

### 3. Market State Degradation
```
if market_state changed to RISK_OFF → sell 50% of position
if market_state changed to PANIC   → sell ALL
reason: `Market state: RISK_OFF → pozisyon küçültüldü`
```

State change detection: compare current state vs `state.market_state.previous_state`.

### 4. Emergency Exit (PANIC)
```
On every cycle: if market_state === 'PANIC' → sell ALL open positions
Overrides all other logic.
```

Exit triggers are checked **before** entry logic. If an exit fires, no pyramid evaluation happens for that symbol that cycle.

---

## State Schema Changes (`src/state.js`)

New fields added to each position:

```json
{
  "positions": {
    "NVDA": {
      "quantity": 2.5,
      "avg_cost": 450.0,
      "pyramid_level": 1,
      "entry_price": 440.0,
      "level2_price": null,
      "level3_price": null,
      "stop_price": 412.0,
      "atr_at_entry": 14.2
    }
  },
  "market_state": {
    "state": "RISK_ON",
    "score": 82,
    "last_fetch": "2026-06-08T14:00:00.000Z",
    "previous_state": "RISK_ON"
  }
}
```

`pyramid_level = 0` means no open position (same as before). Fields default to `null` for pre-existing positions without pyramid data.

---

## Config Changes

New fields in `config.json` under `strategy`:

```json
"strategy": {
  "active": "momentum",
  "check_interval_minutes": 10,
  "pyramid_sizes": [0.4, 0.3, 0.3],
  "atr_stop_multiplier": 2.0,
  "atr_period": 14,
  "adx_threshold": 20,
  "rs_threshold": 70,
  "min_global_state": "RISK_ON",
  "market_state_cache_minutes": 60
}
```

All thresholds configurable via UI Settings page (already exposed via `CONFIG_PUBLIC_FIELDS`).

---

## Cycle Flow (updated `src/index.js`)

```
1. Load config + state
2. Reset daily counters
3. Get market state (cache or fetch if stale)
   → If PANIC: emergency exit all, skip to save
4. Fetch portfolio + prices from eToro
5. Fetch OHLCV histories for all symbols
6. Fetch benchmark returns (SPY, ^FTSE, BTC-USD) once
7. For each symbol:
   a. Calc regime (EMA50/200, ADX, ATR)
   b. Calc relative strength score
   c. Check exit triggers (ATR stop, trend break, state degradation)
      → If exit fires: sell, skip to next symbol
   d. Check entry filters (RISK_ON + BULL + ADX>20 + RS≥70)
      → If any filter fails: hold, log reason
   e. Evaluate pyramid level → buy if applicable
8. Save state
9. Send Slack report
```

---

## Testing

Each new module has unit tests:

- `market-state.test.js`: score calculation for known inputs, state threshold boundaries, cache staleness logic
- `relative-strength.test.js`: RS score calculation, benchmark selection per asset type, edge cases (zero returns, extreme RS)
- `momentum.test.js`: pyramid level transitions, stop price calculation, all four exit triggers

Existing `market-hours.test.js` and indicator tests remain unchanged.

---

## Design Decisions

- **No ML scoring in Phase 1** — layers 12–14 require data accumulation from this system first
- **No breadth/event/correlation engines in Phase 1** — deferred to Phase 2
- **Cash management (Layer 11) deferred** — eToro doesn't support money market parking
- **ATR stop is hard** — no partial stop; full exit when triggered, prevents death-by-a-thousand-cuts
- **Benchmarks cached per cycle** — SPY/FTSE/BTC fetched once, reused for all assets in that cycle
- **Market state previous_state** — stored in state.json to detect degradation transitions, not just current state
