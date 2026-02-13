/**
 * LLM Skills — Focused LLM calls with pre-compressed context.
 *
 * decideTrade: Urgent trigger → single LLM call with code-skill summaries
 * assessRegime: 30-min comprehensive → market regime + directives
 */
import type { MarketSnapshot, TradeProposal, OrderSide, MarketRegime, MarketDirection, ActiveDiscretionaryPosition } from '../types.js';
import type { ComprehensiveResponse } from '../../strategies/discretionary/llm-advisor.js';
import type { DecisionContext, CritiqueResult, TradeReviewResult, PositionManagementAction, ScenarioAnalysis } from './types.js';
import { LLMAdvisor } from '../../strategies/discretionary/llm-advisor.js';
import { randomUUID } from 'crypto';
import { createChildLogger } from '../../monitoring/logger.js';
import { logTradeLesson } from '../../data/storage.js';

const log = createChildLogger('llm-decide');

// ============================================================
// System Prompt: decideTrade (focused, ~50 lines vs original 115)
// ============================================================

const DECIDE_TRADE_SYSTEM_PROMPT = `You are a crypto perpetual futures trader on Hyperliquid.

You receive PRE-ANALYZED context from code-based systems. Your ONLY job:
Validate the opportunity and propose exact trade parameters, OR reject as noise.

## What You Receive (already processed by code)
- CONTEXT: Current market regime, direction, risk level
- SIGNAL: Which indicators triggered, quality rating, direction alignment
- EXTERNAL: Whether Polymarket/DeFi/Trending data confirms or contradicts
- RISK: Available capital, drawdown, position limits
- PRICE DATA: Technical snapshot of the triggered symbol

## Decision Process
1. Do the signals converge into a real setup?
2. Does external intelligence confirm the technical signal?
3. Is the risk/reward acceptable given current conditions?
4. Be decisive — propose or reject. No vague answers.

## Confidence & Leverage (STRICT)
- "highest" (10-15x, 20-25% size): External intel + TA perfectly aligned. RARE.
- "high" (5-10x, 15-20% size): 3+ aligned signals + external confirms. Scorer 8+.
- "medium" (3-5x, 10-15% size): TA-only decent setup. No external confirmation.
- "low" (3x, 5-10% size): Marginal or counter-trend setup.

## Risk Rules (STRICT)
- Stop loss REQUIRED on every trade.
  - 10-15x leverage: SL within 1-2% of entry
  - 5-10x: SL within 2-3%
  - 3-5x: SL within 3-5%
  - 3x: SL within 5-8%
- Take profit: Minimum 1.5:1 R:R ratio, prefer 2:1+
- Max 25% of allocated capital per trade.
- Extreme funding (>0.05%/h): bias opposite direction.

## Response: JSON only. No markdown.
For a trade:
{ "action": "propose_trade", "symbol": "ETH-PERP", "side": "buy",
  "entry_price": 2500.00, "stop_loss": 2450.00, "take_profit": 2600.00,
  "size_pct": 15, "leverage": 5, "confidence": "high",
  "rationale": "Brief reason citing which signals and external factors drove the decision" }

For no trade:
{ "action": "no_trade", "rationale": "Why this is noise, not signal" }`;

// ============================================================
// System Prompt: assessRegime (comprehensive, 30-min)
// ============================================================

const ASSESS_REGIME_SYSTEM_PROMPT = `You are the strategic brain of a crypto trading bot on Hyperliquid.

Every 30 minutes, you assess market state and set strategic directives.
You are NOT making individual trades — you are setting CONTEXT for strategies.

## What You Assess
1. Market Regime: trending_up, trending_down, range, volatile, unknown
2. Direction: bullish, bearish, neutral
3. Risk Level: 1 (calm) to 5 (extreme danger)
4. Strategy Directives: how each strategy should adjust

## Data Sources You Receive
- Previous assessment (for continuity)
- Market snapshots with technical indicators
- External intelligence (Polymarket, DefiLlama, CoinGecko) summaries
- Current risk assessment

## Response: JSON only, no markdown.
{ "regime": "trending_up", "direction": "bullish", "risk_level": 2, "confidence": 75,
  "reasoning": "Brief explanation including external intelligence factors",
  "directives": {
    "discretionary": { "active": true, "bias": "long", "focus_symbols": ["ETH-PERP"], "max_leverage": 10 },
    "momentum": { "active": true, "leverage_multiplier": 1.2, "allow_long": true, "allow_short": false }
  }
}`;

// ============================================================
// decideTrade: Urgent trigger → focused LLM call
// ============================================================

