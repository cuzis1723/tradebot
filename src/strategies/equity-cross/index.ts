import { Decimal } from 'decimal.js';
import { Strategy } from '../base.js';
import { getHyperliquidClient } from '../../exchanges/hyperliquid/client.js';
import { logTrade } from '../../data/storage.js';
import type {
  StrategyTier,
  TradingMode,
  TradeSignal,
  FilledOrder,
  EquityCrossConfig,
  StrategyPositionSummary,
} from '../../core/types.js';

interface EquityCrossPosition {
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  equityTrigger: string; // which equity perp triggered the trade
  openedAt: number;
  slOrderId?: number;
  tpOrderId?: number;
}

interface PriceHistory {
  prices: number[];
  timestamps: number[];
}

export class EquityCrossStrategy extends Strategy {
  readonly id = 'equity-cross';
  readonly name = 'Equity-Crypto Cross';
  readonly tier: StrategyTier = 'growth';
  readonly mode: TradingMode = 'auto';

  private config: EquityCrossConfig;
  private positions: EquityCrossPosition[] = [];
  private scanInterval: ReturnType<typeof setInterval> | null = null;

  // Price tracking for correlation & move detection
  private equityPriceHistory: Map<string, PriceHistory> = new Map();
  private cryptoPriceHistory: Map<string, PriceHistory> = new Map();
  private lastEquityPrices: Map<string, number> = new Map();
  private lastCryptoPrices: Map<string, number> = new Map();
  private lastScanTime = 0;

  constructor(cfg: EquityCrossConfig) {
    super();
    this.config = cfg;
  }

  async onInit(): Promise<void> {
    this.log.info({
      equitySymbols: this.config.equitySymbols,
      cryptoSymbols: this.config.cryptoSymbols,
    }, 'Equity-Cross strategy initializing');

    // Populate initial prices
    await this.updatePrices();

    this.scanInterval = setInterval(() => {
      this.scan().catch(err => {
        this.log.error({ err }, 'Equity-Cross scan error');
      });
    }, this.config.scanIntervalMs);

    await this.scan();
  }

  async onTick(_data: Record<string, string>): Promise<TradeSignal | null> {
    return null;
  }

  async onOrderFilled(order: FilledOrder): Promise<void> {
    this.log.info({ order }, 'Equity-Cross order filled');
  }

  async onStop(): Promise<void> {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    await this.closeAllPositions();
    this.log.info('Equity-Cross strategy stopped');
  }

  // === Core Logic ===

  private async updatePrices(): Promise<void> {
    const hl = getHyperliquidClient();
    const mids = await hl.getAllMidPrices();

    // Update equity prices
    for (const eqSymbol of this.config.equitySymbols) {
      // Hyperliquid equity perps might use different symbol formats
      const price = mids[eqSymbol]?.toNumber()
        ?? mids[`${eqSymbol}-USD`]?.toNumber()
        ?? mids[`@${eqSymbol}`]?.toNumber();
      if (price) {
        this.lastEquityPrices.set(eqSymbol, price);
        this.appendPriceHistory(this.equityPriceHistory, eqSymbol, price);
      }
    }

    // Update crypto prices
    for (const cryptoSymbol of this.config.cryptoSymbols) {
      const coin = cryptoSymbol.replace('-PERP', '');
      const price = mids[cryptoSymbol]?.toNumber()
        ?? mids[coin]?.toNumber()
        ?? mids[`${coin}-PERP`]?.toNumber();
      if (price) {
        this.lastCryptoPrices.set(cryptoSymbol, price);
        this.appendPriceHistory(this.cryptoPriceHistory, cryptoSymbol, price);
      }
    }
  }

