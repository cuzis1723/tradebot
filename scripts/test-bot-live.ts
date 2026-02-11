import dotenv from 'dotenv';
dotenv.config();

import { Bot, type Context } from 'grammy';
import { getHyperliquidClient } from '../src/exchanges/hyperliquid/client.js';
import { MarketAnalyzer } from '../src/strategies/discretionary/analyzer.js';

const token = process.env.TG_BOT_TOKEN!;
const chatId = process.env.TG_CHAT_ID!;
const bot = new Bot(token);
const analyzer = new MarketAnalyzer();

function isAuthorized(ctx: Context): boolean {
  return ctx.chat?.id?.toString() === chatId;
}

bot.command('market', async (ctx) => {
  if (!isAuthorized(ctx)) return;
  await ctx.reply('Analyzing markets...');

  const symbols = ['BTC-PERP', 'ETH-PERP', 'SOL-PERP'];
  for (const symbol of symbols) {
    const snapshot = await analyzer.analyze(symbol);
    if (snapshot) {
      await ctx.reply(analyzer.formatSnapshot(snapshot), { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`Failed to analyze ${symbol}`);
    }
  }
});

bot.command('help', async (ctx) => {
  if (!isAuthorized(ctx)) return;
  await ctx.reply(
    '<b>TradeBot Test Mode</b>\n\n'
    + '/market - Market analysis (BTC, ETH, SOL)\n'
    + '/help - This message\n\n'
    + '<i>Full bot commands available after full engine start</i>',
    { parse_mode: 'HTML' }
  );
});

async function main() {
  const hl = getHyperliquidClient();
  await hl.connect();
  console.log('Hyperliquid connected');

  bot.start({
    onStart: () => {
      console.log('Bot started. Send /market or /help in Telegram.');
    },
  });

  await bot.api.sendMessage(chatId,
    '🤖 <b>TradeBot Test Mode Active</b>\n\nSend /market to get live analysis.',
    { parse_mode: 'HTML' }
  );
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
