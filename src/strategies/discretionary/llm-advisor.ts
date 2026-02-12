import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/index.js';
import { createChildLogger } from '../../monitoring/logger.js';
import type { MarketSnapshot, TradeProposal, OrderSide, ActiveDiscretionaryPosition, TriggerScore, MarketRegime, MarketDirection, BrainDirectives } from '../../core/types.js';
import { randomUUID } from 'crypto';

const log = createChildLogger('llm-advisor');

/** Response from comprehensive analysis (30-min Brain cycle) */
export interface ComprehensiveResponse {
  regime: MarketRegime;
  direction: MarketDirection;
  riskLevel: number;
  confidence: number;
  reasoning: string;
  directives?: Partial<BrainDirectives>;
}

const SYSTEM_PROMPT = `You are the core decision engine of an automated crypto perpetual futures trading bot on Hyperliquid.

## Context
- Capital: ~$600 allocated to this strategy (60% of $1,000 total portfolio)
- Target: 15-30% monthly return, max 20% drawdown
- Style: Aggressive on high-probability setups, patient otherwise
- Frequency: 10-20 trades/month (quality over quantity)
- You are called ONLY when a code-based scoring system detects unusual market activity
  (score >= 8/33 from 13 technical indicators). Your job is to validate whether the
  detected signal is a real opportunity or noise.

## Your Role
1. Evaluate the trigger signals provided — are they converging into a real setup?
2. Consider market structure: trend, S/R levels, volume confirmation, funding bias
3. If a genuine opportunity exists, propose a specific trade with exact levels
4. If the signal is noise or timing is wrong, clearly say "no_trade" with reasoning
5. Be decisive. Vague "maybe" answers waste API calls. Either propose or reject.

## Scoring System (for reference)
You are called when the bot's code-based scorer detects anomalies:
- Price: 1h move >2.5%, 4h move >5%
- Momentum: RSI <25 or >75, EMA(9/21) crossover
- Volatility: ATR spike >1.5x avg, Bollinger Band breakout
- Volume: 1h volume >3x 24h average
- Structure: Near S/R levels, OI rapid change >5%, extreme funding
- Cross: BTC 3%+ move with alt lagging
The trigger score and individual flags are included in the prompt.

## Decision Framework
- Score 8-10: Standard analysis. Propose only if setup is clean.
- Score 11+: Urgent — indicators strongly aligned. Be more aggressive with sizing.
- Multi-signal alignment (same direction): Higher confidence warranted.
- Conflicting signals (mixed direction): Usually means no clear trade.

## Confidence Levels
- "high": 3+ same-direction signals, clear trend, volume confirms, R:R >= 2:1
  → Size: 15-25% of capital, Leverage: 4-5x
- "medium": 2 aligned signals, decent setup but some uncertainty
  → Size: 10-15% of capital, Leverage: 3x
- "low": Signal detected but setup is marginal, counter-trend, or unclear
  → Size: 5-10% of capital, Leverage: 2-3x

## Risk Rules (STRICT)
- Max leverage: 5x
- Stop loss: REQUIRED on every trade
  - High leverage (4-5x): SL within 2-3% of entry
  - Medium leverage (3x): SL within 3-5% of entry
  - Low leverage (2x): SL within 5-8% of entry
- Take profit: Minimum 1.5:1 R:R ratio, prefer 2:1+
- size_pct: Percentage of allocated capital (max 25% per trade)
- Never go all-in. Always preserve capital for the next opportunity.
- If funding rate is extreme (>0.05%/h), factor it into direction bias:
  Very positive funding → bias short. Very negative → bias long.

## Response Format
ALWAYS respond with valid JSON only. No markdown, no explanations outside JSON.

For a trade proposal:
{
  "action": "propose_trade",
  "symbol": "ETH-PERP",
  "side": "buy",
  "entry_price": 2500.00,
  "stop_loss": 2450.00,
  "take_profit": 2600.00,
  "size_pct": 15,
  "leverage": 3,
  "confidence": "high",
  "rationale": "RSI oversold (22) with EMA golden cross + volume surge 3.5x. Strong bounce setup at support $2480. R:R 2:1."
}

For no trade:
{
  "action": "no_trade",
  "rationale": "ATR spike detected but signals are mixed — RSI neutral, no clear S/R test, volume fading. Likely noise from a single large order."
}

For answering user questions:
{
  "action": "analysis",
  "content": "Your analysis text here"
}`;

