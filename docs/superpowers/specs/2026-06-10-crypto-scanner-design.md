# Crypto Scanner — Design Spec

## Goal

Mevcut momentum botuna, eToro'daki tüm kripto varlıkları her 10 dakikada bir tarayan ve en güçlü momentum'a sahip top N coini otomatik olarak alıp yöneten bir scanner modülü eklemek.

## Architecture

Mevcut sistem korunur. Her `runCycle()` döngüsünün başına "Crypto Scan Pass" eklenir. Bu pass `top5Candidates[]` üretir; mevcut Pass 1 ve Pass 2 bu adayları normal pipeline'dan geçirir.

```
runCycle()
  ├── [YENİ] Crypto Scan Pass
  │     ├── BTC EMA50 gate (1 istek)
  │     ├── ~70 coin → fetch 1H paralel → filtre → puan
  │     └── top5Candidates[] döner
  │
  ├── [MEVCUT] Pass 1 — hold/buy kararları
  │     └── top5 adayları için crypto scanner skoru kullanılır
  │
  └── [MEVCUT] Pass 2 — alım execution
```

## New Files

### `src/analysis/crypto-universe.js`
eToro'da işlem gören ~70 kripto sembolünün statik listesi. Her sembol için Yahoo Finance karşılığı da tutulur.

```js
// Örnek:
const ETORO_CRYPTO = [
  { etoro: 'BTC', yahoo: 'BTC-USD' },
  { etoro: 'ETH', yahoo: 'ETH-USD' },
  { etoro: 'SOL', yahoo: 'SOL-USD' },
  // ... ~70 coin
];
```

### `src/analysis/crypto-scanner.js`
5 filtre + puanlama motorunu çalıştırır. Döndürür: `Promise<CandidateResult[]>`

```js
// CandidateResult shape:
{
  symbol: 'SOL',
  score: 87,
  scores: { rs: 28, volume: 22, adx: 18, btcStrength: 12, rsi: 7 },
  adx: 34.2,
  rsi: 61.5,
  surgRatio: 2.1,
  rs7d: 3.4,
  trend: 'BULL',
}
```

## Modified Files

### `src/index.js`
- `runCycle()` başına `cryptoScanPass()` çağrısı eklenir
- Pass 1 içinde: eğer sembol `top5Candidates`'da ise, `finalScore` olarak scanner skoru kullanılır
- Crypto scanner max_positions kontrolü: açık crypto scanner pozisyon sayısı ≥ max_positions ise yeni alım yapılmaz

### `config.json`
```json
"crypto_scanner": {
  "enabled": true,
  "max_positions": 3,
  "min_score": 65,
  "btc_ema_gate": true,
  "volume_surge_multiplier": 1.5,
  "top_n": 5
}
```

## Filters & Scoring

### Hard Gate: BTC EMA50
BTC 1H kapanış < EMA50(1H) → `cryptoScanPass()` boş dizi döner, yeni crypto alımı yok.

### Filtre 1 — Trend (eleme)
Kaynak: 1H Yahoo Finance verisi (60 gün)
- EMA50 > EMA200
- ADX > 20

İkisi de sağlanmadıysa coin elenir.

### Filtre 2 — Volume Surge (eleme)
Kaynak: son 21 × 1H bar
```
surge_ratio = last_bar_volume / mean(prev_20_bars_volume)
surge_ratio >= volume_surge_multiplier (default 1.5)
```
Sağlanmadıysa elenir.

### Puanlama (0-100)

| Katman | Hesap | Maks |
|--------|-------|------|
| RS Gücü | 7g coin getirisi / BTC getirisi → clamp(0, 5) / 5 × 30 | 30 |
| Hacim Patlaması | clamp(surge_ratio, 1.5, 5) normaliz. | 25 |
| Trend Gücü | clamp(ADX, 20, 50) normaliz. | 20 |
| BTC'ye Karşı Güç | 14g RS, ayrı pencere | 15 |
| RSI Yapısı | RSI 50-70 → 10p, 45-50 veya 70-75 → 5p, dışı → 0 | 10 |

`top_n` (default 5) coin, `min_score` (default 65) üstünde olmalı.

## Data Fetching

Her coin için tek istek:
```
GET https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_symbol}
  ?interval=1h&range=60d
```

60 gün × 24 saat = ~1440 bar. EMA200 için yeterli.

Tüm coinler `Promise.all()` ile paralel çekilir. Mevcut TLS bypass agent kullanılır.

## Position Management

- `state.positions` içinde crypto scanner pozisyonları için `source: 'crypto_scanner'` alanı eklenir
- Açık scanner pozisyon sayısı: `Object.values(state.positions).filter(p => p.source === 'crypto_scanner' && p.quantity > 0).length`
- Bu sayı `max_positions`'a ulaştıysa yeni alım yapılmaz
- Watchlist'te olan coinler (BTC, ETH gibi) scanner top 5'e girerse `source: 'crypto_scanner'` ile işaretlenir; girmezse mevcut momentum skoru geçerli

## Stop-Loss & Exit

Mevcut ATR(14) × `atr_stop_multiplier` kuralı geçerli. Crypto için config'de ayrı `crypto_atr_multiplier` tanımlanabilir (varsayılan: mevcut değer).

## Settings UI

Settings sayfasına "Crypto Scanner" kartı eklenir: enabled toggle, max_positions, min_score, top_n alanları.

## Error Handling

- Bir coinin Yahoo Finance verisi çekilemezse o coin atlanır, diğerleri etkilenmez
- BTC verisi çekilemezse `btc_ema_gate = true` ise tüm pass atlanır (güvenli taraf)
- Rate limit durumunda coin atlanır, log yazılır

## Out of Scope

- 15dk VWAP filtresi (Yahoo rate-limit riski, ileride eklenebilir)
- Dinamik eToro sembol listesi (statik liste yeterli, eToro seyrek günceller)
- Telegram entegrasyonu (mevcut Slack kullanılır)
