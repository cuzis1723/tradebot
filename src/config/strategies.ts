import type { GridConfig, FundingArbConfig, MomentumConfig, DiscretionaryConfig, BrainConfig } from '../core/types.js';

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
  capitalUsd: 250,
  leverage: 3,
};

export const defaultDiscretionaryConfig: DiscretionaryConfig = {
  symbols: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'],
  capitalUsd: 550,
  leverage: 5,
  analysisIntervalMs: 5 * 60 * 1000, // 5 minutes (kept for proposal timeout reference)
  proposalTimeoutMs: 5 * 60 * 1000, // 5 minutes
};

export const defaultBrainConfig: BrainConfig = {
  symbols: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'],
  comprehensiveIntervalMs: 30 * 60 * 1000,  // 30 minutes
  urgentScanIntervalMs: 5 * 60 * 1000,      // 5 minutes
  maxDailyComprehensive: 48,                  // every 30min for 24h
  maxDailyUrgentLLM: 12,                      // max 12 urgent LLM calls/day
  scorer: {
    scanIntervalMs: 5 * 60 * 1000,            // 5 min (used by scorer internals)
    llmThreshold: 8,
    alertThreshold: 5,
    symbolCooldownMs: 2 * 60 * 60 * 1000,     // 2h
    globalCooldownMs: 30 * 60 * 1000,          // 30min
    maxDailyCalls: 12,
    lossCooldownMs: 4 * 60 * 60 * 1000,       // 4h
    maxConsecutiveLosses: 2,
  },
};
