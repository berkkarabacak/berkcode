import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './paths.js';

function startupFile() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Claude Agent Runner.vbs');
}

/** Adds or removes a small script in the Windows Startup folder that starts the app hidden at login. */
export function setStartWithWindows(enabled) {
  const file = startupFile();
  if (!file || process.platform !== 'win32') return { ok: false, message: 'Start with Windows is only available on Windows.' };
  if (!enabled) {
    fs.rmSync(file, { force: true });
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

export function startWithWindowsInstalled() {
  const file = startupFile();
  return Boolean(file && fs.existsSync(file));
}
