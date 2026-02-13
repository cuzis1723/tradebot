import type { MarketRegime, MarketDirection } from '../types.js';

/** Generic result from any skill (code or LLM) */
export interface SkillResult<T = unknown> {
  skillName: string;
  timestamp: number;
  data: T;
  /** Compact text summary for LLM consumption (<80 tokens) */
  summary: string;
  hasSignal: boolean;
}

/** Output of assessContext code skill */
export interface ContextAssessment {
  regime: MarketRegime;
  direction: MarketDirection;
  riskLevel: number;
  confidence: number;
  /** Milliseconds since last Brain comprehensive update */
  age: number;
}

/** Output of readSignals code skill */
export interface SignalReading {
  symbol: string;
  totalScore: number;
  quality: 'strong' | 'moderate' | 'weak';
  direction: 'long' | 'short' | 'neutral';
  alignedSignalCount: number;
  /** Top human-readable signal descriptions (max 5) */
  keySignals: string[];
  hasInfoConfirmation: boolean;
}

/** Output of checkExternal code skill */
export interface ExternalIntelAssessment {
  alignment: 'confirms' | 'contradicts' | 'neutral';
  /** Net conviction adjustment from external sources (-3 to +4) */
  convictionModifier: number;
  /** Top 3 most relevant factors */
  keyFactors: string[];
}

/** Output of assessRisk code skill */
export interface RiskAssessment {
  totalBalance: number;
  availableCapital: number;
  maxPositionSizePct: number;
  currentDrawdownPct: number;
  openPositionCount: number;
  consecutiveLosses: number;
  warnings: string[];
  canTrade: boolean;
}

/** Result from the critique LLM skill (adversarial review of a trade proposal) */
export interface CritiqueResult {
  verdict: 'approve' | 'reject' | 'reduce';
  score: number; // 1-10
  flaws: string[];
  adjustments?: {
    leverage?: number;
    size_pct?: number;
    stop_loss?: number;
    take_profit?: number;
  };
  reasoning: string;
}

/** Output of checkLiquidity code skill */
export interface LiquidityAssessment {
  symbol: string;
  bidDepthUsd: number;
  askDepthUsd: number;
  spreadPct: number;
  estimatedSlippagePct: number;
  liquidityWarning: string | null;
  sizeRecommendation: 'full' | 'reduce' | 'abort';
}

/** Output of assessPortfolioCorrelation code skill */
export interface PortfolioCorrelationAssessment {
  positionCount: number;
  effectiveLeverage: number;
  correlatedPairs: Array<{ symbols: [string, string]; correlation: number }>;
  correlationWarning: string | null;
  maxAdditionalLeverage: number;
}

/** Output of readOrderflow code skill */
export interface OrderflowReading {
  symbol: string;
  buyVolumePct: number;
  sellVolumePct: number;
  imbalance: 'buy_heavy' | 'sell_heavy' | 'balanced';
  largeOrderCount: number;
  tradeFrequencyRatio: number;
  smartMoneySignal: string | null;
}

/** Output of assessTimeframeConfluence code skill */
export interface TimeframeConfluence {
  symbol: string;
  timeframes: Record<string, 'bullish' | 'bearish' | 'neutral'>;
  alignedCount: number;
  totalTimeframes: number;
  confluenceScore: number;
  confluenceLabel: 'strong' | 'moderate' | 'weak' | 'conflicting';
}

/** Output of injectLessons code skill */
export interface LessonsContext {
  relevantLessons: Array<{
    symbol: string;
    direction: string;
    outcome: string;
    lesson: string;
    timestamp: number;
  }>;
  winRateSimilar: number;
  avgRRSimilar: number;
  totalSimilarTrades: number;
}

/** Output of trackNarrativeEvolution code skill */
export interface NarrativeEvolution {
  narratives: Array<{
    source: string;
    name: string;
    trend: 'strengthening' | 'weakening' | 'stable' | 'new';
    currentValue: number;
    previousValue: number;
    changeRate: number;
    detail: string;
  }>;
  dominantNarrative: string | null;
}

/** Output of reviewTrade LLM skill */
export interface TradeReviewResult {
  outcome: 'win' | 'loss' | 'breakeven';
  pnlPct: number;
  whatWorked: string[];
  whatFailed: string[];
  signalAccuracy: Array<{ signal: string; accurate: boolean }>;
  lesson: string;
  improvementSuggestion: string;
}

/** Output of managePosition LLM skill */
export interface PositionManagementAction {
  symbol: string;
  action: 'hold' | 'trail_stop' | 'partial_close' | 'move_to_breakeven' | 'close_now';
  newStopLoss?: number;
  partialClosePct?: number;
  reasoning: string;
}

/** Output of planScenarios LLM skill */
export interface ScenarioAnalysis {
  scenarios: Array<{
    name: string;
    probability: number;
    priceTarget: number;
    positionOutcome: string;
    pnlEstimate: number;
  }>;
  worstCaseAcceptable: boolean;
  overallAssessment: string;
}

/** Combined context passed to the LLM decideTrade skill */
export interface DecisionContext {
  context: SkillResult<ContextAssessment>;
  signal: SkillResult<SignalReading>;
  external: SkillResult<ExternalIntelAssessment>;
  risk: SkillResult<RiskAssessment>;
  /** New enhanced skills (optional for backward compatibility) */
  liquidity?: SkillResult<LiquidityAssessment>;
  portfolioCorrelation?: SkillResult<PortfolioCorrelationAssessment>;
  orderflow?: SkillResult<OrderflowReading>;
  timeframeConfluence?: SkillResult<TimeframeConfluence>;
  lessons?: SkillResult<LessonsContext>;
  narrativeEvolution?: SkillResult<NarrativeEvolution>;
}
