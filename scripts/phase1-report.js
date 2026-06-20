#!/usr/bin/env node
// scripts/phase1-report.js — Faz 1 Ölçüm Raporu
// Çalıştır: node scripts/phase1-report.js
// Strateji mantığına dokunmaz; sadece ölçer ve raporlar.
'use strict';

const axios = require('axios');
const https = require('https');
const path  = require('path');
const fs    = require('fs');

// Load from project root
const { loadConfig } = require('../src/config');
const { loadState }  = require('../src/state');
const { fetchSpreadData } = require('../src/analysis/spread-logger');

const httpsAgent    = new https.Agent({ rejectUnauthorized: false });
const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

const YAHOO_SYM = {
  BTC: 'BTC-USD', ETH: 'ETH-USD', XRP: 'XRP-USD', ADA: 'ADA-USD',
  SOL: 'SOL-USD', DOT: 'DOT-USD', BNB: 'BNB-USD', AVAX: 'AVAX-USD',
  DOGE: 'DOGE-USD', DOGECOIN: 'DOGE-USD',
  'RR.L': 'RR.L', 'VOD.L': 'VOD.L', 'BP.L': 'BP.L', 'VOW3.DE': 'VOW3.DE',
};
function toYahoo(sym) { return YAHOO_SYM[sym] || sym; }

// ── Bar aralığı çekme ────────────────────────────────────────────────────────

