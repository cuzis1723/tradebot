import { Hyperliquid } from 'hyperliquid';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const sdk = new Hyperliquid({ privateKey: process.env.HL_PRIVATE_KEY!, testnet: true });
  await sdk.connect();

  const address = new ethers.Wallet(process.env.HL_PRIVATE_KEY!).address;

  // Get all mids - filter for PERP
  const mids = await sdk.info.getAllMids();
  const allEntries = Object.entries(mids as Record<string, string>);

  console.log(`Total symbols: ${allEntries.length}`);
  console.log('\n--- PERP symbols (first 20) ---');
  const perps = allEntries.filter(([k]) => !k.includes('-SPOT') && !k.includes('SPOT'));
  for (const [k, v] of perps.slice(0, 20)) {
    console.log(`  ${k}: $${v}`);
  }

  // Get meta for perp universe
  const meta = await sdk.info.perpetuals.getMeta();
  const universe = (meta as unknown as { universe: Array<{ name: string; szDecimals: number; maxLeverage: number }> }).universe;
  console.log(`\n--- Perp universe (first 20) ---`);
  for (const u of universe.slice(0, 20)) {
    console.log(`  ${u.name}: szDecimals=${u.szDecimals}, maxLev=${u.maxLeverage}`);
  }

  // Try BTC
  console.log(`\nBTC mid: ${(mids as Record<string, string>)['BTC']}`);
  console.log(`ETH mid: ${(mids as Record<string, string>)['ETH']}`);

  process.exit(0);
}

main();
