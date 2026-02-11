import { Hyperliquid } from 'hyperliquid';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const sdk = new Hyperliquid({ privateKey: process.env.HL_PRIVATE_KEY!, testnet: true });
  await sdk.connect();

  const address = new ethers.Wallet(process.env.HL_PRIVATE_KEY!).address;
  console.log('Wallet:', address);

  // Use SDK's symbol format directly
  // Place a small ETH-PERP limit buy far below market
  console.log('Placing test limit buy: ETH-PERP, 0.01 @ $2000...');

  try {
    const result = await sdk.exchange.placeOrder({
      coin: 'ETH-PERP',
      is_buy: true,
      sz: 0.01,
      limit_px: 2000,
      order_type: { limit: { tif: 'Gtc' } },
      reduce_only: false,
    });
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error:', err);
  }

  // Check open orders
  const orders = await sdk.info.getUserOpenOrders(address);
  console.log('\nOpen orders:', JSON.stringify(orders, null, 2));

  // Cancel all
  if ((orders as unknown[]).length > 0) {
    console.log('\nCancelling all...');
    const cancelResult = await sdk.custom.cancelAllOrders('ETH-PERP');
    console.log('Cancel:', JSON.stringify(cancelResult, null, 2));
  }

  // Check balance after
  const state = await sdk.info.perpetuals.getClearinghouseState(address);
  const margin = (state as unknown as { marginSummary: { accountValue: string } }).marginSummary;
  console.log('\nPerp account value:', margin.accountValue);

  process.exit(0);
}

main();
