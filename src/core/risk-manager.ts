import { Decimal } from 'decimal.js';
import { config } from '../config/index.js';
import { createChildLogger } from '../monitoring/logger.js';
import { saveStrategyState, loadStrategyState } from '../data/storage.js';
import type { TradeSignal, RiskCheckResult, RiskLimits } from './types.js';
import type { Strategy } from '../strategies/base.js';

const log = createChildLogger('risk-manager');

export class RiskManager {
  private limits: RiskLimits;
  private peakPortfolioValue: Decimal = new Decimal(0);
  private currentPortfolioValue: Decimal = new Decimal(0);

  constructor(limits?: Partial<RiskLimits>) {
    this.limits = {
      maxGlobalDrawdownPct: limits?.maxGlobalDrawdownPct ?? config.maxGlobalDrawdownPct,
      maxStrategyDrawdownPct: limits?.maxStrategyDrawdownPct ?? config.maxStrategyDrawdownPct,
      maxPositionSizePct: limits?.maxPositionSizePct ?? 5,
      maxDailyLossPct: limits?.maxDailyLossPct ?? config.maxDailyLossPct,
      maxOpenPositions: limits?.maxOpenPositions ?? 20,
      maxLeverage: limits?.maxLeverage ?? 15,
    };
    this.restorePeakValue();
  }

  checkSignal(signal: TradeSignal, strategy: Strategy): RiskCheckResult {
    // Check if strategy is running
    if (!strategy.isRunning()) {
      return { approved: false, reason: `Strategy ${signal.strategyId} is not running` };
    }

    // Check strategy drawdown
    const strategyDrawdown = strategy.getDrawdownPct();
    if (strategyDrawdown >= this.limits.maxStrategyDrawdownPct) {
      log.warn(
        { strategyId: signal.strategyId, drawdown: strategyDrawdown },
        'Strategy drawdown limit reached - pausing strategy'
      );
      strategy.pause();
      return {
        approved: false,
        reason: `Strategy drawdown ${strategyDrawdown.toFixed(1)}% exceeds limit ${this.limits.maxStrategyDrawdownPct}%`,
      };
    }

    // Check daily loss limit
    const dailyLoss = strategy.getDailyLossPct();
    if (dailyLoss >= this.limits.maxDailyLossPct) {
      log.warn(
        { strategyId: signal.strategyId, dailyLoss },
        'Daily loss limit reached - pausing strategy'
      );
      strategy.pause();
      return {
        approved: false,
        reason: `Daily loss ${dailyLoss.toFixed(1)}% exceeds limit ${this.limits.maxDailyLossPct}%`,
      };
    }

    // Position size check (grid bot manages its own sizing, so we allow for now)

    log.debug({ strategyId: signal.strategyId, symbol: signal.symbol }, 'Signal approved');
    return { approved: true };
  }

  updatePortfolioValue(value: Decimal): void {
    this.currentPortfolioValue = value;
    if (value.greaterThan(this.peakPortfolioValue)) {
      this.peakPortfolioValue = value;
      this.persistPeakValue();
    }
  }

  persistPeakValue(): void {
    try {
      saveStrategyState('__risk_manager__', {
        peakPortfolioValue: this.peakPortfolioValue.toString(),
      });
    } catch {}
  }

  restorePeakValue(): void {
    try {
      const state = loadStrategyState<{ peakPortfolioValue: string }>('__risk_manager__');
      if (state?.peakPortfolioValue) {
        this.peakPortfolioValue = new Decimal(state.peakPortfolioValue);
        log.info({ peak: this.peakPortfolioValue.toString() }, 'Peak portfolio value restored');
      }
    } catch {}
  }

  checkGlobalDrawdown(): RiskCheckResult & { drawdownPct?: number; level?: 'normal' | 'warning' | 'critical' } {
    if (this.peakPortfolioValue.isZero()) return { approved: true, drawdownPct: 0, level: 'normal' };

    const drawdownPct = this.peakPortfolioValue
      .minus(this.currentPortfolioValue)
      .div(this.peakPortfolioValue)
      .mul(100)
      .toNumber();

    // Critical: hard stop at maxGlobalDrawdownPct (20%)
    if (drawdownPct >= this.limits.maxGlobalDrawdownPct) {
      log.error(
        { drawdown: drawdownPct, peak: this.peakPortfolioValue.toString(), current: this.currentPortfolioValue.toString() },
        'GLOBAL DRAWDOWN LIMIT REACHED - ALL STRATEGIES SHOULD PAUSE'
      );
      return {
        approved: false,
        drawdownPct,
        level: 'critical',
        reason: `Global drawdown ${drawdownPct.toFixed(1)}% exceeds limit ${this.limits.maxGlobalDrawdownPct}%`,
      };
    }

    // Warning at 15%
    if (drawdownPct >= 15) {
      log.warn(
        { drawdown: drawdownPct, peak: this.peakPortfolioValue.toString(), current: this.currentPortfolioValue.toString() },
        'DRAWDOWN WARNING - approaching limit'
      );
      return { approved: true, drawdownPct, level: 'warning' };
    }

    return { approved: true, drawdownPct, level: 'normal' };
  }

  getLimits(): RiskLimits {
    return { ...this.limits };
  }

  getCurrentValue(): Decimal {
    return this.currentPortfolioValue;
  }

  getGlobalDrawdownPct(): number {
    if (this.peakPortfolioValue.isZero()) return 0;
    return this.peakPortfolioValue
      .minus(this.currentPortfolioValue)
      .div(this.peakPortfolioValue)
      .mul(100)
      .toNumber();
  }
}
