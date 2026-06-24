'use strict';

const CRYPTO_SYMBOLS = new Set([
  'BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'DOGECOIN', 'BNB', 'AVAX', 'DOT', 'LINK',
  'LTC', 'MATIC', 'UNI', 'ATOM', 'FTM', 'NEAR', 'ALGO', 'VET', 'SHIB', 'TRX'
]);

function getTimeInZone(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  return {
    weekday: parts.weekday,
    hour: parseInt(parts.hour === '24' ? '0' : parts.hour, 10),
    minute: parseInt(parts.minute, 10)
  };
}

function getExchange(symbol) {
  if (CRYPTO_SYMBOLS.has(symbol.toUpperCase())) return 'CRYPTO';
  if (symbol.endsWith('.L')) return 'LSE';
  return 'NYSE';
}

function isMarketOpen(symbol, now = new Date()) {
  const exchange = getExchange(symbol);

  if (exchange === 'CRYPTO') return { open: true, exchange, reason: null };

  const tz = exchange === 'LSE' ? 'Europe/London' : 'America/New_York';
  const { weekday, hour, minute } = getTimeInZone(tz, now);

  if (weekday === 'Sat' || weekday === 'Sun') {
    return { open: false, exchange, reason: 'weekend' };
  }

  const mins = hour * 60 + minute;

  if (exchange === 'LSE') {
    const open = mins >= 8 * 60 && mins < 16 * 60 + 30;
    return { open, exchange, reason: open ? null : 'LSE closed (08:00–16:30 GMT/BST)' };
  }

  // NYSE / NASDAQ
  const open = mins >= 9 * 60 + 30 && mins < 16 * 60;
  return { open, exchange, reason: open ? null : 'NYSE closed (09:30–16:00 ET)' };
}

// Returns true during 00:00–06:59 UTC — lowest liquidity window for crypto.
// New crypto positions opened here face overnight gap risk with no human oversight.
function isCryptoQuietHour(now = new Date()) {
  return now.getUTCHours() < 7;
}

module.exports = { isMarketOpen, getExchange, getTimeInZone, isCryptoQuietHour };
