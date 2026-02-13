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
  MarketSnapshot,
} from '../types.js';
import type {
  SkillResult,
  ContextAssessment,
  SignalReading,
  ExternalIntelAssessment,
  RiskAssessment,
  LiquidityAssessment,
  PortfolioCorrelationAssessment,
  OrderflowReading,
  TimeframeConfluence,
  LessonsContext,
  NarrativeEvolution,
} from './types.js';
import { getRecentLessons, getLessonStats, getNarrativeHistory, logNarrativeSnapshot } from '../../data/storage.js';


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

// ============================================================
// Skill 5: checkLiquidity
// ============================================================

/** Estimate slippage from L2 orderbook data */
export function checkLiquidity(
  l2Book: { bids: Array<{ px: string; sz: string }>; asks: Array<{ px: string; sz: string }> } | null,
  symbol: string,
  tradeNotionalUsd: number,
  side: 'buy' | 'sell',
): SkillResult<LiquidityAssessment> {
  const now = Date.now();

  if (!l2Book || (!l2Book.bids?.length && !l2Book.asks?.length)) {
    const data: LiquidityAssessment = {
      symbol,
      bidDepthUsd: 0,
      askDepthUsd: 0,
      spreadPct: 0,
      estimatedSlippagePct: 0,
      liquidityWarning: 'No orderbook data available',
      sizeRecommendation: 'reduce',
    };
    return { skillName: 'checkLiquidity', timestamp: now, data, summary: `${symbol}: No L2 data`, hasSignal: false };
  }

  const bestBid = l2Book.bids.length > 0 ? parseFloat(l2Book.bids[0].px) : 0;
  const bestAsk = l2Book.asks.length > 0 ? parseFloat(l2Book.asks[0].px) : 0;
  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;

  const spreadPct = mid > 0 && bestBid > 0 && bestAsk > 0
    ? ((bestAsk - bestBid) / mid) * 100
    : 0;

  // Calculate depth in USD for top 10 levels
  let bidDepthUsd = 0;
  for (const level of l2Book.bids.slice(0, 10)) {
    bidDepthUsd += parseFloat(level.px) * parseFloat(level.sz);
  }
  let askDepthUsd = 0;
  for (const level of l2Book.asks.slice(0, 10)) {
    askDepthUsd += parseFloat(level.px) * parseFloat(level.sz);
  }

  // Estimate slippage: walk through the book
  const book = side === 'buy' ? l2Book.asks : l2Book.bids;
  let remaining = tradeNotionalUsd;
  let filledValue = 0;
  let filledQty = 0;
  for (const level of book) {
    const px = parseFloat(level.px);
    const sz = parseFloat(level.sz);
    const levelValue = px * sz;
    if (remaining <= 0) break;
    const fillValue = Math.min(remaining, levelValue);
    const fillQty = fillValue / px;
    filledValue += fillQty * px;
    filledQty += fillQty;
    remaining -= fillValue;
  }

  const avgFillPrice = filledQty > 0 ? filledValue / filledQty : mid;
  const estimatedSlippagePct = mid > 0 ? Math.abs(avgFillPrice - mid) / mid * 100 : 0;

  let liquidityWarning: string | null = null;
  let sizeRecommendation: 'full' | 'reduce' | 'abort' = 'full';

  if (remaining > tradeNotionalUsd * 0.1) {
    liquidityWarning = `Insufficient depth: only ${((1 - remaining / tradeNotionalUsd) * 100).toFixed(0)}% fillable`;
    sizeRecommendation = 'abort';
  } else if (estimatedSlippagePct > 0.3) {
    liquidityWarning = `High slippage: ${estimatedSlippagePct.toFixed(2)}%`;
    sizeRecommendation = 'reduce';
  } else if (spreadPct > 0.1) {
    liquidityWarning = `Wide spread: ${spreadPct.toFixed(3)}%`;
    sizeRecommendation = 'reduce';
  }

  const data: LiquidityAssessment = {
    symbol,
    bidDepthUsd,
    askDepthUsd,
    spreadPct,
    estimatedSlippagePct,
    liquidityWarning,
    sizeRecommendation,
  };

  const summary = [
    `${symbol} SPREAD: ${spreadPct.toFixed(3)}%`,
    `SLIP: ${estimatedSlippagePct.toFixed(3)}%`,
    `DEPTH: $${(bidDepthUsd / 1000).toFixed(0)}k/$${(askDepthUsd / 1000).toFixed(0)}k`,
    `REC: ${sizeRecommendation.toUpperCase()}`,
    liquidityWarning ? `WARN: ${liquidityWarning}` : '',
  ].filter(Boolean).join(' | ');

  return { skillName: 'checkLiquidity', timestamp: now, data, summary, hasSignal: true };
}

