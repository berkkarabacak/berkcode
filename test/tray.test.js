// The icon next to the clock: the status it shows (src/status.js) and the PowerShell script that draws it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-tray-'));
process.env.RUNNER_DATA_DIR = path.join(tmp, 'data');

const { trayStatus, formatWhen, TOOLTIP_MAX } = await import('../src/status.js');
const { trayAvailable, startTray } = await import('../src/tray.js');
const { createProject, updateProject, setProjectFields, deleteProject, listProjects } = await import('../src/projects.js');
const { setSetting } = await import('../src/settings.js');
const { db } = await import('../src/db.js');

const SCRIPT = fileURLToPath(new URL('../scripts/tray.ps1', import.meta.url));
const ready = { installed: true, loggedIn: true };

after(() => {
  db.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function folder(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function reset() {
  for (const p of listProjects()) deleteProject(p.id);
  setSetting('api_key', '');
  setSetting('db_recovered', '');
}

test('the icon never starts in tests or development servers', () => {
  assert.equal(trayAvailable(), false);
  assert.equal(startTray(4280), false);
});

test('times are shown as on the clock: today, tomorrow or the weekday', () => {
  const now = new Date(2026, 10, 23, 10, 0);
  assert.equal(formatWhen(new Date(2026, 10, 23, 14, 5).toISOString(), now), '14:05');
  assert.equal(formatWhen(new Date(2026, 10, 24, 9, 0).toISOString(), now), 'tomorrow 09:00');
  assert.equal(formatWhen(new Date(2026, 10, 26, 9, 0).toISOString(), now), 'Thu 09:00');
});

test('idle: shows the next scheduled run, or that no schedule is on', () => {
  reset();
  let s = trayStatus({ kimi: ready });
  assert.equal(s.state, 'idle');
  assert.equal(s.tooltip, 'Claude Agent Runner\nRunning, no schedule is on');
  assert.deepEqual(s.lines, [{ kind: 'info', text: 'No schedule is on' }]);

  setSetting('api_key', 'sk-ant-test-0000');
  const p = createProject({ name: 'Family site', folder: folder('family'), agent: 'claude', schedule: { type: 'interval', minutes: 30 }, enabled: true });
  s = trayStatus({ kimi: ready });
  assert.equal(s.state, 'idle');
  assert.match(s.tooltip, /^Claude Agent Runner\nNext run \d\d:\d\d$|^Claude Agent Runner\nNext run tomorrow \d\d:\d\d$/);
  assert.match(s.lines[0].text, /^Next run: Family site, /);
  updateProject(p.id, { enabled: false });
  assert.equal(trayStatus({ kimi: ready }).lines[0].text, 'No schedule is on');
});

test('needs attention: missing API key, missing folder, repeated failures, Kimi, damaged database', () => {
  reset();
  const claude = createProject({ name: 'Shop', folder: folder('shop'), agent: 'claude' });
  let s = trayStatus({ kimi: ready });
  assert.equal(s.state, 'attention');
  assert.equal(s.tooltip, 'Claude Agent Runner\nNo Claude API key is set');
  setSetting('api_key', 'sk-ant-test-0000');
  assert.equal(trayStatus({ kimi: ready }).state, 'idle');

  setProjectFields(claude.id, { consecutive_failures: 3, paused_reason: 'The schedule was paused after 3 failed runs in a row.' });
  s = trayStatus({ kimi: ready });
  assert.deepEqual(s.lines.filter((l) => l.kind === 'attention').map((l) => l.text), ['Shop: paused after 3 failed runs']);
  updateProject(claude.id, { enabled: true });
  assert.equal(trayStatus({ kimi: ready }).state, 'idle', 'resuming the schedule clears it');

  createProject({ name: 'Gone', folder: path.join(tmp, 'does not exist'), agent: 'claude' });
  assert.ok(trayStatus({ kimi: ready }).lines.some((l) => l.text === 'Gone: project folder not found'));

  createProject({ name: 'Kimi site', folder: folder('kimi'), agent: 'kimi' });
  assert.ok(trayStatus({ kimi: { installed: false, loggedIn: false } }).lines.some((l) => l.text === 'Kimi Code CLI is not installed'));
  assert.ok(trayStatus({ kimi: { installed: true, loggedIn: false, message: 'Kimi Code CLI is installed but not logged in.' } }).lines.some((l) => l.text === 'Kimi Code CLI is not logged in'));
  assert.ok(!trayStatus({ kimi: ready }).lines.some((l) => /Kimi Code CLI/.test(l.text)));
  assert.ok(!trayStatus({ kimi: null }).lines.some((l) => /Kimi Code CLI/.test(l.text)), 'unknown is not reported as a problem');

  setSetting('db_recovered', JSON.stringify({ from: 'app-2026-11-22.db' }));
  s = trayStatus({ kimi: { installed: false, loggedIn: false } });
  assert.equal(s.state, 'attention');
  assert.equal(s.tooltip, 'Claude Agent Runner\n3 things need your attention');
  assert.equal(s.lines.at(-1).kind, 'info');
});

test('texts always fit: the tooltip stays within the Windows limit', () => {
  reset();
  setSetting('api_key', 'sk-ant-test-0000');
  createProject({ name: 'A project with a really very long name that goes on and on', folder: path.join(tmp, 'missing'), agent: 'claude' });
  const s = trayStatus({ kimi: ready });
  assert.ok(s.tooltip.length <= TOOLTIP_MAX, s.tooltip);
  assert.ok(s.tooltip.endsWith('…'));
  assert.ok(s.lines.every((l) => l.text.length <= 90));
});

test('the tray script is valid PowerShell and can build its icon and menu on this computer', { skip: process.platform !== 'win32' }, () => {
  const parse = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replace(/'/g, "''")}', [ref]$null, [ref]$e); "errors=$($e.Count)"`], { encoding: 'utf8' });
  assert.match(parse.stdout, /errors=0/, parse.stderr);
  assert.equal(fs.readFileSync(SCRIPT).some((b) => b > 127), false, 'Windows PowerShell 5.1 needs the script to be plain ASCII');
  const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', SCRIPT, '-SelfTest'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  // The app icon stores PNG images; decoding them as bitmaps gives a noisy icon.
  assert.match(run.stdout, /tray self-test ok: 7 menu items, tooltip 63 characters, icon from png \d+px/);
});
