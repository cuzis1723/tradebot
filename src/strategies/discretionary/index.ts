import { Decimal } from 'decimal.js';
import { Strategy } from '../base.js';
import { getHyperliquidClient } from '../../exchanges/hyperliquid/client.js';
import { logTrade, saveStrategyState, loadStrategyState } from '../../data/storage.js';
import type {
  StrategyTier,
  TradingMode,
  TradeSignal,
  FilledOrder,
  DiscretionaryConfig,
  TradeProposal,
  MarketSnapshot,
  ActiveDiscretionaryPosition,
  StrategyPositionSummary,
} from '../../core/types.js';

/**
 * Discretionary Strategy v3 — Brain-Driven
 *
 * No longer runs its own analysis loop. Instead:
 * - Brain's 5-min urgent scan detects opportunities and sends TradeProposals here
 * - Brain's 30-min comprehensive analysis sets MarketState (accessible via this.marketState)
 * - This strategy handles: proposal management, trade execution, position tracking
 * - User interaction: approve/modify/reject proposals via Telegram
 */
export class DiscretionaryStrategy extends Strategy {
  readonly id = 'discretionary';
  readonly name = 'Discretionary Trading';
  readonly tier: StrategyTier = 'growth';
  readonly mode: TradingMode = 'semi-auto';

  private config: DiscretionaryConfig;
  private pendingProposals: Map<string, TradeProposal> = new Map();
  private positions: ActiveDiscretionaryPosition[] = [];

  // Callback to send Telegram messages - set by engine/telegram integration
  public onProposal: ((proposal: TradeProposal, snapshot?: MarketSnapshot) => Promise<void>) | null = null;
  public onMessage: ((msg: string) => Promise<void>) | null = null;

  constructor(cfg: DiscretionaryConfig) {
    super();
    this.config = cfg;
  }

  async onInit(): Promise<void> {
    this.log.info({ symbols: this.config.symbols }, 'Discretionary v3 strategy initializing (Brain-driven)');
    // Restore positions from DB (CRIT-3: survive restarts)
    this.restorePositions();
  }

  async onTick(_data: Record<string, string>): Promise<TradeSignal | null> {
    // Expire old proposals on each tick
    this.expireOldProposals();
    return null;
  }

  async onOrderFilled(order: FilledOrder): Promise<void> {
    this.log.info({ order }, 'Discretionary order filled');
    this.recordTrade(order.fee.negated());
  }

  async onStop(): Promise<void> {
    await this.closeAllPositions();
    this.log.info('Discretionary strategy stopped');
  }

  // === Brain Integration ===

