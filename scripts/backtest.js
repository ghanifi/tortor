#!/usr/bin/env node
// scripts/backtest.js
// Generates historical trade records by walking 2 years of OHLCV data
// through the same layer logic the live bot uses.
//
// Output: data/logs/backtest_trades.jsonl
// Each record is identical to live trades.jsonl but has source:"backtest"
//
// Usage:
//   node scripts/backtest.js
//   node scripts/backtest.js --symbols TSLA,NVDA,BTC --years 2
//   node scripts/backtest.js --append   (keep existing records, add new ones)

const path  = require('path');
const fs    = require('fs');
const https = require('https');
const axios = require('axios');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
process.env.DATA_DIR = DATA_DIR;

// Read only the unencrypted strategy fields — no BOT_SECRET needed
function loadConfig() {
  const configPath = path.join(DATA_DIR, 'config.json');
  const fallback   = path.join(process.cwd(), 'config.json');
  const raw = JSON.parse(fs.readFileSync(fs.existsSync(configPath) ? configPath : fallback, 'utf8'));
  return raw;
}
const { detectAssetRegimeV3 }   = require('../src/analysis/regime');
const { fetchSymbolHistory }    = require('../src/analysis/regime');
const { calcRelativeStrength }  = require('../src/analysis/relative-strength');
const { calcTechnicalScore }    = require('../src/analysis/technical-score');
const { decideMomentum, checkExitTrigger } = require('../src/strategies/momentum');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const LOG_DIR    = path.join(DATA_DIR, 'logs');
const OUT_FILE   = path.join(LOG_DIR, 'backtest_trades.jsonl');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const symArg  = args.find(a => a.startsWith('--symbols=') || args[args.indexOf('--symbols') + 1]);
const yearArg = args.find(a => a.startsWith('--years='))   || null;
const append  = args.includes('--append');

function getArg(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  const inline = args.find(a => a.startsWith(flag + '='));
  return inline ? inline.split('=')[1] : null;
}

const yearsBack = parseInt(getArg('--years') || '2', 10);
const range     = yearsBack <= 1 ? '1y' : '2y';

// ── Yahoo Finance fetch ───────────────────────────────────────────────────────
async function fetchYahoo(symbol, r = range) {
  try {
    return await fetchSymbolHistory(symbol, r);
  } catch (err) {
    console.warn(`  [fetch] ${symbol} başarısız: ${err.message}`);
    return null;
  }
}

async function fetchYahooCloses(symbol, r = range) {
  const h = await fetchYahoo(symbol, r);
  return h ? h.closes : [];
}

// ── Simplified market state for each day ─────────────────────────────────────
// Uses SPY MA50 + VIX proxy (SPY only for speed — avoids fetching 6 symbols × 500 days)
function buildMarketStateSlice(spyCloses, vixCloses, i) {
  const spy = spyCloses.slice(0, i + 1);
  if (spy.length < 50) return 'RISK_NEUTRAL';
  const ma50 = spy.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const spyAbove = spy[spy.length - 1] > ma50;

  let score = spyAbove ? 35 : 0; // simplified: SPY alone can reach RISK_ON proxy

  // VIX contribution if data available
  if (vixCloses.length > i) {
    const vix = vixCloses[i];
    if (vix < 20) score += 35;
    else if (vix <= 30) score += 15;
  } else {
    score += 20; // neutral assumption when VIX unavailable
  }

  if (score >= 55) return 'RISK_ON';
  if (score >= 30) return 'RISK_NEUTRAL';
  return 'RISK_OFF';
}

// ── Benchmark 20-day return at day i ─────────────────────────────────────────
function benchmarkReturn20d(closes, i) {
  if (i < 20) return 0;
  return ((closes[i] - closes[i - 20]) / closes[i - 20]) * 100;
}

