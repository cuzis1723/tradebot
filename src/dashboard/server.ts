import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChildLogger } from '../monitoring/logger.js';
import { getDb, getRecentDecisions, getRecentTradeProposals, getReports, getReportById, getRecentLLMCalls, getRecentSkillLogs, getRecentLessons, getLessonStats, getRecentNarratives } from '../data/storage.js';
import { getHyperliquidClient } from '../exchanges/hyperliquid/client.js';
import { config } from '../config/index.js';
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
  Promise.all([hl.getAccountState(), hl.getSpotBalances()]).then(([state, spotState]) => {
    const totalBalance = spotState.balances
      .filter(b => b.coin.toUpperCase().includes('USDC'))
      .reduce((sum: number, b) => sum + parseFloat(b.total), 0);
    const marginUsed = parseFloat(state.marginSummary.totalMarginUsed);
    json(res, {
      balance: totalBalance,
      marginUsed,
      freeMargin: totalBalance - marginUsed,
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

  const hl = getHyperliquidClient();
  const startTime = Date.now() - days * 86_400_000;

  hl.getUserFillsByTime(startTime).then(fills => {
    // Aggregate closedPnl by date
    const byDate = new Map<string, { pnl: number; trades: number }>();
    for (const f of fills) {
      const pnl = parseFloat(f.closedPnl);
      if (pnl === 0) continue; // skip non-closing fills
      const date = new Date(f.time).toISOString().split('T')[0];
      const entry = byDate.get(date) ?? { pnl: 0, trades: 0 };
      entry.pnl += pnl;
      entry.trades += 1;
      byDate.set(date, entry);
    }

    // Sort by date and build cumulative
    const sorted = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    let cumulative = 0;
    const data = sorted.map(([date, d]) => {
      cumulative += d.pnl;
      return { date, pnl: d.pnl, cumulative, trades: d.trades };
    });

    json(res, data);
  }).catch(err => {
    log.warn({ err }, 'Dashboard: daily-pnl fetch failed');
    json(res, [], 500);
  });
}

function apiPortfolio(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const period = url.searchParams.get('period') ?? 'allTime';

  const hl = getHyperliquidClient();
  hl.getPortfolio().then((raw: unknown) => {
    if (!raw || !Array.isArray(raw)) {
      json(res, { error: 'No portfolio data' }, 500);
      return;
    }

    // portfolio response: array of [periodName, { accountValueHistory, pnlHistory, vlm }]
    const entry = (raw as Array<[string, { accountValueHistory: [number, string][]; pnlHistory: [number, string][]; vlm: string }]>)
      .find(([name]) => name === period);

    if (!entry) {
      json(res, { error: `Period '${period}' not found` }, 400);
      return;
    }

    const [, data] = entry;
    json(res, {
      period,
      accountValue: data.accountValueHistory.map(([ts, val]) => ({ ts, value: parseFloat(val) })),
      pnl: data.pnlHistory.map(([ts, val]) => ({ ts, value: parseFloat(val) })),
      volume: parseFloat(data.vlm),
    });
  }).catch(err => {
    log.warn({ err }, 'Dashboard: portfolio fetch failed');
    json(res, { error: 'Portfolio fetch failed' }, 500);
  });
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

function apiDecisions(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const limit = Math.min(500, parseInt(url.searchParams.get('limit') ?? '50', 10));

  try {
    const decisions = getRecentDecisions(limit);
    json(res, decisions);
  } catch (err) {
    log.warn({ err }, 'Dashboard: decisions fetch failed');
    json(res, [], 500);
  }
}

function apiProposals(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const limit = Math.min(100, parseInt(url.searchParams.get('limit') ?? '50', 10));

  try {
    const proposals = getRecentTradeProposals(limit);
    json(res, proposals);
  } catch (err) {
    log.warn({ err }, 'Dashboard: proposals fetch failed');
    json(res, [], 500);
  }
}

function apiFills(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10));

  const hl = getHyperliquidClient();
  hl.getUserFills().then(fills => {
    const recent = fills.slice(0, limit);
    json(res, recent.map(f => ({
      coin: f.coin,
      side: f.side,
      px: f.px,
      sz: f.sz,
      time: f.time,
      closedPnl: f.closedPnl,
      fee: f.fee,
      dir: f.dir,
    })));
  }).catch(err => {
    log.warn({ err }, 'Dashboard: fills fetch failed');
    json(res, [], 500);
  });
}

function apiEquity(_req: IncomingMessage, res: ServerResponse): void {
  const hl = getHyperliquidClient();
  Promise.all([hl.getAccountState(), hl.getSpotBalances()]).then(([state, spotState]) => {
    // Spot balance already includes unrealized PnL (Hyperliquid unified account)
    const totalBalance = spotState.balances
      .filter(b => b.coin.toUpperCase().includes('USDC'))
      .reduce((sum: number, b) => sum + parseFloat(b.total), 0);

    // Perp unrealized PnL calculated separately for display only
    const positions = state.assetPositions.filter(ap => parseFloat(ap.position.szi) !== 0);
    const unrealizedPnl = positions.reduce((sum, ap) => sum + parseFloat(ap.position.unrealizedPnl), 0);

    json(res, {
      balance: totalBalance,
      unrealizedPnl,
      equity: totalBalance,  // spot balance IS the account value (already includes unrealized PnL)
      timestamp: Date.now(),
    });
  }).catch(err => {
    log.warn({ err }, 'Dashboard: equity fetch failed');
    json(res, { balance: 0, unrealizedPnl: 0, equity: 0, timestamp: Date.now() }, 500);
  });
}

function apiCandles(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const symbol = url.searchParams.get('symbol');
  if (!symbol) { json(res, { error: 'symbol required' }, 400); return; }

  const interval = url.searchParams.get('interval') || '1h';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);

  const intervalMs: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 };
  const endTime = Date.now();
  const startTime = endTime - (intervalMs[interval] || 3_600_000) * limit;

  const hl = getHyperliquidClient();
  hl.getCandleSnapshot(symbol, interval, startTime, endTime)
    .then(candles => {
      json(res, (candles as Array<{ t: number; o: string; h: string; l: string; c: string }>).map(c => ({
        time: Math.floor(c.t / 1000),
        open: parseFloat(c.o),
        high: parseFloat(c.h),
        low: parseFloat(c.l),
        close: parseFloat(c.c),
      })));
    })
    .catch(err => {
      log.warn({ err, symbol, interval }, 'Dashboard: candles fetch failed');
      json(res, [], 500);
    });
}

