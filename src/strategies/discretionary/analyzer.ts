import { RSI, EMA, ATR, BollingerBands } from 'technicalindicators';
import { getHyperliquidClient } from '../../exchanges/hyperliquid/client.js';
import { createChildLogger } from '../../monitoring/logger.js';
import type { MarketSnapshot } from '../../core/types.js';

const log = createChildLogger('market-analyzer');

interface CandleData {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export class MarketAnalyzer {
  private candleCache: Map<string, CandleData[]> = new Map();
  private midPriceCache: Map<string, number> = new Map();
  private oiCache: Map<string, number> = new Map();

  async fetchCandles(symbol: string, interval: '1h' | '4h' = '1h', limit: number = 100): Promise<CandleData[]> {
    const hl = getHyperliquidClient();
    try {
      const coin = symbol.replace('-PERP', '');
      const now = Date.now();
      const intervalMs = interval === '1h' ? 3600_000 : 14_400_000;
      const startTime = now - limit * intervalMs;

      const response = await hl.getCandleSnapshot(coin, interval, startTime, now);

      const candles = (response as Array<{ o: number | string; h: number | string; l: number | string; c: number | string; v: number | string; t: number }>).map(c => ({
        open: Number(c.o),
        high: Number(c.h),
        low: Number(c.l),
        close: Number(c.c),
        volume: Number(c.v),
        timestamp: c.t,
      }));

      this.candleCache.set(`${symbol}:${interval}`, candles);
      return candles;
    } catch (err) {
      log.error({ err, symbol, interval }, 'Failed to fetch candles');
      return this.candleCache.get(`${symbol}:${interval}`) ?? [];
    }
  }

  async updateMidPrices(): Promise<void> {
    const hl = getHyperliquidClient();
    const mids = await hl.getAllMidPrices();
    for (const [symbol, price] of Object.entries(mids)) {
      this.midPriceCache.set(symbol, price.toNumber());
      // Normalize: store both "ETH" and "ETH-PERP" keys
      if (symbol.endsWith('-PERP')) {
        this.midPriceCache.set(symbol.replace('-PERP', ''), price.toNumber());
      } else if (!symbol.includes('-')) {
        this.midPriceCache.set(`${symbol}-PERP`, price.toNumber());
      }
    }
  }

  getMidPrice(symbol: string): number | undefined {
    // Try exact match, then with/without -PERP suffix
    const coin = symbol.replace('-PERP', '');
    return this.midPriceCache.get(symbol)
      ?? this.midPriceCache.get(coin)
      ?? this.midPriceCache.get(`${coin}-PERP`);
  }

  computeIndicators(candles: CandleData[]): {
    rsi14: number;
    ema9: number;
    ema21: number;
    atr14: number;
    support: number;
    resistance: number;
    bollingerUpper: number;
    bollingerLower: number;
    bollingerWidth: number;
    atrAvg20: number;
  } {
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    // RSI
    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const rsi14 = rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : 50;

    // EMA
    const ema9Values = EMA.calculate({ values: closes, period: 9 });
    const ema21Values = EMA.calculate({ values: closes, period: 21 });
    const ema9 = ema9Values.length > 0 ? ema9Values[ema9Values.length - 1] : closes[closes.length - 1];
    const ema21 = ema21Values.length > 0 ? ema21Values[ema21Values.length - 1] : closes[closes.length - 1];

    // ATR
    const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const atr14 = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;

    // ATR 20-period average: average of the last 20 ATR values for volatility comparison
    const atrTail = atrValues.slice(-20);
    const atrAvg20 = atrTail.length > 0
      ? atrTail.reduce((sum, v) => sum + v, 0) / atrTail.length
      : atr14;

    // Bollinger Bands (period 20, stdDev 2)
    const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    const lastBB = bbValues.length > 0 ? bbValues[bbValues.length - 1] : null;
    const currentPrice = closes[closes.length - 1];
    const bollingerUpper = lastBB ? lastBB.upper : currentPrice;
    const bollingerLower = lastBB ? lastBB.lower : currentPrice;
    const bollingerWidth = currentPrice > 0
      ? ((bollingerUpper - bollingerLower) / currentPrice) * 100
      : 0;

    // Simple support/resistance from recent swing highs/lows (last 20 candles)
    const recentCandles = candles.slice(-20);
    const recentHighs = recentCandles.map(c => c.high);
    const recentLows = recentCandles.map(c => c.low);
    const resistance = Math.max(...recentHighs);
    const support = Math.min(...recentLows);

    return { rsi14, ema9, ema21, atr14, support, resistance, bollingerUpper, bollingerLower, bollingerWidth, atrAvg20 };
  }