export async function decideTrade(
  advisor: LLMAdvisor,
  decision: DecisionContext,
  targetSnapshot: MarketSnapshot | undefined,
): Promise<{ action: string; proposal?: TradeProposal; content?: string }> {
  if (!advisor.isAvailable()) {
    return { action: 'no_trade', content: 'LLM advisor not available' };
  }

  if (!targetSnapshot) {
    return { action: 'no_trade', content: 'No snapshot data for target symbol' };
  }

  // Build the focused snapshot (only triggered symbol)
  const snapshotData = {
    symbol: targetSnapshot.symbol,
    price: targetSnapshot.price,
    change_1h: `${targetSnapshot.change1h.toFixed(2)}%`,
    change_4h: `${targetSnapshot.change4h.toFixed(2)}%`,
    change_24h: `${targetSnapshot.change24h.toFixed(2)}%`,
    rsi14: targetSnapshot.rsi14.toFixed(1),
    ema9: targetSnapshot.ema9.toFixed(2),
    ema21: targetSnapshot.ema21.toFixed(2),
    atr14: targetSnapshot.atr14.toFixed(2),
    support: targetSnapshot.support.toFixed(2),
    resistance: targetSnapshot.resistance.toFixed(2),
    funding: `${(targetSnapshot.fundingRate * 100).toFixed(4)}%/h`,
    trend: targetSnapshot.trend,
    volume_24h: `$${(targetSnapshot.volume24h / 1_000_000).toFixed(1)}M`,
    ...(targetSnapshot.bollingerUpper !== undefined && { bb_upper: targetSnapshot.bollingerUpper.toFixed(2) }),
    ...(targetSnapshot.bollingerLower !== undefined && { bb_lower: targetSnapshot.bollingerLower.toFixed(2) }),
    ...(targetSnapshot.volumeRatio !== undefined && { vol_ratio: `${targetSnapshot.volumeRatio.toFixed(2)}x` }),
    ...(targetSnapshot.oiChange1h !== undefined && { oi_change_1h: `${targetSnapshot.oiChange1h.toFixed(2)}%` }),
  };

  // Build enhanced prompt sections from new skills
  const enhancedSections = buildEnhancedPromptSections(decision);

  // Assemble the focused prompt
  const prompt = [
    `=== CONTEXT ===`,
    decision.context.summary,
    ``,
    `=== SIGNAL ===`,
    decision.signal.summary,
    ``,
    `=== EXTERNAL ===`,
    decision.external.summary,
    ``,
    `=== RISK ===`,
    decision.risk.summary,
    ``,
    // Inject enhanced skill data
    ...enhancedSections,
    enhancedSections.length > 0 ? `` : '',
    `=== PRICE DATA (${targetSnapshot.symbol}) ===`,
    JSON.stringify(snapshotData, null, 2),
    ``,
    `DECIDE: Trade or no trade? Factor in ALL context including liquidity, orderflow, confluence, past lessons, and narrative trends. JSON only.`,
  ].filter(Boolean).join('\n');

  try {
    const response = await advisor.callWithSystemPrompt(
      DECIDE_TRADE_SYSTEM_PROMPT,
      prompt,
      'skill_decide',
    );

    return parseTradeResponse(response);
  } catch (err) {
    log.error({ err }, 'decideTrade LLM call failed');
    return { action: 'no_trade', content: `LLM error: ${String(err)}` };
  }
}

// ============================================================
// assessRegime: 30-min comprehensive → regime + directives
// ============================================================

export async function assessRegime(
  advisor: LLMAdvisor,
  compressedContext: string,
  balance?: number,
): Promise<ComprehensiveResponse | null> {
  if (!advisor.isAvailable()) return null;

  let contextWithBalance = compressedContext;
  if (balance !== undefined) {
    const balanceCtx = [
      `## Current Portfolio Balance`,
      `- Total: $${balance.toFixed(2)}`,
      `- Discretionary (55%): ~$${(balance * 0.55).toFixed(2)}`,
    ].join('\n');
    contextWithBalance = `${balanceCtx}\n\n${compressedContext}`;
  }

  try {
    return await advisor.callComprehensiveWithSystemPrompt(
      ASSESS_REGIME_SYSTEM_PROMPT,
      contextWithBalance,
    );
  } catch (err) {
    log.error({ err }, 'assessRegime LLM call failed');
    return null;
  }
}

// ============================================================
// System Prompt: critiqueTrade (adversarial risk review)
// ============================================================

const CRITIQUE_TRADE_SYSTEM_PROMPT = `You are a risk analyst reviewing a proposed crypto perpetual futures trade.
Your role is ADVERSARIAL — intentionally look for flaws, over-optimism, and hidden risks.

## Your Checks
1. Is the stop loss appropriate for the leverage? (Higher leverage → tighter SL needed)
2. Is the R:R ratio realistic given current volatility?
3. Do the signal direction and market regime actually align?
4. Is the leverage excessive relative to the confidence level?
5. Does external intelligence genuinely confirm the thesis, or is it over-interpreted?

## Scoring (1-10)
- 1-3: Reject — serious flaws, likely losing trade
- 4-5: Borderline — reduce size/leverage significantly or reject
- 6-7: Acceptable — minor adjustments may help
- 8-10: Strong — proposal is well-reasoned

## Response: JSON only. No markdown.
{
  "verdict": "approve" | "reject" | "reduce",
  "score": 7,
  "flaws": ["SL too tight for 5x leverage", "Volume declining contradicts breakout thesis"],
  "adjustments": { "leverage": 3, "size_pct": 10, "stop_loss": 2440 },
  "reasoning": "Brief explanation of your assessment"
}

Notes:
- "adjustments" is optional for "approve", required for "reduce"
- Be specific in flaws — vague criticism is useless
- If the trade is solid, say so. Don't reject good trades just to be contrarian.`;

