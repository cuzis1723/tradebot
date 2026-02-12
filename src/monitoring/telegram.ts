import { Bot, type Context } from 'grammy';
import { config } from '../config/index.js';
import { createChildLogger } from './logger.js';
import { getTotalPnl, getRecentTrades } from '../data/storage.js';
import { getHyperliquidClient } from '../exchanges/hyperliquid/client.js';
import type { DiscretionaryStrategy } from '../strategies/discretionary/index.js';
import type { Brain } from '../core/brain.js';
import type { TradeProposal, MarketSnapshot } from '../core/types.js';

const log = createChildLogger('telegram');

type EngineRef = {
  getStatus: () => unknown;
  pauseStrategy: (id: string) => void;
  resumeStrategy: (id: string) => void;
  stopAll: () => Promise<void>;
};

let bot: Bot | null = null;
let engineRef: EngineRef | null = null;
let discretionaryRef: DiscretionaryStrategy | null = null;
let brainRef: Brain | null = null;

export function setDiscretionaryStrategy(strategy: DiscretionaryStrategy): void {
  discretionaryRef = strategy;

  // Wire up callbacks so strategy can push messages to Telegram
  strategy.onProposal = async (proposal: TradeProposal, snapshot?: MarketSnapshot) => {
    let msg = '';
    if (snapshot) {
      // Use Brain's analyzer to format the snapshot
      const analyzer = brainRef?.getAnalyzer();
      if (analyzer) {
        msg = analyzer.formatSnapshot(snapshot) + '\n\n';
      }
    }
    msg += strategy.formatProposal(proposal);
    await sendAlert(msg);
  };

  strategy.onMessage = async (msg: string) => {
    await sendAlert(msg);
  };
}

export function setBrain(brain: Brain): void {
  brainRef = brain;
}

