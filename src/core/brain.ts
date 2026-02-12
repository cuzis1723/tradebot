import { EventEmitter } from 'events';
import { MarketAnalyzer } from '../strategies/discretionary/analyzer.js';
import { MarketScorer } from '../strategies/discretionary/scorer.js';
import { LLMAdvisor } from '../strategies/discretionary/llm-advisor.js';
import { InfoSourceAggregator } from '../data/sources/index.js';
import { createChildLogger } from '../monitoring/logger.js';
import type {
  MarketState,
  BrainConfig,
  MarketSnapshot,
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
  private state: MarketState;

  private comprehensiveInterval: ReturnType<typeof setInterval> | null = null;
  private urgentInterval: ReturnType<typeof setInterval> | null = null;
  private dailyResetTime = 0;

  // Injected references for position context
  private getPositions: () => ActiveDiscretionaryPosition[] = () => [];

  constructor(cfg: BrainConfig) {
    super();
    this.config = cfg;
    this.analyzer = new MarketAnalyzer();
    this.scorer = new MarketScorer(cfg.scorer);
    this.advisor = new LLMAdvisor();
    this.infoSources = new InfoSourceAggregator();
    this.state = { ...DEFAULT_MARKET_STATE };
    this.dailyResetTime = this.getMidnightUTC();
  }

  /** Wire up position accessor for LLM context */
  setPositionAccessor(fn: () => ActiveDiscretionaryPosition[]): void {
    this.getPositions = fn;
  }

  /** Start both loops */
  async start(): Promise<void> {
    log.info({
      symbols: this.config.symbols,
      comprehensive: `${this.config.comprehensiveIntervalMs / 60_000}min`,
      urgent: `${this.config.urgentScanIntervalMs / 60_000}min`,
    }, 'Brain starting...');

    // 30-min comprehensive loop
    this.comprehensiveInterval = setInterval(() => {
      this.runComprehensiveAnalysis().catch(err => {
        log.error({ err }, 'Comprehensive analysis error');
      });
    }, this.config.comprehensiveIntervalMs);

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
    if (this.comprehensiveInterval) {
      clearInterval(this.comprehensiveInterval);
      this.comprehensiveInterval = null;
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

  // ========== 30-MIN COMPREHENSIVE ANALYSIS ==========

  async runComprehensiveAnalysis(): Promise<void> {
    const now = Date.now();
    this.resetDailyCountersIfNeeded(now);

    if (this.state.comprehensiveCount >= this.config.maxDailyComprehensive) {
      log.warn('Daily comprehensive limit reached');
      return;
    }

    log.info('Running comprehensive analysis...');

    // Step 1: Collect market data + info sources in parallel
    const [snapshots, infoSignals] = await Promise.all([
      this.analyzer.analyzeMultiple(this.config.symbols),
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

    // Step 3: Call LLM for regime assessment
    if (!this.advisor.isAvailable()) {
      log.warn('LLM not available for comprehensive analysis');
      this.state.lastComprehensiveAt = now;
      return;
    }

    try {
      const context = this.buildComprehensiveContext(snapshots, infoSignals);
      const response = await this.advisor.comprehensiveAnalysis(context);

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

    // Step 1: Fetch market data + info sources in parallel
    const [snapshots, infoSignals] = await Promise.all([
      this.analyzer.analyzeMultiple(this.config.symbols),
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

        // Trigger LLM for trade decision
        log.info({ symbol: score.symbol, score: score.totalScore, action }, 'Urgent: triggering LLM');
        this.scorer.recordLLMCall(score.symbol);
        this.state.urgentTriggerCount++;

        try {
          const positions = this.getPositions();
          const infoContext = this.infoSources.buildLLMContext();
          const result = await this.advisor.analyzeMarketWithTrigger(
            snapshots,
            score,
            positions,
            infoContext !== 'No external data sources available.' ? infoContext : undefined,
          );

          if (result.action === 'propose_trade' && result.proposal) {
            const snapshot = snapshots.find(s => s.symbol === score.symbol);
            log.info({ proposal: result.proposal }, 'Urgent: trade proposal generated');
            this.emit('tradeProposal', result.proposal, snapshot);
          } else if (result.action === 'no_trade') {
            log.debug({ reason: result.content }, 'Urgent: LLM says no trade');
            this.emit('alert', `${this.scorer.formatScore(score)}\nLLM: ${result.content ?? 'No opportunity'}`);
          }
        } catch (err) {
          log.error({ err }, 'Urgent LLM call failed');
        }
      }
    }
  }

  // ========== Helpers ==========

  private buildComprehensiveContext(snapshots: MarketSnapshot[], infoSignals?: import('./types.js').InfoSignals | null): string {
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
      funding: `${(s.fundingRate * 100).toFixed(4)}%/h`,
      trend: s.trend,
      volume_24h: `$${(s.volume24h / 1_000_000).toFixed(1)}M`,
      ...(s.bollingerWidth !== undefined && { bb_width: `${s.bollingerWidth.toFixed(2)}%` }),
      ...(s.volumeRatio !== undefined && { vol_ratio: `${s.volumeRatio.toFixed(2)}x` }),
      ...(s.oiChange1h !== undefined && { oi_change: `${s.oiChange1h.toFixed(2)}%` }),
    }));

    // Score summary
    const scoreSummary = this.state.latestScores
      .filter(s => s.totalScore >= 3)
      .map(s => ({
        symbol: s.symbol,
        score: s.totalScore,
        bias: s.directionBias,
        flags: s.flags.map(f => f.name).join(', '),
      }));

    // Position summary
    const positions = this.getPositions();
    const positionSummary = positions.length > 0
      ? positions.map(p => ({
        symbol: p.symbol,
        side: p.side,
        entry: p.entryPrice,
        sl: p.stopLoss,
        tp: p.takeProfit,
        held_min: Math.floor((Date.now() - p.openedAt) / 60_000),
      }))
      : 'No open positions';

    // Previous state for continuity
    const prevState = {
      regime: this.state.regime,
      direction: this.state.direction,
      riskLevel: this.state.riskLevel,
      confidence: this.state.confidence,
    };

    // Info sources context
    const infoContext = infoSignals ? this.infoSources.buildLLMContext() : 'External data sources not available.';

    return [
      `=== COMPREHENSIVE MARKET ANALYSIS (every 30min) ===`,
      '',
      `=== PREVIOUS STATE ===`,
      JSON.stringify(prevState, null, 2),
      '',
      `=== MARKET DATA ===`,
      JSON.stringify(marketData, null, 2),
      '',
      `=== TRIGGER SCORES (notable) ===`,
      JSON.stringify(scoreSummary, null, 2),
      '',
      `=== EXTERNAL INTELLIGENCE ===`,
      infoContext,
      '',
      `=== OPEN POSITIONS ===`,
      typeof positionSummary === 'string' ? positionSummary : JSON.stringify(positionSummary, null, 2),
      '',
      `=== TASK ===`,
      `Assess the current market regime, direction, and risk level.`,
      `Provide strategic directives for each strategy.`,
      `Factor in EXTERNAL INTELLIGENCE: prediction market probabilities, DeFi TVL flows, and trending sentiment.`,
      `Consider: Are we trending? Ranging? Is volatility expanding?`,
      `Should strategies be aggressive or defensive?`,
      `Respond with JSON only.`,
    ].join('\n');
  }

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
