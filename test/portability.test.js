// Copying the app folder to another place or computer: paths, project folders and "Start with Windows".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-portable-'));
process.env.RUNNER_DATA_DIR = path.join(tmp, 'data');
// "Start with Windows" writes into %APPDATA%; point it at a temporary folder instead of the real Startup folder.
process.env.APPDATA = path.join(tmp, 'appdata');

const { APP_ROOT, PROJECTS_DIR, samePath, isInside, canonicalPath } = await import('../src/paths.js');
const { createProject, getProject, updateProject, storeFolder, resolveFolder } = await import('../src/projects.js');
const { db } = await import('../src/db.js');
const autostart = await import('../src/autostart.js');

after(() => {
  db.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('paths are compared the way Windows does', { skip: process.platform !== 'win32' }, () => {
  assert.ok(samePath('C:\\Apps\\Runner', 'c:\\apps\\runner\\'));
  assert.ok(!samePath('C:\\Apps\\Runner', 'C:\\Apps\\Runner2'));
  assert.ok(isInside('C:\\Apps\\Runner\\projects\\A', 'C:\\Apps\\Runner'));
  assert.ok(isInside('c:\\apps\\runner\\projects\\a', 'C:\\Apps\\Runner\\'));
  assert.ok(!isInside('C:\\Apps\\Runner', 'C:\\Apps\\Runner'));
  assert.ok(!isInside('C:\\Apps\\Runner2\\x', 'C:\\Apps\\Runner'));
});

test('folders inside the app folder are stored relative to it, other folders as full paths', () => {
  const inside = path.join(APP_ROOT, 'projects', 'My site');
  assert.equal(storeFolder(inside), path.join('projects', 'My site'));
  assert.equal(resolveFolder(path.join('projects', 'My site')), inside);
  const outside = path.join(tmp, 'elsewhere');
  assert.equal(storeFolder(outside), outside);
  assert.equal(resolveFolder(outside), outside);
});

test('a folder given with a short (8.3) name inside the app folder is still stored relative to it', { skip: process.platform !== 'win32' }, (t) => {
  const short = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${APP_ROOT}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();
  if (!short || short.toLowerCase() === APP_ROOT.toLowerCase()) return t.skip('the app folder has no short name here');
  assert.equal(storeFolder(path.join(short, 'projects', 'My site')), path.join('projects', 'My site'));
});

test("a project in the app's projects folder is saved so that it survives copying the app folder", () => {
  assert.ok(samePath(PROJECTS_DIR, path.join(APP_ROOT, 'projects')));
  const folder = path.join(PROJECTS_DIR, 'Portable test project');
  const project = createProject({ name: 'Portable', folder, agent: 'kimi' });
  assert.equal(db.prepare('SELECT folder FROM projects WHERE id = ?').get(project.id).folder, path.join('projects', 'Portable test project'));
  assert.equal(project.folder, folder);
  assert.equal(project.folder_in_app, true);

  const outside = path.join(tmp, 'outside project');
  updateProject(project.id, { folder: outside });
  assert.equal(db.prepare('SELECT folder FROM projects WHERE id = ?').get(project.id).folder, outside);
  assert.equal(getProject(project.id).folder_in_app, false);
});

test('short (8.3) folder names and long names are recognised as the same folder', (t) => {
  const long = canonicalPath(tmp);
  if (long.toLowerCase() === path.resolve(tmp).toLowerCase()) return t.skip('the temporary folder has no short name here');
  assert.ok(samePath(tmp, long));
  assert.ok(isInside(path.join(tmp, 'x'), long));
  assert.ok(isInside(path.join(long, 'x'), tmp));
});

test('a project folder that moved along with the Windows user folder is found again', (t) => {
  if (!isInside(tmp, os.homedir())) return t.skip('the temporary folder is not inside the user folder');
  const real = canonicalPath(path.join(tmp, 'moved project'));
  fs.mkdirSync(real);
  const fromOtherComputer = path.join('C:\\Users\\SomebodyElse', path.relative(os.homedir(), real));
  assert.equal(resolveFolder(fromOtherComputer), real);
  const missing = 'C:\\Users\\SomebodyElse\\Documents\\Not there at all';
  assert.equal(resolveFolder(missing), missing);
});

test('a damaged database (for example copied mid-write) is set aside and the newest daily backup is used', () => {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'db_recovered'").get();
  assert.equal(stored, undefined, 'a healthy database is used as it is');

  const data = path.join(tmp, 'damaged-data');
  fs.mkdirSync(path.join(data, 'db-backups'), { recursive: true });
  for (const [day, port] of [['2026-11-19', '4111'], ['2026-11-20', '4999']]) {
    const backup = new DatabaseSync(path.join(data, 'db-backups', `app-${day}.db`));
    backup.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('port', '${port}');`);
    backup.close();
  }
  fs.writeFileSync(path.join(data, 'app.db'), `SQLite format 3\0${'damaged '.repeat(2000)}`);

  const script = `
    const { getSetting } = await import(${JSON.stringify(new URL('../src/settings.js', import.meta.url).href)});
    console.log(JSON.stringify({ port: getSetting('port'), recovered: JSON.parse(getSetting('db_recovered') || 'null') }));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, RUNNER_DATA_DIR: data }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(out.port, 4999, 'the newest backup is used');
  assert.equal(out.recovered.from, 'app-2026-11-20.db');
  assert.match(out.recovered.damaged, /^app\.db\.damaged-/);
  assert.ok(fs.existsSync(path.join(data, out.recovered.damaged)), 'the damaged file is kept');
  assert.match(child.stderr, /The database was damaged/);
});

function writeStartupEntry(folder) {
  const file = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Claude Agent Runner.vbs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const vbs = ['Set shell = CreateObject("WScript.Shell")', `shell.CurrentDirectory = "${folder}"`, 'shell.Run "powershell.exe", 0, False', ''].join('\r\n');
  fs.writeFileSync(file, `\ufeff${vbs}`, 'utf16le');
  return file;
}

test("Start with Windows follows the app folder, but never takes over or removes another copy's entry", { skip: process.platform !== 'win32' }, () => {
  // No entry yet (a new computer): one is created for this folder.
  assert.equal(autostart.startWithWindowsTarget(), null);
  assert.equal(autostart.syncStartWithWindows().changed, true);
  assert.ok(autostart.startWithWindowsHere());
  assert.ok(samePath(autostart.startWithWindowsTarget(), APP_ROOT));

  // The entry starts another copy of the app that still exists: it is left alone.
  const other = path.join(tmp, 'other copy of the app');
  fs.mkdirSync(path.join(other, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(other, 'scripts', 'start.ps1'), '');
  const file = writeStartupEntry(other);
  const sync = autostart.syncStartWithWindows();
  assert.equal(sync.changed, false);
  assert.ok(samePath(sync.other, other));
  assert.ok(!autostart.startWithWindowsHere());
  // Turning it off in this copy does not remove the other copy's entry.
  autostart.setStartWithWindows(false);
  assert.ok(fs.existsSync(file));
  assert.ok(samePath(autostart.startWithWindowsTarget(), other));

  // The other copy is gone (the folder was moved): the stale entry is pointed at this folder.
  fs.rmSync(other, { recursive: true, force: true });
  assert.equal(autostart.syncStartWithWindows().changed, true);
  assert.ok(autostart.startWithWindowsHere());
  autostart.setStartWithWindows(false);
  assert.ok(!fs.existsSync(file));
});