// ============================================================
// Skill 6: assessPortfolioCorrelation
// ============================================================

// Hard-coded approximate correlation coefficients for major crypto pairs
const CRYPTO_CORRELATIONS: Record<string, Record<string, number>> = {
  'BTC-PERP': { 'ETH-PERP': 0.82, 'SOL-PERP': 0.78, 'DOGE-PERP': 0.70, 'AVAX-PERP': 0.75, 'LINK-PERP': 0.72 },
  'ETH-PERP': { 'BTC-PERP': 0.82, 'SOL-PERP': 0.80, 'AVAX-PERP': 0.78, 'LINK-PERP': 0.76, 'DOGE-PERP': 0.65 },
  'SOL-PERP': { 'BTC-PERP': 0.78, 'ETH-PERP': 0.80, 'AVAX-PERP': 0.72, 'LINK-PERP': 0.68, 'DOGE-PERP': 0.60 },
};

/** Check cross-position correlation and effective leverage */
export function assessPortfolioCorrelation(
  positions: ActiveDiscretionaryPosition[],
  proposedSymbol?: string,
  proposedSide?: 'buy' | 'sell',
  proposedLeverage?: number,
): SkillResult<PortfolioCorrelationAssessment> {
  const now = Date.now();

  if (positions.length === 0 && !proposedSymbol) {
    const data: PortfolioCorrelationAssessment = {
      positionCount: 0,
      effectiveLeverage: 0,
      correlatedPairs: [],
      correlationWarning: null,
      maxAdditionalLeverage: 15,
    };
    return { skillName: 'assessPortfolioCorrelation', timestamp: now, data, summary: 'No positions — no correlation risk', hasSignal: false };
  }

  // Build position list including proposed
  const allPositions = [...positions.map(p => ({
    symbol: p.symbol,
    side: p.side,
    leverage: p.leverage,
    notional: Math.abs(p.entryPrice * p.size),
  }))];

  if (proposedSymbol && proposedSide && proposedLeverage) {
    allPositions.push({
      symbol: proposedSymbol,
      side: proposedSide,
      leverage: proposedLeverage,
      notional: 0, // unknown yet, just check correlation
    });
  }

  // Find correlated pairs
  const correlatedPairs: Array<{ symbols: [string, string]; correlation: number }> = [];
  for (let i = 0; i < allPositions.length; i++) {
    for (let j = i + 1; j < allPositions.length; j++) {
      const a = allPositions[i];
      const b = allPositions[j];
      if (a.symbol === b.symbol) continue;
      const corr = CRYPTO_CORRELATIONS[a.symbol]?.[b.symbol] ?? 0.5; // default 0.5 for unknown pairs
      if (corr >= 0.6) {
        correlatedPairs.push({ symbols: [a.symbol, b.symbol], correlation: corr });
      }
    }
  }

  // Calculate effective leverage considering correlations
  // For same-direction correlated positions: effective_lev = sum(lev * corr_weight)
  let effectiveLeverage = 0;
  for (const pos of allPositions) {
    let corrMultiplier = 1.0;
    for (const other of allPositions) {
      if (other.symbol === pos.symbol) continue;
      const corr = CRYPTO_CORRELATIONS[pos.symbol]?.[other.symbol] ?? 0.5;
      const sameDirection = pos.side === other.side;
      if (sameDirection && corr > 0.6) {
        corrMultiplier += corr * 0.5; // partial stacking
      }
    }
    effectiveLeverage += pos.leverage * Math.min(corrMultiplier, 2.0);
  }

  // Warnings
  let correlationWarning: string | null = null;
  const maxAdditionalLeverage = Math.max(3, 15 - effectiveLeverage);

  if (effectiveLeverage > 20) {
    correlationWarning = `DANGER: Effective leverage ${effectiveLeverage.toFixed(1)}x across correlated positions`;
  } else if (effectiveLeverage > 12) {
    correlationWarning = `High effective leverage ${effectiveLeverage.toFixed(1)}x due to correlation`;
  } else if (correlatedPairs.length >= 2) {
    correlationWarning = `${correlatedPairs.length} correlated pairs detected`;
  }

  const data: PortfolioCorrelationAssessment = {
    positionCount: allPositions.length,
    effectiveLeverage,
    correlatedPairs,
    correlationWarning,
    maxAdditionalLeverage,
  };

  const pairsStr = correlatedPairs.map(p => `${p.symbols[0].replace('-PERP', '')}/${p.symbols[1].replace('-PERP', '')}=${p.correlation.toFixed(2)}`).join(', ');
  const summary = [
    `POS: ${allPositions.length}`,
    `EFF_LEV: ${effectiveLeverage.toFixed(1)}x`,
    `MAX_ADD: ${maxAdditionalLeverage.toFixed(0)}x`,
    pairsStr ? `CORR: ${pairsStr}` : '',
    correlationWarning ? `WARN: ${correlationWarning}` : '',
  ].filter(Boolean).join(' | ');

  return { skillName: 'assessPortfolioCorrelation', timestamp: now, data, summary, hasSignal: correlatedPairs.length > 0 };
}

