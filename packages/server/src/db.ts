import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

export type Database = DatabaseSyncType;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    preset TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT,
    anthropic_base_url TEXT,
    api_key_enc TEXT,
    key_hint TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 100,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL,
    profile TEXT,
    monthly_budget_usd REAL,
    rpm INTEGER,
    allowed_providers TEXT,
    expires_at INTEGER,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    key_id TEXT,
    tenant TEXT,
    provider TEXT,
    model TEXT,
    protocol TEXT,
    path TEXT,
    stream INTEGER NOT NULL DEFAULT 0,
    status INTEGER,
    latency_ms INTEGER,
    ttfb_ms INTEGER,
    overhead_ms REAL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    estimated INTEGER NOT NULL DEFAULT 0,
    optimizer_saved INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    baseline_cost REAL NOT NULL DEFAULT 0,
    cache_hit INTEGER NOT NULL DEFAULT 0,
    profile TEXT,
    lossy INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
  CREATE INDEX IF NOT EXISTS idx_requests_key_ts ON requests(key_id, ts);
  CREATE TABLE IF NOT EXISTS response_cache (
    key TEXT PRIMARY KEY,
    tenant TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    body BLOB NOT NULL,
    usage TEXT NOT NULL,
    model TEXT,
    provider TEXT,
    size INTEGER NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_cache_expires ON response_cache(expires_at);
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    ip TEXT
  );
  `,
];

/** Silence Node's ExperimentalWarning for node:sqlite only. */
function quietSqliteWarning(): void {
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    const type = typeof args[0] === "string" ? args[0] : (args[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && /SQLite/i.test(text)) return;
    return (original as (...a: unknown[]) => void)(warning, ...args);
  }) as typeof process.emitWarning;
}

export async function openDatabase(dataDir: string | ":memory:"): Promise<Database> {
  quietSqliteWarning();
  const { DatabaseSync } = await import("node:sqlite");
  let path = ":memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    path = join(dataDir, "tokensip.db");
  }
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
  );
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