// ============================================================
// System Prompt: assessRegime — Technical-only perspective
// ============================================================

const ASSESS_REGIME_TECHNICAL_PROMPT = `You are the technical analysis brain of a crypto trading bot on Hyperliquid.

You assess market state using ONLY technical/on-chain data. No external narrative.

## What You Assess
1. Market Regime: trending_up, trending_down, range, volatile, unknown
2. Direction: bullish, bearish, neutral
3. Risk Level: 1 (calm) to 5 (extreme danger)
4. Strategy Directives: how each strategy should adjust

## Data You Focus On
- RSI, EMA crossovers, ATR, Bollinger Bands
- Volume and volume ratios
- Open interest changes
- Funding rates
- Support/resistance levels
- Price action across multiple symbols

## Response: JSON only, no markdown.
{ "regime": "trending_up", "direction": "bullish", "risk_level": 2, "confidence": 75,
  "reasoning": "Brief TA-based explanation",
  "directives": {
    "discretionary": { "active": true, "bias": "long", "focus_symbols": ["ETH-PERP"], "max_leverage": 10 },
    "momentum": { "active": true, "leverage_multiplier": 1.2, "allow_long": true, "allow_short": false }
  }
}`;

// ============================================================
// System Prompt: assessRegime — Macro/External perspective
// ============================================================

const ASSESS_REGIME_MACRO_PROMPT = `You are the macro/narrative analyst brain of a crypto trading bot on Hyperliquid.

You assess market state from the EXTERNAL INTELLIGENCE perspective — what are market participants betting on?

## What You Assess
1. Market Regime: trending_up, trending_down, range, volatile, unknown
2. Direction: bullish, bearish, neutral
3. Risk Level: 1 (calm) to 5 (extreme danger)
4. Strategy Directives: how each strategy should adjust

## Data You Focus On
- Polymarket: Prediction market probability shifts (leading indicator for events)
- DefiLlama: DeFi TVL capital flows — where is money moving?
- CoinGecko: Trending coins — what does retail sentiment look like?
- Narrative detection: Is there a strong story driving the market?
- Event risk: Upcoming catalysts or binary events?

## Response: JSON only, no markdown.
{ "regime": "volatile", "direction": "bullish", "risk_level": 3, "confidence": 65,
  "reasoning": "Brief macro/narrative explanation",
  "directives": {
    "discretionary": { "active": true, "bias": "long", "focus_symbols": ["ETH-PERP"], "max_leverage": 5 },
    "momentum": { "active": true, "leverage_multiplier": 1.0, "allow_long": true, "allow_short": true }
  }
}`;

// ============================================================
// critiqueTrade: Adversarial review of a trade proposal
// ============================================================

export async function critiqueTrade(
  advisor: LLMAdvisor,
  decision: DecisionContext,
  proposal: TradeProposal,
  snapshot: MarketSnapshot | undefined,
): Promise<CritiqueResult | null> {
  if (!advisor.isAvailable()) return null;

  const proposalData = {
    symbol: proposal.symbol,
    side: proposal.side,
    entry_price: proposal.entryPrice,
    stop_loss: proposal.stopLoss,
    take_profit: proposal.takeProfit,
    size_pct: Math.round(proposal.size * 100),
    leverage: proposal.leverage,
    confidence: proposal.confidence,
    rr_ratio: proposal.riskRewardRatio.toFixed(2),
    rationale: proposal.rationale,
  };

  const parts = [
    `=== CONTEXT (from code skills) ===`,
    decision.context.summary,
    ``,
    `=== SIGNAL ===`,
    decision.signal.summary,
    ``,
    `=== EXTERNAL ===`,
    decision.external.summary,
    ``,
    `=== RISK ===`,
    decision.risk.summary,
    ``,
    `=== PROPOSED TRADE ===`,
    JSON.stringify(proposalData, null, 2),
  ];

  if (snapshot) {
    parts.push(
      ``,
      `=== PRICE DATA (${snapshot.symbol}) ===`,
      JSON.stringify({
        price: snapshot.price,
        rsi14: snapshot.rsi14.toFixed(1),
        atr14: snapshot.atr14.toFixed(2),
        ema9: snapshot.ema9.toFixed(2),
        ema21: snapshot.ema21.toFixed(2),
        support: snapshot.support.toFixed(2),
        resistance: snapshot.resistance.toFixed(2),
        trend: snapshot.trend,
        funding: `${(snapshot.fundingRate * 100).toFixed(4)}%/h`,
        ...(snapshot.bollingerUpper !== undefined && { bb_upper: snapshot.bollingerUpper.toFixed(2) }),
        ...(snapshot.bollingerLower !== undefined && { bb_lower: snapshot.bollingerLower.toFixed(2) }),
      }, null, 2),
    );
  }

  parts.push(``, `CRITIQUE this trade proposal. JSON only.`);

  try {
    const response = await advisor.callWithSystemPrompt(
      CRITIQUE_TRADE_SYSTEM_PROMPT,
      parts.join('\n'),
      'skill_critique',
    );
    return parseCritiqueResponse(response);
  } catch (err) {
    log.error({ err }, 'critiqueTrade LLM call failed');
    return null;
  }
}

