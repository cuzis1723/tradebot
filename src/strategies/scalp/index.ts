import { Decimal } from 'decimal.js';
import { Strategy } from '../base.js';
import { getHyperliquidClient } from '../../exchanges/hyperliquid/client.js';
import { logTrade, saveStrategyState, loadStrategyState, openPositionLifecycle, closePositionLifecycle, addManagementAction } from '../../data/storage.js';
import type {
  StrategyTier,
  TradingMode,
  TradeSignal,
  FilledOrder,
  ScalpConfig,
  TradeProposal,
  MarketSnapshot,
  ActiveDiscretionaryPosition,
  StrategyPositionSummary,
} from '../../core/types.js';
import type { PositionManagementAction } from '../../core/skills/types.js';

/**
 * Scalp Strategy — Auto-Execute Short-Term Trading
 *
 * Key differences from Discretionary:
 * - Auto-execute: proposals are executed immediately (no Telegram approval)
 * - Time-boxed: positions held > maxHoldTime are force-closed
 * - More aggressive Kelly: 0.75x (vs 0.5x)
 * - Higher size floor: 8% (vs 5%)
 * - Max 2 concurrent positions
 * - 3 consecutive losses → 1h cooldown then auto-resume (vs full stop)
 */
export class ScalpStrategy extends Strategy {
  readonly id = 'scalp';
  readonly name = 'Scalp Trading';
  readonly tier: StrategyTier = 'growth';
  readonly mode: TradingMode = 'auto';

  private config: ScalpConfig;
  private positions: ActiveDiscretionaryPosition[] = [];
  private holdTimeCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lossCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private closeRetryCount: Map<string, number> = new Map();

  // Callback to send Telegram messages
  public onMessage: ((msg: string) => Promise<void>) | null = null;
  public onTradeClose: ((position: ActiveDiscretionaryPosition, closePrice: number, pnl: number) => Promise<void>) | null = null;

  constructor(cfg: ScalpConfig) {
    super();
    this.config = cfg;
  }

  async onInit(): Promise<void> {
    this.log.info({ symbols: this.config.symbols }, 'Scalp strategy initializing (auto-execute)');
    this.restorePositions();

    // Check max hold time every 60 seconds
    this.holdTimeCheckInterval = setInterval(() => {
      this.checkMaxHoldTime().catch(err => {
        this.log.error({ err }, 'Max hold time check error');
      });
    }, 60_000);
  }

  async onTick(_data: Record<string, string>): Promise<TradeSignal | null> {
    return null;
  }

  async onOrderFilled(order: FilledOrder): Promise<void> {
    this.log.info({ order }, 'Scalp order filled');
    this.recordTrade(order.fee.negated());
  }

  async onStop(): Promise<void> {
    if (this.holdTimeCheckInterval) {
      clearInterval(this.holdTimeCheckInterval);
      this.holdTimeCheckInterval = null;
    }
    if (this.lossCooldownTimer) {
      clearTimeout(this.lossCooldownTimer);
      this.lossCooldownTimer = null;
    }
    await this.closeAllPositions();
    this.log.info('Scalp strategy stopped');
  }

  // === Override consecutive loss behavior ===

  override recordTrade(pnl: Decimal): void {
    this.realizedPnl = this.realizedPnl.plus(pnl);
    this.totalTrades++;
    if (pnl.greaterThan(0)) {
      this.winningTrades++;
    } else if (pnl.lessThan(0)) {
      this.losingTrades++;
    }

    if (pnl.lessThan(0)) {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= 4) {
        // 4 consecutive losses → full auto-stop (same as discretionary at 3)
        this.lossSizeMultiplier = 0;
        this.isAutoStopped = true;
        this.pause();
        this.log.error({ consecutiveLosses: this.consecutiveLosses }, 'Scalp auto-stopped: 4 consecutive losses');
      } else if (this.consecutiveLosses >= 3) {
        // 3 consecutive losses → 1h cooldown then auto-resume
        this.lossSizeMultiplier = 0.5;
        this.pause();
        this.log.warn({ consecutiveLosses: this.consecutiveLosses }, 'Scalp paused: 3 consecutive losses, auto-resume in 1h');
        this.scheduleLossCooldownResume();
      } else if (this.consecutiveLosses >= 2) {
        this.lossSizeMultiplier = 0.5;
        this.log.warn({ consecutiveLosses: this.consecutiveLosses, multiplier: 0.5 }, 'Scalp position size reduced: 2 consecutive losses');
      }
    } else {
      this.consecutiveLosses = 0;
      this.lossSizeMultiplier = 1.0;
      this.isAutoStopped = false;
    }

