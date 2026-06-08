const { RSI, MACD, BollingerBands, ATR, ADX, EMA } = require('technicalindicators');

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const values = RSI.calculate({ values: closes, period });
  return values.length ? values[values.length - 1] : null;
}

function calculateMACD(closes) {
  if (closes.length < 26) return null;
  const values = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  if (!values.length) return null;
  const last = values[values.length - 1];
  return { macd: last.MACD, signal: last.signal, histogram: last.histogram };
}

function calculateBollinger(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const values = BollingerBands.calculate({ values: closes, period, stdDev });
  if (!values.length) return null;
  const last = values[values.length - 1];
  return { upper: last.upper, middle: last.middle, lower: last.lower };
}

function calculateATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const values = ATR.calculate({ high: highs, low: lows, close: closes, period });
  return values.length ? values[values.length - 1] : null;
}

function calculateADX(highs, lows, closes, period = 14) {
  if (closes.length < period * 2) return null;
  const values = ADX.calculate({ close: closes, high: highs, low: lows, period });
  if (!values.length) return null;
  return values[values.length - 1].adx;
}

function calculateEMA(closes, period = 14) {
  if (closes.length < period) return null;
  const values = EMA.calculate({ values: closes, period });
  return values.length ? values[values.length - 1] : null;
}

function analyzeSignals(closes, highs, lows) {
  const rsi = calculateRSI(closes);
  const macd = calculateMACD(closes);
  const bollinger = calculateBollinger(closes);
  const atr = calculateATR(highs, lows, closes);
  const price = closes[closes.length - 1];

  let bullishCount = 0;
  let bearishCount = 0;

  if (rsi !== null) {
    if (rsi < 35) bullishCount++;
    else if (rsi > 65) bearishCount++;
  }
  if (macd !== null && macd.histogram !== null) {
    if (macd.histogram > 0) bullishCount++;
    else if (macd.histogram < 0) bearishCount++;
  }
  if (bollinger !== null) {
    if (price <= bollinger.lower) bullishCount++;
    else if (price >= bollinger.upper) bearishCount++;
  }

  const signal = bullishCount > bearishCount ? 'bullish'
    : bearishCount > bullishCount ? 'bearish'
    : 'neutral';

  return { rsi, macd, bollinger, atr, signal, bullishCount, bearishCount };
}

module.exports = { calculateRSI, calculateMACD, calculateBollinger, calculateATR, calculateADX, calculateEMA, analyzeSignals };