// ============================================================
// applyCritique: Merge critique verdict into final decision
// ============================================================

export function applyCritique(
  proposal: TradeProposal,
  critique: CritiqueResult,
): { action: string; proposal?: TradeProposal; content?: string } {
  const { verdict, score, adjustments } = critique;

  // Strong approve — pass through as-is
  if (verdict === 'approve' && score >= 6) {
    log.info({ symbol: proposal.symbol, score, verdict }, 'Critique approved proposal');
    return { action: 'propose_trade', proposal };
  }

  // Hard reject — cancel the trade
  if (verdict === 'reject' && score <= 3) {
    log.info({ symbol: proposal.symbol, score, flaws: critique.flaws }, 'Critique rejected proposal');
    return { action: 'no_trade', content: `Critique rejected (score ${score}): ${critique.flaws.join('; ')}` };
  }

  // Reduce or soft reject (score 4-5) — apply adjustments
  const adjusted: TradeProposal = { ...proposal };

  if (verdict === 'reduce' && adjustments) {
    if (adjustments.leverage !== undefined) adjusted.leverage = Math.min(15, adjustments.leverage);
    if (adjustments.size_pct !== undefined) adjusted.size = adjustments.size_pct / 100;
    if (adjustments.stop_loss !== undefined) adjusted.stopLoss = adjustments.stop_loss;
    if (adjustments.take_profit !== undefined) adjusted.takeProfit = adjustments.take_profit;
  } else if (verdict === 'reject' && score >= 4) {
    // Soft reject: downgrade to minimum entry
    adjusted.leverage = 3;
    adjusted.size = Math.min(adjusted.size, 0.10); // cap at 10%
  }

  // Recalculate R:R after adjustments
  adjusted.riskRewardRatio = Math.abs(adjusted.takeProfit - adjusted.entryPrice) /
    Math.abs(adjusted.entryPrice - adjusted.stopLoss);

  log.info({
    symbol: proposal.symbol,
    verdict,
    score,
    origLev: proposal.leverage,
    newLev: adjusted.leverage,
    origSize: Math.round(proposal.size * 100),
    newSize: Math.round(adjusted.size * 100),
  }, 'Critique adjusted proposal');

  return { action: 'propose_trade', proposal: adjusted };
}

// ============================================================
// assessRegimeTechnical: TA-only perspective for dual assessment
// ============================================================

export async function assessRegimeTechnical(
  advisor: LLMAdvisor,
  technicalContext: string,
  balance?: number,
): Promise<ComprehensiveResponse | null> {
  if (!advisor.isAvailable()) return null;

  let contextWithBalance = technicalContext;
  if (balance !== undefined) {
    const balanceCtx = [
      `## Current Portfolio Balance`,
      `- Total: $${balance.toFixed(2)}`,
      `- Discretionary (55%): ~$${(balance * 0.55).toFixed(2)}`,
    ].join('\n');
    contextWithBalance = `${balanceCtx}\n\n${technicalContext}`;
  }

  try {
    return await advisor.callComprehensiveWithSystemPrompt(
      ASSESS_REGIME_TECHNICAL_PROMPT,
      contextWithBalance,
    );
  } catch (err) {
    log.error({ err }, 'assessRegimeTechnical LLM call failed');
    return null;
  }
}

// ============================================================
// assessRegimeMacro: External/narrative perspective
// ============================================================

export async function assessRegimeMacro(
  advisor: LLMAdvisor,
  macroContext: string,
  balance?: number,
): Promise<ComprehensiveResponse | null> {
  if (!advisor.isAvailable()) return null;

  let contextWithBalance = macroContext;
  if (balance !== undefined) {
    const balanceCtx = [
      `## Current Portfolio Balance`,
      `- Total: $${balance.toFixed(2)}`,
      `- Discretionary (55%): ~$${(balance * 0.55).toFixed(2)}`,
    ].join('\n');
    contextWithBalance = `${balanceCtx}\n\n${macroContext}`;
  }

  try {
    return await advisor.callComprehensiveWithSystemPrompt(
      ASSESS_REGIME_MACRO_PROMPT,
      contextWithBalance,
    );
  } catch (err) {
    log.error({ err }, 'assessRegimeMacro LLM call failed');
    return null;
  }
}

// ============================================================
// mergeRegimeAssessments: Combine TA + Macro perspectives
// ============================================================

const REGIME_CONSERVATISM: Record<string, number> = {
  volatile: 4,
  trending_down: 3,
  trending_up: 2,
  range: 1,
  unknown: 0,
};

