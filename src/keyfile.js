import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { KEY_FILES } from './paths.js';
import { getSetting, setSetting } from './settings.js';

/** Finds an Anthropic API key inside text, tolerating BOMs, quotes, "KEY=" prefixes and stray whitespace. */
export function extractKey(text) {
  const match = String(text ?? '').match(/sk-ant-[A-Za-z0-9_\-]{10,}/);
  return match ? match[0] : null;
}

/**
 * If a key file (claudeapi.key) sits next to start.bat, loads its key into the settings.
 * The file is only re-read into settings when its content changes, so a key typed in
 * Settings later is not overwritten by an old file.
 */
export function importKeyFile() {
  for (const file of KEY_FILES) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const key = extractKey(text);
    if (!key) return { file: path.basename(file), imported: false, reason: 'no key found in file' };
    const hash = crypto.createHash('sha256').update(key).digest('hex');
    if (getSetting('key_file_hash') === hash) return { file: path.basename(file), imported: false, reason: 'unchanged' };
    setSetting('api_key', key);
    setSetting('api_key_source', `file:${path.basename(file)}`);
    setSetting('key_file_hash', hash);
    return { file: path.basename(file), imported: true };
  }
  return null;
}
