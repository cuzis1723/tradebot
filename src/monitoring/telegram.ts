import { Bot, type Context } from 'grammy';
import { config } from '../config/index.js';
import { createChildLogger } from './logger.js';
import { getHyperliquidClient } from '../exchanges/hyperliquid/client.js';
import type { DiscretionaryStrategy } from '../strategies/discretionary/index.js';
import type { ScalpStrategy } from '../strategies/scalp/index.js';
import type { Brain } from '../core/brain.js';
import type { DailyReporter } from '../core/daily-report.js';
import type { TradeProposal, MarketSnapshot } from '../core/types.js';
import { promptManager, type PromptKey } from '../core/prompt-manager.js';
import { getRecentLifecycles, saveTelegramMessage } from '../data/storage.js';

const log = createChildLogger('telegram');

let bot: Bot | null = null;
let brainRef: Brain | null = null;
let scalpRef: ScalpStrategy | null = null;
let reporterRef: DailyReporter | null = null;

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

export function setDailyReporter(reporter: DailyReporter): void {
  reporterRef = reporter;
}

export function initTelegram(_engine: Record<string, unknown>): Bot | null {
  if (!config.tgBotToken || !config.tgChatId) {
    log.warn('Telegram not configured (TG_BOT_TOKEN or TG_CHAT_ID missing)');
    return null;
  }

  bot = new Bot(config.tgBotToken);

  // Log all incoming messages to DB
  bot.use(async (ctx, next) => {
    if (ctx.message?.text && isAuthorized(ctx)) {
      const text = ctx.message.text;
      const cmd = text.startsWith('/') ? text.split(/\s+/)[0].substring(1).split('@')[0] : undefined;
      logIncoming(ctx, cmd);
    }
    await next();
  });

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

      await replyAndLog(ctx, msg, { parse_mode: 'HTML' });
    } catch (err) {
      log.error({ err }, 'Balance fetch failed');
      await replyAndLog(ctx, 'Failed to fetch account balance.');
    }
  });

  // === /status — 최근 LLM 분석 결과 ===

  bot.command('status', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await replyAndLog(ctx, 'Brain not active.');
      return;
    }
    const formatted = brainRef.formatState();
    await sendLongMessage(ctx, formatted);
  });

  // === /score — 최근 스코어러 분석 결과 (캐시) ===

  bot.command('score', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await replyAndLog(ctx, 'Brain not active.');
      return;
    }
    const state = brainRef.getState();
    const scores = state.latestScores;

    if (!scores || scores.length === 0) {
      await replyAndLog(ctx, 'No score data yet. Wait for next scan cycle.');
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
      await replyAndLog(ctx, 'Brain not active.');
      return;
    }
    const command = ctx.message?.text?.replace(/^\/do\s*/, '').trim();
    if (!command) {
      await replyAndLog(ctx, 'Usage: /do &lt;command&gt;\n\nExamples:\n/do 잔고 확인해\n/do spot에서 perp으로 400 USDC 옮겨\n/do ETH 롱 0.01개 5배 레버리지\n/do 모든 포지션 정리해\n/do 펀딩레이트 높은 거 보여줘\n/do 왜 ETH가 떨어지고 있어?', { parse_mode: 'HTML' });
      return;
    }
    await replyAndLog(ctx, 'Executing...');
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
      await replyAndLog(ctx, `Execution failed: ${String(err)}`);
    }
  });

  // === /dashboard — 웹 대시보드 링크 ===

  bot.command('dashboard', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    const url = config.dashboardUrl ?? 'http://89.167.31.117:3847';
    await replyAndLog(ctx, `<b>Web Dashboard</b>\n\n<a href="${url}">${url}</a>`, { parse_mode: 'HTML' });
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
      await replyAndLog(ctx, msg, { parse_mode: 'HTML' });
      return;
    }

    // /prompt view <key>
    if (subcommand === 'view') {
      const key = parts[1];
      if (!key || !promptManager.isValidKey(key)) {
        await replyAndLog(ctx, `Invalid key. Use /prompt list to see available keys.`);
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
        await replyAndLog(ctx, `Invalid key. Use /prompt list to see available keys.`);
        return;
      }
      const instruction = parts.slice(2).join(' ');
      if (!instruction) {
        await replyAndLog(ctx, `Usage: /prompt edit &lt;key&gt; &lt;instruction&gt;\n\nExample: /prompt edit decide_trade 좀 더 보수적으로, 레버리지 최대 10x`, { parse_mode: 'HTML' });
        return;
      }
      if (!brainRef) {
        await replyAndLog(ctx, 'Brain not active.');
        return;
      }

      await replyAndLog(ctx, 'Editing prompt...');

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
          await replyAndLog(ctx, 'LLM returned invalid prompt (too short). Edit cancelled.');
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
        await replyAndLog(ctx, msg, { parse_mode: 'HTML' });
      } catch (err) {
        log.error({ err }, '/prompt edit failed');
        await replyAndLog(ctx, `Edit failed: ${String(err)}`);
      }
      return;
    }

    // /prompt reset <key>
    if (subcommand === 'reset') {
      const key = parts[1];
      if (!key || !promptManager.isValidKey(key)) {
        await replyAndLog(ctx, `Invalid key. Use /prompt list to see available keys.`);
        return;
      }
      promptManager.reset(key as PromptKey);
      await replyAndLog(ctx, `Prompt <code>${key}</code> reset to default.`, { parse_mode: 'HTML' });
      return;
    }

    // /prompt history <key>
    if (subcommand === 'history') {
      const key = parts[1];
      if (!key || !promptManager.isValidKey(key)) {
        await replyAndLog(ctx, `Invalid key. Use /prompt list to see available keys.`);
        return;
      }
      const history = promptManager.getHistory(key as PromptKey, 5);
      if (history.length === 0) {
        await replyAndLog(ctx, `No modification history for <code>${key}</code>.`, { parse_mode: 'HTML' });
        return;
      }
      let msg = `<b>Prompt History: ${key}</b>\n\n`;
      history.forEach((h, i) => {
        const ago = Math.floor((Date.now() - h.timestamp) / 60_000);
        const agoStr = ago < 60 ? `${ago}min ago` : `${Math.floor(ago / 60)}h ago`;
        msg += `${i + 1}. ${agoStr} — ${h.change_description ?? 'no description'}\n`;
      });
      await replyAndLog(ctx, msg, { parse_mode: 'HTML' });
      return;
    }

    await replyAndLog(ctx, `Unknown subcommand. Use /prompt list, view, edit, reset, or history.`);
  });

  // === /scalp — Scalp 포지션 & 상태 ===

  bot.command('scalp', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!scalpRef) {
      await replyAndLog(ctx, 'Scalp strategy not active.');
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

    await replyAndLog(ctx, msg, { parse_mode: 'HTML' });
  });

  // === /scalpclose <symbol> — Scalp 포지션 강제 청산 ===

  bot.command('scalpclose', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!scalpRef) {
      await replyAndLog(ctx, 'Scalp strategy not active.');
      return;
    }

    const symbol = ctx.message?.text?.replace(/^\/scalpclose\s*/, '').trim().toUpperCase();
    if (!symbol) {
      await replyAndLog(ctx, 'Usage: /scalpclose &lt;symbol&gt;\nExample: /scalpclose ETH-PERP', { parse_mode: 'HTML' });
      return;
    }

    const result = await scalpRef.handleClosePosition(symbol);
    await replyAndLog(ctx, result, { parse_mode: 'HTML' });
  });

  // === /scoredump — 실시간 스코어 진단 ===

  bot.command('scoredump', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!brainRef) {
      await replyAndLog(ctx, 'Brain not active.');
      return;
    }

    const state = brainRef.getState();
    const scores = state.latestScores;

    if (!scores || scores.length === 0) {
      await replyAndLog(ctx, 'No score data yet. Wait for next scan cycle.');
      return;
    }

    const urgentScorer = brainRef.getUrgentScorer();
    const scalpScorer = brainRef.getScalpScorer();
    const brainConfig = brainRef.getBrainConfig();
    const urgentThreshold = urgentScorer.getConfig().llmThreshold;
    const scalpThreshold = scalpScorer.getConfig().llmThreshold;

    const ago = state.lastUrgentScanAt > 0
      ? `${Math.floor((Date.now() - state.lastUrgentScanAt) / 60_000)}min ago`
      : 'never';

    let msg = `<b>Score Dump</b> (scanned ${ago})\n`;
    msg += `━━━━━━━━━━━━━━━━━\n`;

    const sorted = [...scores].sort((a, b) => b.totalScore - a.totalScore);

    for (const s of sorted) {
      const snapshot = state.latestSnapshots.find(ss => ss.symbol === s.symbol);
      const change1h = snapshot ? `${snapshot.change1h >= 0 ? '+' : ''}${snapshot.change1h.toFixed(1)}%` : '?';
      const rsi = snapshot ? `${snapshot.rsi14.toFixed(0)}` : '?';

      // Check if score exceeds urgent or scalp threshold
      const urgentTrigger = s.totalScore >= urgentThreshold;
      const scalpTrigger = s.totalScore >= scalpThreshold && !urgentTrigger;
      const triggerIcon = urgentTrigger ? ' ⚡' : (scalpTrigger ? ' ⚡' : '');

      msg += `<b>${s.symbol}</b>: ${s.totalScore}/${urgentThreshold}${triggerIcon} [1h:${change1h}, RSI:${rsi}]\n`;

      if (s.flags.length > 0) {
        const flagSummary = s.flags.map(f => `${f.name}(+${f.score})`).join(', ');
        msg += `  Flags: ${flagSummary}\n`;
      }
    }

    msg += `━━━━━━━━━━━━━━━━━\n`;
    msg += `Urgent: ${state.urgentTriggerCount}/${brainConfig.maxDailyUrgentLLM} LLM calls today\n`;
    msg += `Scalp: ${brainRef.getScalpTriggerCount()}/${brainConfig.maxDailyScalpLLM} LLM calls today`;

    await sendLongMessage(ctx, msg);
  });

  // === /journal — 트레이드 저널 (position_lifecycle) ===

  bot.command('journal', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;

    const args = ctx.message?.text?.replace(/^\/journal\s*/, '').trim();
    const limit = args && !isNaN(Number(args)) ? Math.min(Number(args), 50) : 10;

    try {
      const lifecycles = getRecentLifecycles(limit) as Array<{
        id: number; strategy_id: string; symbol: string; side: string;
        entry_price: number; entry_size: number; leverage: number;
        stop_loss: number | null; take_profit: number | null;
        entry_rationale: string | null; confidence: string | null;
        close_price: number | null; close_reason: string | null;
        pnl: number | null; pnl_pct: number | null; held_minutes: number | null;
        review_lesson: string | null; status: string;
        opened_at: number; closed_at: number | null;
      }>;

      if (lifecycles.length === 0) {
        await replyAndLog(ctx, 'No trade history yet.');
        return;
      }

      let msg = `<b>Trade Journal</b> (last ${limit})\n`;
      msg += `━━━━━━━━━━━━━━━━━\n`;

      let wins = 0;
      let losses = 0;
      let totalPnlPct = 0;
      let closedCount = 0;

      for (const lc of lifecycles) {
        const stratLabel = lc.strategy_id.includes('scalp') ? 'scalp' : 'disc';

        if (lc.status === 'open') {
          // Open position
          msg += `\n🟡 <b>${lc.symbol}</b> ${lc.side.toUpperCase()} (${stratLabel}) ${lc.leverage}x  ← OPEN\n`;
          msg += `  $${lc.entry_price.toFixed(2)}`;
          if (lc.stop_loss) msg += ` | SL: $${lc.stop_loss.toFixed(2)}`;
          if (lc.take_profit) msg += ` | TP: $${lc.take_profit.toFixed(2)}`;
          msg += '\n';
          if (lc.entry_rationale) {
            const rationale = lc.entry_rationale.length > 80
              ? lc.entry_rationale.substring(0, 77) + '...'
              : lc.entry_rationale;
            msg += `  ${rationale}\n`;
          }
        } else {
          // Closed position
          const pnl = lc.pnl ?? 0;
          const pnlPct = lc.pnl_pct ?? 0;
          const won = pnl >= 0;
          if (won) wins++; else losses++;
          closedCount++;
          totalPnlPct += pnlPct;

          const icon = won ? '✅' : '❌';
          const pnlStr = pnl >= 0
            ? `+$${pnl.toFixed(2)} (+${pnlPct.toFixed(1)}%)`
            : `-$${Math.abs(pnl).toFixed(2)} (${pnlPct.toFixed(1)}%)`;

          // Format held time
          let heldStr = '';
          if (lc.held_minutes != null) {
            if (lc.held_minutes < 60) {
              heldStr = `${lc.held_minutes}min`;
            } else {
              const hrs = Math.floor(lc.held_minutes / 60);
              const mins = lc.held_minutes % 60;
              heldStr = mins > 0 ? `${hrs}h${mins}m` : `${hrs}h`;
            }
          }

          msg += `\n${icon} <b>${lc.symbol}</b> ${lc.side.toUpperCase()} (${stratLabel}) ${lc.leverage}x\n`;
          msg += `  $${lc.entry_price.toFixed(2)} → $${(lc.close_price ?? 0).toFixed(2)} | ${pnlStr}`;
          if (heldStr) msg += ` | ${heldStr}`;
          msg += '\n';

          // Show lesson or rationale
          const note = lc.review_lesson ?? lc.entry_rationale;
          if (note) {
            const trimmed = note.length > 80 ? note.substring(0, 77) + '...' : note;
            msg += `  ${trimmed}\n`;
          }
        }
      }

      msg += `\n━━━━━━━━━━━━━━━━━\n`;
      if (closedCount > 0) {
        const winRate = ((wins / closedCount) * 100).toFixed(0);
        const avgPnl = (totalPnlPct / closedCount).toFixed(1);
        msg += `Win Rate: ${winRate}% (${wins}W/${losses}L) | Avg PnL: ${Number(avgPnl) >= 0 ? '+' : ''}${avgPnl}%`;
      } else {
        msg += `No closed trades yet.`;
      }

      await sendLongMessage(ctx, msg);
    } catch (err) {
      log.error({ err }, '/journal command failed');
      await replyAndLog(ctx, 'Failed to fetch trade journal.');
    }
  });

  // === /report — On-demand 리포트 생성 ===

  bot.command('report', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    if (!reporterRef) {
      await replyAndLog(ctx, 'Daily reporter not active.');
      return;
    }
    await replyAndLog(ctx, 'Generating report...');
    try {
      const msg = await reporterRef.generateOnDemand();
      await sendLongMessage(ctx, msg);
    } catch (err) {
      log.error({ err }, '/report command failed');
      await replyAndLog(ctx, 'Failed to generate report.');
    }
  });

  // === /help ===

  bot.command('help', async (ctx: Context) => {
    if (!isAuthorized(ctx)) return;
    await replyAndLog(ctx,
      '<b>pangjibot Commands</b>\n\n'
      + '<b>General</b>\n'
      + '/balance - Account balance &amp; positions\n'
      + '/status - Latest LLM analysis result\n'
      + '/score - Latest scorer metrics\n'
      + '/scoredump - Real-time score diagnostic (compact)\n'
      + '/journal [N] - Trade journal (last N trades)\n'
      + '/do &lt;command&gt; - Talk to LLM (trade, ask, transfer, etc)\n'
      + '/prompt - Manage LLM system prompts\n'
      + '/report - Generate on-demand report\n'
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
        await replyAndLog(ctx, 'Edit expired (5min timeout). Run /prompt edit again.');
        return;
      }

      promptManager.set(pendingEdit.key, pendingEdit.newText, pendingEdit.summary);
      await replyAndLog(ctx, `Prompt <code>${pendingEdit.key}</code> updated successfully.`, { parse_mode: 'HTML' });
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

function logIncoming(ctx: Context, command?: string): void {
  const text = ctx.message?.text ?? '';
  const chatId = ctx.chat?.id?.toString();
  const msgId = ctx.message?.message_id;
  saveTelegramMessage('incoming', text, chatId, msgId, command);
}

function logOutgoing(text: string, chatId?: string, messageId?: number): void {
  saveTelegramMessage('outgoing', text, chatId, messageId);
}

async function replyAndLog(ctx: Context, text: string, opts?: { parse_mode?: string }): Promise<void> {
  logOutgoing(text, ctx.chat?.id?.toString());
  await ctx.reply(text, opts as Parameters<Context['reply']>[1]);
}

async function sendLongMessage(ctx: Context, text: string): Promise<void> {
  logOutgoing(text, ctx.chat?.id?.toString());
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
  logOutgoing(message, config.tgChatId);
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
