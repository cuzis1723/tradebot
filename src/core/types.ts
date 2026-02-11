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
