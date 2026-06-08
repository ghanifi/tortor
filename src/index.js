// src/index.js
const cron = require('node-cron');
const { loadConfig } = require('./config');
const { loadState, saveState } = require('./state');
const EToroClient = require('./etoro/client');
const { fetchSymbolPrices, fetchSymbolHistories, detectAssetRegimeV3 } = require('./analysis/regime');
const { getMarketState } = require('./analysis/market-state');
const { calcRelativeStrength, fetchBenchmarkReturns, getExchangeBenchmark } = require('./analysis/relative-strength');
const { decideMomentum, checkExitTrigger } = require('./strategies/momentum');
const { check, updateAfterTrade, checkDrawdown, resetDailyCounters } = require('./risk');
const { calcPnL, calcTotalPortfolioValue, allocateBudget } = require('./portfolio');
const SlackNotifier = require('./slack');
const { isMarketOpen } = require('./market-hours');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');

let config = null;
let slack = null;
let etoroClient = null;
let isRunning = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcNewAvgCost(existingQty, existingAvg, newQty, newPrice) {
  const total = existingQty + newQty;
  if (total === 0) return newPrice;
  return ((existingQty * (existingAvg || newPrice)) + (newQty * newPrice)) / total;
}

async function executeSell({ symbol, pos, portion, reason, currentPrice, state }) {
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

    if (config.safety?.dry_run) {
      console.log(`[DRY RUN] SELL ${symbol} ${(portion * 100).toFixed(0)}%: ${reason}`);
    }
  } catch (err) {
    console.error(`[Trade] Sell ${symbol} failed:`, err.message);
  }

  return state;
}