export function initTelegram(engine: EngineRef): Bot | null {
  if (!config.tgBotToken || !config.tgChatId) {
    log.warn('Telegram not configured (TG_BOT_TOKEN or TG_CHAT_ID missing)');
    return null;
  }

  bot = new Bot(config.tgBotToken);
  engineRef = engine;

  // === Core Commands ===

  bot.command('status', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    const status = engineRef?.getStatus();
    await ctx.reply(formatStatus(status), { parse_mode: 'HTML' });
  });

  bot.command('pnl', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    const totalPnl = getTotalPnl();
    const trades = getRecentTrades(5);
    let msg = `<b>PnL Summary</b>\n\nTotal PnL: <b>$${totalPnl.toFixed(2)}</b>\n\n`;
    msg += '<b>Recent Trades:</b>\n';
    for (const trade of trades as Array<{ strategy_id: string; symbol: string; side: string; pnl: number; price: number }>) {
      const pnlStr = trade.pnl >= 0 ? `+$${trade.pnl.toFixed(2)}` : `-$${Math.abs(trade.pnl).toFixed(2)}`;
      msg += `${trade.strategy_id} | ${trade.symbol} ${trade.side} @ $${trade.price} | ${pnlStr}\n`;
    }
    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  bot.command('pause', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    const strategyId = ctx.message?.text?.split(' ')[1];
    if (!strategyId) {
      await ctx.reply('Usage: /pause <strategy_id>');
      return;
    }
    engineRef?.pauseStrategy(strategyId);
    await ctx.reply(`Strategy ${strategyId} paused`);
  });

  bot.command('resume', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    const strategyId = ctx.message?.text?.split(' ')[1];
    if (!strategyId) {
      await ctx.reply('Usage: /resume <strategy_id>');
      return;
    }
    engineRef?.resumeStrategy(strategyId);
    await ctx.reply(`Strategy ${strategyId} resumed`);
  });

  bot.command('stop', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    await ctx.reply('Stopping all strategies...');
    await engineRef?.stopAll();
    await ctx.reply('All strategies stopped');
  });

  // === Brain Commands ===

  bot.command('brain', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await ctx.reply('Brain not active.');
      return;
    }
    const subcommand = ctx.message?.text?.split(' ')[1];
    if (subcommand === 'refresh') {
      await ctx.reply('Running comprehensive analysis...');
      const result = await brainRef.forceComprehensive();
      await sendLongMessage(ctx, result);
    } else {
      // Show current state
      const state = brainRef.formatState();
      await sendLongMessage(ctx, state);
    }
  });

  bot.command('market', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await ctx.reply('Brain not active.');
      return;
    }
    await ctx.reply('Analyzing markets...');
    const analyzer = brainRef.getAnalyzer();
    const state = brainRef.getState();
    if (state.latestSnapshots.length === 0) {
      await ctx.reply('No market data available yet. Wait for next scan.');
      return;
    }
    const parts = state.latestSnapshots.map(s => analyzer.formatSnapshot(s));
    await sendLongMessage(ctx, parts.join('\n\n'));
  });

  bot.command('score', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await ctx.reply('Brain not active.');
      return;
    }
    await ctx.reply('Running urgent scan...');
    const result = await brainRef.forceUrgentScan();
    await sendLongMessage(ctx, result);
  });

  bot.command('cooldown', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await ctx.reply('Brain not active.');
      return;
    }
    const status = brainRef.getScorer().getCooldownStatus();
    const state = brainRef.getState();
    const extra = [
      `\nBrain comprehensive: ${state.comprehensiveCount}/day`,
      `Brain urgent LLM: ${state.urgentTriggerCount}/day`,
    ].join('\n');
    await ctx.reply(status + extra, { parse_mode: 'HTML' });
  });

  bot.command('info', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await ctx.reply('Brain not active.');
      return;
    }
    const infoSources = brainRef.getInfoSources();
    const subcommand = ctx.message?.text?.split(' ')[1];
    if (subcommand === 'refresh') {
      await ctx.reply('Fetching external data sources...');
      await infoSources.fetchAll();
    }
    const formatted = infoSources.formatAll();
    await sendLongMessage(ctx, formatted);
  });

  bot.command('balance', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    try {
      const hl = getHyperliquidClient();
      const state = await hl.getAccountState();
      const positions = state.assetPositions.filter(
        ap => parseFloat(ap.position.szi) !== 0,
      );

      const accountValue = parseFloat(state.marginSummary.accountValue);
      const marginUsed = parseFloat(state.marginSummary.totalMarginUsed);
      const totalNtlPos = parseFloat(state.marginSummary.totalNtlPos);
      const freeMargin = accountValue - marginUsed;

      let msg = `<b>Account Balance (Unified)</b>\n\n`;
      msg += `Account Value: <b>$${accountValue.toFixed(2)}</b>\n`;
      msg += `Margin Used: $${marginUsed.toFixed(2)}\n`;
      msg += `Free Margin: $${freeMargin.toFixed(2)}\n`;
      msg += `Notional Position: $${totalNtlPos.toFixed(2)}\n`;

      if (positions.length > 0) {
        msg += `\n<b>Open Positions (${positions.length}):</b>\n`;
        for (const ap of positions) {
          const p = ap.position;
          const size = parseFloat(p.szi);
          const side = size > 0 ? 'LONG' : 'SHORT';
          const sideIcon = size > 0 ? '📈' : '📉';
          const upnl = parseFloat(p.unrealizedPnl);
          const upnlStr = upnl >= 0 ? `+$${upnl.toFixed(2)}` : `-$${Math.abs(upnl).toFixed(2)}`;
          msg += `${sideIcon} ${p.coin}-PERP ${side} ${Math.abs(size)} @ $${parseFloat(p.entryPx).toFixed(2)} | uPnL: ${upnlStr}\n`;
        }
      } else {
        msg += `\nNo open positions.`;
      }

      await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err) {
      log.error({ err }, 'Balance fetch failed');
      await ctx.reply('Failed to fetch account balance.');
    }
  });

  bot.command('usage', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await ctx.reply('Brain not active.');
      return;
    }
    const advisor = brainRef.getAdvisor();
    const stats = advisor.getUsageStats();
    const brainState = brainRef.getState();

    const lastCallAgo = stats.lastCallAt > 0
      ? `${Math.floor((Date.now() - stats.lastCallAt) / 60_000)}min ago`
      : 'never';

    let msg = `<b>LLM Usage Stats</b>\n\n`;
    msg += `Model: <b>${stats.model}</b>\n`;
    msg += `\n<b>Today:</b>\n`;
    msg += `  Calls: ${stats.callsToday}\n`;
    msg += `  Tokens: ${stats.tokensToday.toLocaleString()}\n`;
    msg += `\n<b>All-time (since restart):</b>\n`;
    msg += `  Total Calls: ${stats.totalCalls}\n`;
    msg += `  Input Tokens: ${stats.totalInputTokens.toLocaleString()}\n`;
    msg += `  Output Tokens: ${stats.totalOutputTokens.toLocaleString()}\n`;
    msg += `  Total Tokens: ${stats.totalTokens.toLocaleString()}\n`;
    msg += `  Est. Cost: <b>$${stats.estimatedCostUsd.toFixed(4)}</b>\n`;
    msg += `  Last Call: ${lastCallAgo}\n`;
    msg += `\n<b>Brain Counters (daily):</b>\n`;
    msg += `  Comprehensive: ${brainState.comprehensiveCount}\n`;
    msg += `  Urgent LLM: ${brainState.urgentTriggerCount}\n`;

    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // === Discretionary Trading Commands ===

  bot.command('idea', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await ctx.reply('Brain not active.');
      return;
    }
    const idea = ctx.message?.text?.replace(/^\/idea\s*/, '').trim();
    if (!idea) {
      await ctx.reply('Usage: /idea ETH long 근거: 지지선 근처');
      return;
    }
    await ctx.reply('Evaluating your idea...');
    const advisor = brainRef.getAdvisor();
    const state = brainRef.getState();
    const result = await advisor.evaluateIdea(idea, state.latestSnapshots);
    if (result.action === 'propose_trade' && result.proposal && discretionaryRef) {
      const snapshot = state.latestSnapshots.find(s => s.symbol === result.proposal!.symbol);
      discretionaryRef.receiveProposal(result.proposal, snapshot);
      await sendLongMessage(ctx, discretionaryRef.formatProposal(result.proposal));
    } else {
      await sendLongMessage(ctx, result.content ?? 'No viable trade found for this idea.');
    }
  });

  bot.command('approve', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!discretionaryRef) {
      await ctx.reply('Discretionary strategy not active.');
      return;
    }
    const shortId = ctx.message?.text?.split(' ')[1];
    if (!shortId) {
      await ctx.reply('Usage: /approve <proposal_id>');
      return;
    }
    const proposal = discretionaryRef.getPendingProposal(shortId);
    if (!proposal) {
      await ctx.reply('Proposal not found or expired.');
      return;
    }
    const result = await discretionaryRef.handleApprove(proposal.id);
    await ctx.reply(result, { parse_mode: 'HTML' });
  });

  bot.command('modify', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!discretionaryRef) {
      await ctx.reply('Discretionary strategy not active.');
      return;
    }
    const parts = ctx.message?.text?.split(' ') ?? [];
    const shortId = parts[1];
    if (!shortId) {
      await ctx.reply('Usage: /modify <id> size=10 sl=2400 tp=2700');
      return;
    }
    const proposal = discretionaryRef.getPendingProposal(shortId);
    if (!proposal) {
      await ctx.reply('Proposal not found or expired.');
      return;
    }

    const modifications: Partial<{ size: number; stopLoss: number; takeProfit: number }> = {};
    for (const part of parts.slice(2)) {
      const [key, val] = part.split('=');
      if (key === 'size') modifications.size = parseFloat(val);
      else if (key === 'sl') modifications.stopLoss = parseFloat(val);
      else if (key === 'tp') modifications.takeProfit = parseFloat(val);
    }

    const result = await discretionaryRef.handleModify(proposal.id, modifications);
    await ctx.reply(result, { parse_mode: 'HTML' });
  });

  bot.command('reject', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!discretionaryRef) {
      await ctx.reply('Discretionary strategy not active.');
      return;
    }
    const shortId = ctx.message?.text?.split(' ')[1];
    if (!shortId) {
      await ctx.reply('Usage: /reject <proposal_id>');
      return;
    }
    const proposal = discretionaryRef.getPendingProposal(shortId);
    if (!proposal) {
      await ctx.reply('Proposal not found or expired.');
      return;
    }
    const result = await discretionaryRef.handleReject(proposal.id);
    await ctx.reply(result);
  });

  bot.command('positions', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!discretionaryRef) {
      await ctx.reply('Discretionary strategy not active.');
      return;
    }
    const analysis = await discretionaryRef.handlePositionsRequest();
    await sendLongMessage(ctx, analysis);
  });

  bot.command('close', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!discretionaryRef) {
      await ctx.reply('Discretionary strategy not active.');
      return;
    }
    const symbol = ctx.message?.text?.split(' ')[1];
    if (!symbol) {
      await ctx.reply('Usage: /close ETH-PERP');
      return;
    }
    const normalizedSymbol = symbol.includes('-PERP') ? symbol : `${symbol.toUpperCase()}-PERP`;
    const result = await discretionaryRef.handleClosePosition(normalizedSymbol);
    await ctx.reply(result, { parse_mode: 'HTML' });
  });

  bot.command('ask', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await ctx.reply('Brain not active.');
      return;
    }
    const question = ctx.message?.text?.replace(/^\/ask\s*/, '').trim();
    if (!question) {
      await ctx.reply('Usage: /ask 왜 ETH가 떨어지고 있어?');
      return;
    }
    await ctx.reply('Thinking...');
    const advisor = brainRef.getAdvisor();
    const state = brainRef.getState();
    const answer = await advisor.askQuestion(question, state.latestSnapshots);
    await sendLongMessage(ctx, answer);
  });

  bot.command('do', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await ctx.reply('Brain not active.');
      return;
    }
    const command = ctx.message?.text?.replace(/^\/do\s*/, '').trim();
    if (!command) {
      await ctx.reply('Usage: /do &lt;command&gt;\n\nExamples:\n/do 잔고 확인해\n/do spot에서 perp으로 400 USDC 옮겨\n/do ETH 롱 0.01개 5배 레버리지\n/do 모든 포지션 정리해\n/do 펀딩레이트 높은 거 보여줘', { parse_mode: 'HTML' });
      return;
    }
    await ctx.reply('Executing...');
    try {
      const advisor = brainRef.getAdvisor();
      const state = brainRef.getState();
      const infoSources = brainRef.getInfoSources();
      const infoContext = infoSources.buildLLMContext();
      const result = await advisor.executeWithSkills(command, {
        snapshots: state.latestSnapshots,
        additionalInfo: infoContext !== 'No external data sources available.' ? infoContext : undefined,
      });
      await sendLongMessage(ctx, result);
    } catch (err) {
      log.error({ err }, '/do command failed');
      await ctx.reply(`Execution failed: ${String(err)}`);
    }
  });

  // === Account Management Commands ===

  bot.command('spotbalance', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    try {
      const hl = getHyperliquidClient();
      const spotState = await hl.getSpotBalances();

      let msg = '<b>Spot Token Holdings</b>\n<i>(Unified account — USDC is shared with perp margin)</i>\n\n';
      const nonZero = spotState.balances.filter(b => parseFloat(b.total) > 0);
      if (nonZero.length === 0) {
        msg += 'No spot token holdings.';
      } else {
        for (const b of nonZero) {
          msg += `${b.coin}: <b>${parseFloat(b.total).toFixed(4)}</b>`;
          if (parseFloat(b.hold) > 0) msg += ` (hold: ${parseFloat(b.hold).toFixed(4)})`;
          msg += '\n';
        }
      }
      await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err) {
      log.error({ err }, 'Spot balance fetch failed');
      await ctx.reply('Failed to fetch spot balances.');
    }
  });

  bot.command('transfer', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    const parts = ctx.message?.text?.split(' ') ?? [];
    const amount = parseFloat(parts[1]);
    const direction = parts[2]?.toLowerCase();

    if (!amount || !direction || !['s2p', 'p2s'].includes(direction)) {
      await ctx.reply('Usage: /transfer &lt;amount&gt; &lt;s2p|p2s&gt;\n\n<i>Note: Unified account — Spot USDC is auto-used as perp margin. Transfer is typically not needed.</i>', { parse_mode: 'HTML' });
      return;
    }

    try {
      const hl = getHyperliquidClient();
      const toPerp = direction === 's2p';
      const success = toPerp
        ? await hl.transferSpotToPerp(amount)
        : await hl.transferPerpToSpot(amount);

      if (success) {
        const dir = toPerp ? 'Spot → Perp' : 'Perp → Spot';
        await ctx.reply(`Transfer $${amount} ${dir} completed.`);
      } else {
        await ctx.reply('Transfer failed. Check logs.');
      }
    } catch (err) {
      log.error({ err }, 'Transfer command failed');
      await ctx.reply('Transfer failed.');
    }
  });

  bot.command('withdraw', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    const parts = ctx.message?.text?.split(' ') ?? [];
    const amount = parseFloat(parts[1]);
    const destination = parts[2];

    if (!amount || !destination) {
      await ctx.reply('Usage: /withdraw &lt;amount&gt; &lt;address&gt;', { parse_mode: 'HTML' });
      return;
    }

    try {
      const hl = getHyperliquidClient();
      const success = await hl.initiateWithdrawal(destination, amount);
      if (success) {
        await ctx.reply(`Withdrawal of $${amount} to ${destination.slice(0, 10)}... initiated.`);
      } else {
        await ctx.reply('Withdrawal failed. Check logs.');
      }
    } catch (err) {
      log.error({ err }, 'Withdraw command failed');
      await ctx.reply('Withdrawal failed.');
    }
  });

  bot.command('fills', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    try {
      const count = parseInt(ctx.message?.text?.split(' ')[1] ?? '10');
      const hl = getHyperliquidClient();
      const fills = await hl.getUserFills();
      const recent = fills.slice(0, Math.min(count, 20));

      if (recent.length === 0) {
        await ctx.reply('No recent fills.');
        return;
      }

      let msg = `<b>Recent Fills (${recent.length})</b>\n\n`;
      for (const f of recent) {
        const pnl = parseFloat(f.closedPnl);
        const pnlStr = pnl !== 0 ? (pnl >= 0 ? ` | PnL: +$${pnl.toFixed(2)}` : ` | PnL: -$${Math.abs(pnl).toFixed(2)}`) : '';
        const time = new Date(f.time).toISOString().slice(5, 16).replace('T', ' ');
        msg += `${time} | ${f.coin} ${f.side.toUpperCase()} ${f.sz} @ $${parseFloat(f.px).toFixed(2)} | fee: $${parseFloat(f.fee).toFixed(4)}${pnlStr}\n`;
      }
      await sendLongMessage(ctx, msg);
    } catch (err) {
      log.error({ err }, 'Fills command failed');
      await ctx.reply('Failed to fetch fills.');
    }
  });

  bot.command('fundingpaid', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    try {
      const hours = parseInt(ctx.message?.text?.split(' ')[1] ?? '24');
      const hl = getHyperliquidClient();
      const startTime = Date.now() - hours * 60 * 60 * 1000;
      const funding = await hl.getUserFunding(startTime);

      if (funding.length === 0) {
        await ctx.reply(`No funding payments in the last ${hours}h.`);
        return;
      }

      let totalUsdc = 0;
      let msg = `<b>Funding Payments (${hours}h)</b>\n\n`;
      for (const f of funding.slice(0, 30)) {
        const usdc = parseFloat(f.usdc);
        totalUsdc += usdc;
        const time = new Date(f.time).toISOString().slice(5, 16).replace('T', ' ');
        const sign = usdc >= 0 ? '+' : '';
        msg += `${time} | ${f.coin} | ${sign}$${usdc.toFixed(4)} | rate: ${(parseFloat(f.fundingRate) * 100).toFixed(4)}%\n`;
      }
      const totalSign = totalUsdc >= 0 ? '+' : '';
      msg += `\n<b>Total: ${totalSign}$${totalUsdc.toFixed(4)}</b>`;
      await sendLongMessage(ctx, msg);
    } catch (err) {
      log.error({ err }, 'Funding paid command failed');
      await ctx.reply('Failed to fetch funding payments.');
    }
  });

  bot.command('orders', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    try {
      const hl = getHyperliquidClient();
      const orders = await hl.getOpenOrders() as Array<{ coin: string; side: string; sz: string; limitPx: string; oid: number; timestamp: number }>;

      if (orders.length === 0) {
        await ctx.reply('No open orders.');
        return;
      }

      let msg = `<b>Open Orders (${orders.length})</b>\n\n`;
      for (const o of orders) {
        msg += `#${o.oid} | ${o.coin} ${o.side.toUpperCase()} ${o.sz} @ $${parseFloat(o.limitPx).toFixed(2)}\n`;
      }
      await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err) {
      log.error({ err }, 'Orders command failed');
      await ctx.reply('Failed to fetch open orders.');
    }
  });

  bot.command('cancelall', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    const symbol = ctx.message?.text?.split(' ')[1];
    try {
      const hl = getHyperliquidClient();
      const success = await hl.cancelAllOrders(symbol);
      if (success) {
        await ctx.reply(`All orders cancelled${symbol ? ` for ${symbol}` : ''}.`);
      } else {
        await ctx.reply('Cancel all orders failed.');
      }
    } catch (err) {
      log.error({ err }, 'Cancel all command failed');
      await ctx.reply('Failed to cancel orders.');
    }
  });

  bot.command('closeall', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    try {
      const hl = getHyperliquidClient();
      const success = await hl.closeAllPositions(0.05);
      if (success) {
        await ctx.reply('All positions closed.');
      } else {
        await ctx.reply('Close all positions failed.');
      }
    } catch (err) {
      log.error({ err }, 'Close all command failed');
      await ctx.reply('Failed to close positions.');
    }
  });

  bot.command('rates', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    try {
      const symbol = ctx.message?.text?.split(' ')[1]?.toUpperCase();
      const hl = getHyperliquidClient();
      const assets = await hl.getAssetInfos();

      let filtered = assets.filter(a => a.funding !== 0);
      if (symbol) {
        filtered = filtered.filter(a => a.name.includes(symbol));
      }

      // Sort by absolute funding rate
      filtered.sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding));
      const top = filtered.slice(0, 20);

      if (top.length === 0) {
        await ctx.reply('No funding rates to show.');
        return;
      }

      let msg = '<b>Funding Rates (hourly)</b>\n\n';
      for (const a of top) {
        const rate = (a.funding * 100).toFixed(4);
        const annual = (a.funding * 100 * 24 * 365).toFixed(1);
        msg += `${a.name}: <b>${rate}%</b>/h (${annual}%/yr) | OI: $${(a.openInterest / 1e6).toFixed(2)}M\n`;
      }
      await sendLongMessage(ctx, msg);
    } catch (err) {
      log.error({ err }, 'Rates command failed');
      await ctx.reply('Failed to fetch funding rates.');
    }
  });

  bot.command('fees', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    try {
      const hl = getHyperliquidClient();
      const fees = await hl.getUserFees();
      await ctx.reply(`<b>Fee Schedule</b>\n\n<pre>${JSON.stringify(fees, null, 2)}</pre>`, { parse_mode: 'HTML' });
    } catch (err) {
      log.error({ err }, 'Fees command failed');
      await ctx.reply('Failed to fetch fee info.');
    }
  });

  bot.command('ledger', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    try {
      const days = parseInt(ctx.message?.text?.split(' ')[1] ?? '7');
      const hl = getHyperliquidClient();
      const startTime = Date.now() - days * 24 * 60 * 60 * 1000;
      const entries = await hl.getUserLedger(startTime);

      if (entries.length === 0) {
        await ctx.reply(`No ledger entries in the last ${days} days.`);
        return;
      }

      let msg = `<b>Ledger (${days}d)</b>\n\n`;
      for (const e of entries.slice(0, 20)) {
        const time = new Date(e.time).toISOString().slice(5, 16).replace('T', ' ');
        const usdc = parseFloat(e.delta.usdc);
        const sign = usdc >= 0 ? '+' : '';
        msg += `${time} | ${e.delta.type} | ${sign}$${usdc.toFixed(4)}\n`;
      }
      await sendLongMessage(ctx, msg);
    } catch (err) {
      log.error({ err }, 'Ledger command failed');
      await ctx.reply('Failed to fetch ledger.');
    }
  });

  // === Help ===

  bot.command('help', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    await ctx.reply(
      '<b>TradeBot Commands</b>\n\n'
      + '<b>General:</b>\n'
      + '/status - Bot status\n'
      + '/pnl - PnL summary\n'
      + '/pause &lt;id&gt; - Pause strategy\n'
      + '/resume &lt;id&gt; - Resume strategy\n'
      + '/stop - Stop all\n'
      + '\n<b>Brain (Central Intelligence):</b>\n'
      + '/brain - Current market state &amp; directives\n'
      + '/brain refresh - Force 30-min comprehensive analysis\n'
      + '/market - Market snapshot (all symbols)\n'
      + '/score - Force 5-min urgent scan\n'
      + '/cooldown - LLM cooldown status\n'
      + '/info - External intelligence (Polymarket, DeFi TVL, Trending)\n'
      + '/info refresh - Force re-fetch all sources\n'
      + '\n<b>Account &amp; Wallet:</b>\n'
      + '/balance - Perp account balance &amp; positions\n'
      + '/spotbalance - Spot token holdings\n'
      + '/transfer &lt;amt&gt; &lt;s2p|p2s&gt; - Spot↔Perp transfer\n'
      + '/withdraw &lt;amt&gt; &lt;addr&gt; - Bridge withdrawal\n'
      + '/orders - Open orders\n'
      + '/cancelall [symbol] - Cancel all orders\n'
      + '/closeall - Close all positions\n'
      + '/fills [count] - Recent trade fills\n'
      + '/fundingpaid [hours] - Funding payments\n'
      + '/rates [symbol] - Funding rates\n'
      + '/fees - Fee schedule\n'
      + '/ledger [days] - Deposit/withdrawal history\n'
      + '/usage - LLM token usage &amp; cost\n'
      + '\n<b>Discretionary Trading:</b>\n'
      + '/idea &lt;text&gt; - Evaluate trade idea\n'
      + '/approve &lt;id&gt; - Approve proposal\n'
      + '/modify &lt;id&gt; size=N sl=N tp=N\n'
      + '/reject &lt;id&gt; - Reject proposal\n'
      + '/positions - Position analysis\n'
      + '/close &lt;symbol&gt; - Close position\n'
      + '/ask &lt;question&gt; - Ask about market\n'
      + '/do &lt;command&gt; - LLM executes directly (transfer, trade, etc)\n'
      + '\n/help - This message',
      { parse_mode: 'HTML' }
    );
  });

  // Start the bot
  bot.start({
    onStart: () => {
      log.info('Telegram bot started');
    },
  });

  return bot;
}

