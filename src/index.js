// src/index.js
const cron = require('node-cron');
const { loadConfig } = require('./config');
const { loadState, saveState } = require('./state');
const EToroClient = require('./etoro/client');
const { analyzeSignals } = require('./analysis/indicators');
const { loadResearchSignals } = require('./analysis/research');
const { fetchSP500History, fetchBTCDominanceHistory, fetchSymbolPrices, fetchSymbolHistories, detectEquityRegime, detectCryptoRegime, detectAssetRegime, applyRegimeAdjustments } = require('./analysis/regime');
const { decide, calcNewAvgCost } = require('./strategies/dca');
const { canCallAI, recordCall, shouldWarnBudget } = require('./analysis/ai_budget');
const { analyzeChart } = require('./analysis/ai_chart');
const { check, updateAfterTrade, checkDrawdown, resetDailyCounters } = require('./risk');
const { calcChange, calcPnL, calcTotalPortfolioValue, allocateBudget } = require('./portfolio');
const SlackNotifier = require('./slack');
const bridge = require('./etoro/bridge');
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

  // Reload config each cycle so watchlist/thresholds changes take effect without restart
  config = loadConfig();

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

    // Normalize portfolio data — structure differs by layer
    const prices = {};
    let normalizedPositions = []; // [{ symbol, units, avgCost }]
    let cash = 0;

    if (portfolioData?.AggregatedResult) {
      // Layer 1: logindata v2 format
      const api = portfolioData.AggregatedResult.ApiResponses;
      const portfolio = api?.PrivatePortfolio?.Content?.ClientPortfolio;
      const rawPositions = portfolio?.Positions || [];
      cash = portfolio?.Credit || 0;

      const rates = api?.Rates?.Content || {};
      const metadata = api?.InstrumentsMetadata?.Content || {};

      // Group positions by InstrumentID (multiple lots → one entry with weighted avg)
      const byInstrument = {};
      for (const pos of rawPositions) {
        const id = String(pos.InstrumentID);
        if (!byInstrument[id]) byInstrument[id] = { totalAmount: 0, totalUnits: 0, symbol: metadata[id]?.SymbolFull || id };
        byInstrument[id].totalAmount += pos.Amount || 0;
        byInstrument[id].totalUnits += pos.Units || 0;
      }
      normalizedPositions = Object.entries(byInstrument).map(([id, g]) => ({
        symbol: g.symbol, instrumentId: id,
        units: g.totalUnits,
        avgCost: g.totalUnits > 0 ? g.totalAmount / g.totalUnits : 0
      }));

      // Current prices from Rates section (mid-price)
      for (const [id, rate] of Object.entries(rates)) {
        const sym = metadata[id]?.SymbolFull || id;
        prices[sym] = (rate.Bid + rate.Ask) / 2;
      }
    } else {
      // Layers 2/3: DOM format
      const rawPositions = portfolioData?.positions || [];
      cash = portfolioData?.cash || 0;
      normalizedPositions = rawPositions.map(p => ({
        symbol: p.symbol, instrumentId: null,
        units: p.units || 0, avgCost: p.avgCost || p.openRate || 0
      }));
      for (const p of rawPositions) {
        if (p.symbol) prices[p.symbol] = p.currentPrice || 0;
      }
    }

    // Update state positions from live data
    for (const pos of normalizedPositions) {
      const sym = pos.symbol;
      if (!sym) continue;
      if (!state.positions[sym]) state.positions[sym] = {};
      state.positions[sym].quantity = pos.units;
      // Set avg_cost from live data if bot hasn't tracked it (pre-existing positions)
      if (!state.positions[sym].avg_cost && pos.avgCost) {
        state.positions[sym].avg_cost = pos.avgCost;
      }
    }

    // Fetch prices from Yahoo Finance for watchlist symbols missing from eToro response
    const missingPriceSymbols = (config.watchlist || []).filter(s => !prices[s]);
    if (missingPriceSymbols.length) {
      try {
        const yahooprices = await fetchSymbolPrices(missingPriceSymbols);
        Object.assign(prices, yahooprices);
      } catch (err) {
        console.warn('[Prices] Yahoo Finance fetch failed:', err.message);
      }
    }

    // Cash: use API value if > 0, otherwise fall back to config override
    const configCash = config.budget?.available_cash ?? 0;
    if (cash === 0 && configCash > 0) {
      cash = configCash;
      console.log(`[Cash] Using config override: $${cash}`);
    }

    // All symbols to evaluate: portfolio + watchlist
    const allSymbols = [...new Set([
      ...Object.keys(state.positions),
      ...(config.watchlist || [])
    ])];

    // Portfolio value + drawdown check
    const portfolioValue = calcTotalPortfolioValue(state.positions, prices, cash);
    state = checkDrawdown(state, portfolioValue);

    // Fetch OHLCV history for all symbols (3 months, daily) for real indicator computation
    let historyMap = {};
    try {
      historyMap = await fetchSymbolHistories(allSymbols);
      console.log(`[History] Fetched for: ${Object.keys(historyMap).join(', ')}`);
    } catch (err) {
      console.warn('[History] Batch fetch failed:', err.message);
    }

    // Load analyst consensus signals from extension-collected research cache
    let researchSignals = {};
    try {
      researchSignals = await loadResearchSignals();
      const covered = Object.keys(researchSignals);
      if (covered.length) console.log(`[Research] Analyst signals: ${covered.join(', ')}`);
    } catch (err) {
      console.warn('[Research] Load failed:', err.message);
    }

    // 3. Process each asset through decision pipeline
    const assetReports = [];
    let totalPnl = 0;

    for (const symbol of allSymbols) {
      const pos = state.positions[symbol] || { avg_cost: null, quantity: 0 };
      const currentPrice = prices[symbol] || 0;
      if (!currentPrice) continue;

      // First time we see a watchlist item with no position: save price as reference.
      // Next cycles will measure dips from this reference, enabling buy signals.
      if (!pos.avg_cost && !pos.quantity) {
        if (!state.positions[symbol]) state.positions[symbol] = {};
        if (!state.positions[symbol].avg_cost) {
          state.positions[symbol].avg_cost = currentPrice;
          console.log(`[Bot] ${symbol}: reference price set at $${currentPrice.toFixed(2)}`);
          assetReports.push({ symbol, price: currentPrice, avgCost: currentPrice, change: 0, action: 'hold', reason: 'İlk gözlem — referans fiyat ayarlandı' });
          continue;
        }
      }

      const change = calcChange(currentPrice, pos.avg_cost);
      const pnl = pos.quantity > 0 ? calcPnL(pos.quantity, pos.avg_cost, currentPrice) : 0;
      totalPnl += pnl;

      const assetClass = config.strategy?.asset_classes?.[symbol] || 'stocks';
      const baseThresholds = config.thresholds?.[assetClass] || config.thresholds?.stocks;

      // Real OHLCV history for indicators + regime
      const hist = historyMap[symbol];

      // Asset regime — use real history if available, fall back to single price
      const assetRegime = detectAssetRegime(hist?.closes?.length >= 14 ? hist.closes : [currentPrice]);
      const { thresholds, budgetMultiplier } = applyRegimeAdjustments(
        baseThresholds, macroEquity, macroCrypto, assetClass, assetRegime
      );

      // Real indicators from OHLCV history
      const indicators = hist && hist.closes.length >= 15
        ? analyzeSignals(hist.closes, hist.highs, hist.lows)
        : { rsi: null, macd: null, bollinger: null, signal: 'neutral' };

      // Analyst consensus from research page (collected by extension)
      const research = researchSignals[symbol] || null;

      let decision = decide({ change: change || 0, thresholds, indicators });

      // Research overlay: if analysts strongly disagree with the DCA decision, downgrade it
      if (research && research.total >= 3) {
        if (decision.action === 'buy' && research.consensusSignal === 'bearish') {
          decision = {
            action: 'hold', portion: 0,
            reason: `${decision.reason} — analist konsensüs SATIŞ (${Math.round(research.sellPct * 100)}% sell, hedef $${research.priceTarget?.toFixed(2) || '?'})`
          };
        } else if (decision.action === 'sell' && research.consensusSignal === 'bullish') {
          // Don't block sells on technical grounds, but note the conflict
          decision = { ...decision, reason: `${decision.reason} — not: analistler AL diyor (${Math.round(research.buyPct * 100)}%)` };
        } else if (decision.action === 'hold' && research.priceTarget && research.priceTarget > currentPrice * 1.15 && research.consensusSignal === 'bullish') {
          // Strong analyst upside + bullish consensus nudges edge to watch more closely
          decision = { ...decision, reason: `${decision.reason} — hedef $${research.priceTarget.toFixed(2)} (analist: ${Math.round(research.buyPct * 100)}% AL)` };
        }
      }

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
        assetReports.push({ symbol, price: currentPrice, avgCost: pos.avg_cost, change: change || 0, action: 'hold', blocked: true, blockedReason: riskResult.reason, reason: decision.reason });
        if (decision.action === 'buy') {
          await slack.send(slack.formatBlock({ symbol, reason: riskResult.reason, price: currentPrice }));
        }
        continue;
      }

      // dry_run: bridge ile simüle et (continue kaldırıldı)
      if ((decision.action === 'buy' || decision.action === 'sell') && config.safety?.dry_run) {
        console.log(`[DRY RUN] ${decision.action.toUpperCase()} ${symbol}: ${decision.reason}`);
        // Bridge varsa simüle et, yoksa sadece logla
        const bridgeReady = await bridge.isAvailable();
        if (!bridgeReady) {
          assetReports.push({ symbol, price: currentPrice, avgCost: pos.avg_cost, change: change || 0, action: decision.action, reason: decision.reason });
          continue;
        }
        // Bridge varsa aşağıdaki execution bloklarına geç (bridge dry_run=true ile çalışır)
      }

      if (decision.action === 'buy') {
        const budget = allocateBudget(symbol, allSymbols, cash, config) * budgetMultiplier;
        if (budget > 0) {
          try {
            const qty = budget / currentPrice;
            // Extension bridge (tarayıcıdan çalışır, Datadome yok)
            const bridgeReady = await bridge.isAvailable();
            if (bridgeReady) {
              await bridge.executeTrade({
                symbol, action: 'buy', amount: budget,
                dryRun: config.safety?.dry_run
              });
            } else {
              // Fallback: doğrudan HTTP/DOM katmanları
              await etoroClient.execute(
                (http) => http.openPosition({ instrumentId: symbol, isBuy: true, amount: budget }),
                (dom) => dom.buyAsset({ symbol, amount: budget }),
                (pw) => pw.buyAsset({ symbol, amount: budget })
              );
            }
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
          const bridgeReady = await bridge.isAvailable();
          if (bridgeReady) {
            await bridge.executeTrade({
              symbol, action: 'sell',
              amount: sellQty * currentPrice,
              positionId: pos.positionId,
              dryRun: config.safety?.dry_run
            });
          } else {
            await etoroClient.execute(
              (http) => http.closePosition(pos.positionId || symbol),
              (dom) => dom.sellPosition(pos.positionId || symbol),
              (pw) => pw.sellPosition(pos.positionId || symbol)
            );
          }
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

      assetReports.push({ symbol, price: currentPrice, avgCost: pos.avg_cost, change: change || 0, action: decision.action, reason: decision.reason });
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
