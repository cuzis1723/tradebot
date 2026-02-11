import { Decimal } from 'decimal.js';
import { Strategy } from '../base.js';
import { getHyperliquidClient, type HyperliquidClient } from '../../exchanges/hyperliquid/client.js';
import { logTrade, updateDailyPnl, saveStrategyState, loadStrategyState } from '../../data/storage.js';
import type { TradeSignal, FilledOrder, StrategyTier, TradingMode, GridConfig } from '../../core/types.js';

interface GridLevel {
  index: number;
  price: Decimal;
  buyOrderId: number | null;
  sellOrderId: number | null;
  hasPosition: boolean; // true = we bought at this level, waiting to sell above
}

interface GridState {
  levels: Array<{
    index: number;
    price: string;
    buyOrderId: number | null;
    sellOrderId: number | null;
    hasPosition: boolean;
  }>;
  totalBought: number;
  totalSold: number;
  realizedGridPnl: number;
}

export class GridStrategy extends Strategy {
  readonly id = 'grid-bot';
  readonly name = 'Grid Trading Bot';
  readonly tier: StrategyTier = 'foundation';
  readonly mode: TradingMode = 'auto';

  private client: HyperliquidClient;
  private config: GridConfig;
  private levels: GridLevel[] = [];
  private sizePerGrid: Decimal = new Decimal(0);
  private lastMidPrice: Decimal = new Decimal(0);
  private orderCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(gridConfig: GridConfig) {
    super();
    this.client = getHyperliquidClient();
    this.config = gridConfig;
  }

  async onInit(): Promise<void> {
    // Try to restore state
    const savedState = loadStrategyState<GridState>(this.id);
    if (savedState) {
      this.log.info('Restoring grid state from database');
      this.levels = savedState.levels.map((l) => ({
        index: l.index,
        price: new Decimal(l.price),
        buyOrderId: l.buyOrderId,
        sellOrderId: l.sellOrderId,
        hasPosition: l.hasPosition,
      }));
    } else {
      this.calculateGridLevels();
    }

    // Calculate size per grid: total capital / number of grids / mid price
    const midPrice = new Decimal(this.config.upperPrice + this.config.lowerPrice).div(2);
    const capitalPerGrid = this.allocatedCapital.div(this.config.gridCount);
    this.sizePerGrid = capitalPerGrid.mul(this.config.leverage).div(midPrice);
    // Round to reasonable precision
    this.sizePerGrid = new Decimal(this.sizePerGrid.toFixed(4));

    this.log.info({
      symbol: this.config.symbol,
      upper: this.config.upperPrice,
      lower: this.config.lowerPrice,
      grids: this.config.gridCount,
      sizePerGrid: this.sizePerGrid.toString(),
      capital: this.allocatedCapital.toString(),
    }, 'Grid strategy initialized');

    // Set leverage
    await this.client.updateLeverage(this.config.symbol, this.config.leverage);

    // Place initial grid orders
    if (!savedState) {
      await this.placeInitialOrders();
    }

    // Start periodic order check (every 30 seconds)
    this.orderCheckInterval = setInterval(() => {
      this.checkAndRefillOrders().catch((err) => {
        this.log.error({ err }, 'Error checking orders');
      });
    }, 30000);
  }

  private calculateGridLevels(): void {
    const upper = new Decimal(this.config.upperPrice);
    const lower = new Decimal(this.config.lowerPrice);
    const step = upper.minus(lower).div(this.config.gridCount);

    this.levels = [];
    for (let i = 0; i <= this.config.gridCount; i++) {
      this.levels.push({
        index: i,
        price: lower.plus(step.mul(i)),
        buyOrderId: null,
        sellOrderId: null,
        hasPosition: false,
      });
    }

    this.log.info(
      { gridCount: this.levels.length, step: step.toString() },
      'Grid levels calculated'
    );
  }

  private async placeInitialOrders(): Promise<void> {
    // Get current price to determine which orders to place
    const mids = await this.client.getAllMidPrices();
    // Symbol in SDK format: "ETH-PERP" but mids uses raw coin name "ETH"
    const coinName = this.config.symbol.replace('-PERP', '').replace('-SPOT', '');
    const midPriceStr = mids[coinName];
    if (!midPriceStr) {
      this.log.error({ coinName, available: Object.keys(mids).slice(0, 10) }, 'Could not find mid price for symbol');
      return;
    }
    const currentPrice = midPriceStr;
    this.lastMidPrice = currentPrice;

    this.log.info({ currentPrice: currentPrice.toString() }, 'Placing initial grid orders');

    for (const level of this.levels) {
      if (level.price.lessThan(currentPrice)) {
        // Below current price: place buy orders
        await this.placeBuyOrder(level);
      } else if (level.price.greaterThan(currentPrice)) {
        // Above current price: place sell orders (these will fill when we have position)
        // For initial setup, we only place buys below. Sells are placed after buys fill.
      }
      // Small delay to avoid rate limiting
      await sleep(100);
    }

    this.saveState();
  }

  private async placeBuyOrder(level: GridLevel): Promise<void> {
    if (level.hasPosition || level.buyOrderId !== null) return;

    const result = await this.client.placeOrder({
      coin: this.config.symbol,
      isBuy: true,
      size: this.sizePerGrid.toString(),
      price: level.price.toFixed(1),
      orderType: 'limit',
      reduceOnly: false,
      tif: 'Gtc',
    });

    if (result.orderId !== null) {
      level.buyOrderId = result.orderId;
      if (result.filled) {
        level.hasPosition = true;
        level.buyOrderId = null;
        this.log.info({ level: level.index, price: level.price.toString() }, 'Buy filled immediately');
        // Place sell order one level above
        await this.placeSellAbove(level);
      }
    }
  }

