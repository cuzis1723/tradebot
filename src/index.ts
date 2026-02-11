import { TradingEngine } from './core/engine.js';
import { GridStrategy } from './strategies/grid/index.js';
import { DiscretionaryStrategy } from './strategies/discretionary/index.js';
import { MomentumStrategy } from './strategies/momentum/index.js';
import {
  defaultGridConfig,
  defaultDiscretionaryConfig,
  defaultMomentumConfig,
} from './config/strategies.js';
import { setDiscretionaryStrategy } from './monitoring/telegram.js';
import { createChildLogger } from './monitoring/logger.js';

const log = createChildLogger('main');

async function main(): Promise<void> {
  log.info('TradeBot starting...');

  const engine = new TradingEngine();

  // Register all strategies
  const gridStrategy = new GridStrategy(defaultGridConfig);
  engine.addStrategy(gridStrategy);

  const momentumStrategy = new MomentumStrategy(defaultMomentumConfig);
  engine.addStrategy(momentumStrategy);

  const discretionaryStrategy = new DiscretionaryStrategy(defaultDiscretionaryConfig);
  engine.addStrategy(discretionaryStrategy);

  // Wire discretionary strategy to Telegram commands
  setDiscretionaryStrategy(discretionaryStrategy);

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutdown signal received');
    await engine.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught exception');
    shutdown();
  });
  process.on('unhandledRejection', (err) => {
    log.error({ err }, 'Unhandled rejection');
  });

  // Start the engine
  await engine.start();

  log.info('TradeBot is running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
