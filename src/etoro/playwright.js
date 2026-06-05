// src/etoro/playwright.js
// Layer 3: Full Playwright automation with retry logic and error capture.
// Extends DOM client with screenshot-on-failure and retry.
const EToroDOM = require('./dom');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = path.join(process.cwd(), 'logs', 'screenshots');

class EToroPlaywright extends EToroDOM {
  async withRetry(fn, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt === retries) throw err;
        console.warn(`[Layer3] Attempt ${attempt + 1} failed: ${err.message}. Retrying...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  async captureErrorScreenshot(label) {
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const filename = `error_${label}_${Date.now()}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    if (this.page) await this.page.screenshot({ path: filepath, fullPage: true });
    return filepath;
  }

  async getPortfolioPositions() {
    return await this.withRetry(() => super.getPortfolioPositions());
  }

  async buyAsset(opts) {
    return await this.withRetry(() => super.buyAsset(opts));
  }

  async sellPosition(positionId) {
    return await this.withRetry(() => super.sellPosition(positionId));
  }
}

module.exports = EToroPlaywright;
