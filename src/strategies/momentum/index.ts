import { Decimal } from 'decimal.js';
import { RSI, EMA, ATR, ADX } from 'technicalindicators';
import { Strategy } from '../base.js';
import { getHyperliquidClient } from '../../exchanges/hyperliquid/client.js';
import { logTrade } from '../../data/storage.js';
import type {
  StrategyTier,
  TradingMode,
  TradeSignal,
  FilledOrder,
  MomentumConfig,
  StrategyPositionSummary,
} from '../../core/types.js';

interface MomentumPosition {
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
  slOrderId?: number;
  tpOrderId?: number;
}

interface SymbolState {
  symbol: string;
  lastSignal: 'long' | 'short' | 'none';
  lastSignalTime: number;
}

export class MomentumStrategy extends Strategy {
  readonly id = 'momentum';
  readonly name = 'Momentum Trading';
  readonly tier: StrategyTier = 'growth';
  readonly mode: TradingMode = 'auto';

  private config: MomentumConfig;
  private positions: MomentumPosition[] = [];
  private symbolStates: Map<string, SymbolState> = new Map();
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private lastScanTime = 0;
  private readonly SCAN_INTERVAL_MS = 60 * 1000; // 1 min check (uses 1h candles)
  private readonly SIGNAL_COOLDOWN_MS = 4 * 3600_000; // 4h between signals per symbol

  constructor(cfg: MomentumConfig) {
    super();
    this.config = cfg;

    for (const symbol of cfg.symbols) {
      this.symbolStates.set(symbol, {
        symbol,
        lastSignal: 'none',
        lastSignalTime: 0,
      });
    }
  }

  async onInit(): Promise<void> {
    this.log.info({ symbols: this.config.symbols }, 'Momentum strategy initializing');

    this.scanInterval = setInterval(() => {
      this.scanAll().catch(err => {
        this.log.error({ err }, 'Momentum scan error');
      });
    }, this.SCAN_INTERVAL_MS);

    await this.scanAll();
  }

  async onTick(_data: Record<string, string>): Promise<TradeSignal | null> {
    // Momentum runs on its own candle-based interval
    return null;
  }

  async onOrderFilled(order: FilledOrder): Promise<void> {
    this.log.info({ order }, 'Momentum order filled');
  }

  async onStop(): Promise<void> {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    await this.closeAllPositions();
    this.log.info('Momentum strategy stopped');
  }

  // === Core Logic ===

  private async scanAll(): Promise<void> {
    if (!this.isRunning()) return;

    // Brain can disable Momentum strategy
    if (this.marketState?.directives.momentum.active === false) {
      this.log.debug('Momentum scan skipped: disabled by Brain directive');
      return;
    }

    const now = Date.now();
    if (now - this.lastScanTime < this.SCAN_INTERVAL_MS * 0.8) return;
    this.lastScanTime = now;

    for (const symbol of this.config.symbols) {
      try {
        // Check stop loss / take profit for existing positions
        await this.checkExistingPosition(symbol);

        // Generate signal from candle data
        const signal = await this.analyzeSymbol(symbol);
        if (signal) {
          await this.actOnSignal(symbol, signal);
        }
      } catch (err) {
        this.log.error({ err, symbol }, 'Error scanning symbol');
      }
    }
  }

