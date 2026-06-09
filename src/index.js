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
const { auditTrade } = require('./analysis/ai-auditor');
const { canCallAI, recordCall } = require('./analysis/ai_budget');
const { logDecision } = require('./analysis/decision-logger');
const { calcFinalScore, scoreToTier } = require('./analysis/final-score');
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

async function executeBuy({ symbol, pos, tranche, reason, currentPrice, atr, state, scores, strongBuy, portfolioValue }) {
  const sizes           = config.strategy?.pyramid_sizes        || [0.4, 0.3, 0.3];
  const baseSize        = sizes[tranche - 1]                    || 0.33;
  // Strong Buy: L1 tranche gets 25% larger (capped at 0.6)
  const trancheSize     = (strongBuy && tranche === 1)
    ? Math.min(0.6, baseSize * 1.25)
    : baseSize;
  const atrMult         = config.strategy?.atr_stop_multiplier  || 2.0;
  const riskPerTradePct = config.strategy?.risk_per_trade_pct   ?? 0.75;
  const minReserve      = config.safety?.min_cash_reserve       || 0;

  const budget = calcPositionBudget({
    totalAccountValue: (state.cash || 0) + portfolioValue,
    currentPrice,
    atr:               atr || 0,
    atrStopMultiplier: atrMult,
    riskPerTradePct,
    trancheSize,
    availableCash:     state.cash || 0,
    minCashReserve:    minReserve,
  });

  if (budget <= 0) {
    console.warn(`[Trade] Buy ${symbol} skipped: budget=0 (cash=$${(state.cash||0).toFixed(2)}, reserve=$${minReserve}, atr=${atr})`);
    return { state, success: false, failReason: `Bütçe yetersiz ($${(state.cash||0).toFixed(2)} nakit, $${minReserve} rezerv)` };
  }

  const qty = budget / currentPrice;

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

    logEntry({ symbol, tranche, price: currentPrice, qty, amount: budget,
      stopPrice: state.positions[symbol]?.stop_price ?? null,
      reason, scores: scores || {} });

    if (config.safety?.dry_run) {
      console.log(`[DRY RUN] BUY ${symbol} L${tranche} $${budget.toFixed(2)}: ${reason}`);
    }
    return { state, success: true, failReason: null };
  } catch (err) {
    console.error(`[Trade] Buy ${symbol} failed:`, err.message);
    return { state, success: false, failReason: `eToro API hatası: ${err.message}` };
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
      console.log(`[Breadth] ${breadthState}: ${breadthCount}/${breadth.total ?? 11} sektör MA50 üzerinde`);
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
          state = await executeSell({ symbol: sym, pos, portion: 1, reason: 'Market state: PANIC — acil çıkış', currentPrice: price, state, marketState: 'PANIC' });
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
    const cycleTs = new Date().toISOString();
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
        const exitResult = checkExitTrigger({
          pos, currentPrice, assetRegime,
          currentMarketState, prevMarketState
        });

        if (exitResult.exit) {
          const market = isMarketOpen(symbol);
          if (!market.open && market.exchange !== 'CRYPTO') {
            assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason: `Piyasa kapalı (çıkış ertelendi) — ${exitResult.reason}` });
            logDecision({ ...decisionData, decision: 'hold', failReason: `Piyasa kapalı — ${exitResult.reason}` });
            continue;
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

      // d. Entry filters
      const pyramidLevel  = pos.pyramid_level || 0;
      const adxThreshold  = config.strategy?.adx_threshold     || 20;
      const entryScore    = config.strategy?.entry_score        ?? 70;
      const strongScore   = config.strategy?.strong_buy_score   ?? 85;

      let allFiltersPass = true;
      let failReason = null;
      const filterLog = {};

      // ── Hard gates (binary — override score) ────────────────────────────────
      const minState = config.strategy?.min_global_state || 'RISK_ON';
      if (currentMarketState !== minState) {
        allFiltersPass = false;
        failReason = `Market state: ${currentMarketState} (${minState} gerekli)`;
        filterLog.market_state = 'FAIL';
      } else {
        filterLog.market_state = 'PASS';
        if (assetRegime.trend === 'BEAR') {
          allFiltersPass = false;
          failReason = `Trend filtresi: BEAR (BULL veya SIDEWAYS gerekli)`;
          filterLog.trend = 'FAIL';
        } else {
          filterLog.trend = 'PASS';
          if (!assetRegime.adx || assetRegime.adx <= adxThreshold) {
            allFiltersPass = false;
            failReason = `ADX filtresi: ${assetRegime.adx?.toFixed(1) || 'null'} ≤ ${adxThreshold} (trend gücü yetersiz)`;
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
                      failReason = `Final skor: ${finalScore} < ${entryScore} | AI: ${audit.reason}`;
                      filterLog.final_score = 'FAIL';
                      filterLog.ai_audit    = 'FAIL';
                    }
                  } catch (err) {
                    console.warn(`[AI Override] ${symbol} hata:`, err.message);
                    allFiltersPass = false;
                    failReason = `Final skor: ${finalScore} < ${entryScore} (RS:${rsScore?.toFixed(0) ?? '?'} Tek:${techScore} Mkt:${marketScore} Breadth:${breadthCount}/11)`;
                    filterLog.final_score = 'FAIL';
                  }
                } else {
                  allFiltersPass = false;
                  failReason = `Final skor: ${finalScore} < ${entryScore} (AI bütçe aşıldı: ${aiCheck.reason})`;
                  filterLog.final_score = 'FAIL';
                }
              } else {
                allFiltersPass = false;
                failReason = `Final skor: ${finalScore} < ${entryScore} (RS:${rsScore?.toFixed(0) ?? '?'} Tek:${techScore} Mkt:${marketScore} Breadth:${breadthCount}/11)`;
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
        buyCandidates.push({ symbol, pos, currentPrice, changePct, assetRegime, decision, rsScore: rsScore ?? 0, techScore, techResult, marketScore, filterLog, decisionData, tier: decisionData.tier });
      } else {
        assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason: decision.reason });
        logDecision({ ...decisionData, filters: filterLog, decision: 'hold', failReason: decision.reason });
      }
    }

    // Pass 2: execute buys ranked by RS score (strongest signal first)
    buyCandidates.sort((a, b) => b.rsScore - a.rsScore);

    const corrMax = config.strategy?.correlation_max ?? 0.85;

    for (const { symbol, pos, currentPrice, changePct, assetRegime, decision, rsScore, techScore, techResult, marketScore, filterLog, decisionData, tier } of buyCandidates) {
      // Correlation check (Layer 7) — only for new entries (tranche 1), not pyramid additions
      if (decision.tranche === 1) {
        const corrResult = checkCorrelation(historyMap[symbol]?.closes || [], state.positions, historyMap, corrMax);
        if (corrResult.blocked) {
          const reason = `Korelasyon filtresi: ${corrResult.with} ile r=${corrResult.correlation.toFixed(2)}`;
          assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason });
          logDecision({ ...decisionData, filters: { ...filterLog, correlation: 'FAIL' }, decision: 'hold', failReason: reason });
          continue;
        }
        filterLog.correlation = 'PASS';

        // AI Auditor (Layer 14) — final gate for new entries
        // Skip if AI was already called in Pass 1 (override mode promoted this candidate)
        let aiVerdict = decisionData.aiVerdict ?? null;
        let aiReason  = decisionData.aiReason  ?? null;
        const aiMode  = config.strategy?.ai_mode || 'gate';
        const aiCheck = canCallAI(state);
        if (aiMode !== 'disabled' && !aiVerdict && aiCheck.allowed) {
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
              const reason = `AI Denetçi: ${audit.reason}`;
              assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason });
              logDecision({ ...decisionData, filters: { ...filterLog, ai_audit: 'FAIL' }, decision: 'hold', failReason: reason, aiVerdict, aiReason });
              continue;
            }
            filterLog.ai_audit = 'PASS';
            console.log(`[AI Auditor] ${symbol}: BUY — ${audit.reason}`);
          } catch (err) {
            console.warn(`[AI Auditor] ${symbol} denetim başarısız, devam ediliyor:`, err.message);
            filterLog.ai_audit = 'SKIP';
          }
        } else if (aiVerdict) {
          // Already called in Pass 1 (override mode) — treat as PASS
          filterLog.ai_audit = 'PASS';
          console.log(`[AI Auditor] ${symbol}: Pass 1'de onaylandı (${aiVerdict})`);
        } else {
          filterLog.ai_audit = 'SKIP';
          const skipReason = aiCheck.reason || (aiMode === 'disabled' ? 'AI devre dışı' : 'bilinmiyor');
          console.log(`[AI Auditor] ${symbol}: atlandı — ${skipReason}`);
        }
      } else {
        filterLog.correlation = 'SKIP';
        filterLog.ai_audit    = 'SKIP';
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
        const reason = `Piyasa kapalı — ${market.reason}`;
        assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'hold', reason });
        logDecision({ ...decisionData, filters: filterLog, decision: 'hold', failReason: reason });
        continue;
      }

      const buyReason = tier === 'STRONG_BUY'
        ? `[STRONG BUY:${decisionData.finalScore}] ${decision.reason}`
        : `[Score:${decisionData.finalScore}] ${decision.reason}`;

      const buyResult = await executeBuy({
        symbol, pos, tranche: decision.tranche,
        reason: buyReason, currentPrice,
        atr: assetRegime.atr, state,
        strongBuy: tier === 'STRONG_BUY',
        portfolioValue,
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
        assetReports.push({ symbol, price: currentPrice, change: changePct, action: 'buy', reason: buyReason });
        logDecision({ ...decisionData, filters: filterLog, decision: 'buy', tranche: decision.tranche, failReason: null });
      } else {
        const execFailReason = buyResult.failReason || 'Alım başarısız';
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
  await slack.send(`🤖 eToro Bot v3 Momentum başladı — ${intervalMin}dk aralık, dry_run=${config.safety?.dry_run}`);

  await runCycle();
  cron.schedule(`*/${intervalMin} * * * *`, runCycle);
}

main().catch(err => {
  console.error('[Bot] Fatal error:', err);
  process.exit(1);
});
