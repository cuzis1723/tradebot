import { Bot, type Context } from 'grammy';
import { config } from '../config/index.js';
import { createChildLogger } from './logger.js';
import { getTotalPnl, getRecentTrades } from '../data/storage.js';
import type { DiscretionaryStrategy } from '../strategies/discretionary/index.js';
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

export function setDiscretionaryStrategy(strategy: DiscretionaryStrategy): void {
  discretionaryRef = strategy;

  // Wire up callbacks so strategy can push messages to Telegram
  strategy.onProposal = async (proposal: TradeProposal, snapshot: MarketSnapshot) => {
    const marketMsg = strategy['analyzer'].formatSnapshot(snapshot);
    const proposalMsg = strategy.formatProposal(proposal);
    await sendAlert(`${marketMsg}\n\n${proposalMsg}`);
  };

  strategy.onMessage = async (msg: string) => {
    await sendAlert(msg);
  };
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

  // === Discretionary Trading Commands ===

  bot.command('market', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!discretionaryRef) {
      await ctx.reply('Discretionary strategy not active.');
      return;
    }
    await ctx.reply('Analyzing markets...');
    const analysis = await discretionaryRef.handleMarketRequest();
    await sendLongMessage(ctx, analysis);
  });

  bot.command('idea', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!discretionaryRef) {
      await ctx.reply('Discretionary strategy not active.');
      return;
    }
    const idea = ctx.message?.text?.replace(/^\/idea\s*/, '').trim();
    if (!idea) {
      await ctx.reply('Usage: /idea ETH long 근거: 지지선 근처');
      return;
    }
    await ctx.reply('Evaluating your idea...');
    const response = await discretionaryRef.handleIdeaRequest(idea);
    await sendLongMessage(ctx, response);
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
    if (!discretionaryRef) {
      await ctx.reply('Discretionary strategy not active.');
      return;
    }
    const question = ctx.message?.text?.replace(/^\/ask\s*/, '').trim();
    if (!question) {
      await ctx.reply('Usage: /ask 왜 ETH가 떨어지고 있어?');
      return;
    }
    await ctx.reply('Thinking...');
    const answer = await discretionaryRef.handleAskQuestion(question);
    await sendLongMessage(ctx, answer);
  });

  // === Scoring Commands (v2) ===

  bot.command('score', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!discretionaryRef) {
      await ctx.reply('Discretionary strategy not active.');
      return;
    }
    await ctx.reply('Scanning markets...');
    const scoreReport = await discretionaryRef.handleScoreRequest();
    await sendLongMessage(ctx, scoreReport);
  });

  bot.command('cooldown', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!discretionaryRef) {
      await ctx.reply('Discretionary strategy not active.');
      return;
    }
    const status = discretionaryRef.handleCooldownRequest();
    await ctx.reply(status, { parse_mode: 'HTML' });
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
      + '\n<b>Discretionary Trading:</b>\n'
      + '/market - Market analysis\n'
      + '/score - Trigger score scan\n'
      + '/cooldown - LLM cooldown status\n'
      + '/idea &lt;text&gt; - Evaluate trade idea\n'
      + '/approve &lt;id&gt; - Approve proposal\n'
      + '/modify &lt;id&gt; size=N sl=N tp=N\n'
      + '/reject &lt;id&gt; - Reject proposal\n'
      + '/positions - Position analysis\n'
      + '/close &lt;symbol&gt; - Close position\n'
      + '/ask &lt;question&gt; - Ask about market\n'
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
