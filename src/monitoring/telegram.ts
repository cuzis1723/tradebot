import { Bot, type Context } from 'grammy';
import { config } from '../config/index.js';
import { createChildLogger } from './logger.js';
import { getHyperliquidClient } from '../exchanges/hyperliquid/client.js';
import type { DiscretionaryStrategy } from '../strategies/discretionary/index.js';
import type { Brain } from '../core/brain.js';
import type { TradeProposal, MarketSnapshot } from '../core/types.js';

const log = createChildLogger('telegram');

let bot: Bot | null = null;
let brainRef: Brain | null = null;

export function setDiscretionaryStrategy(strategy: DiscretionaryStrategy): void {
  // Wire up callbacks so strategy can push messages to Telegram
  strategy.onProposal = async (proposal: TradeProposal, snapshot?: MarketSnapshot) => {
    let msg = '';
    if (snapshot) {
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

export function initTelegram(_engine: Record<string, unknown>): Bot | null {
  if (!config.tgBotToken || !config.tgChatId) {
    log.warn('Telegram not configured (TG_BOT_TOKEN or TG_CHAT_ID missing)');
    return null;
  }

  bot = new Bot(config.tgBotToken);

  // === /balance — 잔액 및 포지션 ===

  bot.command('balance', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    try {
      const hl = getHyperliquidClient();
      const [state, spotState] = await Promise.all([
        hl.getAccountState(),
        hl.getSpotBalances(),
      ]);
      const positions = state.assetPositions.filter(
        ap => parseFloat(ap.position.szi) !== 0,
      );

      const totalBalance = spotState.balances
        .filter(b => b.coin.toUpperCase().includes('USDC'))
        .reduce((sum, b) => sum + parseFloat(b.total), 0);
      const marginUsed = parseFloat(state.marginSummary.totalMarginUsed);
      const totalNtlPos = parseFloat(state.marginSummary.totalNtlPos);
      const freeMargin = totalBalance - marginUsed;

      let msg = `<b>Account Balance</b>\n\n`;
      msg += `Total: <b>$${totalBalance.toFixed(2)}</b>\n`;
      msg += `Margin Used: $${marginUsed.toFixed(2)}\n`;
      msg += `Free: $${freeMargin.toFixed(2)}\n`;
      msg += `Notional Position: $${totalNtlPos.toFixed(2)}\n`;

      if (positions.length > 0) {
        msg += `\n<b>Open Positions (${positions.length}):</b>\n`;
        for (const ap of positions) {
          const p = ap.position;
          const size = parseFloat(p.szi);
          const side = size > 0 ? 'LONG' : 'SHORT';
          const upnl = parseFloat(p.unrealizedPnl);
          const upnlStr = upnl >= 0 ? `+$${upnl.toFixed(2)}` : `-$${Math.abs(upnl).toFixed(2)}`;
          msg += `${side} ${p.coin}-PERP ${Math.abs(size)} @ $${parseFloat(p.entryPx).toFixed(2)} | uPnL: ${upnlStr}\n`;
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

  // === /status — 최근 LLM 분석 결과 ===

  bot.command('status', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await ctx.reply('Brain not active.');
      return;
    }
    const formatted = brainRef.formatState();
    await sendLongMessage(ctx, formatted);
  });

  // === /score — 최근 스코어러 분석 결과 (캐시) ===

  bot.command('score', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await ctx.reply('Brain not active.');
      return;
    }
    const state = brainRef.getState();
    const scores = state.latestScores;

    if (!scores || scores.length === 0) {
      await ctx.reply('No score data yet. Wait for next scan cycle.');
      return;
    }

    const scorer = brainRef.getScorer();
    const ago = state.lastUrgentScanAt > 0
      ? `${Math.floor((Date.now() - state.lastUrgentScanAt) / 60_000)}min ago`
      : 'never';

    let msg = `<b>Latest Scores</b> (scanned ${ago})\n\n`;
    const sorted = [...scores].sort((a, b) => b.totalScore - a.totalScore);
    msg += sorted.map(s => scorer.formatScore(s)).join('\n\n');

    await sendLongMessage(ctx, msg);
  });

  // === /do — LLM과 대화 (트레이드, 질문, 실행 등) ===

  bot.command('do', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await ctx.reply('Brain not active.');
      return;
    }
    const command = ctx.message?.text?.replace(/^\/do\s*/, '').trim();
    if (!command) {
      await ctx.reply('Usage: /do &lt;command&gt;\n\nExamples:\n/do 잔고 확인해\n/do spot에서 perp으로 400 USDC 옮겨\n/do ETH 롱 0.01개 5배 레버리지\n/do 모든 포지션 정리해\n/do 펀딩레이트 높은 거 보여줘\n/do 왜 ETH가 떨어지고 있어?', { parse_mode: 'HTML' });
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

  // === /dashboard — 웹 대시보드 링크 ===

  bot.command('dashboard', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    const url = config.dashboardUrl ?? 'http://89.167.31.117:3847';
    await ctx.reply(`<b>Web Dashboard</b>\n\n<a href="${url}">${url}</a>`, { parse_mode: 'HTML' });
  });

  // === /help ===

  bot.command('help', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    await ctx.reply(
      '<b>TradeBot Commands</b>\n\n'
      + '/balance - Account balance &amp; positions\n'
      + '/status - Latest LLM analysis result\n'
      + '/score - Latest scorer metrics\n'
      + '/do &lt;command&gt; - Talk to LLM (trade, ask, transfer, etc)\n'
      + '/dashboard - Web dashboard link\n'
      + '/help - This message',
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
