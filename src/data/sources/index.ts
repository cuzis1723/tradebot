import { createChildLogger } from '../../monitoring/logger.js';
import { PolymarketSource } from './polymarket.js';
import { DefiLlamaSource } from './defillama.js';
import { CoinGeckoSource } from './coingecko.js';
import type { InfoSignals, InfoTriggerFlag } from '../../core/types.js';

const log = createChildLogger('info-sources');

/**
 * InfoSourceAggregator: Combines Polymarket, DefiLlama, and CoinGecko data
 * into a unified InfoSignals object for Brain's analysis loops.
 *
 * All APIs are read-only, no authentication required.
 * Fetches are cached internally per source to avoid rate limits.
 */
export class InfoSourceAggregator {
  private polymarket: PolymarketSource;
  private defillama: DefiLlamaSource;
  private coingecko: CoinGeckoSource;
  private lastSignals: InfoSignals | null = null;

  constructor() {
    this.polymarket = new PolymarketSource();
    this.defillama = new DefiLlamaSource();
    this.coingecko = new CoinGeckoSource();
  }

  /**
   * Fetch all info sources concurrently and aggregate into InfoSignals.
   * Each source handles its own caching/error recovery internally.
   */
  async fetchAll(): Promise<InfoSignals> {
    const [markets, tvl, trending] = await Promise.all([
      this.polymarket.fetchMarkets().catch(err => {
        log.warn({ err }, 'Polymarket source failed');
        return [];
      }),
      this.defillama.fetchTVL().catch(err => {
        log.warn({ err }, 'DefiLlama source failed');
        return [];
      }),
      this.coingecko.fetchTrending().catch(err => {
        log.warn({ err }, 'CoinGecko source failed');
        return [];
      }),
    ]);

    // Generate trigger flags from each source
    const polyFlags = this.polymarket.generateTriggerFlags(markets);
    const tvlFlags = this.defillama.generateTriggerFlags(tvl);
    const trendFlags = this.coingecko.generateTriggerFlags(trending);

    const triggerFlags: InfoTriggerFlag[] = [...polyFlags, ...tvlFlags, ...trendFlags];

    const signals: InfoSignals = {
      polymarket: markets,
      tvl,
      trending,
      timestamp: Date.now(),
      triggerFlags,
    };

    this.lastSignals = signals;

    if (triggerFlags.length > 0) {
      log.info({
        polyFlags: polyFlags.length,
        tvlFlags: tvlFlags.length,
        trendFlags: trendFlags.length,
      }, 'Info source trigger flags generated');
    }

    return signals;
  }

  /** Get last fetched signals without re-fetching */
  getLastSignals(): InfoSignals | null {
    return this.lastSignals;
  }

  /** Get trigger flags relevant to a specific symbol */
  getFlagsForSymbol(symbol: string): InfoTriggerFlag[] {
    if (!this.lastSignals) return [];
    return this.lastSignals.triggerFlags.filter(f => f.relevantSymbol === symbol);
  }

  /** Format all sources for Telegram / LLM display */
  formatAll(): string {
    if (!this.lastSignals) return 'No info source data available yet.';

    const sections: string[] = [];

    sections.push(this.polymarket.formatMarkets(this.lastSignals.polymarket));
    sections.push(this.defillama.formatTVL(this.lastSignals.tvl));
    sections.push(this.coingecko.formatTrending(this.lastSignals.trending));

    if (this.lastSignals.triggerFlags.length > 0) {
      const flagLines = ['<b>Info Trigger Flags</b>'];
      for (const f of this.lastSignals.triggerFlags) {
        const dirIcon = f.direction === 'long' ? '📈' : f.direction === 'short' ? '📉' : '➡️';
        flagLines.push(`  ${dirIcon} [${f.source}] ${f.relevantSymbol}: ${f.detail} (+${f.score}pts)`);
      }
      sections.push(flagLines.join('\n'));
    }

    return sections.join('\n\n');
  }

  /** Build context string for LLM comprehensive analysis */
  buildLLMContext(): string {
    if (!this.lastSignals) return 'No external data sources available.';

    const parts: string[] = [];

    // Polymarket context
    if (this.lastSignals.polymarket.length > 0) {
      const pmData = this.lastSignals.polymarket.map(m => ({
        question: m.question,
        probability: `${(m.probability * 100).toFixed(0)}%`,
        delta: m.prevProbability !== undefined
          ? `${((m.probability - m.prevProbability) * 100).toFixed(1)}% shift`
          : 'first reading',
        volume_24h: `$${(m.volume24h / 1000).toFixed(0)}k`,
        category: m.category,
        relevant_symbols: m.relevantSymbols.join(', '),
      }));
      parts.push(`=== PREDICTION MARKETS (Polymarket) ===\n${JSON.stringify(pmData, null, 2)}`);
    }

    // DeFi TVL context
    if (this.lastSignals.tvl.length > 0) {
      const tvlData = this.lastSignals.tvl.map(d => ({
        chain: d.chain,
        tvl: `$${(d.tvl / 1e9).toFixed(2)}B`,
        change_24h: `${d.tvlChange24h > 0 ? '+' : ''}${d.tvlChange24h.toFixed(1)}%`,
        change_7d: d.tvlChange7d !== 0 ? `${d.tvlChange7d > 0 ? '+' : ''}${d.tvlChange7d.toFixed(1)}%` : 'N/A',
      }));
      parts.push(`=== DEFI TVL (DefiLlama) ===\n${JSON.stringify(tvlData, null, 2)}`);
    }

    // Trending context
    if (this.lastSignals.trending.length > 0) {
      const trendData = this.lastSignals.trending.slice(0, 10).map(c => ({
        rank: c.score + 1,
        symbol: c.symbol,
        name: c.name,
        price_24h: `${c.priceChange24h > 0 ? '+' : ''}${c.priceChange24h.toFixed(1)}%`,
        tracked: c.relevantSymbol ? `YES (${c.relevantSymbol})` : 'NO',
      }));
      parts.push(`=== TRENDING COINS (CoinGecko) ===\n${JSON.stringify(trendData, null, 2)}`);
    }

    // Info trigger flags summary
    if (this.lastSignals.triggerFlags.length > 0) {
      const flagSummary = this.lastSignals.triggerFlags.map(f => ({
        source: f.source,
        symbol: f.relevantSymbol,
        direction: f.direction,
        score: f.score,
        detail: f.detail,
      }));
      parts.push(`=== INFO SOURCE SIGNALS ===\n${JSON.stringify(flagSummary, null, 2)}`);
    }

    return parts.join('\n\n');
  }
}
