import { Decimal } from 'decimal.js';

// === Strategy Types ===

export type StrategyTier = 'foundation' | 'growth' | 'moonshot';
export type StrategyStatus = 'idle' | 'running' | 'paused' | 'error' | 'stopped';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';
export type TradingMode = 'auto' | 'semi-auto';

export interface TradeSignal {
  strategyId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price: Decimal;
  size: Decimal;
  reduceOnly: boolean;
  metadata?: Record<string, unknown>;
}

export interface FilledOrder {
  orderId: string;
  symbol: string;
  side: OrderSide;
  price: Decimal;
  size: Decimal;
  fee: Decimal;
  timestamp: number;
  strategyId: string;
}

export interface Position {
  symbol: string;
  side: OrderSide;
  size: Decimal;
  entryPrice: Decimal;
  markPrice: Decimal;
  unrealizedPnl: Decimal;
  leverage: number;
  strategyId: string;
}

export interface StrategyPerformance {
  strategyId: string;
  totalPnl: Decimal;
  realizedPnl: Decimal;
  unrealizedPnl: Decimal;
  winRate: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  maxDrawdown: Decimal;
  sharpeRatio: number;
}

// === Risk Types ===

export interface RiskLimits {
  maxGlobalDrawdownPct: number;
  maxStrategyDrawdownPct: number;
  maxPositionSizePct: number;
  maxDailyLossPct: number;
  maxOpenPositions: number;
  maxLeverage: number;
}

export interface RiskCheckResult {
  approved: boolean;
  reason?: string;
}

// === Portfolio Types ===

export interface PortfolioAllocation {
  strategyId: string;
  tier: StrategyTier;
  targetPct: number;
  currentPct: number;
  capitalUsd: Decimal;
  pnlUsd: Decimal;
}

// === Market Data Types ===

export interface PriceTick {
  symbol: string;
  mid: Decimal;
  bid: Decimal;
  ask: Decimal;
  timestamp: number;
}

export interface Candle {
  symbol: string;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
  timestamp: number;
  interval: string;
}

export interface FundingRate {
  symbol: string;
  rate: Decimal;
  timestamp: number;
}

// === Engine Types ===

export interface EngineStatus {
  running: boolean;
  uptime: number;
  strategies: Array<{
    id: string;
    name: string;
    status: StrategyStatus;
    pnl: Decimal;
  }>;
  totalPnl: Decimal;
  totalCapital: Decimal;
}

// === Config Types ===

export interface GridConfig {
  symbol: string;
  upperPrice: number;
  lowerPrice: number;
  gridCount: number;
  capitalUsd: number;
  leverage: number;
}

export interface FundingArbConfig {
  minFundingRate: number;
  capitalUsd: number;
  maxPositions: number;
}

export interface MomentumConfig {
  symbols: string[];
  fastEma: number;
  slowEma: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  atrPeriod: number;
  capitalUsd: number;
  leverage: number;
}

// === Equity Cross Strategy Types ===

export interface EquityCrossConfig {
  /** Equity perp symbols on Hyperliquid (e.g., NVDA, TSLA, AAPL) */
  equitySymbols: string[];
  /** Crypto perp symbols to correlate against */
  cryptoSymbols: string[];
  /** Correlation mappings: equity → related crypto perps */
  correlationMap: Record<string, string[]>;
  capitalUsd: number;
  leverage: number;
  /** Minimum equity move (%) to consider a signal */
  minEquityMovePct: number;
  /** Scan interval in ms */
  scanIntervalMs: number;
  /** Correlation window (number of 1h candles for rolling correlation) */
  correlationWindow: number;
}

// === Discretionary Trading Types ===

export interface DiscretionaryConfig {
  symbols: string[];
  capitalUsd: number;
  leverage: number;
  analysisIntervalMs: number; // how often to scan for opportunities
  proposalTimeoutMs: number; // how long to wait for user approval
}

export interface MarketSnapshot {
  symbol: string;
  price: number;
  change1h: number;
  change4h: number;
  change24h: number;
  volume24h: number;
  fundingRate: number;
  rsi14: number;
  ema9: number;
  ema21: number;
  atr14: number;
  support: number;
  resistance: number;
  trend: 'bullish' | 'bearish' | 'neutral';
  timestamp: number;
  // Extended indicators (optional for backward compatibility)
  bollingerUpper?: number;
  bollingerLower?: number;
  bollingerWidth?: number;   // BB width as % of price
  volumeRatio?: number;      // last 1h volume / 24h avg hourly volume
  oiChange1h?: number;       // OI % change since last analysis
  atrAvg20?: number;         // 20-period average ATR for volatility comparison
  // 15m candle data (v3)
  candle15m?: { size: number; atr14: number; isLarge: boolean; direction: 'long' | 'short' };
}

export interface TradeProposal {
  id: string;
  symbol: string;
  side: OrderSide;
  entryPrice: number;
  size: number;
  stopLoss: number;
  takeProfit: number;
  leverage: number;
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
  riskRewardRatio: number;
  status: 'pending' | 'approved' | 'modified' | 'rejected' | 'expired' | 'executed';
  createdAt: number;
  expiresAt: number;
}

