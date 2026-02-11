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
