import type { GridConfig, FundingArbConfig, MomentumConfig, DiscretionaryConfig, ScalpConfig, BrainConfig, EquityCrossConfig, DynamicSymbolConfig } from '../core/types.js';

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
  capitalUsd: 350,  // Reduced from 550 to make room for scalp
  leverage: 5,
  analysisIntervalMs: 5 * 60 * 1000, // 5 minutes (kept for proposal timeout reference)
  proposalTimeoutMs: 5 * 60 * 1000, // 5 minutes
  autoExecute: true, // execute immediately without Telegram approval
};

export const defaultScalpConfig: ScalpConfig = {
  symbols: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'],
  capitalUsd: 200,
  leverage: 5,
  maxConcurrentPositions: 2,
  maxHoldTimeMs: 4 * 60 * 60 * 1000, // 4 hours hard max
  proposalTimeoutMs: 2 * 60 * 1000,  // 2 minutes
};

export const defaultEquityCrossConfig: EquityCrossConfig = {
  equitySymbols: ['NVDA', 'TSLA', 'AAPL'],
  cryptoSymbols: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'],
  correlationMap: {
    // AI/tech stocks → AI-adjacent crypto
    NVDA: ['SOL-PERP', 'ETH-PERP'],
    // Broad risk-on proxy
    TSLA: ['BTC-PERP', 'ETH-PERP'],
    AAPL: ['BTC-PERP'],
  },
  capitalUsd: 100,
  leverage: 3,
  minEquityMovePct: 3, // equity must move >3% to trigger
  scanIntervalMs: 5 * 60 * 1000, // 5 min
  correlationWindow: 168, // 168 x 1h candles (7 days) for rolling correlation
};

export const defaultDynamicSymbolConfig: DynamicSymbolConfig = {
  enabled: true,
  minVolume24h: 10_000_000,       // $10M daily volume floor
  minOpenInterest: 2_000_000,     // $2M OI floor
  maxSymbols: 20,                 // analyze up to 20 symbols per cycle
  preScreenThreshold: 1,          // min pre-screen score to warrant full analysis
};

export const defaultBrainConfig: BrainConfig = {
  symbols: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'],  // core: always analyzed
  dynamicSymbols: defaultDynamicSymbolConfig,
  comprehensiveIntervalMs: 30 * 60 * 1000,  // 30 minutes
  urgentScanIntervalMs: 5 * 60 * 1000,      // 5 minutes
  maxDailyComprehensive: 48,                  // every 30min for 24h
  maxDailyUrgentLLM: 12,                      // max 12 urgent LLM calls/day
  scorer: {
    scanIntervalMs: 5 * 60 * 1000,            // 5 min (used by scorer internals)
    llmThreshold: 8,
    alertThreshold: 5,
    symbolCooldownMs: 2 * 60 * 60 * 1000,     // 2h
    globalCooldownMs: 15 * 60 * 1000,          // 15min (reduced from 30min — daily limit caps cost)
    maxDailyCalls: 12,
    lossCooldownMs: 4 * 60 * 60 * 1000,       // 4h
    maxConsecutiveLosses: 2,
  },
  // Scalp: faster scan, lower thresholds, shorter cooldowns
  scalpScanIntervalMs: 2 * 60 * 1000,         // 2 min
  maxDailyScalpLLM: 24,                        // 24 scalp LLM calls/day
  scalpScorer: {
    scanIntervalMs: 2 * 60 * 1000,             // 2 min
    llmThreshold: 6,                            // lower bar for scalps (vs 8)
    alertThreshold: 4,
    symbolCooldownMs: 20 * 60 * 1000,           // 20 min (vs 2h)
    globalCooldownMs: 10 * 60 * 1000,           // 10 min (vs 30min)
    maxDailyCalls: 24,                           // more frequent (vs 12)
    lossCooldownMs: 60 * 60 * 1000,              // 1h (vs 4h)
    maxConsecutiveLosses: 3,                     // more tolerant (vs 2)
  },
};
