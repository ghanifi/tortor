// src/etoro/client.js
// eToro Official Public API — tek katman.
const EToroPublicAPI = require('./public-api');

class EToroClient {
  constructor(config) {
    this.api = new EToroPublicAPI({
      publicKey: config.etoro.publicApiKey,
      userKey: config.etoro.userApiKey,
    });
  }

  async getPortfolioPositions() {
    const raw = await this.api.getPortfolioPositions();
    const positions = await this.api.enrichPositionsWithSymbols(raw.positions);
    return { positions, cash: raw.cash };
  }

  async getAssetPrice(symbol) {
    return await this.api.getAssetPrice(symbol);
  }

  async buyAsset({ symbol, amount }) {
    return await this.api.buyAsset({ symbol, amount });
  }

  async sellPosition(positionIdOrSymbolOrObj) {
    return await this.api.sellPosition(positionIdOrSymbolOrObj);
  }
}

module.exports = EToroClient;
