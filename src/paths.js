import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

for (const dir of [DATA_DIR, BACKUP_DIR, DB_BACKUP_DIR, LOG_DIR, TMP_DIR, AGENT_HOME]) fs.mkdirSync(dir, { recursive: true });

export function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}
