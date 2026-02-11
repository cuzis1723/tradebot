import dotenv from 'dotenv';
dotenv.config();

import { Bot } from 'grammy';

async function main() {
  const token = process.env.TG_BOT_TOKEN!;
  const chatId = process.env.TG_CHAT_ID!;

  console.log(`Token: ${token.slice(0, 10)}...`);
  console.log(`Chat ID: ${chatId}`);

  const bot = new Bot(token);

  // Send a test message
  console.log('Sending test message...');
  await bot.api.sendMessage(chatId,
    '<b>🤖 TradeBot Connected!</b>\n\n'
    + 'Telegram integration test successful.\n\n'
    + '<b>Available Commands:</b>\n'
    + '/status - Bot status\n'
    + '/market - Market analysis\n'
    + '/idea &lt;text&gt; - Evaluate trade idea\n'
    + '/help - All commands',
    { parse_mode: 'HTML' }
  );

  console.log('Message sent! Check Telegram.');
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