export function mergeRegimeAssessments(
  technical: ComprehensiveResponse,
  macro: ComprehensiveResponse,
): ComprehensiveResponse {
  // Regime: if they agree, use it; if they conflict, pick the more conservative one
  let regime: MarketRegime;
  if (technical.regime === macro.regime) {
    regime = technical.regime;
  } else {
    const techScore = REGIME_CONSERVATISM[technical.regime] ?? 0;
    const macroScore = REGIME_CONSERVATISM[macro.regime] ?? 0;
    regime = techScore >= macroScore ? technical.regime : macro.regime;
  }

  // Direction: agree → use it; conflict → neutral
  let direction: MarketDirection;
  if (technical.direction === macro.direction) {
    direction = technical.direction;
  } else {
    direction = 'neutral';
  }

  // Risk: take the higher (more conservative) value
  const riskLevel = Math.max(technical.riskLevel, macro.riskLevel);

  // Confidence: agreement boosts it, conflict lowers it
  let confidence: number;
  if (technical.direction === macro.direction && technical.regime === macro.regime) {
    confidence = Math.min(100, Math.round((technical.confidence + macro.confidence) / 2 + 10));
  } else {
    confidence = Math.max(0, Math.min(technical.confidence, macro.confidence) - 10);
  }

  // Directives: pick the more conservative settings
  const techDir = technical.directives;
  const macroDir = macro.directives;
  const mergedDirectives = techDir ?? macroDir;

  if (techDir && macroDir) {
    // Merge discretionary: lower max_leverage, more restrictive bias
    if (techDir.discretionary && macroDir.discretionary) {
      mergedDirectives!.discretionary = {
        active: techDir.discretionary.active && macroDir.discretionary.active,
        bias: technical.direction === macro.direction
          ? techDir.discretionary.bias
          : 'neutral',
        focusSymbols: [...new Set([
          ...(techDir.discretionary.focusSymbols ?? []),
          ...(macroDir.discretionary.focusSymbols ?? []),
        ])],
        maxLeverage: Math.min(
          techDir.discretionary.maxLeverage ?? 10,
          macroDir.discretionary.maxLeverage ?? 10,
        ),
      };
    }
    // Merge momentum: lower multiplier, restrictive direction
    if (techDir.momentum && macroDir.momentum) {
      mergedDirectives!.momentum = {
        active: techDir.momentum.active && macroDir.momentum.active,
        leverageMultiplier: Math.min(
          techDir.momentum.leverageMultiplier ?? 1,
          macroDir.momentum.leverageMultiplier ?? 1,
        ),
        allowLong: techDir.momentum.allowLong && macroDir.momentum.allowLong,
        allowShort: techDir.momentum.allowShort && macroDir.momentum.allowShort,
      };
    }
  }

  const reasoning = `Technical: ${technical.reasoning} | Macro: ${macro.reasoning}`;

  log.info({
    techRegime: technical.regime,
    macroRegime: macro.regime,
    mergedRegime: regime,
    techDir: technical.direction,
    macroDir: macro.direction,
    mergedDir: direction,
    confidence,
    riskLevel,
  }, 'Merged dual regime assessments');

  return { regime, direction, riskLevel, confidence, reasoning, directives: mergedDirectives };
}

// ============================================================
// LLM Skill: managePosition — Dynamic position management
// ============================================================

const MANAGE_POSITION_SYSTEM_PROMPT = `You are the position manager of a crypto perpetual futures trading bot on Hyperliquid.

## Your Job
Review an OPEN position and decide the optimal management action.
You are NOT opening new trades — only managing existing ones.

## Actions You Can Take
1. "hold" — Keep current SL/TP, no change needed
2. "trail_stop" — Move stop loss to lock in profit (provide new SL price)
3. "partial_close" — Take partial profit (provide % to close, e.g. 50)
4. "move_to_breakeven" — Move SL to entry price (risk-free position)
5. "close_now" — Close entire position immediately (conditions deteriorated)

## Decision Rules
- Position up 1R+ (profit >= risk distance): Consider moving SL to breakeven
- Position up 1.5R+: Consider partial close (50%) + trail rest
- Market regime changed against position: Consider close_now
- RSI reversed against position (was oversold→overbought or vice versa): Trail or close
- Volume dying after entry: Position may be stalling, consider tighter stop
- If in doubt, "hold" — avoid over-managing

## Response: JSON only, no markdown.
{
  "action": "trail_stop",
  "new_stop_loss": 2520.00,
  "partial_close_pct": null,
  "reasoning": "Position up 1.2R, moving SL to breakeven+0.5% to protect gains while allowing room for TP"
}`;