function isAuthorized(ctx: Context): boolean {
  const chatId = ctx.chat?.id?.toString();
  return chatId === config.tgChatId;
}

function formatStatus(status: unknown): string {
  if (!status) return 'Engine not available';
  const s = status as {
    running: boolean;
    uptime: number;
    strategies: Array<{ id: string; name: string; status: string; pnl: string }>;
    totalPnl: string;
    totalCapital: string;
  };

  const uptime = Math.floor(s.uptime / 1000 / 60);
  let msg = `<b>TradeBot Status</b>\n\n`;
  msg += `Running: ${s.running ? 'Yes' : 'No'}\n`;
  msg += `Uptime: ${uptime}min\n`;
  msg += `Total PnL: <b>$${s.totalPnl}</b>\n\n`;

  // Brain state
  if (brainRef) {
    const state = brainRef.getState();
    msg += `<b>Brain:</b> ${state.regime} | ${state.direction} | risk ${state.riskLevel}/5\n\n`;
  }

  msg += `<b>Strategies:</b>\n`;
  for (const strat of s.strategies) {
    const icon = strat.status === 'running' ? '🟢' : strat.status === 'paused' ? '🟡' : '🔴';
    msg += `${icon} ${strat.name}: ${strat.status} | PnL: $${strat.pnl}\n`;
  }
  return msg;
}

