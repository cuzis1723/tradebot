/**
 * SkillPipeline — Orchestrates code skills and LLM skills.
 *
 * Urgent flow:  4 code skills (parallel) → 1 LLM decideTrade
 * Comprehensive: code skills compress context → 1 LLM assessRegime
 */
import { assessContext, readSignals, checkExternal, assessRisk } from './code-skills.js';
import {
  decideTrade,
  assessRegime,
  critiqueTrade,
  applyCritique,
  assessRegimeTechnical,
  assessRegimeMacro,
  mergeRegimeAssessments,
} from './llm-decide.js';
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

    // Phase 3: LLM decideTrade call (Proposer)
    const targetSnapshot = snapshots.find(s => s.symbol === triggerScore.symbol);
    const result = await decideTrade(this.advisor, decisionCtx, targetSnapshot);

    // Phase 4: Critique (only if trade proposed — no extra cost on no_trade)
    if (result.action === 'propose_trade' && result.proposal) {
      log.info({ symbol: triggerScore.symbol }, 'Skill pipeline: running critique on proposal');
      const critique = await critiqueTrade(this.advisor, decisionCtx, result.proposal, targetSnapshot);
      if (critique) {
        const finalResult = applyCritique(result.proposal, critique);

        const durationMs = Date.now() - startMs;
        log.info({
          symbol: triggerScore.symbol,
          action: finalResult.action,
          critiqueVerdict: critique.verdict,
          critiqueScore: critique.score,
          durationMs,
        }, 'Skill pipeline: decision complete (with critique)');

        this.logExecution('urgent', triggerScore.symbol, decisionCtx, finalResult.action, 0, 0, durationMs);
        return finalResult;
      }
      // Critique failed (null) — fall through with original proposal
      log.warn({ symbol: triggerScore.symbol }, 'Critique call failed, using original proposal');
    }

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

    const hasExternalSignals = externalParts.length > 0;

    // Dual perspective: when external signals exist, run TA and Macro in parallel
    if (hasExternalSignals) {
      const technicalContext = [
        `=== PREVIOUS STATE ===`,
        contextResult.summary,
        ``,
        `=== MARKET DATA ===`,
        JSON.stringify(marketData, null, 2),
        ``,
        `=== NOTABLE SIGNALS ===`,
        signalSummaries.length > 0 ? signalSummaries.join('\n') : 'No notable signals (all scores < 3)',
        ``,
        `=== RISK & POSITIONS ===`,
        riskResult.summary,
        positionSummary,
        ``,
        `=== TASK ===`,
        `Assess market regime using ONLY technical analysis.`,
        `Set strategy directives. Respond with JSON only.`,
      ].join('\n');

      const macroContext = [
        `=== PREVIOUS STATE ===`,
        contextResult.summary,
        ``,
        `=== EXTERNAL INTELLIGENCE ===`,
        externalParts.join('\n'),
        ``,
        `=== MARKET DATA (brief) ===`,
        JSON.stringify(marketData.map(s => ({ symbol: s.symbol, price: s.price, change_24h: s.change_24h, trend: s.trend })), null, 2),
        ``,
        `=== RISK & POSITIONS ===`,
        riskResult.summary,
        positionSummary,
        ``,
        `=== TASK ===`,
        `Assess market regime from external intelligence / macro perspective.`,
        `What are market participants betting on? What narratives are driving flows?`,
        `Set strategy directives. Respond with JSON only.`,
      ].join('\n');

      log.info('Skill pipeline: running dual regime assessment (TA + Macro)');
      const [technical, macro] = await Promise.all([
        assessRegimeTechnical(this.advisor, technicalContext, balance),
        assessRegimeMacro(this.advisor, macroContext, balance),
      ]);

      let response: ComprehensiveResponse | null;
      if (technical && macro) {
        response = mergeRegimeAssessments(technical, macro);
      } else {
        response = technical ?? macro;
      }

      const durationMs = Date.now() - startMs;
      log.info({ durationMs, regime: response?.regime, dual: true }, 'Skill pipeline: comprehensive complete');
      return response;
    }

    // Single perspective: no external signals, use standard assessRegime
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
      'No external signals',
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
    log.info({ durationMs, regime: response?.regime, dual: false }, 'Skill pipeline: comprehensive complete');

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
export { decideTrade, assessRegime, critiqueTrade, applyCritique, assessRegimeTechnical, assessRegimeMacro, mergeRegimeAssessments } from './llm-decide.js';
export type { SkillResult, DecisionContext, ContextAssessment, SignalReading, ExternalIntelAssessment, RiskAssessment, CritiqueResult } from './types.js';
