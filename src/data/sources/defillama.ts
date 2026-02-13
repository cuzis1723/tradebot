import { createChildLogger } from '../../monitoring/logger.js';
import type { TVLData, InfoTriggerFlag } from '../../core/types.js';

const log = createChildLogger('defillama');

const LLAMA_API_BASE = 'https://api.llama.fi';

// Chains we care about for trading signals
const TRACKED_CHAINS: Record<string, string[]> = {
  Ethereum: ['ETH-PERP'],
  Solana: ['SOL-PERP'],
  Bitcoin: ['BTC-PERP'],
  Avalanche: ['AVAX-PERP'],
  Polygon: ['MATIC-PERP'],
  Arbitrum: ['ARB-PERP'],
  Optimism: ['OP-PERP'],
  Near: ['NEAR-PERP'],
  Aptos: ['APT-PERP'],
  Sui: ['SUI-PERP'],
  Injective: ['INJ-PERP'],
  Sei: ['SEI-PERP'],
  Celestia: ['TIA-PERP'],
  Starknet: ['STRK-PERP'],
};

interface LlamaChain {
  name: string;
  tvl: number;
  tokenSymbol?: string;
  gecko_id?: string;
}

interface LlamaHistoricalChain {
  date: string;
  totalLiquidityUSD: number;
}

export class DefiLlamaSource {
  private cache: TVLData[] = [];
  private lastFetch = 0;
  private readonly FETCH_INTERVAL_MS = 15 * 60 * 1000; // 15 min cache
  private previousTVL: Map<string, number> = new Map();

  async fetchTVL(): Promise<TVLData[]> {
    const now = Date.now();
    if (now - this.lastFetch < this.FETCH_INTERVAL_MS && this.cache.length > 0) {
      return this.cache;
    }

    try {
      // Fetch current chain TVLs
      const response = await fetch(`${LLAMA_API_BASE}/v2/chains`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        log.warn({ status: response.status }, 'DefiLlama API error');
        return this.cache;
      }

      const chains: LlamaChain[] = await response.json() as LlamaChain[];
      const results: TVLData[] = [];

      for (const chain of chains) {
        const symbols = TRACKED_CHAINS[chain.name];
        if (!symbols) continue;

        const prevTVL = this.previousTVL.get(chain.name);
        // WARN-9: This is inter-poll delta (~15min), not true 24h change
        // Rename internally but keep field name for type compat; threshold adjusted in generateTriggerFlags
        const tvlChange24h = prevTVL !== undefined && prevTVL > 0
          ? ((chain.tvl - prevTVL) / prevTVL) * 100
          : 0;

        results.push({
          chain: chain.name,
          tvl: chain.tvl,
          tvlChange24h,
          tvlChange7d: 0, // Would need historical endpoint for accurate 7d
          relevantSymbols: symbols,
        });

        this.previousTVL.set(chain.name, chain.tvl);
      }

      // Also fetch total DeFi TVL for overall market health
      try {
        const totalResp = await fetch(`${LLAMA_API_BASE}/v2/historicalChainTvl`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });

        if (totalResp.ok) {
          const history: LlamaHistoricalChain[] = await totalResp.json() as LlamaHistoricalChain[];
          if (history.length >= 2) {
            const current = history[history.length - 1];
            // Find entry ~24h ago (daily data points)
            const prev = history.length >= 2 ? history[history.length - 2] : current;
            const prev7d = history.length >= 8 ? history[history.length - 8] : current;

            const totalChange24h = prev.totalLiquidityUSD > 0
              ? ((current.totalLiquidityUSD - prev.totalLiquidityUSD) / prev.totalLiquidityUSD) * 100
              : 0;
            const totalChange7d = prev7d.totalLiquidityUSD > 0
              ? ((current.totalLiquidityUSD - prev7d.totalLiquidityUSD) / prev7d.totalLiquidityUSD) * 100
              : 0;

            results.push({
              chain: 'Total DeFi',
              tvl: current.totalLiquidityUSD,
              tvlChange24h: totalChange24h,
              tvlChange7d: totalChange7d,
              relevantSymbols: ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'],
            });
          }
        }
      } catch (err) {
        log.debug({ err }, 'Failed to fetch total DeFi TVL history');
      }

      this.cache = results;
      this.lastFetch = now;
      log.info({ chains: results.length }, 'DefiLlama TVL data fetched');
      return results;
    } catch (err) {
      log.warn({ err }, 'DefiLlama fetch failed, using cache');
      return this.cache;
    }
  }

  /** Generate trigger flags from TVL changes */
  generateTriggerFlags(tvlData: TVLData[]): InfoTriggerFlag[] {
    const flags: InfoTriggerFlag[] = [];

    for (const data of tvlData) {
      // "Total DeFi" uses real 24h from historical endpoint — use 10% threshold
      // Per-chain uses 15min inter-poll delta — use 3% threshold (WARN-9)
      const isHistorical = data.chain === 'Total DeFi';
      const dropThreshold = isHistorical ? -10 : -3;
      const surgeThreshold = isHistorical ? 10 : 3;
      const label = isHistorical ? '24h' : '~15m';

      // TVL drop → risk signal
      if (data.tvlChange24h < dropThreshold) {
        for (const symbol of data.relevantSymbols) {
          flags.push({
            source: 'defillama',
            name: 'tvl_drop',
            score: 2,
            direction: 'short',
            relevantSymbol: symbol,
            detail: `${data.chain} TVL drop: ${data.tvlChange24h.toFixed(1)}% ${label} ($${(data.tvl / 1e9).toFixed(1)}B)`,
          });
        }
      }

      // TVL surge → bullish signal
      if (data.tvlChange24h > surgeThreshold) {
        for (const symbol of data.relevantSymbols) {
          flags.push({
            source: 'defillama',
            name: 'tvl_surge',
            score: 2,
            direction: 'long',
            relevantSymbol: symbol,
            detail: `${data.chain} TVL surge: +${data.tvlChange24h.toFixed(1)}% ${label} ($${(data.tvl / 1e9).toFixed(1)}B)`,
          });
        }
      }

      // 7d trend (only from historical endpoint data)
      if (data.tvlChange7d !== 0 && Math.abs(data.tvlChange7d) > 10) {
        for (const symbol of data.relevantSymbols) {
          flags.push({
            source: 'defillama',
            name: 'tvl_7d_trend',
            score: 2,
            direction: data.tvlChange7d > 0 ? 'long' : 'short',
            relevantSymbol: symbol,
            detail: `${data.chain} TVL 7d: ${data.tvlChange7d > 0 ? '+' : ''}${data.tvlChange7d.toFixed(1)}%`,
          });
        }
      }
    }

    return flags;
  }

  formatTVL(tvlData: TVLData[]): string {
    if (tvlData.length === 0) return 'No TVL data available.';

    const lines = ['<b>DeFi TVL (DefiLlama)</b>'];
    for (const d of tvlData) {
      const changeIcon = d.tvlChange24h >= 0 ? '+' : '';
      lines.push(
        `  ${d.chain}: $${(d.tvl / 1e9).toFixed(2)}B (${changeIcon}${d.tvlChange24h.toFixed(1)}% 24h)`,
      );
    }
    return lines.join('\n');
  }
}
