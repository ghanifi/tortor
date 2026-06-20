// src/analysis/crypto-scanner.js
// Crypto Scan Pass: fetches 1H OHLCV for all eToro crypto, applies
// BTC gate + trend/volume filters, scores survivors, returns top N.
'use strict';

const axios = require('axios');
const https = require('https');
const { calculateEMA, calculateADX, calculateRSI } = require('./indicators');
const { ETORO_CRYPTO } = require('./crypto-universe');

// Same TLS bypass as regime.js (SSL inspection proxy)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchCryptoHistory1H(yahooSymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1h&range=60d`;
  const res = await axios.get(url, { headers: YAHOO_HEADERS, timeout: 10000, httpsAgent });
  const quote = res.data.chart.result[0].indicators.quote[0];
  const raw = (quote.close || [])
    .map((c, i) => ({
      c, h: (quote.high  || [])[i],
      l:    (quote.low   || [])[i],
      v:    (() => { const raw = (quote.volume || [])[i]; return (raw == null || isNaN(raw)) ? 0 : raw; })(),
    }))
    .filter(d => d.c != null && d.h != null && d.l != null);

  // Drop last bar — current incomplete hourly candle must not influence signals
  if (raw.length > 0) raw.pop();

  return {
    closes:  raw.map(d => d.c),
    highs:   raw.map(d => d.h),
    lows:    raw.map(d => d.l),
    volumes: raw.map(d => d.v),
  };
}

async function fetchAllCryptoHistories() {
  const results = {};
  await Promise.all(ETORO_CRYPTO.map(async ({ etoro, yahoo }) => {
    try {
      results[etoro] = await fetchCryptoHistory1H(yahoo);
    } catch (err) {
      console.warn(`[CryptoScanner] ${etoro} verisi alınamadı: ${err.message}`);
    }
  }));
  return results;
}

// ── BTC Gate ──────────────────────────────────────────────────────────────────

// Returns true (gate OPEN) applying ±1% hysteresis to prevent flicker.
// Gate closes only when BTC < EMA×0.99; opens only when BTC > EMA×1.01.
// prevGateOpen: last persisted gate state (undefined → treated as closed).
function btcEmaGate(btcCloses, period = 50, prevGateOpen = false) {
  if (btcCloses.length < period) return false;
  const ema = calculateEMA(btcCloses, period);
  if (ema === null) return false;
  const price = btcCloses[btcCloses.length - 1];
  if (prevGateOpen) {
    // Gate is currently open — close only if price drops below 99% of EMA
    return price >= ema * 0.99;
  } else {
    // Gate is currently closed — open only if price rises above 101% of EMA
    return price > ema * 1.01;
  }
}

// ── Filters ───────────────────────────────────────────────────────────────────

// Filter 1: Trend — EMA50 > EMA200 on 1H (ADX is scored, not gated)
function passTrendFilter(closes, highs, lows) {
  if (closes.length < 200) return false;
  const ema50  = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  return ema50 !== null && ema200 !== null && ema50 > ema200;
}