// ============================================================
// Skill 7: readOrderflow
// ============================================================

/** Analyze recent fills for buy/sell imbalance and large orders */
export function readOrderflow(
  recentFills: Array<{ side: string; px: string; sz: string; time: number }> | null,
  symbol: string,
  _currentPrice: number,
): SkillResult<OrderflowReading> {
  const now = Date.now();

  if (!recentFills || recentFills.length === 0) {
    const data: OrderflowReading = {
      symbol,
      buyVolumePct: 50,
      sellVolumePct: 50,
      imbalance: 'balanced',
      largeOrderCount: 0,
      tradeFrequencyRatio: 1.0,
      smartMoneySignal: null,
    };
    return { skillName: 'readOrderflow', timestamp: now, data, summary: `${symbol}: No fill data`, hasSignal: false };
  }

  let buyVolume = 0;
  let sellVolume = 0;
  const sizes: number[] = [];

  for (const fill of recentFills) {
    const sz = parseFloat(fill.sz) * parseFloat(fill.px);
    sizes.push(sz);
    if (fill.side === 'B' || fill.side === 'buy') {
      buyVolume += sz;
    } else {
      sellVolume += sz;
    }
  }

  const totalVolume = buyVolume + sellVolume;
  const buyPct = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 50;
  const sellPct = 100 - buyPct;

  let imbalance: 'buy_heavy' | 'sell_heavy' | 'balanced' = 'balanced';
  if (buyPct > 60) imbalance = 'buy_heavy';
  else if (sellPct > 60) imbalance = 'sell_heavy';

  // Detect large orders (> 3x median)
  const sortedSizes = [...sizes].sort((a, b) => a - b);
  const median = sortedSizes[Math.floor(sortedSizes.length / 2)] || 0;
  const largeThreshold = median * 3;
  const largeOrderCount = sizes.filter(s => s > largeThreshold && largeThreshold > 0).length;

  // Trade frequency: fills in last 5min vs previous 5min
  const fiveMinAgo = now - 300_000;
  const tenMinAgo = now - 600_000;
  const recentCount = recentFills.filter(f => f.time > fiveMinAgo).length;
  const olderCount = recentFills.filter(f => f.time > tenMinAgo && f.time <= fiveMinAgo).length;
  const tradeFrequencyRatio = olderCount > 0 ? recentCount / olderCount : recentCount > 0 ? 2.0 : 1.0;

  // Smart money signal
  let smartMoneySignal: string | null = null;
  if (largeOrderCount >= 3 && imbalance !== 'balanced') {
    smartMoneySignal = `${largeOrderCount} large orders on ${imbalance === 'buy_heavy' ? 'buy' : 'sell'} side`;
  } else if (tradeFrequencyRatio > 3.0) {
    smartMoneySignal = `Trade frequency surge ${tradeFrequencyRatio.toFixed(1)}x — volatility imminent`;
  }

  const data: OrderflowReading = {
    symbol,
    buyVolumePct: Math.round(buyPct),
    sellVolumePct: Math.round(sellPct),
    imbalance,
    largeOrderCount,
    tradeFrequencyRatio,
    smartMoneySignal,
  };

  const summary = [
    `${symbol} BUY: ${buyPct.toFixed(0)}% SELL: ${sellPct.toFixed(0)}%`,
    `${imbalance.toUpperCase()}`,
    largeOrderCount > 0 ? `LARGE: ${largeOrderCount}` : '',
    tradeFrequencyRatio > 2 ? `FREQ: ${tradeFrequencyRatio.toFixed(1)}x` : '',
    smartMoneySignal ? `SMART: ${smartMoneySignal}` : '',
  ].filter(Boolean).join(' | ');

  return { skillName: 'readOrderflow', timestamp: now, data, summary, hasSignal: imbalance !== 'balanced' || largeOrderCount > 0 };
}

