/**
 * LLM Skills — Focused LLM calls with pre-compressed context.
 *
 * decideTrade: Urgent trigger → single LLM call with code-skill summaries
 * assessRegime: 30-min comprehensive → market regime + directives
 */
import type { MarketSnapshot, TradeProposal, OrderSide } from '../types.js';
import type { ComprehensiveResponse } from '../../strategies/discretionary/llm-advisor.js';
import type { DecisionContext } from './types.js';
import { LLMAdvisor } from '../../strategies/discretionary/llm-advisor.js';
import { randomUUID } from 'crypto';
import { createChildLogger } from '../../monitoring/logger.js';

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
    `=== PRICE DATA (${targetSnapshot.symbol}) ===`,
    JSON.stringify(snapshotData, null, 2),
    ``,
    `DECIDE: Trade or no trade? JSON only.`,
  ].join('\n');

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
// Response Parsing
// ============================================================

function parseTradeResponse(response: string): { action: string; proposal?: TradeProposal; content?: string } {
  try {
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const data = JSON.parse(jsonStr);

    if (data.action === 'propose_trade') {
      const proposal: TradeProposal = {
        id: randomUUID(),
        symbol: data.symbol,
        side: data.side as OrderSide,
        entryPrice: data.entry_price,
        size: data.size_pct / 100,
        stopLoss: data.stop_loss,
        takeProfit: data.take_profit,
        leverage: Math.min(15, data.leverage ?? 3),
        rationale: data.rationale,
        confidence: data.confidence ?? 'medium',
        riskRewardRatio: Math.abs(data.take_profit - data.entry_price) / Math.abs(data.entry_price - data.stop_loss),
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