// ── Write a record ────────────────────────────────────────────────────────────
function writeRecord(record) {
  fs.appendFileSync(OUT_FILE, JSON.stringify({ ...record, source: 'backtest' }) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const config  = loadConfig();
  fs.mkdirSync(LOG_DIR, { recursive: true });

  if (!append && fs.existsSync(OUT_FILE)) fs.unlinkSync(OUT_FILE);

  const symbolsArg = getArg('--symbols');
  const symbols    = symbolsArg
    ? symbolsArg.split(',').map(s => s.trim().toUpperCase())
    : config.watchlist || [];

  if (!symbols.length) {
    console.error('Sembol bulunamadı. config.json watchlist veya --symbols kullan.');
    process.exit(1);
  }

  console.log(`\n📊 Backtest başlatılıyor — ${range} veri, ${symbols.length} sembol`);
  console.log(`Semboller: ${symbols.join(', ')}\n`);

  // Fetch market data
  process.stdout.write('Piyasa verisi çekiliyor (SPY, VIX)... ');
  const [spyData, vixData] = await Promise.all([
    fetchYahooCloses('SPY'),
    fetchYahooCloses('^VIX'),
  ]);
  console.log('✓');

  // Fetch all symbol histories
  process.stdout.write('Sembol geçmişleri çekiliyor... ');
  const histMap = {};
  await Promise.all(symbols.map(async sym => {
    histMap[sym] = await fetchYahoo(sym);
  }));
  console.log('✓\n');

  let totalEntries = 0;
  let totalExits   = 0;

  for (const symbol of symbols) {
    const hist = histMap[symbol];
    if (!hist || hist.closes.length < 60) {
      console.log(`⚠ ${symbol}: yetersiz veri, atlandı`);
      continue;
    }

    const { closes, highs, lows, volumes } = hist;
    const N = closes.length;

    // Thresholds from config
    const adxThreshold  = config.strategy?.adx_threshold         || 20;
    const rsThreshold   = config.strategy?.rs_threshold          || 70;
    const techThreshold = config.strategy?.technical_threshold   || 65;
    const atrMult       = config.strategy?.atr_stop_multiplier   || 2.0;
    const sizes         = config.strategy?.pyramid_sizes         || [0.4, 0.3, 0.3];

    // Simulated position state for this symbol
    let pos = {
      pyramidLevel: 0, quantity: 0, avgCost: null,
      entryPrice: null, level2Price: null, level3Price: null,
      stopPrice: null, atrAtEntry: null,
    };

    let symEntries = 0;
    let symExits   = 0;

    // Walk forward — start at day 60 to have enough history
    for (let i = 60; i < N; i++) {
      const closeSlice  = closes.slice(0, i + 1);
      const highSlice   = highs.slice(0,  i + 1);
      const lowSlice    = lows.slice(0,   i + 1);
      const volSlice    = volumes.slice(0, i + 1);
      const currentPrice = closes[i];

      // Layer 1 (simplified): market state
      const vixIdx = Math.min(i, vixData.length - 1);
      const marketState = buildMarketStateSlice(spyData, vixData, Math.min(i, spyData.length - 1));
      if (marketState === 'RISK_OFF') {
        // Exit open positions on RISK_OFF (simplified state degradation)
        if (pos.pyramidLevel > 0) {
          const pnl    = (currentPrice - pos.avgCost) * pos.quantity;
          const pnlPct = ((currentPrice - pos.avgCost) / pos.avgCost) * 100;
          writeRecord({
            ts: new Date(Date.now() - (N - i) * 86400000).toISOString(),
            type: 'exit', symbol, price: +currentPrice.toFixed(4),
            qty: +pos.quantity.toFixed(6),
            proceeds: +(currentPrice * pos.quantity).toFixed(2),
            pnl: +pnl.toFixed(2), pnl_pct: +pnlPct.toFixed(2),
            result: pnl >= 0 ? 'WIN' : 'LOSS',
            reason: 'Market state: RISK_OFF — pozisyon küçültüldü',
            market_state: marketState,
          });
          pos = { pyramidLevel: 0, quantity: 0, avgCost: null, entryPrice: null, level2Price: null, level3Price: null, stopPrice: null, atrAtEntry: null };
          symExits++;
        }
        continue;
      }

      // Layer 2: regime
      const regime = detectAssetRegimeV3(closeSlice, highSlice, lowSlice);

      // Layer 3: RS score
      let rsScore = null;
      if (closeSlice.length >= 21 && spyData.length > i) {
        const assetRet = ((closeSlice[closeSlice.length - 1] - closeSlice[closeSlice.length - 21]) / closeSlice[closeSlice.length - 21]) * 100;
        const benchRet = benchmarkReturn20d(spyData, Math.min(i, spyData.length - 1));
        rsScore = calcRelativeStrength(assetRet, benchRet);
      }

      // Layer 6: technical score
      const techResult = calcTechnicalScore(closeSlice, highSlice, lowSlice, volSlice);
      const techScore  = techResult.score;

      // Check exit triggers for open positions
      if (pos.pyramidLevel > 0) {
        const simPos = {
          quantity: pos.quantity, avg_cost: pos.avgCost,
          pyramid_level: pos.pyramidLevel,
          entry_price: pos.entryPrice, stop_price: pos.stopPrice,
        };
        const prevMarket = marketState; // simplified: same for exit check
        const exitResult = checkExitTrigger({
          pos: simPos, currentPrice, assetRegime: regime,
          currentMarketState: marketState, prevMarketState: prevMarket,
        });

        if (exitResult.exit) {
          const sellQty = pos.quantity * exitResult.portion;
          const pnl     = sellQty * (currentPrice - pos.avgCost);
          const pnlPct  = ((currentPrice - pos.avgCost) / pos.avgCost) * 100;
          writeRecord({
            ts: new Date(Date.now() - (N - i) * 86400000).toISOString(),
            type: 'exit', symbol, price: +currentPrice.toFixed(4),
            qty: +sellQty.toFixed(6),
            proceeds: +(sellQty * currentPrice).toFixed(2),
            pnl: +pnl.toFixed(2), pnl_pct: +pnlPct.toFixed(2),
            result: pnl >= 0 ? 'WIN' : 'LOSS',
            reason: exitResult.reason, market_state: marketState,
          });
          symExits++;
          if (exitResult.portion >= 1) {
            pos = { pyramidLevel: 0, quantity: 0, avgCost: null, entryPrice: null, level2Price: null, level3Price: null, stopPrice: null, atrAtEntry: null };
          } else {
            pos.quantity -= sellQty;
            pos.pyramidLevel = Math.max(0, pos.pyramidLevel - 1);
          }
          continue;
        }
      }

      // Entry filters
      let allFiltersPass = true;
      let failReason = null;
      if (marketState !== 'RISK_ON') {
        allFiltersPass = false; failReason = `Market state: ${marketState}`;
      } else if (regime.trend !== 'BULL') {
        allFiltersPass = false; failReason = `Trend: ${regime.trend}`;
      } else if (!regime.adx || regime.adx <= adxThreshold) {
        allFiltersPass = false; failReason = `ADX: ${regime.adx?.toFixed(1) || 'null'}`;
      } else if (rsScore === null || rsScore < rsThreshold) {
        allFiltersPass = false; failReason = `RS: ${rsScore?.toFixed(0) || '?'}`;
      } else if (techScore < techThreshold) {
        allFiltersPass = false; failReason = `Tech: ${techScore}`;
      }

      const decision = decideMomentum({
        pyramidLevel:  pos.pyramidLevel,
        currentPrice,
        entryPrice:    pos.entryPrice,
        level2Price:   pos.level2Price,
        atr:           regime.atr || 0,
        filters:       { allPass: allFiltersPass, failReason },
      });

      if (decision.action !== 'buy') continue;

      const tranche     = decision.tranche;
      const trancheSize = sizes[tranche - 1] || 0.33;
      const budget      = 1000 * trancheSize; // fixed $1000 notional per position
      const qty         = budget / currentPrice;
      const stopPrice   = currentPrice - atrMult * (regime.atr || 1);

      // Update simulated position
      if (tranche === 1) {
        pos = { pyramidLevel: 1, quantity: qty, avgCost: currentPrice,
                entryPrice: currentPrice, level2Price: null, level3Price: null,
                stopPrice, atrAtEntry: regime.atr };
      } else if (tranche === 2) {
        const newAvg = ((pos.quantity * pos.avgCost) + (qty * currentPrice)) / (pos.quantity + qty);
        pos = { ...pos, pyramidLevel: 2, quantity: pos.quantity + qty,
                avgCost: newAvg, level2Price: currentPrice, stopPrice };
      } else if (tranche === 3) {
        const newAvg = ((pos.quantity * pos.avgCost) + (qty * currentPrice)) / (pos.quantity + qty);
        pos = { ...pos, pyramidLevel: 3, quantity: pos.quantity + qty,
                avgCost: newAvg, level3Price: currentPrice, stopPrice };
      }

      writeRecord({
        ts: new Date(Date.now() - (N - i) * 86400000).toISOString(),
        type: 'entry', symbol, tranche,
        price:  +currentPrice.toFixed(4),
        qty:    +qty.toFixed(6),
        amount: +budget.toFixed(2),
        stop_price: +stopPrice.toFixed(4),
        reason: decision.reason,
        scores: {
          market_state:  marketState,
          market_score:  null,
          trend:         regime.trend,
          adx:           regime.adx   != null ? +regime.adx.toFixed(2)   : null,
          atr:           regime.atr   != null ? +regime.atr.toFixed(4)   : null,
          rs_score:      rsScore      != null ? +rsScore.toFixed(1)       : null,
          tech_score:    techScore    != null ? +techScore.toFixed(0)     : null,
          pyramid_level: tranche,
        },
      });
      symEntries++;
    }

    // Close any open position at end of backtest period
    if (pos.pyramidLevel > 0) {
      const lastPrice = closes[N - 1];
      const pnl       = (lastPrice - pos.avgCost) * pos.quantity;
      const pnlPct    = ((lastPrice - pos.avgCost) / pos.avgCost) * 100;
      writeRecord({
        ts: new Date().toISOString(),
        type: 'exit', symbol, price: +lastPrice.toFixed(4),
        qty: +pos.quantity.toFixed(6),
        proceeds: +(lastPrice * pos.quantity).toFixed(2),
        pnl: +pnl.toFixed(2), pnl_pct: +pnlPct.toFixed(2),
        result: pnl >= 0 ? 'WIN' : 'LOSS',
        reason: 'Backtest sonu — pozisyon kapatıldı', market_state: 'RISK_ON',
      });
      symExits++;
    }

    console.log(`✓ ${symbol.padEnd(8)} ${symEntries} giriş, ${symExits} çıkış`);
    totalEntries += symEntries;
    totalExits   += symExits;
  }

  const lines = fs.existsSync(OUT_FILE)
    ? fs.readFileSync(OUT_FILE, 'utf8').split('\n').filter(Boolean).length
    : 0;

  console.log(`\n✅ Backtest tamamlandı`);
  console.log(`   Toplam: ${totalEntries} giriş + ${totalExits} çıkış = ${lines} kayıt`);
  console.log(`   Dosya: ${OUT_FILE}`);
}

main().catch(err => {
  console.error('Backtest hatası:', err);
  process.exit(1);
});
