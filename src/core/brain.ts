import { EventEmitter } from 'events';
import { MarketAnalyzer } from '../strategies/discretionary/analyzer.js';
import { MarketScorer } from '../strategies/discretionary/scorer.js';
import { LLMAdvisor } from '../strategies/discretionary/llm-advisor.js';
import { InfoSourceAggregator } from '../data/sources/index.js';
import { SkillPipeline } from './skills/index.js';
import { createChildLogger } from '../monitoring/logger.js';
import { logBrainDecision, updateBrainDecisionTrade, logTradeProposal } from '../data/storage.js';
import type {
  MarketState,
  BrainConfig,
  ActiveDiscretionaryPosition,
} from './types.js';

const log = createChildLogger('brain');

const DEFAULT_MARKET_STATE: MarketState = {
  regime: 'unknown',
  direction: 'neutral',
  riskLevel: 3,
  confidence: 0,
  reasoning: 'Initializing...',
  directives: {
    discretionary: {
      active: true,
      bias: 'neutral',
      focusSymbols: [],
      maxLeverage: 5,
    },
    momentum: {
      active: true,
      leverageMultiplier: 1.0,
      allowLong: true,
      allowShort: true,
    },
  },
  latestSnapshots: [],
  latestScores: [],
  updatedAt: 0,
  lastComprehensiveAt: 0,
  lastUrgentScanAt: 0,
  comprehensiveCount: 0,
  urgentTriggerCount: 0,
};

/**
 * Brain: Central intelligence module that coordinates all strategies.
 *
 * - 30-min comprehensive loop: LLM assesses market regime + sets directives
 * - 5-min urgent scan: code-based scoring, LLM called only on score >= 8
 *
 * Events emitted:
 * - 'stateUpdate' (MarketState): When state changes after comprehensive analysis
 * - 'tradeProposal' (TradeProposal, MarketSnapshot): Urgent trigger produced a trade
 * - 'alert' (string): Score 5-7 alert, or informational message
 */
export class Brain extends EventEmitter {
  private config: BrainConfig;
  private analyzer: MarketAnalyzer;
  private scorer: MarketScorer;
  private advisor: LLMAdvisor;
  private infoSources: InfoSourceAggregator;
  private skillPipeline: SkillPipeline;
  private state: MarketState;

  private comprehensiveTimeout: ReturnType<typeof setTimeout> | null = null;
  private urgentInterval: ReturnType<typeof setInterval> | null = null;
  private dailyResetTime = 0;

  // Injected references for position context
  private getPositions: () => ActiveDiscretionaryPosition[] = () => [];
  private getBalance: () => Promise<number> = async () => 0;

  constructor(cfg: BrainConfig) {
    super();
    this.config = cfg;
    this.analyzer = new MarketAnalyzer();
    this.scorer = new MarketScorer(cfg.scorer);
    this.advisor = new LLMAdvisor();
    this.infoSources = new InfoSourceAggregator();
    this.skillPipeline = new SkillPipeline(this.advisor);
    this.state = { ...DEFAULT_MARKET_STATE };
    this.dailyResetTime = this.getMidnightUTC();
  }

  /** Wire up position accessor for LLM context */
  setPositionAccessor(fn: () => ActiveDiscretionaryPosition[]): void {
    this.getPositions = fn;
  }

  /** Wire up balance accessor for dynamic balance in LLM prompts */
  setBalanceAccessor(fn: () => Promise<number>): void {
    this.getBalance = fn;
  }

  /** Start both loops */
  async start(): Promise<void> {
    const dynMode = this.config.dynamicSymbols?.enabled ? 'dynamic' : 'static';
    log.info({
      coreSymbols: this.config.symbols,
      mode: dynMode,
      ...(this.config.dynamicSymbols?.enabled ? {
        maxSymbols: this.config.dynamicSymbols.maxSymbols,
        minVol: `$${(this.config.dynamicSymbols.minVolume24h / 1e6).toFixed(0)}M`,
        minOI: `$${(this.config.dynamicSymbols.minOpenInterest / 1e6).toFixed(0)}M`,
      } : {}),
      comprehensive: `${this.config.comprehensiveIntervalMs / 60_000}min`,
      urgent: `${this.config.urgentScanIntervalMs / 60_000}min`,
    }, 'Brain starting...');

    // Initialize LLM advisor
    await this.advisor.init();

    // 30-min comprehensive loop — aligned to clock :00/:30
    this.scheduleNextComprehensive();

    // 5-min urgent scan loop
    this.urgentInterval = setInterval(() => {
      this.runUrgentScan().catch(err => {
        log.error({ err }, 'Urgent scan error');
      });
    }, this.config.urgentScanIntervalMs);

    // Initial runs: urgent scan first (fast, no LLM), then comprehensive
    await this.runUrgentScan();
    await this.runComprehensiveAnalysis();

    log.info('Brain started');
  }

