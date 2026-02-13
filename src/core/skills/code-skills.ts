/**
 * Code Skills — Pure code functions that compress raw data into focused summaries.
 *
 * Each skill takes structured inputs and produces a SkillResult with:
 * - data: structured TypeScript object
 * - summary: compact text (<80 tokens) optimized for LLM consumption
 *
 * No LLM calls. No async (except assessRisk). All deterministic.
 */
import type {
  MarketState,
  TriggerScore,
  InfoSignals,
  ActiveDiscretionaryPosition,
} from '../types.js';
import type {
  SkillResult,
  ContextAssessment,
  SignalReading,
  ExternalIntelAssessment,
  RiskAssessment,
} from './types.js';


// ============================================================
// Skill 1: assessContext
// ============================================================

/** Read the current Brain state and produce a compact summary */
export function assessContext(state: MarketState): SkillResult<ContextAssessment> {
  const now = Date.now();
  const age = state.lastComprehensiveAt > 0 ? now - state.lastComprehensiveAt : -1;

  const data: ContextAssessment = {
    regime: state.regime,
    direction: state.direction,
    riskLevel: state.riskLevel,
    confidence: state.confidence,
    age,
  };

  const ageStr = age < 0 ? 'NO_DATA' : `${Math.floor(age / 60_000)}min`;

  const summary = [
    `REGIME: ${state.regime}`,
    `DIR: ${state.direction}`,
    `RISK: ${state.riskLevel}/5`,
    `CONF: ${state.confidence}%`,
    `AGE: ${ageStr}`,
  ].join(' | ');

  return {
    skillName: 'assessContext',
    timestamp: now,
    data,
    summary,
    hasSignal: state.updatedAt > 0,
  };
}

// ============================================================
// Skill 2: readSignals
// ============================================================

/** Parse trigger score flags into a focused signal reading */
export function readSignals(
  score: TriggerScore,
  _infoSignals?: InfoSignals | null,
): SkillResult<SignalReading> {
  const now = Date.now();

  // Count direction-aligned signals
  const directionCounts = { long: 0, short: 0, neutral: 0 };
  for (const flag of score.flags) {
    directionCounts[flag.direction]++;
  }
  const alignedCount = directionCounts[score.directionBias] || 0;

  // Quality from total score
  let quality: 'strong' | 'moderate' | 'weak';
  if (score.totalScore >= 11) quality = 'strong';
  else if (score.totalScore >= 8) quality = 'moderate';
  else quality = 'weak';

  // Check for info-source confirmation
  const hasInfoConfirmation = score.flags.some(f => f.category === 'external');

  // Top signals by score (max 5)
  const sorted = [...score.flags].sort((a, b) => b.score - a.score);
  const keySignals = sorted.slice(0, 5).map(f => f.detail);

  const data: SignalReading = {
    symbol: score.symbol,
    totalScore: score.totalScore,
    quality,
    direction: score.directionBias,
    alignedSignalCount: alignedCount,
    keySignals,
    hasInfoConfirmation,
  };

  // Compact summary
  const signalNames = sorted.slice(0, 4).map(f => {
    const short = f.detail.length > 30 ? f.detail.slice(0, 30) + '…' : f.detail;
    return short;
  });
  const infoTag = hasInfoConfirmation ? ' | Info: YES' : '';

  const summary = [
    `${score.symbol} SCORE=${score.totalScore} ${quality.toUpperCase()} ${score.directionBias.toUpperCase()}`,
    `${signalNames.join(', ')}${infoTag}`,
  ].join(' | ');

  return {
    skillName: 'readSignals',
    timestamp: now,
    data,
    summary,
    hasSignal: score.totalScore >= 5,
  };
}

// ============================================================
// Skill 3: checkExternal
// ============================================================

