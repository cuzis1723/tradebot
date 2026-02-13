import { TradingEngine } from './core/engine.js';
import { DiscretionaryStrategy } from './strategies/discretionary/index.js';
import { ScalpStrategy } from './strategies/scalp/index.js';
import { MomentumStrategy } from './strategies/momentum/index.js';
import { EquityCrossStrategy } from './strategies/equity-cross/index.js';
import {
  defaultDiscretionaryConfig,
  defaultScalpConfig,
  defaultMomentumConfig,
  defaultEquityCrossConfig,
  defaultBrainConfig,
} from './config/strategies.js';
import { setDiscretionaryStrategy, setScalpStrategy, setBrain, setDailyReporter } from './monitoring/telegram.js';
import { DailyReporter } from './core/daily-report.js';
import { startDashboard } from './dashboard/server.js';
import { config } from './config/index.js';
import { createChildLogger } from './monitoring/logger.js';

const log = createChildLogger('main');

async function main(): Promise<void> {
  log.info('pangjibot starting...');

  // Engine now requires BrainConfig
  const engine = new TradingEngine(defaultBrainConfig);

  // Register strategies (v3: Discretionary + Momentum + EquityCross)
  const momentumStrategy = new MomentumStrategy(defaultMomentumConfig);
  engine.addStrategy(momentumStrategy);

  const discretionaryStrategy = new DiscretionaryStrategy(defaultDiscretionaryConfig);
  engine.addStrategy(discretionaryStrategy);

  const scalpStrategy = new ScalpStrategy(defaultScalpConfig);
  engine.addStrategy(scalpStrategy);

  const equityCrossStrategy = new EquityCrossStrategy(defaultEquityCrossConfig);
  engine.addStrategy(equityCrossStrategy);

  // Wire Brain → Discretionary: Brain proposals go to Discretionary for execution
  engine.setTradeProposalHandler(async (proposal, snapshot) => {
    discretionaryStrategy.receiveProposal(proposal, snapshot);
  });

  // Wire Brain's position accessors so it can include positions in LLM context
  engine.getBrain().setPositionAccessor(() => discretionaryStrategy.getPositions());
  engine.getBrain().setScalpPositionAccessor(() => scalpStrategy.getPositions());

  // Wire Discretionary + Scalp + Brain to Telegram commands
  setDiscretionaryStrategy(discretionaryStrategy);
  setScalpStrategy(scalpStrategy);
  setBrain(engine.getBrain());

  // Daily reporter (6AM / 6PM KST automatic Telegram reports + dashboard archive)
  let dailyReporter: DailyReporter | null = null;

  // Graceful shutdown
  const shutdown = async () => {
    log.info('Shutdown signal received');
    dailyReporter?.stop();
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

  // Start daily reporter after engine is running
  dailyReporter = new DailyReporter({
    getEngineStatus: () => engine.getStatus(),
    getBrainState: () => engine.getBrain().getState(),
  });
  dailyReporter.start();
  setDailyReporter(dailyReporter);

  // Start dashboard web server
  startDashboard(config.dashboardPort, {
    getStatus: () => engine.getStatus(),
    getBrain: () => engine.getBrain(),
  });

  log.info({ dashboard: `http://0.0.0.0:${config.dashboardPort}` }, 'pangjibot is running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
