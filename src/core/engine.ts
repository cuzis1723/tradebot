import { Decimal } from 'decimal.js';
import { config } from '../config/index.js';
import { createChildLogger } from '../monitoring/logger.js';
import { RiskManager } from './risk-manager.js';
import { getHyperliquidClient, type HyperliquidClient } from '../exchanges/hyperliquid/client.js';
import { initTelegram, sendAlert, sendTradeAlert, stopTelegram } from '../monitoring/telegram.js';
import { getDb, closeDb } from '../data/storage.js';
import type { Strategy } from '../strategies/base.js';
import type { EngineStatus } from './types.js';

const log = createChildLogger('engine');

export class TradingEngine {
  private strategies: Map<string, Strategy> = new Map();
  private riskManager: RiskManager;
  private hlClient: HyperliquidClient;
  private running = false;
  private startTime = 0;
  private priceCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.riskManager = new RiskManager();
    this.hlClient = getHyperliquidClient();
  }

  addStrategy(strategy: Strategy): void {
    this.strategies.set(strategy.id, strategy);

    // Listen for trade events from strategy
    strategy.on('trade', (data: { strategy: string; type: string; symbol?: string; side?: string; price?: string; profit?: string; totalPnl?: string }) => {
      sendTradeAlert(data).catch((err) => {
        log.error({ err }, 'Failed to send trade alert');
      });
    });

    log.info({ id: strategy.id, name: strategy.name }, 'Strategy registered');
  }

  async start(): Promise<void> {
    log.info('Starting trading engine...');

    // Ensure data directory exists
    const fs = await import('fs');
    if (!fs.existsSync('data')) {
      fs.mkdirSync('data', { recursive: true });
    }

    // Initialize database
    getDb();

    // Connect to Hyperliquid
    await this.hlClient.connect();

    // Get initial balance
    const balance = await this.hlClient.getBalance();
    this.riskManager.updatePortfolioValue(balance);
    log.info({ balance: balance.toString() }, 'Account balance');

    // Initialize Telegram
    initTelegram({
      getStatus: () => this.getStatus(),
      pauseStrategy: (id: string) => this.pauseStrategy(id),
      resumeStrategy: (id: string) => this.resumeStrategy(id),
      stopAll: () => this.stop(),
    });

    // Start all strategies
    const totalCapital = new Decimal(config.initialCapitalUsd);
    for (const [id, strategy] of this.strategies) {
      let capitalPct: number;
      switch (strategy.tier) {
        case 'foundation':
          capitalPct = (config.gridCapitalPct + config.fundingArbCapitalPct) / this.countByTier('foundation');
          break;
        case 'growth':
          capitalPct = config.momentumCapitalPct / this.countByTier('growth');
          break;
        case 'moonshot':
          capitalPct = config.sniperCapitalPct / this.countByTier('moonshot');
          break;
      }
      const capital = totalCapital.mul(capitalPct).div(100);

      try {
        await strategy.start(capital);
        log.info({ id, capital: capital.toString() }, 'Strategy started');
      } catch (err) {
        log.error({ err, id }, 'Failed to start strategy');
      }
    }

    // Subscribe to price updates
    this.hlClient.subscribeToPrices((data) => {
      this.onPriceTick(data).catch((err) => {
        log.error({ err }, 'Error processing price tick');
      });
    });

    // Periodic balance/risk check (every 5 minutes)
    this.priceCheckInterval = setInterval(() => {
      this.periodicCheck().catch((err) => {
        log.error({ err }, 'Error in periodic check');
      });
    }, 5 * 60 * 1000);

    this.running = true;
    this.startTime = Date.now();

    await sendAlert('🤖 <b>TradeBot Started</b>\n\nAll strategies initialized and running.');
    log.info('Trading engine started successfully');
  }

  private countByTier(tier: string): number {
    let count = 0;
    for (const s of this.strategies.values()) {
      if (s.tier === tier) count++;
    }
    return Math.max(count, 1);
  }

  private async onPriceTick(data: Record<string, string>): Promise<void> {
    for (const [_id, strategy] of this.strategies) {
      if (!strategy.isRunning()) continue;
      try {
        const signal = await strategy.onTick(data);
        if (signal) {
          const check = this.riskManager.checkSignal(signal, strategy);
          if (!check.approved) {
            log.warn({ reason: check.reason, signal: signal.symbol }, 'Signal rejected by risk manager');
            continue;
          }
          // Execute the signal
          await this.executeSignal(signal);
        }
      } catch (err) {
        log.error({ err, strategyId: _id }, 'Error in strategy onTick');
      }
    }
  }

  private async executeSignal(_signal: unknown): Promise<void> {
    // Grid bot handles its own orders; this is for future strategies
    // that emit signals for the engine to execute
  }

  private async periodicCheck(): Promise<void> {
    try {
      const balance = await this.hlClient.getBalance();
      this.riskManager.updatePortfolioValue(balance);

      const globalCheck = this.riskManager.checkGlobalDrawdown();
      if (!globalCheck.approved) {
        log.error({ reason: globalCheck.reason }, 'GLOBAL RISK LIMIT BREACHED');
        await sendAlert(`🚨 <b>RISK ALERT</b>\n\n${globalCheck.reason}\n\nPausing all strategies!`);
        for (const strategy of this.strategies.values()) {
          strategy.pause();
        }
      }

      log.info({
        balance: balance.toString(),
        drawdown: this.riskManager.getGlobalDrawdownPct().toFixed(2) + '%',
      }, 'Periodic check complete');
    } catch (err) {
      log.error({ err }, 'Periodic check failed');
    }
  }

  pauseStrategy(id: string): void {
    const strategy = this.strategies.get(id);
    if (strategy) {
      strategy.pause();
      log.info({ id }, 'Strategy paused');
    }
  }

  resumeStrategy(id: string): void {
    const strategy = this.strategies.get(id);
    if (strategy) {
      strategy.resume();
      log.info({ id }, 'Strategy resumed');
    }
  }

  async stop(): Promise<void> {
    log.info('Stopping trading engine...');

    if (this.priceCheckInterval) {
      clearInterval(this.priceCheckInterval);
      this.priceCheckInterval = null;
    }

    for (const [id, strategy] of this.strategies) {
      try {
        await strategy.stop();
        log.info({ id }, 'Strategy stopped');
      } catch (err) {
        log.error({ err, id }, 'Error stopping strategy');
      }
    }

    await this.hlClient.disconnect();
    stopTelegram();
    closeDb();
    this.running = false;

    log.info('Trading engine stopped');
  }

  getStatus(): EngineStatus {
    const strategies = [];
    let totalPnl = new Decimal(0);
    for (const [_id, strategy] of this.strategies) {
      const perf = strategy.getPerformance();
      strategies.push({
        id: perf.strategyId,
        name: strategy.name,
        status: strategy.getStatus(),
        pnl: perf.totalPnl,
      });
      totalPnl = totalPnl.plus(perf.totalPnl);
    }

    return {
      running: this.running,
      uptime: this.running ? Date.now() - this.startTime : 0,
      strategies,
      totalPnl,
      totalCapital: new Decimal(config.initialCapitalUsd),
    };
  }
}
