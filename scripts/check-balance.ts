import { Hyperliquid } from 'hyperliquid';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

const pk = process.env.HL_PRIVATE_KEY!;
const testnet = process.env.HL_USE_TESTNET === 'true';
const wallet = new ethers.Wallet(pk);
const walletAddress = process.env.HL_WALLET_ADDRESS ?? wallet.address;

console.log('=== Config ===');
console.log('testnet:', testnet);
console.log('HL_USE_TESTNET env:', process.env.HL_USE_TESTNET);
console.log('derived address:', wallet.address);
console.log('HL_WALLET_ADDRESS env:', process.env.HL_WALLET_ADDRESS ?? '(not set)');
console.log('using address:', walletAddress);

const sdk = new Hyperliquid({ enableWs: false, privateKey: pk, testnet });

async function main() {
  await sdk.connect();

  console.log('\n=== Perp Clearinghouse State ===');
  const perpState = await sdk.info.perpetuals.getClearinghouseState(walletAddress);
  console.log(JSON.stringify(perpState, null, 2));

  console.log('\n=== Spot Clearinghouse State ===');
  const spotState = await sdk.info.spot.getSpotClearinghouseState(walletAddress);
  console.log(JSON.stringify(spotState, null, 2));

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
