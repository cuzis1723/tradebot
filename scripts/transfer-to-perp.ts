import { Hyperliquid } from 'hyperliquid';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const amount = parseFloat(process.argv[2] ?? '999');

  const sdk = new Hyperliquid({ privateKey: process.env.HL_PRIVATE_KEY!, testnet: true });
  await sdk.connect();

  console.log(`Transferring $${amount} from Spot to Perp...`);

  // true = spot to perp
  const result = await sdk.exchange.transferBetweenSpotAndPerp(amount, true);
  console.log('Result:', JSON.stringify(result, null, 2));

  process.exit(0);
}

main();
