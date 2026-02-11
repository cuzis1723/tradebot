import { Decimal } from 'decimal.js';
import { Strategy } from '../base.js';
import { getHyperliquidClient } from '../../exchanges/hyperliquid/client.js';
import { logTrade } from '../../data/storage.js';
import type {
  StrategyTier,
  TradingMode,
  TradeSignal,
  FilledOrder,
  FundingArbConfig,
} from '../../core/types.js';
import type { HLAssetInfo } from '../../exchanges/hyperliquid/types.js';

interface FundingPosition {
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  entryPrice: number;
  fundingRate: number;       // rate at entry
  accumulatedFunding: number; // total funding collected
  openedAt: number;
}

export class FundingArbStrategy extends Strategy {
  readonly id = 'funding-arb';
  readonly name = 'Funding Rate Arb';
  readonly tier: StrategyTier = 'foundation';
  readonly mode: TradingMode = 'auto';

  private config: FundingArbConfig;
  private positions: FundingPosition[] = [];
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private lastScanTime = 0;
  private readonly SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 min

  // Thresholds
  private readonly MIN_OI = 500_000;          // $500k minimum open interest
  private readonly MIN_VOLUME = 100_000;       // $100k minimum 24h volume
  private readonly EXIT_FUNDING_THRESHOLD = 0.3; // exit when funding drops to 30% of entry rate
  private readonly MAX_HOLD_HOURS = 72;         // max 3 days hold

  constructor(cfg: FundingArbConfig) {
    super();
    this.config = cfg;
  }

  async onInit(): Promise<void> {
    this.log.info({ config: this.config }, 'Funding Rate Arb initializing');

    // Start periodic scan
    this.scanInterval = setInterval(() => {
      this.scanAndManage().catch(err => {
        this.log.error({ err }, 'Funding arb scan error');
      });
    }, this.SCAN_INTERVAL_MS);

    // Initial scan
    await this.scanAndManage();
  }

  async onTick(_data: Record<string, string>): Promise<TradeSignal | null> {
    // This strategy runs on its own scan interval, not on price ticks
    return null;
  }

  async onOrderFilled(order: FilledOrder): Promise<void> {
    this.log.info({ order }, 'Funding arb order filled');
  }

  async onStop(): Promise<void> {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    await this.closeAllPositions();
    this.log.info('Funding Rate Arb stopped');
  }

  // === Core Logic ===

  private async scanAndManage(): Promise<void> {
    if (!this.isRunning()) return;

    const now = Date.now();
    if (now - this.lastScanTime < this.SCAN_INTERVAL_MS * 0.8) return;
    this.lastScanTime = now;

    const hl = getHyperliquidClient();

    try {
      // 1. Get all asset infos with funding rates
      const assets = await hl.getAssetInfos();

      // 2. Manage existing positions
      await this.manageExistingPositions(assets);

      // 3. Look for new opportunities if we have room
      if (this.positions.length < this.config.maxPositions) {
        await this.findNewOpportunities(assets);
      }
    } catch (err) {
      this.log.error({ err }, 'Scan and manage failed');
    }
  }

  private async manageExistingPositions(assets: HLAssetInfo[]): Promise<void> {
    const now = Date.now();

    for (const position of [...this.positions]) {
      const coin = position.symbol.replace('-PERP', '');
      const asset = assets.find(a => a.name === coin);
      if (!asset) continue;

      const currentFunding = Math.abs(asset.funding);
      const entryFunding = Math.abs(position.fundingRate);
      const holdHours = (now - position.openedAt) / 3600_000;

      // Exit conditions:
      // 1. Funding rate dropped significantly
      const fundingDropped = entryFunding > 0 && currentFunding < entryFunding * this.EXIT_FUNDING_THRESHOLD;
      // 2. Held too long
      const heldTooLong = holdHours > this.MAX_HOLD_HOURS;
      // 3. Funding flipped direction
      const fundingFlipped = (position.side === 'sell' && asset.funding < 0) ||
                             (position.side === 'buy' && asset.funding > 0);

      if (fundingDropped || heldTooLong || fundingFlipped) {
        const reason = fundingDropped ? 'funding_normalized' : heldTooLong ? 'max_hold_time' : 'funding_flipped';
        this.log.info({
          symbol: position.symbol,
          reason,
          holdHours: holdHours.toFixed(1),
          currentFunding: (currentFunding * 100).toFixed(4),
          entryFunding: (entryFunding * 100).toFixed(4),
        }, 'Closing funding arb position');

        await this.closePosition(position, reason);
      } else {
        // Update accumulated funding estimate
        // Funding is paid hourly, rate is per hour
        const hoursSinceUpdate = this.SCAN_INTERVAL_MS / 3600_000;
        const fundingPayment = Math.abs(asset.funding) * position.size * asset.markPrice * hoursSinceUpdate;
        position.accumulatedFunding += fundingPayment;
      }
    }
  }

