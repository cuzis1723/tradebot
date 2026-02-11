import { Decimal } from 'decimal.js';
import { Strategy } from '../base.js';
import { MarketAnalyzer } from './analyzer.js';
import { MarketScorer } from './scorer.js';
import { LLMAdvisor } from './llm-advisor.js';
import { getHyperliquidClient } from '../../exchanges/hyperliquid/client.js';
import { logTrade } from '../../data/storage.js';
import type {
  StrategyTier,
  TradingMode,
  TradeSignal,
  FilledOrder,
  DiscretionaryConfig,
  TradeProposal,
  MarketSnapshot,
  ActiveDiscretionaryPosition,
  TriggerScore,
} from '../../core/types.js';

export class DiscretionaryStrategy extends Strategy {
  readonly id = 'discretionary';
  readonly name = 'Discretionary Trading';
  readonly tier: StrategyTier = 'growth';
  readonly mode: TradingMode = 'semi-auto';

  private config: DiscretionaryConfig;
  private analyzer: MarketAnalyzer;
  private scorer: MarketScorer;
  private advisor: LLMAdvisor;
  private pendingProposals: Map<string, TradeProposal> = new Map();
  private positions: ActiveDiscretionaryPosition[] = [];
  private analysisInterval: ReturnType<typeof setInterval> | null = null;
  private lastAnalysisTime = 0;
  private latestSnapshots: MarketSnapshot[] = [];
  private latestScores: TriggerScore[] = [];

  // Callback to send Telegram messages - set by engine/telegram integration
  public onProposal: ((proposal: TradeProposal, snapshot: MarketSnapshot) => Promise<void>) | null = null;
  public onMessage: ((msg: string) => Promise<void>) | null = null;

  constructor(cfg: DiscretionaryConfig) {
    super();
    this.config = cfg;
    this.analyzer = new MarketAnalyzer();
    this.scorer = new MarketScorer();
    this.advisor = new LLMAdvisor();
  }

  async onInit(): Promise<void> {
    this.log.info({ symbols: this.config.symbols }, 'Discretionary v2 strategy initializing (score-triggered)');

    if (!this.advisor.isAvailable()) {
      this.log.warn('LLM advisor not available - manual mode only');
    }

    // Start 5-min score-based scan cycle
    this.analysisInterval = setInterval(() => {
      this.runScoringCycle().catch(err => {
        this.log.error({ err }, 'Scoring cycle error');
      });
    }, this.config.analysisIntervalMs);

    // Run initial cycle
    await this.runScoringCycle();
  }

  async onTick(_data: Record<string, string>): Promise<TradeSignal | null> {
    // Discretionary strategy doesn't auto-trade on ticks
    // It runs its own analysis cycle and waits for user approval
    this.expireOldProposals();
    return null;
  }

  async onOrderFilled(order: FilledOrder): Promise<void> {
    this.log.info({ order }, 'Discretionary order filled');
    this.recordTrade(order.fee.negated()); // fee as cost
  }

