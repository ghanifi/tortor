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
      v:    (quote.volume|| [])[i] ?? 0,
    }))
    .filter(d => d.c != null && d.h != null && d.l != null);
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

// Returns true (gate OPEN) if BTC last price >= EMA50(1H)
function btcEmaGate(btcCloses) {
  if (btcCloses.length < 50) return false;
  const ema50 = calculateEMA(btcCloses, 50);
  if (ema50 === null) return false;
  return btcCloses[btcCloses.length - 1] >= ema50;
}

// ── Filters ───────────────────────────────────────────────────────────────────

// Filter 1: Trend — EMA50 > EMA200 on 1H AND ADX(14) > 20
function passTrendFilter(closes, highs, lows) {
  if (closes.length < 200) return false;
  const ema50  = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  if (!ema50 || !ema200 || ema50 <= ema200) return false;
  const adx = calculateADX(highs, lows, closes, 14);
  return adx !== null && adx > 20;
}

// Filter 2 + scoring input: volume surge ratio = last_bar / mean(prev 20 bars)
// Returns null if data insufficient or avg is 0
function calcVolumeSurge(volumes) {
  if (volumes.length < 21) return null;
  const prev20 = volumes.slice(-21, -1);
  const avg = prev20.reduce((a, b) => a + b, 0) / 20;
  if (avg <= 0) return null;
  return volumes[volumes.length - 1] / avg;
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
    surgRatio: surgeRatio,
    rs7d,
    trend: 'BULL',
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the full crypto scan pass.
 * @param {object} cryptoConfig — from config.json `crypto_scanner` block
 * @returns {Promise<Array<CandidateResult & { symbol: string }>>}
 */
async function runCryptoScan(cryptoConfig = {}) {
  const {
    enabled                = true,
    btc_ema_gate           = true,
    volume_surge_multiplier = 1.5,
    top_n                  = 5,
    min_score              = 65,
  } = cryptoConfig;

  if (!enabled) return [];

  let histories;
  try {
    histories = await fetchAllCryptoHistories();
  } catch (err) {
    console.warn('[CryptoScanner] Veri çekme hatası:', err.message);
    return [];
  }

  const btcHist = histories['BTC'];

  // BTC gate
  if (btc_ema_gate) {
    if (!btcHist) {
      console.warn('[CryptoScanner] BTC verisi yok — gate açık sayılamaz, scan atlandı');
      return [];
    }
    if (!btcEmaGate(btcHist.closes)) {
      console.log('[CryptoScanner] BTC < EMA50(1H) — bear market gate, yeni alım yok');
      return [];
    }
  }

  const candidates = [];

  for (const { etoro } of ETORO_CRYPTO) {
    if (etoro === 'BTC') continue; // BTC already handled as reference
    const hist = histories[etoro];
    if (!hist || hist.closes.length < 200) continue;

    if (!passTrendFilter(hist.closes, hist.highs, hist.lows)) continue;

    const surgeRatio = calcVolumeSurge(hist.volumes);
    if (surgeRatio === null || surgeRatio < volume_surge_multiplier) continue;

    const result = scoreCoin(hist, btcHist || hist);
    if (result.score < min_score) continue;

    candidates.push({ symbol: etoro, ...result });
  }

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