  private appendPriceHistory(historyMap: Map<string, PriceHistory>, symbol: string, price: number): void {
    let hist = historyMap.get(symbol);
    if (!hist) {
      hist = { prices: [], timestamps: [] };
      historyMap.set(symbol, hist);
    }
    hist.prices.push(price);
    hist.timestamps.push(Date.now());

    // Keep only the correlation window + buffer
    const maxLen = this.config.correlationWindow + 10;
    if (hist.prices.length > maxLen) {
      hist.prices = hist.prices.slice(-maxLen);
      hist.timestamps = hist.timestamps.slice(-maxLen);
    }
  }

  private async scan(): Promise<void> {
    if (!this.isRunning()) return;

    const now = Date.now();
    if (now - this.lastScanTime < this.config.scanIntervalMs * 0.8) return;
    this.lastScanTime = now;

    // Skip if auto-stopped
    if (this.isAutoStopped) {
      this.log.debug('Equity-Cross scan skipped: auto-stopped');
      return;
    }

    await this.updatePrices();

    // Check existing positions for SL/TP
    for (const pos of [...this.positions]) {
      await this.checkPosition(pos);
    }

    // Look for new signals from equity moves
    for (const eqSymbol of this.config.equitySymbols) {
      const eqHist = this.equityPriceHistory.get(eqSymbol);
      if (!eqHist || eqHist.prices.length < 2) continue;

      const currentPrice = eqHist.prices[eqHist.prices.length - 1];

      // Look back ~1h for price reference (depends on scan interval)
      const lookbackIdx = Math.max(0, eqHist.prices.length - Math.ceil(3600_000 / this.config.scanIntervalMs));
      const refPrice = eqHist.prices[lookbackIdx];
      if (!refPrice || refPrice === 0) continue;

      const equityMovePct = ((currentPrice - refPrice) / refPrice) * 100;

      // Only trigger if equity moved significantly
      if (Math.abs(equityMovePct) < this.config.minEquityMovePct) continue;

      // Check correlated crypto symbols
      const correlatedSymbols = this.config.correlationMap[eqSymbol] ?? [];
      for (const cryptoSymbol of correlatedSymbols) {
        // Skip if already have position on this crypto from this equity trigger
        if (this.positions.some(p => p.symbol === cryptoSymbol && p.equityTrigger === eqSymbol)) continue;

        const cryptoHist = this.cryptoPriceHistory.get(cryptoSymbol);
        if (!cryptoHist || cryptoHist.prices.length < 2) continue;

        const cryptoCurrent = cryptoHist.prices[cryptoHist.prices.length - 1];
        const cryptoLookbackIdx = Math.max(0, cryptoHist.prices.length - Math.ceil(3600_000 / this.config.scanIntervalMs));
        const cryptoRef = cryptoHist.prices[cryptoLookbackIdx];
        if (!cryptoRef || cryptoRef === 0) continue;

        const cryptoMovePct = ((cryptoCurrent - cryptoRef) / cryptoRef) * 100;

        // Decoupling detection: equity moved but crypto lagged
        // Expectation: crypto will catch up to equity direction
        const isDecoupled = Math.abs(equityMovePct) > this.config.minEquityMovePct
          && Math.abs(cryptoMovePct) < Math.abs(equityMovePct) * 0.3;

        if (isDecoupled) {
          const side: 'buy' | 'sell' = equityMovePct > 0 ? 'buy' : 'sell';
          await this.openPosition(cryptoSymbol, side, cryptoCurrent, eqSymbol, equityMovePct);
        }
      }
    }
  }

