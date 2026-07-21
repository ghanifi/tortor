# Never sell at a loss (except PANIC)

## Background

The bot's automated exit logic (`src/strategies/momentum.js:checkExitTrigger`)
currently has three mechanisms that can close a position below its average
cost (a realized loss):

1. **Max-loss backstop** (Trigger 0) — hard exit if loss exceeds `max_loss_pct`
   (default 30%).
2. **ATR trailing stop** (Trigger 1) — hard exit whenever price falls below
   the trailing stop, "regardless of profit/loss" (existing code comment).
   The stop starts below `avg_cost` at entry and only locks to breakeven once
   price has risen above `avg_cost`.
3. **Trend break / RISK_OFF** (Triggers 2–3) — soft exits tied to regime
   deterioration, which can fire while a position is underwater.

This is intentional: on 2026-06-12 the bot briefly ran a "never sell at a
loss" rule, and on 2026-06-24 that rule was reversed (commit `1972d79`) after
a position (TRX) kept falling with no exit available, producing an outsized
loss. The max-loss backstop, ATR stop, and a loss-cooldown were added
specifically to prevent a repeat.

The user has now explicitly asked to reinstate "never sell at a loss, no
exceptions except PANIC" — fully aware of, and accepting, the risk that this
reopens the exact failure mode the 2026-06-24 fix addressed. This spec
implements that request as stated.

## Change

### `src/strategies/momentum.js`

- Remove Trigger 0 (max-loss backstop) entirely, along with the `maxLossPct`
  parameter. By definition it only ever fires on a loss, so it is dead code
  under the new rule.
- Add a single shared guard: `wouldRealizeLoss = pos.avg_cost != null && currentPrice < pos.avg_cost`.
- Apply the guard to Triggers 1–3 (ATR stop, trend break, RISK_OFF): if the
  trigger's condition is met but `wouldRealizeLoss` is true, return
  `{ exit: false, _skipped: '<reason> but loss-protection active (price $X < avg cost $Y)' }`
  instead of exiting. The position is held and logged, same pattern already
  used for the min-hold-period skip.
- PANIC (checked first, before any of the above) is unaffected — still a
  hard, unconditional full close.
- Profitable/breakeven closes are unaffected: if `currentPrice >= pos.avg_cost`,
  all triggers behave exactly as before.

### `src/index.js`

- Remove the `maxLossPct` config read (`config.strategy?.max_loss_pct`) and
  its pass-through into `checkExitTrigger(...)`.

### `config.json` / `config.example.json`

- Remove the now-unused `max_loss_pct` key.

### `tests/momentum.test.js`

- Update the existing test titled *"ATR stop fires even when below avg_cost
  (no zararda override)"* — this codified the exact behavior being reversed.
  Replace it with a test asserting the ATR stop is **skipped** when it would
  realize a loss.
- Remove/replace any max-loss-backstop-specific tests (Trigger 0).
- Add coverage for: trend-break skipped at a loss, RISK_OFF skipped at a
  loss, and PANIC still firing at a loss (unconditional override).

## Out of scope

- Manual/dashboard-triggered sells are untouched — this rule only governs
  the bot's automated `checkExitTrigger` decision path.
- `loss_cooldown_hours` bookkeeping (recorded after a negative full exit) is
  left as-is; it can still apply to a PANIC-triggered loss exit.
- Crypto partial profit-taking is unaffected — it already only fires when
  `currentPrice > pos.avg_cost`.
