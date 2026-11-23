import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, DATA_DIR, BACKUP_DIR, DB_BACKUP_DIR } from './paths.js';

export { APP_ROOT, DATA_DIR, BACKUP_DIR, DB_BACKUP_DIR };

export const DB_PATH = path.join(DATA_DIR, 'app.db');

const isCorruption = (err) => [11, 26].includes(err?.errcode) || /malformed|not a database|corrupt/i.test(String(err?.message));

/**
 * Opens app.db. If it is damaged (for example because the app folder was copied while the app was writing),
 * the damaged files are kept aside and the newest daily backup is used instead, so the app still starts.
 */
function openDatabase() {
  let handle = null;
  try {
    handle = new DatabaseSync(DB_PATH);
    handle.exec('PRAGMA busy_timeout = 5000');
    const result = Object.values(handle.prepare('PRAGMA quick_check').get())[0];
    if (result !== 'ok') throw Object.assign(new Error(`the database check failed: ${result}`), { errcode: 11 });
    return { handle, recovered: null };
  } catch (err) {
    try {
      handle?.close();
    } catch {
      /* ignore */
    }
    if (!isCorruption(err)) throw err;
    const damaged = `${DB_PATH}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(DB_PATH + suffix)) fs.renameSync(DB_PATH + suffix, damaged + suffix);
    }
    const backups = fs.readdirSync(DB_BACKUP_DIR).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    const from = backups.at(-1) ?? null;
    if (from) fs.copyFileSync(path.join(DB_BACKUP_DIR, from), DB_PATH);
    console.error(`The database was damaged (${err.message}). It was kept as ${path.basename(damaged)}; ${from ? `the backup ${from} is used instead` : 'there was no backup, so a new database was started'}.`);
    const recovered = { at: new Date().toISOString(), from, reason: err.message, damaged: path.basename(damaged) };
    return { handle: new DatabaseSync(DB_PATH), recovered };
  }
}

const opened = openDatabase();
export const db = opened.handle;

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

-- Messages from the owner that wait for their turn (the queue in runner.js). held_reason: kept, but only sent
-- when the owner says so.
CREATE TABLE IF NOT EXISTS chat_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  new_conversation INTEGER NOT NULL DEFAULT 0,
  held_reason TEXT
);
CREATE INDEX IF NOT EXISTS chat_queue_project ON chat_queue(project_id, id);

-- Signed-in browsers of the web version (src/auth.js). Only a hash of each session token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);

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

/** Adds columns introduced after the first release, so older databases keep working. Returns true when added. */
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (columns.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}
addColumnIfMissing('projects', 'session_cost_total', 'REAL NOT NULL DEFAULT 0');
addColumnIfMissing('runs', 'agent_note', 'TEXT');
// Which agent works on a project ('claude' or 'kimi'); chosen when the project is created and never changed.
addColumnIfMissing('projects', 'agent', "TEXT NOT NULL DEFAULT 'claude'");
// Thinking effort for agents that support it (Kimi: low / high / max).
addColumnIfMissing('projects', 'effort', 'TEXT');
addColumnIfMissing('runs', 'agent', 'TEXT');
addColumnIfMissing('runs', 'model', 'TEXT');
addColumnIfMissing('runs', 'effort', 'TEXT');
// The full folder path the current agent session worked in. When the project folder moves (or the app folder
// is copied to another place or computer), the next run starts a fresh session instead of continuing one
// whose context still points at the old location.
if (addColumnIfMissing('projects', 'session_folder', 'TEXT')) {
  db.exec("UPDATE projects SET session_folder = folder WHERE session_id IS NOT NULL AND (folder LIKE '_:%' OR folder LIKE '\\\\%')");
}

// Conversations: every run belongs to one (scheduled runs and chat messages alike). A conversation is one agent
// session as the owner sees it; its id is the id of the run that started it. runs.user_message is the owner's
// message for runs started from the chat.
const addedConversations = addColumnIfMissing('runs', 'conversation_id', 'INTEGER');
addColumnIfMissing('runs', 'user_message', 'TEXT');
addColumnIfMissing('projects', 'conversation_id', 'INTEGER');
if (addedConversations) backfillConversations();

/** Groups the runs made before conversations existed: a fresh session starts a new conversation. */
function backfillConversations() {
  const setRun = db.prepare('UPDATE runs SET conversation_id = ? WHERE id = ?');
  const setProject = db.prepare('UPDATE projects SET conversation_id = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const { id: projectId } of db.prepare('SELECT id FROM projects').all()) {
      let current = null;
      for (const run of db.prepare("SELECT id, status, session_mode FROM runs WHERE project_id = ? ORDER BY id").all(projectId)) {
        if (run.status === 'skipped') continue;
        if (!current || String(run.session_mode ?? '').startsWith('fresh')) current = run.id;
        setRun.run(current, run.id);
      }
      if (current) setProject.run(current, projectId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
db.exec('CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id)');
// The "Resume schedule" button became the switch under Scheduled tasks.
db.exec(`UPDATE projects SET paused_reason = REPLACE(paused_reason, 'then press "Resume schedule".', 'then turn the schedule on again under Scheduled tasks.')
  WHERE paused_reason LIKE '%then press "Resume schedule".%'`);

// Shown to the owner by the browser UI until they acknowledge it.
if (opened.recovered) {
  db.prepare("INSERT INTO settings(key, value) VALUES ('db_recovered', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(opened.recovered));
}

/**
 * Folds the write-ahead log back into app.db, so that app.db alone holds all data. Done when idle: a copy of
 * the app folder made while the app is running then still has a complete, consistent database.
 */
export function checkpoint() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* busy: the next checkpoint will do it */
  }
}

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
