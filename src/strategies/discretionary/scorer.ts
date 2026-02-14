import type { MarketSnapshot, TriggerFlag, TriggerScore, CooldownState, ScorerConfig, InfoTriggerFlag } from '../../core/types.js';

const DEFAULT_SCORER_CONFIG: ScorerConfig = {
  scanIntervalMs: 5 * 60 * 1000,       // 5 min
  llmThreshold: 8,
  alertThreshold: 5,
  symbolCooldownMs: 2 * 60 * 60 * 1000,  // 2h
  globalCooldownMs: 15 * 60 * 1000,       // 15min
  maxDailyCalls: 12,
  lossCooldownMs: 4 * 60 * 60 * 1000,    // 4h
  maxConsecutiveLosses: 2,
};

export class MarketScorer {
  private config: ScorerConfig;
  private cooldown: CooldownState;
  private previousSnapshots: Map<string, MarketSnapshot> = new Map();

  constructor(config?: Partial<ScorerConfig>) {
    this.config = { ...DEFAULT_SCORER_CONFIG, ...config };
    this.cooldown = {
      symbolCooldowns: new Map(),
      globalLastCall: 0,
      dailyCallCount: 0,
      dailyResetTime: this.getMidnightUTC(),
      consecutiveLosses: 0,
      lastLossTime: 0,
    };
  }

