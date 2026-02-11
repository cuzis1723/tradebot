import { Hyperliquid } from 'hyperliquid';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const privateKey = process.env.HL_PRIVATE_KEY;
  const testnet = process.env.HL_USE_TESTNET === 'true';

  if (!privateKey) {
    console.error('HL_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  // Derive address from private key
  const wallet = new ethers.Wallet(privateKey);
  const address = process.env.HL_WALLET_ADDRESS ?? wallet.address;

  console.log(`Connecting to Hyperliquid ${testnet ? 'testnet' : 'mainnet'}...`);
  console.log(`Wallet: ${address}`);

  const sdk = new Hyperliquid({
    privateKey,
    testnet,
  });

  try {
    await sdk.connect();
    console.log(`Network: ${testnet ? 'Testnet' : 'Mainnet'}\n`);

    // Get perp clearinghouse state
    const state = await sdk.info.perpetuals.getClearinghouseState(address);
    const margin = (state as unknown as { marginSummary: { accountValue: string; totalMarginUsed: string } }).marginSummary;
    console.log(`--- Perpetuals ---`);
    console.log(`Account Value: $${margin.accountValue}`);
    console.log(`Margin Used:   $${margin.totalMarginUsed}`);

    // Get positions
    const positions = (state as unknown as { assetPositions: Array<{ position: { coin: string; szi: string; entryPx: string; unrealizedPnl: string } }> }).assetPositions
      .filter(ap => parseFloat(ap.position.szi) !== 0);

    if (positions.length > 0) {
      console.log(`\n--- Open Positions ---`);
      for (const ap of positions) {
        const p = ap.position;
        const side = parseFloat(p.szi) > 0 ? 'LONG' : 'SHORT';
        console.log(`${p.coin}: ${side} ${Math.abs(parseFloat(p.szi))} @ $${p.entryPx} | uPnL: $${p.unrealizedPnl}`);
      }
    } else {
      console.log(`\nNo open positions.`);
    }

    // Get open orders
    const orders = await sdk.info.getUserOpenOrders(address) as Array<{ coin: string; side: string; sz: string; limitPx: string }>;
    if (orders.length > 0) {
      console.log(`\n--- Open Orders (${orders.length}) ---`);
      for (const o of orders) {
        console.log(`${o.coin}: ${o.side} ${o.sz} @ $${o.limitPx}`);
      }
    } else {
      console.log(`\nNo open orders.`);
    }

    console.log('\nDone.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
