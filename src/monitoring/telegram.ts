import { Bot, type Context } from 'grammy';
import { config } from '../config/index.js';
import { createChildLogger } from './logger.js';
import { getHyperliquidClient } from '../exchanges/hyperliquid/client.js';
import type { DiscretionaryStrategy } from '../strategies/discretionary/index.js';
import type { ScalpStrategy } from '../strategies/scalp/index.js';
import type { Brain } from '../core/brain.js';
import type { TradeProposal, MarketSnapshot } from '../core/types.js';
import { promptManager, type PromptKey } from '../core/prompt-manager.js';

const log = createChildLogger('telegram');

let bot: Bot | null = null;
let brainRef: Brain | null = null;
let scalpRef: ScalpStrategy | null = null;

// Pending prompt edit (awaiting user confirmation)
let pendingEdit: {
  key: PromptKey;
  newText: string;
  summary: string;
  expiresAt: number;
} | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatLogInterval: ReturnType<typeof setInterval> | null = null;
let lastBotAlive = 0;

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

export function setScalpStrategy(strategy: ScalpStrategy): void {
  scalpRef = strategy;
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

  // === /prompt — LLM 시스템 프롬프트 관리 ===

  bot.command('prompt', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    const args = ctx.message?.text?.replace(/^\/prompt\s*/, '').trim() ?? '';
    const parts = args.split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    // /prompt list
    if (!subcommand || subcommand === 'list') {
      const entries = promptManager.listAll();
      const modifiedCount = entries.filter(e => e.isModified).length;
      let msg = `<b>LLM System Prompts</b> (${entries.length} total, ${modifiedCount} modified)\n\n`;
      entries.forEach((e, i) => {
        const tag = e.isModified ? ' [MODIFIED]' : '';
        msg += `${i + 1}. <code>${e.key}</code> — ${e.description}${tag}\n`;
      });
      msg += `\nCommands:\n/prompt view &lt;key&gt;\n/prompt edit &lt;key&gt; &lt;instruction&gt;\n/prompt reset &lt;key&gt;\n/prompt history &lt;key&gt;`;
      await ctx.reply(msg, { parse_mode: 'HTML' });
      return;
    }

    // /prompt view <key>
    if (subcommand === 'view') {
      const key = parts[1];
      if (!key || !promptManager.isValidKey(key)) {
        await ctx.reply(`Invalid key. Use /prompt list to see available keys.`);
        return;
      }
      const entries = promptManager.listAll();
      const entry = entries.find(e => e.key === key)!;
      const status = entry.isModified
        ? `MODIFIED (${new Date(entry.modifiedAt!).toLocaleString()})`
        : 'DEFAULT';
      const header = `<b>${key}</b> — ${entry.description}\nStatus: ${status}\nLength: ${entry.currentText.length} chars\n\n`;
      await sendLongMessage(ctx, header + entry.currentText);
      return;
    }

    // /prompt edit <key> <instruction>
    if (subcommand === 'edit') {
      const key = parts[1];
      if (!key || !promptManager.isValidKey(key)) {
        await ctx.reply(`Invalid key. Use /prompt list to see available keys.`);
        return;
      }
      const instruction = parts.slice(2).join(' ');
      if (!instruction) {
        await ctx.reply(`Usage: /prompt edit &lt;key&gt; &lt;instruction&gt;\n\nExample: /prompt edit decide_trade 좀 더 보수적으로, 레버리지 최대 10x`, { parse_mode: 'HTML' });
        return;
      }
      if (!brainRef) {
        await ctx.reply('Brain not active.');
        return;
      }

      await ctx.reply('Editing prompt...');

      try {
        const advisor = brainRef.getAdvisor();
        const currentText = promptManager.get(key as PromptKey);

        const metaPrompt = `You are a prompt engineering assistant for a crypto trading bot.

You will receive:
1. The CURRENT system prompt text
2. A user instruction describing how to modify it

Your job:
- Apply the requested changes to the prompt
- Preserve the overall structure and JSON response format requirements
- Do NOT remove safety rules or risk management sections unless explicitly asked
- Keep changes minimal and targeted
- Maintain the same response format instructions

CRITICAL SAFETY RULES (never remove these from any prompt):
- Stop loss requirements
- Maximum leverage caps
- R:R ratio minimums
- JSON response format requirements

Respond with JSON only:
{
  "modified_prompt": "The full modified prompt text...",
  "changes_summary": "Brief description of what was changed",
  "warnings": ["Any safety concerns about the modification"]
}`;

        const userMsg = `CURRENT PROMPT (key: ${key}):\n\`\`\`\n${currentText}\n\`\`\`\n\nINSTRUCTION: ${instruction}`;

        const response = await advisor.callWithSystemPrompt(metaPrompt, userMsg, 'prompt_edit');

        // Parse LLM response
        let jsonStr = response;
        const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) jsonStr = jsonMatch[1].trim();

        const data = JSON.parse(jsonStr);
        const newText = data.modified_prompt;
        const summary = data.changes_summary ?? 'No summary';
        const warnings: string[] = Array.isArray(data.warnings) ? data.warnings : [];

        if (!newText || newText.length < 50) {
          await ctx.reply('LLM returned invalid prompt (too short). Edit cancelled.');
          return;
        }

        // Store pending edit
        pendingEdit = {
          key: key as PromptKey,
          newText,
          summary,
          expiresAt: Date.now() + 5 * 60_000, // 5 min timeout
        };

        let msg = `<b>Prompt Edit Preview</b>\n\n`;
        msg += `Key: <code>${key}</code>\n`;
        msg += `Changes: ${summary}\n`;
        if (warnings.length > 0) {
          msg += `\nWarnings:\n${warnings.map(w => `- ${w}`).join('\n')}\n`;
        }
        msg += `\nNew length: ${newText.length} chars (was ${currentText.length})\n`;
        msg += `\n<b>Apply this change? Reply Y to confirm.</b>`;
        await ctx.reply(msg, { parse_mode: 'HTML' });
      } catch (err) {
        log.error({ err }, '/prompt edit failed');
        await ctx.reply(`Edit failed: ${String(err)}`);
      }
      return;
    }

    // /prompt reset <key>
    if (subcommand === 'reset') {
      const key = parts[1];
      if (!key || !promptManager.isValidKey(key)) {
        await ctx.reply(`Invalid key. Use /prompt list to see available keys.`);
        return;
      }
      promptManager.reset(key as PromptKey);
      await ctx.reply(`Prompt <code>${key}</code> reset to default.`, { parse_mode: 'HTML' });
      return;
    }

    // /prompt history <key>
    if (subcommand === 'history') {
      const key = parts[1];
      if (!key || !promptManager.isValidKey(key)) {
        await ctx.reply(`Invalid key. Use /prompt list to see available keys.`);
        return;
      }
      const history = promptManager.getHistory(key as PromptKey, 5);
      if (history.length === 0) {
        await ctx.reply(`No modification history for <code>${key}</code>.`, { parse_mode: 'HTML' });
        return;
      }
      let msg = `<b>Prompt History: ${key}</b>\n\n`;
      history.forEach((h, i) => {
        const ago = Math.floor((Date.now() - h.timestamp) / 60_000);
        const agoStr = ago < 60 ? `${ago}min ago` : `${Math.floor(ago / 60)}h ago`;
        msg += `${i + 1}. ${agoStr} — ${h.change_description ?? 'no description'}\n`;
      });
      await ctx.reply(msg, { parse_mode: 'HTML' });
      return;
    }

    await ctx.reply(`Unknown subcommand. Use /prompt list, view, edit, reset, or history.`);
  });

  // === /scalp — Scalp 포지션 & 상태 ===

  bot.command('scalp', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!scalpRef) {
      await ctx.reply('Scalp strategy not active.');
      return;
    }

    const status = scalpRef.getStatus();
    const perf = scalpRef.getPerformance();
    const positions = scalpRef.formatPositions();
    const winRate = perf.totalTrades > 0
      ? ((perf.winningTrades / perf.totalTrades) * 100).toFixed(1)
      : '0.0';

    let msg = `<b>⚡ Scalp Strategy</b>\n\n`;
    msg += `Status: ${status === 'running' ? '🟢 Running' : status === 'paused' ? '⏸ Paused' : '⏹ Stopped'}\n`;
    const pnl = perf.totalPnl.toNumber();
    msg += `PnL: <b>${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</b>\n`;
    msg += `Trades: ${perf.totalTrades} (W:${perf.winningTrades} L:${perf.losingTrades}) ${winRate}%\n`;
    msg += `\n${positions}`;

    await ctx.reply(msg, { parse_mode: 'HTML' });
  });

  // === /scalpclose <symbol> — Scalp 포지션 강제 청산 ===

  bot.command('scalpclose', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!scalpRef) {
      await ctx.reply('Scalp strategy not active.');
      return;
    }

    const symbol = ctx.message?.text?.replace(/^\/scalpclose\s*/, '').trim().toUpperCase();
    if (!symbol) {
      await ctx.reply('Usage: /scalpclose &lt;symbol&gt;\nExample: /scalpclose ETH-PERP', { parse_mode: 'HTML' });
      return;
    }

    const result = await scalpRef.handleClosePosition(symbol);
    await ctx.reply(result, { parse_mode: 'HTML' });
  });

  // === /help ===

  bot.command('help', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    await ctx.reply(
      '<b>pangjibot Commands</b>\n\n'
      + '<b>General</b>\n'
      + '/balance - Account balance &amp; positions\n'
      + '/status - Latest LLM analysis result\n'
      + '/score - Latest scorer metrics\n'
      + '/do &lt;command&gt; - Talk to LLM (trade, ask, transfer, etc)\n'
      + '/prompt - Manage LLM system prompts\n'
      + '/dashboard - Web dashboard link\n'
      + '\n<b>Scalp</b>\n'
      + '/scalp - Scalp positions &amp; status\n'
      + '/scalpclose &lt;symbol&gt; - Force close a scalp position\n'
      + '\n/help - This message',
      { parse_mode: 'HTML' }
    );
  });

  // Handle pending prompt edit confirmation (Y/y/yes)
  // NOTE: must be registered AFTER all bot.command() handlers,
  // otherwise bot.on('message:text') swallows commands like /help
  bot.on('message:text', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;

    const text = ctx.message?.text?.trim();
    if (!text) return;

    // Check for pending prompt edit confirmation
    if (pendingEdit && (text === 'Y' || text === 'y' || text.toLowerCase() === 'yes')) {
      if (Date.now() > pendingEdit.expiresAt) {
        pendingEdit = null;
        await ctx.reply('Edit expired (5min timeout). Run /prompt edit again.');
        return;
      }

      promptManager.set(pendingEdit.key, pendingEdit.newText, pendingEdit.summary);
      await ctx.reply(`Prompt <code>${pendingEdit.key}</code> updated successfully.`, { parse_mode: 'HTML' });
      pendingEdit = null;
      return;
    }

    // Clear expired pending edit
    if (pendingEdit && Date.now() > pendingEdit.expiresAt) {
      pendingEdit = null;
    }
  });

  // Start the bot
  bot.start({
    onStart: () => {
      log.info('Telegram bot started');
      lastBotAlive = Date.now();
    },
  });

  // Heartbeat: verify bot connection every 5 minutes
  heartbeatInterval = setInterval(() => {
    if (!bot) return;
    bot.api.getMe().then(() => {
      lastBotAlive = Date.now();
    }).catch((err) => {
      const downtime = Date.now() - lastBotAlive;
      log.error({ err, downtimeMs: downtime }, 'Telegram heartbeat failed — bot may be disconnected');
    });
  }, 5 * 60_000);

  // Periodic heartbeat log every 30 minutes
  heartbeatLogInterval = setInterval(() => {
    const aliveAgo = lastBotAlive > 0 ? Math.floor((Date.now() - lastBotAlive) / 1000) : -1;
    log.info({ lastAliveSecsAgo: aliveAgo }, 'Telegram bot heartbeat: still connected');
  }, 30 * 60_000);

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
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (heartbeatLogInterval) {
    clearInterval(heartbeatLogInterval);
    heartbeatLogInterval = null;
  }
  if (bot) {
    bot.stop();
    bot = null;
  }
}