// ============================================================
// Skill 8: assessTimeframeConfluence
// ============================================================

/** Assess trend alignment across multiple timeframes */
export function assessTimeframeConfluence(
  snapshots1h: MarketSnapshot | null,
  candles4h: Array<{ close: number; open: number }> | null,
  candles15m: Array<{ close: number; open: number }> | null,
  symbol: string,
): SkillResult<TimeframeConfluence> {
  const now = Date.now();

  const timeframes: Record<string, 'bullish' | 'bearish' | 'neutral'> = {};

  // 15m: use recent candles trend
  if (candles15m && candles15m.length >= 3) {
    const recent = candles15m.slice(-3);
    const bullish = recent.filter(c => c.close > c.open).length;
    timeframes['15m'] = bullish >= 2 ? 'bullish' : bullish <= 1 ? 'bearish' : 'neutral';
  }

  // 1h: from snapshot indicators (EMA9 vs EMA21 + RSI)
  if (snapshots1h) {
    const emaTrend = snapshots1h.ema9 > snapshots1h.ema21 ? 'bullish' : snapshots1h.ema9 < snapshots1h.ema21 ? 'bearish' : 'neutral';
    const rsiBias = snapshots1h.rsi14 > 55 ? 'bullish' : snapshots1h.rsi14 < 45 ? 'bearish' : 'neutral';
    if (emaTrend === rsiBias) timeframes['1h'] = emaTrend;
    else timeframes['1h'] = emaTrend; // EMA takes precedence
  }

  // 4h: use candle trend
  if (candles4h && candles4h.length >= 3) {
    const recent = candles4h.slice(-3);
    const bullish = recent.filter(c => c.close > c.open).length;
    const ema9 = candles4h.slice(-9).reduce((s, c) => s + c.close, 0) / Math.min(9, candles4h.length);
    const ema21 = candles4h.slice(-21).reduce((s, c) => s + c.close, 0) / Math.min(21, candles4h.length);
    const emaTrend = ema9 > ema21 ? 'bullish' : 'bearish';
    timeframes['4h'] = bullish >= 2 ? emaTrend : bullish === 0 ? (emaTrend === 'bullish' ? 'bearish' : 'bullish') : 'neutral';
  }

  // 1d: from 1h snapshot 24h change
  if (snapshots1h) {
    timeframes['1d'] = snapshots1h.change24h > 1 ? 'bullish' : snapshots1h.change24h < -1 ? 'bearish' : 'neutral';
  }

  const totalTimeframes = Object.keys(timeframes).length;
  const bullishCount = Object.values(timeframes).filter(t => t === 'bullish').length;
  const bearishCount = Object.values(timeframes).filter(t => t === 'bearish').length;
  const alignedCount = Math.max(bullishCount, bearishCount);

  let confluenceScore: number;
  let confluenceLabel: 'strong' | 'moderate' | 'weak' | 'conflicting';

  if (totalTimeframes === 0) {
    confluenceScore = 0;
    confluenceLabel = 'weak';
  } else if (alignedCount === totalTimeframes) {
    confluenceScore = 3;
    confluenceLabel = 'strong';
  } else if (alignedCount >= totalTimeframes - 1) {
    confluenceScore = 1;
    confluenceLabel = 'moderate';
  } else if (bullishCount > 0 && bearishCount > 0 && Math.abs(bullishCount - bearishCount) <= 1) {
    confluenceScore = -1;
    confluenceLabel = 'conflicting';
  } else {
    confluenceScore = 0;
    confluenceLabel = 'weak';
  }

  const data: TimeframeConfluence = {
    symbol,
    timeframes,
    alignedCount,
    totalTimeframes,
    confluenceScore,
    confluenceLabel,
  };

  const tfStr = Object.entries(timeframes).map(([tf, dir]) => `${tf}:${dir[0].toUpperCase()}`).join(' ');
  const summary = [
    `${symbol} TF: ${tfStr}`,
    `ALIGNED: ${alignedCount}/${totalTimeframes}`,
    `CONF: ${confluenceLabel.toUpperCase()} (${confluenceScore >= 0 ? '+' : ''}${confluenceScore})`,
  ].join(' | ');

  return { skillName: 'assessTimeframeConfluence', timestamp: now, data, summary, hasSignal: confluenceLabel !== 'weak' };
}