  private async analyzeSymbol(symbol: string): Promise<'long' | 'short' | null> {
    const hl = getHyperliquidClient();
    const coin = symbol.replace('-PERP', '');

    // Fetch 1h candles
    const now = Date.now();
    const candles = await hl.getCandleSnapshot(coin, '1h', now - 100 * 3600_000, now);
    const parsed = (candles as Array<{ o: number | string; h: number | string; l: number | string; c: number | string; t: number }>).map(c => ({
      close: Number(c.c),
      high: Number(c.h),
      low: Number(c.l),
    }));

    if (parsed.length < 30) return null;

    const closes = parsed.map(c => c.close);
    const highs = parsed.map(c => c.high);
    const lows = parsed.map(c => c.low);

    // Calculate indicators
    const fastEmaValues = EMA.calculate({ values: closes, period: this.config.fastEma });
    const slowEmaValues = EMA.calculate({ values: closes, period: this.config.slowEma });
    const rsiValues = RSI.calculate({ values: closes, period: this.config.rsiPeriod });

    // ADX filter: skip signal in ranging market (ADX < 20)
    const adxValues = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    if (adxValues.length > 0) {
      const latestAdx = adxValues[adxValues.length - 1].adx;
      if (latestAdx < 20) {
        this.log.debug({ symbol, adx: latestAdx.toFixed(1) }, 'Signal skipped: ADX < 20 (ranging market)');
        return null;
      }
    }

    if (fastEmaValues.length < 2 || slowEmaValues.length < 2 || rsiValues.length < 1) return null;

    const fastEma = fastEmaValues[fastEmaValues.length - 1];
    const fastEmaPrev = fastEmaValues[fastEmaValues.length - 2];
    const slowEma = slowEmaValues[slowEmaValues.length - 1];
    const slowEmaPrev = slowEmaValues[slowEmaValues.length - 2];
    const rsi = rsiValues[rsiValues.length - 1];

    // Signal: EMA crossover + RSI filter
    const bullishCross = fastEmaPrev <= slowEmaPrev && fastEma > slowEma;
    const bearishCross = fastEmaPrev >= slowEmaPrev && fastEma < slowEma;

    // Cooldown check
    const state = this.symbolStates.get(symbol);
    const now2 = Date.now();
    if (state && now2 - state.lastSignalTime < this.SIGNAL_COOLDOWN_MS) return null;

    if (bullishCross && rsi < this.config.rsiOverbought && rsi > this.config.rsiOversold) {
      // Brain directive filter: check if long is allowed
      if (this.marketState?.directives.momentum.allowLong === false) {
        this.log.info({ symbol }, 'LONG signal suppressed by Brain directive (allowLong=false)');
        return null;
      }
      this.log.info({ symbol, fastEma, slowEma, rsi }, 'LONG signal: EMA bullish cross');
      return 'long';
    }

    if (bearishCross && rsi > this.config.rsiOversold && rsi < this.config.rsiOverbought) {
      // Brain directive filter: check if short is allowed
      if (this.marketState?.directives.momentum.allowShort === false) {
        this.log.info({ symbol }, 'SHORT signal suppressed by Brain directive (allowShort=false)');
        return null;
      }
      this.log.info({ symbol, fastEma, slowEma, rsi }, 'SHORT signal: EMA bearish cross');
      return 'short';
    }

    return null;
  }

  private async actOnSignal(symbol: string, signal: 'long' | 'short'): Promise<void> {
    const hl = getHyperliquidClient();

    // Close existing position if direction changed
    const existing = this.positions.find(p => p.symbol === symbol);
    if (existing) {
      if ((existing.side === 'buy' && signal === 'short') || (existing.side === 'sell' && signal === 'long')) {
        await this.closePosition(existing, 'signal_reversal');
      } else {
        return; // Same direction, keep existing position
      }
    }

    // Check if we have room for new positions
    if (this.positions.length >= this.config.symbols.length) return;

    // Calculate ATR for stop loss
    const coin = symbol.replace('-PERP', '');
    const now = Date.now();
    const candles = await hl.getCandleSnapshot(coin, '1h', now - 50 * 3600_000, now);
    const parsed = (candles as Array<{ h: number | string; l: number | string; c: number | string }>).map(c => ({
      high: Number(c.h),
      low: Number(c.l),
      close: Number(c.c),
    }));

    const atrValues = ATR.calculate({
      high: parsed.map(c => c.high),
      low: parsed.map(c => c.low),
      close: parsed.map(c => c.close),
      period: this.config.atrPeriod,
    });

    const atr = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
    if (atr === 0) return;

    const currentPrice = parsed[parsed.length - 1].close;
    const side: 'buy' | 'sell' = signal === 'long' ? 'buy' : 'sell';

    // ATR-based stop loss (2x ATR) and take profit (3x ATR)
    const stopLoss = side === 'buy'
      ? currentPrice - 2 * atr
      : currentPrice + 2 * atr;
    const takeProfit = side === 'buy'
      ? currentPrice + 3 * atr
      : currentPrice - 3 * atr;

    // Skip if auto-stopped due to consecutive losses
    if (this.isAutoStopped) {
      this.log.warn({ symbol }, 'Momentum entry skipped: auto-stopped (3 consecutive losses)');
      return;
    }

    // Position sizing: Kelly Criterion + Brain-adjusted leverage + loss multiplier
    const kellyFrac = this.kellyFraction(); // half-Kelly from trade history
    const sizeFraction = Math.max(kellyFrac, 1 / this.config.symbols.length); // floor at equal allocation
    const capitalForTrade = this.allocatedCapital.mul(sizeFraction);
    const leverageMultiplier = this.marketState?.directives.momentum.leverageMultiplier ?? 1.0;
    const effectiveLeverage = Math.max(1, Math.round(this.config.leverage * leverageMultiplier));
    const notional = capitalForTrade.mul(effectiveLeverage).mul(this.lossSizeMultiplier);
    const size = notional.div(currentPrice);
    const sz = parseFloat(size.toFixed(4));

    if (sz <= 0) return;

    // Cross-exposure check before entry
    if (!this.canOpenPosition(symbol, notional.toNumber())) {
      this.log.warn({ symbol, notional: notional.toFixed(2) }, 'Momentum entry blocked by cross-exposure limit');
      return;
    }

    try {
      await hl.updateLeverage(symbol, effectiveLeverage, 'cross');

      const result = await hl.placeOrder({
        coin: symbol,
        isBuy: side === 'buy',
        size: sz.toString(),
        price: currentPrice.toString(),
        orderType: 'market',
        reduceOnly: false,
      });

      if (result.error) {
        this.log.warn({ symbol, error: result.error }, 'Momentum order failed');
        return;
      }

      const entryPrice = result.avgPrice ? parseFloat(result.avgPrice) : currentPrice;

      // Place on-chain trigger orders for SL and TP
      let slOrderId: number | undefined;
      let tpOrderId: number | undefined;

      const slResult = await hl.placeTriggerOrder({
        coin: symbol,
        isBuy: side !== 'buy', // opposite side to close
        size: sz.toString(),
        triggerPx: stopLoss.toString(),
        tpsl: 'sl',
        reduceOnly: true,
      });
      if (slResult.orderId) slOrderId = slResult.orderId;

      const tpResult = await hl.placeTriggerOrder({
        coin: symbol,
        isBuy: side !== 'buy',
        size: sz.toString(),
        triggerPx: takeProfit.toString(),
        tpsl: 'tp',
        reduceOnly: true,
      });
      if (tpResult.orderId) tpOrderId = tpResult.orderId;

      this.positions.push({
        symbol,
        side,
        size: sz,
        entryPrice,
        stopLoss,
        takeProfit,
        openedAt: Date.now(),
        slOrderId,
        tpOrderId,
      });

      // Update state
      const state = this.symbolStates.get(symbol);
      if (state) {
        state.lastSignal = signal;
        state.lastSignalTime = Date.now();
      }

      logTrade(this.id, symbol, side, entryPrice, sz, 0, 0, result.orderId?.toString());

      this.log.info({
        symbol,
        side,
        size: sz,
        entryPrice,
        stopLoss: stopLoss.toFixed(2),
        takeProfit: takeProfit.toFixed(2),
        atr: atr.toFixed(2),
      }, 'Momentum position opened');

      this.emit('trade', {
        strategy: this.name,
        type: 'entry',
        symbol,
        side,
        price: entryPrice.toString(),
      });
    } catch (err) {
      this.log.error({ err, symbol }, 'Failed to open momentum position');
    }
  }