export interface ActiveDiscretionaryPosition {
  symbol: string;
  side: OrderSide;
  entryPrice: number;
  size: number;
  stopLoss: number;
  takeProfit: number;
  proposalId: string;
  openedAt: number;
}

// === Trigger Score Types (v2) ===

export interface TriggerFlag {
  name: string;
  category: 'price' | 'price_15m' | 'momentum' | 'volatility' | 'volume' | 'structure' | 'cross' | 'external';
  score: number;
  direction: 'long' | 'short' | 'neutral';
  detail: string;
}

export interface TriggerScore {
  symbol: string;
  totalScore: number;
  flags: TriggerFlag[];
  directionBias: 'long' | 'short' | 'neutral';
  bonusScore: number;
  timestamp: number;
}

export interface CooldownState {
  symbolCooldowns: Map<string, number>;  // symbol -> last LLM call timestamp
  globalLastCall: number;                // last LLM call timestamp (any symbol)
  dailyCallCount: number;               // calls today
  dailyResetTime: number;               // midnight UTC timestamp
  consecutiveLosses: number;            // count of consecutive losing trades
  lastLossTime: number;                 // timestamp of last loss
}

export interface ScorerConfig {
  scanIntervalMs: number;        // 5 min = 300_000
  llmThreshold: number;          // 8 points
  alertThreshold: number;        // 5 points
  symbolCooldownMs: number;      // 2 hours = 7_200_000
  globalCooldownMs: number;      // 30 min = 1_800_000
  maxDailyCalls: number;         // 12
  lossCooldownMs: number;        // 4 hours = 14_400_000
  maxConsecutiveLosses: number;  // 2
}

// === Brain Types (Central Intelligence) ===

export type MarketRegime = 'trending_up' | 'trending_down' | 'range' | 'volatile' | 'unknown';
export type MarketDirection = 'bullish' | 'bearish' | 'neutral';

export interface BrainDirectives {
  discretionary: {
    active: boolean;
    bias: 'long' | 'short' | 'neutral';
    focusSymbols: string[];
    maxLeverage: number;
  };
  momentum: {
    active: boolean;
    leverageMultiplier: number;   // 0.5x ~ 1.5x applied to base leverage
    allowLong: boolean;
    allowShort: boolean;
  };
}

export interface MarketState {
  // Core judgment (set by 30-min comprehensive LLM)
  regime: MarketRegime;
  direction: MarketDirection;
  riskLevel: number;              // 1 (safe) ~ 5 (danger)
  confidence: number;             // 0-100
  reasoning: string;

  // Strategy directives
  directives: BrainDirectives;

  // Latest data cache (shared across strategies)
  latestSnapshots: MarketSnapshot[];
  latestScores: TriggerScore[];

  // Timing
  updatedAt: number;
  lastComprehensiveAt: number;
  lastUrgentScanAt: number;
  comprehensiveCount: number;     // daily count
  urgentTriggerCount: number;     // daily count
}

export interface BrainConfig {
  symbols: string[];
  comprehensiveIntervalMs: number;   // 30 min = 1_800_000
  urgentScanIntervalMs: number;      // 5 min = 300_000
  maxDailyComprehensive: number;     // 48 (every 30 min)
  maxDailyUrgentLLM: number;         // 12
  scorer: ScorerConfig;
}

// === Information Source Types ===

export type InfoSourceType = 'polymarket' | 'defillama' | 'coingecko';

/** A prediction market relevant to crypto trading */
export interface PredictionMarket {
  id: string;
  question: string;
  probability: number;         // 0-1, current YES probability
  prevProbability?: number;    // previous reading for delta
  volume24h: number;           // USD volume in last 24h
  liquidity: number;           // USD liquidity
  category: string;            // e.g., "Crypto", "Politics"
  relevantSymbols: string[];   // mapped trading symbols, e.g., ["BTC-PERP"]
  updatedAt: number;
}

/** TVL data from DefiLlama */
export interface TVLData {
  chain: string;
  tvl: number;                 // current TVL in USD
  tvlChange24h: number;        // % change
  tvlChange7d: number;         // % change
  relevantSymbols: string[];   // mapped symbols
}

/** Trending coin data from CoinGecko */
export interface TrendingCoin {
  id: string;
  symbol: string;
  name: string;
  marketCapRank: number;
  priceChange24h: number;      // %
  score: number;               // trending score (0-100)
  relevantSymbol?: string;     // mapped perp symbol if exists
}

/** Aggregated info signals from all sources */
export interface InfoSignals {
  polymarket: PredictionMarket[];
  tvl: TVLData[];
  trending: TrendingCoin[];
  timestamp: number;
  /** Scored flags from info sources for the scorer */
  triggerFlags: InfoTriggerFlag[];
}

/** A trigger flag generated from information sources */
export interface InfoTriggerFlag {
  source: InfoSourceType;
  name: string;
  score: number;               // points to add to trigger score
  direction: 'long' | 'short' | 'neutral';
  relevantSymbol: string;      // e.g., "BTC-PERP"
  detail: string;
}
