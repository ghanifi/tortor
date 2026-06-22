// src/index.js
const cron = require('node-cron');
const { loadConfig } = require('./config');
const { loadState, saveState } = require('./state');
const EToroClient = require('./etoro/client');
const { fetchSymbolPrices, fetchSymbolHistories, detectAssetRegimeV3 } = require('./analysis/regime');
const { getMarketState } = require('./analysis/market-state');
const { calcRelativeStrength, fetchBenchmarkReturns, getExchangeBenchmark } = require('./analysis/relative-strength');
const { decideMomentum, checkExitTrigger } = require('./strategies/momentum');
const { calcTechnicalScore } = require('./analysis/technical-score');
const { checkCorrelation } = require('./analysis/correlation');
const { check, updateAfterTrade, checkDrawdown, resetDailyCounters } = require('./risk');
const { calcPnL, calcTotalPortfolioValue, allocateBudget, calcPositionBudget } = require('./portfolio');
const { logEntry, logExit } = require('./analysis/data-lake');
const { checkEarningsBlock } = require('./analysis/event-engine');
const { getBreadthState } = require('./analysis/breadth');
const { auditTrade, queryExitDirection } = require('./analysis/ai-auditor');
const { canCallAI, recordCall } = require('./analysis/ai_budget');
const { logDecision } = require('./analysis/decision-logger');
const { calcFinalScore, scoreToTier } = require('./analysis/final-score');
const SlackNotifier = require('./slack');
const { isMarketOpen } = require('./market-hours');
const { runCryptoScan } = require('./analysis/crypto-scanner');
const { logSpreads } = require('./analysis/spread-logger');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');

let config = null;
let slack = null;
let etoroClient = null;
let isRunning = false;
let consecutiveErrors = 0;        // suppress repeated Slack alerts on persistent outage
const ERROR_SLACK_INTERVAL = 3;   // alert every Nth failure, not every cycle

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcNewAvgCost(existingQty, existingAvg, newQty, newPrice) {
  const total = existingQty + newQty;
  if (total === 0) return newPrice;
  return ((existingQty * (existingAvg || newPrice)) + (newQty * newPrice)) / total;
}

async function executeSell({ symbol, pos, portion, reason, currentPrice, state, marketState }) {
  const sellQty = (pos.quantity || 0) * portion;
  const proceeds = sellQty * currentPrice;
  const pnlThisSell = sellQty * (currentPrice - (pos.avg_cost || currentPrice));

  try {
    if (!config.safety?.dry_run) {
      await etoroClient.sellPosition({
        positionIds: pos.positionIds,
        positionId: pos.positionId,
        instrumentId: pos.instrumentId,
      });
    }

    if (portion >= 1) {
      // Full exit: reset all pyramid state
      state.positions[symbol] = {
        ...pos,
        quantity: 0,
        avg_cost: null,
        pyramid_level: 0,
        entry_price: null,
        level2_price: null,
        level3_price: null,
        stop_price: null,
        atr_at_entry: null,
      };
    } else {
      // Partial exit: reduce quantity and step down pyramid level
      state.positions[symbol].quantity = (pos.quantity || 0) - sellQty;
      const currentLevel = pos.pyramid_level || 0;
      if (currentLevel > 0) {
        state.positions[symbol].pyramid_level = currentLevel - 1;
      }
    }

    state = updateAfterTrade(state, symbol);

    await slack.send(slack.formatTrade({
      action: 'sell', symbol, price: currentPrice,
      pnl: pnlThisSell, cashRemaining: (state.cash || 0) + proceeds,
      tranche: `${(portion * 100).toFixed(0)}%`, reason
    }));

    const tradeEntry = JSON.stringify({
      ts: new Date().toISOString(), symbol, action: 'sell',
      amount: proceeds, price: currentPrice,
      pnl: Number(pnlThisSell.toFixed(2)), reason
    });
    fs.appendFileSync(path.join(LOG_DIR, 'trades.jsonl'), tradeEntry + '\n');

    const pnlPct = pos.avg_cost ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : 0;
    logExit({ symbol, price: currentPrice, qty: sellQty, proceeds, pnl: pnlThisSell, pnlPct, reason, marketState: marketState || null });

    if (config.safety?.dry_run) {
      console.log(`[DRY RUN] SELL ${symbol} ${(portion * 100).toFixed(0)}%: ${reason}`);
    }
  } catch (err) {
    console.error(`[Trade] Sell ${symbol} failed:`, err.message);
  }

  return state;
}