async function executeBuy({ symbol, pos, tranche, reason, currentPrice, atr, state }) {
  const sizes = config.strategy?.pyramid_sizes || [0.4, 0.3, 0.3];
  const trancheSize = sizes[tranche - 1] || 0.33;
  const budget = allocateBudget(symbol, Object.keys(state.positions), state.cash || 0, config) * trancheSize;

  if (budget <= 0) return state;

  const qty = budget / currentPrice;
  const atrMult = config.strategy?.atr_stop_multiplier || 2.0;

  try {
    if (!config.safety?.dry_run) {
      await etoroClient.buyAsset({ symbol, amount: budget });
    }

    const newAvg = calcNewAvgCost(pos.quantity || 0, pos.avg_cost || currentPrice, qty, currentPrice);

    if (tranche === 1) {
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

    if (config.safety?.dry_run) {
      console.log(`[DRY RUN] BUY ${symbol} L${tranche} $${budget.toFixed(2)}: ${reason}`);
    }
  } catch (err) {
    console.error(`[Trade] Buy ${symbol} failed:`, err.message);
  }

  return state;
}

// ── Main cycle ────────────────────────────────────────────────────────────────

async function runCycle() {
  if (isRunning) { console.log('[Bot] Previous cycle still running, skipping.'); return; }
  isRunning = true;
  console.log(`[Bot] Cycle start: ${new Date().toISOString()}`);

  config = loadConfig();
  let state = loadState();
  state = resetDailyCounters(state);

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
          state = await executeSell({ symbol: sym, pos, portion: 1, reason: 'Market state: PANIC — acil çıkış', currentPrice: price, state });
        } else {
          console.error(`[PANIC] ${sym} satılamadı — fiyat verisi yok, manuel müdahale gerekli`);
          try {
            await slack.send(`⚠️ PANIC: ${sym} otomatik çıkış BAŞARISIZ — fiyat verisi yok, manuel işlem gerekli`);
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
    } catch (err) {
      await slack.send(slack.formatError({ message: err.message, lastSuccess: state.last_check }));
      saveState(state);
      isRunning = false;
      return;
    }

    const prices = {};
    const rawPositions = portfolioData?.positions || [];
    let cash = portfolioData?.cash || 0;

    for (const p of rawPositions) {
      const sym = p.symbol;
      if (!sym) continue;
      if (p.currentPrice) prices[sym] = p.currentPrice;
      if (!state.positions[sym]) state.positions[sym] = {};
      state.positions[sym].quantity    = p.units || 0;
      state.positions[sym].positionIds = p.positionIds;
      state.positions[sym].instrumentId = p.instrumentId;
      if (!state.positions[sym].avg_cost && p.avgCost) {
        state.positions[sym].avg_cost = p.avgCost;
      }
    }

    const configCash = config.budget?.available_cash ?? 0;
    if (cash === 0 && configCash > 0) { cash = configCash; }
    state.cash = cash;

    const allSymbols = [...new Set([
      ...Object.keys(state.positions),
      ...(config.watchlist || [])
    ])];

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
    const assetReports = [];
    const buyCandidates = [];
    let totalPnl = 0;

    // Pass 1: compute indicators, execute exits, collect buy candidates
    for (const symbol of allSymbols) {
      const pos = state.positions[symbol] || { avg_cost: null, quantity: 0 };
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

      // b. Relative strength
      let rsScore = null;
      if (hist.closes.length >= 21) {
        const closes = hist.closes;
        const assetReturn = ((closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]) * 100;
        const bench = getExchangeBenchmark(symbol);
        const benchReturn = benchmarkReturns[bench] ?? 0;
        rsScore = calcRelativeStrength(assetReturn, benchReturn);
      }

      // c. Exit triggers (only for open positions) — executed immediately, not deferred
      if ((pos.quantity || 0) > 0) {
        const exitResult = checkExitTrigger({
          pos, currentPrice, assetRegime,
          currentMarketState, prevMarketState
        });

        if (exitResult.exit) {
          const market = isMarketOpen(symbol);
          if (!market.open && market.exchange !== 'CRYPTO') {
            assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason: `Piyasa kapalı (çıkış ertelendi) — ${exitResult.reason}` });
            continue;
          }

          state = await executeSell({
            symbol, pos, portion: exitResult.portion,
            reason: exitResult.reason, currentPrice, state
          });
          assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'sell', reason: exitResult.reason });
          continue;
        }
      }

      // d. Entry filters
      const pyramidLevel = pos.pyramid_level || 0;
      const adxThreshold = config.strategy?.adx_threshold || 20;
      const rsThreshold  = config.strategy?.rs_threshold  || 70;

      let allFiltersPass = true;
      let failReason = null;

      const minState = config.strategy?.min_global_state || 'RISK_ON';
      if (currentMarketState !== minState) {
        allFiltersPass = false;
        failReason = `Market state: ${currentMarketState} (${minState} gerekli)`;
      } else if (assetRegime.trend !== 'BULL') {
        allFiltersPass = false;
        failReason = `Regime filtresi: EMA/ADX koşulu sağlanmadı (trend: ${assetRegime.trend})`;
      } else if (!assetRegime.adx || assetRegime.adx <= adxThreshold) {
        allFiltersPass = false;
        failReason = `Regime filtresi: ADX ${assetRegime.adx?.toFixed(1) || 'null'} ≤ ${adxThreshold}`;
      } else if (rsScore === null || rsScore < rsThreshold) {
        allFiltersPass = false;
        failReason = `RS filtresi: ${rsScore?.toFixed(0) || '?'} < ${rsThreshold} (benchmark'ın gerisinde)`;
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
        buyCandidates.push({ symbol, pos, currentPrice, changePct, assetRegime, decision, rsScore: rsScore ?? 0 });
      } else {
        assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason: decision.reason });
      }
    }

    // Pass 2: execute buys ranked by RS score (strongest signal first)
    buyCandidates.sort((a, b) => b.rsScore - a.rsScore);

    for (const { symbol, pos, currentPrice, changePct, assetRegime, decision, rsScore } of buyCandidates) {
      // Risk check — re-evaluated here so cash state reflects prior buys in this cycle
      const riskResult = check({
        symbol, action: decision.action,
        state, config, portfolioValue,
        assetValue: (pos.quantity || 0) * currentPrice
      });

      if (!riskResult.approved) {
        assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', blocked: true, reason: riskResult.reason });
        continue;
      }

      const market = isMarketOpen(symbol);
      if (!market.open && market.exchange !== 'CRYPTO') {
        assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason: `Piyasa kapalı — ${market.reason}` });
        continue;
      }

      state = await executeBuy({
        symbol, pos, tranche: decision.tranche,
        reason: decision.reason, currentPrice,
        atr: assetRegime.atr, state
      });
      assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'buy', reason: `[RS:${rsScore.toFixed(0)}] ${decision.reason}` });
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
  await slack.send(`🤖 eToro Bot v3 Momentum başladı — ${intervalMin}dk aralık, dry_run=${config.safety?.dry_run}`);

  await runCycle();
  cron.schedule(`*/${intervalMin} * * * *`, runCycle);
}

main().catch(err => {
  console.error('[Bot] Fatal error:', err);
  process.exit(1);
});