  /** Stop both loops */
  stop(): void {
    if (this.comprehensiveTimeout) {
      clearTimeout(this.comprehensiveTimeout);
      this.comprehensiveTimeout = null;
    }
    if (this.urgentInterval) {
      clearInterval(this.urgentInterval);
      this.urgentInterval = null;
    }
    log.info('Brain stopped');
  }

  /** Get current market state (read-only copy) */
  getState(): Readonly<MarketState> {
    return this.state;
  }

  /** Get analyzer for Telegram commands */
  getAnalyzer(): MarketAnalyzer {
    return this.analyzer;
  }

  /** Get scorer for Telegram commands */
  getScorer(): MarketScorer {
    return this.scorer;
  }

  /** Get advisor for Telegram commands */
  getAdvisor(): LLMAdvisor {
    return this.advisor;
  }

  /** Get info sources for Telegram commands */
  getInfoSources(): InfoSourceAggregator {
    return this.infoSources;
  }

  // ========== DYNAMIC SYMBOL RESOLUTION ==========

  /**
   * Resolve which symbols to fully analyze this cycle.
   * If dynamicSymbols is enabled: pre-screen ALL HL symbols via asset info (1 API call),
   * then only fully analyze (candles + indicators) symbols that pass the pre-screen.
   * Core symbols (BTC/ETH/SOL) always get full analysis.
   */
  private async resolveSymbols(): Promise<string[]> {
    const dynCfg = this.config.dynamicSymbols;
    if (!dynCfg?.enabled) {
      return this.config.symbols;
    }

    try {
      const { selected } = await this.analyzer.preScreenSymbols({
        minVolume24h: dynCfg.minVolume24h,
        minOpenInterest: dynCfg.minOpenInterest,
        maxSymbols: dynCfg.maxSymbols,
        coreSymbols: this.config.symbols,
        preScreenThreshold: dynCfg.preScreenThreshold,
      });
      return selected;
    } catch (err) {
      log.warn({ err }, 'Dynamic symbol discovery failed, falling back to core symbols');
      return this.config.symbols;
    }
  }

  // ========== 30-MIN COMPREHENSIVE ANALYSIS ==========

  /**
   * Schedule comprehensive analysis at the next clock :00 or :30.
   * Uses setTimeout → re-schedule pattern so it always aligns to wall-clock.
   */
  private scheduleNextComprehensive(): void {
    const now = Date.now();
    const msInHalfHour = 30 * 60_000;
    const msSinceEpochHalf = now % msInHalfHour;
    const delay = msInHalfHour - msSinceEpochHalf;

    const nextRun = new Date(now + delay);
    log.info({ nextRun: nextRun.toISOString(), delayMs: delay }, 'Comprehensive analysis scheduled');

    this.comprehensiveTimeout = setTimeout(() => {
      this.runComprehensiveAnalysis().catch(err => {
        log.error({ err }, 'Comprehensive analysis error');
      }).finally(() => {
        this.scheduleNextComprehensive();
      });
    }, delay);
  }

