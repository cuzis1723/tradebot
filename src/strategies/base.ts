import { Decimal } from 'decimal.js';
import { EventEmitter } from 'events';
import type { StrategyTier, StrategyStatus, TradeSignal, FilledOrder, StrategyPerformance, TradingMode, MarketState } from '../core/types.js';
import { createChildLogger } from '../monitoring/logger.js';

export abstract class Strategy extends EventEmitter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly tier: StrategyTier;
  abstract readonly mode: TradingMode;

  protected status: StrategyStatus = 'idle';
  protected allocatedCapital: Decimal = new Decimal(0);
  protected realizedPnl: Decimal = new Decimal(0);
  protected unrealizedPnl: Decimal = new Decimal(0);
  protected peakCapital: Decimal = new Decimal(0);
  protected totalTrades = 0;
  protected winningTrades = 0;
  protected losingTrades = 0;
  protected dailyPnl: Decimal = new Decimal(0);
  protected dailyPnlResetDate = '';
  protected log;

  // Consecutive loss tracking (v3: auto position reduction)
  protected consecutiveLosses = 0;
  protected lossSizeMultiplier = 1.0;
  protected isAutoStopped = false;

  /** Shared market state from Brain (updated every 30min comprehensive + 5min urgent) */
  private _marketState: Readonly<MarketState> | null = null;

  constructor() {
    super();
    this.log = createChildLogger('strategy');
  }

  abstract onInit(): Promise<void>;
  abstract onTick(data: Record<string, string>): Promise<TradeSignal | null>;
  abstract onOrderFilled(order: FilledOrder): Promise<void>;
  abstract onStop(): Promise<void>;

  async start(capital: Decimal): Promise<void> {
    this.allocatedCapital = capital;
    this.peakCapital = capital;
    this.status = 'running';
    this.log = createChildLogger(this.id);
    this.log.info({ capital: capital.toString() }, `Strategy ${this.name} started`);
    await this.onInit();
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
    this.log.info(`Strategy ${this.name} stopped`);
    await this.onStop();
  }

  pause(): void {
    this.status = 'paused';
    this.log.warn(`Strategy ${this.name} paused`);
  }

  resume(): void {
    if (this.status === 'paused') {
      this.status = 'running';
      this.log.info(`Strategy ${this.name} resumed`);
    }
  }

  recordTrade(pnl: Decimal): void {
    this.realizedPnl = this.realizedPnl.plus(pnl);
    this.totalTrades++;
    if (pnl.greaterThan(0)) {
      this.winningTrades++;
    } else if (pnl.lessThan(0)) {
      this.losingTrades++;
    }

    // Consecutive loss tracking (v3)
    if (pnl.lessThan(0)) {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= 3) {
        this.lossSizeMultiplier = 0;
        this.isAutoStopped = true;
        this.pause();
        this.log.error({ consecutiveLosses: this.consecutiveLosses }, 'Auto-stopped: 3 consecutive losses');
      } else if (this.consecutiveLosses >= 2) {
        this.lossSizeMultiplier = 0.5;
        this.log.warn({ consecutiveLosses: this.consecutiveLosses, multiplier: 0.5 }, 'Position size reduced: 2 consecutive losses');
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

  getDrawdownPct(): number {
    const currentCapital = this.allocatedCapital.plus(this.realizedPnl);
    if (this.peakCapital.isZero()) return 0;
    return this.peakCapital.minus(currentCapital).div(this.peakCapital).mul(100).toNumber();
  }

  getDailyLossPct(): number {
    if (this.allocatedCapital.isZero()) return 0;
    if (this.dailyPnl.greaterThanOrEqualTo(0)) return 0;
    return this.dailyPnl.abs().div(this.allocatedCapital).mul(100).toNumber();
  }

  getPerformance(): StrategyPerformance {
    return {
      strategyId: this.id,
      totalPnl: this.realizedPnl.plus(this.unrealizedPnl),
      realizedPnl: this.realizedPnl,
      unrealizedPnl: this.unrealizedPnl,
      winRate: this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0,
      totalTrades: this.totalTrades,
      winningTrades: this.winningTrades,
      losingTrades: this.losingTrades,
      maxDrawdown: new Decimal(this.getDrawdownPct()),
      sharpeRatio: 0, // TODO: implement
    };
  }

  getStatus(): StrategyStatus {
    return this.status;
  }

  isRunning(): boolean {
    return this.status === 'running';
  }

  getConsecutiveLosses(): number {
    return this.consecutiveLosses;
  }

  getLossSizeMultiplier(): number {
    return this.lossSizeMultiplier;
  }

  getIsAutoStopped(): boolean {
    return this.isAutoStopped;
  }

  resetConsecutiveLosses(): void {
    this.consecutiveLosses = 0;
    this.lossSizeMultiplier = 1.0;
    this.isAutoStopped = false;
    this.log.info('Consecutive losses reset manually');
  }

  /** Called by Engine when Brain updates the market state */
  setMarketState(state: Readonly<MarketState>): void {
    this._marketState = state;
  }

  /** Access current market state from Brain */
  protected get marketState(): Readonly<MarketState> | null {
    return this._marketState;
  }
}