  /** Called by Brain (via Engine) when urgent trigger produces a trade proposal */
  receiveProposal(proposal: TradeProposal, snapshot?: MarketSnapshot): void {
    // Apply Brain's directives to validate
    const state = this.marketState;
    if (state && !state.directives.discretionary.active) {
      this.log.info('Proposal rejected: Discretionary disabled by Brain directives');
      return;
    }

    // Apply max leverage from Brain directives
    if (state) {
      const maxLev = state.directives.discretionary.maxLeverage;
      if (proposal.leverage > maxLev) {
        this.log.info({ original: proposal.leverage, capped: maxLev }, 'Leverage capped by Brain directive');
        proposal.leverage = maxLev;
      }
    }

    this.pendingProposals.set(proposal.id, proposal);
    this.log.info({ proposal }, 'Trade proposal received from Brain');

    if (this.onProposal) {
      this.onProposal(proposal, snapshot).catch(err => {
        this.log.error({ err }, 'Failed to send proposal to Telegram');
      });
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

  async handleClosePosition(symbol: string): Promise<string> {
    const position = this.positions.find(p => p.symbol === symbol);
    if (!position) return `No open position for ${symbol}.`;
    return await this.closePosition(position);
  }

  async handlePositionsRequest(): Promise<string> {
    if (this.positions.length === 0) return 'No open discretionary positions.';
    return this.formatPositions();
  }

  // === Trade Execution ===

  private async executeProposal(proposal: TradeProposal): Promise<string> {
    // Block execution if auto-stopped due to consecutive losses
    if (this.isAutoStopped) {
      this.log.warn({ proposal: proposal.id }, 'Proposal execution blocked: auto-stopped (3 consecutive losses)');
      return 'Execution blocked: strategy auto-stopped after 3 consecutive losses. Use /resume to reset.';
    }

    const hl = getHyperliquidClient();

    // Kelly-capped position sizing: LLM proposes size_pct, Kelly provides upper bound
    const kellyMax = this.kellyFraction(undefined, proposal.riskRewardRatio);
    const effectiveSize = Math.min(proposal.size, Math.max(kellyMax, 0.05)); // floor at 5%
    const capitalForTrade = this.allocatedCapital.mul(effectiveSize).mul(this.lossSizeMultiplier);
    const sizeInUnits = capitalForTrade.mul(proposal.leverage).div(proposal.entryPrice);
    const sz = parseFloat(sizeInUnits.toFixed(4));

    try {
      await hl.updateLeverage(proposal.symbol, proposal.leverage);

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

      // Place SL/TP as exchange trigger orders (CRIT-2: not just in-memory)
      let slOrderId: number | undefined;
      let tpOrderId: number | undefined;
      try {
        const slResult = await hl.placeTriggerOrder({
          coin: proposal.symbol,
          isBuy: proposal.side !== 'buy', // opposite side to close
          size: sz.toString(),
          triggerPx: proposal.stopLoss.toString(),
          tpsl: 'sl',
          reduceOnly: true,
        });
        if (slResult.orderId) slOrderId = slResult.orderId;

        const tpResult = await hl.placeTriggerOrder({
          coin: proposal.symbol,
          isBuy: proposal.side !== 'buy',
          size: sz.toString(),
          triggerPx: proposal.takeProfit.toString(),
          tpsl: 'tp',
          reduceOnly: true,
        });
        if (tpResult.orderId) tpOrderId = tpResult.orderId;
      } catch (triggerErr) {
        this.log.warn({ triggerErr, symbol: proposal.symbol }, 'Failed to place SL/TP trigger orders');
      }

      const position = {
        symbol: proposal.symbol,
        side: proposal.side,
        entryPrice: result.filled ? parseFloat(result.avgPrice!) : proposal.entryPrice,
        size: sz,
        leverage: proposal.leverage,
        stopLoss: proposal.stopLoss,
        takeProfit: proposal.takeProfit,
        proposalId: proposal.id,
        openedAt: Date.now(),
        slOrderId,
        tpOrderId,
      };
      this.positions.push(position);
      this.persistPositions();

      proposal.status = 'executed';

      logTrade(this.id, proposal.symbol, proposal.side, proposal.entryPrice, sz, 0, 0, result.orderId?.toString());

      this.emit('trade', {
        strategy: this.name,
        type: 'entry',
        symbol: proposal.symbol,
        side: proposal.side,
        price: proposal.entryPrice.toString(),
      });

      const triggerStatus = slOrderId && tpOrderId ? 'SL/TP ON EXCHANGE' : 'SL/TP PENDING';
      const fillStatus = result.filled ? '(FILLED)' : '(RESTING)';
      return `Order placed ${fillStatus}: ${proposal.side.toUpperCase()} ${sz} ${proposal.symbol} @ $${proposal.entryPrice}\nSL: $${proposal.stopLoss} | TP: $${proposal.takeProfit} [${triggerStatus}]`;
    } catch (err) {
      this.log.error({ err, proposal }, 'Failed to execute proposal');
      return `Execution error: ${String(err)}`;
    }
  }

  private async closePosition(position: ActiveDiscretionaryPosition): Promise<string> {
    const hl = getHyperliquidClient();

    try {
      // Cancel remaining trigger orders (SL/TP) before closing
      try {
        if (position.slOrderId) await hl.cancelOrder(position.symbol, position.slOrderId);
        if (position.tpOrderId) await hl.cancelOrder(position.symbol, position.tpOrderId);
      } catch (cancelErr) {
        this.log.debug({ cancelErr, symbol: position.symbol }, 'Failed to cancel trigger orders (may already be filled)');
      }

      const result = await hl.placeOrder({
        coin: position.symbol,
        isBuy: position.side === 'sell',
        size: position.size.toString(),
        price: '0',
        orderType: 'market',
        reduceOnly: true,
      });

      if (result.error) {
        return `Close failed: ${result.error}`;
      }

      const closePrice = result.avgPrice ? parseFloat(result.avgPrice) : 0;
      const pnl = (closePrice - position.entryPrice) * position.size * (position.side === 'buy' ? 1 : -1);

      this.positions = this.positions.filter(p => p.proposalId !== position.proposalId);
      this.persistPositions();

      logTrade(this.id, position.symbol, position.side === 'buy' ? 'sell' : 'buy', closePrice, position.size, 0, pnl);
      this.recordTrade(new Decimal(pnl));

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

  // === DB Persistence (CRIT-3) ===

  private persistPositions(): void {
    try {
      saveStrategyState('discretionary_positions', this.positions);
    } catch (err) {
      this.log.warn({ err }, 'Failed to persist discretionary positions');
    }
  }

  private restorePositions(): void {
    try {
      const saved = loadStrategyState<ActiveDiscretionaryPosition[]>('discretionary_positions');
      if (saved && Array.isArray(saved) && saved.length > 0) {
        this.positions = saved;
        this.log.info({ count: saved.length }, 'Restored discretionary positions from DB');
      }
    } catch (err) {
      this.log.warn({ err }, 'Failed to restore discretionary positions');
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

  // === Cross-Exposure (v3) ===

  override getPositionSummaries(): StrategyPositionSummary[] {
    return this.positions.map(p => ({
      strategyId: this.id,
      symbol: p.symbol,
      side: p.side,
      notionalValue: Math.abs(p.entryPrice * p.size),
    }));
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
}
