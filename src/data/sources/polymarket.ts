import { createChildLogger } from '../../monitoring/logger.js';
import type { PredictionMarket, InfoTriggerFlag } from '../../core/types.js';

const log = createChildLogger('polymarket');

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

// Crypto-related keywords to filter prediction markets
const CRYPTO_KEYWORDS = [
  'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol',
  'crypto', 'defi', 'etf', 'sec', 'regulation',
  'fed', 'interest rate', 'inflation', 'recession',
  'stablecoin', 'usdc', 'usdt', 'tether',
  'halving', 'merge', 'upgrade', 'fork',
  'binance', 'coinbase', 'exchange',
];

// Map prediction market topics to trading symbols
const BROAD_CRYPTO = ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'];
const SYMBOL_MAPPING: Record<string, string[]> = {
  bitcoin: ['BTC-PERP'],
  btc: ['BTC-PERP'],
  ethereum: ['ETH-PERP'],
  eth: ['ETH-PERP'],
  solana: ['SOL-PERP'],
  sol: ['SOL-PERP'],
  dogecoin: ['DOGE-PERP'],
  doge: ['DOGE-PERP'],
  chainlink: ['LINK-PERP'],
  link: ['LINK-PERP'],
  arbitrum: ['ARB-PERP'],
  arb: ['ARB-PERP'],
  optimism: ['OP-PERP'],
  uniswap: ['UNI-PERP'],
  aave: ['AAVE-PERP'],
  pepe: ['PEPE-PERP'],
  sui: ['SUI-PERP'],
  // AI/compute tokens
  ai: ['RENDER-PERP', 'FET-PERP'],
  nvidia: ['RENDER-PERP', 'FET-PERP'],
  // Broad crypto/macro → affects major caps
  crypto: BROAD_CRYPTO,
  defi: ['ETH-PERP', 'SOL-PERP', 'AAVE-PERP', 'UNI-PERP'],
  etf: ['BTC-PERP', 'ETH-PERP'],
  sec: BROAD_CRYPTO,
  regulation: BROAD_CRYPTO,
  fed: BROAD_CRYPTO,
  'interest rate': BROAD_CRYPTO,
  recession: BROAD_CRYPTO,
  stablecoin: BROAD_CRYPTO,
  'layer 2': ['ARB-PERP', 'OP-PERP', 'STRK-PERP'],
  l2: ['ARB-PERP', 'OP-PERP', 'STRK-PERP'],
};

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  active: boolean;
  closed: boolean;
  markets: GammaMarket[];
}

interface GammaMarket {
  id: string;
  question: string;
  outcomePrices: string;     // JSON string: "[\"0.65\",\"0.35\"]"
  volume24hr: number;
  liquidityNum: number;
  active: boolean;
  closed: boolean;
}

interface ProbabilityHistoryEntry {
  timestamp: number;
  probability: number;
}

export class PolymarketSource {
  private cache: PredictionMarket[] = [];
  private lastFetch = 0;
  private readonly FETCH_INTERVAL_MS = 10 * 60 * 1000; // 10 min cache
  private previousProbabilities: Map<string, number> = new Map();
  // 30-minute probability history for rapid_shift detection (v3)
  private probabilityHistory: Map<string, ProbabilityHistoryEntry[]> = new Map();