  async runComprehensiveAnalysis(): Promise<void> {
    const now = Date.now();
    this.resetDailyCountersIfNeeded(now);

    if (this.state.comprehensiveCount >= this.config.maxDailyComprehensive) {
      log.warn('Daily comprehensive limit reached');
      return;
    }

    log.info('Running comprehensive analysis...');

    // Step 0: Resolve symbols (dynamic pre-screen or static)
    const symbols = await this.resolveSymbols();

    // Step 1: Collect market data + info sources in parallel
    const [snapshots, infoSignals] = await Promise.all([
      this.analyzer.analyzeMultiple(symbols),
      this.infoSources.fetchAll().catch(err => {
        log.warn({ err }, 'Info sources fetch failed during comprehensive');
        return this.infoSources.getLastSignals();
      }),
    ]);

    if (snapshots.length === 0) {
      log.warn('No market data for comprehensive analysis');
      return;
    }

    this.state.latestSnapshots = snapshots;

    // Step 2: Run scoring with info source flags
    const infoFlags = infoSignals?.triggerFlags ?? [];
    this.state.latestScores = this.scorer.scoreAll(snapshots, infoFlags);

    // Step 3: Call LLM for regime assessment via skill pipeline
    if (!this.advisor.isAvailable()) {
      log.warn('LLM not available for comprehensive analysis');
      this.state.lastComprehensiveAt = now;
      return;
    }

    try {
      const balance = await this.getBalance();
      const positions = this.getPositions();
      const response = await this.skillPipeline.runComprehensiveAssessment(
        snapshots, this.state.latestScores, this.state, infoSignals, positions, balance,
        this.scorer.getConsecutiveLosses(),
      );

      if (response) {
        // Update market state from LLM response
        this.state.regime = response.regime ?? this.state.regime;
        this.state.direction = response.direction ?? this.state.direction;
        this.state.riskLevel = response.riskLevel ?? this.state.riskLevel;
        this.state.confidence = response.confidence ?? this.state.confidence;
        this.state.reasoning = response.reasoning ?? this.state.reasoning;

        if (response.directives) {
          if (response.directives.discretionary) {
            Object.assign(this.state.directives.discretionary, response.directives.discretionary);
          }
          if (response.directives.momentum) {
            Object.assign(this.state.directives.momentum, response.directives.momentum);
          }
        }

        this.state.updatedAt = now;
        this.state.lastComprehensiveAt = now;
        this.state.comprehensiveCount++;

        // Log decision to database
        try {
          const decisionId = logBrainDecision(
            'comprehensive',
            response.regime ?? null,
            response.direction ?? null,
            response.riskLevel ?? null,
            response.confidence ?? null,
            response.reasoning ?? null,
            response.directives ? JSON.stringify(response.directives) : null,
          );
          void decisionId; // stored in DB, no need to retain in memory
        } catch (e) {
          log.warn({ err: e }, 'Failed to log brain decision');
        }

        log.info({
          regime: this.state.regime,
          direction: this.state.direction,
          riskLevel: this.state.riskLevel,
          confidence: this.state.confidence,
        }, 'Comprehensive analysis complete');

        this.emit('stateUpdate', this.state);
        this.emit('alert', this.formatStateUpdate());
      }
    } catch (err) {
      log.error({ err }, 'Comprehensive LLM analysis failed');
    }
  }

  // ========== 5-MIN URGENT SCAN ==========

  async runUrgentScan(): Promise<void> {
    const now = Date.now();
    this.resetDailyCountersIfNeeded(now);

    log.debug('Running urgent scan...');

    // Step 0: Resolve symbols (dynamic pre-screen or static)
    const symbols = await this.resolveSymbols();

    // Step 1: Fetch market data + info sources in parallel
    const [snapshots, infoSignals] = await Promise.all([
      this.analyzer.analyzeMultiple(symbols),
      this.infoSources.fetchAll().catch(err => {
        log.debug({ err }, 'Info sources fetch failed during urgent scan');
        return this.infoSources.getLastSignals();
      }),
    ]);

    if (snapshots.length === 0) return;

    this.state.latestSnapshots = snapshots;
    this.state.lastUrgentScanAt = now;

    // Step 2: Score all symbols with info source flags
    const infoFlags = infoSignals?.triggerFlags ?? [];
    const scores = this.scorer.scoreAll(snapshots, infoFlags);
    this.state.latestScores = scores;

    // Step 3: Process each score
    for (const score of scores) {
      const action = this.scorer.getAction(score);

      if (action === 'ignore') continue;

      // Alert (5-7 points): info only
      if (action === 'alert') {
        log.info({ symbol: score.symbol, score: score.totalScore }, 'Score alert');
        this.emit('alert', this.scorer.formatScore(score));
        continue;
      }

      // LLM call (8+): check cooldowns, then call LLM
      if (action === 'llm_call' || action === 'llm_urgent') {
        if (this.state.urgentTriggerCount >= this.config.maxDailyUrgentLLM) {
          log.warn({ symbol: score.symbol }, 'Daily urgent LLM limit reached');
          this.emit('alert', `${this.scorer.formatScore(score)}\n⏳ Daily LLM limit reached`);
          continue;
        }

        const cooldownCheck = this.scorer.canCallLLM(score.symbol);
        if (!cooldownCheck.allowed) {
          log.info({ symbol: score.symbol, reason: cooldownCheck.reason }, 'LLM blocked by cooldown');
          this.emit('alert', `${this.scorer.formatScore(score)}\n⏳ ${cooldownCheck.reason}`);
          continue;
        }

        if (!this.advisor.isAvailable()) continue;

        // Trigger LLM for trade decision via skill pipeline
        log.info({ symbol: score.symbol, score: score.totalScore, action }, 'Urgent: triggering skill pipeline');
        this.scorer.recordLLMCall(score.symbol);
        this.state.urgentTriggerCount++;

        try {
          const positions = this.getPositions();
          const balance = await this.getBalance();
          const result = await this.skillPipeline.runUrgentDecision(
            score, snapshots, this.state, infoSignals, positions, balance,
            this.scorer.getConsecutiveLosses(),
          );

          if (result.action === 'propose_trade' && result.proposal) {
            const snapshot = snapshots.find(s => s.symbol === score.symbol);
            log.info({ proposal: result.proposal }, 'Urgent: trade proposal generated');

            // Log to database
            try {
              const decisionId = logBrainDecision(
                'urgent_trigger',
                this.state.regime,
                this.state.direction,
                this.state.riskLevel,
                this.state.confidence,
                `Urgent trigger for ${score.symbol} (score: ${score.totalScore})`,
                null,
                score.symbol,
                score.totalScore,
              );
              const proposalDbId = logTradeProposal(
                result.proposal.id,
                result.proposal.symbol,
                result.proposal.side,
                result.proposal.entryPrice,
                result.proposal.stopLoss ?? 0,
                result.proposal.takeProfit ?? 0,
                result.proposal.leverage ?? 3,
                result.proposal.confidence ?? 'medium',
                result.proposal.rationale ?? '',
                'pending',
                decisionId,
              );
              updateBrainDecisionTrade(decisionId, proposalDbId);
            } catch (e) {
              log.warn({ err: e }, 'Failed to log trade proposal');
            }

            this.emit('tradeProposal', result.proposal, snapshot);
          } else if (result.action === 'no_trade') {
            log.debug({ reason: result.content }, 'Urgent: LLM says no trade');

            // Log no_trade decision
            try {
              logBrainDecision(
                'urgent_trigger',
                this.state.regime,
                this.state.direction,
                this.state.riskLevel,
                this.state.confidence,
                result.content ?? 'No opportunity',
                null,
                score.symbol,
                score.totalScore,
              );
            } catch (e) {
              log.warn({ err: e }, 'Failed to log no_trade decision');
            }

            this.emit('alert', `${this.scorer.formatScore(score)}\nLLM: ${result.content ?? 'No opportunity'}`);
          }
        } catch (err) {
          log.error({ err }, 'Urgent LLM call failed');
        }
      }
    }
  }

