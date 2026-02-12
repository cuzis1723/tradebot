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

/** Combined context passed to the LLM decideTrade skill */
export interface DecisionContext {
  context: SkillResult<ContextAssessment>;
  signal: SkillResult<SignalReading>;
  external: SkillResult<ExternalIntelAssessment>;
  risk: SkillResult<RiskAssessment>;
}
