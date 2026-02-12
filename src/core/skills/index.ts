/**
 * SkillPipeline — Orchestrates code skills and LLM skills.
 *
 * Urgent flow:  4 code skills (parallel) → 1 LLM decideTrade
 * Comprehensive: code skills compress context → 1 LLM assessRegime
 */
import { assessContext, readSignals, checkExternal, assessRisk } from './code-skills.js';
import { decideTrade, assessRegime } from './llm-decide.js';
import { logSkillExecution } from '../../data/storage.js';
import { createChildLogger } from '../../monitoring/logger.js';
import { LLMAdvisor } from '../../strategies/discretionary/llm-advisor.js';
import type { ComprehensiveResponse } from '../../strategies/discretionary/llm-advisor.js';
import type {
  TriggerScore,
  MarketSnapshot,
  MarketState,
  InfoSignals,
  ActiveDiscretionaryPosition,
  TradeProposal,
} from '../types.js';
import type { DecisionContext } from './types.js';

const log = createChildLogger('skill-pipeline');

export class SkillPipeline {
  private advisor: LLMAdvisor;

  constructor(advisor: LLMAdvisor) {
    this.advisor = advisor;
  }

  /**
   * Run the urgent decision pipeline.
   * Phase 1: 4 code skills in parallel (<10ms)
   * Phase 2: Early exit if risk check fails
   * Phase 3: Single LLM decideTrade call
   */
  async runUrgentDecision(
    triggerScore: TriggerScore,
    snapshots: MarketSnapshot[],
    brainState: MarketState,
    infoSignals: InfoSignals | null,
    positions: ActiveDiscretionaryPosition[],
    balance: number,
    consecutiveLosses: number = 0,
  ): Promise<{ action: string; proposal?: TradeProposal; content?: string }> {
    const startMs = Date.now();

    // Phase 1: Code skills (parallel)
    const [contextResult, signalResult, externalResult, riskResult] = [
      assessContext(brainState),
      readSignals(triggerScore, infoSignals),
      checkExternal(infoSignals, triggerScore.symbol, triggerScore.directionBias),
      assessRisk(balance, positions, consecutiveLosses),
    ];

    const decisionCtx: DecisionContext = {
      context: contextResult,
      signal: signalResult,
      external: externalResult,
      risk: riskResult,
    };

    log.info({
      symbol: triggerScore.symbol,
      score: triggerScore.totalScore,
      context: contextResult.summary,
      signal: signalResult.summary,
      external: externalResult.summary,
      risk: riskResult.summary,
    }, 'Skill pipeline: code skills complete');

    // Phase 2: Early exit if risk check fails
    if (!riskResult.data.canTrade) {
      const content = `Risk check failed: ${riskResult.data.warnings.join(', ')}`;
      log.info({ symbol: triggerScore.symbol, reason: content }, 'Skill pipeline: early exit — risk');

      this.logExecution('urgent', triggerScore.symbol, decisionCtx, 'no_trade', 0, 0, Date.now() - startMs);
      return { action: 'no_trade', content };
    }

    // Phase 3: LLM decideTrade call
    const targetSnapshot = snapshots.find(s => s.symbol === triggerScore.symbol);
    const result = await decideTrade(this.advisor, decisionCtx, targetSnapshot);

    const durationMs = Date.now() - startMs;
    log.info({
      symbol: triggerScore.symbol,
      action: result.action,
      durationMs,
    }, 'Skill pipeline: decision complete');

    this.logExecution('urgent', triggerScore.symbol, decisionCtx, result.action, 0, 0, durationMs);

    return result;
  }

  /**
   * Run the comprehensive assessment pipeline.
   * Compresses all data via code skills → single LLM assessRegime call.
   */
  async runComprehensiveAssessment(
    snapshots: MarketSnapshot[],
    scores: TriggerScore[],
    brainState: MarketState,
    infoSignals: InfoSignals | null,
    positions: ActiveDiscretionaryPosition[],
    balance: number,
    consecutiveLosses: number = 0,
  ): Promise<ComprehensiveResponse | null> {
    const startMs = Date.now();

    // Build compressed context from code skills
    const contextResult = assessContext(brainState);
    const riskResult = assessRisk(balance, positions, consecutiveLosses);

    // Signal summaries for all notable symbols (score >= 3)
    const notableScores = scores.filter(s => s.totalScore >= 3);
    const signalSummaries = notableScores.map(s => {
      const sr = readSignals(s, infoSignals);
      return sr.summary;
    });

    // External summary (all symbols)
    const externalParts: string[] = [];
    const symbolSet = new Set(snapshots.map(s => s.symbol));
    for (const sym of symbolSet) {
      const ext = checkExternal(infoSignals, sym, 'neutral');
      if (ext.hasSignal) externalParts.push(`${sym}: ${ext.summary}`);
    }

    // Market data (compact format)
    const marketData = snapshots.map(s => ({
      symbol: s.symbol,
      price: s.price,
      change_1h: `${s.change1h.toFixed(2)}%`,
      change_4h: `${s.change4h.toFixed(2)}%`,
      change_24h: `${s.change24h.toFixed(2)}%`,
      rsi14: s.rsi14.toFixed(1),
      ema9: s.ema9.toFixed(2),
      ema21: s.ema21.toFixed(2),
      trend: s.trend,
      funding: `${(s.fundingRate * 100).toFixed(4)}%/h`,
      vol_ratio: s.volumeRatio !== undefined ? `${s.volumeRatio.toFixed(2)}x` : 'N/A',
    }));

    // Position summary
    const positionSummary = positions.length > 0
      ? positions.map(p => `${p.symbol} ${p.side} @${p.entryPrice} SL:${p.stopLoss} TP:${p.takeProfit}`).join('; ')
      : 'No open positions';

    const compressedContext = [
      `=== PREVIOUS STATE ===`,
      contextResult.summary,
      ``,
      `=== MARKET DATA ===`,
      JSON.stringify(marketData, null, 2),
      ``,
      `=== NOTABLE SIGNALS ===`,
      signalSummaries.length > 0 ? signalSummaries.join('\n') : 'No notable signals (all scores < 3)',
      ``,
      `=== EXTERNAL INTELLIGENCE ===`,
      externalParts.length > 0 ? externalParts.join('\n') : 'No external signals',
      ``,
      `=== RISK & POSITIONS ===`,
      riskResult.summary,
      positionSummary,
      ``,
      `=== TASK ===`,
      `Assess market regime, direction, and risk level.`,
      `Set strategy directives. Factor in external intelligence.`,
      `Respond with JSON only.`,
    ].join('\n');

    const response = await assessRegime(this.advisor, compressedContext, balance);

    const durationMs = Date.now() - startMs;
    log.info({ durationMs, regime: response?.regime }, 'Skill pipeline: comprehensive complete');

    return response;
  }

  private logExecution(
    pipelineType: string,
    symbol: string | null,
    ctx: DecisionContext,
    decision: string,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
  ): void {
    try {
      logSkillExecution(
        pipelineType,
        symbol,
        ctx.context.summary,
        ctx.signal.summary,
        ctx.external.summary,
        ctx.risk.summary,
        inputTokens,
        outputTokens,
        decision,
        durationMs,
      );
    } catch (e) {
      log.warn({ err: e }, 'Failed to log skill execution');
    }
  }
}

// Re-export skills for direct use
export { assessContext, readSignals, checkExternal, assessRisk } from './code-skills.js';
export { decideTrade, assessRegime } from './llm-decide.js';
export type { SkillResult, DecisionContext, ContextAssessment, SignalReading, ExternalIntelAssessment, RiskAssessment } from './types.js';