function apiReportsList(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const limit = Math.min(100, parseInt(url.searchParams.get('limit') ?? '30', 10));

  try {
    const reports = getReports(limit);
    json(res, reports.map(r => ({
      id: r.id,
      report_type: r.report_type,
      generated_at: r.generated_at,
      period_start: r.period_start,
      period_end: r.period_end,
      telegram_sent: r.telegram_sent === 1,
    })));
  } catch (err) {
    log.warn({ err }, 'Dashboard: reports list fetch failed');
    json(res, [], 500);
  }
}

function apiReportDetail(_req: IncomingMessage, res: ServerResponse, id: number): void {
  try {
    const report = getReportById(id);
    if (!report) {
      json(res, { error: 'Report not found' }, 404);
      return;
    }
    json(res, {
      id: report.id,
      report_type: report.report_type,
      generated_at: report.generated_at,
      period_start: report.period_start,
      period_end: report.period_end,
      data: JSON.parse(report.data_json),
      telegram_message: report.telegram_message,
      telegram_sent: report.telegram_sent === 1,
    });
  } catch (err) {
    log.warn({ err }, 'Dashboard: report detail fetch failed');
    json(res, { error: 'Failed to fetch report' }, 500);
  }
}

// === DB exploration APIs ===

function apiDbSummary(_req: IncomingMessage, res: ServerResponse): void {
  try {
    const db = getDb();
    const tables = ['trades', 'brain_decisions', 'trade_proposals', 'llm_logs', 'skill_logs',
      'trade_lessons', 'signal_accuracy', 'narrative_history', 'daily_pnl', 'llm_usage_daily',
      'daily_reports', 'prompt_overrides', 'strategy_state'] as const;

    const summary: Record<string, number> = {};
    for (const table of tables) {
      const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
      summary[table] = row.count;
    }
    json(res, summary);
  } catch (err) {
    log.warn({ err }, 'Dashboard: db-summary failed');
    json(res, { error: 'Failed' }, 500);
  }
}

