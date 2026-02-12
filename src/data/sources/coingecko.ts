import { createChildLogger } from '../../monitoring/logger.js';
import type { TrendingCoin, InfoTriggerFlag } from '../../core/types.js';

const log = createChildLogger('coingecko');

const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';

// Map CoinGecko coin IDs to our perp symbols
const COIN_TO_SYMBOL: Record<string, string> = {
  bitcoin: 'BTC-PERP',
  ethereum: 'ETH-PERP',
  solana: 'SOL-PERP',
};

interface CoinGeckoTrending {
  coins: Array<{
    item: {
      id: string;
      coin_id: number;
      name: string;
      symbol: string;
      market_cap_rank: number;
      score: number;
      data?: {
        price_change_percentage_24h?: { usd?: number };
      };
    };
  }>;
}

interface CoinGeckoSimplePrice {
  [coinId: string]: {
    usd: number;
    usd_24h_change?: number;
    usd_24h_vol?: number;
    usd_market_cap?: number;
  };
}

export class CoinGeckoSource {
  private trendingCache: TrendingCoin[] = [];
  private lastTrendingFetch = 0;
  private readonly TRENDING_INTERVAL_MS = 15 * 60 * 1000; // 15 min
  private previousTrendingRanks: Map<string, number> = new Map();

  async fetchTrending(): Promise<TrendingCoin[]> {
    const now = Date.now();
    if (now - this.lastTrendingFetch < this.TRENDING_INTERVAL_MS && this.trendingCache.length > 0) {
      return this.trendingCache;
    }

    try {
      const response = await fetch(`${COINGECKO_API_BASE}/search/trending`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        // CoinGecko rate limits aggressively on free tier
        if (response.status === 429) {
          log.debug('CoinGecko rate limited, using cache');
        } else {
          log.warn({ status: response.status }, 'CoinGecko API error');
        }
        return this.trendingCache;
      }

      const data: CoinGeckoTrending = await response.json() as CoinGeckoTrending;
      const results: TrendingCoin[] = [];

      for (const coin of data.coins ?? []) {
        const item = coin.item;
        const relevantSymbol = COIN_TO_SYMBOL[item.id];
        const priceChange = item.data?.price_change_percentage_24h?.usd ?? 0;

        results.push({
          id: item.id,
          symbol: item.symbol.toUpperCase(),
          name: item.name,
          marketCapRank: item.market_cap_rank ?? 999,
          priceChange24h: priceChange,
          score: item.score,
          relevantSymbol,
        });
      }

      this.trendingCache = results;
      this.lastTrendingFetch = now;
      log.info({ count: results.length }, 'CoinGecko trending data fetched');
      return results;
    } catch (err) {
      log.warn({ err }, 'CoinGecko fetch failed, using cache');
      return this.trendingCache;
    }
  }

  /** Fetch price data for our tracked coins */
  async fetchTrackedPrices(): Promise<CoinGeckoSimplePrice> {
    try {
      const ids = Object.keys(COIN_TO_SYMBOL).join(',');
      const response = await fetch(
        `${COINGECKO_API_BASE}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`,
        {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!response.ok) return {};

      return await response.json() as CoinGeckoSimplePrice;
    } catch (err) {
      log.debug({ err }, 'CoinGecko price fetch failed');
      return {};
    }
  }

  /** Generate trigger flags from trending data */
  generateTriggerFlags(trending: TrendingCoin[]): InfoTriggerFlag[] {
    const flags: InfoTriggerFlag[] = [];

    // Check if our tracked symbols appeared in trending
    for (const coin of trending) {
      if (!coin.relevantSymbol) continue;

      // Our tracked coin is trending → retail attention signal
      const prevRank = this.previousTrendingRanks.get(coin.id);
      const isNewlyTrending = prevRank === undefined;

      if (isNewlyTrending || coin.score <= 2) {
        // Newly appeared or top-ranked in trending
        flags.push({
          source: 'coingecko',
          name: 'trending_coin',
          score: 2,
          direction: coin.priceChange24h > 0 ? 'long' : coin.priceChange24h < -3 ? 'short' : 'neutral',
          relevantSymbol: coin.relevantSymbol,
          detail: `${coin.name} trending #${coin.score + 1} on CoinGecko (24h: ${coin.priceChange24h > 0 ? '+' : ''}${coin.priceChange24h.toFixed(1)}%)`,
        });
      }
    }

    // Update rank tracking
    this.previousTrendingRanks.clear();
    for (const coin of trending) {
      this.previousTrendingRanks.set(coin.id, coin.score);
    }

    // Check if many top coins are trending in same direction → market sentiment
    const trackedTrending = trending.filter(c => c.relevantSymbol);
    if (trackedTrending.length >= 2) {
      const allBullish = trackedTrending.every(c => c.priceChange24h > 3);
      const allBearish = trackedTrending.every(c => c.priceChange24h < -3);

      if (allBullish || allBearish) {
        flags.push({
          source: 'coingecko',
          name: 'trending_consensus',
          score: 2,
          direction: allBullish ? 'long' : 'short',
          relevantSymbol: 'BTC-PERP', // Broad market signal
          detail: `${trackedTrending.length} tracked coins trending ${allBullish ? 'bullish' : 'bearish'} (avg ${(trackedTrending.reduce((s, c) => s + c.priceChange24h, 0) / trackedTrending.length).toFixed(1)}%)`,
        });
      }
    }

    return flags;
  }

  formatTrending(trending: TrendingCoin[]): string {
    if (trending.length === 0) return 'No trending data available.';

    const lines = ['<b>CoinGecko Trending</b>'];
    for (const coin of trending.slice(0, 10)) {
      const relevantTag = coin.relevantSymbol ? ` [${coin.relevantSymbol}]` : '';
      lines.push(
        `  #${coin.score + 1} ${coin.symbol} (${coin.name})${relevantTag}: ${coin.priceChange24h > 0 ? '+' : ''}${coin.priceChange24h.toFixed(1)}%`,
      );
    }
    return lines.join('\n');
  }
}
