/**
 * Scorer Backtest Framework
 *
 * Fetches historical 1h candles from Hyperliquid, computes MarketSnapshot indicators,
 * runs scorer.scoreSymbol() on each bar, then checks forward price movement
 * at 4h/8h/12h windows to verify directional accuracy.
 *
 * Usage: npm run backtest
 *   or:  npx tsx src/backtest/scorer-backtest.ts [symbol] [days]
 */

import { RSI, EMA, ATR, BollingerBands } from 'technicalindicators';
import { MarketScorer } from '../strategies/discretionary/scorer.js';
import type { MarketSnapshot, TriggerScore } from '../core/types.js';

// ============================================================
// Config
// ============================================================

const DEFAULT_SYMBOL = 'ETH';
const DEFAULT_DAYS = 30;
const FORWARD_WINDOWS_H = [4, 8, 12];
const SCORE_THRESHOLDS = [5, 8, 11];

// ============================================================
// Candle Fetch (direct HTTP — no SDK needed for backtest)
// ============================================================

interface RawCandle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

async function fetchCandles(coin: string, intervalMs: number, startTime: number, endTime: number): Promise<RawCandle[]> {
  const url = 'https://api.hyperliquid.xyz/info';
  const all: RawCandle[] = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const body = {
      type: 'candleSnapshot',
      req: {
        coin,
        interval: '1h',
        startTime: cursor,
        endTime: Math.min(cursor + 500 * intervalMs, endTime),
      },
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const candles = (await resp.json()) as RawCandle[];
    if (candles.length === 0) break;
    all.push(...candles);
    cursor = candles[candles.length - 1].t + intervalMs;
  }

  // Deduplicate by timestamp
  const seen = new Set<number>();
  return all.filter(c => {
    if (seen.has(c.t)) return false;
    seen.add(c.t);
    return true;
  }).sort((a, b) => a.t - b.t);
}

// ============================================================
// Build MarketSnapshot from candle window
// ============================================================

function buildSnapshot(
  symbol: string,
  candles: { close: number; high: number; low: number; volume: number; timestamp: number }[],
  idx: number,
): MarketSnapshot | null {
  if (idx < 30) return null; // need enough history

  const window = candles.slice(0, idx + 1);
  const closes = window.map(c => c.close);
  const highs = window.map(c => c.high);
  const lows = window.map(c => c.low);
  const current = window[window.length - 1];

  // Price changes
  const price1hAgo = idx >= 1 ? candles[idx - 1].close : current.close;
  const price4hAgo = idx >= 4 ? candles[idx - 4].close : current.close;
  const price24hAgo = idx >= 24 ? candles[idx - 24].close : current.close;

  const change1h = price1hAgo !== 0 ? ((current.close - price1hAgo) / price1hAgo) * 100 : 0;
  const change4h = price4hAgo !== 0 ? ((current.close - price4hAgo) / price4hAgo) * 100 : 0;
  const change24h = price24hAgo !== 0 ? ((current.close - price24hAgo) / price24hAgo) * 100 : 0;

  // Indicators
  const rsiValues = RSI.calculate({ values: closes, period: 14 });
  const ema9Values = EMA.calculate({ values: closes, period: 9 });
  const ema21Values = EMA.calculate({ values: closes, period: 21 });
  const atrValues = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });

  if (rsiValues.length === 0 || ema9Values.length === 0 || ema21Values.length === 0 || atrValues.length === 0) {
    return null;
  }

  const rsi14 = rsiValues[rsiValues.length - 1];
  const ema9 = ema9Values[ema9Values.length - 1];
  const ema21 = ema21Values[ema21Values.length - 1];
  const atr14 = atrValues[atrValues.length - 1];

  // ATR average (20-period)
  const atrWindow = atrValues.slice(-20);
  const atrAvg20 = atrWindow.reduce((a, b) => a + b, 0) / atrWindow.length;

  // Bollinger Bands
  const bb = bbValues.length > 0 ? bbValues[bbValues.length - 1] : null;

  // Volume ratio: last bar volume / average hourly volume (24h)
  const volumeWindow = window.slice(-24);
  const avgHourlyVolume = volumeWindow.reduce((s, c) => s + c.volume, 0) / volumeWindow.length;
  const volumeRatio = avgHourlyVolume > 0 ? current.volume / avgHourlyVolume : 0;

  // Simple support/resistance: lowest low / highest high in last 20 bars
  const srWindow = window.slice(-20);
  const support = Math.min(...srWindow.map(c => c.low));
  const resistance = Math.max(...srWindow.map(c => c.high));

  // Trend from EMA
  const trend: 'bullish' | 'bearish' | 'neutral' = ema9 > ema21 ? 'bullish' : ema9 < ema21 ? 'bearish' : 'neutral';

  return {
    symbol: `${symbol}-PERP`,
    price: current.close,
    change1h,
    change4h,
    change24h,
    volume24h: volumeWindow.reduce((s, c) => s + c.volume, 0),
    fundingRate: 0,
    rsi14,
    ema9,
    ema21,
    atr14,
    support,
    resistance,
    trend,
    timestamp: current.timestamp,
    bollingerUpper: bb?.upper,
    bollingerLower: bb?.lower,
    bollingerWidth: bb ? ((bb.upper - bb.lower) / current.close) * 100 : undefined,
    volumeRatio,
    atrAvg20,
  };
}

// ============================================================
// Backtest Runner
// ============================================================

