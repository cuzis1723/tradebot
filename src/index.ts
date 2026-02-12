import { TradingEngine } from './core/engine.js';
import { DiscretionaryStrategy } from './strategies/discretionary/index.js';
import { MomentumStrategy } from './strategies/momentum/index.js';
import {
  defaultDiscretionaryConfig,
  defaultMomentumConfig,
  defaultBrainConfig,
} from './config/strategies.js';
import { setDiscretionaryStrategy, setBrain } from './monitoring/telegram.js';
import { createChildLogger } from './monitoring/logger.js';

const log = createChildLogger('main');

async function main(): Promise<void> {
  log.info('TradeBot starting...');

  // Engine now requires BrainConfig
  const engine = new TradingEngine(defaultBrainConfig);

  // Register strategies (v3: Grid removed, only Discretionary + Momentum)
  const momentumStrategy = new MomentumStrategy(defaultMomentumConfig);
  engine.addStrategy(momentumStrategy);

  const discretionaryStrategy = new DiscretionaryStrategy(defaultDiscretionaryConfig);
  engine.addStrategy(discretionaryStrategy);

  // Wire Brain → Discretionary: Brain proposals go to Discretionary for execution
  engine.setTradeProposalHandler(async (proposal, snapshot) => {
    discretionaryStrategy.receiveProposal(proposal, snapshot);
  });

  // Wire Brain's position accessor so it can include positions in LLM context
  engine.getBrain().setPositionAccessor(() => discretionaryStrategy.getPositions());

  // Wire Discretionary + Brain to Telegram commands
  setDiscretionaryStrategy(discretionaryStrategy);
  setBrain(engine.getBrain());

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

  // Start the engine (includes Brain startup)
  await engine.start();

  log.info('TradeBot is running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