async function executeBuy({ symbol, pos, tranche, reason, currentPrice, atr, state, scores, strongBuy, portfolioValue, isCryptoScanner, isDCA }) {
  const sizes           = config.strategy?.pyramid_sizes        || [0.4, 0.3, 0.3];
  const baseSize        = sizes[tranche - 1]                    || 0.33;
  // Strong Buy: L1 tranche gets 25% larger (capped at 0.6)
  const trancheSize     = (strongBuy && tranche === 1)
    ? Math.min(0.6, baseSize * 1.25)
    : baseSize;
  const atrMult         = config.strategy?.atr_stop_multiplier  || 2.0;
  const riskPerTradePct = config.strategy?.risk_per_trade_pct   ?? 0.75;
  const minReserve      = config.safety?.min_cash_reserve       || 0;

  let budget = calcPositionBudget({
    totalAccountValue: (state.cash || 0) + portfolioValue,
    currentPrice,
    atr:               atr || 0,
    atrStopMultiplier: atrMult,
    riskPerTradePct,
    trancheSize,
    availableCash:     state.cash || 0,
    minCashReserve:    minReserve,
  });

  // For crypto scanner entries, apply a fixed minimum budget if ATR sizing produced less.
  // This ensures trades happen even when daily ATR is large relative to account size.
  if (isCryptoScanner && config.crypto_scanner?.budget_per_trade > 0) {
    const spendable = Math.max(0, (state.cash || 0) - minReserve);
    const fixedBudget = Math.min(config.crypto_scanner.budget_per_trade, spendable);
    if (fixedBudget > budget) {
      console.log(`[Trade] ${symbol}: ATR budget $${budget.toFixed(2)} → crypto fixed $${fixedBudget.toFixed(2)}`);
      budget = fixedBudget;
    }
  }

  if (budget <= 0) {
    console.log(`[Trade] [ERROR] BUY ${symbol} L${tranche} FAILED — budget=0 (cash=$${(state.cash||0).toFixed(2)}, reserve=$${minReserve}, ATR=${atr?.toFixed(2) ?? 'N/A'})`);
    return { state, success: false, failReason: `Insufficient budget (cash=$${(state.cash||0).toFixed(2)}, reserve=$${minReserve}, ATR=${atr?.toFixed(2) ?? 'N/A'})` };
  }

  const qty = budget / currentPrice;

  try {
    if (!config.safety?.dry_run) {
      await etoroClient.buyAsset({ symbol, amount: budget });
    }

    const newAvg = calcNewAvgCost(pos.quantity || 0, pos.avg_cost || currentPrice, qty, currentPrice);

    if (isDCA) {
      // DCA buy: add to existing position — don't change pyramid level,
      // only update quantity, avg cost and dca_count.
      // Stop is also updated to the new lower avg cost.
      const newStop = atr ? newAvg - atrMult * atr : (pos.stop_price ?? null);
      state.positions[symbol] = {
        ...pos,
        quantity:  (pos.quantity || 0) + qty,
        avg_cost:  newAvg,
        dca_count: (pos.dca_count || 0) + 1,
        stop_price: newStop,
        profit_take_1_done: false,  // price dropped → new avg_cost → reset PT
        profit_take_2_done: false,
      };
    } else if (tranche === 1) {
      state.positions[symbol] = {
        ...pos,
        quantity: (pos.quantity || 0) + qty,
        avg_cost: newAvg,
        pyramid_level: 1,
        entry_price: currentPrice,
        level2_price: null,
        level3_price: null,
        stop_price: currentPrice - atrMult * atr,
        atr_at_entry: atr,
        entry_at: new Date().toISOString(),
        invested_usd: budget,
        dca_count: 0,
        profit_take_1_done: false,
        profit_take_2_done: false,
      };
    } else if (tranche === 2) {
      state.positions[symbol] = {
        ...pos,
        quantity: (pos.quantity || 0) + qty,
        avg_cost: newAvg,
        pyramid_level: 2,
        level2_price: currentPrice,
        stop_price: currentPrice - atrMult * atr,
      };
    } else if (tranche === 3) {
      state.positions[symbol] = {
        ...pos,
        quantity: (pos.quantity || 0) + qty,
        avg_cost: newAvg,
        pyramid_level: 3,
        level3_price: currentPrice,
        stop_price: currentPrice - atrMult * atr,
      };
    }

    state = updateAfterTrade(state, symbol);
    state.cash = Math.max(0, (state.cash || 0) - budget);

    await slack.send(slack.formatTrade({
      action: 'buy', symbol, price: currentPrice, amount: budget,
      newAvg, cashRemaining: state.cash, reason
    }));

    const tradeEntry = JSON.stringify({
      ts: new Date().toISOString(), symbol, action: 'buy',
      amount: budget, price: currentPrice, reason
    });
    fs.appendFileSync(path.join(LOG_DIR, 'trades.jsonl'), tradeEntry + '\n');

    logEntry({ symbol, tranche, price: currentPrice, qty, amount: budget,
      stopPrice: state.positions[symbol]?.stop_price ?? null,
      reason, scores: scores || {} });

    console.log(`[Trade] BUY ${symbol} L${tranche} $${budget.toFixed(2)} @ $${currentPrice.toFixed(2)}${config.safety?.dry_run ? ' [DRY RUN]' : ''}`);
    return { state, success: true, failReason: null };
  } catch (err) {
    console.log(`[Trade] [ERROR] BUY ${symbol} L${tranche} FAILED — ${err.message}`);
    return { state, success: false, failReason: `eToro API error: ${err.message}` };
  }
}

// ── Main cycle ────────────────────────────────────────────────────────────────

