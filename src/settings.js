import { db } from './db.js';

export const DEFAULTS = {
  api_key: '',
  api_key_source: '',
  key_file_hash: '',
  default_model: 'claude-sonnet-5-5',
  default_turn_limit: 50,
  default_budget_usd: 5,
  default_max_minutes: 60,
  monthly_cap_usd: 100,
  port: 4280,
  start_with_windows: false,
  catch_up_missed: true,
  backup_size_limit_mb: 500,
  budget_paused_month: '',
  heartbeat: '',
};

/** Allowed ranges for numeric settings; out-of-range or non-numeric values fall back to the default. */
const NUMERIC = {
  default_turn_limit: [1, 500],
  default_budget_usd: [0.1, 1000],
  default_max_minutes: [1, 24 * 60],
  monthly_cap_usd: [1, 100000],
  port: [1024, 65535],
  backup_size_limit_mb: [10, 100000],
};
const BOOLEAN = new Set(['start_with_windows', 'catch_up_missed']);
const PRIVATE = new Set(['api_key', 'heartbeat', 'key_file_hash']);

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function normalize(key, value) {
  if (key in NUMERIC) {
    const n = Number(value);
    const [min, max] = NUMERIC[key];
    if (!Number.isFinite(n)) return DEFAULTS[key];
    return Math.min(max, Math.max(min, n));
  }
  if (BOOLEAN.has(key)) return value === true || value === 'true';
  return value == null ? '' : String(value);
}

export function getSetting(key) {
  const row = getStmt.get(key);
  if (!row) return DEFAULTS[key];
  return normalize(key, row.value);
}

export function setSetting(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
  setStmt.run(key, String(normalize(key, value)));
}

export function getAllSettings() {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = getSetting(key);
  return out;
}

export function maskKey(key) {
  if (!key) return '';
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/** Settings safe to send to the browser: the API key is never included. */
export function publicSettings() {
  const all = getAllSettings();
  const out = {};
  for (const [key, value] of Object.entries(all)) if (!PRIVATE.has(key)) out[key] = value;
  return { ...out, has_api_key: Boolean(all.api_key), api_key_masked: maskKey(all.api_key) };
}
