import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The full, canonical form of a path: long folder names instead of Windows 8.3 short names (C:\Users\ODINLO~1)
 * and links resolved. Parts that do not exist yet are kept as given.
 */
export function canonicalPath(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    /* does not exist (yet): canonicalise the part that does */
  }
  const parent = path.dirname(resolved);
  return parent === resolved ? resolved : path.join(canonicalPath(parent), path.basename(resolved));
}

// Canonical, so the same app folder is always recognised, however the app was started (short names, links).
export const APP_ROOT = canonicalPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
export const DATA_DIR = process.env.RUNNER_DATA_DIR ? path.resolve(process.env.RUNNER_DATA_DIR) : path.join(APP_ROOT, 'data');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const DB_BACKUP_DIR = path.join(DATA_DIR, 'db-backups');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
/** Claude Code's own config and session transcripts, kept apart from any personal Claude Code install. */
export const AGENT_HOME = path.join(DATA_DIR, 'agent');
export const RUNTIME_DIR = path.join(APP_ROOT, 'runtime');
export const RUNTIME_INFO = path.join(DATA_DIR, 'runtime.json');
export const KEY_FILES = ['claudeapi.key', 'claudeapi.key.txt', 'claudeapi.txt'].map((f) => path.join(APP_ROOT, f));
/** Default home for project folders. Inside the app folder, so copying the app folder to another PC takes them along. */
export const PROJECTS_DIR = process.env.RUNNER_PROJECTS_DIR ? path.resolve(process.env.RUNNER_PROJECTS_DIR) : path.join(APP_ROOT, 'projects');

for (const dir of [DATA_DIR, BACKUP_DIR, DB_BACKUP_DIR, LOG_DIR, TMP_DIR, AGENT_HOME, PROJECTS_DIR]) fs.mkdirSync(dir, { recursive: true });

const normalize = (p) => {
  const canonical = canonicalPath(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
};

export function samePath(a, b) {
  return Boolean(a && b) && normalize(a) === normalize(b);
}

/** True when `child` is strictly inside `parent`. */
export function isInside(child, parent) {
  return normalize(child).startsWith(normalize(parent) + path.sep);
}

export function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}
