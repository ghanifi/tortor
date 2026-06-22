const axios = require('axios');
const https = require('https');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const LAYER_NAMES = { 'Public API': 'eToro Public API' };

class SlackNotifier {
  constructor(webhookUrl) {
    this.webhookUrl = webhookUrl;
  }

  async send(text) {
    if (!this.webhookUrl) { console.log('[Slack]', text); return; }
    try {
      await axios.post(this.webhookUrl, { text }, { httpsAgent });
    } catch (err) {
      console.error('[Slack error]', err.message);
    }
  }

  formatCheckReport({ layer, cash, portfolioValue, assets, totalPnl, totalPnlPct, aiUsage, risk }) {
    const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
    const assetLines = assets.map(a => {
      let status = '⏳ hold';
      if (a.action === 'buy') status = '🟢 BOUGHT';
      else if (a.action === 'sell') status = '🔴 SOLD';
      else if (a.action === 'edge') status = '🔍 edge zone';
      else if (a.blocked) status = `🚫 ${a.blockedReason}`;
      const reasonSuffix = a.reason ? `  ← ${a.reason}` : '';
      const fmt = (n) => n != null ? `$${Number(n).toFixed(2)}` : '-';
      const changeStr = a.change != null ? `${a.change >= 0 ? '+' : ''}${a.change.toFixed(1)}%` : '-';
      return `  ${a.symbol.padEnd(6)} ${fmt(a.price)}  avg ${fmt(a.avgCost)}  ${changeStr}  ${status}${reasonSuffix}`;
    }).join('\n');

    const pnlSign = totalPnl >= 0 ? '+' : '';
    const pnlPctSign = totalPnlPct >= 0 ? '+' : '';

    return [
      `🤖 eToro Bot — ${time} Cycle`,
      ``,
      `📡 Connection: ${LAYER_NAMES[layer] || layer || 'Unknown'}`,
      `🌍 Regime: Macro=${risk.macroEquity}/${risk.macroCrypto}`,
      `💰 Cash: $${cash.toFixed(2)} | Portfolio: $${portfolioValue.toFixed(2)}`,
      `🤖 AI: ${aiUsage.dailyCalls}/${aiUsage.dailyLimit} daily | $${aiUsage.monthlyCost.toFixed(2)}/$${aiUsage.monthlyBudget.toFixed(2)} monthly`,
      `⚠️ Risk: ${risk.paused ? 'PAUSED' : 'Normal'} | Daily trades: ${risk.dailyTrades}/${risk.maxDailyTrades}`,
      ``,
      `📊 Snapshot:`,
      assetLines || '  (portfolio empty)',
      ``,
      `📈 Total P&L: ${pnlSign}$${Math.abs(totalPnl).toFixed(2)} (${pnlPctSign}${totalPnlPct.toFixed(1)}%)`
    ].join('\n');
  }

  formatTrade({ action, symbol, price, amount, newAvg, cashRemaining, reason, pnl, tranche }) {
    if (action === 'buy') {
      return [
        `🟢 BUY — ${symbol} (DCA)`,
        `   Price: $${price} | $${amount.toFixed(2)} spent`,
        newAvg ? `   New avg: $${newAvg.toFixed(2)} | Remaining cash: $${cashRemaining.toFixed(2)}` : '',
        reason ? `   Reason: "${reason}"` : ''
      ].filter(Boolean).join('\n');
    }
    const pnlSign = pnl >= 0 ? '+' : '';
    return [
      `🔴 SELL — ${symbol} (Tranche ${tranche})`,
      `   Price: $${price} | P&L: ${pnlSign}$${Math.abs(pnl).toFixed(2)}`,
      `   Remaining cash: $${cashRemaining.toFixed(2)}`,
      reason ? `   Reason: "${reason}"` : ''
    ].filter(Boolean).join('\n');
  }

  formatBlock({ symbol, reason, price }) {
    return `🚫 BLOCKED — ${symbol} buy blocked\n   Reason: ${reason}\n   Price: $${price}`;
  }

  formatError({ message, lastSuccess, retryIn = 10, attempt = 1 }) {
    const attemptStr = attempt > 1 ? ` (attempt ${attempt})` : '';
    return [
      `🚨 ERROR — eToro API unreachable${attemptStr}`,
      `   ${message}`,
      `   Last success: ${lastSuccess || 'unknown'}`,
      `   Retry in ${retryIn} min`
    ].join('\n');
  }

  formatAiBudgetWarning({ monthlyUsed, monthlyBudget }) {
    const pct = ((monthlyUsed / monthlyBudget) * 100).toFixed(0);
    return `⚠️ AI BUDGET — ${pct}% used ($${monthlyUsed.toFixed(2)}/$${monthlyBudget.toFixed(2)})\n   AI analysis disabled → technical indicators only`;
  }
}

module.exports = SlackNotifier;