  async analyze15mCandle(symbol: string): Promise<{ size: number; atr14: number; isLarge: boolean; direction: 'long' | 'short' } | null> {
    try {
      const candles15m = await this.fetchCandles(symbol, '15m' as '1h', 20);
      if (candles15m.length < 15) return null;

      const highs = candles15m.map(c => c.high);
      const lows = candles15m.map(c => c.low);
      const closes = candles15m.map(c => c.close);

      const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
      const atr14 = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
      if (atr14 === 0) return null;

      const latest = candles15m[candles15m.length - 1];
      const candleSize = latest.high - latest.low;
      const isLarge = candleSize > 2 * atr14;
      const direction: 'long' | 'short' = latest.close >= latest.open ? 'long' : 'short';

      return { size: candleSize, atr14, isLarge, direction };
    } catch (err) {
      log.debug({ err, symbol }, '15m candle analysis failed');
      return null;
    }
  }

  async analyze(symbol: string): Promise<MarketSnapshot | null> {
    try {
      await this.updateMidPrices();
      const currentPrice = this.getMidPrice(symbol);
      if (!currentPrice) {
        log.warn({ symbol }, 'No mid price available');
        return null;
      }

      const candles1h = await this.fetchCandles(symbol, '1h', 100);
      if (candles1h.length < 25) {
        log.warn({ symbol, count: candles1h.length }, 'Not enough candle data');
        return null;
      }

      const indicators = this.computeIndicators(candles1h);

      // Price changes
      const change1h = candles1h.length >= 2
        ? ((currentPrice - candles1h[candles1h.length - 2].close) / candles1h[candles1h.length - 2].close) * 100
        : 0;
      const change4h = candles1h.length >= 5
        ? ((currentPrice - candles1h[candles1h.length - 5].close) / candles1h[candles1h.length - 5].close) * 100
        : 0;
      const change24h = candles1h.length >= 25
        ? ((currentPrice - candles1h[candles1h.length - 25].close) / candles1h[candles1h.length - 25].close) * 100
        : 0;

      // Volume (sum of last 24 candles)
      const last24Candles = candles1h.slice(-24);
      const volume24h = last24Candles.reduce((sum, c) => sum + c.volume, 0);

      // Volume ratio: last completed 1h candle volume / average hourly volume over 24h
      const avgHourlyVolume = last24Candles.length > 0
        ? volume24h / last24Candles.length
        : 0;
      // Use the second-to-last candle (last completed) for comparison; current candle may be incomplete
      const lastCompletedVolume = candles1h.length >= 2
        ? candles1h[candles1h.length - 2].volume
        : 0;
      const volumeRatio = avgHourlyVolume > 0
        ? lastCompletedVolume / avgHourlyVolume
        : 0;

      // Funding rate
      const hl = getHyperliquidClient();
      const fundingRates = await hl.getFundingRates();
      const funding = fundingRates.find(f => f.symbol === symbol);
      const fundingRate = funding ? funding.rate.toNumber() : 0;

      // OI change - try to get from asset infos (may not be available on testnet)
      let oiChange1h: number | undefined;
      try {
        const assetInfos = await hl.getAssetInfos();
        const coin = symbol.replace('-PERP', '');
        const assetInfo = assetInfos.find(a => a.name === coin);
        if (assetInfo && assetInfo.openInterest > 0) {
          // We don't have historical OI readily available, so store current OI
          // and compute change on subsequent calls
          const cacheKey = `oi:${symbol}`;
          const prevOI = this.oiCache.get(cacheKey);
          const currentOI = assetInfo.openInterest;
          if (prevOI !== undefined && prevOI > 0) {
            oiChange1h = ((currentOI - prevOI) / prevOI) * 100;
          }
          this.oiCache.set(cacheKey, currentOI);
        }
      } catch (err) {
        log.debug({ err, symbol }, 'OI data not available');
      }

      // 15m candle analysis (v3)
      const candle15m = await this.analyze15mCandle(symbol) ?? undefined;

      // Trend determination
      let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
      if (indicators.ema9 > indicators.ema21 && indicators.rsi14 > 50) {
        trend = 'bullish';
      } else if (indicators.ema9 < indicators.ema21 && indicators.rsi14 < 50) {
        trend = 'bearish';
      }

      return {
        symbol,
        price: currentPrice,
        change1h,
        change4h,
        change24h,
        volume24h,
        fundingRate,
        rsi14: indicators.rsi14,
        ema9: indicators.ema9,
        ema21: indicators.ema21,
        atr14: indicators.atr14,
        support: indicators.support,
        resistance: indicators.resistance,
        trend,
        timestamp: Date.now(),
        bollingerUpper: indicators.bollingerUpper,
        bollingerLower: indicators.bollingerLower,
        bollingerWidth: indicators.bollingerWidth,
        volumeRatio,
        oiChange1h,
        atrAvg20: indicators.atrAvg20,
        candle15m,
      };
    } catch (err) {
      log.error({ err, symbol }, 'Market analysis failed');
      return null;
    }
  }