    // Track daily PnL
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.dailyPnlResetDate) {
      this.dailyPnl = new Decimal(0);
      this.dailyPnlResetDate = today;
    }
    this.dailyPnl = this.dailyPnl.plus(pnl);

    // Track peak for drawdown
    const currentCapital = this.allocatedCapital.plus(this.realizedPnl);
    if (currentCapital.greaterThan(this.peakCapital)) {
      this.peakCapital = currentCapital;
    }
  }

  private scheduleLossCooldownResume(): void {
    if (this.lossCooldownTimer) clearTimeout(this.lossCooldownTimer);
    this.lossCooldownTimer = setTimeout(() => {
      if (this.consecutiveLosses === 3 && !this.isAutoStopped) {
        this.resume();
        this.lossSizeMultiplier = 0.75; // Resume at 75% size
        this.log.info('Scalp auto-resumed after 1h loss cooldown (75% size)');
        if (this.onMessage) {
          this.onMessage('⏰ Scalp strategy auto-resumed after 1h cooldown (75% size)').catch(() => {});
        }
      }
    }, 60 * 60 * 1000); // 1 hour
  }

  // === Brain Integration (Auto-Execute) ===

  /** Called by Brain (via Engine) when scalp trigger produces a trade proposal */
  receiveProposal(proposal: TradeProposal, _snapshot?: MarketSnapshot): void {
    // Check Brain directives
    const state = this.marketState;
    if (state && !state.directives.scalp.active) {
      this.log.info('Scalp proposal rejected: disabled by Brain directives');
      return;
    }

    // Apply max leverage from Brain directives
    if (state) {
      const maxLev = state.directives.scalp.maxLeverage;
      if (proposal.leverage > maxLev) {
        this.log.info({ original: proposal.leverage, capped: maxLev }, 'Scalp leverage capped by Brain directive');
        proposal.leverage = maxLev;
      }
    }

    // Check concurrent position limit
    if (this.positions.length >= this.config.maxConcurrentPositions) {
      this.log.info({ current: this.positions.length, max: this.config.maxConcurrentPositions },
        'Scalp proposal rejected: max concurrent positions reached');
      return;
    }

    // Check for duplicate symbol (no double-up on same symbol)
    if (this.positions.some(p => p.symbol === proposal.symbol)) {
      this.log.info({ symbol: proposal.symbol }, 'Scalp proposal rejected: already have position on this symbol');
      return;
    }

    // AUTO-EXECUTE: no pending, execute immediately
    this.log.info({ proposal }, 'Scalp: auto-executing proposal');
    this.executeProposal(proposal).then(result => {
      // Notify via Telegram (after execution)
      if (this.onMessage) {
        const msg = `⚡ <b>Scalp Auto-Execute</b>\n${result}`;
        this.onMessage(msg).catch(() => {});
      }
    }).catch(err => {
      this.log.error({ err, proposal }, 'Scalp auto-execution failed');
    });
  }

  // === Trade Execution ===

  private async executeProposal(proposal: TradeProposal): Promise<string> {
    if (this.isAutoStopped) {
      return 'Scalp execution blocked: auto-stopped after consecutive losses. Use /resume scalp to reset.';
    }

    const hl = getHyperliquidClient();

    // Scalp uses 0.75x Kelly (more aggressive than discretionary's 0.5x)
    const kellyMax = this.kellyFraction(undefined, proposal.riskRewardRatio, 0.75);
    const effectiveSize = Math.min(proposal.size, Math.max(kellyMax, 0.08)); // floor at 8% (vs 5%)
    const cappedSize = Math.min(effectiveSize, 0.20); // max 20% per scalp trade
    const capitalForTrade = this.allocatedCapital.mul(cappedSize).mul(this.lossSizeMultiplier);
    const sizeInUnits = capitalForTrade.mul(proposal.leverage).div(proposal.entryPrice);
    const szDecimals = await hl.getSzDecimals(proposal.symbol);
    const sz = parseFloat(sizeInUnits.toFixed(szDecimals));
    const notional = capitalForTrade.mul(proposal.leverage).toNumber();

    if (sz <= 0) {
      this.log.warn({ symbol: proposal.symbol, raw: sizeInUnits.toString(), szDecimals }, 'Scalp size too small after rounding');
      return `Scalp blocked: position size too small for ${proposal.symbol}`;
    }

    // Cross-exposure check
    if (!this.canOpenPosition(proposal.symbol, notional)) {
      this.log.warn({ symbol: proposal.symbol, notional }, 'Scalp blocked by cross-exposure limit');
      return `Scalp blocked: cross-exposure limit exceeded for ${proposal.symbol}`;
    }

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
        return `Scalp order failed: ${result.error}`;
      }

      // Place SL/TP on exchange
      let slOrderId: number | undefined;
      let tpOrderId: number | undefined;
      try {
        const slResult = await hl.placeTriggerOrder({
          coin: proposal.symbol,
          isBuy: proposal.side !== 'buy',
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
        this.log.warn({ triggerErr, symbol: proposal.symbol }, 'Failed to place scalp SL/TP trigger orders');
      }

      const position: ActiveDiscretionaryPosition = {
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
        entryContext: proposal.entryContext,
      };
      this.positions.push(position);
      this.persistPositions();

      // Track lifecycle
      try {
        position.lifecycleId = openPositionLifecycle({
          strategyId: this.id,
          proposalUuid: proposal.id,
          symbol: proposal.symbol,
          side: proposal.side,
          entryPrice: position.entryPrice,
          entrySize: sz,
          leverage: proposal.leverage,
          stopLoss: proposal.stopLoss,
          takeProfit: proposal.takeProfit,
          entryRationale: proposal.entryContext,
          confidence: proposal.confidence,
        });
        this.persistPositions();
      } catch (e) {
        this.log.debug({ err: e }, 'Failed to open lifecycle record');
      }

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
      return `${proposal.side.toUpperCase()} ${sz} ${proposal.symbol} @ $${proposal.entryPrice} ${fillStatus}\nSL: $${proposal.stopLoss} | TP: $${proposal.takeProfit} [${triggerStatus}]`;
    } catch (err) {
      this.log.error({ err, proposal }, 'Scalp execution error');
      return `Scalp execution error: ${String(err)}`;
    }
  }

  // === Position Management ===

  /** Get actual exchange position size for a symbol. Returns 0 if no position found. */
  private async getExchangePositionSize(symbol: string): Promise<number> {
    const hl = getHyperliquidClient();
    try {
      const positions = await hl.getPositions();
      const coin = symbol.replace('-PERP', '');
      const pos = positions.find(
        p => p.position.coin === coin || p.position.coin === symbol,
      );
      return pos ? Math.abs(parseFloat(pos.position.szi)) : 0;
    } catch (err) {
      this.log.warn({ err, symbol }, 'Failed to verify exchange position');
      return -1; // -1 = unknown, proceed cautiously
    }
  }

  /** Remove a position from local state when it no longer exists on exchange */
  private removeStalePosition(position: ActiveDiscretionaryPosition, reason: string): void {
    this.positions = this.positions.filter(p => p.proposalId !== position.proposalId);
    this.closeRetryCount.delete(position.proposalId);
    this.persistPositions();
    this.log.warn({ symbol: position.symbol, reason }, 'Removed stale scalp position');
  }

  async handlePositionManagement(action: PositionManagementAction): Promise<string> {
    const position = this.positions.find(p => p.symbol === action.symbol);
    if (!position) return `No scalp position found for ${action.symbol}`;

    const hl = getHyperliquidClient();

    switch (action.action) {
      case 'trail_stop':
      case 'move_to_breakeven': {
        const newSl = action.action === 'move_to_breakeven' ? position.entryPrice : action.newStopLoss;
        if (!newSl) return 'No new SL price provided';

        // Verify exchange position exists before updating SL
        const actualSize = await this.getExchangePositionSize(position.symbol);
        if (actualSize === 0) {
          this.removeStalePosition(position, 'no exchange position for SL update');
          return `Scalp SL update skipped: ${position.symbol} position no longer exists on exchange (likely closed by SL/TP trigger)`;
        }

        try {
          // Use actual exchange size for trigger order to avoid size mismatch
          const effectiveSize = actualSize > 0 ? Math.min(position.size, actualSize) : position.size;
          if (position.slOrderId) await hl.cancelOrder(position.symbol, position.slOrderId).catch(() => {});
          const slResult = await hl.placeTriggerOrder({
            coin: position.symbol,
            isBuy: position.side !== 'buy',
            size: effectiveSize.toString(),
            triggerPx: newSl.toString(),
            tpsl: 'sl',
            reduceOnly: true,
          });
          position.stopLoss = newSl;
          if (slResult.orderId) position.slOrderId = slResult.orderId;
          this.persistPositions();
          if (position.lifecycleId) {
            try {
              addManagementAction(position.lifecycleId, {
                time: Date.now(),
                action: action.action,
                detail: `SL updated to ${newSl.toFixed(2)}`,
              });
            } catch (e) {
              this.log.debug({ err: e }, 'Failed to log management action');
            }
          }
          return `Scalp SL updated: ${position.symbol} new SL @ $${newSl.toFixed(2)} (${action.reasoning})`;
        } catch (err) {
          this.log.error({ err }, 'Failed to update scalp SL');
          return `Failed to update scalp SL: ${String(err)}`;
        }
      }
      case 'partial_close': {
        const closePct = action.partialClosePct ?? 50;
        const closeSzDecimals = await hl.getSzDecimals(position.symbol);

        // Verify exchange position before attempting reduce-only close
        const actualSize = await this.getExchangePositionSize(position.symbol);
        if (actualSize === 0) {
          this.removeStalePosition(position, 'no exchange position for partial close');
          return `Scalp partial close skipped: ${position.symbol} position no longer exists on exchange (likely closed by SL/TP trigger)`;
        }

        // Use actual exchange size to prevent "would increase position" error
        const effectiveSize = actualSize > 0 ? Math.min(position.size, actualSize) : position.size;
        const closeSize = effectiveSize * (closePct / 100);

        try {
          const result = await hl.placeOrder({
            coin: position.symbol,
            isBuy: position.side === 'sell',
            size: closeSize.toFixed(closeSzDecimals),
            price: '0',
            orderType: 'market',
            reduceOnly: true,
          });
          if (result.error) {
            this.log.error({ symbol: position.symbol, error: result.error }, 'Scalp partial close order failed');
            return `Scalp partial close failed: ${result.error}`;
          }
          position.size -= closeSize;
          this.persistPositions();
          const closePrice = result.avgPrice ? parseFloat(result.avgPrice) : 0;
          const pnl = (closePrice - position.entryPrice) * closeSize * (position.side === 'buy' ? 1 : -1);
          logTrade(this.id, position.symbol, position.side === 'buy' ? 'sell' : 'buy', closePrice, closeSize, 0, pnl);
          if (position.lifecycleId) {
            try {
              addManagementAction(position.lifecycleId, {
                time: Date.now(),
                action: action.action,
                detail: `Partial close ${closePct}% at $${closePrice.toFixed(2)}, PnL: $${pnl.toFixed(2)}`,
              });
            } catch (e) {
              this.log.debug({ err: e }, 'Failed to log management action');
            }
          }
          return `Scalp partial close ${closePct}%: ${position.symbol} @ $${closePrice.toFixed(2)} PnL: $${pnl.toFixed(2)}`;
        } catch (err) {
          this.log.error({ err }, 'Failed to partial close scalp');
          return `Failed to partial close scalp: ${String(err)}`;
        }
      }
      case 'close_now': {
        if (position.lifecycleId) {
          try {
            addManagementAction(position.lifecycleId, {
              time: Date.now(),
              action: action.action,
              detail: `Close requested: ${action.reasoning}`,
            });
          } catch (e) {
            this.log.debug({ err: e }, 'Failed to log management action');
          }
        }
        const msg = await this.closePosition(position, action.reasoning || 'brain_close');
        return `${msg} (Reason: ${action.reasoning})`;
      }
      default:
        return `Unknown action: ${action.action}`;
    }
  }

  async handleClosePosition(symbol: string): Promise<string> {
    const position = this.positions.find(p => p.symbol === symbol);
    if (!position) return `No scalp position for ${symbol}.`;
    return await this.closePosition(position);
  }

  private async closePosition(position: ActiveDiscretionaryPosition, reason = 'manual'): Promise<string> {
    const hl = getHyperliquidClient();

    try {
      try {
        if (position.slOrderId) await hl.cancelOrder(position.symbol, position.slOrderId);
        if (position.tpOrderId) await hl.cancelOrder(position.symbol, position.tpOrderId);
      } catch (cancelErr) {
        this.log.debug({ cancelErr, symbol: position.symbol }, 'Failed to cancel scalp trigger orders');
      }

      // Verify actual exchange position to avoid "reduce only would increase" errors
      const actualSize = await this.getExchangePositionSize(position.symbol);
      if (actualSize === 0) {
        // Position already closed on exchange (e.g., by SL/TP trigger) — clean up local state
        this.positions = this.positions.filter(p => p.proposalId !== position.proposalId);
        this.closeRetryCount.delete(position.proposalId);
        this.persistPositions();
        const held = Math.floor((Date.now() - position.openedAt) / 60_000);
        this.log.info({ symbol: position.symbol, reason }, 'Scalp position already closed on exchange');
        return `Scalp already closed on exchange: ${position.symbol} (held ${held}min, reason: ${reason})`;
      }

      // Use actual exchange size (may differ if partial fills occurred)
      const closeQty = actualSize > 0 ? Math.min(position.size, actualSize) : position.size;

      const result = await hl.placeOrder({
        coin: position.symbol,
        isBuy: position.side === 'sell',
        size: closeQty.toString(),
        price: '0',
        orderType: 'market',
        reduceOnly: true,
      });

      if (result.error) {
        return `Scalp close failed: ${result.error}`;
      }

      const closePrice = result.avgPrice ? parseFloat(result.avgPrice) : 0;
      const pnl = (closePrice - position.entryPrice) * closeQty * (position.side === 'buy' ? 1 : -1);

      this.positions = this.positions.filter(p => p.proposalId !== position.proposalId);
      this.closeRetryCount.delete(position.proposalId);
      this.persistPositions();

      if (position.lifecycleId) {
        try {
          const heldMin = Math.floor((Date.now() - position.openedAt) / 60_000);
          const pnlPct = position.entryPrice > 0 ? (pnl / (position.entryPrice * position.size)) * 100 : 0;
          closePositionLifecycle(position.lifecycleId, {
            closePrice,
            closeReason: reason,
            pnl,
            pnlPct,
            heldMinutes: heldMin,
          });
        } catch (e) {
          this.log.debug({ err: e }, 'Failed to close lifecycle record');
        }
      }

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

      // Trigger post-trade review
      if (this.onTradeClose) {
        this.onTradeClose(position, closePrice, pnl).catch(err => {
          this.log.debug({ err }, 'Scalp trade review callback failed');
        });
      }

      const held = Math.floor((Date.now() - position.openedAt) / 60_000);
      return `Scalp closed: ${position.symbol} @ $${closePrice.toFixed(2)} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (held ${held}min)`;
    } catch (err) {
      this.log.error({ err }, 'Failed to close scalp position');
      return `Scalp close error: ${String(err)}`;
    }
  }

  // === Max Hold Time Check ===

  private async checkMaxHoldTime(): Promise<void> {
    const MAX_CLOSE_RETRIES = 3;
    const now = Date.now();
    for (const position of [...this.positions]) {
      const heldMs = now - position.openedAt;
      if (heldMs > this.config.maxHoldTimeMs) {
        const retryKey = position.proposalId;
        const retries = this.closeRetryCount.get(retryKey) ?? 0;

        if (retries >= MAX_CLOSE_RETRIES) {
          // Already failed too many times — skip to avoid spam
          continue;
        }

        const heldMin = Math.floor(heldMs / 60_000);
        this.log.warn({ symbol: position.symbol, heldMin, attempt: retries + 1 }, 'Scalp max hold time exceeded, force-closing');
        const result = await this.closePosition(position, 'max_hold_time');

        // If position is still open (close failed), increment retry counter
        if (this.positions.some(p => p.proposalId === position.proposalId)) {
          this.closeRetryCount.set(retryKey, retries + 1);
          if (retries + 1 >= MAX_CLOSE_RETRIES) {
            this.log.error({ symbol: position.symbol, retries: retries + 1 }, 'Scalp close failed max retries — manual intervention needed');
            if (this.onMessage) {
              this.onMessage(`🚨 <b>Scalp Close FAILED ${MAX_CLOSE_RETRIES}x</b>\n${position.symbol} — manual /scalpclose needed`).catch(() => {});
            }
          }
        } else {
          // Successfully closed — clean up retry counter
          this.closeRetryCount.delete(retryKey);
        }

        if (this.onMessage) {
          this.onMessage(`⏰ <b>Scalp Max Hold Time</b>\n${result}`).catch(() => {});
        }
      }
    }
  }

  private async closeAllPositions(): Promise<void> {
    for (const position of [...this.positions]) {
      await this.closePosition(position, 'strategy_stop');
    }
  }

  // === DB Persistence ===

  private persistPositions(): void {
    try {
      saveStrategyState('scalp_positions', this.positions);
    } catch (err) {
      this.log.warn({ err }, 'Failed to persist scalp positions');
    }
  }

  private restorePositions(): void {
    try {
      const saved = loadStrategyState<ActiveDiscretionaryPosition[]>('scalp_positions');
      if (saved && Array.isArray(saved) && saved.length > 0) {
        this.positions = saved;
        this.log.info({ count: saved.length }, 'Restored scalp positions from DB');
      }
    } catch (err) {
      this.log.warn({ err }, 'Failed to restore scalp positions');
    }
  }

  // === Helpers ===

  formatPositions(): string {
    if (this.positions.length === 0) return 'No open scalp positions.';

    const lines = ['<b>Open Scalp Positions</b>\n'];
    for (const pos of this.positions) {
      const sideIcon = pos.side === 'buy' ? '🟢' : '🔴';
      const held = Math.floor((Date.now() - pos.openedAt) / 60_000);
      const maxHoldMin = Math.floor(this.config.maxHoldTimeMs / 60_000);
      lines.push(
        `${sideIcon} ${pos.symbol} | ${pos.side.toUpperCase()} ${pos.size} @ $${pos.entryPrice.toFixed(2)}`,
        `  SL: $${pos.stopLoss.toFixed(2)} | TP: $${pos.takeProfit.toFixed(2)} | ${held}/${maxHoldMin}min`,
      );
    }
    return lines.join('\n');
  }

  // === Cross-Exposure ===

  override getPositionSummaries(): StrategyPositionSummary[] {
    return this.positions.map(p => ({
      strategyId: this.id,
      symbol: p.symbol,
      side: p.side,
      notionalValue: Math.abs(p.entryPrice * p.size),
    }));
  }

  getPositions(): ActiveDiscretionaryPosition[] {
    return [...this.positions];
  }
}
