import dotenv from 'dotenv';
dotenv.config();

import { getHyperliquidClient } from '../src/exchanges/hyperliquid/client.js';
import { MarketAnalyzer } from '../src/strategies/discretionary/analyzer.js';

async function main() {
  console.log('=== MarketAnalyzer End-to-End Test ===\n');

  // Connect HL client
  const hl = getHyperliquidClient();
  await hl.connect();
  console.log('1. Hyperliquid connected\n');

  // Create analyzer
  const analyzer = new MarketAnalyzer();

  // Test single symbol analysis
  console.log('2. Analyzing ETH-PERP...');
  const ethSnapshot = await analyzer.analyze('ETH-PERP');
  if (ethSnapshot) {
    console.log(analyzer.formatSnapshot(ethSnapshot).replace(/<\/?b>/g, '').replace(/<\/?i>/g, ''));
  } else {
    console.log('   Failed to analyze ETH-PERP');
  }

  // Test multiple symbols
  console.log('\n3. Analyzing multiple symbols...');
  const snapshots = await analyzer.analyzeMultiple(['BTC-PERP', 'ETH-PERP', 'SOL-PERP']);
  console.log(`   Successfully analyzed: ${snapshots.map(s => s.symbol).join(', ')}`);

  for (const snap of snapshots) {
    console.log(`\n--- ${snap.symbol} ---`);
    console.log(analyzer.formatSnapshot(snap).replace(/<\/?b>/g, '').replace(/<\/?i>/g, ''));
  }

  // Test balance
  console.log('\n4. Account check:');
  const balance = await hl.getBalance();
  console.log(`   Balance: $${balance.toString()}`);

  console.log('\n=== Test Complete ===');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
