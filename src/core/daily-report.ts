import { createChildLogger } from '../monitoring/logger.js';
import { getHyperliquidClient } from '../exchanges/hyperliquid/client.js';
import { sendAlert } from '../monitoring/telegram.js';
import {
  saveReport,
  markReportSent,
  getLLMUsageToday,
  getLLMUsageTotals,
} from '../data/storage.js';
import type { EngineStatus, MarketState } from './types.js';

const log = createChildLogger('daily-report');

// ============================================================
// Types
// ============================================================

interface ReportDeps {
  getEngineStatus: () => EngineStatus;
  getBrainState: () => MarketState;
}

interface ReportData {
  // Account
  balance: number;
  equity: number;
  marginUsed: number;
  freeMargin: number;

  // PnL
  periodPnl: number;
  periodTradeCount: number;
  periodWins: number;
  periodLosses: number;
  totalPnl: number;

  // Strategies
  strategies: Array<{
    id: string;
    name: string;
    status: string;
    pnl: number;
  }>;

  // Positions
  openPositions: Array<{
    symbol: string;
    side: string;
    size: number;
    entryPrice: number;
    unrealizedPnl: number;
    leverage: number | string;
  }>;

  // LLM
  llmCallsToday: number;
  llmCostToday: number;
  llmCallsTotal: number;
  llmCostTotal: number;

  // Brain
  brainRegime: string;
  brainDirection: string;
  brainRiskLevel: number;
  brainConfidence: number;

  // Notable trades (biggest wins/losses in period)
  notableTrades: Array<{
    symbol: string;
    side: string;
    pnl: number;
    time: number;
  }>;
}

// ============================================================
// DailyReporter
// ============================================================