  // Score a single symbol based on its snapshot
  scoreSymbol(snapshot: MarketSnapshot, prevSnapshot?: MarketSnapshot, allSnapshots?: MarketSnapshot[]): TriggerScore {
    const flags: TriggerFlag[] = [];

    // --- PRICE CATEGORY ---

    // 1h price change > 2.5%
    if (Math.abs(snapshot.change1h) > 2.5) {
      flags.push({
        name: '1h_price_move',
        category: 'price',
        score: 3,
        direction: snapshot.change1h > 0 ? 'long' : 'short',
        detail: `1h change: ${snapshot.change1h.toFixed(2)}%`,
      });
    }

    // 4h price change > 5%
    if (Math.abs(snapshot.change4h) > 5) {
      flags.push({
        name: '4h_price_move',
        category: 'price',
        score: 3,
        direction: snapshot.change4h > 0 ? 'long' : 'short',
        detail: `4h change: ${snapshot.change4h.toFixed(2)}%`,
      });
    }

    // 15m candle spike > 2x ATR(14) — v3
    if (snapshot.candle15m?.isLarge) {
      flags.push({
        name: '15m_candle_spike',
        category: 'price_15m',
        score: 2,
        direction: snapshot.candle15m.direction,
        detail: `15m candle spike: size ${snapshot.candle15m.size.toFixed(2)} > 2x ATR(14) ${snapshot.candle15m.atr14.toFixed(2)} (${snapshot.candle15m.direction})`,
      });
    }

    // --- MOMENTUM CATEGORY ---

    // RSI extreme
    if (snapshot.rsi14 < 25) {
      flags.push({
        name: 'rsi_oversold',
        category: 'momentum',
        score: 3,
        direction: 'long',
        detail: `RSI(14): ${snapshot.rsi14.toFixed(1)} (oversold)`,
      });
    } else if (snapshot.rsi14 > 75) {
      flags.push({
        name: 'rsi_overbought',
        category: 'momentum',
        score: 3,
        direction: 'short',
        detail: `RSI(14): ${snapshot.rsi14.toFixed(1)} (overbought)`,
      });
    }

    // EMA crossover (check if recently crossed)
    const emaCrossed = this.detectEMACross(snapshot, prevSnapshot);
    if (emaCrossed) {
      flags.push({
        name: 'ema_crossover',
        category: 'momentum',
        score: 3,
        direction: emaCrossed,
        detail: `EMA(9/21) ${emaCrossed === 'long' ? 'golden' : 'death'} cross. EMA9=${snapshot.ema9.toFixed(2)}, EMA21=${snapshot.ema21.toFixed(2)}`,
      });
    }

    // --- VOLATILITY CATEGORY ---

    // ATR spike: current ATR > 1.5x 20-period average ATR
    if (snapshot.atrAvg20 !== undefined && snapshot.atrAvg20 > 0) {
      const atrRatio = snapshot.atr14 / snapshot.atrAvg20;
      if (atrRatio > 1.5) {
        flags.push({
          name: 'atr_spike',
          category: 'volatility',
          score: 2,
          direction: 'neutral',
          detail: `ATR spike: ${atrRatio.toFixed(2)}x avg (${snapshot.atr14.toFixed(2)} vs avg ${snapshot.atrAvg20.toFixed(2)})`,
        });
      }
    }

    // Bollinger Bands breakout: price outside 2σ bands
    if (snapshot.bollingerUpper !== undefined && snapshot.bollingerLower !== undefined) {
      if (snapshot.price > snapshot.bollingerUpper) {
        flags.push({
          name: 'bb_breakout_upper',
          category: 'volatility',
          score: 2,
          direction: 'long',
          detail: `BB upper breakout: price $${snapshot.price.toFixed(2)} > upper $${snapshot.bollingerUpper.toFixed(2)}`,
        });
      } else if (snapshot.price < snapshot.bollingerLower) {
        flags.push({
          name: 'bb_breakout_lower',
          category: 'volatility',
          score: 2,
          direction: 'short',
          detail: `BB lower breakout: price $${snapshot.price.toFixed(2)} < lower $${snapshot.bollingerLower.toFixed(2)}`,
        });
      }
    }

    // --- VOLUME CATEGORY ---

    // Volume surge: 1h volume > 3x 24h average
    if (snapshot.volumeRatio !== undefined && snapshot.volumeRatio > 3) {
      flags.push({
        name: 'volume_surge',
        category: 'volume',
        score: 3,
        direction: 'neutral',
        detail: `Volume surge: ${snapshot.volumeRatio.toFixed(2)}x avg hourly`,
      });
    }

    // --- STRUCTURE CATEGORY ---

    // OI rapid change > 5%
    if (snapshot.oiChange1h !== undefined && Math.abs(snapshot.oiChange1h) > 5) {
      flags.push({
        name: 'oi_rapid_change',
        category: 'structure',
        score: 2,
        direction: 'neutral',
        detail: `OI 1h change: ${snapshot.oiChange1h >= 0 ? '+' : ''}${snapshot.oiChange1h.toFixed(2)}%`,
      });
    }

    // Near support/resistance
    const distToSupport = ((snapshot.price - snapshot.support) / snapshot.price) * 100;
    const distToResistance = ((snapshot.resistance - snapshot.price) / snapshot.price) * 100;

    if (distToSupport < 0.5 && distToSupport >= 0) {
      flags.push({
        name: 'near_support',
        category: 'structure',
        score: 2,
        direction: 'long',
        detail: `Price near support ($${snapshot.support.toFixed(2)}), distance: ${distToSupport.toFixed(2)}%`,
      });
    }

    if (distToResistance < 0.5 && distToResistance >= 0) {
      flags.push({
        name: 'near_resistance',
        category: 'structure',
        score: 2,
        direction: 'short',
        detail: `Price near resistance ($${snapshot.resistance.toFixed(2)}), distance: ${distToResistance.toFixed(2)}%`,
      });
    }

    // Funding rate extreme
    if (Math.abs(snapshot.fundingRate) > 0.0005) { // 0.05%/h
      flags.push({
        name: 'extreme_funding',
        category: 'structure',
        score: 1,
        direction: snapshot.fundingRate > 0 ? 'short' : 'long',
        detail: `Funding: ${(snapshot.fundingRate * 100).toFixed(4)}%/h (extreme)`,
      });
    }

    // --- CROSS-SYMBOL CATEGORY ---

    // BTC 3%+ move while alt is lagging (only for non-BTC symbols)
    if (allSnapshots && !snapshot.symbol.startsWith('BTC')) {
      const btcSnapshot = allSnapshots.find(s => s.symbol.startsWith('BTC'));
      if (btcSnapshot && Math.abs(btcSnapshot.change1h) > 3) {
        // Alt is lagging if it moved less than half of BTC's move in the same direction
        const altFollowed = Math.sign(snapshot.change1h) === Math.sign(btcSnapshot.change1h)
          && Math.abs(snapshot.change1h) > Math.abs(btcSnapshot.change1h) * 0.5;
        if (!altFollowed) {
          flags.push({
            name: 'btc_alt_divergence',
            category: 'cross',
            score: 3,
            direction: btcSnapshot.change1h > 0 ? 'long' : 'short',
            detail: `BTC ${btcSnapshot.change1h >= 0 ? '+' : ''}${btcSnapshot.change1h.toFixed(2)}% but ${snapshot.symbol} only ${snapshot.change1h >= 0 ? '+' : ''}${snapshot.change1h.toFixed(2)}% (lagging)`,
          });
        }
      }
    }

    // --- Calculate direction bias ---
    let longScore = 0;
    let shortScore = 0;
    for (const f of flags) {
      if (f.direction === 'long') longScore += f.score;
      if (f.direction === 'short') shortScore += f.score;
    }

    let directionBias: 'long' | 'short' | 'neutral' = 'neutral';
    if (longScore > shortScore && longScore >= 3) directionBias = 'long';
    else if (shortScore > longScore && shortScore >= 3) directionBias = 'short';
    else if (longScore === shortScore && longScore >= 3) {
      // Tie-break: follow price action (4h > 1h momentum)
      if (snapshot.change4h > 1) directionBias = 'long';
      else if (snapshot.change4h < -1) directionBias = 'short';
    }

    // --- Bonus points ---
    let bonusScore = 0;

    // Same-direction signals 3+ → +2
    const directionFlags = flags.filter(f => f.direction === directionBias && directionBias !== 'neutral');
    if (directionFlags.length >= 3) bonusScore += 2;

    // --- Conflict penalty: mild deduction when signals contradict ---
    // Cap at -2 to avoid destroying valid signals (CRIT-5: was min(L,S) which could nuke total)
    const conflictPenalty = (longScore >= 3 && shortScore >= 3) ? 2 : 0;

    const totalScore = flags.reduce((sum, f) => sum + f.score, 0) + bonusScore - conflictPenalty;

    return {
      symbol: snapshot.symbol,
      totalScore,
      flags,
      directionBias,
      bonusScore,
      conflictPenalty,
      timestamp: Date.now(),
    };
  }