  // ========== Helpers ==========

  private formatStateUpdate(): string {
    const regimeIcon: Record<string, string> = {
      trending_up: '📈',
      trending_down: '📉',
      range: '↔️',
      volatile: '⚡',
      unknown: '❓',
    };

    const riskBar = '🟢🟢🟢🟢🟢'.slice(0, this.state.riskLevel * 2)
      + '⚪⚪⚪⚪⚪'.slice(0, (5 - this.state.riskLevel) * 2);

    const lines = [
      `<b>🧠 Brain Update</b>`,
      ``,
      `${regimeIcon[this.state.regime] ?? '❓'} Regime: <b>${this.state.regime.toUpperCase()}</b>`,
      `Direction: <b>${this.state.direction.toUpperCase()}</b> (${this.state.confidence}% confidence)`,
      `Risk: ${riskBar} (${this.state.riskLevel}/5)`,
      ``,
      `<b>Directives:</b>`,
      `  Disc: bias=${this.state.directives.discretionary.bias}, maxLev=${this.state.directives.discretionary.maxLeverage}x`,
      `  Mom: levMul=${this.state.directives.momentum.leverageMultiplier}x, long=${this.state.directives.momentum.allowLong}, short=${this.state.directives.momentum.allowShort}`,
      ``,
      `<i>${this.state.reasoning}</i>`,
    ];

    return lines.join('\n');
  }

  /** Force a comprehensive analysis (for /brain command) */
  async forceComprehensive(): Promise<string> {
    await this.runComprehensiveAnalysis();
    return this.formatStateUpdate();
  }

  /** Force an urgent scan (for /score command) */
  async forceUrgentScan(): Promise<string> {
    await this.runUrgentScan();
    if (this.state.latestScores.length === 0) return 'No scores computed.';
    return this.state.latestScores.map(s => this.scorer.formatScore(s)).join('\n\n');
  }

  /** Get formatted state for /brain command */
  formatState(): string {
    if (this.state.updatedAt === 0) return 'Brain has not completed its first analysis yet.';
    return this.formatStateUpdate();
  }

  private resetDailyCountersIfNeeded(now: number): void {
    if (now > this.dailyResetTime + 86_400_000) {
      this.state.comprehensiveCount = 0;
      this.state.urgentTriggerCount = 0;
      this.dailyResetTime = this.getMidnightUTC();
    }
  }

  private getMidnightUTC(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
}