async function fetchBars(sym, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${toYahoo(sym)}?interval=${interval}&range=${range}`;
  const res  = await axios.get(url, { headers: YAHOO_HEADERS, timeout: 15000, httpsAgent });
  const result = res.data.chart?.result?.[0];
  if (!result) return [];

  const q = result.indicators.quote[0];
  const closes  = q.close  || [];
  const highs   = q.high   || [];
  const lows    = q.low    || [];

  // Drop last bar — it is the current incomplete candle
  const n = closes.length - 1;
  const bars = [];
  for (let i = 0; i < n; i++) {
    const c = closes[i], h = highs[i], l = lows[i];
    if (c && h && l && c > 0) bars.push({ c, h, l });
  }
  return bars;
}

// Mean (high - low) / close * 100 over the last `limit` completed bars
function avgRange(bars, limit = 200) {
  const sample = bars.slice(-limit);
  if (sample.length === 0) return null;
  const sum = sample.reduce((s, b) => s + (b.h - b.l) / b.c * 100, 0);
  return sum / sample.length;
}

// ── Feed sanity thresholds ───────────────────────────────────────────────────
// Prices above `max` trigger a warning; adjust if a legitimate rally occurs.
const SANITY = {
  SNDK: {
    max:  500,
    note: 'Spun-off from Western Digital (Feb 2024). $2186 aşırı yüksek — ticker/split-adjust kontrolü gerekli',
  },
  INTC: {
    max:  60,
    note: 'Intel; 2025 itibarıyla $20-30 bandında. $134 seviyesi şüpheli — para birimi/ticker doğrulaması gerekli',
  },
};

function feedCheck(sym, price) {
  if (sym === 'RR.L') {
    return `${price.toFixed(0)} pence  ✓ NORMAL (Londra borsası pence cinsinden)`;
  }
  const rule = SANITY[sym];
  if (!rule) return `${price.toFixed(2)}  ✓ eşik tanımsız`;
  if (price > rule.max) {
    return `${price.toFixed(2)}  ⚠️  ŞÜPHELI (> $${rule.max}) — ${rule.note}`;
  }
  return `${price.toFixed(2)}  ✓ ($${rule.max} sınırı altında)`;
}

// ── Tablo çizim yardımcısı ───────────────────────────────────────────────────

function col(val, width, right = true) {
  const s = val == null ? 'N/A' : String(val);
  return right ? s.padStart(width) : s.padEnd(width);
}

// ── Ana rapor ────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const state  = loadState();

  const openSymbols = Object.entries(state.positions || {})
    .filter(([, p]) => (p.quantity || 0) > 0).map(([s]) => s);
  const watchlist = config.watchlist || [];
  const symbols = [...new Set([...watchlist, ...openSymbols])];

  const LINE = '═'.repeat(110);
  const sep  = '─'.repeat(110);

  console.log(`\n${LINE}`);
  console.log('  FAZ 1 — ÖLÇÜM RAPORU');
  console.log(`  Tarih : ${new Date().toISOString()}`);
  console.log(`  Semboller : ${symbols.join(', ')}`);
  console.log(LINE);
  console.log('  NOT: Yahoo bid/ask eToro spread\'inden DARDIR.');
  console.log('       Aşağıdaki spread_pct "taban maliyet"; gerçek eToro roundtrip bunun üstündedir.\n');

  // 1. Spread verisi
  process.stdout.write('→ Yahoo v7 bid/ask çekiliyor... ');
  let spreadData = {};
  try {
    spreadData = await fetchSpreadData(symbols);
    console.log('OK');
  } catch (err) {
    console.log(`HATA: ${err.message}`);
  }

  // 2. 1-dk ve 5-dk bar aralıkları (sembol başına sırayla, rate-limit için bekle)
  console.log('→ 1-dk ve 5-dk bar aralıkları hesaplanıyor (sembol başına ~0.5s bekleniyor)...');
  const barData = {};
  for (const sym of symbols) {
    process.stdout.write(`  ${sym.padEnd(10)}`);
    const result = { avg1m: null, avg5m: null, count1m: 0, count5m: 0 };
    try {
      const bars1m = await fetchBars(sym, '1m', '1d');
      result.avg1m   = avgRange(bars1m, 200);
      result.count1m = bars1m.length;
      process.stdout.write(` 1m:${result.count1m} bars`);
    } catch (err) {
      process.stdout.write(` 1m:ERR(${err.message.slice(0, 30)})`);
    }
    await new Promise(r => setTimeout(r, 250));
    try {
      const bars5m = await fetchBars(sym, '5m', '5d');
      result.avg5m   = avgRange(bars5m, 200);
      result.count5m = bars5m.length;
      process.stdout.write(` 5m:${result.count5m} bars`);
    } catch (err) {
      process.stdout.write(` 5m:ERR(${err.message.slice(0, 30)})`);
    }
    console.log();
    barData[sym] = result;
    await new Promise(r => setTimeout(r, 250));
  }

  // 3. Fizibilite tablosu
  console.log(`\n${LINE}`);
  console.log('  FİZİBİLİTE TABLOSU');
  console.log(sep);
  console.log(
    col('SYMBOL', 10, false) +
    col('SPREAD%',  10) +
    col('ROUNDTRIP%', 12) +
    col('1DK_HAR%',  10) +
    col('5DK_HAR%',  10) +
    col('HAR/MAL',   10) +
    '  KARAR'
  );
  console.log(sep);

  const rows = [];
  for (const sym of symbols) {
    const sd = spreadData[sym];
    const bd = barData[sym];

    const bid    = sd?.bid;
    const ask    = sd?.ask;
    const spread = (bid != null && ask != null && bid > 0)
      ? (ask - bid) / bid * 100 : null;
    const roundtrip = spread != null ? spread * 2 : null;
    const avg1m     = bd?.avg1m ?? null;
    const avg5m     = bd?.avg5m ?? null;
    const ratio     = (roundtrip != null && roundtrip > 0 && avg1m != null)
      ? avg1m / roundtrip : null;

    let verdict;
    if (ratio != null) {
      if (ratio < 2)       verdict = '❌ KAYIP    — har/mal < 2, dakikalaik scalping matematiksel kayip';
      else if (ratio < 3)  verdict = '⚠️  SINIR   — har/mal 2-3, risk yüksek';
      else                 verdict = '✓  YETERLİ — har/mal > 3';
    } else if (spread == null) {
      verdict = '—  spread yok (piyasa kapalı veya piyasa saati dışı)';
    } else {
      verdict = '—  bar verisi alınamadı';
    }

    rows.push({ sym, spread, roundtrip, avg1m, avg5m, ratio, verdict });

    console.log(
      col(sym,      10, false) +
      col(spread    != null ? spread.toFixed(4)    : null, 10) +
      col(roundtrip != null ? roundtrip.toFixed(4) : null, 12) +
      col(avg1m     != null ? avg1m.toFixed(4)     : null, 10) +
      col(avg5m     != null ? avg5m.toFixed(4)     : null, 10) +
      col(ratio     != null ? ratio.toFixed(2)     : null, 10) +
      '  ' + verdict
    );
  }

  console.log(sep);
  console.log('  har/mal = ort_1dk_hareket% / roundtrip_spread%');
  console.log('  Kural: har/mal < 2 → o sembolde dakikalık scalping matematiksel kayıptır.');
  console.log('         har/mal < 3 → sınır bölge, risk/ödül düşük.');
  console.log('  (Spread piyasa açıkken ölçülmesi gerekir; kapalıyken N/A normaldir.)');

  // Kritik uyarılar
  const critical = rows.filter(r => r.ratio != null && r.ratio < 2);
  if (critical.length) {
    console.log(`\n  ⚠️  SCALPING MATEMATİKSEL KAYIP SEMBOLLER: ${critical.map(r => r.sym).join(', ')}`);
    console.log('  Bu semboller için timeframe uzatılması veya strateji değişikliği önerilir.');
  }

  // 4. Feed doğrulama
  console.log(`\n${LINE}`);
  console.log('  FEED DOĞRULAMA');
  console.log(sep);

  for (const sym of symbols) {
    const price = spreadData[sym]?.price;
    if (!price) {
      console.log(`  ${sym.padEnd(10)}: fiyat verisi yok`);
      continue;
    }
    console.log(`  ${sym.padEnd(10)}: ${feedCheck(sym, price)}`);
  }

  console.log(sep);
  console.log('\n  Faz 1 raporu tamamlandı.');
  console.log('  Faz 2\'ye geçmek için onay veriniz.\n');
  console.log(LINE + '\n');

  // 5. JSON olarak kaydet (panel bu dosyayı okur)
  const DATA_DIR  = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const LOG_DIR   = path.join(DATA_DIR, 'logs');
  const REPORT_JSON = path.join(LOG_DIR, 'phase1_report.json');
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  // Feed validation results for JSON output
  const feedResults = {};
  for (const sym of symbols) {
    const price = spreadData[sym]?.price ?? null;
    if (!price) { feedResults[sym] = { price: null, ok: null, note: 'fiyat verisi yok' }; continue; }
    if (sym === 'RR.L') {
      feedResults[sym] = { price, ok: true, note: `${price.toFixed(0)} pence — NORMAL (Londra borsası pence cinsinden)` };
      continue;
    }
    const rule = SANITY[sym];
    if (!rule) { feedResults[sym] = { price, ok: true, note: 'eşik tanımsız' }; continue; }
    feedResults[sym] = price > rule.max
      ? { price, ok: false, note: rule.note }
      : { price, ok: true,  note: `$${rule.max} siniri altinda` };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    symbols,
    feasibility: rows.map(r => ({
      symbol:        r.sym,
      spread_pct:    r.spread    != null ? +r.spread.toFixed(4)    : null,
      roundtrip_pct: r.roundtrip != null ? +r.roundtrip.toFixed(4) : null,
      avg_1m_pct:    r.avg1m     != null ? +r.avg1m.toFixed(4)     : null,
      avg_5m_pct:    r.avg5m     != null ? +r.avg5m.toFixed(4)     : null,
      ratio:         r.ratio     != null ? +r.ratio.toFixed(2)      : null,
      verdict:       r.verdict,
      status: r.ratio == null ? 'unknown'
            : r.ratio < 2    ? 'loss'
            : r.ratio < 3    ? 'marginal'
            : 'ok',
    })),
    feed: feedResults,
  };

  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  console.log(`  Rapor kaydedildi: ${REPORT_JSON}`);
}

main().catch(err => {
  console.error('[Phase1] Fatal:', err.message);
  process.exit(1);
});
