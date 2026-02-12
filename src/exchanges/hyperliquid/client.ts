import { Hyperliquid } from 'hyperliquid';
import { Decimal } from 'decimal.js';
import { ethers } from 'ethers';
import { config } from '../../config/index.js';
import { createChildLogger } from '../../monitoring/logger.js';
import type {
  HLOrderParams, HLModifyOrderParams, HLClearinghouseState, HLAssetCtx, HLPerpMeta, HLAssetInfo,
  HLSpotClearinghouseState, HLSpotMeta, HLSpotAssetCtx,
  HLUserFill, HLUserFunding, HLLedgerUpdate, HLOrderStatus,
  HLTwapParams, HLTwapStatus, HLPredictedFunding, HLFundingHistoryEntry,
} from './types.js';
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

  isConnected(): boolean {
    return this.connected;
  }

  // ============================================================
  // Market Data
  // ============================================================

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

  // ============================================================
  // Perp Account
  // ============================================================

  async getAccountState(walletAddress?: string): Promise<HLClearinghouseState> {
    const address = walletAddress ?? this.walletAddress;
    const state = await this.sdk.info.perpetuals.getClearinghouseState(address);
    return state as unknown as HLClearinghouseState;
  }

  async getBalance(): Promise<Decimal> {
    const spotState = await this.getSpotBalances();
    const spotUsdc = spotState.balances
      .filter(b => b.coin.toUpperCase().includes('USDC'))
      .reduce((sum, b) => sum.plus(new Decimal(b.total)), new Decimal(0));
    return spotUsdc;
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

  // ============================================================
  // Spot Account
  // ============================================================

  async getSpotBalances(walletAddress?: string): Promise<HLSpotClearinghouseState> {
    const address = walletAddress ?? this.walletAddress;
    const state = await this.sdk.info.spot.getSpotClearinghouseState(address);
    return state as unknown as HLSpotClearinghouseState;
  }

  async getSpotMeta(): Promise<HLSpotMeta> {
    const meta = await this.sdk.info.spot.getSpotMeta();
    return meta as unknown as HLSpotMeta;
  }

  async getSpotMetaAndAssetCtxs(): Promise<[HLSpotMeta, HLSpotAssetCtx[]]> {
    const result = await this.sdk.info.spot.getSpotMetaAndAssetCtxs();
    return result as unknown as [HLSpotMeta, HLSpotAssetCtx[]];
  }

  // ============================================================
  // Transfers
  // ============================================================

  /** Transfer USDC from Spot wallet to Perp wallet */
  async transferSpotToPerp(amount: number): Promise<boolean> {
    try {
      await this.sdk.exchange.transferBetweenSpotAndPerp(amount, true);
      log.info({ amount, direction: 'spot→perp' }, 'Transfer completed');
      return true;
    } catch (err) {
      log.error({ err, amount }, 'Spot→Perp transfer failed');
      return false;
    }
  }

  /** Transfer USDC from Perp wallet to Spot wallet */
  async transferPerpToSpot(amount: number): Promise<boolean> {
    try {
      await this.sdk.exchange.transferBetweenSpotAndPerp(amount, false);
      log.info({ amount, direction: 'perp→spot' }, 'Transfer completed');
      return true;
    } catch (err) {
      log.error({ err, amount }, 'Perp→Spot transfer failed');
      return false;
    }
  }

  /** Transfer USDC to another wallet on Hyperliquid L1 */
  async usdTransfer(destination: string, amount: number): Promise<boolean> {
    try {
      await this.sdk.exchange.usdTransfer(destination, amount);
      log.info({ destination, amount }, 'USD transfer completed');
      return true;
    } catch (err) {
      log.error({ err, destination, amount }, 'USD transfer failed');
      return false;
    }
  }

  /** Transfer spot tokens to another wallet */
  async spotTransfer(destination: string, token: string, amount: string): Promise<boolean> {
    try {
      await this.sdk.exchange.spotTransfer(destination, token, amount);
      log.info({ destination, token, amount }, 'Spot transfer completed');
      return true;
    } catch (err) {
      log.error({ err, destination, token, amount }, 'Spot transfer failed');
      return false;
    }
  }

  /** Initiate bridge withdrawal to L1 */
  async initiateWithdrawal(destination: string, amount: number): Promise<boolean> {
    try {
      await this.sdk.exchange.initiateWithdrawal(destination, amount);
      log.info({ destination, amount }, 'Withdrawal initiated');
      return true;
    } catch (err) {
      log.error({ err, destination, amount }, 'Withdrawal failed');
      return false;
    }
  }

  // ============================================================
  // Orders — Basic
  // ============================================================

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

  // ============================================================
  // Orders — Enhanced
  // ============================================================

  /** Modify an existing order */
  async modifyOrder(params: HLModifyOrderParams): Promise<{ orderId: number | null; filled: boolean; avgPrice: string | null; error: string | null }> {
    const tif = (params.tif ?? 'Gtc') as 'Gtc' | 'Ioc' | 'Alo';
    try {
      const response = await this.sdk.exchange.modifyOrder(params.oid, {
        coin: params.coin,
        is_buy: params.isBuy,
        sz: parseFloat(params.size),
        limit_px: parseFloat(params.price),
        order_type: { limit: { tif } },
        reduce_only: params.reduceOnly ?? false,
      });

      const resp = response as { status: string; response?: { type: string; data?: { statuses: Array<Record<string, unknown>> } } };

      if (resp.status === 'ok' && resp.response?.data?.statuses) {
        const status = resp.response.data.statuses[0];
        if (status && 'resting' in status) {
          const resting = status.resting as { oid: number };
          log.info({ orderId: resting.oid, ...params }, 'Order modified (resting)');
          return { orderId: resting.oid, filled: false, avgPrice: null, error: null };
        }
        if (status && 'filled' in status) {
          const filled = status.filled as { oid: number; avgPx: string; totalSz: string };
          log.info({ orderId: filled.oid, avgPx: filled.avgPx, ...params }, 'Order modified (filled)');
          return { orderId: filled.oid, filled: true, avgPrice: filled.avgPx, error: null };
        }
        if (status && 'error' in status) {
          const errMsg = status.error as string;
          log.warn({ error: errMsg, ...params }, 'Order modify rejected');
          return { orderId: null, filled: false, avgPrice: null, error: errMsg };
        }
      }

      return { orderId: null, filled: false, avgPrice: null, error: 'Unexpected response' };
    } catch (err) {
      log.error({ err, ...params }, 'Order modification failed');
      return { orderId: null, filled: false, avgPrice: null, error: String(err) };
    }
  }

  /** Market buy/sell with slippage protection */
  async marketOpen(symbol: string, isBuy: boolean, size: number, slippage?: number): Promise<{ orderId: number | null; filled: boolean; avgPrice: string | null; error: string | null }> {
    try {
      const response = await this.sdk.custom.marketOpen(symbol, isBuy, size, undefined, slippage);
      const resp = response as { status: string; response?: { type: string; data?: { statuses: Array<Record<string, unknown>> } } };

      if (resp.status === 'ok' && resp.response?.data?.statuses) {
        const status = resp.response.data.statuses[0];
        if (status && 'filled' in status) {
          const filled = status.filled as { oid: number; avgPx: string; totalSz: string };
          log.info({ symbol, isBuy, size, avgPx: filled.avgPx }, 'Market open filled');
          return { orderId: filled.oid, filled: true, avgPrice: filled.avgPx, error: null };
        }
        if (status && 'resting' in status) {
          const resting = status.resting as { oid: number };
          log.info({ symbol, isBuy, size }, 'Market open resting');
          return { orderId: resting.oid, filled: false, avgPrice: null, error: null };
        }
        if (status && 'error' in status) {
          const errMsg = status.error as string;
          return { orderId: null, filled: false, avgPrice: null, error: errMsg };
        }
      }

      return { orderId: null, filled: false, avgPrice: null, error: 'Unexpected response' };
    } catch (err) {
      log.error({ err, symbol, isBuy, size }, 'Market open failed');
      return { orderId: null, filled: false, avgPrice: null, error: String(err) };
    }
  }

  /** Market close a position with slippage protection */
  async marketClose(symbol: string, size?: number, slippage?: number): Promise<{ orderId: number | null; filled: boolean; avgPrice: string | null; error: string | null }> {
    try {
      const response = await this.sdk.custom.marketClose(symbol, size, undefined, slippage);
      const resp = response as { status: string; response?: { type: string; data?: { statuses: Array<Record<string, unknown>> } } };

      if (resp.status === 'ok' && resp.response?.data?.statuses) {
        const status = resp.response.data.statuses[0];
        if (status && 'filled' in status) {
          const filled = status.filled as { oid: number; avgPx: string; totalSz: string };
          log.info({ symbol, size, avgPx: filled.avgPx }, 'Market close filled');
          return { orderId: filled.oid, filled: true, avgPrice: filled.avgPx, error: null };
        }
        if (status && 'error' in status) {
          const errMsg = status.error as string;
          return { orderId: null, filled: false, avgPrice: null, error: errMsg };
        }
      }

      return { orderId: null, filled: false, avgPrice: null, error: 'Unexpected response' };
    } catch (err) {
      log.error({ err, symbol, size }, 'Market close failed');
      return { orderId: null, filled: false, avgPrice: null, error: String(err) };
    }
  }

  /** Close all open positions */
  async closeAllPositions(slippage?: number): Promise<boolean> {
    try {
      await this.sdk.custom.closeAllPositions(slippage);
      log.info('All positions closed');
      return true;
    } catch (err) {
      log.error({ err }, 'Close all positions failed');
      return false;
    }
  }

  // ============================================================
  // Leverage & Margin
  // ============================================================

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

  /** Adjust isolated margin for a position */
  async updateIsolatedMargin(symbol: string, isBuy: boolean, amount: number): Promise<boolean> {
    try {
      await this.sdk.exchange.updateIsolatedMargin(symbol, isBuy, amount);
      log.info({ symbol, isBuy, amount }, 'Isolated margin updated');
      return true;
    } catch (err) {
      log.error({ err, symbol, isBuy, amount }, 'Update isolated margin failed');
      return false;
    }
  }

  // ============================================================
  // Funding Rates
  // ============================================================

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

  /** Get predicted next funding rates for all assets */
  async getPredictedFundings(): Promise<HLPredictedFunding[]> {
    try {
      const result = await this.sdk.info.perpetuals.getPredictedFundings();
      return result as unknown as HLPredictedFunding[];
    } catch (err) {
      log.error({ err }, 'Failed to get predicted fundings');
      return [];
    }
  }

  /** Get historical funding rates for a specific coin */
  async getFundingHistory(coin: string, startTime: number, endTime?: number): Promise<HLFundingHistoryEntry[]> {
    try {
      const result = await this.sdk.info.perpetuals.getFundingHistory(coin, startTime, endTime);
      return result as unknown as HLFundingHistoryEntry[];
    } catch (err) {
      log.error({ err, coin }, 'Failed to get funding history');
      return [];
    }
  }

  /** Get assets that have reached their open interest cap */
  async getPerpsAtOpenInterestCap(): Promise<unknown[]> {
    try {
      const result = await this.sdk.info.perpetuals.getPerpsAtOpenInterestCap();
      return result as unknown[];
    } catch (err) {
      log.error({ err }, 'Failed to get perps at OI cap');
      return [];
    }
  }

  // ============================================================
  // User History
  // ============================================================

  /** Get user's recent fills/trades */
  async getUserFills(walletAddress?: string): Promise<HLUserFill[]> {
    try {
      const address = walletAddress ?? this.walletAddress;
      const fills = await this.sdk.info.getUserFills(address);
      return fills as unknown as HLUserFill[];
    } catch (err) {
      log.error({ err }, 'Failed to get user fills');
      return [];
    }
  }

  /** Get user's fills by time range */
  async getUserFillsByTime(startTime: number, endTime?: number, walletAddress?: string): Promise<HLUserFill[]> {
    try {
      const address = walletAddress ?? this.walletAddress;
      const fills = await this.sdk.info.getUserFillsByTime(address, startTime, endTime ?? Date.now());
      return fills as unknown as HLUserFill[];
    } catch (err) {
      log.error({ err }, 'Failed to get user fills by time');
      return [];
    }
  }

  /** Get user's funding payments */
  async getUserFunding(startTime: number, endTime?: number, walletAddress?: string): Promise<HLUserFunding[]> {
    try {
      const address = walletAddress ?? this.walletAddress;
      const funding = await this.sdk.info.perpetuals.getUserFunding(address, startTime, endTime);
      return funding as unknown as HLUserFunding[];
    } catch (err) {
      log.error({ err }, 'Failed to get user funding');
      return [];
    }
  }

  /** Get user's non-funding ledger entries (deposits, withdrawals, transfers) */
  async getUserLedger(startTime: number, endTime?: number, walletAddress?: string): Promise<HLLedgerUpdate[]> {
    try {
      const address = walletAddress ?? this.walletAddress;
      const updates = await this.sdk.info.perpetuals.getUserNonFundingLedgerUpdates(address, startTime, endTime);
      return updates as unknown as HLLedgerUpdate[];
    } catch (err) {
      log.error({ err }, 'Failed to get user ledger');
      return [];
    }
  }

  /** Get status of a specific order */
  async getOrderStatus(orderId: number, walletAddress?: string): Promise<HLOrderStatus | null> {
    try {
      const address = walletAddress ?? this.walletAddress;
      const status = await this.sdk.info.getOrderStatus(address, orderId);
      return status as unknown as HLOrderStatus;
    } catch (err) {
      log.error({ err, orderId }, 'Failed to get order status');
      return null;
    }
  }

  /** Get user's rate limit info */
  async getUserRateLimit(walletAddress?: string): Promise<unknown> {
    try {
      const address = walletAddress ?? this.walletAddress;
      return await this.sdk.info.getUserRateLimit(address);
    } catch (err) {
      log.error({ err }, 'Failed to get rate limit');
      return null;
    }
  }

  /** Get user's historical orders */
  async getHistoricalOrders(walletAddress?: string): Promise<unknown[]> {
    try {
      const address = walletAddress ?? this.walletAddress;
      const orders = await this.sdk.info.getHistoricalOrders(address);
      return orders as unknown[];
    } catch (err) {
      log.error({ err }, 'Failed to get historical orders');
      return [];
    }
  }

  // ============================================================
  // TWAP Orders
  // ============================================================

  /** Place a TWAP (Time-Weighted Average Price) order */
  async placeTwapOrder(params: HLTwapParams): Promise<{ status: string; id?: number; error?: string }> {
    try {
      const response = await this.sdk.exchange.placeTwapOrder({
        coin: params.coin,
        is_buy: params.isBuy,
        sz: params.sz,
        reduce_only: params.reduceOnly,
        duration_ms: params.durationMs,
        randomize: params.randomize,
      } as never);
      const resp = response as { status: string; response?: { data?: { id?: number }; error?: string } };
      if (resp.status === 'ok') {
        log.info({ ...params, id: resp.response?.data?.id }, 'TWAP order placed');
        return { status: 'ok', id: resp.response?.data?.id };
      }
      return { status: 'error', error: resp.response?.error ?? 'Unknown error' };
    } catch (err) {
      log.error({ err, ...params }, 'TWAP order failed');
      return { status: 'error', error: String(err) };
    }
  }

  /** Cancel a TWAP order */
  async cancelTwapOrder(coin: string, twapId: number): Promise<boolean> {
    try {
      await this.sdk.exchange.cancelTwapOrder({ coin, twap_id: twapId });
      log.info({ twapId }, 'TWAP order cancelled');
      return true;
    } catch (err) {
      log.error({ err, twapId }, 'TWAP cancel failed');
      return false;
    }
  }

  /** Get TWAP order history */
  async getTwapHistory(walletAddress?: string): Promise<HLTwapStatus[]> {
    try {
      const address = walletAddress ?? this.walletAddress;
      const history = await this.sdk.info.twapHistory(address);
      return history as unknown as HLTwapStatus[];
    } catch (err) {
      log.error({ err }, 'Failed to get TWAP history');
      return [];
    }
  }

  // ============================================================
  // Account Info & Portfolio
  // ============================================================

  /** Get portfolio performance data */
  async getPortfolio(walletAddress?: string): Promise<unknown> {
    try {
      const address = walletAddress ?? this.walletAddress;
      return await this.sdk.info.portfolio(address);
    } catch (err) {
      log.error({ err }, 'Failed to get portfolio');
      return null;
    }
  }

  /** Get user's fee schedule */
  async getUserFees(walletAddress?: string): Promise<unknown> {
    try {
      const address = walletAddress ?? this.walletAddress;
      return await this.sdk.info.userFees(address);
    } catch (err) {
      log.error({ err }, 'Failed to get user fees');
      return null;
    }
  }

  /** Get referral info */
  async getReferral(walletAddress?: string): Promise<unknown> {
    try {
      const address = walletAddress ?? this.walletAddress;
      return await this.sdk.info.referral(address);
    } catch (err) {
      log.error({ err }, 'Failed to get referral info');
      return null;
    }
  }

  // ============================================================
  // Sub-accounts
  // ============================================================

  /** Create a sub-account */
  async createSubAccount(name: string): Promise<boolean> {
    try {
      await this.sdk.exchange.createSubAccount(name);
      log.info({ name }, 'Sub-account created');
      return true;
    } catch (err) {
      log.error({ err, name }, 'Create sub-account failed');
      return false;
    }
  }

  /** Get sub-accounts */
  async getSubAccounts(walletAddress?: string): Promise<unknown[]> {
    try {
      const address = walletAddress ?? this.walletAddress;
      const subs = await this.sdk.info.getSubAccounts(address);
      return subs as unknown[];
    } catch (err) {
      log.error({ err }, 'Failed to get sub-accounts');
      return [];
    }
  }

  /** Transfer USDC to/from sub-account */
  async subAccountTransfer(subAccountUser: string, isDeposit: boolean, amount: number): Promise<boolean> {
    try {
      await this.sdk.exchange.subAccountTransfer(subAccountUser, isDeposit, amount);
      log.info({ subAccountUser, isDeposit, amount }, 'Sub-account transfer completed');
      return true;
    } catch (err) {
      log.error({ err, subAccountUser, amount }, 'Sub-account transfer failed');
      return false;
    }
  }

  // ============================================================
  // Vault
  // ============================================================

  /** Get vault details */
  async getVaultDetails(vaultAddress: string): Promise<unknown> {
    try {
      return await this.sdk.info.getVaultDetails(vaultAddress, this.walletAddress);
    } catch (err) {
      log.error({ err, vaultAddress }, 'Failed to get vault details');
      return null;
    }
  }

  /** Transfer to/from vault */
  async vaultTransfer(vaultAddress: string, isDeposit: boolean, amount: number): Promise<boolean> {
    try {
      await this.sdk.exchange.vaultTransfer(vaultAddress, isDeposit, amount);
      log.info({ vaultAddress, isDeposit, amount }, 'Vault transfer completed');
      return true;
    } catch (err) {
      log.error({ err, vaultAddress, amount }, 'Vault transfer failed');
      return false;
    }
  }

  // ============================================================
  // Agent / Builder
  // ============================================================

  /** Approve a trading agent */
  async approveAgent(agentAddress: string, agentName?: string): Promise<boolean> {
    try {
      await this.sdk.exchange.approveAgent({ agentAddress, agentName });
      log.info({ agentAddress, agentName }, 'Agent approved');
      return true;
    } catch (err) {
      log.error({ err, agentAddress }, 'Approve agent failed');
      return false;
    }
  }

  /** Approve builder fee */
  async approveBuilderFee(builder: string, maxFeeRate: string): Promise<boolean> {
    try {
      await this.sdk.exchange.approveBuilderFee({ builder, maxFeeRate });
      log.info({ builder, maxFeeRate }, 'Builder fee approved');
      return true;
    } catch (err) {
      log.error({ err, builder }, 'Approve builder fee failed');
      return false;
    }
  }

  // ============================================================
  // Referral
  // ============================================================

  /** Set referrer code */
  async setReferrer(code: string): Promise<boolean> {
    try {
      await this.sdk.exchange.setReferrer(code);
      log.info({ code }, 'Referrer set');
      return true;
    } catch (err) {
      log.error({ err, code }, 'Set referrer failed');
      return false;
    }
  }

  // ============================================================
  // Schedule Cancel
  // ============================================================

  /** Schedule auto-cancellation of all orders at a future time */
  async scheduleCancel(timeMs: number | null): Promise<boolean> {
    try {
      await this.sdk.exchange.scheduleCancel(timeMs);
      log.info({ timeMs }, timeMs ? 'Schedule cancel set' : 'Schedule cancel cleared');
      return true;
    } catch (err) {
      log.error({ err, timeMs }, 'Schedule cancel failed');
      return false;
    }
  }

  // ============================================================
  // WebSocket Subscriptions
  // ============================================================

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

  /** Subscribe to order status updates (filled, cancelled, etc.) */
  subscribeToOrderUpdates(callback: (data: unknown) => void, walletAddress?: string): void {
    const address = walletAddress ?? this.walletAddress;
    this.sdk.subscriptions.subscribeToOrderUpdates(address, callback);
    log.info('Subscribed to order updates');
  }

  /** Subscribe to L2 order book updates for a symbol */
  subscribeToL2Book(symbol: string, callback: (data: unknown) => void): void {
    this.sdk.subscriptions.subscribeToL2Book(symbol, callback);
    log.info({ symbol }, 'Subscribed to L2 book');
  }

  /** Subscribe to trades for a symbol */
  subscribeToTrades(symbol: string, callback: (data: unknown) => void): void {
    this.sdk.subscriptions.subscribeToTrades(symbol, callback);
    log.info({ symbol }, 'Subscribed to trades');
  }

  /** Subscribe to all user events (fills, fundings, liquidations, cancels) */
  subscribeToUserEvents(callback: (data: unknown) => void, walletAddress?: string): void {
    const address = walletAddress ?? this.walletAddress;
    this.sdk.subscriptions.subscribeToUserEvents(address, callback);
    log.info('Subscribed to user events');
  }

  /** Subscribe to user's funding payments */
  subscribeToUserFundings(callback: (data: unknown) => void, walletAddress?: string): void {
    const address = walletAddress ?? this.walletAddress;
    this.sdk.subscriptions.subscribeToUserFundings(address, callback);
    log.info('Subscribed to user fundings');
  }

  /** Subscribe to best bid/offer for a symbol */
  subscribeToBbo(symbol: string, callback: (data: unknown) => void): void {
    this.sdk.subscriptions.subscribeToBbo(symbol, callback);
    log.info({ symbol }, 'Subscribed to BBO');
  }

  /** Subscribe to active asset context (price, funding, OI) */
  subscribeToActiveAssetCtx(symbol: string, callback: (data: unknown) => void): void {
    this.sdk.subscriptions.subscribeToActiveAssetCtx(symbol, callback);
    log.info({ symbol }, 'Subscribed to active asset context');
  }

  // --- Unsubscribe helpers ---

  unsubscribeFromAllMids(): void {
    this.sdk.subscriptions.unsubscribeFromAllMids();
    log.info('Unsubscribed from all mids');
  }

  unsubscribeFromCandle(symbol: string, interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d'): void {
    this.sdk.subscriptions.unsubscribeFromCandle(symbol, interval);
    log.info({ symbol, interval }, 'Unsubscribed from candle');
  }

  unsubscribeFromL2Book(symbol: string): void {
    this.sdk.subscriptions.unsubscribeFromL2Book(symbol);
    log.info({ symbol }, 'Unsubscribed from L2 book');
  }

  unsubscribeFromTrades(symbol: string): void {
    this.sdk.subscriptions.unsubscribeFromTrades(symbol);
    log.info({ symbol }, 'Unsubscribed from trades');
  }

  unsubscribeFromOrderUpdates(walletAddress?: string): void {
    const address = walletAddress ?? this.walletAddress;
    this.sdk.subscriptions.unsubscribeFromOrderUpdates(address);
    log.info('Unsubscribed from order updates');
  }

  unsubscribeFromUserFills(walletAddress?: string): void {
    const address = walletAddress ?? this.walletAddress;
    this.sdk.subscriptions.unsubscribeFromUserFills(address);
    log.info('Unsubscribed from user fills');
  }

  unsubscribeFromActiveAssetCtx(symbol: string): void {
    this.sdk.subscriptions.unsubscribeFromActiveAssetCtx(symbol);
    log.info({ symbol }, 'Unsubscribed from active asset context');
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
