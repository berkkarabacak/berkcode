// "Share the app with family and friends": one ZIP file of this app for another computer. It holds the app itself
// and, if the owner wants, their Claude API key (claudeapi.key, read at the first start) and settings for the new
// computer (copy-settings.json, applied once). The owner's projects, history, settings and downloads stay out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { APP_ROOT } from './paths.js';
import { getSetting, setSetting } from './settings.js';

export const COPY_SETTINGS_FILE = 'copy-settings.json';
export const SHARE_FILE_NAME = 'Claude Agent Runner.zip';
/** Settings a copy may bring for its new computer. */
const COPY_SETTINGS = ['monthly_cap_usd'];
/** Never copied (at the top of the app folder): the owner's data and projects, and downloads that are made again. */
const SKIP_TOP_DIRS = new Set(['data', 'projects', 'runtime']);
const SKIP_FILES = /^(claudeapi(\.key)?(\.txt)?|copy-settings\.json|start here\.txt|desktop\.ini|thumbs\.db)$|\.(key|log|zip|partial)$/i;

/** The app's own files: [{ full, rel }] with `rel` relative to the app folder (forward slashes). */
export function listAppFiles(root = APP_ROOT) {
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const name = entry.name.toLowerCase();
      // Links (for example a junction to node_modules) are not followed.
      if (entry.isDirectory()) {
        if (name === '.git' || name === 'node_modules' || (!rel && SKIP_TOP_DIRS.has(name))) continue;
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile() && !SKIP_FILES.test(entry.name)) {
        files.push({ full: path.join(dir, entry.name), rel: relPath });
      }
    }
  };
  walk(root, '');
  return files;
}

function startHereText(withKey) {
  return [
    'Claude Agent Runner',
    '',
    '1. If you got this as a ZIP file: right-click it, choose Properties, tick "Unblock" if you see it, and press OK.',
    '   Then right-click it again, choose "Extract All..." and press "Extract".',
    '2. Open the extracted folder and double-click start.bat.',
    '   If Windows asks whether to run it, choose "Run" (or "More info", then "Run anyway").',
    '   The first start takes a few minutes while the app downloads what it needs.',
    '3. Your browser opens the app. From then on, open it with the "Claude Agent Runner" icon on your desktop.',
    '',
    withKey
      ? 'Claude is already set up in this copy.'
      : 'For Claude projects: in the app, open Settings and paste a Claude API key.',
    'For Kimi projects: in the app, open Settings, press "Install Kimi Code CLI", then "Log in to Kimi",',
    'and sign in with the Kimi account of the person who gave you the app.',
    '',
  ].join('\r\n');
}

/**
 * Writes the ZIP to `target` (replacing an older one). `key`: the Claude API key to include, or null.
 * `settings`: settings for the new computer, for example { monthly_cap_usd: 20 }. Returns { file, files, bytes }.
 */
export async function writeShareCopy(target, { key = null, settings = {}, root = APP_ROOT } = {}) {
  const files = listAppFiles(root);
  const zip = new yazl.ZipFile();
  const mtime = new Date();
  // The files sit at the top of the ZIP, so "Extract All" gives a folder with start.bat right in it.
  for (const f of files) zip.addFile(f.full, f.rel);
  zip.addBuffer(Buffer.from(startHereText(Boolean(key))), 'START HERE.txt', { mtime });
  if (key) zip.addBuffer(Buffer.from(`${key}\n`), 'claudeapi.key', { mtime });
  const chosen = Object.fromEntries(Object.entries(settings).filter(([k, v]) => COPY_SETTINGS.includes(k) && v != null && v !== ''));
  if (Object.keys(chosen).length) zip.addBuffer(Buffer.from(`${JSON.stringify(chosen, null, 2)}\n`), COPY_SETTINGS_FILE, { mtime });
  zip.end();

  const partial = `${target}.partial`;
  try {
    await pipeline(zip.outputStream, fs.createWriteStream(partial));
    fs.renameSync(partial, target);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
  return { file: target, files: files.length, bytes: fs.statSync(target).size };
}

/**
 * Applies the settings a copy brought for this computer (copy-settings.json next to start.bat). Only once: settings
 * changed here later are kept. Returns the names of the applied settings, or null.
 */
export function applyCopySettings(root = APP_ROOT) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, COPY_SETTINGS_FILE), 'utf8');
  } catch {
    return null;
  }
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  if (getSetting('copy_settings_hash') === hash) return null;
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* a damaged file is ignored */
  }
  const applied = [];
  for (const key of COPY_SETTINGS) {
    if (data && data[key] != null && data[key] !== '') {
      setSetting(key, data[key]);
      applied.push(key);
    }
  }
  setSetting('copy_settings_hash', hash);
  return applied;
}