  async onStop(): Promise<void> {
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }
    // Close all open positions
    await this.closeAllPositions();
    this.log.info('Discretionary strategy stopped');
  }

  // === Core Scoring Cycle (v2: score-triggered LLM calls) ===

  private async runScoringCycle(): Promise<void> {
    if (!this.isRunning()) return;

    const now = Date.now();
    if (now - this.lastAnalysisTime < this.config.analysisIntervalMs * 0.9) return;
    this.lastAnalysisTime = now;

    this.log.info('Running scoring cycle...');

    // Step 1: Fetch market data for all tracked symbols
    this.latestSnapshots = await this.analyzer.analyzeMultiple(this.config.symbols);
    if (this.latestSnapshots.length === 0) {
      this.log.warn('No market data available');
      return;
    }

    // Step 2: Score all symbols (code-based, cost-free)
    this.latestScores = this.scorer.scoreAll(this.latestSnapshots);

    for (const score of this.latestScores) {
      const action = this.scorer.getAction(score);

      if (action === 'ignore') {
        this.log.debug({ symbol: score.symbol, score: score.totalScore }, 'Score below threshold');
        continue;
      }

      // Alert: log + Telegram notification (5-7 points)
      if (action === 'alert') {
        this.log.info({ symbol: score.symbol, score: score.totalScore, flags: score.flags.length }, 'Score alert');
        if (this.onMessage) {
          await this.onMessage(this.scorer.formatScore(score));
        }
        continue;
      }

      // LLM call or urgent (8+ points): check cooldown first
      if (action === 'llm_call' || action === 'llm_urgent') {
        const cooldownCheck = this.scorer.canCallLLM(score.symbol);
        if (!cooldownCheck.allowed) {
          this.log.info({ symbol: score.symbol, score: score.totalScore, reason: cooldownCheck.reason }, 'LLM call blocked by cooldown');
          if (this.onMessage) {
            await this.onMessage(`${this.scorer.formatScore(score)}\n⏳ ${cooldownCheck.reason}`);
          }
          continue;
        }

        // Step 3: Call LLM with trigger context
        if (this.advisor.isAvailable() && this.pendingProposals.size === 0) {
          this.log.info({ symbol: score.symbol, score: score.totalScore, action }, 'Triggering LLM analysis');
          this.scorer.recordLLMCall(score.symbol);

          try {
            const snapshot = this.latestSnapshots.find(s => s.symbol === score.symbol);
            const result = await this.advisor.analyzeMarketWithTrigger(
              this.latestSnapshots,
              score,
            );

            if (result.action === 'propose_trade' && result.proposal) {
              this.pendingProposals.set(result.proposal.id, result.proposal);
              this.log.info({ proposal: result.proposal }, 'New trade proposal generated');

              if (this.onProposal && snapshot) {
                await this.onProposal(result.proposal, snapshot);
              }
            } else if (result.action === 'no_trade') {
              this.log.debug({ reason: result.content }, 'LLM: No trade opportunity');
              if (this.onMessage) {
                await this.onMessage(`${this.scorer.formatScore(score)}\nLLM: ${result.content ?? 'No opportunity'}`);
              }
            }
          } catch (err) {
            this.log.error({ err }, 'LLM analysis failed');
          }
        }
      }
    }
  }

  // === User Commands (called from Telegram) ===

  async handleApprove(proposalId: string): Promise<string> {
    const proposal = this.pendingProposals.get(proposalId);
    if (!proposal) return 'Proposal not found or expired.';
    if (proposal.status !== 'pending') return `Proposal already ${proposal.status}.`;

    proposal.status = 'approved';
    const result = await this.executeProposal(proposal);
    this.pendingProposals.delete(proposalId);
    return result;
  }

  async handleModify(proposalId: string, modifications: Partial<{ size: number; stopLoss: number; takeProfit: number }>): Promise<string> {
    const proposal = this.pendingProposals.get(proposalId);
    if (!proposal) return 'Proposal not found or expired.';

    if (modifications.size !== undefined) proposal.size = modifications.size / 100;
    if (modifications.stopLoss !== undefined) proposal.stopLoss = modifications.stopLoss;
    if (modifications.takeProfit !== undefined) proposal.takeProfit = modifications.takeProfit;

    proposal.status = 'modified';
    proposal.riskRewardRatio = Math.abs(proposal.takeProfit - proposal.entryPrice) / Math.abs(proposal.entryPrice - proposal.stopLoss);

    const result = await this.executeProposal(proposal);
    this.pendingProposals.delete(proposalId);
    return result;
  }

  async handleReject(proposalId: string): Promise<string> {
    const proposal = this.pendingProposals.get(proposalId);
    if (!proposal) return 'Proposal not found or expired.';
    proposal.status = 'rejected';
    this.pendingProposals.delete(proposalId);
    return `Proposal rejected: ${proposal.symbol} ${proposal.side}`;
  }

  async handleMarketRequest(): Promise<string> {
    this.latestSnapshots = await this.analyzer.analyzeMultiple(this.config.symbols);
    if (this.latestSnapshots.length === 0) return 'No market data available.';

    const parts = this.latestSnapshots.map(s => this.analyzer.formatSnapshot(s));
    return parts.join('\n\n');
  }

  async handleIdeaRequest(idea: string): Promise<string> {
    if (!this.advisor.isAvailable()) return 'LLM advisor not available. Set ANTHROPIC_API_KEY.';

    if (this.latestSnapshots.length === 0) {
      this.latestSnapshots = await this.analyzer.analyzeMultiple(this.config.symbols);
    }

    const result = await this.advisor.evaluateIdea(idea, this.latestSnapshots);

    if (result.action === 'propose_trade' && result.proposal) {
      this.pendingProposals.set(result.proposal.id, result.proposal);
      const snapshot = this.latestSnapshots.find(s => s.symbol === result.proposal!.symbol);
      if (this.onProposal && snapshot) {
        await this.onProposal(result.proposal, snapshot);
      }
      return this.formatProposal(result.proposal);
    }

    return result.content ?? 'No viable trade found for this idea.';
  }

  async handlePositionsRequest(): Promise<string> {
    if (this.positions.length === 0) return 'No open discretionary positions.';

    if (!this.advisor.isAvailable()) {
      return this.formatPositions();
    }

    if (this.latestSnapshots.length === 0) {
      this.latestSnapshots = await this.analyzer.analyzeMultiple(this.config.symbols);
    }

    const analysis = await this.advisor.analyzePositions(this.positions, this.latestSnapshots);
    return `${this.formatPositions()}\n\n<b>LLM Analysis:</b>\n${analysis}`;
  }

  async handleClosePosition(symbol: string): Promise<string> {
    const position = this.positions.find(p => p.symbol === symbol);
    if (!position) return `No open position for ${symbol}.`;

    return await this.closePosition(position);
  }

  async handleScoreRequest(): Promise<string> {
    // Force a fresh scoring cycle
    this.latestSnapshots = await this.analyzer.analyzeMultiple(this.config.symbols);
    if (this.latestSnapshots.length === 0) return 'No market data available.';

    this.latestScores = this.scorer.scoreAll(this.latestSnapshots);
    if (this.latestScores.length === 0) return 'No scores computed.';

    const parts = this.latestScores.map(s => this.scorer.formatScore(s));
    return parts.join('\n\n');
  }

  handleCooldownRequest(): string {
    return this.scorer.getCooldownStatus();
  }

  async handleAskQuestion(question: string): Promise<string> {
    if (!this.advisor.isAvailable()) return 'LLM advisor not available. Set ANTHROPIC_API_KEY.';

    if (this.latestSnapshots.length === 0) {
      this.latestSnapshots = await this.analyzer.analyzeMultiple(this.config.symbols);
    }

    return await this.advisor.askQuestion(question, this.latestSnapshots);
  }

  // === Trade Execution ===

  private async executeProposal(proposal: TradeProposal): Promise<string> {
    const hl = getHyperliquidClient();

    // Calculate position size from allocated capital
    const capitalForTrade = this.allocatedCapital.mul(proposal.size);
    const sizeInUnits = capitalForTrade.mul(proposal.leverage).div(proposal.entryPrice);

    // Round to appropriate decimals (ETH: 3, BTC: 5, etc.)
    const sz = parseFloat(sizeInUnits.toFixed(4));

    try {
      // Set leverage
      await hl.updateLeverage(proposal.symbol, proposal.leverage);

      // Place entry order
      const result = await hl.placeOrder({
        coin: proposal.symbol,
        isBuy: proposal.side === 'buy',
        size: sz.toString(),
        price: proposal.entryPrice.toString(),
        orderType: 'limit',
        tif: 'Gtc',
        reduceOnly: false,
      });

      if (result.error) {
        return `Order failed: ${result.error}`;
      }

      // Track position
      this.positions.push({
        symbol: proposal.symbol,
        side: proposal.side,
        entryPrice: result.filled ? parseFloat(result.avgPrice!) : proposal.entryPrice,
        size: sz,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        proposalId: proposal.id,
        openedAt: Date.now(),
      });

      proposal.status = 'executed';

      // Log the trade
      logTrade(this.id, proposal.symbol, proposal.side, proposal.entryPrice, sz, 0, 0, result.orderId?.toString());

      this.emit('trade', {
        strategy: this.name,
        type: 'entry',
        symbol: proposal.symbol,
        side: proposal.side,
        price: proposal.entryPrice.toString(),
      });

      const fillStatus = result.filled ? '(FILLED)' : '(RESTING)';
      return `Order placed ${fillStatus}: ${proposal.side.toUpperCase()} ${sz} ${proposal.symbol} @ $${proposal.entryPrice}\nSL: $${proposal.stopLoss} | TP: $${proposal.takeProfit}`;
    } catch (err) {
      this.log.error({ err, proposal }, 'Failed to execute proposal');
      return `Execution error: ${String(err)}`;
    }
  }

  private async closePosition(position: ActiveDiscretionaryPosition): Promise<string> {
    const hl = getHyperliquidClient();

    try {
      const result = await hl.placeOrder({
        coin: position.symbol,
        isBuy: position.side === 'sell', // opposite side to close
        size: position.size.toString(),
        price: '0', // will be market price
        orderType: 'market',
        reduceOnly: true,
      });

      if (result.error) {
        return `Close failed: ${result.error}`;
      }

      const closePrice = result.avgPrice ? parseFloat(result.avgPrice) : 0;
      const pnl = (closePrice - position.entryPrice) * position.size * (position.side === 'buy' ? 1 : -1);

      // Remove from tracked positions
      this.positions = this.positions.filter(p => p.proposalId !== position.proposalId);

      // Log, record, and update scorer cooldown
      logTrade(this.id, position.symbol, position.side === 'buy' ? 'sell' : 'buy', closePrice, position.size, 0, pnl);
      this.recordTrade(new Decimal(pnl));
      this.scorer.recordTradeResult(pnl >= 0);

      this.emit('trade', {
        strategy: this.name,
        type: 'close',
        symbol: position.symbol,
        side: position.side === 'buy' ? 'sell' : 'buy',
        price: closePrice.toString(),
        profit: pnl.toFixed(2),
        totalPnl: this.realizedPnl.toString(),
      });

      return `Position closed: ${position.symbol} @ $${closePrice.toFixed(2)} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
    } catch (err) {
      this.log.error({ err }, 'Failed to close position');
      return `Close error: ${String(err)}`;
    }
  }

  private async closeAllPositions(): Promise<void> {
    for (const position of [...this.positions]) {
      await this.closePosition(position);
    }
  }

  // === Helpers ===

  private expireOldProposals(): void {
    const now = Date.now();
    for (const [id, proposal] of this.pendingProposals) {
      if (proposal.status === 'pending' && now > proposal.expiresAt) {
        proposal.status = 'expired';
        this.pendingProposals.delete(id);
        this.log.info({ id, symbol: proposal.symbol }, 'Proposal expired');
      }
    }
  }

  formatProposal(proposal: TradeProposal): string {
    const sideIcon = proposal.side === 'buy' ? '🟢 LONG' : '🔴 SHORT';
    const confIcon = proposal.confidence === 'high' ? '🔥' : proposal.confidence === 'medium' ? '✅' : '⚠️';

    return [
      `<b>Trade Proposal</b> ${confIcon}`,
      `ID: <code>${proposal.id.slice(0, 8)}</code>`,
      `${sideIcon} ${proposal.symbol}`,
      `Entry: $${proposal.entryPrice.toFixed(2)}`,
      `Stop Loss: $${proposal.stopLoss.toFixed(2)}`,
      `Take Profit: $${proposal.takeProfit.toFixed(2)}`,
      `Leverage: ${proposal.leverage}x | Size: ${(proposal.size * 100).toFixed(0)}% of capital`,
      `R:R = 1:${proposal.riskRewardRatio.toFixed(1)}`,
      '',
      `<b>Rationale:</b> ${proposal.rationale}`,
      '',
      `<i>Commands:</i>`,
      `/approve ${proposal.id.slice(0, 8)}`,
      `/modify ${proposal.id.slice(0, 8)} size=10 sl=2400`,
      `/reject ${proposal.id.slice(0, 8)}`,
    ].join('\n');
  }

  private formatPositions(): string {
    if (this.positions.length === 0) return 'No open discretionary positions.';

    const lines = ['<b>Open Discretionary Positions</b>\n'];
    for (const pos of this.positions) {
      const sideIcon = pos.side === 'buy' ? '🟢' : '🔴';
      const held = Math.floor((Date.now() - pos.openedAt) / 60_000);
      lines.push(
        `${sideIcon} ${pos.symbol} | ${pos.side.toUpperCase()} ${pos.size} @ $${pos.entryPrice.toFixed(2)}`,
        `  SL: $${pos.stopLoss.toFixed(2)} | TP: $${pos.takeProfit.toFixed(2)} | ${held}min`,
      );
    }
    return lines.join('\n');
  }

  getPendingProposal(shortId: string): TradeProposal | undefined {
    for (const [id, proposal] of this.pendingProposals) {
      if (id.startsWith(shortId)) return proposal;
    }
    return undefined;
  }

  getPositions(): ActiveDiscretionaryPosition[] {
    return [...this.positions];
  }

  getSnapshots(): MarketSnapshot[] {
    return [...this.latestSnapshots];
  }

  getScores(): TriggerScore[] {
    return [...this.latestScores];
  }

  getScorer(): MarketScorer {
    return this.scorer;
  }
}