export class DailyReporter {
  private deps: ReportDeps;
  private reportTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: ReportDeps) {
    this.deps = deps;
  }

  start(): void {
    this.scheduleNext();
    log.info('DailyReporter started');
  }

  stop(): void {
    if (this.reportTimeout) {
      clearTimeout(this.reportTimeout);
      this.reportTimeout = null;
    }
    log.info('DailyReporter stopped');
  }

  // ============================================================
  // Scheduler
  // ============================================================

  private getNextReportTime(): { time: number; type: 'morning' | 'evening' } {
    const now = Date.now();
    const today = new Date();

    // morning = KST 06:00 = UTC 21:00
    // evening = KST 18:00 = UTC 09:00
    const todayUtc9 = Date.UTC(
      today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 9, 0, 0,
    );
    const todayUtc21 = Date.UTC(
      today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 21, 0, 0,
    );

    const candidates = [
      { time: todayUtc9, type: 'evening' as const },      // UTC 09:00 = KST 18:00
      { time: todayUtc21, type: 'morning' as const },      // UTC 21:00 = KST 06:00 (+1 day)
      { time: todayUtc9 + 86_400_000, type: 'evening' as const },
      { time: todayUtc21 + 86_400_000, type: 'morning' as const },
    ];

    return candidates.find(c => c.time > now)!;
  }

  private getPeriodStart(reportTime: number, reportType: 'morning' | 'evening'): number {
    // Each report covers the previous 12 hours
    // morning (UTC 21:00): covers UTC 09:00 ~ UTC 21:00
    // evening (UTC 09:00): covers UTC 21:00 (prev day) ~ UTC 09:00
    void reportType;
    return reportTime - 12 * 60 * 60 * 1000;
  }

  private scheduleNext(): void {
    const next = this.getNextReportTime();
    const delay = next.time - Date.now();

    log.info({
      nextReport: new Date(next.time).toISOString(),
      type: next.type,
      delayMin: Math.round(delay / 60_000),
    }, 'Next daily report scheduled');

    this.reportTimeout = setTimeout(async () => {
      try {
        await this.generateAndSend(next.type, next.time);
      } catch (err) {
        log.error({ err }, 'Daily report generation failed');
      }
      this.scheduleNext();
    }, delay);
  }

  // ============================================================
  // Data Collection
  // ============================================================

  private async collectData(periodStart: number, periodEnd: number): Promise<ReportData> {
    const hl = getHyperliquidClient();

    // Account state + spot balances
    let balance = 0;
    let marginUsed = 0;
    let openPositions: ReportData['openPositions'] = [];
    try {
      const [state, spotState] = await Promise.all([
        hl.getAccountState(),
        hl.getSpotBalances(),
      ]);
      balance = spotState.balances
        .filter(b => b.coin.toUpperCase().includes('USDC'))
        .reduce((sum, b) => sum + parseFloat(b.total), 0);
      marginUsed = parseFloat(state.marginSummary.totalMarginUsed);

      const positions = state.assetPositions.filter(ap => parseFloat(ap.position.szi) !== 0);
      openPositions = positions.map(ap => {
        const p = ap.position;
        const size = parseFloat(p.szi);
        return {
          symbol: p.coin,
          side: size >= 0 ? 'long' : 'short',
          size: Math.abs(size),
          entryPrice: parseFloat(p.entryPx),
          unrealizedPnl: parseFloat(p.unrealizedPnl),
          leverage: p.leverage?.value ?? 1,
        };
      });
    } catch (err) {
      log.warn({ err }, 'Failed to fetch account data for report');
    }

    // balance (spot USDC total) already includes unrealized PnL in Hyperliquid unified account
    const equity = balance;
    const freeMargin = balance - marginUsed;

    // Period trades (from exchange fills)
    let periodPnl = 0;
    let periodTradeCount = 0;
    let periodWins = 0;
    let periodLosses = 0;
    const notableTrades: ReportData['notableTrades'] = [];

    try {
      const fills = await hl.getUserFillsByTime(periodStart, periodEnd);
      for (const f of fills) {
        const pnl = parseFloat(f.closedPnl);
        if (pnl === 0) continue; // skip non-closing fills
        periodPnl += pnl;
        periodTradeCount++;
        if (pnl > 0) periodWins++;
        else periodLosses++;

        notableTrades.push({
          symbol: f.coin,
          side: f.side,
          pnl,
          time: typeof f.time === 'number' ? f.time : new Date(f.time).getTime(),
        });
      }
      // Sort by absolute PnL and keep top 5
      notableTrades.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
      notableTrades.splice(5);
    } catch (err) {
      log.warn({ err }, 'Failed to fetch fills for report');
    }

    // Engine strategies
    let strategies: ReportData['strategies'] = [];
    let totalPnl = 0;
    try {
      const status = this.deps.getEngineStatus();
      totalPnl = status.totalPnl.toNumber();
      strategies = status.strategies.map(s => ({
        id: s.id,
        name: s.name,
        status: s.status,
        pnl: s.pnl.toNumber(),
      }));
    } catch (err) {
      log.warn({ err }, 'Failed to get engine status for report');
    }

    // LLM usage
    const llmToday = getLLMUsageToday();
    const llmTotal = getLLMUsageTotals();

    // Brain state
    let brainRegime = 'unknown';
    let brainDirection = 'neutral';
    let brainRiskLevel = 0;
    let brainConfidence = 0;
    try {
      const brainState = this.deps.getBrainState();
      brainRegime = brainState.regime;
      brainDirection = brainState.direction;
      brainRiskLevel = brainState.riskLevel;
      brainConfidence = brainState.confidence;
    } catch (err) {
      log.warn({ err }, 'Failed to get brain state for report');
    }

    return {
      balance,
      equity,
      marginUsed,
      freeMargin,
      periodPnl,
      periodTradeCount,
      periodWins,
      periodLosses,
      totalPnl,
      strategies,
      openPositions,
      llmCallsToday: llmToday.totalCalls,
      llmCostToday: llmToday.totalCostUsd,
      llmCallsTotal: llmTotal.totalCalls,
      llmCostTotal: llmTotal.totalCostUsd,
      brainRegime,
      brainDirection,
      brainRiskLevel,
      brainConfidence,
      notableTrades,
    };
  }

  // ============================================================
  // Formatting
  // ============================================================

  private formatTelegram(data: ReportData, reportType: 'morning' | 'evening', reportTime: number): string {
    const typeLabel = reportType === 'morning' ? 'Morning Report' : 'Evening Report';
    const kstTime = reportType === 'morning' ? '06:00' : '18:00';
    const dateStr = new Date(reportTime).toISOString().split('T')[0];

    const fmtPnl = (v: number) => v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`;
    const fmtUsd = (v: number) => `$${v.toFixed(2)}`;

    const lines: string[] = [];

    // Header
    lines.push(`<b>${typeLabel}</b> (${kstTime} KST)`);
    lines.push(dateStr);
    lines.push('');

    // Account
    lines.push(`<b>Account</b>`);
    lines.push(`Balance: ${fmtUsd(data.balance)} | Equity: ${fmtUsd(data.equity)}`);
    lines.push(`Margin: ${fmtUsd(data.marginUsed)} | Free: ${fmtUsd(data.freeMargin)}`);
    lines.push('');

    // PnL
    const winRate = data.periodTradeCount > 0
      ? ((data.periodWins / data.periodTradeCount) * 100).toFixed(0)
      : '0';
    lines.push(`<b>PnL (12h)</b>`);
    lines.push(`Period: <b>${fmtPnl(data.periodPnl)}</b> (${data.periodTradeCount}T ${winRate}%WR)`);
    lines.push(`All-time: ${fmtPnl(data.totalPnl)}`);
    lines.push('');

    // Strategies
    if (data.strategies.length > 0) {
      lines.push(`<b>Strategies</b>`);
      for (const s of data.strategies) {
        const icon = s.id === 'scalp' ? '⚡' : s.id === 'momentum' ? '📊' : '⚙️';
        lines.push(`${icon} ${s.name}: ${fmtPnl(s.pnl)} [${s.status}]`);
      }
      lines.push('');
    }

    // Open Positions
    if (data.openPositions.length > 0) {
      lines.push(`<b>Positions (${data.openPositions.length})</b>`);
      for (const p of data.openPositions) {
        const sideIcon = p.side === 'long' ? '🟢' : '🔴';
        lines.push(`${sideIcon} ${p.side.toUpperCase()} ${p.symbol} ${p.size} @ $${p.entryPrice.toFixed(2)} | ${fmtPnl(p.unrealizedPnl)}`);
      }
      lines.push('');
    } else {
      lines.push('No open positions.');
      lines.push('');
    }

    // Brain
    lines.push(`<b>Brain</b>`);
    lines.push(`${data.brainRegime.toUpperCase()} | ${data.brainDirection} ${data.brainConfidence}% | Risk ${data.brainRiskLevel}/5`);
    lines.push('');

    // LLM
    lines.push(`<b>LLM</b>`);
    lines.push(`Today: ${data.llmCallsToday} calls ($${data.llmCostToday.toFixed(3)}) | Total: ${data.llmCallsTotal} calls ($${data.llmCostTotal.toFixed(2)})`);

    // Notable trades
    if (data.notableTrades.length > 0) {
      lines.push('');
      lines.push(`<b>Notable Trades</b>`);
      for (const t of data.notableTrades.slice(0, 3)) {
        const icon = t.pnl >= 0 ? '✅' : '❌';
        lines.push(`${icon} ${t.symbol} ${t.side} ${fmtPnl(t.pnl)}`);
      }
    }

    return lines.join('\n');
  }

  // ============================================================
  // Generate & Send
  // ============================================================

  private async generateAndSend(reportType: 'morning' | 'evening', reportTime: number): Promise<void> {
    const periodStart = this.getPeriodStart(reportTime, reportType);
    const periodEnd = reportTime;

    log.info({ reportType, periodStart: new Date(periodStart).toISOString(), periodEnd: new Date(periodEnd).toISOString() }, 'Generating daily report');

    const data = await this.collectData(periodStart, periodEnd);
    const telegramMsg = this.formatTelegram(data, reportType, reportTime);

    // Save to DB (archive)
    const reportId = saveReport(
      reportType,
      Date.now(),
      periodStart,
      periodEnd,
      JSON.stringify(data),
      telegramMsg,
      false,
    );

    // Send to Telegram
    try {
      await sendAlert(telegramMsg);
      markReportSent(reportId);
      log.info({ reportId, reportType }, 'Daily report sent to Telegram');
    } catch (err) {
      log.error({ err, reportId }, 'Failed to send daily report to Telegram');
    }
  }

  /** On-demand report generation (for /report command). Does NOT save to DB. */
  async generateOnDemand(): Promise<string> {
    const now = Date.now();
    // Show last 12 hours
    const periodStart = now - 12 * 60 * 60 * 1000;
    const data = await this.collectData(periodStart, now);
    return this.formatTelegram(data, 'evening', now);
  }
}