  async analyzeMultiple(symbols: string[]): Promise<MarketSnapshot[]> {
    const results: MarketSnapshot[] = [];
    for (const symbol of symbols) {
      const snapshot = await this.analyze(symbol);
      if (snapshot) results.push(snapshot);
    }
    return results;
  }

  formatSnapshot(snapshot: MarketSnapshot): string {
    const changeIcon = (v: number) => v >= 0 ? '📈' : '📉';
    const trendIcon = snapshot.trend === 'bullish' ? '🟢' : snapshot.trend === 'bearish' ? '🔴' : '🟡';

    const lines = [
      `<b>${snapshot.symbol}</b> ${trendIcon} ${snapshot.trend.toUpperCase()}`,
      `Price: $${snapshot.price.toFixed(2)}`,
      `${changeIcon(snapshot.change1h)} 1h: ${snapshot.change1h >= 0 ? '+' : ''}${snapshot.change1h.toFixed(2)}%`,
      `${changeIcon(snapshot.change4h)} 4h: ${snapshot.change4h >= 0 ? '+' : ''}${snapshot.change4h.toFixed(2)}%`,
      `${changeIcon(snapshot.change24h)} 24h: ${snapshot.change24h >= 0 ? '+' : ''}${snapshot.change24h.toFixed(2)}%`,
      `RSI(14): ${snapshot.rsi14.toFixed(1)} | EMA9: ${snapshot.ema9.toFixed(2)} | EMA21: ${snapshot.ema21.toFixed(2)}`,
      `ATR(14): ${snapshot.atr14.toFixed(2)} | Vol24h: $${(snapshot.volume24h / 1_000_000).toFixed(1)}M`,
      `Support: $${snapshot.support.toFixed(2)} | Resistance: $${snapshot.resistance.toFixed(2)}`,
      `Funding: ${(snapshot.fundingRate * 100).toFixed(4)}%/hr`,
    ];

    // Append extended indicator lines when available
    if (snapshot.bollingerUpper !== undefined && snapshot.bollingerLower !== undefined) {
      lines.push(
        `BB(20,2): $${snapshot.bollingerLower.toFixed(2)} - $${snapshot.bollingerUpper.toFixed(2)}` +
        (snapshot.bollingerWidth !== undefined ? ` (W: ${snapshot.bollingerWidth.toFixed(2)}%)` : ''),
      );
    }
    if (snapshot.volumeRatio !== undefined) {
      lines.push(`VolRatio: ${snapshot.volumeRatio.toFixed(2)}x avg`);
    }
    if (snapshot.atrAvg20 !== undefined) {
      const atrRatio = snapshot.atrAvg20 > 0 ? (snapshot.atr14 / snapshot.atrAvg20) : 0;
      lines.push(`ATR avg(20): ${snapshot.atrAvg20.toFixed(2)} (current ${atrRatio.toFixed(2)}x avg)`);
    }
    if (snapshot.oiChange1h !== undefined) {
      lines.push(`OI 1h: ${snapshot.oiChange1h >= 0 ? '+' : ''}${snapshot.oiChange1h.toFixed(2)}%`);
    }

    return lines.join('\n');
  }
}
