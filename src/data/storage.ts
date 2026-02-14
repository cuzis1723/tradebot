import Database from 'better-sqlite3';
import { createChildLogger } from '../monitoring/logger.js';

const log = createChildLogger('storage');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database('data/tradebot.db');
    db.pragma('journal_mode = WAL');
    initSchema(db);
    log.info('Database initialized');
  }
  return db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL NOT NULL,
      fee REAL DEFAULT 0,
      pnl REAL DEFAULT 0,
      order_id TEXT,
      timestamp INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS grid_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL NOT NULL,
      grid_level INTEGER NOT NULL,
      order_id INTEGER,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS strategy_state (
      strategy_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_pnl (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id TEXT NOT NULL,
      date TEXT NOT NULL,
      pnl REAL NOT NULL,
      trades_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(strategy_id, date)
    );

    CREATE TABLE IF NOT EXISTS llm_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      response TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      model TEXT,
      timestamp INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS brain_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      regime TEXT,
      direction TEXT,
      risk_level INTEGER,
      confidence INTEGER,
      reasoning TEXT,
      directives_json TEXT,
      trigger_symbol TEXT,
      trigger_score INTEGER,
      had_trade INTEGER DEFAULT 0,
      proposal_id INTEGER,
      timestamp INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trade_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_uuid TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      entry_price REAL,
      stop_loss REAL,
      take_profit REAL,
      leverage INTEGER,
      confidence TEXT,
      rationale TEXT,
      status TEXT DEFAULT 'pending',
      brain_decision_id INTEGER,
      timestamp INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS llm_usage_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      total_calls INTEGER DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_id);
    CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
    CREATE INDEX IF NOT EXISTS idx_grid_orders_strategy ON grid_orders(strategy_id);
    CREATE INDEX IF NOT EXISTS idx_daily_pnl_date ON daily_pnl(date);
    CREATE INDEX IF NOT EXISTS idx_llm_logs_timestamp ON llm_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_llm_logs_type ON llm_logs(type);
    CREATE INDEX IF NOT EXISTS idx_brain_decisions_timestamp ON brain_decisions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_brain_decisions_type ON brain_decisions(type);
    CREATE INDEX IF NOT EXISTS idx_trade_proposals_timestamp ON trade_proposals(timestamp);
    CREATE INDEX IF NOT EXISTS idx_trade_proposals_status ON trade_proposals(status);

    CREATE TABLE IF NOT EXISTS skill_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_type TEXT NOT NULL,
      symbol TEXT,
      context_summary TEXT,
      signal_summary TEXT,
      external_summary TEXT,
      risk_summary TEXT,
      llm_input_tokens INTEGER DEFAULT 0,
      llm_output_tokens INTEGER DEFAULT 0,
      decision TEXT,
      duration_ms INTEGER,
      timestamp INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_skill_logs_timestamp ON skill_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_skill_logs_symbol ON skill_logs(symbol);

    CREATE TABLE IF NOT EXISTS signal_accuracy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      signal_name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      score INTEGER NOT NULL,
      outcome TEXT,
      price_at_signal REAL,
      price_after_1h REAL,
      price_after_4h REAL,
      timestamp INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_signal_accuracy_source_timestamp ON signal_accuracy(source, timestamp);

    CREATE TABLE IF NOT EXISTS trade_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price REAL NOT NULL,
      close_price REAL NOT NULL,
      pnl REAL NOT NULL,
      pnl_pct REAL NOT NULL,
      leverage INTEGER DEFAULT 3,
      outcome TEXT NOT NULL,
      what_worked TEXT,
      what_failed TEXT,
      lesson TEXT NOT NULL,
      signal_accuracy_json TEXT,
      improvement TEXT,
      regime TEXT,
      trigger_score INTEGER,
      timestamp INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_trade_lessons_symbol ON trade_lessons(symbol);
    CREATE INDEX IF NOT EXISTS idx_trade_lessons_outcome ON trade_lessons(outcome);
    CREATE INDEX IF NOT EXISTS idx_trade_lessons_timestamp ON trade_lessons(timestamp);

    CREATE TABLE IF NOT EXISTS narrative_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      name TEXT NOT NULL,
      value REAL NOT NULL,
      detail TEXT,
      timestamp INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_narrative_history_source_name ON narrative_history(source, name);
    CREATE INDEX IF NOT EXISTS idx_narrative_history_timestamp ON narrative_history(timestamp);

    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_type TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      telegram_message TEXT,
      telegram_sent INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_daily_reports_generated ON daily_reports(generated_at);

    CREATE TABLE IF NOT EXISTS prompt_overrides (
      key TEXT PRIMARY KEY,
      prompt_text TEXT NOT NULL,
      change_description TEXT,
      modified_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      previous_text TEXT NOT NULL,
      new_text TEXT NOT NULL,
      change_description TEXT,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_history_key ON prompt_history(key);
    CREATE INDEX IF NOT EXISTS idx_prompt_history_timestamp ON prompt_history(timestamp);
  `);
}

export function logTrade(
  strategyId: string,
  symbol: string,
  side: string,
  price: number,
  size: number,
  fee: number,
  pnl: number,
  orderId?: string,
): void {
  const database = getDb();
  database.prepare(`
    INSERT INTO trades (strategy_id, symbol, side, price, size, fee, pnl, order_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(strategyId, symbol, side, price, size, fee, pnl, orderId ?? null, Date.now());
}

export function saveStrategyState(strategyId: string, state: unknown): void {
  const database = getDb();
  database.prepare(`
    INSERT OR REPLACE INTO strategy_state (strategy_id, state_json, updated_at)
    VALUES (?, ?, datetime('now'))
  `).run(strategyId, JSON.stringify(state));
}

export function loadStrategyState<T>(strategyId: string): T | null {
  const database = getDb();
  const row = database.prepare('SELECT state_json FROM strategy_state WHERE strategy_id = ?').get(strategyId) as { state_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.state_json) as T;
}

export function updateDailyPnl(strategyId: string, pnl: number): void {
  const database = getDb();
  const date = new Date().toISOString().split('T')[0];
  database.prepare(`
    INSERT INTO daily_pnl (strategy_id, date, pnl, trades_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(strategy_id, date) DO UPDATE SET
      pnl = pnl + excluded.pnl,
      trades_count = trades_count + 1
  `).run(strategyId, date, pnl);
}

export function getTotalPnl(strategyId?: string): number {
  const database = getDb();
  if (strategyId) {
    const row = database.prepare('SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE strategy_id = ?').get(strategyId) as { total: number };
    return row.total;
  }
  const row = database.prepare('SELECT COALESCE(SUM(pnl), 0) as total FROM trades').get() as { total: number };
  return row.total;
}

export function getRecentTrades(limit: number = 10, strategyId?: string): unknown[] {
  const database = getDb();
  if (strategyId) {
    return database.prepare('SELECT * FROM trades WHERE strategy_id = ? ORDER BY timestamp DESC LIMIT ?').all(strategyId, limit);
  }
  return database.prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?').all(limit);
}

export function logLLMCall(
  type: string,
  prompt: string,
  response: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  model?: string,
): number {
  const database = getDb();
  const result = database.prepare(`
    INSERT INTO llm_logs (type, prompt, response, input_tokens, output_tokens, cost_usd, model, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(type, prompt, response, inputTokens, outputTokens, costUsd, model ?? null, Date.now());
  return Number(result.lastInsertRowid);
}

export function logBrainDecision(
  type: string,
  regime: string | null,
  direction: string | null,
  riskLevel: number | null,
  confidence: number | null,
  reasoning: string | null,
  directivesJson: string | null,
  triggerSymbol?: string,
  triggerScore?: number,
): number {
  const database = getDb();
  const result = database.prepare(`
    INSERT INTO brain_decisions (type, regime, direction, risk_level, confidence, reasoning, directives_json, trigger_symbol, trigger_score, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(type, regime, direction, riskLevel, confidence, reasoning, directivesJson, triggerSymbol ?? null, triggerScore ?? null, Date.now());
  return Number(result.lastInsertRowid);
}

export function updateBrainDecisionTrade(decisionId: number, proposalId: number): void {
  const database = getDb();
  database.prepare(`
    UPDATE brain_decisions SET had_trade = 1, proposal_id = ? WHERE id = ?
  `).run(proposalId, decisionId);
}

export function logTradeProposal(
  proposalUuid: string,
  symbol: string,
  side: string,
  entryPrice: number,
  stopLoss: number,
  takeProfit: number,
  leverage: number,
  confidence: string,
  rationale: string,
  status: string,
  brainDecisionId?: number,
): number {
  const database = getDb();
  const result = database.prepare(`
    INSERT INTO trade_proposals (proposal_uuid, symbol, side, entry_price, stop_loss, take_profit, leverage, confidence, rationale, status, brain_decision_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(proposalUuid, symbol, side, entryPrice, stopLoss, takeProfit, leverage, confidence, rationale, status, brainDecisionId ?? null, Date.now());
  return Number(result.lastInsertRowid);
}

export function updateTradeProposalStatus(proposalUuid: string, status: string): void {
  const database = getDb();
  database.prepare(`
    UPDATE trade_proposals SET status = ? WHERE proposal_uuid = ?
  `).run(status, proposalUuid);
}

export function getTradeProposalByUuid(proposalUuid: string): { rationale: string; confidence: string; trigger_score: number | null } | null {
  const database = getDb();
  const row = database.prepare(`
    SELECT tp.rationale, tp.confidence, bd.trigger_score
    FROM trade_proposals tp
    LEFT JOIN brain_decisions bd ON tp.brain_decision_id = bd.id
    WHERE tp.proposal_uuid = ?
  `).get(proposalUuid) as { rationale: string; confidence: string; trigger_score: number | null } | undefined;
  return row ?? null;
}

export function getRecentDecisions(limit: number = 50): unknown[] {
  const database = getDb();
  return database.prepare(`
    SELECT bd.*, tp.symbol as trade_symbol, tp.side as trade_side, tp.status as trade_status
    FROM brain_decisions bd
    LEFT JOIN trade_proposals tp ON bd.proposal_id = tp.id
    ORDER BY bd.timestamp DESC
    LIMIT ?
  `).all(limit);
}

export function getRecentLLMCalls(limit: number = 50): unknown[] {
  const database = getDb();
  return database.prepare(`
    SELECT id, type, input_tokens, output_tokens, cost_usd, model, timestamp
    FROM llm_logs
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit);
}

export function getRecentTradeProposals(limit: number = 50): unknown[] {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM trade_proposals ORDER BY timestamp DESC LIMIT ?
  `).all(limit);
}

export function updateLLMUsageDaily(calls: number, inputTokens: number, outputTokens: number, costUsd: number): void {
  const database = getDb();
  const date = new Date().toISOString().split('T')[0];
  database.prepare(`
    INSERT INTO llm_usage_daily (date, total_calls, total_input_tokens, total_output_tokens, total_cost_usd)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      total_calls = total_calls + excluded.total_calls,
      total_input_tokens = total_input_tokens + excluded.total_input_tokens,
      total_output_tokens = total_output_tokens + excluded.total_output_tokens,
      total_cost_usd = total_cost_usd + excluded.total_cost_usd,
      updated_at = datetime('now')
  `).run(date, calls, inputTokens, outputTokens, costUsd);
}

export function getLLMUsageTotals(): { totalCalls: number; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number } {
  const database = getDb();
  const row = database.prepare(`
    SELECT COALESCE(SUM(total_calls), 0) as totalCalls,
           COALESCE(SUM(total_input_tokens), 0) as totalInputTokens,
           COALESCE(SUM(total_output_tokens), 0) as totalOutputTokens,
           COALESCE(SUM(total_cost_usd), 0) as totalCostUsd
    FROM llm_usage_daily
  `).get() as { totalCalls: number; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number };
  return row;
}

export function getLLMUsageToday(): { totalCalls: number; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number } {
  const database = getDb();
  const date = new Date().toISOString().split('T')[0];
  const row = database.prepare(`
    SELECT COALESCE(total_calls, 0) as totalCalls,
           COALESCE(total_input_tokens, 0) as totalInputTokens,
           COALESCE(total_output_tokens, 0) as totalOutputTokens,
           COALESCE(total_cost_usd, 0) as totalCostUsd
    FROM llm_usage_daily
    WHERE date = ?
  `).get(date) as { totalCalls: number; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number } | undefined;
  return row ?? { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 };
}

export function logSkillExecution(
  pipelineType: string,
  symbol: string | null,
  contextSummary: string,
  signalSummary: string,
  externalSummary: string,
  riskSummary: string,
  llmInputTokens: number,
  llmOutputTokens: number,
  decision: string,
  durationMs: number,
): number {
  const database = getDb();
  const result = database.prepare(`
    INSERT INTO skill_logs (pipeline_type, symbol, context_summary, signal_summary, external_summary, risk_summary, llm_input_tokens, llm_output_tokens, decision, duration_ms, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(pipelineType, symbol, contextSummary, signalSummary, externalSummary, riskSummary, llmInputTokens, llmOutputTokens, decision, durationMs, Date.now());
  return Number(result.lastInsertRowid);
}

export function getRecentSkillLogs(limit: number = 10, symbol?: string): unknown[] {
  const database = getDb();
  if (symbol) {
    return database.prepare(`
      SELECT * FROM skill_logs WHERE symbol = ? ORDER BY timestamp DESC LIMIT ?
    `).all(symbol, limit);
  }
  return database.prepare(`
    SELECT * FROM skill_logs ORDER BY timestamp DESC LIMIT ?
  `).all(limit);
}

export function logSignalAccuracy(
  source: string,
  signalName: string,
  symbol: string,
  direction: string,
  score: number,
  priceAtSignal: number,
): number {
  const database = getDb();
  const result = database.prepare(`
    INSERT INTO signal_accuracy (source, signal_name, symbol, direction, score, outcome, price_at_signal, timestamp)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(source, signalName, symbol, direction, score, priceAtSignal, Date.now());
  return Number(result.lastInsertRowid);
}

export function updateSignalOutcome(
  id: number,
  outcome: 'correct' | 'incorrect',
  priceAfter1h?: number,
  priceAfter4h?: number,
): void {
  const database = getDb();
  database.prepare(`
    UPDATE signal_accuracy
    SET outcome = ?, price_after_1h = ?, price_after_4h = ?
    WHERE id = ?
  `).run(outcome, priceAfter1h ?? null, priceAfter4h ?? null, id);
}

// ============================================================
// Trade Lessons
// ============================================================

export function logTradeLesson(
  symbol: string,
  side: string,
  direction: string,
  entryPrice: number,
  closePrice: number,
  pnl: number,
  pnlPct: number,
  leverage: number,
  outcome: string,
  whatWorked: string | null,
  whatFailed: string | null,
  lesson: string,
  signalAccuracyJson: string | null,
  improvement: string | null,
  regime: string | null,
  triggerScore: number | null,
): number {
  const database = getDb();
  const result = database.prepare(`
    INSERT INTO trade_lessons (symbol, side, direction, entry_price, close_price, pnl, pnl_pct, leverage, outcome, what_worked, what_failed, lesson, signal_accuracy_json, improvement, regime, trigger_score, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(symbol, side, direction, entryPrice, closePrice, pnl, pnlPct, leverage, outcome, whatWorked, whatFailed, lesson, signalAccuracyJson, improvement, regime, triggerScore, Date.now());
  return Number(result.lastInsertRowid);
}

export function getRecentLessons(limit: number = 10, symbol?: string): Array<{
  symbol: string; side: string; direction: string; pnl: number; pnl_pct: number;
  outcome: string; lesson: string; improvement: string | null; regime: string | null;
  trigger_score: number | null; timestamp: number;
}> {
  const database = getDb();
  if (symbol) {
    return database.prepare(`
      SELECT symbol, side, direction, pnl, pnl_pct, outcome, lesson, improvement, regime, trigger_score, timestamp
      FROM trade_lessons WHERE symbol = ? ORDER BY timestamp DESC LIMIT ?
    `).all(symbol, limit) as Array<{
      symbol: string; side: string; direction: string; pnl: number; pnl_pct: number;
      outcome: string; lesson: string; improvement: string | null; regime: string | null;
      trigger_score: number | null; timestamp: number;
    }>;
  }
  return database.prepare(`
    SELECT symbol, side, direction, pnl, pnl_pct, outcome, lesson, improvement, regime, trigger_score, timestamp
    FROM trade_lessons ORDER BY timestamp DESC LIMIT ?
  `).all(limit) as Array<{
    symbol: string; side: string; direction: string; pnl: number; pnl_pct: number;
    outcome: string; lesson: string; improvement: string | null; regime: string | null;
    trigger_score: number | null; timestamp: number;
  }>;
}

export function getLessonStats(symbol?: string, direction?: string): { wins: number; losses: number; winRate: number; avgPnlPct: number } {
  const database = getDb();
  let query = 'SELECT outcome, pnl_pct FROM trade_lessons WHERE 1=1';
  const params: (string)[] = [];
  if (symbol) { query += ' AND symbol = ?'; params.push(symbol); }
  if (direction) { query += ' AND direction = ?'; params.push(direction); }
  const rows = database.prepare(query).all(...params) as Array<{ outcome: string; pnl_pct: number }>;
  const wins = rows.filter(r => r.outcome === 'win').length;
  const losses = rows.filter(r => r.outcome === 'loss').length;
  const total = rows.length;
  const avgPnlPct = total > 0 ? rows.reduce((s, r) => s + r.pnl_pct, 0) / total : 0;
  return { wins, losses, winRate: total > 0 ? wins / total : 0, avgPnlPct };
}

// ============================================================
// Narrative History
// ============================================================

export function logNarrativeSnapshot(
  source: string,
  name: string,
  value: number,
  detail: string | null,
): void {
  const database = getDb();
  database.prepare(`
    INSERT INTO narrative_history (source, name, value, detail, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(source, name, value, detail, Date.now());
}

export function getNarrativeHistory(source: string, name: string, limit: number = 10): Array<{
  value: number; detail: string | null; timestamp: number;
}> {
  const database = getDb();
  return database.prepare(`
    SELECT value, detail, timestamp FROM narrative_history
    WHERE source = ? AND name = ?
    ORDER BY timestamp DESC LIMIT ?
  `).all(source, name, limit) as Array<{ value: number; detail: string | null; timestamp: number }>;
}

export function getRecentNarratives(hoursBack: number = 2): Array<{
  source: string; name: string; value: number; detail: string | null; timestamp: number;
}> {
  const database = getDb();
  const since = Date.now() - hoursBack * 3600_000;
  return database.prepare(`
    SELECT source, name, value, detail, timestamp FROM narrative_history
    WHERE timestamp > ?
    ORDER BY timestamp DESC
  `).all(since) as Array<{ source: string; name: string; value: number; detail: string | null; timestamp: number }>;
}

// ============================================================
// Prompt Overrides
// ============================================================

export function loadPromptOverrides(): Array<{
  key: string; prompt_text: string; change_description: string | null; modified_at: number;
}> {
  const database = getDb();
  return database.prepare('SELECT * FROM prompt_overrides').all() as Array<{
    key: string; prompt_text: string; change_description: string | null; modified_at: number;
  }>;
}

export function savePromptOverride(key: string, promptText: string, changeDescription: string | null): void {
  const database = getDb();
  database.prepare(`
    INSERT OR REPLACE INTO prompt_overrides (key, prompt_text, change_description, modified_at)
    VALUES (?, ?, ?, ?)
  `).run(key, promptText, changeDescription, Date.now());
}

export function deletePromptOverride(key: string): void {
  const database = getDb();
  database.prepare('DELETE FROM prompt_overrides WHERE key = ?').run(key);
}

export function logPromptChange(
  key: string,
  previousText: string,
  newText: string,
  changeDescription: string | null,
): void {
  const database = getDb();
  database.prepare(`
    INSERT INTO prompt_history (key, previous_text, new_text, change_description, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(key, previousText, newText, changeDescription, Date.now());
}

export function getPromptHistory(key: string, limit: number = 5): Array<{
  id: number; key: string; change_description: string | null; timestamp: number;
}> {
  const database = getDb();
  return database.prepare(`
    SELECT id, key, change_description, timestamp FROM prompt_history
    WHERE key = ? ORDER BY timestamp DESC LIMIT ?
  `).all(key, limit) as Array<{
    id: number; key: string; change_description: string | null; timestamp: number;
  }>;
}

// ============================================================
// Daily Reports
// ============================================================

export function saveReport(
  reportType: string,
  generatedAt: number,
  periodStart: number,
  periodEnd: number,
  dataJson: string,
  telegramMessage: string,
  telegramSent: boolean,
): number {
  const database = getDb();
  const result = database.prepare(`
    INSERT INTO daily_reports (report_type, generated_at, period_start, period_end, data_json, telegram_message, telegram_sent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(reportType, generatedAt, periodStart, periodEnd, dataJson, telegramMessage, telegramSent ? 1 : 0);
  return Number(result.lastInsertRowid);
}

export function getReports(limit: number = 30): Array<{
  id: number; report_type: string; generated_at: number;
  period_start: number; period_end: number; telegram_sent: number;
}> {
  const database = getDb();
  return database.prepare(`
    SELECT id, report_type, generated_at, period_start, period_end, telegram_sent
    FROM daily_reports ORDER BY generated_at DESC LIMIT ?
  `).all(limit) as Array<{
    id: number; report_type: string; generated_at: number;
    period_start: number; period_end: number; telegram_sent: number;
  }>;
}

export function getReportById(id: number): {
  id: number; report_type: string; generated_at: number;
  period_start: number; period_end: number;
  data_json: string; telegram_message: string; telegram_sent: number;
} | undefined {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM daily_reports WHERE id = ?
  `).get(id) as {
    id: number; report_type: string; generated_at: number;
    period_start: number; period_end: number;
    data_json: string; telegram_message: string; telegram_sent: number;
  } | undefined;
}

export function markReportSent(id: number): void {
  const database = getDb();
  database.prepare('UPDATE daily_reports SET telegram_sent = 1 WHERE id = ?').run(id);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