  private async openPosition(
    cryptoSymbol: string,
    side: 'buy' | 'sell',
    currentPrice: number,
    equityTrigger: string,
    equityMovePct: number,
  ): Promise<void> {
    // Max 1 position per crypto symbol
    if (this.positions.some(p => p.symbol === cryptoSymbol)) return;

    // Max total positions = number of crypto symbols
    if (this.positions.length >= this.config.cryptoSymbols.length) return;

    const hl = getHyperliquidClient();

    // Conservative SL/TP for cross strategy
    const slPct = 0.03; // 3% stop loss
    const tpPct = 0.05; // 5% take profit (R:R ~1.7:1)

    const stopLoss = side === 'buy'
      ? currentPrice * (1 - slPct)
      : currentPrice * (1 + slPct);
    const takeProfit = side === 'buy'
      ? currentPrice * (1 + tpPct)
      : currentPrice * (1 - tpPct);

    // Position sizing: Kelly-informed allocation with loss multiplier
    const kellyFrac = this.kellyFraction(undefined, tpPct / slPct); // R:R from SL/TP
    const sizeFraction = Math.max(kellyFrac, 1 / this.config.cryptoSymbols.length);
    const capitalPerPosition = this.allocatedCapital.mul(sizeFraction);
    const notional = capitalPerPosition.mul(this.config.leverage).mul(this.lossSizeMultiplier);
    const size = notional.div(currentPrice);
    const szDecimals = await hl.getSzDecimals(cryptoSymbol);
    const sz = parseFloat(size.toFixed(szDecimals));

    if (sz <= 0) return;

    // Cross-exposure check before entry
    if (!this.canOpenPosition(cryptoSymbol, notional.toNumber())) {
      this.log.warn({ cryptoSymbol, notional: notional.toFixed(2) }, 'Equity-Cross entry blocked by cross-exposure limit');
      return;
    }

    try {
      await hl.updateLeverage(cryptoSymbol, this.config.leverage, 'cross');

      const result = await hl.placeOrder({
        coin: cryptoSymbol,
        isBuy: side === 'buy',
        size: sz.toString(),
        price: currentPrice.toString(),
        orderType: 'market',
        reduceOnly: false,
      });

      if (result.error) {
        this.log.warn({ cryptoSymbol, error: result.error }, 'Equity-Cross order failed');
        return;
      }

      const entryPrice = result.avgPrice ? parseFloat(result.avgPrice) : currentPrice;

      // Place on-chain trigger orders for SL and TP
      let slOrderId: number | undefined;
      let tpOrderId: number | undefined;

      const slResult = await hl.placeTriggerOrder({
        coin: cryptoSymbol,
        isBuy: side !== 'buy',
        size: sz.toString(),
        triggerPx: stopLoss.toString(),
        tpsl: 'sl',
        reduceOnly: true,
      });
      if (slResult.orderId) slOrderId = slResult.orderId;

      const tpResult = await hl.placeTriggerOrder({
        coin: cryptoSymbol,
        isBuy: side !== 'buy',
        size: sz.toString(),
        triggerPx: takeProfit.toString(),
        tpsl: 'tp',
        reduceOnly: true,
      });
      if (tpResult.orderId) tpOrderId = tpResult.orderId;

      this.positions.push({
        symbol: cryptoSymbol,
        side,
        size: sz,
        entryPrice,
        stopLoss,
        takeProfit,
        equityTrigger,
        openedAt: Date.now(),
        slOrderId,
        tpOrderId,
      });

      logTrade(this.id, cryptoSymbol, side, entryPrice, sz, 0, 0, result.orderId?.toString());

      this.log.info({
        cryptoSymbol,
        side,
        size: sz,
        entryPrice,
        stopLoss: stopLoss.toFixed(2),
        takeProfit: takeProfit.toFixed(2),
        equityTrigger,
        equityMovePct: equityMovePct.toFixed(2),
      }, 'Equity-Cross position opened');

      this.emit('trade', {
        strategy: this.name,
        type: 'entry',
        symbol: cryptoSymbol,
        side,
        price: entryPrice.toString(),
      });
    } catch (err) {
      this.log.error({ err, cryptoSymbol }, 'Failed to open equity-cross position');
    }
  }

