import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, samePath } from './paths.js';

function startupFile() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Claude Agent Runner.vbs');
}

/** The app folder that the Windows Startup entry starts, or null when there is no entry. */
export function startWithWindowsTarget() {
  const file = startupFile();
  if (!file || !fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf16le').replace(/^\ufeff/, '');
    const match = text.match(/shell\.CurrentDirectory = "((?:[^"]|"")*)"/);
    return match ? match[1].replace(/""/g, '"') : '';
  } catch {
    return '';
  }
}

/** True when another copy of the app, which still exists, owns the Startup entry. */
function ownedByOtherCopy(target) {
  return Boolean(target) && !samePath(target, APP_ROOT) && fs.existsSync(path.join(target, 'scripts', 'start.ps1'));
}

/** True when the Startup entry starts the app from this folder. */
export function startWithWindowsHere() {
  const target = startWithWindowsTarget();
  return Boolean(target) && samePath(target, APP_ROOT);
}

/** Adds or removes a small script in the Windows Startup folder that starts the app hidden at login. */
export function setStartWithWindows(enabled) {
  const file = startupFile();
  if (!file || process.platform !== 'win32') return { ok: false, message: 'Start with Windows is only available on Windows.' };
  if (!enabled) {
    // Never remove the entry of another copy of the app (for example the original after copying the folder).
    if (!ownedByOtherCopy(startWithWindowsTarget())) fs.rmSync(file, { force: true });
    return { ok: true };
  }
  const script = path.join(APP_ROOT, 'scripts', 'start.ps1');
  const q = (s) => s.replace(/"/g, '""');
  const vbs = [
    "' Starts Claude Agent Runner in the background when you log in to Windows.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${q(APP_ROOT)}"`,
    `shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${q(script)}"" -Background", 0, False`,
    '',
  ].join('\r\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Windows Script Host reads UTF-16 with a byte order mark, so non-English folder names work.
  fs.writeFileSync(file, `\ufeff${vbs}`, 'utf16le');
  return { ok: true };
}

/**
 * Called at startup when "Start with Windows" is on. After the app folder was copied to another computer or
 * moved, the Startup entry is missing or points at a folder that is gone: point it at this folder.
 * An entry that starts another copy of the app which still exists is left alone.
 */
export function syncStartWithWindows() {
  const target = startWithWindowsTarget();
  if (target && samePath(target, APP_ROOT)) return { changed: false, here: true };
  if (ownedByOtherCopy(target)) return { changed: false, here: false, other: target };
  const r = setStartWithWindows(true);
  return { changed: r.ok, here: r.ok };
}