  private async placeSellAbove(filledBuyLevel: GridLevel): Promise<void> {
    // Find the next level above
    const nextLevel = this.levels.find((l) => l.index === filledBuyLevel.index + 1);
    if (!nextLevel) return;

    const result = await this.client.placeOrder({
      coin: this.config.symbol,
      isBuy: false,
      size: this.sizePerGrid.toString(),
      price: nextLevel.price.toFixed(1),
      orderType: 'limit',
      reduceOnly: false,
      tif: 'Gtc',
    });

    if (result.orderId !== null) {
      nextLevel.sellOrderId = result.orderId;
      if (result.filled) {
        // Sell filled immediately - grid cycle complete
        const profit = nextLevel.price.minus(filledBuyLevel.price).mul(this.sizePerGrid);
        this.handleGridCycleComplete(filledBuyLevel, nextLevel, profit);
      }
    }
  }

  private handleGridCycleComplete(buyLevel: GridLevel, sellLevel: GridLevel, profit: Decimal): void {
    buyLevel.hasPosition = false;
    sellLevel.sellOrderId = null;

    this.recordTrade(profit);
    logTrade(this.id, this.config.symbol, 'grid-cycle', buyLevel.price.toNumber(), this.sizePerGrid.toNumber(), 0, profit.toNumber());
    updateDailyPnl(this.id, profit.toNumber());

    this.log.info({
      buyPrice: buyLevel.price.toString(),
      sellPrice: sellLevel.price.toString(),
      profit: profit.toString(),
      totalPnl: this.realizedPnl.toString(),
    }, 'Grid cycle completed');

    this.emit('trade', {
      strategy: this.id,
      type: 'grid-cycle',
      buyPrice: buyLevel.price.toString(),
      sellPrice: sellLevel.price.toString(),
      profit: profit.toString(),
      totalPnl: this.realizedPnl.toString(),
    });

    this.saveState();
  }

  async checkAndRefillOrders(): Promise<void> {
    if (!this.isRunning()) return;

    try {
      const openOrders = await this.client.getOpenOrders();
      const openOrderIds = new Set(
        (openOrders as Array<{ oid: number }>).map((o) => o.oid)
      );

      // Check each level
      for (const level of this.levels) {
        // If we had a buy order that's no longer open, it was filled
        if (level.buyOrderId !== null && !openOrderIds.has(level.buyOrderId)) {
          level.buyOrderId = null;
          level.hasPosition = true;
          this.log.info({ level: level.index, price: level.price.toString() }, 'Buy order filled (detected)');
          await this.placeSellAbove(level);
          await sleep(100);
        }

        // If we had a sell order that's no longer open, it was filled
        if (level.sellOrderId !== null && !openOrderIds.has(level.sellOrderId)) {
          const buyLevel = this.levels.find((l) => l.index === level.index - 1);
          if (buyLevel && buyLevel.hasPosition) {
            const profit = level.price.minus(buyLevel.price).mul(this.sizePerGrid);
            this.handleGridCycleComplete(buyLevel, level, profit);
            // Re-place buy order at the buy level
            await this.placeBuyOrder(buyLevel);
            await sleep(100);
          } else {
            level.sellOrderId = null;
          }
        }

        // If a level has no orders and no position, and it's below current price, place buy
        if (!level.buyOrderId && !level.sellOrderId && !level.hasPosition) {
          if (level.price.lessThan(this.lastMidPrice)) {
            await this.placeBuyOrder(level);
            await sleep(100);
          }
        }
      }

      this.saveState();
    } catch (err) {
      this.log.error({ err }, 'Error in checkAndRefillOrders');
    }
  }

  async onTick(data: Record<string, string>): Promise<TradeSignal | null> {
    const coinName = this.config.symbol.replace('-PERP', '').replace('-SPOT', '');
    const price = data[coinName];
    if (price) {
      this.lastMidPrice = new Decimal(price);
    }
    // Grid bot is order-based, not tick-based. We handle logic in checkAndRefillOrders.
    return null;
  }

  async onOrderFilled(order: FilledOrder): Promise<void> {
    // Handled via checkAndRefillOrders polling
    this.log.info({ order }, 'Order filled event received');
  }

  async onStop(): Promise<void> {
    if (this.orderCheckInterval) {
      clearInterval(this.orderCheckInterval);
      this.orderCheckInterval = null;
    }

    // Cancel all open grid orders
    await this.client.cancelAllOrders(this.config.symbol);
    this.saveState();
    this.log.info('Grid strategy stopped, all orders cancelled');
  }

  private saveState(): void {
    const state: GridState = {
      levels: this.levels.map((l) => ({
        index: l.index,
        price: l.price.toString(),
        buyOrderId: l.buyOrderId,
        sellOrderId: l.sellOrderId,
        hasPosition: l.hasPosition,
      })),
      totalBought: this.winningTrades + this.losingTrades,
      totalSold: this.winningTrades,
      realizedGridPnl: this.realizedPnl.toNumber(),
    };
    saveStrategyState(this.id, state);
  }

  getGridStatus(): { levels: number; activeOrders: number; positions: number; pnl: string } {
    return {
      levels: this.levels.length,
      activeOrders: this.levels.filter((l) => l.buyOrderId !== null || l.sellOrderId !== null).length,
      positions: this.levels.filter((l) => l.hasPosition).length,
      pnl: this.realizedPnl.toFixed(2),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