// ============================================================
// Skill 9: injectLessons
// ============================================================

/** Retrieve relevant past trade lessons for context injection */
export function injectLessons(
  symbol: string,
  direction: 'long' | 'short' | 'neutral',
): SkillResult<LessonsContext> {
  const now = Date.now();

  // Get recent lessons for this symbol
  const symbolLessons = getRecentLessons(5, symbol);
  // Get overall stats for this direction
  const stats = getLessonStats(symbol, direction === 'neutral' ? undefined : direction);
  // Get general recent lessons
  const generalLessons = symbolLessons.length < 3 ? getRecentLessons(5) : [];

  const allLessons = [...symbolLessons, ...generalLessons.filter(l => !symbolLessons.some(sl => sl.timestamp === l.timestamp))].slice(0, 5);

  const relevantLessons = allLessons.map(l => ({
    symbol: l.symbol,
    direction: l.direction,
    outcome: l.outcome,
    lesson: l.lesson,
    timestamp: l.timestamp,
  }));

  const data: LessonsContext = {
    relevantLessons,
    winRateSimilar: stats.winRate,
    avgRRSimilar: stats.avgPnlPct,
    totalSimilarTrades: stats.wins + stats.losses,
  };

  if (relevantLessons.length === 0) {
    return { skillName: 'injectLessons', timestamp: now, data, summary: 'No past lessons available', hasSignal: false };
  }

  const summary = [
    `LESSONS: ${relevantLessons.length} similar trades`,
    `WIN_RATE: ${(stats.winRate * 100).toFixed(0)}% (${stats.wins}W/${stats.losses}L)`,
    `AVG_PNL: ${stats.avgPnlPct.toFixed(1)}%`,
    relevantLessons[0] ? `LAST: "${relevantLessons[0].lesson.slice(0, 40)}..."` : '',
  ].filter(Boolean).join(' | ');

  return { skillName: 'injectLessons', timestamp: now, data, summary, hasSignal: relevantLessons.length > 0 };
}

// ============================================================
// Skill 10: trackNarrativeEvolution
// ============================================================

