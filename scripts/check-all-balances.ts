import { Hyperliquid } from 'hyperliquid';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const sdk = new Hyperliquid({ privateKey: process.env.HL_PRIVATE_KEY!, testnet: true });
  await sdk.connect();

  const address = new ethers.Wallet(process.env.HL_PRIVATE_KEY!).address;
  console.log('Wallet:', address);

  // Spot
  const spotState = await sdk.info.spot.getSpotClearinghouseState(address);
  console.log('\n--- Spot ---');
  console.log(JSON.stringify(spotState, null, 2));

  // Perp
  const perpState = await sdk.info.perpetuals.getClearinghouseState(address);
  console.log('\n--- Perp ---');
  console.log(JSON.stringify(perpState, null, 2));

  process.exit(0);
}

main();
