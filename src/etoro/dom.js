// src/etoro/dom.js
// Layer 2: Playwright DOM — reads and interacts with eToro's web UI directly.
// IMPORTANT: CSS selectors marked // VERIFY: must be confirmed against live eToro UI.
const { chromium } = require('playwright');

class EToroDOM {
  constructor() {
    this.browser = null;
    this.page = null;
  }

  async launch() {
    this.browser = await chromium.launch({ headless: false, slowMo: 200 });
    const context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    this.page = await context.newPage();
  }

  async close() {
    if (this.browser) await this.browser.close();
  }

  async login(username, password) {
    await this.page.goto('https://www.etoro.com/login', { waitUntil: 'networkidle' });
    await this.page.fill('[name="username"], [automation-id="e2e-login-input-username"]', username); // VERIFY: selector
    await this.page.fill('[name="password"], [automation-id="e2e-login-input-password"]', password); // VERIFY: selector
    await this.page.click('[automation-id="e2e-login-submit"], button[type="submit"]'); // VERIFY: selector
    await this.page.waitForURL('**/portfolio**', { timeout: 30000 });
  }

  async getCookies() {
    return await this.page.context().cookies();
  }

  async getPortfolioPositions() {
    await this.page.goto('https://www.etoro.com/portfolio', { waitUntil: 'networkidle' });
    // Try to get data from window state first
    const response = await this.page.evaluate(() => {
      return window.__INITIAL_STATE__?.portfolio || null;
    });
    if (response) return response;

    // Fallback: read from DOM table
    // VERIFY: these selectors against live eToro portfolio page
    const rows = await this.page.$$eval(
      '[data-etoro-automation-id="portfolio-overview-table-body-row"]',
      rows => rows.map(row => ({
        symbol: row.querySelector('[automation-id="portfolio-overview-table-body-row-symbol"]')?.textContent?.trim(),
        currentValue: parseFloat(row.querySelector('[automation-id="portfolio-overview-table-body-row-value"]')?.textContent?.replace(/[^0-9.]/g, '') || '0'),
        units: parseFloat(row.querySelector('[automation-id="portfolio-overview-table-body-row-units"]')?.textContent?.replace(/[^0-9.]/g, '') || '0'),
      }))
    );
    return { positions: rows };
  }

  async getAssetPrice(symbol) {
    await this.page.goto(`https://www.etoro.com/markets/${symbol.toLowerCase()}`, { waitUntil: 'networkidle' });
    // VERIFY: selector for current price display
    const priceText = await this.page.$eval(
      '[automation-id="instrument-buy-button-rate"], .price-item',
      el => el.textContent.trim()
    );
    return parseFloat(priceText.replace(/[^0-9.]/g, ''));
  }

  async captureChartScreenshot(symbol, outputPath) {
    await this.page.goto(`https://www.etoro.com/markets/${symbol.toLowerCase()}/chart`, { waitUntil: 'networkidle' });
    await this.page.waitForTimeout(2000); // Wait for chart to render
    // VERIFY: chart container selector
    const chart = await this.page.$('[data-etoro-automation-id="chart-container"], .chart-container');
    if (chart) {
      await chart.screenshot({ path: outputPath });
    } else {
      await this.page.screenshot({ path: outputPath });
    }
    return outputPath;
  }

  async buyAsset({ symbol, amount }) {
    await this.page.goto(`https://www.etoro.com/markets/${symbol.toLowerCase()}`, { waitUntil: 'networkidle' });
    // VERIFY: buy button selector
    await this.page.click('[automation-id="instrument-buy-button"], .buy-button');
    await this.page.waitForTimeout(1000);
    // VERIFY: amount input selector
    await this.page.fill('[automation-id="trade-amount-input"], [name="amount"]', String(amount));
    // VERIFY: open trade button selector
    await this.page.click('[automation-id="trade-open-button"], .open-trade-btn');
    await this.page.waitForTimeout(2000);
  }

  async sellPosition(positionId) {
    await this.page.goto('https://www.etoro.com/portfolio', { waitUntil: 'networkidle' });
    // VERIFY: close position button selector
    await this.page.click(`[data-position-id="${positionId}"] [automation-id="close-position-button"]`);
    await this.page.waitForTimeout(1000);
    await this.page.click('[automation-id="close-position-confirm-button"]'); // VERIFY
    await this.page.waitForTimeout(2000);
  }
}

module.exports = EToroDOM;