async function runCycle() {
  if (isRunning) { console.log('[Bot] Previous cycle still running, skipping.'); return; }
  isRunning = true;
  console.log(`[Bot] Cycle start: ${new Date().toISOString()}`);

  config = loadConfig();
  let state = loadState();
  state = resetDailyCounters(state);

  // Sync AI budget limits from config (so UI/config changes take effect immediately)
  if (!state.ai_usage) state.ai_usage = {};
  state.ai_usage.daily_limit      = config.ai?.daily_call_limit   ?? 200;
  state.ai_usage.monthly_budget_usd = config.ai?.monthly_budget_usd ?? 10;

  try {
    // 3. Get market state (cached or fresh)
    const prevMarketState = state.market_state?.state || null;
    let currentMarketState = 'RISK_NEUTRAL';
    let marketScore = 0;

    try {
      const ms = await getMarketState(state);
      currentMarketState = ms.state;
      marketScore = ms.score;
      state.market_state = {
        state: currentMarketState,
        score: marketScore,
        last_fetch: ms.last_fetch || state.market_state?.last_fetch || new Date().toISOString(),
        previous_state: prevMarketState,
      };
      console.log(`[MarketState] ${currentMarketState} (score ${marketScore})`);
    } catch (err) {
      console.warn('[MarketState] Fetch failed, using cached:', err.message);
      currentMarketState = state.market_state?.state || 'RISK_NEUTRAL';
    }

    // 3b. Get breadth state (Layer 4, cached)
    let breadthCount = 0;
    let breadthState = 'NARROW';
    try {
      const breadth = await getBreadthState(state);
      breadthCount = breadth.count ?? 0;
      breadthState = breadth.state;
      state.breadth_state = {
        score: breadth.score, count: breadth.count, total: breadth.total,
        state: breadth.state, last_fetch: breadth.last_fetch,
      };
      console.log(`[Breadth] ${breadthState}: ${breadthCount}/${breadth.total ?? 11} sectors above MA50`);
    } catch (err) {
      console.warn('[Breadth] Fetch failed, skipping breadth filter:', err.message);
    }

    // Emergency exit: PANIC — close everything now, skip rest of cycle
    if (currentMarketState === 'PANIC') {
      console.log('[Bot] PANIC state — emergency exit all positions');
      const openSymbols = Object.entries(state.positions)
        .filter(([, p]) => (p.quantity || 0) > 0)
        .map(([sym]) => sym);

      const prices = {};
      if (openSymbols.length) {
        const p = await fetchSymbolPrices(openSymbols).catch(() => ({}));
        Object.assign(prices, p);
      }

      for (const sym of openSymbols) {
        const pos = state.positions[sym];
        const price = prices[sym] || pos.avg_cost || 0;
        if (price > 0) {
          state = await executeSell({ symbol: sym, pos, portion: 1, reason: 'Market state: PANIC — emergency exit', currentPrice: price, state, marketState: 'PANIC' });
        } else {
          console.error(`[PANIC] ${sym} could not be sold — no price data, manual action required`);
          try {
            await slack.send(`⚠️ PANIC: ${sym} auto-exit FAILED — no price data, manual trade required`);
          } catch (slackErr) {
            console.error('[PANIC] Slack alert failed:', slackErr.message);
          }
        }
      }

      state.last_check = new Date().toISOString();
      saveState(state);
      isRunning = false;
      return;
    }

    // 4. Fetch portfolio + prices from eToro
    let portfolioData = null;
    try {
      portfolioData = await etoroClient.getPortfolioPositions();
      consecutiveErrors = 0; // reset on success
    } catch (err) {
      consecutiveErrors++;
      // Alert on first failure, then every ERROR_SLACK_INTERVAL cycles to avoid spam
      if (consecutiveErrors === 1 || consecutiveErrors % ERROR_SLACK_INTERVAL === 0) {
        const intervalMin = config.strategy?.check_interval_minutes || 10;
        await slack.send(slack.formatError({
          message: err.message,
          lastSuccess: state.last_check,
          retryIn: intervalMin,
          attempt: consecutiveErrors,
        }));
      }
      console.error(`[Bot] eToro API error (attempt ${consecutiveErrors}):`, err.message);
      saveState(state);
      isRunning = false;
      return;
    }

    const prices = {};
    const rawPositions = portfolioData?.positions || [];
    let cash = portfolioData?.cash || 0;

    // Build instrumentId → real symbol map from existing state (non-numeric keys only)
    const idToSymbol = {};
    for (const [k, v] of Object.entries(state.positions)) {
      if (!/^\d+$/.test(k) && v.instrumentId) idToSymbol[v.instrumentId] = k;
    }

    for (const p of rawPositions) {
      let sym = p.symbol;
      if (!sym) continue;

      // If eToro returned a numeric ID instead of a symbol (discover lookup failed),
      // check if we already know the real symbol for this instrumentId
      if (/^\d+$/.test(sym) && p.instrumentId && idToSymbol[p.instrumentId]) {
        const realSym = idToSymbol[p.instrumentId];
        console.log(`[Portfolio] ${sym} → ${realSym} (instrumentId ${p.instrumentId} matched)`);
        // Merge numeric-keyed entry into the real symbol entry and delete the stale key
        if (state.positions[sym]) {
          const numericEntry = state.positions[sym];
          state.positions[realSym] = { ...numericEntry, ...state.positions[realSym] };
          delete state.positions[sym];
        }
        sym = realSym;
      }

      if (p.currentPrice) prices[sym] = p.currentPrice;
      const existingSource = state.positions[sym]?.source;
      if (!state.positions[sym]) state.positions[sym] = {};
      state.positions[sym].quantity    = p.units || 0;
      state.positions[sym].positionIds = p.positionIds;
      state.positions[sym].instrumentId = p.instrumentId;
      if (p.pnlUsd != null) state.positions[sym].etoro_pnl_usd = p.pnlUsd;
      if (!state.positions[sym].avg_cost && p.avgCost) {
        state.positions[sym].avg_cost = p.avgCost;
        // Stop was likely initialized from current price (avg_cost was null then).
        // If avg_cost is now set and is far above the existing stop, reset stop
        // so it gets recalculated correctly from avg_cost in the exit section.
        const existingStop = state.positions[sym].stop_price;
        if (existingStop != null && p.avgCost > existingStop * 1.5) {
          state.positions[sym].stop_price = null;
          console.log(`[Portfolio] ${sym}: stop_price $${existingStop.toFixed(4)} reset — avg_cost $${p.avgCost.toFixed(4)} much higher, will recalculate`);
        }
      }
      // Ensure entry_at is always set — min_hold protection fails silently if null
      // (null → holdMs=Infinity → "held forever" → min_hold bypassed)
      if (!state.positions[sym].entry_at) {
        state.positions[sym].entry_at = new Date().toISOString();
      }
      if (existingSource) state.positions[sym].source = existingSource;

      // Register new non-numeric symbol in map for subsequent iterations
      if (!/^\d+$/.test(sym) && p.instrumentId) idToSymbol[p.instrumentId] = sym;
    }

    // Clean up any remaining numeric-keyed orphans whose instrumentId now maps to a real symbol
    for (const k of Object.keys(state.positions)) {
      if (/^\d+$/.test(k)) {
        const instrId = state.positions[k]?.instrumentId;
        if (instrId && idToSymbol[instrId]) {
          console.log(`[Portfolio] Orphan key "${k}" removed (duplicate of ${idToSymbol[instrId]})`);
          delete state.positions[k];
        }
      }
    }

    const configCash = config.budget?.available_cash ?? 0;
    if (cash === 0 && configCash > 0) { cash = configCash; }
    state.cash = cash;

    // ── Crypto Scan Pass ─────────────────────────────────────────────────────
    let cryptoCandidates = {}; // symbol → CandidateResult
    if (config.crypto_scanner?.enabled !== false) {
      try {
        const scanResults = await runCryptoScan(config.crypto_scanner || {}, state, saveState);
        for (const c of scanResults) cryptoCandidates[c.symbol] = c;
        if (scanResults.length === 0) {
          console.log(`[CryptoScanner] No candidates — BTC EMA gate, trend or score filter`);
        }
      } catch (err) {
        console.warn('[CryptoScanner] Scan error, skipping:', err.message);
      }
    }

    const allSymbols = [...new Set([
      ...Object.keys(state.positions),
      ...(config.watchlist || []),
      ...Object.keys(cryptoCandidates),
    ])];

    // Phase 1: spread log (every cycle; errors are silent, strategy unaffected)
    logSpreads(allSymbols).catch(() => {});

    // Fetch missing prices from Yahoo
    const missingPriceSymbols = allSymbols.filter(s => !prices[s]);
    if (missingPriceSymbols.length) {
      const yPrices = await fetchSymbolPrices(missingPriceSymbols).catch(() => ({}));
      Object.assign(prices, yPrices);
    }
    state.prices = prices;

    // Portfolio value + drawdown
    const portfolioValue = calcTotalPortfolioValue(state.positions, prices, cash);
    state = checkDrawdown(state, portfolioValue);

    // 5. Fetch OHLCV histories (1 year — needed for EMA200)
    let historyMap = {};
    try {
      historyMap = await fetchSymbolHistories(allSymbols, '1y');
      console.log(`[History] Fetched 1y for: ${Object.keys(historyMap).join(', ')}`);
    } catch (err) {
      console.warn('[History] Batch fetch failed:', err.message);
    }

    // 6. Fetch benchmark returns once for all symbols in this cycle
    const neededBenchmarks = new Set(allSymbols.map(s => getExchangeBenchmark(s)));
    let benchmarkReturns = {};
    try {
      benchmarkReturns = await fetchBenchmarkReturns([...neededBenchmarks]);
    } catch (err) {
      console.warn('[RS] Benchmark fetch failed:', err.message);
    }

    // 7. Per-symbol decision loop (two-pass: exits first, then buys ranked by RS score)
    const cycleTs = new Date().toISOString();
    const assetReports = [];
    const buyCandidates = [];
    let totalPnl = 0;

    // Pass 1: compute indicators, execute exits, collect buy candidates
    for (const symbol of allSymbols) {
      let pos = state.positions[symbol] || { avg_cost: null, quantity: 0 };
      const currentPrice = prices[symbol] || 0;
      if (!currentPrice) continue;

      const pnl = (pos.quantity || 0) > 0 ? calcPnL(pos.quantity, pos.avg_cost || currentPrice, currentPrice) : 0;
      totalPnl += pnl;
      const changePct = (pos.quantity || 0) > 0 && pos.avg_cost ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : null;

      const hist = historyMap[symbol];
      if (!hist || hist.closes.length < 14) {
        assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason: 'Yeterli tarihsel veri yok' });
        continue;
      }

      // a. Asset regime
      const assetRegime = detectAssetRegimeV3(hist.closes, hist.highs, hist.lows);

      // b. Relative strength — dual-window: 20-day (60%) + 63-day (40%)
      // Prevents a short-term bounce in a multi-month downtrend from looking like momentum
      let rsScore = null;
      if (hist.closes.length >= 21) {
        const closes = hist.closes;
        const ret20 = ((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100;
        const ret63 = closes.length >= 64
          ? ((closes[closes.length - 1] - closes[closes.length - 64]) / closes[closes.length - 64]) * 100
          : ret20;
        const assetReturn = ret20 * 0.6 + ret63 * 0.4;
        const bench = getExchangeBenchmark(symbol);
        const benchReturn = benchmarkReturns[bench] ?? 0;
        rsScore = calcRelativeStrength(assetReturn, benchReturn);
      }

      // b2. Technical score (Layer 6)
      const techResult = calcTechnicalScore(hist.closes, hist.highs, hist.lows, hist.volumes || []);
      const techScore = techResult.score;

      // Shared decision data for logging (built up as we go)
      const decisionData = {
        cycleTs, symbol, price: currentPrice, changePct,
        marketState: currentMarketState, marketScore,
        breadthCount, breadthState,
        trend: assetRegime.trend, adx: assetRegime.adx, atr: assetRegime.atr,
        rsScore, techScore,
        rsi: techResult.rsi, macdHistogram: techResult.macdHistogram,
        volumeExpanding: techResult.volumeExpanding, atrExpanding: techResult.atrExpanding,
        techRsiPts: techResult.rsiPts, techMacdPts: techResult.macdPts,
        techVolPts: techResult.volumePts, techAtrPts: techResult.atrPts,
        filters: {},
        pyramidLevel: pos.pyramid_level || 0,
      };

      // c. Exit triggers (only for open positions) — executed immediately, not deferred
      if ((pos.quantity || 0) > 0) {
        const atrMult = config.strategy?.atr_stop_multiplier || 2.0;
        const atr = assetRegime.atr;

        // Initialize stop for legacy/manual positions that have no stop_price yet
        if (pos.stop_price == null && atr) {
          const basePrice = pos.avg_cost || currentPrice;
          const initStop = basePrice - atrMult * atr;
          state.positions[symbol].stop_price = initStop;
          pos = state.positions[symbol];
          console.log(`[Stop] ${symbol}: stop_price initialized $${initStop.toFixed(2)} (avg $${basePrice.toFixed(2)} - ${atrMult}×ATR $${atr.toFixed(2)})`);
        }

        // Trail stop upward — never let gains erode back to the original stop level
        if (pos.stop_price != null && atr) {
          const trailingStop = currentPrice - atrMult * atr;
          if (trailingStop > pos.stop_price) {
            state.positions[symbol].stop_price = trailingStop;
            pos = state.positions[symbol];
          }
        }

        // Breakeven lock — once the position is profitable, the stop must never fall
        // below avg_cost. This guarantees we never exit a winner at a loss.
        if (pos.avg_cost && currentPrice > pos.avg_cost && pos.stop_price != null) {
          if (pos.stop_price < pos.avg_cost) {
            state.positions[symbol].stop_price = pos.avg_cost;
            pos = state.positions[symbol];
          }
        }

        // ── Crypto partial profit taking ─────────────────────────────────────────
        // For scanner positions: sell 33% each time a profit target is hit.
        // Checked before ATR stop — gives the trade a chance to realise gains.
        if (pos.source === 'crypto_scanner' && pos.avg_cost && currentPrice > pos.avg_cost) {
          const profitPct = ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100;
          const pt1 = config.crypto_scanner?.profit_take_pct_1 ?? 10;
          const pt2 = config.crypto_scanner?.profit_take_pct_2 ?? 20;
          let ptReason = null;
          if (!pos.profit_take_2_done && profitPct >= pt2) {
            state.positions[symbol].profit_take_2_done = true;
            state.positions[symbol].profit_take_1_done = true;
            ptReason = `Partial take PT2: +${profitPct.toFixed(1)}% ≥ +${pt2}%`;
          } else if (!pos.profit_take_1_done && profitPct >= pt1) {
            state.positions[symbol].profit_take_1_done = true;
            ptReason = `Partial take PT1: +${profitPct.toFixed(1)}% ≥ +${pt1}%`;
          }
          if (ptReason) {
            pos = state.positions[symbol];
            state = await executeSell({ symbol, pos, portion: 0.33, reason: ptReason, currentPrice, state, marketState: currentMarketState });
            assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'sell', reason: ptReason });
            logDecision({ ...decisionData, decision: 'sell', failReason: null });
            continue;
          }
        }

        const minHoldMinutes = config.strategy?.min_hold_minutes ?? 60;
        const exitResult = checkExitTrigger({
          pos, currentPrice, assetRegime,
          currentMarketState, prevMarketState, minHoldMinutes,
        });

        if (exitResult._skipped) {
          // Trend broke but min hold period not elapsed — log and continue to entry filters
          console.log(`[Exit] ${symbol}: ${exitResult._skipped}`);
        } else if (exitResult.exit) {
          const market = isMarketOpen(symbol);
          if (!market.open && market.exchange !== 'CRYPTO') {
            assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason: `Market closed (exit deferred) — ${exitResult.reason}` });
            logDecision({ ...decisionData, decision: 'hold', failReason: `Market closed — ${exitResult.reason}` });
            continue;
          }

          // AI exit gate: for soft exits (trend-break / RISK_OFF) on profitable positions,
          // ask Claude for a direction call. If AI says HOLD, skip this cycle and wait for
          // a better exit or for the ATR stop to define the floor. Hard exits (ATR stop,
          // PANIC) bypass the gate entirely — those are quantitative safety mechanisms.
          if (
            exitResult.type === 'soft' &&
            pos.avg_cost && currentPrice > pos.avg_cost &&
            config.strategy?.ai_exit_gate !== false
          ) {
            const budgetCheck = canCallAI(state);
            if (budgetCheck.allowed) {
              try {
                const profitPct = ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100;
                const aiExit = await queryExitDirection({
                  symbol,
                  price: currentPrice,
                  avgCost: pos.avg_cost,
                  profitPct,
                  trend: assetRegime.trend,
                  adx: assetRegime.adx,
                  atr: assetRegime.atr,
                  marketState: currentMarketState,
                  exitReason: exitResult.reason,
                  model: config.ai?.model,
                });
                state = recordCall(state, aiExit.costUsd);
                console.log(`[AI Exit Gate] ${symbol}: ${aiExit.verdict} — ${aiExit.reason}`);

                if (aiExit.verdict === 'HOLD') {
                  const holdReason = `AI Exit Gate: HOLD — ${aiExit.reason}`;
                  assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason: holdReason });
                  logDecision({ ...decisionData, decision: 'hold', failReason: holdReason });
                  continue;
                }
              } catch (err) {
                // Fail open: API error → proceed with sell
                console.warn(`[AI Exit Gate] ${symbol}: API error, proceeding with sell — ${err.message}`);
              }
            } else {
              console.log(`[AI Exit Gate] ${symbol}: skipped — ${budgetCheck.reason}`);
            }
          }

          state = await executeSell({
            symbol, pos, portion: exitResult.portion,
            reason: exitResult.reason, currentPrice, state,
            marketState: currentMarketState,
          });
          assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'sell', reason: exitResult.reason });
          logDecision({ ...decisionData, decision: 'sell', failReason: null });
          continue;
        }
      }

      // d. Cooldown check — skip symbols rejected 3× for the same reason (no open position)
      // Only applies to pure watchlist symbols; open positions always proceed to exit logic above.
      if ((pos.quantity || 0) === 0) {
        const cooldownMinutes = config.strategy?.rejection_cooldown_minutes ?? 60;
        const cooldownMs = cooldownMinutes * 60 * 1000;
        const rej = state.rejection_counts?.[symbol];
        if (rej && rej.count >= 3 && (Date.now() - new Date(rej.since).getTime()) < cooldownMs) {
          const minsLeft = Math.ceil((cooldownMs - (Date.now() - new Date(rej.since).getTime())) / 60000);
          const reason = `Cooldown: ${minsLeft}min remaining (rejected ${rej.count}× for '${rej.reason}')`;
          assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason });
          logDecision({ ...decisionData, filters: {}, decision: 'hold', failReason: reason });
          continue;
        }
      }

      // e. Entry filters
      const pyramidLevel  = pos.pyramid_level || 0;
      const adxThreshold  = config.strategy?.adx_threshold     || 20;
      const entryScore    = config.strategy?.entry_score        ?? 70;
      const strongScore   = config.strategy?.strong_buy_score   ?? 85;

      let allFiltersPass = true;
      let failReason = null;
      const filterLog = {};

      // ── Hard gates (binary — override score) ────────────────────────────────
      const minState = config.strategy?.min_global_state || 'RISK_ON';
      // Crypto scanner candidates skip the equity market-state gate:
      // they already have the BTC EMA50 gate as their own macro filter.
      // PANIC is still enforced globally (handled earlier in cycle).
      const isCryptoCandidate = symbol in cryptoCandidates;
      if (!isCryptoCandidate && currentMarketState !== minState) {
        allFiltersPass = false;
        failReason = `Market state: ${currentMarketState} (${minState} required)`;
        filterLog.market_state = 'FAIL';
      } else {
        filterLog.market_state = isCryptoCandidate ? 'SCANNER_BYPASS' : 'PASS';

        if (isCryptoCandidate) {
          // ── Crypto scanner candidate: scanner is the authority, no equity re-filter ──
          // Scanner already applied BTC gate + trend + ADX + volume + min_score.
          // Do NOT re-apply entry_score (equity threshold) — crypto has its own scoring.
          const scanResult   = cryptoCandidates[symbol];
          const scannerScore = scanResult.score;
          filterLog.trend       = 'SCANNER';
          filterLog.adx         = 'SCANNER';
          filterLog.final_score = 'SCANNER';
          decisionData.finalScore = scannerScore;
          decisionData.tier       = scannerScore >= (config.crypto_scanner?.strong_buy_score ?? 80) ? 'STRONG_BUY' : 'BUY';
          // Earnings check skipped for crypto (event-engine handles via CRYPTO_SYMBOLS)
          filterLog.earnings = 'SKIP';
        } else if (assetRegime.trend === 'BEAR') {
          allFiltersPass = false;
          failReason = `Trend filter: BEAR (BULL or SIDEWAYS required)`;
          filterLog.trend = 'FAIL';
        } else {
          filterLog.trend = 'PASS';
          if (!assetRegime.adx || assetRegime.adx <= adxThreshold) {
            allFiltersPass = false;
            failReason = `ADX filter: ${assetRegime.adx?.toFixed(1) || 'null'} ≤ ${adxThreshold} (trend strength insufficient)`;
            filterLog.adx = 'FAIL';
          } else {
            filterLog.adx = 'PASS';

            // ── Final Score gate (replaces individual RS / Tech / Breadth thresholds) ──
            const finalScore = calcFinalScore({
              rsScore, techScore, marketScore,
              breadthCount, adx: assetRegime.adx, adxMin: adxThreshold,
            });
            const tier = scoreToTier(finalScore, entryScore, strongScore);

            if (tier === 'NO_ENTRY') {
              const aiMode     = config.strategy?.ai_mode     || 'gate';
              const aiMinScore = config.strategy?.ai_min_score ?? 50;

              // override mode: AI may promote a near-miss to BUY
              if (aiMode === 'override' && finalScore >= aiMinScore && pyramidLevel === 0) {
                const aiCheck = canCallAI(state);
                if (aiCheck.allowed) {
                  try {
                    const audit = await auditTrade({
                      symbol, price: currentPrice,
                      reason: `Near-miss override: Final skor ${finalScore}/${entryScore}`,
                      scores: { market_state: currentMarketState, market_score: marketScore, trend: assetRegime.trend, adx: assetRegime.adx, atr: assetRegime.atr, rs_score: rsScore, tech_score: techScore },
                      model: config.ai?.model || 'claude-haiku-4-5-20251001',
                    });
                    state = recordCall(state, audit.costUsd);
                    decisionData.aiVerdict = audit.verdict;
                    decisionData.aiReason  = audit.reason;
                    decisionData.aiPrompt  = audit.prompt;
                    if (audit.verdict === 'BUY') {
                      filterLog.final_score = 'AI_OVERRIDE';
                      filterLog.ai_audit    = 'PASS';
                      decisionData.finalScore = finalScore;
                      decisionData.tier = 'BUY';
                      console.log(`[AI Override] ${symbol}: skor ${finalScore} < ${entryScore} ama AI BUY — ${audit.reason}`);
                      // allFiltersPass remains true → falls through to earnings check below
                    } else {
                      allFiltersPass = false;
                      failReason = `Final score: ${finalScore} < ${entryScore} | AI: ${audit.reason}`;
                      filterLog.final_score = 'FAIL';
                      filterLog.ai_audit    = 'FAIL';
                    }
                  } catch (err) {
                    console.warn(`[AI Override] ${symbol} error:`, err.message);
                    allFiltersPass = false;
                    failReason = `Final score: ${finalScore} < ${entryScore} (RS:${rsScore?.toFixed(0) ?? '?'} Tech:${techScore} Mkt:${marketScore} Breadth:${breadthCount}/11)`;
                    filterLog.final_score = 'FAIL';
                  }
                } else {
                  allFiltersPass = false;
                  failReason = `Final score: ${finalScore} < ${entryScore} (AI budget exceeded: ${aiCheck.reason})`;
                  filterLog.final_score = 'FAIL';
                }
              } else {
                allFiltersPass = false;
                failReason = `Final score: ${finalScore} < ${entryScore} (RS:${rsScore?.toFixed(0) ?? '?'} Tech:${techScore} Mkt:${marketScore} Breadth:${breadthCount}/11)`;
                filterLog.final_score = 'FAIL';
              }
            } else {
              filterLog.final_score = tier; // 'BUY' or 'STRONG_BUY'

              // Layer 5: Earnings filter — only for new entries
              if (pyramidLevel === 0) {
                const earningsDaysBefore = config.strategy?.earnings_days_before ?? 5;
                const earningsDaysAfter  = config.strategy?.earnings_days_after  ?? 2;
                const earningsResult = await checkEarningsBlock(symbol, { daysBefore: earningsDaysBefore, daysAfter: earningsDaysAfter });
                if (earningsResult.blocked) {
                  allFiltersPass = false;
                  failReason = earningsResult.reason;
                  filterLog.earnings = 'FAIL';
                } else {
                  filterLog.earnings = 'PASS';
                }
              } else {
                filterLog.earnings = 'SKIP';
              }

              // Store tier on decisionData so executeBuy can use it
              decisionData.finalScore = finalScore;
              decisionData.tier = tier;
            }
          }
        }
      }

      // e. Pyramid decision
      const decision = decideMomentum({
        pyramidLevel,
        currentPrice,
        entryPrice: pos.entry_price || null,
        level2Price: pos.level2_price || null,
        atr: assetRegime.atr || 0,
        filters: { allPass: allFiltersPass, failReason }
      });

      if (decision.action === 'buy') {
        // Defer buy — will be sorted by RS score before execution
        buyCandidates.push({ symbol, pos, currentPrice, changePct, assetRegime, decision, rsScore: isCryptoCandidate ? cryptoCandidates[symbol].score : (rsScore ?? 0), techScore, techResult, marketScore, filterLog, decisionData, tier: decisionData.tier, isDCA: false });
        // Clear rejection count so symbol starts fresh after being bought
        if (state.rejection_counts?.[symbol]) delete state.rejection_counts[symbol];
      } else {
        // ── Crypto DCA: buy into price dips ────────────────────────────────────
        // If a scanner position exists and price drops dca_dip_pct% below avg cost,
        // generate a DCA buy signal instead of pyramid logic.
        let dcaQueued = false;
        if (pos.source === 'crypto_scanner' && pos.avg_cost && (pos.quantity || 0) > 0) {
          const dcaDipPct    = config.crypto_scanner?.dca_dip_pct    ?? 5;
          const maxDcaCount  = config.crypto_scanner?.max_dca_count  ?? 3;
          const dcaCount     = pos.dca_count || 0;
          if (currentPrice <= pos.avg_cost * (1 - dcaDipPct / 100) && dcaCount < maxDcaCount) {
            const dcaReason = `DCA buy: $${currentPrice.toFixed(4)} ≤ avg cost $${pos.avg_cost.toFixed(4)} −${dcaDipPct}% (${dcaCount + 1}/${maxDcaCount})`;
            buyCandidates.push({
              symbol, pos, currentPrice, changePct, assetRegime,
              decision: { action: 'buy', tranche: 1, reason: dcaReason },
              rsScore: 0, techScore: 0, techResult: {}, marketScore: 0,
              filterLog: { ...filterLog, dca: 'TRIGGER', ai_audit: 'SKIP', correlation: 'SKIP' },
              decisionData: { ...decisionData, tier: 'BUY', finalScore: 50 },
              tier: 'BUY',
              isDCA: true,
            });
            dcaQueued = true;
            console.log(`[DCA] ${symbol}: ${dcaReason}`);
          }
        }
        if (!dcaQueued) {
          assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason: decision.reason });
          logDecision({ ...decisionData, filters: filterLog, decision: 'hold', failReason: decision.reason });

          // Track rejection counts for cooldown (only watchlist symbols, not open positions)
          // Normalize: strip AI comment so "Final skor: 54 < 63 | AI: [varies]" → "Final skor: 54 < 63"
          if ((pos.quantity || 0) === 0 && decision.reason) {
            if (!state.rejection_counts) state.rejection_counts = {};
            const cooldownKey = decision.reason.split(' | AI:')[0];
            const prev = state.rejection_counts[symbol];
            if (prev && prev.reason === cooldownKey) {
              state.rejection_counts[symbol] = { reason: cooldownKey, count: prev.count + 1, since: prev.since };
            } else {
              state.rejection_counts[symbol] = { reason: cooldownKey, count: 1, since: new Date().toISOString() };
            }
          }
        }
      }
    }

    // Pass 2: execute buys ranked by RS score (strongest signal first)
    buyCandidates.sort((a, b) => b.rsScore - a.rsScore);
    const cryptoBuyCandidates = buyCandidates.filter(c => c.symbol in cryptoCandidates);
    if (cryptoBuyCandidates.length) {
      console.log(`[CryptoPass2] ${cryptoBuyCandidates.length} candidates processing: ${cryptoBuyCandidates.map(c => `${c.symbol}(${c.rsScore})`).join(', ')}`);
    } else if (Object.keys(cryptoCandidates).length) {
      console.log(`[CryptoPass2] Scanner found ${Object.keys(cryptoCandidates).length} candidates but none reached Pass2`);
    }

    const corrMax = config.strategy?.correlation_max ?? 0.85;

    for (const { symbol, pos, currentPrice, changePct, assetRegime, decision, rsScore, techScore, techResult, marketScore, filterLog, decisionData, tier, isDCA } of buyCandidates) {
      // Correlation check (Layer 7) — skip for DCA (already in the position) and pyramid additions
      if (decision.tranche === 1 && !isDCA) {
        const corrResult = checkCorrelation(historyMap[symbol]?.closes || [], state.positions, historyMap, corrMax);
        if (corrResult.blocked) {
          const reason = `Correlation filter: r=${corrResult.correlation.toFixed(2)} with ${corrResult.with}`;
          assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason });
          logDecision({ ...decisionData, filters: { ...filterLog, correlation: 'FAIL' }, decision: 'hold', failReason: reason });
          continue;
        }
        filterLog.correlation = 'PASS';

        // AI Auditor (Layer 14) — final gate for new entries
        // Skip if AI was already called in Pass 1 (override mode promoted this candidate)
        // Also skip for crypto scanner candidates: scanner already applied BTC gate + trend +
        // ADX + volume + RS + RSI on 1H data. Sending daily-candle analysis to the AI
        // would contradict the scanner's 1H conclusion and block valid crypto entries.
        const isCryptoEntry = (symbol in cryptoCandidates) || isDCA;
        let aiVerdict = decisionData.aiVerdict ?? null;
        let aiReason  = decisionData.aiReason  ?? null;
        const aiMode  = config.strategy?.ai_mode || 'gate';
        const aiCheck = canCallAI(state);
        if (isCryptoEntry) {
          filterLog.ai_audit = isDCA ? 'DCA' : 'SCANNER';
          console.log(`[AI Auditor] ${symbol}: ${isDCA ? 'DCA buy' : 'scanner candidate'} — AI audit skipped`);
        } else if (aiMode !== 'disabled' && !aiVerdict && aiCheck.allowed) {
          try {
            const audit = await auditTrade({
              symbol, price: currentPrice,
              reason: decision.reason,
              scores: {
                market_state:  currentMarketState,
                market_score:  marketScore,
                trend:         assetRegime.trend,
                adx:           assetRegime.adx,
                atr:           assetRegime.atr,
                rs_score:      rsScore,
                tech_score:    techScore,
              },
              model: config.ai?.model || 'claude-haiku-4-5-20251001',
            });
            state = recordCall(state, audit.costUsd);
            aiVerdict = audit.verdict;
            aiReason  = audit.reason;
            decisionData.aiPrompt = audit.prompt;
            if (audit.verdict === 'SKIP') {
              const reason = `AI Auditor: ${audit.reason}`;
              assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason });
              logDecision({ ...decisionData, filters: { ...filterLog, ai_audit: 'FAIL' }, decision: 'hold', failReason: reason, aiVerdict, aiReason });
              continue;
            }
            filterLog.ai_audit = 'PASS';
            console.log(`[AI Auditor] ${symbol}: BUY — ${audit.reason}`);
          } catch (err) {
            console.warn(`[AI Auditor] ${symbol} audit failed, proceeding:`, err.message);
            filterLog.ai_audit = 'SKIP';
          }
        } else if (aiVerdict) {
          // Already called in Pass 1 (override mode) — treat as PASS
          filterLog.ai_audit = 'PASS';
          console.log(`[AI Auditor] ${symbol}: approved in Pass 1 (${aiVerdict})`);
        } else {
          filterLog.ai_audit = 'SKIP';
          const skipReason = aiCheck.reason || (aiMode === 'disabled' ? 'AI disabled' : 'unknown');
          console.log(`[AI Auditor] ${symbol}: skipped — ${skipReason}`);
        }
      } else {
        filterLog.correlation = 'SKIP';
        filterLog.ai_audit    = 'SKIP';
      }

      // max_positions cap for scanner candidates — checked in Pass 2 so source tags
      // from earlier buys in the same cycle are already reflected
      if ((symbol in cryptoCandidates) && decision.tranche === 1) {
        const maxPositions     = config.crypto_scanner?.max_positions ?? 3;
        const scannerOpenCount = Object.values(state.positions)
          .filter(p => p.source === 'crypto_scanner' && (p.quantity || 0) > 0).length;
        if (scannerOpenCount >= maxPositions) {
          const reason = `Crypto scanner: max_positions (${maxPositions}) reached`;
          assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason });
          logDecision({ ...decisionData, filters: filterLog, decision: 'hold', failReason: reason });
          continue;
        }
      }

      // Risk check — re-evaluated here so cash state reflects prior buys in this cycle
      const riskResult = check({
        symbol, action: decision.action,
        state, config, portfolioValue,
        assetValue: (pos.quantity || 0) * currentPrice
      });

      if (!riskResult.approved) {
        assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', blocked: true, reason: riskResult.reason });
        logDecision({ ...decisionData, filters: filterLog, decision: 'hold', failReason: riskResult.reason });
        continue;
      }

      const market = isMarketOpen(symbol);
      if (!market.open && market.exchange !== 'CRYPTO') {
        const reason = `Market closed — ${market.reason}`;
        assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason });
        logDecision({ ...decisionData, filters: filterLog, decision: 'hold', failReason: reason });
        continue;
      }

      const buyReason = isDCA
        ? decision.reason
        : tier === 'STRONG_BUY'
          ? `[STRONG BUY:${decisionData.finalScore}] ${decision.reason}`
          : `[Score:${decisionData.finalScore}] ${decision.reason}`;

      const buyResult = await executeBuy({
        symbol, pos, tranche: decision.tranche,
        reason: buyReason, currentPrice,
        atr: assetRegime.atr, state,
        strongBuy: tier === 'STRONG_BUY',
        portfolioValue,
        isCryptoScanner: (symbol in cryptoCandidates) || isDCA,
        isDCA,
        scores: {
          market_state:  currentMarketState,
          market_score:  marketScore,
          trend:         assetRegime.trend,
          adx:           assetRegime.adx,
          atr:           assetRegime.atr,
          rs_score:      rsScore,
          tech_score:    techScore,
          pyramid_level: decision.tranche,
        },
      });
      state = buyResult.state;
      if (buyResult.success) {
        // Tag position as scanner-originated (used for max_positions counting)
        if (symbol in cryptoCandidates) {
          if (!state.positions[symbol]) state.positions[symbol] = {};
          state.positions[symbol].source = 'crypto_scanner';
        }
        assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'buy', reason: buyReason });
        logDecision({ ...decisionData, filters: filterLog, decision: 'buy', tranche: decision.tranche, failReason: null });
      } else {
        const execFailReason = buyResult.failReason || 'Buy failed';
        assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason: execFailReason });
        logDecision({ ...decisionData, filters: filterLog, decision: 'hold', failReason: execFailReason });
      }
    }

    // 8. Save decisions for UI display
    state.last_decisions = assetReports.map(r => {
      const market = isMarketOpen(r.symbol);
      return { ...r, market_open: market.open, exchange: market.exchange, checked_at: new Date().toISOString() };
    });

    // 9. Send Slack report
    const totalPnlPct = portfolioValue > 0 ? (totalPnl / (portfolioValue - totalPnl)) * 100 : 0;
    await slack.send(slack.formatCheckReport({
      layer: 'Momentum v3',
      cash,
      portfolioValue,
      assets: assetReports,
      totalPnl,
      totalPnlPct,
      aiUsage: {
        dailyCalls: state.ai_usage?.daily_calls || 0,
        dailyLimit: state.ai_usage?.daily_limit || 0,
        monthlyCost: state.ai_usage?.monthly_cost_usd || 0,
        monthlyBudget: state.ai_usage?.monthly_budget_usd || 0,
      },
      risk: {
        macroEquity: currentMarketState,
        macroCrypto: currentMarketState,
        paused: state.risk.trades_paused,
        dailyTrades: state.risk.daily_trades_today,
        maxDailyTrades: config.strategy?.max_daily_trades || 10
      }
    }));

    state.last_check = new Date().toISOString();
    saveState(state);

  } catch (err) {
    console.error('[Bot] Unhandled error in cycle:', err);
    await slack.send(slack.formatError({ message: err.message, lastSuccess: state.last_check }));
  } finally {
    isRunning = false;
  }
}

async function main() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'bot.pid'), process.pid.toString());

  config = loadConfig();
  slack = new SlackNotifier(process.env.SLACK_WEBHOOK_URL || config.slack?.webhook_url);
  etoroClient = new EToroClient(config);

  const intervalMin = config.strategy?.check_interval_minutes || 10;
  console.log(`[Bot] Starting Momentum v3. Interval: ${intervalMin}min. Dry run: ${config.safety?.dry_run}`);
  await slack.send(`🤖 eToro Bot v3 Momentum started — ${intervalMin}min interval, dry_run=${config.safety?.dry_run}`);

  await runCycle();
  cron.schedule(`*/${intervalMin} * * * *`, runCycle);
}

main().catch(err => {
  console.error('[Bot] Fatal error:', err);
  process.exit(1);
});
