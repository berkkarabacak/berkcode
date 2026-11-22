import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, DATA_DIR, BACKUP_DIR, DB_BACKUP_DIR } from './paths.js';

export { APP_ROOT, DATA_DIR, BACKUP_DIR, DB_BACKUP_DIR };

export const DB_PATH = path.join(DATA_DIR, 'app.db');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  folder TEXT NOT NULL,
  task_prompt TEXT NOT NULL DEFAULT '',
  model TEXT,
  schedule TEXT NOT NULL DEFAULT '{"type":"daily","time":"09:00"}',
  timezone TEXT NOT NULL DEFAULT 'Europe/Istanbul',
  enabled INTEGER NOT NULL DEFAULT 0,
  restore_mode TEXT NOT NULL DEFAULT 'zip',
  session_id TEXT,
  runs_on_session INTEGER NOT NULL DEFAULT 0,
  fresh_every INTEGER NOT NULL DEFAULT 10,
  fresh_pending INTEGER NOT NULL DEFAULT 0,
  turn_limit INTEGER,
  budget_usd REAL,
  max_minutes INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  session_id TEXT,
  session_mode TEXT,
  turns INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  summary TEXT,
  changed_files TEXT,
  memory_written TEXT,
  restore_ref TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id, id);

CREATE TABLE IF NOT EXISTS run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_logs_run ON run_logs(run_id, seq);

CREATE TABLE IF NOT EXISTS memory_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, path)
);

CREATE TABLE IF NOT EXISTS memory_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  previous_content TEXT,
  action TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_history_path ON memory_history(project_id, path, id);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  path, content, content='memory_entries', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(rowid, path, content) VALUES (new.id, new.path, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, path, content) VALUES ('delete', old.id, old.path, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, path, content) VALUES ('delete', old.id, old.path, old.content);
  INSERT INTO memory_fts(rowid, path, content) VALUES (new.id, new.path, new.content);
END;
`);

/** Adds columns introduced after the first release, so older databases keep working. */
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumnIfMissing('projects', 'session_cost_total', 'REAL NOT NULL DEFAULT 0');
addColumnIfMissing('runs', 'agent_note', 'TEXT');

export const now = () => new Date().toISOString();

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function backupDatabaseIfDue() {
  const stamp = new Date().toISOString().slice(0, 10);
  const target = path.join(DB_BACKUP_DIR, `app-${stamp}.db`);
  if (fs.existsSync(target)) return;
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const files = fs.readdirSync(DB_BACKUP_DIR).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - 7))) {
    fs.rmSync(path.join(DB_BACKUP_DIR, old), { force: true });
  }
}
