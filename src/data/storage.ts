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

    CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_id);
    CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
    CREATE INDEX IF NOT EXISTS idx_grid_orders_strategy ON grid_orders(strategy_id);
    CREATE INDEX IF NOT EXISTS idx_daily_pnl_date ON daily_pnl(date);
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

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