/** Evaluate external intelligence relative to the triggered symbol and direction */
export function checkExternal(
  infoSignals: InfoSignals | null,
  symbol: string,
  direction: 'long' | 'short' | 'neutral',
): SkillResult<ExternalIntelAssessment> {
  const now = Date.now();

  if (!infoSignals || infoSignals.triggerFlags.length === 0) {
    return {
      skillName: 'checkExternal',
      timestamp: now,
      data: { alignment: 'neutral', convictionModifier: 0, keyFactors: [] },
      summary: 'EXTERNAL: No data available',
      hasSignal: false,
    };
  }

  // Filter flags relevant to this symbol
  const relevantFlags = infoSignals.triggerFlags.filter(
    f => f.relevantSymbol === symbol || f.relevantSymbol.includes(symbol.split('-')[0]),
  );

  if (relevantFlags.length === 0) {
    return {
      skillName: 'checkExternal',
      timestamp: now,
      data: { alignment: 'neutral', convictionModifier: 0, keyFactors: [] },
      summary: 'EXTERNAL: No signals for ' + symbol,
      hasSignal: false,
    };
  }

  // Calculate net conviction: flags in same direction add, opposite subtract
  let convictionModifier = 0;
  let confirming = 0;
  let contradicting = 0;
  const keyFactors: string[] = [];

  for (const flag of relevantFlags) {
    const detail = `[${flag.source}] ${flag.detail}`;

    if (flag.direction === direction) {
      convictionModifier += flag.score;
      confirming++;
      if (keyFactors.length < 3) keyFactors.push(detail);
    } else if (flag.direction !== 'neutral' && direction !== 'neutral') {
      convictionModifier -= flag.score;
      contradicting++;
      if (keyFactors.length < 3) keyFactors.push(detail);
    } else {
      // neutral flags: partial credit
      if (keyFactors.length < 3) keyFactors.push(detail);
    }
  }

  // Clamp to -3..+4
  convictionModifier = Math.max(-3, Math.min(4, convictionModifier));

  let alignment: 'confirms' | 'contradicts' | 'neutral';
  if (confirming > contradicting && convictionModifier > 0) alignment = 'confirms';
  else if (contradicting > confirming && convictionModifier < 0) alignment = 'contradicts';
  else alignment = 'neutral';

  const data: ExternalIntelAssessment = { alignment, convictionModifier, keyFactors };

  // Compact summary
  const sign = convictionModifier >= 0 ? `+${convictionModifier}` : `${convictionModifier}`;
  const factorLines = keyFactors.map(f => {
    const short = f.length > 50 ? f.slice(0, 50) + '…' : f;
    return short;
  });

  const summary = [
    `${alignment.toUpperCase()} (${sign})`,
    ...factorLines,
  ].join(' | ');

  return {
    skillName: 'checkExternal',
    timestamp: now,
    data,
    summary,
    hasSignal: relevantFlags.length > 0,
  };
}

// ============================================================
// Skill 4: assessRisk
// ============================================================

/** Evaluate risk constraints: capital, positions, drawdown, consecutive losses */
export function assessRisk(
  balance: number,
  positions: ActiveDiscretionaryPosition[],
  consecutiveLosses: number = 0,
  initialCapital?: number,
): SkillResult<RiskAssessment> {
  const now = Date.now();
  const initCap = initialCapital ?? balance;

  // Discretionary allocation: 55%
  const discAllocation = balance * 0.55;

  // Margin used by open discretionary positions
  // margin = notional / leverage
  const usedMargin = positions.reduce((sum, p) => {
    const notional = Math.abs(p.entryPrice * p.size);
    return sum + notional / (p.leverage || 5);
  }, 0);

  const availableCapital = Math.max(0, discAllocation - usedMargin);
  const maxPositionSizePct = 25; // hard cap from system rules

  // Drawdown from initial capital
  const drawdownPct = initCap > 0 ? ((initCap - balance) / initCap) * 100 : 0;
  const currentDrawdownPct = Math.max(0, drawdownPct);

  // Warnings
  const warnings: string[] = [];
  if (currentDrawdownPct >= 15) warnings.push(`Drawdown ${currentDrawdownPct.toFixed(1)}% approaching 20% hard stop`);
  if (currentDrawdownPct >= 20) warnings.push('HARD STOP: 20% drawdown exceeded');
  if (consecutiveLosses >= 2) warnings.push(`${consecutiveLosses} consecutive losses — cooldown active`);
  if (positions.length >= 3) warnings.push(`${positions.length} open positions — near limit`);
  if (availableCapital < 50) warnings.push(`Low available capital: $${availableCapital.toFixed(0)}`);

  const canTrade = currentDrawdownPct < 20
    && consecutiveLosses < 3
    && availableCapital >= 20;

  const data: RiskAssessment = {
    totalBalance: balance,
    availableCapital,
    maxPositionSizePct,
    currentDrawdownPct,
    openPositionCount: positions.length,
    consecutiveLosses,
    warnings,
    canTrade,
  };

  // Compact summary
  const warnTag = warnings.length > 0 ? ` | WARN: ${warnings[0]}` : '';
  const summary = [
    `CAP: $${balance.toFixed(0)}`,
    `AVAIL: $${availableCapital.toFixed(0)}`,
    `DD: ${currentDrawdownPct.toFixed(1)}%`,
    `POS: ${positions.length}`,
    `LOSSES: ${consecutiveLosses}`,
    `CAN_TRADE: ${canTrade ? 'yes' : 'NO'}`,
  ].join(' | ') + warnTag;

  return {
    skillName: 'assessRisk',
    timestamp: now,
    data,
    summary,
    hasSignal: true,
  };
}
