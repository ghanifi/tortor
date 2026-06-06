// src/etoro/client.js
// Tries each layer in order. Remembers which layer last worked.
const EToroHTTPClient = require('./http');
const EToroDOM = require('./dom');
const EToroPlaywright = require('./playwright');
const { loadState, saveState } = require('../state');

const LAYER_NAMES = { 1: 'HTTP API', 2: 'Playwright DOM', 3: 'Full Automation' };

class EToroClient {
  constructor(config) {
    this.config = config;
    this.httpClient = new EToroHTTPClient();
    this.domClient = null; // lazily initialized (needs browser launch)
    this.playwrightClient = null;
    this.activeLayer = 1;
  }

  async _ensureDOM() {
    if (!this.domClient) {
      this.domClient = new EToroDOM();
      await this.domClient.launch();
      await this.domClient.login(this.config.etoro.username, this.config.etoro.password);
    }
  }

  async _ensurePlaywright() {
    if (!this.playwrightClient) {
      this.playwrightClient = new EToroPlaywright();
      await this.playwrightClient.launch();
      await this.playwrightClient.login(this.config.etoro.username, this.config.etoro.password);
    }
  }

  async _tryLayer1(op) {
    // Load browser-captured auth session (cookies + JWT) first
    this.httpClient.loadAuthSession();
    // Also apply any Playwright-captured cookies from state (legacy fallback)
    const state = loadState();
    if (state.session?.cookies?.length && !this.httpClient.cookieStr) {
      this.httpClient.setCookies(state.session.cookies);
    }
    return await op(this.httpClient);
  }

  async _tryLayer2(op) {
    await this._ensureDOM();
    return await op(this.domClient);
  }

  async _tryLayer3(op) {
    await this._ensurePlaywright();
    return await op(this.playwrightClient);
  }

  async execute(op1, op2, op3) {
    const layers = [
      { num: 1, fn: () => this._tryLayer1(op1) },
      { num: 2, fn: () => this._tryLayer2(op2) },
      { num: 3, fn: () => this._tryLayer3(op3) }
    ];

    for (const layer of layers) {
      try {
        const result = await layer.fn();
        this.activeLayer = layer.num;
        const state = loadState();
        state.active_layer = layer.num;
        saveState(state);
        return result;
      } catch (err) {
        console.warn(`[Client] Layer ${layer.num} (${LAYER_NAMES[layer.num]}) failed: ${err.message}`);
      }
    }

    throw new Error('All three connection layers failed');
  }

  getActiveLayer() { return this.activeLayer; }

  async close() {
    if (this.domClient) await this.domClient.close();
    if (this.playwrightClient) await this.playwrightClient.close();
  }
}

module.exports = EToroClient;
