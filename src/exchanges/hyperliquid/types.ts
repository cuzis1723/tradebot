export interface HLOrderParams {
  coin: string;
  isBuy: boolean;
  size: string;
  price: string;
  orderType: 'limit' | 'market';
  reduceOnly: boolean;
  tif?: 'Gtc' | 'Ioc' | 'Alo';
}

export interface HLOrderResponse {
  status: string;
  response?: {
    type: string;
    data?: {
      statuses: Array<{
        resting?: { oid: number };
        filled?: { totalSz: string; avgPx: string; oid: number };
        error?: string;
      }>;
    };
  };
}

export interface HLPosition {
  coin: string;
  szi: string; // signed size (negative = short)
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  leverage: {
    type: string;
    value: number;
  };
}

export interface HLClearinghouseState {
  marginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
  };
  assetPositions: Array<{
    position: HLPosition;
  }>;
}

export interface HLFundingRate {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}

export interface HLAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
}

export interface HLPerpMeta {
  universe: Array<{
    name: string;
    szDecimals: number;
    maxLeverage: number;
  }>;
}

export interface HLAssetInfo {
  name: string;
  szDecimals: number;
  funding: number;
  openInterest: number;
  markPrice: number;
  volume24h: number;
  maxLeverage: number;
}

// === Spot Types ===

export interface HLSpotBalance {
  coin: string;
  token: number;
  total: string;
  hold: string;
  entryNtl: string;
}

export interface HLSpotClearinghouseState {
  balances: HLSpotBalance[];
}

export interface HLSpotMeta {
  universe: Array<{
    tokens: number[];
    name: string;
    index: number;
    isCanonical: boolean;
  }>;
  tokens: Array<{
    name: string;
    szDecimals: number;
    weiDecimals: number;
    index: number;
    tokenId: string;
    isCanonical: boolean;
  }>;
}

export interface HLSpotAssetCtx {
  dayNtlVlm: string;
  markPx: string;
  midPx: string;
  prevDayPx: string;
  circulatingSupply: string;
}

// === User Fill / Trade History Types ===

export interface HLUserFill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  feeToken: string;
}

// === User Funding Types ===

export interface HLUserFunding {
  time: number;
  coin: string;
  usdc: string;
  szi: string;
  fundingRate: string;
}

// === Ledger / Transfer Types ===

export interface HLLedgerUpdate {
  time: number;
  hash: string;
  delta: {
    type: string;
    usdc: string;
    fee?: string;
    nonce?: number;
  };
}

// === Order Status Types ===

export interface HLOrderStatus {
  order: {
    coin: string;
    side: string;
    limitPx: string;
    sz: string;
    oid: number;
    timestamp: number;
    origSz: string;
    cloid?: string;
  };
  status: string;
  statusTimestamp: number;
}

// === Modify Order Types ===

export interface HLModifyOrderParams {
  oid: number;
  coin: string;
  isBuy: boolean;
  size: string;
  price: string;
  orderType?: 'limit' | 'market';
  tif?: 'Gtc' | 'Ioc' | 'Alo';
  reduceOnly?: boolean;
}

// === TWAP Types ===

export interface HLTwapParams {
  coin: string;
  isBuy: boolean;
  sz: number;
  reduceOnly: boolean;
  durationMs: number;
  randomize: boolean;
}

export interface HLTwapStatus {
  id: number;
  coin: string;
  isBuy: boolean;
  sz: string;
  filledSz: string;
  avgPx: string;
  state: string;
  startTime: number;
  endTime: number;
}

// === Trigger Order Types ===

export interface HLTriggerOrderParams {
  coin: string;
  isBuy: boolean;
  size: string;
  triggerPx: string;
  tpsl: 'tp' | 'sl';
  reduceOnly: boolean;
}

// === Predicted Funding ===

export interface HLPredictedFunding {
  coin: string;
  predictedFundingRate: string;
  currentFundingRate: string;
}

// === Funding History ===

export interface HLFundingHistoryEntry {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}