async function runBacktest(symbol: string, days: number): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Scorer Backtest: ${symbol}-PERP | ${days} days`);
  console.log(`${'='.repeat(60)}\n`);

  const hourMs = 3600_000;
  const endTime = Date.now();
  const maxForwardH = Math.max(...FORWARD_WINDOWS_H);
  const startTime = endTime - (days + Math.ceil(maxForwardH / 24) + 2) * 24 * hourMs;

  console.log('Fetching candles...');
  const rawCandles = await fetchCandles(symbol, hourMs, startTime, endTime);
  console.log(`Fetched ${rawCandles.length} 1h candles\n`);

  if (rawCandles.length < 50) {
    console.log('Not enough candles for backtest. Exiting.');
    return;
  }

  const candles = rawCandles.map(c => ({
    close: parseFloat(c.c),
    high: parseFloat(c.h),
    low: parseFloat(c.l),
    volume: parseFloat(c.v),
    timestamp: c.t,
  }));

  const scorer = new MarketScorer();
  const scores: { score: TriggerScore; snapshot: MarketSnapshot; idx: number }[] = [];

  // Score each bar (leave room for forward window)
  const endIdx = candles.length - maxForwardH - 1;
  let prevSnapshot: MarketSnapshot | undefined;

  for (let i = 30; i <= endIdx; i++) {
    const snapshot = buildSnapshot(symbol, candles, i);
    if (!snapshot) continue;

    const score = scorer.scoreSymbol(snapshot, prevSnapshot);
    if (score.totalScore >= Math.min(...SCORE_THRESHOLDS)) {
      scores.push({ score, snapshot, idx: i });
    }
    prevSnapshot = snapshot;
  }

  console.log(`Total scored bars: ${endIdx - 30 + 1}`);
  console.log(`Triggers above min threshold (${Math.min(...SCORE_THRESHOLDS)}): ${scores.length}\n`);

  // Evaluate for each threshold × each forward window
  for (const windowH of FORWARD_WINDOWS_H) {
    console.log(`--- Forward Window: ${windowH}h ---`);
    console.log(`${'Threshold'.padEnd(12)}${'Triggers'.padEnd(10)}${'Win%'.padEnd(8)}${'AvgRet%'.padEnd(10)}${'AvgWin%'.padEnd(10)}${'AvgLoss%'.padEnd(10)}`);

    for (const threshold of SCORE_THRESHOLDS) {
      const triggered = scores.filter(s => s.score.totalScore >= threshold);
      let correct = 0;
      let wrong = 0;
      let neutral = 0;
      const returns: number[] = [];
      const correctReturns: number[] = [];
      const wrongReturns: number[] = [];

      for (const { score, idx } of triggered) {
        const futureIdx = idx + windowH;
        if (futureIdx >= candles.length) continue;

        const entryPrice = candles[idx].close;
        const futurePrice = candles[futureIdx].close;
        const forwardReturn = ((futurePrice - entryPrice) / entryPrice) * 100;

        returns.push(forwardReturn);

        if (score.directionBias === 'neutral') {
          neutral++;
          continue;
        }

        const directionCorrect = (score.directionBias === 'long' && forwardReturn > 0)
          || (score.directionBias === 'short' && forwardReturn < 0);

        if (directionCorrect) {
          correct++;
          correctReturns.push(Math.abs(forwardReturn));
        } else {
          wrong++;
          wrongReturns.push(Math.abs(forwardReturn));
        }
      }

      const total = correct + wrong;
      const winRate = total > 0 ? (correct / total) * 100 : 0;
      const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
      const avgWinRet = correctReturns.length > 0 ? correctReturns.reduce((a, b) => a + b, 0) / correctReturns.length : 0;
      const avgLossRet = wrongReturns.length > 0 ? wrongReturns.reduce((a, b) => a + b, 0) / wrongReturns.length : 0;

      console.log(
        `${(`>=${threshold}`).padEnd(12)}${triggered.length.toString().padEnd(10)}${winRate.toFixed(1).padEnd(8)}${avgRet.toFixed(3).padEnd(10)}${avgWinRet.toFixed(3).padEnd(10)}${avgLossRet.toFixed(3).padEnd(10)}`
      );
    }
    console.log('');
  }

  // Direction bias distribution
  const allTriggered = scores.filter(s => s.score.totalScore >= SCORE_THRESHOLDS[0]);
  const longCount = allTriggered.filter(s => s.score.directionBias === 'long').length;
  const shortCount = allTriggered.filter(s => s.score.directionBias === 'short').length;
  const neutralCount = allTriggered.filter(s => s.score.directionBias === 'neutral').length;

  console.log(`Direction Distribution (threshold >= ${SCORE_THRESHOLDS[0]}):`);
  console.log(`  Long: ${longCount} | Short: ${shortCount} | Neutral: ${neutralCount}`);

  // Conflict penalty stats
  const withConflict = allTriggered.filter(s => (s.score.conflictPenalty ?? 0) > 0);
  console.log(`  Conflict penalties applied: ${withConflict.length}/${allTriggered.length}`);
  if (withConflict.length > 0) {
    const avgPenalty = withConflict.reduce((s, t) => s + (t.score.conflictPenalty ?? 0), 0) / withConflict.length;
    console.log(`  Avg conflict penalty: ${avgPenalty.toFixed(1)}`);
  }

  console.log(`\n${'='.repeat(60)}\n`);
}

// ============================================================
// CLI Entry Point
// ============================================================

const args = process.argv.slice(2);
const symbol = args[0] || DEFAULT_SYMBOL;
const days = parseInt(args[1] || String(DEFAULT_DAYS), 10);

runBacktest(symbol, days).catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
