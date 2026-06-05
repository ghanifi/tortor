// src/index.js
const cron = require('node-cron');
const { loadConfig } = require('./config');
const { loadState, saveState } = require('./state');
const EToroClient = require('./etoro/client');
const { analyzeSignals } = require('./analysis/indicators');
const { fetchSP500History, fetchBTCDominanceHistory, detectEquityRegime, detectCryptoRegime, detectAssetRegime, applyRegimeAdjustments } = require('./analysis/regime');
const { decide, calcNewAvgCost } = require('./strategies/dca');
const { canCallAI, recordCall, shouldWarnBudget } = require('./analysis/ai_budget');
const { analyzeChart } = require('./analysis/ai_chart');
const { check, updateAfterTrade, checkDrawdown, resetDailyCounters } = require('./risk');
const { calcChange, calcPnL, calcTotalPortfolioValue, allocateBudget } = require('./portfolio');
const SlackNotifier = require('./slack');
const path = require('path');
const fs = require('fs');

let config = null;
let slack = null;
let etoroClient = null;
let isRunning = false;

async function runCycle() {
  if (isRunning) { console.log('[Bot] Previous cycle still running, skipping.'); return; }
  isRunning = true;
  console.log(`[Bot] Cycle start: ${new Date().toISOString()}`);

  let state = loadState();
  state = resetDailyCounters(state);

  try {
    // 1. Fetch macro regime (once per cycle)
    let macroEquity = state.regime.macro_equity;
    let macroCrypto = state.regime.macro_crypto;
    try {
      const sp500 = await fetchSP500History();
      macroEquity = detectEquityRegime(sp500);
      const btcDom = await fetchBTCDominanceHistory();
      macroCrypto = detectCryptoRegime(btcDom.current, btcDom.weekAgo);
      state.regime = { macro_equity: macroEquity, macro_crypto: macroCrypto, updated_at: new Date().toISOString() };
    } catch (err) {
      console.warn('[Regime] Failed to fetch macro data, using cached:', err.message);
    }

    // 2. Fetch portfolio + prices
    let portfolioData = null;
    try {
      portfolioData = await etoroClient.execute(
        (http) => http.getLoginData(),
        (dom) => dom.getPortfolioPositions(),
        (pw) => pw.getPortfolioPositions()
      );
    } catch (err) {
      await slack.send(slack.formatError({ message: err.message, lastSuccess: state.last_check }));
      saveState(state);
      isRunning = false;
      return;
    }

    // Normalize portfolio data (structure may differ by layer)
    const rawPositions = portfolioData?.AggregatedPositions || portfolioData?.positions || [];
    const cash = portfolioData?.CreditByRealizedEquity || portfolioData?.cash || 0;

    // Update state positions from live data
    const prices = {};
    for (const pos of rawPositions) {
      const sym = pos.InstrumentID || pos.symbol;
      if (!sym) continue;
      if (!state.positions[sym]) state.positions[sym] = {};
      state.positions[sym].quantity = pos.Units || pos.units || 0;
      prices[sym] = pos.Rate || pos.currentPrice || 0;
    }

    // All symbols to evaluate: portfolio + watchlist
    const allSymbols = [...new Set([
      ...Object.keys(state.positions),
      ...(config.watchlist || [])
    ])];

    // Portfolio value + drawdown check
    const portfolioValue = calcTotalPortfolioValue(state.positions, prices, cash);
    state = checkDrawdown(state, portfolioValue);

    // 3. Process each asset through decision pipeline
    const assetReports = [];
    let totalPnl = 0;

    for (const symbol of allSymbols) {
      const pos = state.positions[symbol] || { avg_cost: null, quantity: 0 };
      const currentPrice = prices[symbol] || 0;
      if (!currentPrice) continue;

      const change = calcChange(currentPrice, pos.avg_cost);
      const pnl = pos.quantity > 0 ? calcPnL(pos.quantity, pos.avg_cost, currentPrice) : 0;
      totalPnl += pnl;

      const assetClass = config.strategy?.asset_classes?.[symbol] || 'stocks';
      const baseThresholds = config.thresholds?.[assetClass] || config.thresholds?.stocks;

      // Asset regime
      const assetRegime = detectAssetRegime([currentPrice]);
      const { thresholds, budgetMultiplier } = applyRegimeAdjustments(
        baseThresholds, macroEquity, macroCrypto, assetClass, assetRegime
      );

      // Indicators (single price — will be improved with real history later)
      const indicators = { rsi: null, macd: null, bollinger: null, signal: 'neutral' };

      let decision = decide({ change: change || 0, thresholds, indicators });

      // AI edge analysis
      if (decision.action === 'edge' && canCallAI(state).allowed) {
        try {
          const screenshotDir = path.join(process.cwd(), 'logs');
          if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
          const screenshotPath = path.join(screenshotDir, `${symbol}_chart.png`);

          await etoroClient.execute(
            async () => { throw new Error('No screenshot in HTTP layer'); },
            (dom) => dom.captureChartScreenshot(symbol, screenshotPath),
            (pw) => pw.captureChartScreenshot(symbol, screenshotPath)
          );

          const aiResult = await analyzeChart({
            screenshotPath, symbol,
            changePct: change || 0,
            rsi: indicators.rsi,
            macd: indicators.macd,
            regime: `${macroEquity}/${macroCrypto}`
          });
          state = recordCall(state, aiResult.cost);

          if (shouldWarnBudget(state)) {
            await slack.send(slack.formatAiBudgetWarning({
              monthlyUsed: state.ai_usage.monthly_cost_usd,
              monthlyBudget: state.ai_usage.monthly_budget_usd
            }));
          }

          if (aiResult.action === 'buy') decision = { action: 'buy', portion: 1.0, reason: aiResult.reason };
          else if (aiResult.action === 'sell') decision = { action: 'sell', portion: 0.25, reason: aiResult.reason };
        } catch (err) {
          console.warn(`[AI] ${symbol} analysis failed:`, err.message);
        }
      }

      // Risk check
      const riskResult = check({
        symbol, action: decision.action, state, config,
        portfolioValue, assetValue: (pos.quantity || 0) * currentPrice
      });

      if (!riskResult.approved && decision.action !== 'hold') {
        assetReports.push({ symbol, price: currentPrice, avgCost: pos.avg_cost, change: change || 0, action: 'hold', blocked: true, blockedReason: riskResult.reason });
        if (decision.action === 'buy') {
          await slack.send(slack.formatBlock({ symbol, reason: riskResult.reason, price: currentPrice }));
        }
        continue;
      }

      // Execute trades (skip in dry_run)
      if ((decision.action === 'buy' || decision.action === 'sell') && config.safety?.dry_run) {
        console.log(`[DRY RUN] ${decision.action.toUpperCase()} ${symbol}: ${decision.reason}`);
        assetReports.push({ symbol, price: currentPrice, avgCost: pos.avg_cost, change: change || 0, action: decision.action });
        continue;
      }

      if (decision.action === 'buy') {
        const budget = allocateBudget(symbol, allSymbols, cash, config) * budgetMultiplier;
        if (budget > 0) {
          try {
            const qty = budget / currentPrice;
            await etoroClient.execute(
              (http) => http.openPosition({ instrumentId: symbol, isBuy: true, amount: budget }),
              (dom) => dom.buyAsset({ symbol, amount: budget }),
              (pw) => pw.buyAsset({ symbol, amount: budget })
            );
            const newAvg = calcNewAvgCost(pos.quantity || 0, pos.avg_cost || currentPrice, qty, currentPrice);
            state.positions[symbol] = { ...pos, avg_cost: newAvg, quantity: (pos.quantity || 0) + qty };
            state = updateAfterTrade(state, symbol);
            await slack.send(slack.formatTrade({
              action: 'buy', symbol, price: currentPrice, amount: budget,
              newAvg, cashRemaining: cash - budget, reason: decision.reason
            }));
          } catch (err) {
            console.error(`[Trade] Buy ${symbol} failed:`, err.message);
          }
        }
      } else if (decision.action === 'sell' && pos.quantity > 0) {
        const sellQty = pos.quantity * decision.portion;
        const proceeds = sellQty * currentPrice;
        const pnlThisSell = sellQty * (currentPrice - (pos.avg_cost || currentPrice));
        try {
          await etoroClient.execute(
            (http) => http.closePosition(pos.positionId || symbol),
            (dom) => dom.sellPosition(pos.positionId || symbol),
            (pw) => pw.sellPosition(pos.positionId || symbol)
          );
          state.positions[symbol].quantity -= sellQty;
          if (state.positions[symbol].quantity <= 0.001) state.positions[symbol].avg_cost = null;
          state = updateAfterTrade(state, symbol);
          await slack.send(slack.formatTrade({
            action: 'sell', symbol, price: currentPrice,
            pnl: pnlThisSell, cashRemaining: cash + proceeds,
            tranche: `${(decision.portion * 100).toFixed(0)}%`, reason: decision.reason
          }));
        } catch (err) {
          console.error(`[Trade] Sell ${symbol} failed:`, err.message);
        }
      }

      assetReports.push({ symbol, price: currentPrice, avgCost: pos.avg_cost, change: change || 0, action: decision.action });
    }

    // 4. Send Slack check report
    const totalPnlPct = portfolioValue > 0 ? (totalPnl / (portfolioValue - totalPnl)) * 100 : 0;
    await slack.send(slack.formatCheckReport({
      layer: etoroClient.getActiveLayer(),
      cash,
      portfolioValue,
      assets: assetReports,
      totalPnl,
      totalPnlPct,
      aiUsage: {
        dailyCalls: state.ai_usage.daily_calls,
        dailyLimit: state.ai_usage.daily_limit,
        monthlyCost: state.ai_usage.monthly_cost_usd,
        monthlyBudget: state.ai_usage.monthly_budget_usd
      },
      risk: {
        macroEquity,
        macroCrypto,
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
  config = loadConfig();
  slack = new SlackNotifier(config.slack?.webhook_url);
  etoroClient = new EToroClient(config);

  const intervalMin = config.strategy?.check_interval_minutes || 10;
  console.log(`[Bot] Starting. Interval: ${intervalMin}min. Dry run: ${config.safety?.dry_run}`);
  await slack.send(`🤖 eToro Bot başladı — ${intervalMin}dk aralık, dry_run=${config.safety?.dry_run}`);

  // Run immediately then on schedule
  await runCycle();
  cron.schedule(`*/${intervalMin} * * * *`, runCycle);
}

main().catch(err => {
  console.error('[Bot] Fatal error:', err);
  process.exit(1);
});
