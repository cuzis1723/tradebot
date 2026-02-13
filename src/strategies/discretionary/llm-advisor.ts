import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/index.js';
import { createChildLogger } from '../../monitoring/logger.js';
import { TRADING_TOOLS, executeToolCall } from '../../core/trading-tools.js';
import type { MarketSnapshot, TradeProposal, OrderSide, ActiveDiscretionaryPosition, TriggerScore, MarketRegime, MarketDirection, BrainDirectives } from '../../core/types.js';
import { randomUUID } from 'crypto';
import { logLLMCall, updateLLMUsageDaily, getLLMUsageTotals, getLLMUsageToday } from '../../data/storage.js';
import { promptManager } from '../../core/prompt-manager.js';

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

// System prompts are now managed by PromptManager (src/core/prompt-manager.ts)
// Access via: promptManager.get('advisor_chat'), promptManager.get('advisor_skills'), etc.

/** Accumulated LLM usage stats */
export interface LLMUsageStats {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;     // rough estimate based on model pricing
  callsToday: number;
  tokensToday: number;
  dailyResetTime: number;
  lastCallAt: number;
  model: string;
}

// Approximate pricing per 1M tokens (Haiku 4.5)
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
};

export class LLMAdvisor {
  private client: Anthropic | null = null;
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private skillsHistory: Anthropic.MessageParam[] = [];
  private maxHistoryLength = 20;
  private maxSkillsHistoryLength = 10;

  // Token usage tracking
  private usage: LLMUsageStats;

  constructor() {
    this.usage = {
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      callsToday: 0,
      tokensToday: 0,
      dailyResetTime: this.getMidnightUTC(),
      lastCallAt: 0,
      model: config.anthropicModel,
    };

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

  private buildBalanceContext(balance?: number): string {
    if (!balance) return '';
    return `\n## Current Portfolio Balance\n- Total account value: $${balance.toFixed(2)}\n- Discretionary (55%): ~$${(balance * 0.55).toFixed(2)}\n- Available for new trades: Check positions below\n`;
  }

  async init(): Promise<void> {
    try {
      const totals = getLLMUsageTotals();
      const today = getLLMUsageToday();
      this.usage.totalCalls = totals.totalCalls;
      this.usage.totalInputTokens = totals.totalInputTokens;
      this.usage.totalOutputTokens = totals.totalOutputTokens;
      this.usage.totalTokens = totals.totalInputTokens + totals.totalOutputTokens;
      this.usage.estimatedCostUsd = totals.totalCostUsd;
      this.usage.callsToday = today.totalCalls;
      this.usage.tokensToday = today.totalInputTokens + today.totalOutputTokens;
      log.info({ totalCalls: totals.totalCalls, costUsd: totals.totalCostUsd.toFixed(3) }, 'LLM usage restored from DB');
    } catch (e) {
      log.warn({ err: e }, 'Failed to restore LLM usage from DB');
    }
  }

  /** Get current usage stats */
  getUsageStats(): Readonly<LLMUsageStats> {
    this.resetDailyIfNeeded();
    return { ...this.usage };
  }

  private trackUsage(inputTokens: number, outputTokens: number): void {
    this.resetDailyIfNeeded();
    this.usage.totalCalls++;
    this.usage.totalInputTokens += inputTokens;
    this.usage.totalOutputTokens += outputTokens;
    this.usage.totalTokens += inputTokens + outputTokens;
    this.usage.callsToday++;
    this.usage.tokensToday += inputTokens + outputTokens;
    this.usage.lastCallAt = Date.now();

    // Estimate cost
    const pricing = PRICING[config.anthropicModel] ?? PRICING['claude-haiku-4-5-20251001'];
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    this.usage.estimatedCostUsd += inputCost + outputCost;

    // Persist to database
    try {
      updateLLMUsageDaily(1, inputTokens, outputTokens, inputCost + outputCost);
    } catch (e) {
      log.warn({ err: e }, 'Failed to persist LLM usage stats');
    }
  }

  private resetDailyIfNeeded(): void {
    const now = Date.now();
    if (now > this.usage.dailyResetTime + 86_400_000) {
      this.usage.callsToday = 0;
      this.usage.tokensToday = 0;
      this.usage.dailyResetTime = this.getMidnightUTC();
    }
  }

  private getMidnightUTC(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
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
        system: promptManager.get('advisor_chat'),
        messages: this.conversationHistory,
      });

      // Track token usage
      if (response.usage) {
        this.trackUsage(response.usage.input_tokens, response.usage.output_tokens);
      }

      const assistantMessage = response.content[0].type === 'text' ? response.content[0].text : '';
      this.conversationHistory.push({ role: 'assistant', content: assistantMessage });

      try {
        logLLMCall('chat', userMessage, assistantMessage, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0, 0, config.anthropicModel);
      } catch (e) {
        log.warn({ err: e }, 'Failed to log LLM call');
      }