  // Score all symbols, return those above alertThreshold
  // infoFlags are merged into the relevant symbol's score
  scoreAll(snapshots: MarketSnapshot[], infoFlags?: InfoTriggerFlag[]): TriggerScore[] {
    const scores: TriggerScore[] = [];

    for (const snapshot of snapshots) {
      const prev = this.previousSnapshots.get(snapshot.symbol);
      const score = this.scoreSymbol(snapshot, prev, snapshots);

      // Merge info source flags for this symbol
      if (infoFlags && infoFlags.length > 0) {
        const symbolInfoFlags = infoFlags.filter(f => f.relevantSymbol === snapshot.symbol);
        for (const infoFlag of symbolInfoFlags) {
          score.flags.push({
            name: `info_${infoFlag.name}`,
            category: 'external',
            score: infoFlag.score,
            direction: infoFlag.direction,
            detail: `[${infoFlag.source}] ${infoFlag.detail}`,
          });
          score.totalScore += infoFlag.score;
        }

        // Recalculate direction bias after adding info flags
        let longScore = 0;
        let shortScore = 0;
        for (const f of score.flags) {
          if (f.direction === 'long') longScore += f.score;
          if (f.direction === 'short') shortScore += f.score;
        }
        if (longScore > shortScore && longScore >= 3) score.directionBias = 'long';
        else if (shortScore > longScore && shortScore >= 3) score.directionBias = 'short';
        else if (longScore === shortScore && longScore >= 3) {
          // Tie-break: follow price action
          if (snapshot.change4h > 1) score.directionBias = 'long';
          else if (snapshot.change4h < -1) score.directionBias = 'short';
          else score.directionBias = 'neutral';
        } else {
          score.directionBias = 'neutral';
        }
      }

      scores.push(score);

      // Update previous snapshot cache
      this.previousSnapshots.set(snapshot.symbol, snapshot);
    }

    // Sort by score descending
    return scores.sort((a, b) => b.totalScore - a.totalScore);
  }

  // Check if a symbol passes cooldown rules for LLM call
  // score param: if >= 11 (urgent), global cooldown is bypassed
  canCallLLM(symbol: string, score?: number): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const isUrgent = (score ?? 0) >= 11;

    // Reset daily counter if new day
    if (now > this.cooldown.dailyResetTime + 86_400_000) {
      this.cooldown.dailyCallCount = 0;
      this.cooldown.dailyResetTime = this.getMidnightUTC();
    }

    // Daily limit (never bypassed)
    if (this.cooldown.dailyCallCount >= this.config.maxDailyCalls) {
      return { allowed: false, reason: `Daily limit reached (${this.config.maxDailyCalls})` };
    }

    // Global cooldown — bypassed for urgent (11+) signals
    if (!isUrgent && now - this.cooldown.globalLastCall < this.config.globalCooldownMs) {
      const remaining = Math.ceil((this.config.globalCooldownMs - (now - this.cooldown.globalLastCall)) / 60_000);
      return { allowed: false, reason: `Global cooldown: ${remaining}min remaining` };
    }

    // Symbol cooldown (never bypassed — same symbol spam prevention)
    const symbolLast = this.cooldown.symbolCooldowns.get(symbol) ?? 0;
    if (now - symbolLast < this.config.symbolCooldownMs) {
      const remaining = Math.ceil((this.config.symbolCooldownMs - (now - symbolLast)) / 60_000);
      return { allowed: false, reason: `${symbol} cooldown: ${remaining}min remaining` };
    }