  async fetchMarkets(): Promise<PredictionMarket[]> {
    const now = Date.now();
    if (now - this.lastFetch < this.FETCH_INTERVAL_MS && this.cache.length > 0) {
      return this.cache;
    }

    try {
      const url = `${GAMMA_API_BASE}/events?active=true&closed=false&limit=50&order=volume24hr&ascending=false`;
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        log.warn({ status: response.status }, 'Polymarket API error');
        return this.cache;
      }

      const events: GammaEvent[] = await response.json() as GammaEvent[];
      const markets: PredictionMarket[] = [];

      for (const event of events) {
        if (!event.active || event.closed || !event.markets) continue;

        for (const market of event.markets) {
          if (!market.active || market.closed) continue;

          // Filter for crypto/macro relevant markets (word-boundary match to avoid "SOLV"→"sol" etc.)
          const titleLower = (event.title + ' ' + market.question).toLowerCase();
          const matchedKeyword = CRYPTO_KEYWORDS.find(kw => {
            const regex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
            return regex.test(titleLower);
          });
          if (!matchedKeyword) continue;

          // Parse outcome prices
          let probability = 0.5;
          try {
            const prices = JSON.parse(market.outcomePrices);
            if (Array.isArray(prices) && prices.length >= 1) {
              probability = parseFloat(prices[0]);
            }
          } catch {
            continue;
          }

          // Skip low-volume/low-liquidity markets
          if (market.volume24hr < 1000 || market.liquidityNum < 500) continue;

          const prevProb = this.previousProbabilities.get(market.id);
          const relevantSymbols = SYMBOL_MAPPING[matchedKeyword] ?? ['BTC-PERP'];

          markets.push({
            id: market.id,
            question: market.question,
            probability,
            prevProbability: prevProb,
            volume24h: market.volume24hr,
            liquidity: market.liquidityNum,
            category: this.categorize(titleLower),
            relevantSymbols,
            updatedAt: now,
          });

          // Store current probability for next delta calculation
          this.previousProbabilities.set(market.id, probability);

          // Track 30min probability history (v3: rapid_shift detection)
          const history = this.probabilityHistory.get(market.id) ?? [];
          history.push({ timestamp: now, probability });
          // Prune entries older than 35 min
          const cutoff = now - 35 * 60 * 1000;
          const pruned = history.filter(h => h.timestamp > cutoff);
          this.probabilityHistory.set(market.id, pruned);
        }
      }

      this.cache = markets;
      this.lastFetch = now;
      log.info({ count: markets.length }, 'Polymarket data fetched');
      return markets;
    } catch (err) {
      log.warn({ err }, 'Polymarket fetch failed, using cache');
      return this.cache;
    }
  }

  /** Generate trigger flags from prediction market data */
  generateTriggerFlags(markets: PredictionMarket[]): InfoTriggerFlag[] {
    const flags: InfoTriggerFlag[] = [];

    for (const market of markets) {
      // WARN-7: Don't skip first cycle entirely — still check extremes below
      const hasPrev = market.prevProbability !== undefined;
      const probDelta = hasPrev ? market.probability - market.prevProbability! : 0;
      const absDelta = Math.abs(probDelta);

      // Significant probability shift (>10% in one scan period) — requires prev data
      if (hasPrev && absDelta >= 0.10) {
        for (const symbol of market.relevantSymbols) {
          flags.push({
            source: 'polymarket',
            name: 'prediction_shift',
            score: absDelta >= 0.20 ? 4 : 3,
            direction: this.inferDirection(market, probDelta),
            relevantSymbol: symbol,
            detail: `Polymarket "${market.question.slice(0, 60)}": ${(market.prevProbability! * 100).toFixed(0)}% → ${(market.probability * 100).toFixed(0)}% (${probDelta > 0 ? '+' : ''}${(probDelta * 100).toFixed(1)}%)`,
          });
        }
      }

      // Rapid shift: >15%p change within 30 minutes (v3 — scorer +4)
      const history = this.probabilityHistory.get(market.id);
      if (history && history.length >= 2) {
        const oldest = history[0];
        const timeDiffMs = Date.now() - oldest.timestamp;
        if (timeDiffMs >= 5 * 60 * 1000) { // need at least 5min of data
          const rapidDelta = market.probability - oldest.probability;
          const absRapidDelta = Math.abs(rapidDelta);
          if (absRapidDelta >= 0.15) { // 15%p shift within 30min window
            for (const symbol of market.relevantSymbols) {
              flags.push({
                source: 'polymarket',
                name: 'rapid_shift',
                score: 4,
                direction: this.inferDirection(market, rapidDelta),
                relevantSymbol: symbol,
                detail: `Polymarket RAPID "${market.question.slice(0, 50)}": ${(oldest.probability * 100).toFixed(0)}% → ${(market.probability * 100).toFixed(0)}% in ${Math.round(timeDiffMs / 60_000)}min (${rapidDelta > 0 ? '+' : ''}${(rapidDelta * 100).toFixed(1)}%p)`,
              });
            }
          }
        }
      }

      // High-volume market with extreme probability (>90% or <10%)
      // Only flag when probability actually moved (>= 2% delta) — skip static extremes
      if (market.volume24h > 50_000 && (market.probability > 0.90 || market.probability < 0.10)) {
        const extremeDelta = market.prevProbability !== undefined
          ? Math.abs(market.probability - market.prevProbability)
          : 1; // First reading always flags
        if (extremeDelta >= 0.02) {
          for (const symbol of market.relevantSymbols) {
            flags.push({
              source: 'polymarket',
              name: 'prediction_extreme',
              score: 2,
              direction: this.inferDirection(market, market.probability > 0.5 ? 1 : -1),
              relevantSymbol: symbol,
              detail: `Polymarket extreme "${market.question.slice(0, 50)}": ${(market.probability * 100).toFixed(0)}% (${market.prevProbability !== undefined ? `${((market.probability - market.prevProbability) * 100).toFixed(1)}%p shift` : 'new'}, vol: $${(market.volume24h / 1000).toFixed(0)}k)`,
            });
          }
        }
      }
    }

    return flags;
  }

  private inferDirection(market: PredictionMarket, probSignal: number): 'long' | 'short' | 'neutral' {
    // Positive events (ETF approval, rate cut) → bullish
    // Negative events (regulation, recession) → bearish
    const q = market.question.toLowerCase();
    const bullishKeywords = ['approve', 'etf', 'cut', 'bullish', 'above', 'reach', 'hit', 'ath'];
    const bearishKeywords = ['ban', 'recession', 'crash', 'below', 'fall', 'reject', 'sue'];

    const isBullishEvent = bullishKeywords.some(kw => q.includes(kw));
    const isBearishEvent = bearishKeywords.some(kw => q.includes(kw));

    if (isBullishEvent) return probSignal > 0 ? 'long' : 'short';
    if (isBearishEvent) return probSignal > 0 ? 'short' : 'long';
    return 'neutral';
  }

  private categorize(text: string): string {
    if (text.includes('etf')) return 'ETF';
    if (text.includes('sec') || text.includes('regulation')) return 'Regulatory';
    if (text.includes('fed') || text.includes('rate') || text.includes('inflation')) return 'Macro';
    if (text.includes('upgrade') || text.includes('fork') || text.includes('halving')) return 'Protocol';
    return 'Crypto';
  }

  /** Format for display in Telegram / LLM context */
  formatMarkets(markets: PredictionMarket[]): string {
    if (markets.length === 0) return 'No crypto-related prediction markets found.';

    const lines = ['<b>Polymarket Signals</b>'];
    for (const m of markets.slice(0, 8)) {
      const delta = m.prevProbability !== undefined
        ? ` (${m.probability > m.prevProbability ? '+' : ''}${((m.probability - m.prevProbability) * 100).toFixed(1)}%)`
        : '';
      lines.push(
        `  ${(m.probability * 100).toFixed(0)}%${delta} | $${(m.volume24h / 1000).toFixed(0)}k vol`,
        `  "${m.question.slice(0, 70)}"`,
      );
    }
    return lines.join('\n');
  }
}