  private async checkPosition(position: EquityCrossPosition): Promise<void> {
    const currentPrice = this.lastCryptoPrices.get(position.symbol);
    if (!currentPrice) return;

    const hitSL = position.side === 'buy'
      ? currentPrice <= position.stopLoss
      : currentPrice >= position.stopLoss;

    const hitTP = position.side === 'buy'
      ? currentPrice >= position.takeProfit
      : currentPrice <= position.takeProfit;

    // Auto-close after 4 hours (cross convergence should happen quickly)
    const maxHoldMs = 4 * 3600_000;
    const expired = Date.now() - position.openedAt > maxHoldMs;

    if (hitSL) {
      await this.closePosition(position, 'stop_loss');
    } else if (hitTP) {
      await this.closePosition(position, 'take_profit');
    } else if (expired) {
      await this.closePosition(position, 'time_expired');
    }
  }

  private async closePosition(position: EquityCrossPosition, reason: string): Promise<void> {
    const hl = getHyperliquidClient();
    const closeSide = position.side === 'buy' ? 'sell' : 'buy';

    // Cancel remaining trigger orders before closing
    try {
      await hl.cancelTriggerOrders(position.symbol);
    } catch (err) {
      this.log.warn({ err, symbol: position.symbol }, 'Failed to cancel trigger orders on close');
    }

    try {
      const currentPrice = this.lastCryptoPrices.get(position.symbol) ?? 0;

      const result = await hl.placeOrder({
        coin: position.symbol,
        isBuy: closeSide === 'buy',
        size: position.size.toString(),
        price: currentPrice.toString(),
        orderType: 'market',
        reduceOnly: true,
      });

      if (result.error) {
        this.log.error({ symbol: position.symbol, error: result.error }, 'Failed to close equity-cross position');
        return;
      }

      const closePrice = result.avgPrice ? parseFloat(result.avgPrice) : currentPrice;
      const pnl = (closePrice - position.entryPrice) * position.size * (position.side === 'buy' ? 1 : -1);

      this.positions = this.positions.filter(p => p !== position);

      logTrade(this.id, position.symbol, closeSide, closePrice, position.size, 0, pnl);
      this.recordTrade(new Decimal(pnl));

      this.log.info({
        symbol: position.symbol,
        reason,
        pnl: pnl.toFixed(2),
        entryPrice: position.entryPrice,
        closePrice,
        equityTrigger: position.equityTrigger,
      }, 'Equity-Cross position closed');

      this.emit('trade', {
        strategy: this.name,
        type: 'close',
        symbol: position.symbol,
        side: closeSide,
        price: closePrice.toString(),
        profit: pnl.toFixed(2),
        totalPnl: this.realizedPnl.toString(),
      });
    } catch (err) {
      this.log.error({ err, symbol: position.symbol }, 'Error closing equity-cross position');
    }
  }

  private async closeAllPositions(): Promise<void> {
    for (const position of [...this.positions]) {
      await this.closePosition(position, 'strategy_stop');
    }
  }

  /** Compute Pearson correlation between two price series */
  computeCorrelation(series1: number[], series2: number[]): number {
    const n = Math.min(series1.length, series2.length);
    if (n < 5) return 0;

    const s1 = series1.slice(-n);
    const s2 = series2.slice(-n);

    // Convert to returns
    const r1: number[] = [];
    const r2: number[] = [];
    for (let i = 1; i < n; i++) {
      r1.push((s1[i] - s1[i - 1]) / s1[i - 1]);
      r2.push((s2[i] - s2[i - 1]) / s2[i - 1]);
    }

    if (r1.length === 0) return 0;

    const mean1 = r1.reduce((a, b) => a + b, 0) / r1.length;
    const mean2 = r2.reduce((a, b) => a + b, 0) / r2.length;

    let num = 0;
    let den1 = 0;
    let den2 = 0;
    for (let i = 0; i < r1.length; i++) {
      const d1 = r1[i] - mean1;
      const d2 = r2[i] - mean2;
      num += d1 * d2;
      den1 += d1 * d1;
      den2 += d2 * d2;
    }

    const denom = Math.sqrt(den1 * den2);
    return denom === 0 ? 0 : num / denom;
  }

  getPositions(): EquityCrossPosition[] {
    return [...this.positions];
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
}
