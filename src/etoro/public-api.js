// src/etoro/public-api.js
// eToro Official Public API client — https://public-api.etoro.com
// Auth: x-api-key (public) + x-user-key (private/user key)
// Docs: https://api-portal.etoro.com
const axios = require('axios');
const https = require('https');
const { randomUUID } = require('crypto');

const BASE_URL = 'https://public-api.etoro.com';

// Persistent in-process cache: instrumentId (number) → symbol (string)
// Survives across cycles; prevents "1021" phantom when discover API is flaky
const _symbolCache = new Map();

class EToroPublicAPI {
  constructor({ publicKey, userKey }) {
    this.publicKey = publicKey;
    this.userKey = userKey;
    this.client = axios.create({
      baseURL: BASE_URL,
      timeout: 20000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
  }

  _headers() {
    return {
      'x-api-key': this.publicKey,
      'x-user-key': this.userKey,
      'x-request-id': randomUUID(),
    };
  }

  // ── Portfolio ──────────────────────────────────────────────────────────────

  // Returns { positions, cash } — same shape as EToroDOM.getPortfolioPositions()
  async getPortfolioPositions() {
    const res = await this.client.get('/api/v1/trading/info/real/pnl', { headers: this._headers() });
    const raw = res.data?.clientPortfolio;
    if (!raw) throw new Error('Unexpected portfolio response shape');

    // Group multiple lots of same instrument into one position (weighted avg cost)
    const byInstrument = {};
    for (const p of (raw.positions || [])) {
      const id = p.instrumentID;
      if (!byInstrument[id]) {
        byInstrument[id] = {
          positionId: p.positionID,  // first lot's positionId (used for full close)
          positionIds: [],
          instrumentId: id,
          symbol: null,
          totalUnits: 0,
          totalAmount: 0,
          currentPrice: p.unrealizedPnL?.closeRate || 0,
          pnl: 0,
        };
      }
      const g = byInstrument[id];
      g.positionIds.push(p.positionID);
      g.totalUnits += p.units || 0;
      g.totalAmount += (p.units || 0) * (p.openRate || 0);
      g.pnl += p.unrealizedPnL?.pnL || 0;
    }

    const positions = Object.values(byInstrument).map(g => ({
      positionId: g.positionIds[0],
      positionIds: g.positionIds,
      instrumentId: g.instrumentId,
      symbol: null,
      units: g.totalUnits,
      avgCost: g.totalUnits > 0 ? g.totalAmount / g.totalUnits : 0,
      currentPrice: g.currentPrice,
      currentValue: g.totalUnits * g.currentPrice,
      pnl: g.pnl,
    }));

    // credit field = available cash
    const cash = raw.credit ?? 0;
    return { positions, cash };
  }

  // ── Instrument lookup ──────────────────────────────────────────────────────

  // Resolves a symbol string (e.g. "OKLO") to instrumentID
  async getInstrumentId(symbol) {
    const res = await this.client.get('/api/v1/instruments/discover', {
      headers: this._headers(),
      params: { symbol: symbol.toUpperCase(), fields: 'instrumentId,symbol' },
    });
    return res.data?.items?.[0]?.instrumentId ?? null;
  }

  // Resolves an instrumentID to symbol string
  async getInstrumentSymbol(instrumentId) {
    const res = await this.client.get('/api/v1/instruments/discover', {
      headers: this._headers(),
      params: { instrumentID: instrumentId, fields: 'instrumentId,symbol' },
    });
    return res.data?.items?.[0]?.symbol ?? null;
  }

  // Batch: enrich positions with symbol strings by instrumentID.
  // Uses a module-level cache so a single successful lookup persists for the
  // lifetime of the process — prevents "1021" phantom when discover API is flaky.
  async enrichPositionsWithSymbols(positions) {
    const ids = [...new Set(positions.map(p => p.instrumentId).filter(Boolean))];
    if (ids.length === 0) return positions;

    const map = {};
    // Pre-populate from cache
    for (const id of ids) {
      if (_symbolCache.has(id)) map[id] = _symbolCache.get(id);
    }

    // Fetch any IDs not yet in cache
    const uncached = ids.filter(id => !map[id]);
    await Promise.all(uncached.map(async id => {
      try {
        const res = await this.client.get('/api/v1/instruments/discover', {
          headers: this._headers(),
          params: { instrumentID: id, fields: 'instrumentId,symbol' },
        });
        const item = res.data?.items?.[0];
        if (item?.symbol) {
          map[id] = item.symbol;
          _symbolCache.set(id, item.symbol);   // persist for future cycles
        }
      } catch (_) {}
    }));

    return positions.map(p => ({ ...p, symbol: map[p.instrumentId] || String(p.instrumentId) }));
  }

  // ── Market data ────────────────────────────────────────────────────────────

  // Returns current mid-price for a symbol
  async getAssetPrice(symbol) {
    const instrumentId = await this.getInstrumentId(symbol);
    if (!instrumentId) throw new Error(`Instrument not found: ${symbol}`);

    const res = await this.client.get('/api/v1/market-data/instruments/rates', {
      headers: this._headers(),
      params: { instrumentIds: instrumentId },
    });
    const rates = res.data?.rates || res.data;
    const rate = Array.isArray(rates) ? rates[0] : (rates?.[instrumentId] || rates?.[String(instrumentId)]);
    if (!rate) throw new Error(`No rate data for ${symbol}`);
    return (rate.bid + rate.ask) / 2;
  }

  // Returns daily closing price history for an instrument
  async getClosingPriceHistory(instrumentId) {
    const res = await this.client.get('/api/v1/market-data/instruments/history/closing-price', {
      headers: this._headers(),
      params: { instrumentIds: instrumentId },
    });
    return res.data;
  }

  // Returns OHLCV candles for an instrument
  // direction: 'asc' or 'desc', interval: e.g. 'OneHour', 'OneDay', count: max 1000
  async getCandles(instrumentId, { direction = 'desc', interval = 'OneDay', count = 365 } = {}) {
    const res = await this.client.get(
      `/api/v1/market-data/instruments/${instrumentId}/history/candles/${direction}/${interval}/${count}`,
      { headers: this._headers() }
    );
    return res.data;
  }

  // ── Trading ────────────────────────────────────────────────────────────────

  // Buy: opens a new position by amount (USD)
  // Returns { positionId, openRate, orderId }
  async buyAsset({ symbol, amount, leverage = 1 }) {
    const instrumentId = await this.getInstrumentId(symbol);
    if (!instrumentId) throw new Error(`Instrument not found: ${symbol}`);

    // Body must be PascalCase per eToro API spec
    const res = await this.client.post('/api/v1/trading/execution/market-open-orders/by-amount', {
      InstrumentID: instrumentId,
      IsBuy: true,
      Leverage: leverage,
      Amount: amount,
    }, { headers: this._headers() });

    const data = res.data;
    if (data.isSucceeded === false) throw new Error(`Buy failed: ${JSON.stringify(data)}`);
    return {
      positionId: data.positionID ?? data.orderID,
      openRate: data.openRate,
      orderId: data.orderID,
    };
  }

  // Sell: closes an entire position by positionId
  // symbolOrId: positionId (number) preferred; symbol string resolved if needed
  async sellPosition(positionIdOrSymbol) {
    let positionId = positionIdOrSymbol;

    // If string (symbol), find the open position and use all its lot IDs
    let instrumentId = null;
    if (typeof positionIdOrSymbol === 'string') {
      const { positions } = await this.getPortfolioPositions();
      const enriched = await this.enrichPositionsWithSymbols(positions);
      const pos = enriched.find(p => p.symbol?.toUpperCase() === positionIdOrSymbol.toUpperCase());
      if (!pos) throw new Error(`No open position for symbol: ${positionIdOrSymbol}`);
      positionId = pos.positionIds || [pos.positionId];
      instrumentId = pos.instrumentId;
    } else if (positionIdOrSymbol?.instrumentId) {
      instrumentId = positionIdOrSymbol.instrumentId;
      positionId = positionIdOrSymbol.positionIds || [positionIdOrSymbol.positionId || positionIdOrSymbol];
    }

    // If position object was passed with multiple lots, close all
    const idsToClose = Array.isArray(positionId) ? positionId : [positionId];

    // InstrumentId required by close endpoint — resolve from portfolio if not yet known
    if (!instrumentId) {
      const { positions } = await this.getPortfolioPositions();
      const pos = positions.find(p => p.positionIds?.includes(idsToClose[0]) || p.positionId === idsToClose[0]);
      instrumentId = pos?.instrumentId;
    }
    if (!instrumentId) throw new Error(`Cannot resolve instrumentId for positionId ${idsToClose[0]}`);

    for (const pid of idsToClose) {
      const res = await this.client.post(
        `/api/v1/trading/execution/market-close-orders/positions/${pid}`,
        { InstrumentId: instrumentId },
        { headers: this._headers() }
      );
      const data = res.data;
      if (data.isSucceeded === false) throw new Error(`Sell failed for positionId ${pid}: ${JSON.stringify(data)}`);
    }
    return { positionId: idsToClose[0], closed: true };
  }
}

module.exports = EToroPublicAPI;
