/**
 * LLM Skills — Anthropic Tool Use definitions + executor
 *
 * Gives the LLM (Brain/Advisor) the ability to directly call Hyperliquid
 * operations: check balances, place/close orders, etc.
 *
 * NOTE: Hyperliquid uses a Unified Account model — Spot USDC is automatically
 * used as Perp margin. There is NO separate Spot/Perp wallet, and NO need
 * to transfer USDC between them.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { getHyperliquidClient } from '../exchanges/hyperliquid/client.js';
import { createChildLogger } from '../monitoring/logger.js';

const log = createChildLogger('llm-skills');

// ============================================================
// Tool Definitions (Anthropic format)
// ============================================================

export const TRADING_TOOLS: Anthropic.Tool[] = [
  // --- Read: Account ---
  {
    name: 'get_balance',
    description: 'Get the unified account balance (Spot+Perp combined), margin info, and all open perp positions. Hyperliquid uses a unified account — Spot USDC is automatically used as perp margin.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_spot_holdings',
    description: 'Get spot token holdings (e.g. HYPE, PURR). Note: In unified account, USDC balance is already included in get_balance. This only shows non-USDC spot tokens.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_open_orders',
    description: 'Get all currently open (resting) orders.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },

  // --- Read: Market Data ---
  {
    name: 'get_mid_prices',
    description: 'Get current mid prices for all traded symbols. Returns symbol→price mapping.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_funding_rates',
    description: 'Get current funding rates, OI, mark price and volume for all perp assets. Sorted by absolute funding rate.',
    input_schema: {
      type: 'object' as const,
      properties: {
        top_n: { type: 'number', description: 'Number of top assets to return (by |funding|). Default: 20.' },
      },
      required: [],
    },
  },
  {
    name: 'get_l2_book',
    description: 'Get the Level 2 order book (bids/asks) for a specific symbol.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Symbol name, e.g. "ETH" or "BTC"' },
      },
      required: ['symbol'],
    },
  },

  // --- Read: History ---
  {
    name: 'get_recent_fills',
    description: 'Get recent trade fills/executions for this account.',
    input_schema: {
      type: 'object' as const,
      properties: {
        count: { type: 'number', description: 'Number of fills to return. Default: 10.' },
      },
      required: [],
    },
  },
  {
    name: 'get_funding_payments',
    description: 'Get funding payments received/paid in the last N hours.',
    input_schema: {
      type: 'object' as const,
      properties: {
        hours: { type: 'number', description: 'Lookback window in hours. Default: 24.' },
      },
      required: [],
    },
  },

  // --- Write: Orders ---
  {
    name: 'market_open',
    description: 'Open a new position at market price with slippage protection. Sets leverage automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Symbol name, e.g. "ETH" or "BTC"' },
        side: { type: 'string', enum: ['long', 'short'], description: 'Position direction' },
        size: { type: 'number', description: 'Position size in base asset units (e.g. 0.01 ETH)' },
        leverage: { type: 'number', description: 'Leverage to use (1-20). Will be set before order.' },
      },
      required: ['symbol', 'side', 'size'],
    },
  },
  {
    name: 'market_close',
    description: 'Close an existing position at market price. If size is omitted, closes the full position.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Symbol name, e.g. "ETH" or "BTC"' },
        size: { type: 'number', description: 'Size to close. Omit to close full position.' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'place_limit_order',
    description: 'Place a limit order at a specific price.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Symbol name, e.g. "ETH" or "BTC"' },
        side: { type: 'string', enum: ['buy', 'sell'], description: 'Order side' },
        size: { type: 'number', description: 'Order size in base asset units' },
        price: { type: 'number', description: 'Limit price in USD' },
        reduce_only: { type: 'boolean', description: 'If true, only reduces existing position. Default: false.' },
      },
      required: ['symbol', 'side', 'size', 'price'],
    },
  },
  {
    name: 'cancel_order',
    description: 'Cancel a specific open order by its order ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Symbol name, e.g. "ETH" or "BTC"' },
        order_id: { type: 'number', description: 'Order ID to cancel' },
      },
      required: ['symbol', 'order_id'],
    },
  },
  {
    name: 'cancel_all_orders',
    description: 'Cancel all open orders, optionally filtered to a specific symbol.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Optional: only cancel orders for this symbol' },
      },
      required: [],
    },
  },
  {
    name: 'close_all_positions',
    description: 'Emergency: close ALL open positions at market price.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },

  // --- Write: Leverage ---
  {
    name: 'set_leverage',
    description: 'Set the leverage for a symbol. Applies to future orders.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Symbol name, e.g. "ETH" or "BTC"' },
        leverage: { type: 'number', description: 'Leverage multiplier (1-20)' },
        mode: { type: 'string', enum: ['cross', 'isolated'], description: 'Margin mode. Default: cross.' },
      },
      required: ['symbol', 'leverage'],
    },
  },
];

// ============================================================
// Tool Executor
// ============================================================

export async function executeToolCall(
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  const hl = getHyperliquidClient();

  try {
    switch (toolName) {
      // --- Read: Account (Unified) ---
      case 'get_balance': {
        const [state, spotState] = await Promise.all([
          hl.getAccountState(),
          hl.getSpotBalances(),
        ]);
        const positions = state.assetPositions.filter(
          ap => parseFloat(ap.position.szi) !== 0,
        );
        const spotTokens = spotState.balances.filter(
          b => parseFloat(b.total) > 0 && b.coin !== 'USDC',
        );
        const perpValue = parseFloat(state.marginSummary.accountValue);
        const spotUsdc = spotState.balances
          .filter(b => b.coin === 'USDC')
          .reduce((sum, b) => sum + parseFloat(b.total), 0);
        const totalBalance = perpValue + spotUsdc;
        const marginUsed = parseFloat(state.marginSummary.totalMarginUsed);
        return JSON.stringify({
          _note: 'Unified account — total_balance = perp + spot USDC combined. This is your TRUE available capital.',
          total_balance: totalBalance.toFixed(2),
          perp_account_value: state.marginSummary.accountValue,
          spot_usdc: spotUsdc.toFixed(2),
          margin_used: state.marginSummary.totalMarginUsed,
          free_margin: (totalBalance - marginUsed).toFixed(2),
          notional_position: state.marginSummary.totalNtlPos,
          positions: positions.map(ap => ({
            coin: ap.position.coin,
            side: parseFloat(ap.position.szi) > 0 ? 'long' : 'short',
            size: Math.abs(parseFloat(ap.position.szi)),
            entry_price: ap.position.entryPx,
            unrealized_pnl: ap.position.unrealizedPnl,
            leverage: ap.position.leverage,
          })),
          spot_tokens: spotTokens.length > 0
            ? spotTokens.map(b => ({ coin: b.coin, total: b.total, hold: b.hold }))
            : [],
        });
      }

      case 'get_spot_holdings': {
        const spotState = await hl.getSpotBalances();
        const nonZero = spotState.balances.filter(b => parseFloat(b.total) > 0);
        return JSON.stringify({
          _note: 'Unified account — USDC is shared with perp margin, shown here for completeness',
          holdings: nonZero.map(b => ({
            coin: b.coin,
            total: b.total,
            hold: b.hold,
          })),
        });
      }

      case 'get_open_orders': {
        const orders = await hl.getOpenOrders();
        return JSON.stringify(orders);
      }

      // --- Read: Market Data ---
      case 'get_mid_prices': {
        const mids = await hl.getAllMidPrices();
        const result: Record<string, string> = {};
        for (const [sym, price] of Object.entries(mids)) {
          result[sym] = price.toString();
        }
        return JSON.stringify(result);
      }

      case 'get_funding_rates': {
        const topN = (input.top_n as number) || 20;
        const assets = await hl.getAssetInfos();
        const sorted = assets
          .filter(a => a.funding !== 0)
          .sort((a, b) => Math.abs(b.funding) - Math.abs(a.funding))
          .slice(0, topN);
        return JSON.stringify(sorted.map(a => ({
          symbol: a.name,
          funding_rate_pct_hr: (a.funding * 100).toFixed(4),
          annual_pct: (a.funding * 100 * 24 * 365).toFixed(1),
          open_interest: a.openInterest,
          mark_price: a.markPrice,
          volume_24h: a.volume24h,
          max_leverage: a.maxLeverage,
        })));
      }

      case 'get_l2_book': {
        const book = await hl.getL2Book(input.symbol as string);
        return JSON.stringify(book);
      }

      // --- Read: History ---
      case 'get_recent_fills': {
        const count = (input.count as number) || 10;
        const fills = await hl.getUserFills();
        return JSON.stringify(fills.slice(0, count).map(f => ({
          coin: f.coin,
          side: f.side,
          size: f.sz,
          price: f.px,
          closed_pnl: f.closedPnl,
          fee: f.fee,
          time: new Date(f.time).toISOString(),
        })));
      }

      case 'get_funding_payments': {
        const hours = (input.hours as number) || 24;
        const startTime = Date.now() - hours * 60 * 60 * 1000;
        const funding = await hl.getUserFunding(startTime);
        let total = 0;
        const entries = funding.map(f => {
          const usdc = parseFloat(f.usdc);
          total += usdc;
          return {
            coin: f.coin,
            usdc: f.usdc,
            funding_rate: f.fundingRate,
            time: new Date(f.time).toISOString(),
          };
        });
        return JSON.stringify({ total_usdc: total.toFixed(4), entries });
      }

      // --- Write: Orders ---
      case 'market_open': {
        const symbol = input.symbol as string;
        const isBuy = (input.side as string) === 'long';
        const size = input.size as number;
        const leverage = input.leverage as number | undefined;

        if (leverage) {
          await hl.updateLeverage(symbol, leverage);
        }

        const result = await hl.marketOpen(symbol, isBuy, size, 0.05);
        return JSON.stringify({
          success: result.filled || result.orderId !== null,
          filled: result.filled,
          avg_price: result.avgPrice,
          order_id: result.orderId,
          error: result.error,
        });
      }

      case 'market_close': {
        const symbol = input.symbol as string;
        const size = input.size as number | undefined;
        const result = await hl.marketClose(symbol, size, 0.05);
        return JSON.stringify({
          success: result.filled || result.orderId !== null,
          filled: result.filled,
          avg_price: result.avgPrice,
          error: result.error,
        });
      }

      case 'place_limit_order': {
        const result = await hl.placeOrder({
          coin: input.symbol as string,
          isBuy: (input.side as string) === 'buy',
          size: String(input.size),
          price: String(input.price),
          orderType: 'limit',
          reduceOnly: (input.reduce_only as boolean) ?? false,
        });
        return JSON.stringify({
          success: result.orderId !== null,
          order_id: result.orderId,
          filled: result.filled,
          avg_price: result.avgPrice,
          error: result.error,
        });
      }

      case 'cancel_order': {
        const success = await hl.cancelOrder(input.symbol as string, input.order_id as number);
        return JSON.stringify({ success });
      }

      case 'cancel_all_orders': {
        const success = await hl.cancelAllOrders(input.symbol as string | undefined);
        return JSON.stringify({ success });
      }

      case 'close_all_positions': {
        const success = await hl.closeAllPositions(0.05);
        return JSON.stringify({ success });
      }

      // --- Write: Leverage ---
      case 'set_leverage': {
        const success = await hl.updateLeverage(
          input.symbol as string,
          input.leverage as number,
          (input.mode as 'cross' | 'isolated') ?? 'cross',
        );
        return JSON.stringify({ success, symbol: input.symbol, leverage: input.leverage });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  } catch (err) {
    log.error({ err, toolName, input }, 'Tool execution failed');
    return JSON.stringify({ error: String(err) });
  }
}