/** Track how narratives evolve over time (strengthening/weakening) and snapshot current state */
export function trackNarrativeEvolution(
  infoSignals: InfoSignals | null,
): SkillResult<NarrativeEvolution> {
  const now = Date.now();

  if (!infoSignals) {
    return {
      skillName: 'trackNarrativeEvolution',
      timestamp: now,
      data: { narratives: [], dominantNarrative: null },
      summary: 'No info signals',
      hasSignal: false,
    };
  }

  const narratives: NarrativeEvolution['narratives'] = [];

  // Track Polymarket probabilities
  for (const market of infoSignals.polymarket.slice(0, 5)) {
    const name = market.question.slice(0, 50);
    // Save snapshot to DB
    logNarrativeSnapshot('polymarket', name, market.probability, market.question);
    // Get history
    const history = getNarrativeHistory('polymarket', name, 6);
    const prevValue = history.length > 1 ? history[1].value : market.probability;
    const changeRate = market.probability - prevValue;

    let trend: 'strengthening' | 'weakening' | 'stable' | 'new' = 'stable';
    if (history.length <= 1) trend = 'new';
    else if (changeRate > 0.03) trend = 'strengthening';
    else if (changeRate < -0.03) trend = 'weakening';

    narratives.push({
      source: 'polymarket',
      name,
      trend,
      currentValue: market.probability,
      previousValue: prevValue,
      changeRate,
      detail: `${(market.probability * 100).toFixed(0)}% (${changeRate >= 0 ? '+' : ''}${(changeRate * 100).toFixed(1)}pp)`,
    });
  }

  // Track DefiLlama TVL trends
  for (const tvl of infoSignals.tvl.filter(t => Math.abs(t.tvlChange24h) > 2).slice(0, 3)) {
    const name = `${tvl.chain}_tvl`;
    logNarrativeSnapshot('defillama', name, tvl.tvlChange24h, `${tvl.chain} TVL: $${(tvl.tvl / 1e9).toFixed(1)}B`);
    const history = getNarrativeHistory('defillama', name, 6);
    const prevValue = history.length > 1 ? history[1].value : tvl.tvlChange24h;
    const changeRate = tvl.tvlChange24h - prevValue;

    let trend: 'strengthening' | 'weakening' | 'stable' | 'new' = 'stable';
    if (history.length <= 1) trend = 'new';
    else if (changeRate > 1) trend = 'strengthening';
    else if (changeRate < -1) trend = 'weakening';

    narratives.push({
      source: 'defillama',
      name: tvl.chain,
      trend,
      currentValue: tvl.tvlChange24h,
      previousValue: prevValue,
      changeRate,
      detail: `${tvl.chain} TVL ${tvl.tvlChange24h > 0 ? '+' : ''}${tvl.tvlChange24h.toFixed(1)}% 24h (rate: ${changeRate >= 0 ? '+' : ''}${changeRate.toFixed(1)})`,
    });
  }

  // Track CoinGecko trending momentum
  for (const coin of infoSignals.trending.slice(0, 3)) {
    const name = `trending_${coin.symbol}`;
    logNarrativeSnapshot('coingecko', name, coin.score, `${coin.name} rank #${coin.marketCapRank}`);
    const history = getNarrativeHistory('coingecko', name, 6);
    const prevValue = history.length > 1 ? history[1].value : coin.score;
    const changeRate = coin.score - prevValue;

    let trend: 'strengthening' | 'weakening' | 'stable' | 'new' = 'stable';
    if (history.length <= 1) trend = 'new';
    else if (changeRate > 5) trend = 'strengthening';
    else if (changeRate < -5) trend = 'weakening';

    narratives.push({
      source: 'coingecko',
      name: coin.symbol,
      trend,
      currentValue: coin.score,
      previousValue: prevValue,
      changeRate,
      detail: `${coin.symbol} trending score ${coin.score} (${changeRate >= 0 ? '+' : ''}${changeRate.toFixed(0)})`,
    });
  }

  // Dominant narrative: strongest strengthening signal
  const strengthening = narratives.filter(n => n.trend === 'strengthening');
  const dominantNarrative = strengthening.length > 0
    ? `${strengthening[0].source}/${strengthening[0].name}: ${strengthening[0].detail}`
    : null;

  const data: NarrativeEvolution = { narratives, dominantNarrative };

  const trendCounts = { strengthening: 0, weakening: 0, stable: 0, new: 0 };
  for (const n of narratives) trendCounts[n.trend]++;

  const summary = [
    `NARRATIVES: ${narratives.length}`,
    trendCounts.strengthening > 0 ? `UP: ${trendCounts.strengthening}` : '',
    trendCounts.weakening > 0 ? `DOWN: ${trendCounts.weakening}` : '',
    dominantNarrative ? `DOMINANT: ${dominantNarrative.slice(0, 50)}` : '',
  ].filter(Boolean).join(' | ');

  return { skillName: 'trackNarrativeEvolution', timestamp: now, data, summary, hasSignal: narratives.length > 0 };
}
