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
    const time = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const assetLines = assets.map(a => {
      const sign = a.change >= 0 ? '+' : '';
      let status = '⏳ bekle';
      if (a.action === 'buy') status = '🟢 ALINDI';
      else if (a.action === 'sell') status = '🔴 SATILDI';
      else if (a.action === 'edge') status = '🔍 edge zone';
      else if (a.blocked) status = `🚫 ${a.blockedReason}`;
      const reasonSuffix = a.reason ? `  ← ${a.reason}` : '';
      const fmt = (n) => n != null ? `$${Number(n).toFixed(2)}` : '-';
      return `  ${a.symbol.padEnd(6)} ${fmt(a.price)}  avg ${fmt(a.avgCost)}  ${sign}${a.change.toFixed(1)}%  ${status}${reasonSuffix}`;
    }).join('\n');

    const pnlSign = totalPnl >= 0 ? '+' : '';
    const pnlPctSign = totalPnlPct >= 0 ? '+' : '';

    return [
      `🤖 eToro Bot — ${time} Kontrol`,
      ``,
      `📡 Bağlantı: ${LAYER_NAMES[layer] || layer || 'Bilinmiyor'}`,
      `🌍 Regime: Makro=${risk.macroEquity}/${risk.macroCrypto}`,
      `💰 Nakit: $${cash.toFixed(2)} | Portföy: $${portfolioValue.toFixed(2)}`,
      `🤖 AI: ${aiUsage.dailyCalls}/${aiUsage.dailyLimit} günlük | $${aiUsage.monthlyCost.toFixed(2)}/$${aiUsage.monthlyBudget.toFixed(2)} aylık`,
      `⚠️ Risk: ${risk.paused ? 'DURDURULDU' : 'Normal'} | Günlük işlem: ${risk.dailyTrades}/${risk.maxDailyTrades}`,
      ``,
      `📊 Snapshot:`,
      assetLines || '  (portföy boş)',
      ``,
      `📈 Toplam P&L: ${pnlSign}$${Math.abs(totalPnl).toFixed(2)} (${pnlPctSign}${totalPnlPct.toFixed(1)}%)`
    ].join('\n');
  }

  formatTrade({ action, symbol, price, amount, newAvg, cashRemaining, reason, pnl, tranche }) {
    if (action === 'buy') {
      return [
        `🟢 ALIM — ${symbol} (DCA)`,
        `   Fiyat: $${price} | $${amount.toFixed(2)} harcandı`,
        newAvg ? `   Yeni avg: $${newAvg.toFixed(2)} | Kalan nakit: $${cashRemaining.toFixed(2)}` : '',
        reason ? `   Neden: "${reason}"` : ''
      ].filter(Boolean).join('\n');
    }
    const pnlSign = pnl >= 0 ? '+' : '';
    return [
      `🔴 SATIM — ${symbol} (Tranche ${tranche})`,
      `   Fiyat: $${price} | Kâr: ${pnlSign}$${Math.abs(pnl).toFixed(2)}`,
      `   Kalan nakit: $${cashRemaining.toFixed(2)}`,
      reason ? `   Neden: "${reason}"` : ''
    ].filter(Boolean).join('\n');
  }

  formatBlock({ symbol, reason, price }) {
    return `🚫 BLOKE — ${symbol} alımı engellendi\n   Neden: ${reason}\n   Fiyat: $${price}`;
  }

  formatError({ message, lastSuccess }) {
    return [
      `🚨 HATA — Tüm katmanlar başarısız`,
      `   ${message}`,
      `   Son başarılı: ${lastSuccess || 'bilinmiyor'}`,
      `   30 dk sonra tekrar denenecek`
    ].join('\n');
  }

  formatAiBudgetWarning({ monthlyUsed, monthlyBudget }) {
    const pct = ((monthlyUsed / monthlyBudget) * 100).toFixed(0);
    return `⚠️ AI BÜTÇE — %${pct} doldu ($${monthlyUsed.toFixed(2)}/$${monthlyBudget.toFixed(2)})\n   AI analiz devre dışı → sadece teknik indikatörler aktif`;
  }
}

module.exports = SlackNotifier;
