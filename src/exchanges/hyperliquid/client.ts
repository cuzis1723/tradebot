import { Hyperliquid } from 'hyperliquid';
import { Decimal } from 'decimal.js';
import { ethers } from 'ethers';
import { config } from '../../config/index.js';
import { createChildLogger } from '../../monitoring/logger.js';
import type { HLOrderParams, HLClearinghouseState, HLAssetCtx, HLPerpMeta, HLAssetInfo } from './types.js';
import type { FundingRate } from '../../core/types.js';

const log = createChildLogger('hyperliquid');

export class HyperliquidClient {
  private sdk: Hyperliquid;
  private connected = false;
  private fillCallbacks: Array<(fill: unknown) => void> = [];
  readonly walletAddress: string;

  constructor() {
    // Derive wallet address from private key
    const wallet = new ethers.Wallet(config.hlPrivateKey);
    this.walletAddress = config.hlWalletAddress ?? wallet.address;

    this.sdk = new Hyperliquid({
      enableWs: true,
      privateKey: config.hlPrivateKey,
      testnet: config.hlUseTestnet,
    });

    log.info({ walletAddress: this.walletAddress, testnet: config.hlUseTestnet }, 'Hyperliquid client created');
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      await this.sdk.connect();
      this.connected = true;
      log.info({ testnet: config.hlUseTestnet }, 'Connected to Hyperliquid');
    } catch (err) {
      log.error({ err }, 'Failed to connect to Hyperliquid');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    log.info('Disconnected from Hyperliquid');
  }

  // === Market Data ===

  async getAllMidPrices(): Promise<Record<string, Decimal>> {
    const mids = await this.sdk.info.getAllMids();
    const result: Record<string, Decimal> = {};
    for (const [symbol, price] of Object.entries(mids as Record<string, string>)) {
      result[symbol] = new Decimal(price);
    }
    return result;
  }

  async getL2Book(symbol: string): Promise<unknown> {
    return await this.sdk.info.getL2Book(symbol);
  }

  async getCandleSnapshot(coin: string, interval: string, startTime: number, endTime: number): Promise<unknown[]> {
    return await (this.sdk.info as unknown as { getCandleSnapshot: (coin: string, interval: string, startTime: number, endTime: number) => Promise<unknown[]> })
      .getCandleSnapshot(coin, interval, startTime, endTime);
  }

  subscribeToPrices(callback: (data: Record<string, string>) => void): void {
    this.sdk.subscriptions.subscribeToAllMids((data: unknown) => {
      callback(data as Record<string, string>);
    });
    log.info('Subscribed to all mid prices');
  }

  subscribeToCandles(
    symbol: string,
    interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d',
    callback: (data: unknown) => void
  ): void {
    this.sdk.subscriptions.subscribeToCandle(symbol, interval, callback);
    log.info({ symbol, interval }, 'Subscribed to candles');
  }

  subscribeToFills(walletAddress: string, callback: (data: unknown) => void): void {
    this.sdk.subscriptions.subscribeToUserFills(walletAddress, callback);
    this.fillCallbacks.push(callback);
    log.info('Subscribed to user fills');
  }

  // === Trading ===

  async placeOrder(params: HLOrderParams): Promise<{ orderId: number | null; filled: boolean; avgPrice: string | null; error: string | null }> {
    const orderType = params.orderType === 'market'
      ? { limit: { tif: 'Ioc' as const } }
      : { limit: { tif: (params.tif ?? 'Gtc') as 'Gtc' | 'Ioc' | 'Alo' } };

    try {
      const response = await this.sdk.exchange.placeOrder({
        coin: params.coin,
        is_buy: params.isBuy,
        sz: parseFloat(params.size),
        limit_px: parseFloat(params.price),
        order_type: orderType,
        reduce_only: params.reduceOnly,
      });

      const resp = response as { status: string; response?: { type: string; data?: { statuses: Array<Record<string, unknown>> } } };

      if (resp.status === 'ok' && resp.response?.data?.statuses) {
        const status = resp.response.data.statuses[0];
        if (status && 'resting' in status) {
          const resting = status.resting as { oid: number };
          log.info({ orderId: resting.oid, ...params }, 'Order placed (resting)');
          return { orderId: resting.oid, filled: false, avgPrice: null, error: null };
        }
        if (status && 'filled' in status) {
          const filled = status.filled as { oid: number; avgPx: string; totalSz: string };
          log.info({ orderId: filled.oid, avgPx: filled.avgPx, ...params }, 'Order filled');
          return { orderId: filled.oid, filled: true, avgPrice: filled.avgPx, error: null };
        }
        if (status && 'error' in status) {
          const errMsg = status.error as string;
          log.warn({ error: errMsg, ...params }, 'Order rejected');
          return { orderId: null, filled: false, avgPrice: null, error: errMsg };
        }
      }

      log.warn({ response }, 'Unexpected order response');
      return { orderId: null, filled: false, avgPrice: null, error: 'Unexpected response' };
    } catch (err) {
      log.error({ err, ...params }, 'Order placement failed');
      return { orderId: null, filled: false, avgPrice: null, error: String(err) };
    }
  }

