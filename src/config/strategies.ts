import type { GridConfig, FundingArbConfig, MomentumConfig, DiscretionaryConfig } from '../core/types.js';

export const defaultGridConfig: GridConfig = {
  symbol: 'ETH-PERP',
  upperPrice: 3000,
  lowerPrice: 2000,
  gridCount: 20,
  capitalUsd: 100,
  leverage: 3,
};

export const defaultFundingArbConfig: FundingArbConfig = {
  minFundingRate: 0.0001, // 0.01% per hour (~87% APR)
  capitalUsd: 400,
  maxPositions: 5,
};

export const defaultMomentumConfig: MomentumConfig = {
  symbols: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'],
  fastEma: 9,
  slowEma: 21,
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  atrPeriod: 14,
  capitalUsd: 300,
  leverage: 5,
};

export const defaultDiscretionaryConfig: DiscretionaryConfig = {
  symbols: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'],
  capitalUsd: 600,
  leverage: 5,
  analysisIntervalMs: 5 * 60 * 1000, // 5 minutes
  proposalTimeoutMs: 5 * 60 * 1000, // 5 minutes
};
