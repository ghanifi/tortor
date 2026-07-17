# Dashboard: Total P&L shows all-time realized P&L

## Problem

The dashboard's "Total P&L" stat currently shows only the unrealized P&L of the
single open position (e.g. `$-2.00, -45.5%`). It ignores every past closed
trade, so it doesn't answer "how much have I actually made or lost overall."

## Change

`src/ui/public/pages/dashboard.js`:

1. Fetch `/api/history` alongside the existing `/api/state` and `/api/config`
   calls (parallel `Promise.all`, refreshed on the existing 30s timer).
2. **Total P&L** card: compute realized P&L the same way `history.js` does —
   `trades.filter(t => t.action === 'sell').reduce((s,t) => s + (t.pnl||0), 0)`.
   Display this dollar value (green/red by sign). Drop the percentage line
   under it — there's no single meaningful basis for a realized-only %.
3. **Portfolio** card: keep the existing per-position unrealized P&L
   calculation (currently named `totalPnl` in the render loop), but move its
   output into a small muted sub-line under the Portfolio card, e.g.
   `unrealized: $X` (green/red), shown only when there's at least one open
   position with P&L data. Not shown when there are no open positions.
4. `portfolioVal`, `totalCost`-derived `totalVal`, and the drawdown
   calculation are unaffected — they still use the position-loop values as
   today.

## Out of scope

- No backend/API changes — `/api/history` already returns all buy/sell
  records (`src/ui/server.js:252`).
- No changes to `history.js`'s own "Realized P&L" stat card (same formula,
  different page — left as-is).
