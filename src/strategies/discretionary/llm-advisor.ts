import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/index.js';
import { createChildLogger } from '../../monitoring/logger.js';
import type { MarketSnapshot, TradeProposal, OrderSide, ActiveDiscretionaryPosition, TriggerScore } from '../../core/types.js';
import { randomUUID } from 'crypto';

const log = createChildLogger('llm-advisor');

const SYSTEM_PROMPT = `You are a crypto trading analyst assistant for a perpetual futures trading bot on Hyperliquid.

Your role:
- Analyze market data and identify trading opportunities
- Provide clear, concise trade proposals with rationale
- Focus on technical analysis: price action, trend, momentum, support/resistance, RSI, EMA crossovers
- Be conservative with position sizing and always recommend stop losses
- Consider risk/reward ratio (minimum 1.5:1)

When proposing a trade, respond ONLY with valid JSON in this format:
{
  "action": "propose_trade",
  "symbol": "ETH-PERP",
  "side": "buy" or "sell",
  "entry_price": 2500.00,
  "stop_loss": 2450.00,
  "take_profit": 2600.00,
  "size_pct": 10,
  "leverage": 3,
  "confidence": "low" | "medium" | "high",
  "rationale": "Brief explanation of the trade logic"
}

If no good opportunity exists, respond with:
{
  "action": "no_trade",
  "rationale": "Brief explanation of why there's no good setup"
}

When answering a user question, respond with:
{
  "action": "analysis",
  "content": "Your analysis text here"
}

Rules:
- Never recommend more than 5x leverage
- Stop loss must be within 5% of entry for high leverage, 10% for low leverage
- Take profit should give at least 1.5:1 risk/reward
- size_pct is percentage of allocated strategy capital (max 30%)
- Be honest about uncertainty. If the setup is unclear, say so
- Consider funding rate: if very positive, bias toward shorts; if negative, bias toward longs`;

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
      ...(s.volumeRatio !== undefined && { volume_ratio: `${s.volumeRatio.toFixed(2)}x` }),
      ...(s.oiChange1h !== undefined && { oi_change_1h: `${s.oiChange1h.toFixed(2)}%` }),
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

    const prompt = [
      `[TRIGGER ALERT] Score: ${triggerScore.totalScore} | ${triggerScore.symbol} | Bias: ${triggerScore.directionBias.toUpperCase()}`,
      '',
      `Triggered indicators:`,
      JSON.stringify(triggerSummary, null, 2),
      '',
      `Full market data:`,
      JSON.stringify(marketData, null, 2),
      '',
      `The scoring system detected unusual market activity for ${triggerScore.symbol}.`,
      `Direction bias from indicators: ${triggerScore.directionBias.toUpperCase()}.`,
      `Analyze whether this is a genuine trading opportunity. If yes, propose a trade. If not, explain why this is noise.`,
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

  clearHistory(): void {
    this.conversationHistory = [];
  }
}