  async cancelOrder(symbol: string, orderId: number): Promise<boolean> {
    try {
      await this.sdk.exchange.cancelOrder({
        coin: symbol,
        o: orderId,
      });
      log.info({ symbol, orderId }, 'Order cancelled');
      return true;
    } catch (err) {
      log.error({ err, symbol, orderId }, 'Cancel order failed');
      return false;
    }
  }

  async cancelAllOrders(symbol?: string): Promise<boolean> {
    try {
      if (symbol) {
        await this.sdk.custom.cancelAllOrders(symbol);
      } else {
        await this.sdk.custom.cancelAllOrders();
      }
      log.info({ symbol: symbol ?? 'all' }, 'All orders cancelled');
      return true;
    } catch (err) {
      log.error({ err }, 'Cancel all orders failed');
      return false;
    }
  }

  async updateLeverage(symbol: string, leverage: number, mode: 'cross' | 'isolated' = 'cross'): Promise<boolean> {
    try {
      await this.sdk.exchange.updateLeverage(symbol, mode, leverage);
      log.info({ symbol, leverage, mode }, 'Leverage updated');
      return true;
    } catch (err) {
      log.error({ err, symbol, leverage }, 'Update leverage failed');
      return false;
    }
  }

  // === Account ===

  async getAccountState(walletAddress?: string): Promise<HLClearinghouseState> {
    const address = walletAddress ?? this.walletAddress;
    const state = await this.sdk.info.perpetuals.getClearinghouseState(address);
    return state as unknown as HLClearinghouseState;
  }

  async getBalance(): Promise<Decimal> {
    const state = await this.getAccountState();
    return new Decimal(state.marginSummary.accountValue);
  }

  async getPositions(): Promise<HLClearinghouseState['assetPositions']> {
    const state = await this.getAccountState();
    return state.assetPositions.filter(
      (ap) => parseFloat(ap.position.szi) !== 0
    );
  }

  async getOpenOrders(walletAddress?: string): Promise<unknown[]> {
    const address = walletAddress ?? this.walletAddress;
    const orders = await this.sdk.info.getUserOpenOrders(address);
    return orders as unknown[];
  }

  // === Funding Rates ===

  async getFundingRates(): Promise<FundingRate[]> {
    try {
      const assets = await this.getAssetInfos();
      return assets
        .filter(a => a.funding !== 0)
        .map(a => ({
          symbol: `${a.name}-PERP`,
          rate: new Decimal(a.funding),
          timestamp: Date.now(),
        }));
    } catch (err) {
      log.error({ err }, 'Failed to get funding rates');
      return [];
    }
  }

  async getAssetInfos(): Promise<HLAssetInfo[]> {
    const metaAndCtxs = await this.sdk.info.perpetuals.getMetaAndAssetCtxs();
    const [meta, ctxs] = metaAndCtxs as unknown as [HLPerpMeta, HLAssetCtx[]];

    return meta.universe.map((u, i) => ({
      name: u.name,
      szDecimals: u.szDecimals,
      maxLeverage: u.maxLeverage,
      funding: parseFloat(ctxs[i]?.funding ?? '0'),
      openInterest: parseFloat(ctxs[i]?.openInterest ?? '0'),
      markPrice: parseFloat(ctxs[i]?.markPx ?? '0'),
      volume24h: parseFloat(ctxs[i]?.dayNtlVlm ?? '0'),
    }));
  }

  isConnected(): boolean {
    return this.connected;
  }
}

// Singleton instance
let client: HyperliquidClient | null = null;

export function getHyperliquidClient(): HyperliquidClient {
  if (!client) {
    client = new HyperliquidClient();
  }
  return client;
}