      return assistantMessage;
    } catch (err) {
      log.error({ err }, 'LLM API call failed');
      throw err;
    }
  }

  /**
   * Chat with tool use (skills) enabled.
   * The LLM can call Hyperliquid functions directly (check balance, trade, transfer, etc.)
   * Runs a tool-use loop: LLM → tool_call → execute → result → LLM → ... → final text.
   */
  async chatWithTools(userMessage: string, systemOverride?: string, options?: { blockedTools?: string[] }): Promise<string> {
    if (!this.client) throw new Error('LLM advisor not available');

    // Carry over previous skills conversation for context continuity
    this.skillsHistory.push({ role: 'user', content: userMessage });

    // Trim history if too long (keep recent exchanges)
    while (this.skillsHistory.length > this.maxSkillsHistoryLength * 2) {
      this.skillsHistory.shift();
    }

    // Use a working copy that includes history
    const messages: Anthropic.MessageParam[] = [...this.skillsHistory];

    // CRIT-8: Filter out blocked tools
    const blockedSet = new Set(options?.blockedTools ?? []);
    const allowedTools = blockedSet.size > 0
      ? TRADING_TOOLS.filter(t => !blockedSet.has(t.name))
      : TRADING_TOOLS;

    const maxRounds = 10; // prevent infinite loops
    let finalText = '';

    for (let round = 0; round < maxRounds; round++) {
      const response = await this.client.messages.create({
        model: config.anthropicModel,
        max_tokens: 2048,
        system: systemOverride ?? promptManager.get('advisor_skills'),
        tools: allowedTools,
        messages,
      });

      // Track usage
      if (response.usage) {
        this.trackUsage(response.usage.input_tokens, response.usage.output_tokens);
      }

      // Collect text blocks and tool_use blocks
      const textBlocks: string[] = [];
      const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textBlocks.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          });
        }
      }

      // If no tool calls, we're done
      if (toolUseBlocks.length === 0) {
        finalText = textBlocks.join('\n');
        break;
      }

      // Add assistant message with tool_use blocks
      messages.push({ role: 'assistant', content: response.content });

      // Execute each tool call and build tool_result messages
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolCall of toolUseBlocks) {
        log.info({ tool: toolCall.name, input: toolCall.input }, 'LLM executing skill');
        const result = await executeToolCall(toolCall.name, toolCall.input);
        log.info({ tool: toolCall.name, resultLen: result.length }, 'Skill executed');

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: result,
        });
      }

      messages.push({ role: 'user', content: toolResults });

      // If stop_reason is 'end_turn', break even with tool calls
      if (response.stop_reason === 'end_turn' && textBlocks.length > 0) {
        finalText = textBlocks.join('\n');
        break;
      }
    }

    // Save the final assistant response to skills history for continuity
    if (finalText) {
      this.skillsHistory.push({ role: 'assistant', content: finalText });
    }

    return finalText || '(No response from LLM)';
  }

  /** Clear skills conversation history */
  clearSkillsHistory(): void {
    this.skillsHistory = [];
  }

  // CRIT-8: Dangerous tools that /do should not have access to
  // These can cause significant financial damage if misused
  static readonly BLOCKED_DO_TOOLS = [
    'close_all_positions',
    'cancel_all_orders',
  ];

  /**
   * Execute a user command with trading skills enabled.
   * CRIT-8: Blocks dangerous tools (close_all_positions, cancel_all_orders).
   * Use this from Telegram /do command.
   */
  async executeWithSkills(
    command: string,
    context?: { snapshots?: MarketSnapshot[]; additionalInfo?: string },
  ): Promise<string> {
    let prompt = `User command: "${command}"`;

    if (context?.snapshots && context.snapshots.length > 0) {
      const brief = context.snapshots.map(s => ({
        symbol: s.symbol,
        price: s.price,
        trend: s.trend,
        rsi14: s.rsi14.toFixed(1),
        change_1h: `${s.change1h.toFixed(2)}%`,
        change_24h: `${s.change24h.toFixed(2)}%`,
      }));
      prompt += `\n\nCurrent market context:\n${JSON.stringify(brief, null, 2)}`;
    }

    if (context?.additionalInfo) {
      prompt += `\n\n${context.additionalInfo}`;
    }

    prompt += '\n\nUse the available tools to fulfill this request. Explain what you did.';

    return await this.chatWithTools(prompt, undefined, {
      blockedTools: LLMAdvisor.BLOCKED_DO_TOOLS,
    });
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
    infoContext?: string,
    balance?: number,
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

    const promptParts = [
      `[TRIGGER ${urgencyLabel}] Score: ${triggerScore.totalScore}/33 | ${triggerScore.symbol} | Bias: ${triggerScore.directionBias.toUpperCase()}`,
      '',
      `=== TRIGGER SIGNALS ===`,
      JSON.stringify(triggerSummary, null, 2),
      '',
      `=== MARKET DATA (all tracked symbols) ===`,
      JSON.stringify(marketData, null, 2),
      '',
    ];

    // Add balance context if available
    if (balance !== undefined) {
      promptParts.splice(1, 0, this.buildBalanceContext(balance));
    }

    // Include external intelligence if available
    if (infoContext) {
      promptParts.push(`=== EXTERNAL INTELLIGENCE ===`, infoContext, '');
    }

    promptParts.push(
      `=== OPEN POSITIONS ===`,
      positionContext,
      '',
      `=== TASK ===`,
      `The scoring system detected ${urgencyLabel.toLowerCase()} market activity for ${triggerScore.symbol}.`,
      `${triggerScore.flags.length} indicators fired with direction bias: ${triggerScore.directionBias.toUpperCase()}.`,
      infoContext ? `Factor in EXTERNAL INTELLIGENCE when evaluating the opportunity.` : '',
      `Decide: Is this a genuine trading opportunity or noise? Respond with JSON only.`,
    );

    const prompt = promptParts.filter(Boolean).join('\n');

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
      // If JSON parsing fails, treat as plain text analysis
      return { action: 'analysis', content: response };
    }
  }

  /**
   * Comprehensive market analysis for the Brain's 30-min cycle.
   * Uses a separate conversation (doesn't pollute trade history).
   */
  async comprehensiveAnalysis(context: string, balance?: number): Promise<ComprehensiveResponse | null> {
    if (!this.client) throw new Error('LLM advisor not available');

    const contextWithBalance = balance !== undefined
      ? `${this.buildBalanceContext(balance)}\n${context}`
      : context;

    try {
      const response = await this.client.messages.create({
        model: config.anthropicModel,
        max_tokens: 1024,
        system: promptManager.get('advisor_comprehensive'),
        messages: [{ role: 'user', content: contextWithBalance }],
      });

      // Track token usage
      if (response.usage) {
        this.trackUsage(response.usage.input_tokens, response.usage.output_tokens);
      }

      const text = response.content[0].type === 'text' ? response.content[0].text : '';

      try {
        logLLMCall('comprehensive', contextWithBalance, text, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0, 0, config.anthropicModel);
      } catch (e) {
        log.warn({ err: e }, 'Failed to log LLM call');
      }

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
      // Attempt regex-based recovery for truncated JSON
      try {
        const regimeMatch = response.match(/"regime"\s*:\s*"([^"]+)"/);
        const directionMatch = response.match(/"direction"\s*:\s*"([^"]+)"/);
        const riskMatch = response.match(/"risk_level"\s*:\s*(\d+)/);
        const confidenceMatch = response.match(/"confidence"\s*:\s*(\d+)/);
        const reasoningMatch = response.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);

        if (regimeMatch && directionMatch) {
          log.warn('Recovered comprehensive response from truncated JSON via regex');
          return {
            regime: regimeMatch[1] as ComprehensiveResponse['regime'],
            direction: directionMatch[1] as ComprehensiveResponse['direction'],
            riskLevel: Math.min(5, Math.max(1, riskMatch ? parseInt(riskMatch[1]) : 3)),
            confidence: Math.min(100, Math.max(0, confidenceMatch ? parseInt(confidenceMatch[1]) : 50)),
            reasoning: reasoningMatch ? reasoningMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : 'Recovered from truncated response',
          };
        }
      } catch {
        // regex recovery also failed
      }
      log.warn({ response: response.slice(0, 200) }, 'Failed to parse comprehensive response');
      return null;
    }
  }

  /**
   * Call LLM with a custom system prompt (used by skill pipeline).
   * Does NOT use conversation history — each call is independent.
   * Returns raw text response.
   */
  async callWithSystemPrompt(
    systemPrompt: string,
    userMessage: string,
    logType: string = 'skill',
  ): Promise<string> {
    if (!this.client) throw new Error('LLM advisor not available');

    try {
      const response = await this.client.messages.create({
        model: config.anthropicModel,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      if (response.usage) {
        this.trackUsage(response.usage.input_tokens, response.usage.output_tokens);
      }

      const text = response.content[0].type === 'text' ? response.content[0].text : '';

      try {
        logLLMCall(logType, userMessage, text, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0, 0, config.anthropicModel);
      } catch (e) {
        log.warn({ err: e }, 'Failed to log LLM call');
      }

      return text;
    } catch (err) {
      log.error({ err }, 'callWithSystemPrompt failed');
      throw err;
    }
  }

  /**
   * Call LLM for comprehensive analysis with a custom system prompt (used by skill pipeline).
   * Returns parsed ComprehensiveResponse.
   */
  async callComprehensiveWithSystemPrompt(
    systemPrompt: string,
    context: string,
  ): Promise<ComprehensiveResponse | null> {
    if (!this.client) throw new Error('LLM advisor not available');

    try {
      const response = await this.client.messages.create({
        model: config.anthropicModel,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: context }],
      });

      if (response.usage) {
        this.trackUsage(response.usage.input_tokens, response.usage.output_tokens);
      }

      const text = response.content[0].type === 'text' ? response.content[0].text : '';

      try {
        logLLMCall('skill_comprehensive', context, text, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0, 0, config.anthropicModel);
      } catch (e) {
        log.warn({ err: e }, 'Failed to log LLM call');
      }

      return this.parseComprehensiveResponse(text);
    } catch (err) {
      log.error({ err }, 'callComprehensiveWithSystemPrompt failed');
      return null;
    }
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }
}