export class LLMAdvisor {
  private client: Anthropic | null = null;
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private maxHistoryLength = 20;

  constructor() {
    if (config.anthropicApiKey) {
      this.client = new Anthropic({ apiKey: config.anthropicApiKey });
      log.info({ model: config.anthropicModel }, 'LLM advisor initialized');
    } else {
      log.warn('ANTHROPIC_API_KEY not set - LLM advisor disabled');
    }
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  private async chat(userMessage: string): Promise<string> {
    if (!this.client) throw new Error('LLM advisor not available');

    this.conversationHistory.push({ role: 'user', content: userMessage });

    // Trim history if too long
    if (this.conversationHistory.length > this.maxHistoryLength) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength);
    }

    try {
      const response = await this.client.messages.create({
        model: config.anthropicModel,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: this.conversationHistory,
      });

      const assistantMessage = response.content[0].type === 'text' ? response.content[0].text : '';
      this.conversationHistory.push({ role: 'assistant', content: assistantMessage });

      return assistantMessage;
    } catch (err) {
      log.error({ err }, 'LLM API call failed');
      throw err;
    }
  }

  async analyzeMarket(snapshots: MarketSnapshot[]): Promise<{ action: string; proposal?: TradeProposal; content?: string }> {
    const marketData = snapshots.map(s => ({
      symbol: s.symbol,
      price: s.price,
      change_1h: `${s.change1h.toFixed(2)}%`,
      change_4h: `${s.change4h.toFixed(2)}%`,
      change_24h: `${s.change24h.toFixed(2)}%`,
      rsi14: s.rsi14.toFixed(1),
      ema9: s.ema9.toFixed(2),
      ema21: s.ema21.toFixed(2),
      atr14: s.atr14.toFixed(2),
      support: s.support.toFixed(2),
      resistance: s.resistance.toFixed(2),
      funding_rate_pct_hr: (s.fundingRate * 100).toFixed(4),
      trend: s.trend,
      volume_24h_usd: s.volume24h.toFixed(0),
    }));

    const prompt = `Current market data:\n${JSON.stringify(marketData, null, 2)}\n\nAnalyze these markets and propose a trade if there's a good opportunity. If not, explain why.`;

    const response = await this.chat(prompt);
    return this.parseResponse(response);
  }

  async analyzeMarketWithTrigger(
    snapshots: MarketSnapshot[],
    triggerScore: TriggerScore,
    openPositions?: ActiveDiscretionaryPosition[],
  ): Promise<{ action: string; proposal?: TradeProposal; content?: string }> {
    const targetSnapshot = snapshots.find(s => s.symbol === triggerScore.symbol);
    if (!targetSnapshot) {
      return { action: 'no_trade', content: `No snapshot data for ${triggerScore.symbol}` };
    }

    const marketData = snapshots.map(s => ({
      symbol: s.symbol,
      price: s.price,
      change_1h: `${s.change1h.toFixed(2)}%`,
      change_4h: `${s.change4h.toFixed(2)}%`,
      change_24h: `${s.change24h.toFixed(2)}%`,
      rsi14: s.rsi14.toFixed(1),
      ema9: s.ema9.toFixed(2),
      ema21: s.ema21.toFixed(2),
      atr14: s.atr14.toFixed(2),
      support: s.support.toFixed(2),
      resistance: s.resistance.toFixed(2),
      funding_rate_pct_hr: (s.fundingRate * 100).toFixed(4),
      trend: s.trend,
      volume_24h_usd: s.volume24h.toFixed(0),
      ...(s.bollingerUpper !== undefined && { bb_upper: s.bollingerUpper.toFixed(2) }),
      ...(s.bollingerLower !== undefined && { bb_lower: s.bollingerLower.toFixed(2) }),
      ...(s.bollingerWidth !== undefined && { bb_width_pct: `${s.bollingerWidth.toFixed(2)}%` }),
      ...(s.volumeRatio !== undefined && { volume_ratio: `${s.volumeRatio.toFixed(2)}x` }),
      ...(s.oiChange1h !== undefined && { oi_change_1h: `${s.oiChange1h.toFixed(2)}%` }),
      ...(s.atrAvg20 !== undefined && { atr_vs_avg: `${(s.atr14 / s.atrAvg20).toFixed(2)}x` }),
    }));

    const triggerSummary = {
      symbol: triggerScore.symbol,
      total_score: triggerScore.totalScore,
      direction_bias: triggerScore.directionBias,
      bonus: triggerScore.bonusScore,
      triggers: triggerScore.flags.map(f => ({
        name: f.name,
        category: f.category,
        score: f.score,
        direction: f.direction,
        detail: f.detail,
      })),
    };

    // Build position context
    let positionContext = 'No open positions.';
    if (openPositions && openPositions.length > 0) {
      const posData = openPositions.map(p => {
        const snap = snapshots.find(s => s.symbol === p.symbol);
        const currentPrice = snap?.price ?? 0;
        const unrealizedPnl = (currentPrice - p.entryPrice) * p.size * (p.side === 'buy' ? 1 : -1);
        return {
          symbol: p.symbol,
          side: p.side,
          entry: p.entryPrice,
          current_price: currentPrice,
          unrealized_pnl: `$${unrealizedPnl.toFixed(2)}`,
          sl: p.stopLoss,
          tp: p.takeProfit,
          held_minutes: Math.floor((Date.now() - p.openedAt) / 60_000),
        };
      });
      positionContext = JSON.stringify(posData, null, 2);
    }

    const urgencyLabel = triggerScore.totalScore >= 11 ? 'URGENT' : 'STANDARD';

    const prompt = [
      `[TRIGGER ${urgencyLabel}] Score: ${triggerScore.totalScore}/33 | ${triggerScore.symbol} | Bias: ${triggerScore.directionBias.toUpperCase()}`,
      '',
      `=== TRIGGER SIGNALS ===`,
      JSON.stringify(triggerSummary, null, 2),
      '',
      `=== MARKET DATA (all tracked symbols) ===`,
      JSON.stringify(marketData, null, 2),
      '',
      `=== OPEN POSITIONS ===`,
      positionContext,
      '',
      `=== TASK ===`,
      `The scoring system detected ${urgencyLabel.toLowerCase()} market activity for ${triggerScore.symbol}.`,
      `${triggerScore.flags.length} indicators fired with direction bias: ${triggerScore.directionBias.toUpperCase()}.`,
      `Decide: Is this a genuine trading opportunity or noise? Respond with JSON only.`,
    ].join('\n');

    const response = await this.chat(prompt);
    return this.parseResponse(response);
  }

  async evaluateIdea(idea: string, snapshots: MarketSnapshot[]): Promise<{ action: string; proposal?: TradeProposal; content?: string }> {
    const relevantData = snapshots.map(s => ({
      symbol: s.symbol,
      price: s.price,
      change_1h: `${s.change1h.toFixed(2)}%`,
      change_24h: `${s.change24h.toFixed(2)}%`,
      rsi14: s.rsi14.toFixed(1),
      ema9: s.ema9.toFixed(2),
      ema21: s.ema21.toFixed(2),
      trend: s.trend,
      support: s.support.toFixed(2),
      resistance: s.resistance.toFixed(2),
    }));

    const prompt = `User trade idea: "${idea}"\n\nCurrent market data:\n${JSON.stringify(relevantData, null, 2)}\n\nEvaluate this idea. If it's viable, propose specific entry/SL/TP. If not, explain why.`;

    const response = await this.chat(prompt);
    return this.parseResponse(response);
  }

  async analyzePositions(positions: ActiveDiscretionaryPosition[], snapshots: MarketSnapshot[]): Promise<string> {
    if (positions.length === 0) return 'No open discretionary positions.';

    const posData = positions.map(p => {
      const snapshot = snapshots.find(s => s.symbol === p.symbol);
      const currentPrice = snapshot?.price ?? 0;
      const pnlPct = ((currentPrice - p.entryPrice) / p.entryPrice) * 100 * (p.side === 'buy' ? 1 : -1);
      return {
        symbol: p.symbol,
        side: p.side,
        entry: p.entryPrice,
        current: currentPrice,
        pnl_pct: `${pnlPct.toFixed(2)}%`,
        stop_loss: p.stopLoss,
        take_profit: p.takeProfit,
      };
    });

    const prompt = `Current open positions:\n${JSON.stringify(posData, null, 2)}\n\nAnalyze these positions. Should any be closed, have SL/TP adjusted, or held? Provide analysis as text.`;

    const response = await this.chat(prompt);
    const parsed = this.parseResponse(response);
    return parsed.content ?? response;
  }

  async askQuestion(question: string, context?: MarketSnapshot[]): Promise<string> {
    let prompt = `User question: "${question}"`;
    if (context && context.length > 0) {
      const briefData = context.map(s => ({
        symbol: s.symbol,
        price: s.price,
        trend: s.trend,
        rsi14: s.rsi14.toFixed(1),
        change_24h: `${s.change24h.toFixed(2)}%`,
      }));
      prompt += `\n\nCurrent market context:\n${JSON.stringify(briefData, null, 2)}`;
    }
    prompt += '\n\nProvide a helpful analysis or answer.';

    const response = await this.chat(prompt);
    const parsed = this.parseResponse(response);
    return parsed.content ?? response;
  }

  private parseResponse(response: string): { action: string; proposal?: TradeProposal; content?: string } {
    try {
      // Try to extract JSON from the response (might have markdown code blocks)
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      const data = JSON.parse(jsonStr);

      if (data.action === 'propose_trade') {
        const proposal: TradeProposal = {
          id: randomUUID(),
          symbol: data.symbol,
          side: data.side as OrderSide,
          entryPrice: data.entry_price,
          size: data.size_pct / 100, // convert to decimal
          stopLoss: data.stop_loss,
          takeProfit: data.take_profit,
          leverage: data.leverage ?? 3,
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
      // If JSON parsing fails, treat as plain text analysis
      return { action: 'analysis', content: response };
    }
  }

  /**
   * Comprehensive market analysis for the Brain's 30-min cycle.
   * Uses a separate conversation (doesn't pollute trade history).
   */
  async comprehensiveAnalysis(context: string): Promise<ComprehensiveResponse | null> {
    if (!this.client) throw new Error('LLM advisor not available');

    const COMPREHENSIVE_SYSTEM_PROMPT = `You are the strategic brain of a crypto trading bot on Hyperliquid.

## Your Role
Every 30 minutes, you assess the overall market state and provide strategic directives.
You are NOT making individual trade decisions here — you are setting the CONTEXT for strategies.

## What You Assess
1. Market Regime: trending_up, trending_down, range, volatile, unknown
2. Direction: bullish, bearish, neutral
3. Risk Level: 1 (calm) to 5 (extreme danger)
4. Strategy Directives: how each strategy should adjust

## Portfolio: ~$1,000 total
- Discretionary (55%): LLM-guided, semi-auto
- Momentum (25%): EMA crossover, auto
- Cash (10%): reserves

## Response: JSON only, no markdown.
{
  "regime": "trending_up",
  "direction": "bullish",
  "risk_level": 2,
  "confidence": 75,
  "reasoning": "Brief explanation",
  "directives": {
    "discretionary": { "active": true, "bias": "long", "focus_symbols": ["ETH-PERP"], "max_leverage": 10 },
    "momentum": { "active": true, "leverage_multiplier": 1.2, "allow_long": true, "allow_short": false }
  }
}`;

    try {
      const response = await this.client.messages.create({
        model: config.anthropicModel,
        max_tokens: 512,
        system: COMPREHENSIVE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: context }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      return this.parseComprehensiveResponse(text);
    } catch (err) {
      log.error({ err }, 'Comprehensive LLM call failed');
      return null;
    }
  }

  private parseComprehensiveResponse(response: string): ComprehensiveResponse | null {
    try {
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1].trim();

      const data = JSON.parse(jsonStr);

      const result: ComprehensiveResponse = {
        regime: data.regime ?? 'unknown',
        direction: data.direction ?? 'neutral',
        riskLevel: Math.min(5, Math.max(1, data.risk_level ?? 3)),
        confidence: Math.min(100, Math.max(0, data.confidence ?? 50)),
        reasoning: data.reasoning ?? '',
      };

      if (data.directives) {
        result.directives = {};
        if (data.directives.discretionary) {
          const d = data.directives.discretionary;
          result.directives.discretionary = {
            active: d.active ?? true,
            bias: d.bias ?? 'neutral',
            focusSymbols: d.focus_symbols ?? [],
            maxLeverage: Math.min(20, d.max_leverage ?? 5),
          };
        }
        if (data.directives.momentum) {
          const m = data.directives.momentum;
          result.directives.momentum = {
            active: m.active ?? true,
            leverageMultiplier: Math.min(2, Math.max(0.2, m.leverage_multiplier ?? 1.0)),
            allowLong: m.allow_long ?? true,
            allowShort: m.allow_short ?? true,
          };
        }
      }

      return result;
    } catch {
      log.warn({ response: response.slice(0, 200) }, 'Failed to parse comprehensive response');
      return null;
    }
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }
}