export async function managePosition(
  advisor: LLMAdvisor,
  position: ActiveDiscretionaryPosition,
  currentSnapshot: MarketSnapshot | undefined,
  regime: string,
  direction: string,
): Promise<PositionManagementAction | null> {
  if (!advisor.isAvailable() || !currentSnapshot) return null;

  const currentPrice = currentSnapshot.price;
  const unrealizedPnl = (currentPrice - position.entryPrice) * position.size * (position.side === 'buy' ? 1 : -1);
  const riskDistance = Math.abs(position.entryPrice - position.stopLoss);
  const currentR = riskDistance > 0 ? unrealizedPnl / (riskDistance * position.size) : 0;
  const holdMinutes = Math.floor((Date.now() - position.openedAt) / 60_000);

  const prompt = [
    `=== OPEN POSITION ===`,
    `Symbol: ${position.symbol} | Side: ${position.side.toUpperCase()} | Leverage: ${position.leverage}x`,
    `Entry: $${position.entryPrice} | Current: $${currentPrice}`,
    `SL: $${position.stopLoss} | TP: $${position.takeProfit}`,
    `Unrealized PnL: $${unrealizedPnl.toFixed(2)} (${currentR.toFixed(2)}R)`,
    `Held: ${holdMinutes}min`,
    ``,
    `=== MARKET CONDITIONS ===`,
    `Regime: ${regime} | Direction: ${direction}`,
    `RSI: ${currentSnapshot.rsi14.toFixed(1)} | Trend: ${currentSnapshot.trend}`,
    `EMA9: ${currentSnapshot.ema9.toFixed(2)} | EMA21: ${currentSnapshot.ema21.toFixed(2)}`,
    `ATR: ${currentSnapshot.atr14.toFixed(2)}`,
    currentSnapshot.volumeRatio !== undefined ? `Volume Ratio: ${currentSnapshot.volumeRatio.toFixed(2)}x` : '',
    ``,
    `MANAGE: What action should be taken? JSON only.`,
  ].filter(Boolean).join('\n');

  try {
    const response = await advisor.callWithSystemPrompt(
      MANAGE_POSITION_SYSTEM_PROMPT,
      prompt,
      'skill_manage_position',
    );
    return parseManagePositionResponse(response, position.symbol);
  } catch (err) {
    log.error({ err }, 'managePosition LLM call failed');
    return null;
  }
}

// ============================================================
// LLM Skill: reviewTrade — Post-trade analysis & learning
// ============================================================

const REVIEW_TRADE_SYSTEM_PROMPT = `You are the trade reviewer of a crypto perpetual futures trading bot.

## Your Job
After a trade closes, analyze what happened and extract lessons for future trades.

## What You Evaluate
1. Was the entry signal accurate? Which indicators were right/wrong?
2. Was the exit optimal or could it have been better?
3. Was leverage appropriate for the setup?
4. What external factors affected the trade that weren't in the original analysis?
5. What should be done differently next time in a similar setup?

## Response: JSON only, no markdown.
{
  "outcome": "win",
  "pnl_pct": 3.5,
  "what_worked": ["RSI reversal signal was accurate", "External intel confirmed direction"],
  "what_failed": ["TP was too aggressive, price reversed 1% before reaching it"],
  "signal_accuracy": [
    {"signal": "RSI oversold", "accurate": true},
    {"signal": "EMA cross", "accurate": true},
    {"signal": "Volume surge", "accurate": false}
  ],
  "lesson": "RSI extreme + EMA cross is a reliable combo for this symbol. Set TP at 1.5R instead of 2R for faster exits.",
  "improvement_suggestion": "Consider partial take-profit at 1R to secure gains while letting rest run"
}`;

export async function reviewTrade(
  advisor: LLMAdvisor,
  position: ActiveDiscretionaryPosition,
  closePrice: number,
  pnl: number,
  entryContext: string | null,
  regime: string,
): Promise<TradeReviewResult | null> {
  if (!advisor.isAvailable()) return null;

  const pnlPct = ((closePrice - position.entryPrice) / position.entryPrice) * 100 * (position.side === 'buy' ? 1 : -1);
  const holdMinutes = Math.floor((Date.now() - position.openedAt) / 60_000);

  const prompt = [
    `=== CLOSED TRADE ===`,
    `Symbol: ${position.symbol} | Side: ${position.side.toUpperCase()} | Leverage: ${position.leverage}x`,
    `Entry: $${position.entryPrice} | Close: $${closePrice}`,
    `SL was: $${position.stopLoss} | TP was: $${position.takeProfit}`,
    `PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`,
    `Held: ${holdMinutes}min | Regime at entry: ${regime}`,
    ``,
    entryContext ? `=== ENTRY CONTEXT ===\n${entryContext}\n` : '',
    `REVIEW: Analyze this trade and extract lessons. JSON only.`,
  ].filter(Boolean).join('\n');

  try {
    const response = await advisor.callWithSystemPrompt(
      REVIEW_TRADE_SYSTEM_PROMPT,
      prompt,
      'skill_review_trade',
    );
    const result = parseReviewResponse(response);
    if (result) {
      // Persist lesson to DB
      try {
        logTradeLesson(
          position.symbol,
          position.side,
          position.side === 'buy' ? 'long' : 'short',
          position.entryPrice,
          closePrice,
          pnl,
          pnlPct,
          position.leverage,
          result.outcome,
          result.whatWorked.join('; '),
          result.whatFailed.join('; '),
          result.lesson,
          JSON.stringify(result.signalAccuracy),
          result.improvementSuggestion,
          regime,
          null,
        );
      } catch (e) {
        log.warn({ err: e }, 'Failed to persist trade lesson');
      }
    }
    return result;
  } catch (err) {
    log.error({ err }, 'reviewTrade LLM call failed');
    return null;
  }
}

// ============================================================
// LLM Skill: planScenarios — Pre-trade scenario analysis
// ============================================================

