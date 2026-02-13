/**
 * SkillPipeline — Orchestrates code skills and LLM skills.
 *
 * Urgent flow:  10 code skills (parallel) → 1 LLM decideTrade → critique → optional scenarios
 * Comprehensive: code skills compress context → 1 LLM assessRegime
 * Position management: per-position LLM managePosition calls
 * Post-trade: LLM reviewTrade call
 */
import {
  assessContext,
  readSignals,
  checkExternal,
  assessRisk,
  checkLiquidity,
  assessPortfolioCorrelation,
  readOrderflow,
  assessTimeframeConfluence,
  injectLessons,
  trackNarrativeEvolution,
} from './code-skills.js';
import {
  decideTrade,
  assessRegime,
  critiqueTrade,
  applyCritique,
  assessRegimeTechnical,
  assessRegimeMacro,
  mergeRegimeAssessments,
  managePosition,
  reviewTrade,
  planScenarios,
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
import type { DecisionContext, PositionManagementAction, TradeReviewResult, ScenarioAnalysis } from './types.js';

const log = createChildLogger('skill-pipeline');

export class SkillPipeline {
  private advisor: LLMAdvisor;

  constructor(advisor: LLMAdvisor) {
    this.advisor = advisor;
  }

  /**
   * Run the urgent decision pipeline.
   * Phase 1: 10 code skills in parallel (<10ms for pure code, async for L2/fills)
   * Phase 2: Early exit if risk check fails
   * Phase 3: Single LLM decideTrade call (with enhanced context)
   * Phase 4: Optional scenario planning (high confidence trades only)
   * Phase 5: Critique (adversarial review)
   */
  async runUrgentDecision(
    triggerScore: TriggerScore,
    snapshots: MarketSnapshot[],
    brainState: MarketState,
    infoSignals: InfoSignals | null,
    positions: ActiveDiscretionaryPosition[],
    balance: number,
    consecutiveLosses: number = 0,
    l2Book?: { bids: Array<{ px: string; sz: string }>; asks: Array<{ px: string; sz: string }> } | null,
    recentFills?: Array<{ side: string; px: string; sz: string; time: number }> | null,
    candles4h?: Array<{ close: number; open: number }> | null,
    candles15m?: Array<{ close: number; open: number }> | null,
    mode: 'swing' | 'scalp' = 'swing',
  ): Promise<{ action: string; proposal?: TradeProposal; content?: string; scenarioAnalysis?: ScenarioAnalysis }> {
    const startMs = Date.now();
    const targetSnapshot = snapshots.find(s => s.symbol === triggerScore.symbol);

    // Phase 1: All code skills (parallel — synchronous ones are instant)
    const contextResult = assessContext(brainState);
    const signalResult = readSignals(triggerScore, infoSignals);
    const externalResult = checkExternal(infoSignals, triggerScore.symbol, triggerScore.directionBias);
    const riskResult = assessRisk(balance, positions, consecutiveLosses);

    // New enhanced code skills
    const capitalPct = mode === 'scalp' ? 0.20 : 0.55;
    const estimatedNotional = balance * capitalPct * 0.15 * (triggerScore.totalScore >= 11 ? 8 : 5); // rough estimate
    const liquidityResult = checkLiquidity(
      l2Book ?? null,
      triggerScore.symbol,
      estimatedNotional,
      triggerScore.directionBias === 'long' ? 'buy' : 'sell',
    );
    const correlationResult = assessPortfolioCorrelation(
      positions,
      triggerScore.symbol,
      triggerScore.directionBias === 'long' ? 'buy' : 'sell',
      triggerScore.totalScore >= 11 ? 8 : 5,
    );
    const orderflowResult = readOrderflow(
      recentFills ?? null,
      triggerScore.symbol,
      targetSnapshot?.price ?? 0,
    );
    const confluenceResult = assessTimeframeConfluence(
      targetSnapshot ?? null,
      candles4h ?? null,
      candles15m ?? null,
      triggerScore.symbol,
    );
    const lessonsResult = injectLessons(triggerScore.symbol, triggerScore.directionBias);
    const narrativeResult = trackNarrativeEvolution(infoSignals);

    const decisionCtx: DecisionContext = {
      context: contextResult,
      signal: signalResult,
      external: externalResult,
      risk: riskResult,
      liquidity: liquidityResult,
      portfolioCorrelation: correlationResult,
      orderflow: orderflowResult,
      timeframeConfluence: confluenceResult,
      lessons: lessonsResult,
      narrativeEvolution: narrativeResult,
    };

    log.info({
      symbol: triggerScore.symbol,
      score: triggerScore.totalScore,
      context: contextResult.summary,
      signal: signalResult.summary,
      external: externalResult.summary,
      risk: riskResult.summary,
      liquidity: liquidityResult.summary,
      correlation: correlationResult.summary,
      orderflow: orderflowResult.summary,
      confluence: confluenceResult.summary,
      lessons: lessonsResult.summary,
      narratives: narrativeResult.summary,
    }, 'Skill pipeline: all code skills complete');

    // Phase 2: Early exit if risk check fails
    if (!riskResult.data.canTrade) {
      const content = `Risk check failed: ${riskResult.data.warnings.join(', ')}`;
      log.info({ symbol: triggerScore.symbol, reason: content }, 'Skill pipeline: early exit — risk');
      this.logExecution('urgent', triggerScore.symbol, decisionCtx, 'no_trade', 0, 0, Date.now() - startMs);
      return { action: 'no_trade', content };
    }

    // Early exit: liquidity abort
    if (liquidityResult.data.sizeRecommendation === 'abort') {
      const content = `Liquidity check failed: ${liquidityResult.data.liquidityWarning}`;
      log.info({ symbol: triggerScore.symbol, reason: content }, 'Skill pipeline: early exit — liquidity');
      this.logExecution('urgent', triggerScore.symbol, decisionCtx, 'no_trade', 0, 0, Date.now() - startMs);
      return { action: 'no_trade', content };
    }

    // Early exit: correlation danger
    if (correlationResult.data.correlationWarning?.startsWith('DANGER')) {
      const content = `Portfolio correlation check failed: ${correlationResult.data.correlationWarning}`;
      log.info({ symbol: triggerScore.symbol, reason: content }, 'Skill pipeline: early exit — correlation');
      this.logExecution('urgent', triggerScore.symbol, decisionCtx, 'no_trade', 0, 0, Date.now() - startMs);
      return { action: 'no_trade', content };
    }

    // Phase 3: LLM decideTrade call (with enhanced context injected into prompt)
    const promptKey = mode === 'scalp' ? 'decide_scalp_trade' as const : 'decide_trade' as const;
    const result = await decideTrade(this.advisor, decisionCtx, targetSnapshot, promptKey);

    // Phase 4: Scenario planning (only for high confidence swing proposals, skip for scalp)
    let scenarioAnalysis: ScenarioAnalysis | null = null;
    if (mode !== 'scalp' && result.action === 'propose_trade' && result.proposal) {
      const isHighConviction = triggerScore.totalScore >= 11 ||
        result.proposal.confidence === 'high' ||
        (result.proposal.confidence as string) === 'highest';

      if (isHighConviction) {
        log.info({ symbol: triggerScore.symbol }, 'Skill pipeline: running scenario analysis on high-conviction trade');
        scenarioAnalysis = await planScenarios(this.advisor, result.proposal, decisionCtx, targetSnapshot);

        if (scenarioAnalysis && !scenarioAnalysis.worstCaseAcceptable) {
          log.info({ symbol: triggerScore.symbol, assessment: scenarioAnalysis.overallAssessment }, 'Scenario analysis: worst case unacceptable');
          // Don't abort, but reduce leverage
          result.proposal.leverage = Math.max(3, Math.floor(result.proposal.leverage * 0.6));
          result.proposal.size = Math.min(result.proposal.size, 0.10);
        }
      }
    }

    // Phase 5: Critique (only if trade proposed)
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
        return { ...finalResult, scenarioAnalysis: scenarioAnalysis ?? undefined };
      }
      log.warn({ symbol: triggerScore.symbol }, 'Critique call failed, using original proposal');
    }

    const durationMs = Date.now() - startMs;
    log.info({
      symbol: triggerScore.symbol,
      action: result.action,
      durationMs,
    }, 'Skill pipeline: decision complete');

    this.logExecution('urgent', triggerScore.symbol, decisionCtx, result.action, 0, 0, durationMs);

    return { ...result, scenarioAnalysis: scenarioAnalysis ?? undefined };
  }

  /**
   * Run the comprehensive assessment pipeline.
   * Compresses all data via code skills → single LLM assessRegime call.
   * Now includes narrative evolution tracking.
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

    // Track narrative evolution
    const narrativeResult = trackNarrativeEvolution(infoSignals);

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

    // Portfolio correlation summary
    const correlationResult = assessPortfolioCorrelation(positions);

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
        correlationResult.hasSignal ? `\n=== PORTFOLIO CORRELATION ===\n${correlationResult.summary}` : '',
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
        narrativeResult.hasSignal ? `=== NARRATIVE TRENDS ===\n${narrativeResult.summary}\n` : '',
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
      correlationResult.hasSignal ? `\n=== PORTFOLIO CORRELATION ===\n${correlationResult.summary}` : '',
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

  /**
   * Run position management for all open positions.
   * Called periodically (every 5-min scan) when positions exist.
   * Returns management actions for positions that need changes.
   */
  async runPositionManagement(
    positions: ActiveDiscretionaryPosition[],
    snapshots: MarketSnapshot[],
    regime: string,
    direction: string,
  ): Promise<PositionManagementAction[]> {
    if (positions.length === 0) return [];
    if (!this.advisor.isAvailable()) return [];

    const actions: PositionManagementAction[] = [];

    for (const pos of positions) {
      const snapshot = snapshots.find(s => s.symbol === pos.symbol);
      if (!snapshot) continue;

      // Quick code-level checks before LLM call
      const currentPrice = snapshot.price;
      const riskDistance = Math.abs(pos.entryPrice - pos.stopLoss);
      const unrealizedPnl = (currentPrice - pos.entryPrice) * pos.size * (pos.side === 'buy' ? 1 : -1);
      const currentR = riskDistance > 0 ? unrealizedPnl / (riskDistance * pos.size) : 0;

      // Skip LLM call if position is comfortably within -0.5R to +0.5R (no action needed)
      if (Math.abs(currentR) < 0.5) continue;

      const action = await managePosition(this.advisor, pos, snapshot, regime, direction);
      if (action && action.action !== 'hold') {
        actions.push(action);
      }
    }

    if (actions.length > 0) {
      log.info({ count: actions.length, actions: actions.map(a => `${a.symbol}:${a.action}`) }, 'Position management actions');
    }

    return actions;
  }

  /**
   * Run post-trade review after a position is closed.
   * Analyzes what worked and what didn't, persists lessons to DB.
   */
  async runTradeReview(
    position: ActiveDiscretionaryPosition,
    closePrice: number,
    pnl: number,
    regime: string,
    entryContext?: string,
  ): Promise<TradeReviewResult | null> {
    if (!this.advisor.isAvailable()) return null;

    log.info({ symbol: position.symbol, pnl: pnl.toFixed(2) }, 'Running trade review');
    return await reviewTrade(this.advisor, position, closePrice, pnl, entryContext ?? null, regime);
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
export {
  assessContext, readSignals, checkExternal, assessRisk,
  checkLiquidity, assessPortfolioCorrelation, readOrderflow,
  assessTimeframeConfluence, injectLessons, trackNarrativeEvolution,
} from './code-skills.js';
export {
  decideTrade, assessRegime, critiqueTrade, applyCritique,
  assessRegimeTechnical, assessRegimeMacro, mergeRegimeAssessments,
  managePosition, reviewTrade, planScenarios, buildEnhancedPromptSections,
} from './llm-decide.js';
export type {
  SkillResult, DecisionContext, ContextAssessment, SignalReading,
  ExternalIntelAssessment, RiskAssessment, CritiqueResult,
  LiquidityAssessment, PortfolioCorrelationAssessment, OrderflowReading,
  TimeframeConfluence, LessonsContext, NarrativeEvolution,
  TradeReviewResult, PositionManagementAction, ScenarioAnalysis,
} from './types.js';