    // Consecutive loss cooldown (never bypassed)
    if (this.cooldown.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      if (now - this.cooldown.lastLossTime < this.config.lossCooldownMs) {
        const remaining = Math.ceil((this.config.lossCooldownMs - (now - this.cooldown.lastLossTime)) / 60_000);
        return { allowed: false, reason: `Loss cooldown: ${remaining}min remaining (${this.cooldown.consecutiveLosses} consecutive losses)` };
      } else {
        // Cooldown expired, reset
        this.cooldown.consecutiveLosses = 0;
      }
    }

    return { allowed: true };
  }

  // Record that an LLM call was made
  recordLLMCall(symbol: string): void {
    const now = Date.now();
    this.cooldown.globalLastCall = now;
    this.cooldown.symbolCooldowns.set(symbol, now);
    this.cooldown.dailyCallCount++;
  }

  // Get current consecutive loss count
  getConsecutiveLosses(): number {
    return this.cooldown.consecutiveLosses;
  }

  // Record trade result for loss tracking
  recordTradeResult(won: boolean): void {
    if (won) {
      this.cooldown.consecutiveLosses = 0;
    } else {
      this.cooldown.consecutiveLosses++;
      this.cooldown.lastLossTime = Date.now();
    }
  }

  // Determine action based on score
  getAction(score: TriggerScore): 'ignore' | 'alert' | 'llm_call' | 'llm_urgent' {
    if (score.totalScore >= 11) return 'llm_urgent';
    if (score.totalScore >= this.config.llmThreshold) return 'llm_call';
    if (score.totalScore >= this.config.alertThreshold) return 'alert';
    return 'ignore';
  }

  // Format score for Telegram notification
  formatScore(score: TriggerScore): string {
    const actionMap = {
      ignore: '⚪',
      alert: '🟡',
      llm_call: '🟠',
      llm_urgent: '🔴',
    };
    const action = this.getAction(score);
    const icon = actionMap[action];
    const dirIcon = score.directionBias === 'long' ? '📈' : score.directionBias === 'short' ? '📉' : '➡️';

    const lines = [
      `${icon} <b>${score.symbol}</b> | Score: ${score.totalScore}${score.bonusScore > 0 ? ` (+${score.bonusScore} bonus)` : ''}${score.conflictPenalty ? ` (-${score.conflictPenalty} conflict)` : ''} | ${dirIcon} ${score.directionBias.toUpperCase()}`,
    ];

    // Separate TA flags and external flags
    const taFlags = score.flags.filter(f => f.category !== 'external');
    const extFlags = score.flags.filter(f => f.category === 'external');

    // TA signals (show all)
    if (taFlags.length > 0) {
      lines.push(`<b>TA</b>`);
      for (const flag of taFlags) {
        lines.push(`  • ${flag.detail}`);
      }
    }

    // External signals (limit to top 3 by score, hide the rest)
    if (extFlags.length > 0) {
      const sorted = [...extFlags].sort((a, b) => b.score - a.score);
      const shown = sorted.slice(0, 3);
      const hidden = sorted.length - shown.length;
      lines.push(`<b>External</b>`);
      for (const flag of shown) {
        lines.push(`  • ${flag.detail}`);
      }
      if (hidden > 0) {
        lines.push(`  <i>...+${hidden} more</i>`);
      }
    }

    return lines.join('\n');
  }

  // Get cooldown status summary
  getCooldownStatus(): string {
    const now = Date.now();
    const lines = [
      `<b>Cooldown Status</b>`,
      `Daily calls: ${this.cooldown.dailyCallCount}/${this.config.maxDailyCalls}`,
    ];

    if (this.cooldown.globalLastCall > 0) {
      const elapsed = Math.floor((now - this.cooldown.globalLastCall) / 60_000);
      lines.push(`Last LLM call: ${elapsed}min ago`);
    }

    if (this.cooldown.consecutiveLosses > 0) {
      lines.push(`Consecutive losses: ${this.cooldown.consecutiveLosses}`);
    }

    return lines.join('\n');
  }

  private detectEMACross(current: MarketSnapshot, prev?: MarketSnapshot): 'long' | 'short' | null {
    if (!prev) return null;

    const prevAbove = prev.ema9 > prev.ema21;
    const currAbove = current.ema9 > current.ema21;

    if (!prevAbove && currAbove) return 'long';   // golden cross
    if (prevAbove && !currAbove) return 'short';   // death cross
    return null;
  }

  private getMidnightUTC(): number {
    const now = new Date();
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }

  getConfig(): ScorerConfig {
    return { ...this.config };
  }
}