function apiLlmLogs(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10));
  try {
    json(res, getRecentLLMCalls(limit));
  } catch (err) {
    log.warn({ err }, 'Dashboard: llm-logs failed');
    json(res, [], 500);
  }
}

function apiSkillLogs(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const limit = Math.min(100, parseInt(url.searchParams.get('limit') ?? '30', 10));
  const symbol = url.searchParams.get('symbol') ?? undefined;
  try {
    json(res, getRecentSkillLogs(limit, symbol));
  } catch (err) {
    log.warn({ err }, 'Dashboard: skill-logs failed');
    json(res, [], 500);
  }
}

function apiLessons(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const limit = Math.min(100, parseInt(url.searchParams.get('limit') ?? '30', 10));
  const symbol = url.searchParams.get('symbol') ?? undefined;
  try {
    json(res, { lessons: getRecentLessons(limit, symbol), stats: getLessonStats(symbol) });
  } catch (err) {
    log.warn({ err }, 'Dashboard: lessons failed');
    json(res, { lessons: [], stats: {} }, 500);
  }
}

function apiNarratives(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const hours = Math.min(168, parseInt(url.searchParams.get('hours') ?? '24', 10));
  try {
    json(res, getRecentNarratives(hours));
  } catch (err) {
    log.warn({ err }, 'Dashboard: narratives failed');
    json(res, [], 500);
  }
}

function apiSignalAccuracy(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10));
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM signal_accuracy ORDER BY timestamp DESC LIMIT ?').all(limit);
    json(res, rows);
  } catch (err) {
    log.warn({ err }, 'Dashboard: signal-accuracy failed');
    json(res, [], 500);
  }
}

// === Router ===

const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
  '/': serveHtml,
  '/api/balance': apiBalance,
  '/api/status': apiStatus,
  '/api/trades': apiTrades,
  '/api/daily-pnl': apiDailyPnl,
  '/api/portfolio': apiPortfolio,
  '/api/positions': apiPositions,
  '/api/scores': apiScores,
  '/api/stats': apiTradeStats,
  '/api/decisions': apiDecisions,
  '/api/proposals': apiProposals,
  '/api/fills': apiFills,
  '/api/equity': apiEquity,
  '/api/reports': apiReportsList,
  '/api/candles': apiCandles,
  '/api/db-summary': apiDbSummary,
  '/api/llm-logs': apiLlmLogs,
  '/api/skill-logs': apiSkillLogs,
  '/api/lessons': apiLessons,
  '/api/narratives': apiNarratives,
  '/api/signal-accuracy': apiSignalAccuracy,
};

/** CRIT-9: Validate API key for /api/* routes if DASHBOARD_API_KEY is set */
function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const apiKey = config.dashboardApiKey;
  if (!apiKey) return true; // No key configured = no auth required

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  // Only protect /api/* routes, not the HTML dashboard itself
  if (!url.pathname.startsWith('/api/')) return true;

  // Accept key from ?key= query param or Authorization header
  const queryKey = url.searchParams.get('key');
  const headerKey = req.headers.authorization?.replace('Bearer ', '');

  if (queryKey === apiKey || headerKey === apiKey) return true;

  json(res, { error: 'Unauthorized. Set ?key= or Authorization: Bearer <key>' }, 401);
  return false;
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // Auth check
  if (!checkAuth(req, res)) return;

  // Pattern-based routes (e.g., /api/reports/123)
  const reportMatch = pathname.match(/^\/api\/reports\/(\d+)$/);
  if (reportMatch) {
    try {
      apiReportDetail(req, res, parseInt(reportMatch[1], 10));
    } catch (err) {
      log.error({ err, path: pathname }, 'Dashboard handler error');
      json(res, { error: 'Internal error' }, 500);
    }
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
