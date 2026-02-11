import { Bot } from 'grammy';
import dotenv from 'dotenv';

dotenv.config();

const token = process.env.TG_BOT_TOKEN;
if (!token) {
  console.error('TG_BOT_TOKEN not set');
  process.exit(1);
}

const bot = new Bot(token);

console.log('Bot is listening for messages...');
console.log('>> Telegram에서 봇에게 아무 메시지나 보내세요 <<');
console.log('>> Chat ID가 표시되면 .env의 TG_CHAT_ID에 입력하세요 <<\n');

bot.on('message', (ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.from?.username ?? ctx.from?.first_name ?? 'unknown';
  console.log(`=================================`);
  console.log(`Chat ID: ${chatId}`);
  console.log(`User: ${username}`);
  console.log(`Message: ${ctx.message.text}`);
  console.log(`=================================`);
  console.log(`\n.env에 추가: TG_CHAT_ID=${chatId}\n`);

  ctx.reply(`Your Chat ID: ${chatId}\nThis ID has been logged. You can stop the script now.`);
});

bot.start({
  onStart: () => {
    console.log('Bot started. Waiting for messages...\n');
  },
});