  private async findNewOpportunities(assets: HLAssetInfo[]): Promise<void> {
    // Filter for high funding rate opportunities with sufficient liquidity
    const opportunities = assets.filter(a =>
      Math.abs(a.funding) >= this.config.minFundingRate &&
      a.openInterest >= this.MIN_OI &&
      a.volume24h >= this.MIN_VOLUME &&
      a.markPrice > 0 &&
      // Don't open duplicate positions
      !this.positions.some(p => p.symbol === `${a.name}-PERP`)
    );

    // Sort by absolute funding rate (highest first)
    opportunities.sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding));

    // Take top opportunities up to max positions
    const slotsAvailable = this.config.maxPositions - this.positions.length;
    const toOpen = opportunities.slice(0, slotsAvailable);

    for (const asset of toOpen) {
      await this.openPosition(asset);
    }
  }

  private async openPosition(asset: HLAssetInfo): Promise<void> {
    const hl = getHyperliquidClient();
    const symbol = `${asset.name}-PERP`;

    // Positive funding = longs pay shorts → we SHORT
    // Negative funding = shorts pay longs → we LONG
    const side: 'buy' | 'sell' = asset.funding > 0 ? 'sell' : 'buy';

    // Calculate position size: equal allocation per position
    const capitalPerPosition = this.allocatedCapital.div(this.config.maxPositions);
    const leverage = 2; // Conservative leverage for funding arb
    const notional = capitalPerPosition.mul(leverage);
    const size = notional.div(asset.markPrice);

    // Round size to szDecimals
    const sz = parseFloat(size.toFixed(asset.szDecimals));
    if (sz <= 0) {
      this.log.warn({ symbol, size: size.toString() }, 'Position size too small');
      return;
    }

    try {
      // Set leverage
      await hl.updateLeverage(symbol, leverage, 'cross');

      // Place market order
      const result = await hl.placeOrder({
        coin: symbol,
        isBuy: side === 'buy',
        size: sz.toString(),
        price: asset.markPrice.toString(), // will be IOC market
        orderType: 'market',
        reduceOnly: false,
      });

      if (result.error) {
        this.log.warn({ symbol, error: result.error }, 'Funding arb order failed');
        return;
      }

      const entryPrice = result.avgPrice ? parseFloat(result.avgPrice) : asset.markPrice;

      this.positions.push({
        symbol,
        side,
        size: sz,
        entryPrice,
        fundingRate: asset.funding,
        accumulatedFunding: 0,
        openedAt: Date.now(),
      });

      logTrade(this.id, symbol, side, entryPrice, sz, 0, 0, result.orderId?.toString());

      const annualizedPct = (Math.abs(asset.funding) * 24 * 365 * 100).toFixed(0);
      this.log.info({
        symbol,
        side,
        size: sz,
        entryPrice,
        fundingRate: (asset.funding * 100).toFixed(4) + '%/hr',
        annualized: annualizedPct + '% APR',
      }, 'Funding arb position opened');

      this.emit('trade', {
        strategy: this.name,
        type: 'entry',
        symbol,
        side,
        price: entryPrice.toString(),
      });
    } catch (err) {
      this.log.error({ err, symbol }, 'Failed to open funding arb position');
    }
  }

  private async closePosition(position: FundingPosition, reason: string): Promise<void> {
    const hl = getHyperliquidClient();
    const closeSide = position.side === 'buy' ? 'sell' : 'buy';

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
        this.log.error({ symbol: position.symbol, error: result.error }, 'Failed to close funding position');
        return;
      }

      const closePrice = result.avgPrice ? parseFloat(result.avgPrice) : currentPrice;
      const pricePnl = (closePrice - position.entryPrice) * position.size * (position.side === 'buy' ? 1 : -1);
      const totalPnl = pricePnl + position.accumulatedFunding;

      // Remove from positions
      this.positions = this.positions.filter(p => p.symbol !== position.symbol);

      logTrade(this.id, position.symbol, closeSide, closePrice, position.size, 0, totalPnl);
      this.recordTrade(new Decimal(totalPnl));

      this.log.info({
        symbol: position.symbol,
        reason,
        pricePnl: pricePnl.toFixed(2),
        fundingCollected: position.accumulatedFunding.toFixed(2),
        totalPnl: totalPnl.toFixed(2),
      }, 'Funding arb position closed');

      this.emit('trade', {
        strategy: this.name,
        type: 'close',
        symbol: position.symbol,
        side: closeSide,
        price: closePrice.toString(),
        profit: totalPnl.toFixed(2),
        totalPnl: this.realizedPnl.toString(),
      });
    } catch (err) {
      this.log.error({ err, symbol: position.symbol }, 'Error closing funding position');
    }
  }

  private async closeAllPositions(): Promise<void> {
    for (const position of [...this.positions]) {
      await this.closePosition(position, 'strategy_stop');
    }
  }

  getPositions(): FundingPosition[] {
    return [...this.positions];
  }
}