  private async checkExistingPosition(symbol: string): Promise<void> {
    const position = this.positions.find(p => p.symbol === symbol);
    if (!position) return;

    const hl = getHyperliquidClient();
    const mids = await hl.getAllMidPrices();
    const coin = symbol.replace('-PERP', '');
    const currentPrice = mids[coin]?.toNumber() ?? mids[symbol]?.toNumber();
    if (!currentPrice) return;

    // Check stop loss
    const hitSL = position.side === 'buy'
      ? currentPrice <= position.stopLoss
      : currentPrice >= position.stopLoss;

    // Check take profit
    const hitTP = position.side === 'buy'
      ? currentPrice >= position.takeProfit
      : currentPrice <= position.takeProfit;

    if (hitSL) {
      await this.closePosition(position, 'stop_loss');
    } else if (hitTP) {
      await this.closePosition(position, 'take_profit');
    }
  }

  private async closePosition(position: MomentumPosition, reason: string): Promise<void> {
    const hl = getHyperliquidClient();
    const closeSide = position.side === 'buy' ? 'sell' : 'buy';

    // Cancel remaining trigger orders before closing
    try {
      await hl.cancelTriggerOrders(position.symbol);
    } catch (err) {
      this.log.warn({ err, symbol: position.symbol }, 'Failed to cancel trigger orders on close');
    }

    try {
      const mids = await hl.getAllMidPrices();
      const coin = position.symbol.replace('-PERP', '');
      const currentPrice = mids[coin]?.toNumber() ?? mids[position.symbol]?.toNumber() ?? 0;

      const result = await hl.placeOrder({
        coin: position.symbol,
        isBuy: closeSide === 'buy',
        size: position.size.toString(),
        price: currentPrice.toString(),
        orderType: 'market',
        reduceOnly: true,
      });

      if (result.error) {
        this.log.error({ symbol: position.symbol, error: result.error }, 'Failed to close momentum position');
        return;
      }

      const closePrice = result.avgPrice ? parseFloat(result.avgPrice) : currentPrice;
      const pnl = (closePrice - position.entryPrice) * position.size * (position.side === 'buy' ? 1 : -1);

      this.positions = this.positions.filter(p => p.symbol !== position.symbol);

      logTrade(this.id, position.symbol, closeSide, closePrice, position.size, 0, pnl);
      this.recordTrade(new Decimal(pnl));

      this.log.info({
        symbol: position.symbol,
        reason,
        pnl: pnl.toFixed(2),
        entryPrice: position.entryPrice,
        closePrice,
      }, 'Momentum position closed');

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
      this.log.error({ err, symbol: position.symbol }, 'Error closing momentum position');
    }
  }

  private async closeAllPositions(): Promise<void> {
    for (const position of [...this.positions]) {
      await this.closePosition(position, 'strategy_stop');
    }
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
