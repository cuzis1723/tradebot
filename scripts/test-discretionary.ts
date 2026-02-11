import { Hyperliquid } from 'hyperliquid';
import { RSI, EMA, ATR } from 'technicalindicators';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  console.log('=== Discretionary Trading Integration Test ===\n');

  // 1. Connect to Hyperliquid
  const sdk = new Hyperliquid({ privateKey: process.env.HL_PRIVATE_KEY!, testnet: true });
  await sdk.connect();
  const address = new ethers.Wallet(process.env.HL_PRIVATE_KEY!).address;
  console.log('1. Connected to Hyperliquid testnet');
  console.log(`   Wallet: ${address}\n`);

  // 2. Get balance
  const state = await sdk.info.perpetuals.getClearinghouseState(address);
  const balance = (state as unknown as { marginSummary: { accountValue: string } }).marginSummary.accountValue;
  console.log(`2. Account balance: $${balance}\n`);

  // 3. Get mid prices
  const mids = await sdk.info.getAllMids();
  const midsMap = mids as Record<string, string>;
  const symbols = ['BTC', 'ETH', 'SOL'];
  console.log('3. Mid prices:');
  for (const sym of symbols) {
    // Try different key formats for testnet
    const price = midsMap[sym] ?? midsMap[`${sym}-PERP`] ?? midsMap[`@${sym}`] ?? 'N/A';
    console.log(`   ${sym}: $${price}`);
  }

  // Find actual available keys (first 10)
  const allKeys = Object.keys(midsMap);
  console.log(`\n   Total symbols: ${allKeys.length}`);
  console.log(`   Sample keys: ${allKeys.slice(0, 10).join(', ')}\n`);

  // 4. Test candle data fetch
  console.log('4. Fetching candle data...');
  try {
    // Try to get ETH candles
    const coin = 'ETH';
    const now = Date.now();
    const startTime = now - 100 * 3600_000; // 100 hours ago

    const candles = await (sdk.info as unknown as { getCandleSnapshot: (coin: string, interval: string, startTime: number, endTime: number) => Promise<unknown[]> })
      .getCandleSnapshot(coin, '1h', startTime, now);

    console.log(`   ETH 1h candles: ${(candles as unknown[]).length} bars`);

    if ((candles as unknown[]).length > 0) {
      const parsed = (candles as Array<{ o: string; h: string; l: string; c: string; v: string; t: number }>).map(c => ({
        open: parseFloat(c.o),
        high: parseFloat(c.h),
        low: parseFloat(c.l),
        close: parseFloat(c.c),
        volume: parseFloat(c.v),
        timestamp: c.t,
      }));

      const last = parsed[parsed.length - 1];
      console.log(`   Latest candle: O=${last.open} H=${last.high} L=${last.low} C=${last.close}`);

      // 5. Test technical indicators
      console.log('\n5. Technical indicators:');
      const closes = parsed.map(c => c.close);
      const highs = parsed.map(c => c.high);
      const lows = parsed.map(c => c.low);

      if (closes.length >= 15) {
        const rsi = RSI.calculate({ values: closes, period: 14 });
        console.log(`   RSI(14): ${rsi[rsi.length - 1]?.toFixed(1) ?? 'N/A'}`);

        const ema9 = EMA.calculate({ values: closes, period: 9 });
        const ema21 = EMA.calculate({ values: closes, period: 21 });
        console.log(`   EMA(9): ${ema9[ema9.length - 1]?.toFixed(2) ?? 'N/A'}`);
        console.log(`   EMA(21): ${ema21[ema21.length - 1]?.toFixed(2) ?? 'N/A'}`);

        const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
        console.log(`   ATR(14): ${atr[atr.length - 1]?.toFixed(2) ?? 'N/A'}`);

        // Trend
        const e9 = ema9[ema9.length - 1] ?? 0;
        const e21 = ema21[ema21.length - 1] ?? 0;
        const r = rsi[rsi.length - 1] ?? 50;
        const trend = e9 > e21 && r > 50 ? 'BULLISH' : e9 < e21 && r < 50 ? 'BEARISH' : 'NEUTRAL';
        console.log(`   Trend: ${trend}`);

        // Support/Resistance
        const recent20 = parsed.slice(-20);
        const resistance = Math.max(...recent20.map(c => c.high));
        const support = Math.min(...recent20.map(c => c.low));
        console.log(`   Support: $${support.toFixed(2)} | Resistance: $${resistance.toFixed(2)}`);
      } else {
        console.log('   Not enough data for indicators');
      }
    }
  } catch (err) {
    console.error('   Candle fetch error:', err);
  }

  // 6. Test funding rates
  console.log('\n6. Funding rates:');
  try {
    const meta = await sdk.info.perpetuals.getMeta();
    const metaData = meta as unknown as { universe: Array<{ name: string; funding?: string }> };
    const withFunding = metaData.universe.filter(a => a.funding !== undefined).slice(0, 5);
    for (const asset of withFunding) {
      console.log(`   ${asset.name}: ${(parseFloat(asset.funding ?? '0') * 100).toFixed(4)}%/hr`);
    }
    if (withFunding.length === 0) {
      console.log('   No funding rate data available on testnet');
    }
  } catch (err) {
    console.error('   Funding rate error:', err);
  }

  // 7. Test order placement + cancel (same as before but quick)
  console.log('\n7. Quick order test:');
  const ethMid = midsMap['ETH'] ?? midsMap['@107'];
  if (ethMid) {
    const buyPrice = Math.round(parseFloat(ethMid) * 0.8);
    console.log(`   ETH mid: $${ethMid}, placing buy @ $${buyPrice}...`);

    const result = await sdk.exchange.placeOrder({
      coin: 'ETH-PERP',
      is_buy: true,
      sz: 0.01,
      limit_px: buyPrice,
      order_type: { limit: { tif: 'Gtc' } },
      reduce_only: false,
    });

    const resp = result as { status: string; response?: { data?: { statuses: Array<Record<string, unknown>> } } };
    if (resp.status === 'ok') {
      const status = resp.response?.data?.statuses?.[0];
      if (status && 'resting' in status) {
        console.log(`   Order placed (resting), oid: ${(status.resting as { oid: number }).oid}`);
      } else if (status && 'filled' in status) {
        console.log(`   Order filled!`);
      } else {
        console.log(`   Order status:`, JSON.stringify(status));
      }
    } else {
      console.log(`   Order failed:`, JSON.stringify(result));
    }

    // Cancel
    const cancelResult = await sdk.custom.cancelAllOrders('ETH-PERP');
    console.log(`   Cancelled:`, JSON.stringify(cancelResult).slice(0, 100));
  } else {
    console.log('   ETH price not found, skipping order test');
    console.log('   Available mid keys:', Object.keys(midsMap).slice(0, 20).join(', '));
  }

  console.log('\n=== All tests complete ===');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
