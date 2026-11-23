// Starts the icon next to the clock (scripts/tray.ps1) while the app runs, and starts it again if it disappears.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, DATA_DIR } from './paths.js';
import { getSetting } from './settings.js';

const SCRIPT = path.join(APP_ROOT, 'scripts', 'tray.ps1');
const MAX_STARTS_PER_HOUR = 4;

let port = null;
let stopping = false;
let lastSeen = 0; // last time the icon asked for the app's status
let lastStart = 0;
let watchdog = null;
const starts = [];

/** Only the real app (started by the launcher) on Windows shows the icon; tests and development servers do not. */
export function trayAvailable() {
  return process.platform === 'win32' && process.env.RUNNER_LAUNCHER === '1' && process.env.RUNNER_NO_TRAY !== '1' && fs.existsSync(SCRIPT);
}

/** The icon asks for the status every 2 seconds; that is how the app knows it is still there. */
export function trayCheckedIn() {
  lastSeen = Date.now();
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Starts the icon unless it is running already, switched off in Settings, or keeps failing. */
export function startTray(serverPort) {
  if (serverPort) port = serverPort;
  if (!trayAvailable() || !port || stopping || !getSetting('tray_icon')) return false;
  const now = Date.now();
  if (now - lastSeen < 10_000 || now - lastStart < 30_000) return true; // running, or just started
  while (starts.length && starts[0] < now - 3600_000) starts.shift();
  if (starts.length >= MAX_STARTS_PER_HOUR) return false;
  starts.push(now);
  lastStart = now;

  // Started through a short-lived PowerShell with Start-Process, so the icon is not tied to this process:
  // when the app stops, the icon notices and removes itself cleanly (an icon killed along with the app would
  // stay next to the clock until the mouse moves over it). Windows PowerShell also needs the hidden console
  // that Start-Process gives it; started without any console, it ends at once.
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden', '-File', `"${SCRIPT}"`,
    '-Port', String(port), '-ParentPid', String(process.pid), '-DataDir', `"${DATA_DIR}"`];
  const command = `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(${args.map(quote).join(', ')})`;
  const launcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    stdio: 'ignore',
    windowsHide: true,
  });
  launcher.on('error', (err) => console.error('The icon next to the clock could not be started:', err.message));
  launcher.on('exit', (code) => {
    if (code !== 0) console.error(`The icon next to the clock could not be started (exit code ${code}).`);
  });
  return true;
}

/** Starts the icon when the app starts, and checks every 30 seconds that it is still there. */
export function initTray(serverPort) {
  startTray(serverPort);
  if (!watchdog) watchdog = setInterval(() => startTray(), 30_000).unref();
}

/** Called when the app shuts down: the icon closes itself once the app is gone. */
export function trayShuttingDown() {
  stopping = true;
}