const PLAN_SCENARIOS_SYSTEM_PROMPT = `You are the scenario planner for a crypto perpetual futures trading bot.

## Your Job
Before a high-conviction trade executes, model 3 possible outcomes to stress-test the thesis.

## Scenarios to Model
1. **Bull case**: What if the trade goes perfectly?
2. **Base case**: Most likely outcome given current conditions
3. **Bear case**: What could go wrong? How bad could it get?

For each scenario, estimate:
- Probability (must sum to ~100%)
- Price target (where would price go?)
- Position outcome (hit TP, hit SL, partial fill, etc.)
- PnL estimate in USD

## Final Assessment
- Is the worst case acceptable given position size and leverage?
- Overall: proceed / reduce size / abort

## Response: JSON only, no markdown.
{
  "scenarios": [
    {"name": "Bull", "probability": 30, "price_target": 2650, "position_outcome": "TP hit", "pnl_estimate": 45.00},
    {"name": "Base", "probability": 50, "price_target": 2550, "position_outcome": "Partial profit, manual close", "pnl_estimate": 15.00},
    {"name": "Bear", "probability": 20, "price_target": 2420, "position_outcome": "SL hit", "pnl_estimate": -25.00}
  ],
  "worst_case_acceptable": true,
  "overall_assessment": "Expected value positive (+$12.50). Worst case -$25 is within risk limits. Proceed."
}`;

export async function planScenarios(
  advisor: LLMAdvisor,
  proposal: TradeProposal,
  decision: DecisionContext,
  snapshot: MarketSnapshot | undefined,
): Promise<ScenarioAnalysis | null> {
  if (!advisor.isAvailable() || !snapshot) return null;

  const prompt = [
    `=== PROPOSED TRADE ===`,
    `Symbol: ${proposal.symbol} | Side: ${proposal.side.toUpperCase()}`,
    `Entry: $${proposal.entryPrice} | SL: $${proposal.stopLoss} | TP: $${proposal.takeProfit}`,
    `Leverage: ${proposal.leverage}x | Size: ${(proposal.size * 100).toFixed(0)}% of capital`,
    `Confidence: ${proposal.confidence} | R:R: ${proposal.riskRewardRatio.toFixed(1)}`,
    ``,
    `=== CONTEXT ===`,
    decision.context.summary,
    decision.signal.summary,
    decision.external.summary,
    decision.risk.summary,
    ``,
    `=== CURRENT MARKET ===`,
    `Price: $${snapshot.price} | RSI: ${snapshot.rsi14.toFixed(1)} | Trend: ${snapshot.trend}`,
    `ATR: ${snapshot.atr14.toFixed(2)} | Funding: ${(snapshot.fundingRate * 100).toFixed(4)}%/h`,
    ``,
    `MODEL 3 scenarios (Bull/Base/Bear). JSON only.`,
  ].join('\n');

  try {
    const response = await advisor.callWithSystemPrompt(
      PLAN_SCENARIOS_SYSTEM_PROMPT,
      prompt,
      'skill_plan_scenarios',
    );
    return parseScenarioResponse(response);
  } catch (err) {
    log.error({ err }, 'planScenarios LLM call failed');
    return null;
  }
}

// ============================================================
// Enhanced decideTrade: Inject new skill summaries into prompt
// ============================================================

/**
 * Build enhanced prompt sections from new skills.
 * Used by decideTrade to include liquidity, orderflow, confluence, lessons, narratives.
 */
export function buildEnhancedPromptSections(decision: DecisionContext): string[] {
  const parts: string[] = [];

  if (decision.liquidity?.hasSignal) {
    parts.push(`=== LIQUIDITY ===`, decision.liquidity.summary);
  }
  if (decision.portfolioCorrelation?.hasSignal) {
    parts.push(`=== PORTFOLIO CORRELATION ===`, decision.portfolioCorrelation.summary);
  }
  if (decision.orderflow?.hasSignal) {
    parts.push(`=== ORDERFLOW ===`, decision.orderflow.summary);
  }
  if (decision.timeframeConfluence?.hasSignal) {
    parts.push(`=== TIMEFRAME CONFLUENCE ===`, decision.timeframeConfluence.summary);
  }
  if (decision.lessons?.hasSignal) {
    parts.push(`=== PAST LESSONS ===`, decision.lessons.summary);
  }
  if (decision.narrativeEvolution?.hasSignal) {
    parts.push(`=== NARRATIVE TRENDS ===`, decision.narrativeEvolution.summary);
  }

  return parts;
}

// ============================================================
// Response Parsing
// ============================================================