async function sendLongMessage(ctx: Context, text: string): Promise<void> {
  const maxLen = 4000;
  if (text.length <= maxLen) {
    await ctx.reply(text, { parse_mode: 'HTML' });
    return;
  }

  const chunks: string[] = [];
  let current = '';
  for (const paragraph of text.split('\n\n')) {
    if (current.length + paragraph.length + 2 > maxLen) {
      if (current) chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: 'HTML' });
  }
}

export async function sendAlert(message: string): Promise<void> {
  if (!bot || !config.tgChatId) return;
  try {
    if (message.length > 4000) {
      const chunks = splitMessage(message);
      for (const chunk of chunks) {
        await bot.api.sendMessage(config.tgChatId, chunk, { parse_mode: 'HTML' });
      }
    } else {
      await bot.api.sendMessage(config.tgChatId, message, { parse_mode: 'HTML' });
    }
  } catch (err) {
    log.error({ err }, 'Failed to send Telegram alert');
  }
}

function splitMessage(text: string): string[] {
  const maxLen = 4000;
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function sendTradeAlert(data: {
  strategy: string;
  type: string;
  symbol?: string;
  side?: string;
  price?: string;
  profit?: string;
  totalPnl?: string;
}): Promise<void> {
  const profitStr = data.profit
    ? (parseFloat(data.profit) >= 0 ? `+$${parseFloat(data.profit).toFixed(2)}` : `-$${Math.abs(parseFloat(data.profit)).toFixed(2)}`)
    : '';

  let msg = `<b>Trade Alert</b>\n`;
  msg += `Strategy: ${data.strategy}\n`;
  msg += `Type: ${data.type}\n`;
  if (data.symbol) msg += `Symbol: ${data.symbol}\n`;
  if (data.side) msg += `Side: ${data.side}\n`;
  if (data.price) msg += `Price: $${data.price}\n`;
  if (profitStr) msg += `Profit: <b>${profitStr}</b>\n`;
  if (data.totalPnl) msg += `Total PnL: $${data.totalPnl}\n`;

  await sendAlert(msg);
}

export function stopTelegram(): void {
  if (bot) {
    bot.stop();
    bot = null;
  }
}
