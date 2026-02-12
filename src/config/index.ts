import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Hyperliquid
  hlPrivateKey: z.string().min(1, 'HL_PRIVATE_KEY is required'),
  hlWalletAddress: z.string().optional(),
  hlUseTestnet: z.coerce.boolean().default(true),

  // Telegram
  tgBotToken: z.string().optional(),
  tgChatId: z.string().optional(),

  // Capital allocation (v3: Disc 55%, Mom 25%, EquityCross 10%, Cash 10%)
  initialCapitalUsd: z.coerce.number().positive().default(1000),
  discretionaryCapitalPct: z.coerce.number().min(0).max(100).default(55),
  momentumCapitalPct: z.coerce.number().min(0).max(100).default(25),
  equityCrossCapitalPct: z.coerce.number().min(0).max(100).default(10),
  cashBufferPct: z.coerce.number().min(0).max(100).default(10),

  // Anthropic API
  anthropicApiKey: z.string().optional(),
  anthropicModel: z.string().default('claude-haiku-4-5-20251001'),

  // Risk limits
  maxGlobalDrawdownPct: z.coerce.number().min(0).max(100).default(20),
  maxStrategyDrawdownPct: z.coerce.number().min(0).max(100).default(30),
  maxDailyLossPct: z.coerce.number().min(0).max(100).default(10),
});

type Config = z.infer<typeof configSchema>;

function loadConfig(): Config {
  const result = configSchema.safeParse({
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    hlPrivateKey: process.env.HL_PRIVATE_KEY,
    hlWalletAddress: process.env.HL_WALLET_ADDRESS,
    hlUseTestnet: process.env.HL_USE_TESTNET,
    tgBotToken: process.env.TG_BOT_TOKEN,
    tgChatId: process.env.TG_CHAT_ID,
    initialCapitalUsd: process.env.INITIAL_CAPITAL_USD,
    discretionaryCapitalPct: process.env.DISCRETIONARY_CAPITAL_PCT,
    momentumCapitalPct: process.env.MOMENTUM_CAPITAL_PCT,
    equityCrossCapitalPct: process.env.EQUITY_CROSS_CAPITAL_PCT,
    cashBufferPct: process.env.CASH_BUFFER_PCT,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    anthropicModel: process.env.ANTHROPIC_MODEL,
    maxGlobalDrawdownPct: process.env.MAX_GLOBAL_DRAWDOWN_PCT,
    maxStrategyDrawdownPct: process.env.MAX_STRATEGY_DRAWDOWN_PCT,
    maxDailyLossPct: process.env.MAX_DAILY_LOSS_PCT,
  });

  if (!result.success) {
    console.error('Configuration validation failed:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
export type { Config };
