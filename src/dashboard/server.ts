import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChildLogger } from '../monitoring/logger.js';
import { getDb } from '../data/storage.js';
import { getHyperliquidClient } from '../exchanges/hyperliquid/client.js';
import type { EngineStatus } from '../core/types.js';
import type { Brain } from '../core/brain.js';
import type { LLMUsageStats } from '../strategies/discretionary/llm-advisor.js';

const log = createChildLogger('dashboard');
const __dirname = dirname(fileURLToPath(import.meta.url));

interface DashboardDeps {
  getStatus: () => EngineStatus;
  getBrain: () => Brain;
}

let deps: DashboardDeps | null = null;
let cachedHtml: string | null = null;

function serveHtml(_req: IncomingMessage, res: ServerResponse): void {
  if (!cachedHtml) {
    try {
      cachedHtml = readFileSync(join(__dirname, 'index.html'), 'utf-8');
    } catch {
      // Fallback: try from source directory (dev mode with tsx)
      cachedHtml = readFileSync(join(__dirname, '..', '..', 'src', 'dashboard', 'index.html'), 'utf-8');
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(cachedHtml);
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

// === API Handlers ===

function apiBalance(_req: IncomingMessage, res: ServerResponse): void {
  const hl = getHyperliquidClient();
  hl.getAccountState().then(state => {
    const accountValue = parseFloat(state.marginSummary.accountValue);
    const marginUsed = parseFloat(state.marginSummary.totalMarginUsed);
    json(res, {
      balance: accountValue,
      marginUsed,
      freeMargin: accountValue - marginUsed,
      notionalPosition: parseFloat(state.marginSummary.totalNtlPos),
      positionCount: state.assetPositions.filter(ap => parseFloat(ap.position.szi) !== 0).length,
    });
  }).catch(err => {
    log.warn({ err }, 'Dashboard: balance fetch failed');
    json(res, { balance: 0, marginUsed: 0, freeMargin: 0, notionalPosition: 0, positionCount: 0, error: 'Failed to fetch balance' }, 500);
  });
}

function apiStatus(_req: IncomingMessage, res: ServerResponse): void {
  if (!deps) return json(res, { error: 'Engine not ready' }, 503);

  const status = deps.getStatus();
  const brain = deps.getBrain();
  const state = brain.getState();
  const usage: LLMUsageStats = brain.getAdvisor().getUsageStats();

  json(res, {
    running: status.running,
    uptime: status.uptime,
    totalPnl: status.totalPnl.toNumber(),
    totalCapital: status.totalCapital.toNumber(),
    strategies: status.strategies.map(s => ({
      id: s.id,
      name: s.name,
      status: s.status,
      pnl: s.pnl.toNumber(),
    })),
    brain: {
      regime: state.regime,
      direction: state.direction,
      riskLevel: state.riskLevel,
      confidence: state.confidence,
      reasoning: state.reasoning,
      updatedAt: state.updatedAt,
      comprehensiveCount: state.comprehensiveCount,
      urgentTriggerCount: state.urgentTriggerCount,
    },
    llm: {
      totalCalls: usage.totalCalls,
      callsToday: usage.callsToday,
      estimatedCostUsd: usage.estimatedCostUsd,
      model: usage.model,
    },
  });
}

function apiTrades(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10));
  const strategy = url.searchParams.get('strategy') ?? undefined;

  const db = getDb();
  let rows;
  if (strategy) {
    rows = db.prepare('SELECT * FROM trades WHERE strategy_id = ? ORDER BY timestamp DESC LIMIT ?').all(strategy, limit);
  } else {
    rows = db.prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?').all(limit);
  }

  json(res, rows);
}

function apiDailyPnl(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const days = Math.min(365, parseInt(url.searchParams.get('days') ?? '30', 10));

  const db = getDb();
  const rows = db.prepare(`
    SELECT date, SUM(pnl) as pnl, SUM(trades_count) as trades_count
    FROM daily_pnl
    WHERE date >= date('now', ?)
    GROUP BY date
    ORDER BY date ASC
  `).all(`-${days} days`);

  // Build cumulative PnL
  let cumulative = 0;
  const data = (rows as Array<{ date: string; pnl: number; trades_count: number }>).map(r => {
    cumulative += r.pnl;
    return { date: r.date, pnl: r.pnl, cumulative, trades: r.trades_count };
  });

  json(res, data);
}

function apiPositions(_req: IncomingMessage, res: ServerResponse): void {
  const hl = getHyperliquidClient();
  hl.getPositions().then(positions => {
    json(res, positions.map(ap => {
      const p = ap.position;
      const size = parseFloat(p.szi);
      return {
        symbol: p.coin,
        side: size >= 0 ? 'long' : 'short',
        size: Math.abs(size),
        entryPrice: parseFloat(p.entryPx),
        markPrice: Math.abs(size) > 0 ? parseFloat(p.positionValue) / Math.abs(size) : 0,
        unrealizedPnl: parseFloat(p.unrealizedPnl),
        leverage: p.leverage?.value ?? 1,
      };
    }));
  }).catch(err => {
    log.warn({ err }, 'Dashboard: positions fetch failed');
    json(res, [], 500);
  });
}

function apiScores(_req: IncomingMessage, res: ServerResponse): void {
  if (!deps) return json(res, [], 503);
  const state = deps.getBrain().getState();
  json(res, state.latestScores.map(s => ({
    symbol: s.symbol,
    totalScore: s.totalScore,
    directionBias: s.directionBias,
    bonusScore: s.bonusScore,
    flags: s.flags.map(f => ({ name: f.name, category: f.category, score: f.score, direction: f.direction, detail: f.detail })),
    timestamp: s.timestamp,
  })));
}

function apiTradeStats(_req: IncomingMessage, res: ServerResponse): void {
  const db = getDb();

  const total = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(pnl), 0) as total_pnl FROM trades').get() as { count: number; total_pnl: number };
  const wins = db.prepare('SELECT COUNT(*) as count FROM trades WHERE pnl > 0').get() as { count: number };
  const losses = db.prepare('SELECT COUNT(*) as count FROM trades WHERE pnl < 0').get() as { count: number };
  const byStrategy = db.prepare(`
    SELECT strategy_id, COUNT(*) as count, COALESCE(SUM(pnl), 0) as total_pnl,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
           SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses
    FROM trades GROUP BY strategy_id
  `).all();

  json(res, {
    totalTrades: total.count,
    totalPnl: total.total_pnl,
    wins: wins.count,
    losses: losses.count,
    winRate: total.count > 0 ? (wins.count / total.count * 100).toFixed(1) : '0',
    byStrategy,
  });
}

// === Router ===

const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
  '/': serveHtml,
  '/api/balance': apiBalance,
  '/api/status': apiStatus,
  '/api/trades': apiTrades,
  '/api/daily-pnl': apiDailyPnl,
  '/api/positions': apiPositions,
  '/api/scores': apiScores,
  '/api/stats': apiTradeStats,
};

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  const handler = routes[pathname];
  if (handler) {
    try {
      handler(req, res);
    } catch (err) {
      log.error({ err, path: pathname }, 'Dashboard handler error');
      json(res, { error: 'Internal error' }, 500);
    }
  } else {
    json(res, { error: 'Not found' }, 404);
  }
}

export function startDashboard(port: number, dependencies: DashboardDeps): void {
  deps = dependencies;

  const server = createServer(handleRequest);
  server.listen(port, '0.0.0.0', () => {
    log.info({ port }, 'Dashboard server started');
  });

  server.on('error', (err) => {
    log.error({ err }, 'Dashboard server error');
  });
}