// Filter 2 + scoring input: volume surge ratio = last_active_bar / mean(prev 20 active bars)
// Yahoo Finance reports 0 volume for incomplete/unreported bars (especially on weekends).
// We skip trailing zeros to find the last real trading bar.
function calcVolumeSurge(volumes) {
  // Find last non-zero bar (signal bar)
  let signalIdx = volumes.length - 1;
  while (signalIdx >= 0 && volumes[signalIdx] === 0) signalIdx--;
  if (signalIdx < 20) return null;

  const signalVol = volumes[signalIdx];

  // Find 20 non-zero bars before the signal bar for the baseline average
  const prevBars = volumes.slice(0, signalIdx).filter(v => v > 0);
  if (prevBars.length < 10) return null;   // need at least 10 real bars
  const recent20 = prevBars.slice(-20);
  const avg = recent20.reduce((a, b) => a + b, 0) / recent20.length;
  if (avg <= 0) return null;
  return signalVol / avg;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// Score a single coin that has already passed filters.
// Returns a CandidateResult (without `symbol`).
function scoreCoin(hist, btcHist) {
  const { closes, highs, lows, volumes } = hist;
  const n   = closes.length;
  const btcN = btcHist.closes.length;

  // ── RS Gücü (max 30): 7-day return / BTC 7-day return ──────────────────────
  const bars7d = 7 * 24;
  let rsPts = 0;
  let rs7d  = null;
  if (n >= bars7d + 1 && btcN >= bars7d + 1) {
    const coin7d = (closes[n - 1] - closes[n - 1 - bars7d]) / closes[n - 1 - bars7d];
    const btc7d  = (btcHist.closes[btcN - 1] - btcHist.closes[btcN - 1 - bars7d]) / btcHist.closes[btcN - 1 - bars7d];
    rs7d  = btc7d !== 0 ? coin7d / btc7d : (coin7d > 0 ? 5 : 0);
    rsPts = Math.round(clamp(rs7d, 0, 5) / 5 * 30);
  }

  // ── Hacim Patlaması (max 25) ────────────────────────────────────────────────
  const surgeRatio = calcVolumeSurge(volumes) ?? 1.5;
  // Score floor is 1.5× — coins below this are filtered out before scoring; no config coupling needed
  const volumePts  = Math.round((clamp(surgeRatio, 1.5, 5) - 1.5) / (5 - 1.5) * 25);

  // ── Trend Gücü / ADX (max 20) ──────────────────────────────────────────────
  const adx    = calculateADX(highs, lows, closes, 14) ?? 20;
  const adxPts = Math.round((clamp(adx, 20, 50) - 20) / (50 - 20) * 20);

  // ── BTC'ye Karşı Güç (max 15): 14-day RS vs BTC ────────────────────────────
  const bars14d = 14 * 24;
  let btcStrengthPts = 0;
  if (n >= bars14d + 1 && btcN >= bars14d + 1) {
    const coin14d = (closes[n - 1] - closes[n - 1 - bars14d]) / closes[n - 1 - bars14d];
    const btc14d  = (btcHist.closes[btcN - 1] - btcHist.closes[btcN - 1 - bars14d]) / btcHist.closes[btcN - 1 - bars14d];
    const rs14d   = btc14d !== 0 ? coin14d / btc14d : (coin14d > 0 ? 5 : 0);
    btcStrengthPts = Math.round(clamp(rs14d, 0, 5) / 5 * 15);
  }

  // ── RSI Yapısı (max 10) ────────────────────────────────────────────────────
  const rsi = calculateRSI(closes, 14);
  let rsiPts = 0;
  if (rsi !== null) {
    if      (rsi >= 50 && rsi <= 70)  rsiPts = 10;
    else if ((rsi >= 45 && rsi < 50) || (rsi > 70 && rsi <= 75)) rsiPts = 5;
  }

  const score = rsPts + volumePts + adxPts + btcStrengthPts + rsiPts;
  return {
    score,
    scores: { rs: rsPts, volume: volumePts, adx: adxPts, btcStrength: btcStrengthPts, rsi: rsiPts },
    adx,
    rsi: rsi ?? null,
    surgeRatio,
    rs7d,
    trend: 'BULL',
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the full crypto scan pass.
 * @param {object} cryptoConfig — from config.json `crypto_scanner` block
 * @param {object} [botState]   — full bot state (loadState()); gate persisted in state.crypto_gate_open
 * @param {Function} [saveStateFn] — saveState() callback; called when gate state changes
 * @returns {Promise<Array<CandidateResult & { symbol: string }>>}
 */
async function runCryptoScan(cryptoConfig = {}, botState = null, saveStateFn = null) {
  const {
    enabled                = true,
    btc_ema_gate           = true,
    btc_ema_period         = 50,
    volume_surge_multiplier = 1.5,
    top_n                  = 5,
    min_score              = 65,
  } = cryptoConfig;

  if (!enabled) return [];

  const histories = await fetchAllCryptoHistories();

  const btcHist = histories['BTC'];

  // BTC data is required for RS scoring regardless of gate setting
  if (!btcHist) {
    console.warn('[CryptoScanner] BTC verisi yok — RS skoru hesaplanamaz, scan atlandı');
    return [];
  }

  // BTC EMA gate with ±1% hysteresis
  if (btc_ema_gate) {
    const prevGateOpen = botState?.crypto_gate_open ?? false;
    const gateOpen = btcEmaGate(btcHist.closes, btc_ema_period, prevGateOpen);
    if (gateOpen !== prevGateOpen && botState && saveStateFn) {
      botState.crypto_gate_open = gateOpen;
      saveStateFn(botState);
      console.log(`[CryptoScanner] BTC gate ${prevGateOpen ? 'OPEN→CLOSED' : 'CLOSED→OPEN'} (EMA${btc_ema_period} histerezis)`);
    }
    if (!gateOpen) {
      console.log(`[CryptoScanner] BTC EMA${btc_ema_period} gate kapalı — bear market, yeni alım yok`);
      return [];
    }
  }

  const candidates = [];
  let diagNoData = 0, diagTrend = 0, diagVolume = 0, diagScore = 0;

  for (const { etoro } of ETORO_CRYPTO) {
    const hist = histories[etoro];
    if (!hist || hist.closes.length < 200) { diagNoData++; continue; }

    if (!passTrendFilter(hist.closes, hist.highs, hist.lows)) { diagTrend++; continue; }

    const surgeRatio = calcVolumeSurge(hist.volumes);
    if (surgeRatio === null || surgeRatio < volume_surge_multiplier) { diagVolume++; continue; }

    const result = scoreCoin(hist, btcHist);
    if (!Number.isFinite(result.score) || result.score < min_score) { diagScore++; continue; }

    candidates.push({ symbol: etoro, ...result });
  }

  console.log(`[CryptoScanner] Eleme: veri yok=${diagNoData} trend=${diagTrend} hacim=${diagVolume} skor=${diagScore}`);

  candidates.sort((a, b) => b.score - a.score);
  const topN = candidates.slice(0, top_n);

  console.log(
    `[CryptoScanner] ${ETORO_CRYPTO.length} coin tarandı → ${candidates.length} aday → ` +
    `top ${topN.length}: ${topN.map(c => `${c.symbol}(${c.score})`).join(', ') || '—'}`
  );

  return topN;
}

module.exports = {
  runCryptoScan,
  // exported for testing:
  btcEmaGate,
  passTrendFilter,
  calcVolumeSurge,
  scoreCoin,
  fetchCryptoHistory1H,
};