function parseTradeResponse(response: string): { action: string; proposal?: TradeProposal; content?: string } {
  try {
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const data = JSON.parse(jsonStr);

    if (data.action === 'propose_trade') {
      const leverage = Math.min(15, data.leverage ?? 3);
      const entryPrice = data.entry_price;
      const sl = data.stop_loss;
      const tp = data.take_profit;

      // CRIT-10: Validate SL distance matches leverage rules
      // Max SL % per leverage tier: 10-15x → 2%, 5-10x → 3%, 3-5x → 5%, <3x → 8%
      const slPct = Math.abs(entryPrice - sl) / entryPrice * 100;
      let maxSlPct: number;
      if (leverage >= 10) maxSlPct = 2;
      else if (leverage >= 5) maxSlPct = 3;
      else if (leverage >= 3) maxSlPct = 5;
      else maxSlPct = 8;

      // Clamp SL if it exceeds the max for this leverage
      let clampedSl = sl;
      if (slPct > maxSlPct) {
        const slDir = sl < entryPrice ? -1 : 1;
        clampedSl = entryPrice + slDir * entryPrice * (maxSlPct / 100);
        log.warn({ symbol: data.symbol, originalSl: sl, clampedSl, leverage, slPct: slPct.toFixed(2), maxSlPct }, 'SL clamped to match leverage rules');
      }

      // Validate R:R >= 1.5
      const slDist = Math.abs(entryPrice - clampedSl);
      const tpDist = Math.abs(tp - entryPrice);
      const rr = slDist > 0 ? tpDist / slDist : 0;
      // If R:R < 1.5, adjust TP to meet minimum
      let clampedTp = tp;
      if (rr < 1.5 && slDist > 0) {
        const tpDir = tp > entryPrice ? 1 : -1;
        clampedTp = entryPrice + tpDir * slDist * 1.5;
        log.warn({ symbol: data.symbol, originalTp: tp, clampedTp, rr: rr.toFixed(2) }, 'TP adjusted for min 1.5:1 R:R');
      }

      const proposal: TradeProposal = {
        id: randomUUID(),
        symbol: data.symbol,
        side: data.side as OrderSide,
        entryPrice,
        size: data.size_pct / 100,
        stopLoss: clampedSl,
        takeProfit: clampedTp,
        leverage,
        rationale: data.rationale,
        confidence: data.confidence ?? 'medium',
        riskRewardRatio: slDist > 0 ? Math.abs(clampedTp - entryPrice) / slDist : 1.5,
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
      };
      return { action: 'propose_trade', proposal };
    }

    if (data.action === 'no_trade') {
      return { action: 'no_trade', content: data.rationale };
    }

    if (data.action === 'analysis') {
      return { action: 'analysis', content: data.content };
    }

    return { action: 'unknown', content: response };
  } catch {
    return { action: 'analysis', content: response };
  }
}

function parseCritiqueResponse(response: string): CritiqueResult | null {
  try {
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const data = JSON.parse(jsonStr);

    const verdict = data.verdict;
    if (verdict !== 'approve' && verdict !== 'reject' && verdict !== 'reduce') {
      log.warn({ verdict }, 'Invalid critique verdict');
      return null;
    }

    return {
      verdict,
      score: Math.min(10, Math.max(1, data.score ?? 5)),
      flaws: Array.isArray(data.flaws) ? data.flaws : [],
      adjustments: data.adjustments,
      reasoning: data.reasoning ?? '',
    };
  } catch {
    log.warn({ response: response.slice(0, 200) }, 'Failed to parse critique response');
    return null;
  }
}

function parseManagePositionResponse(response: string, symbol: string): PositionManagementAction | null {
  try {
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const data = JSON.parse(jsonStr);
    const validActions = ['hold', 'trail_stop', 'partial_close', 'move_to_breakeven', 'close_now'];
    const action = validActions.includes(data.action) ? data.action : 'hold';

    return {
      symbol,
      action,
      newStopLoss: data.new_stop_loss ?? undefined,
      partialClosePct: data.partial_close_pct ?? undefined,
      reasoning: data.reasoning ?? '',
    };
  } catch {
    log.warn({ response: response.slice(0, 200) }, 'Failed to parse manage position response');
    return null;
  }
}

function parseReviewResponse(response: string): TradeReviewResult | null {
  try {
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const data = JSON.parse(jsonStr);

    return {
      outcome: data.outcome ?? 'breakeven',
      pnlPct: data.pnl_pct ?? 0,
      whatWorked: Array.isArray(data.what_worked) ? data.what_worked : [],
      whatFailed: Array.isArray(data.what_failed) ? data.what_failed : [],
      signalAccuracy: Array.isArray(data.signal_accuracy)
        ? data.signal_accuracy.map((s: { signal?: string; accurate?: boolean }) => ({
          signal: s.signal ?? '',
          accurate: s.accurate ?? false,
        }))
        : [],
      lesson: data.lesson ?? '',
      improvementSuggestion: data.improvement_suggestion ?? '',
    };
  } catch {
    log.warn({ response: response.slice(0, 200) }, 'Failed to parse review response');
    return null;
  }
}

function parseScenarioResponse(response: string): ScenarioAnalysis | null {
  try {
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const data = JSON.parse(jsonStr);

    const scenarios = Array.isArray(data.scenarios)
      ? data.scenarios.map((s: { name?: string; probability?: number; price_target?: number; position_outcome?: string; pnl_estimate?: number }) => ({
        name: s.name ?? 'Unknown',
        probability: s.probability ?? 33,
        priceTarget: s.price_target ?? 0,
        positionOutcome: s.position_outcome ?? '',
        pnlEstimate: s.pnl_estimate ?? 0,
      }))
      : [];

    return {
      scenarios,
      worstCaseAcceptable: data.worst_case_acceptable ?? true,
      overallAssessment: data.overall_assessment ?? '',
    };
  } catch {
    log.warn({ response: response.slice(0, 200) }, 'Failed to parse scenario response');
    return null;
  }
}
