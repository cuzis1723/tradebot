import { Hyperliquid } from 'hyperliquid';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const sdk = new Hyperliquid({ privateKey: process.env.HL_PRIVATE_KEY!, testnet: true });
  await sdk.connect();

  const address = new ethers.Wallet(process.env.HL_PRIVATE_KEY!).address;

  // Try all info endpoints to find the balance
  console.log('=== getAllMids (first 5) ===');
  const mids = await sdk.info.getAllMids();
  const entries = Object.entries(mids as Record<string, string>).slice(0, 5);
  for (const [k, v] of entries) console.log(`  ${k}: $${v}`);

  console.log('\n=== Test order: place and cancel ETH-PERP ===');
  // Try placing a small limit order far from market to test
  const ethPrice = (mids as Record<string, string>)['ETH'];
  console.log(`Current ETH mid: $${ethPrice}`);
  const buyPrice = Math.round(parseFloat(ethPrice) * 0.8); // 20% below market
  console.log(`Placing test buy @ $${buyPrice}...`);

  try {
    const result = await sdk.exchange.placeOrder({
      coin: 'ETH-PERP',
      is_buy: true,
      sz: 0.01,
      limit_px: buyPrice,
      order_type: { limit: { tif: 'Gtc' } },
      reduce_only: false,
    });
    console.log('Order result:', JSON.stringify(result, null, 2));

    // Cancel it
    console.log('Cancelling all orders...');
    const cancelResult = await sdk.custom.cancelAllOrders('ETH-PERP');
    console.log('Cancel result:', JSON.stringify(cancelResult, null, 2));
  } catch (err) {
    console.error('Order error:', err);
  }

  process.exit(0);
}

main();
