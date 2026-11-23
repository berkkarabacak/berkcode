import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-kimi-'));
process.env.RUNNER_DATA_DIR = path.join(tmp, 'data');
process.env.FAKE_KIMI_STATE = tmp;
process.env.RUNNER_KIMI_COMMAND = JSON.stringify([process.execPath, fileURLToPath(new URL('./fixtures/fake-kimi.mjs', import.meta.url))]);
process.env.RUNNER_KIMI_QUIET_MS = '1500';

const express = (await import('express')).default;
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { mountMemoryMcp, setServerPort, grantMemoryAccess } = await import('../src/mcpHttp.js');
const { createProject, getProject, setProjectFields, updateProject } = await import('../src/projects.js');
const { ensureStandardEntries, getEntry } = await import('../src/memory.js');
const { startRun, stopRun, activeRunId } = await import('../src/runner.js');
const { db } = await import('../src/db.js');

const app = express();
app.use(express.json({ limit: '5mb' }));
mountMemoryMcp(app);
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
setServerPort(server.address().port);

after(() => {
  server.close();
  db.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function newProject(name, extra = {}) {
  const folder = path.join(tmp, name);
  fs.mkdirSync(folder, { recursive: true });
  const project = createProject({ name, folder, agent: 'kimi', task_prompt: extra.task ?? 'Keep going.', schedule: { type: 'interval', minutes: 30 } });
  if (extra.turn_limit) updateProject(project.id, { turn_limit: extra.turn_limit });
  ensureStandardEntries(project.id);
  return getProject(project.id);
}

async function runAndWait(projectId, { stopAfterMs } = {}) {
  const { runId } = startRun(projectId, 'manual');
  if (stopAfterMs) setTimeout(() => stopRun(projectId), stopAfterMs);
  for (let i = 0; i < 300 && activeRunId(projectId); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(activeRunId(projectId), null, 'run did not finish in time');
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  run.logs = db.prepare('SELECT type, content FROM run_logs WHERE run_id = ? ORDER BY seq').all(runId);
  return run;
}

test('the memory MCP endpoint serves the same tools, only while the run is open', async () => {
  const project = newProject('mcp-endpoint');
  const written = [];
  const grant = grantMemoryAccess({ projectId: project.id, changedBy: 'test', onWrite: (p) => written.push(p) });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.url)));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['memory', 'memory_search']);
  const created = await client.callTool({ name: 'memory', arguments: { command: 'create', path: '/memories/notes/x.md', file_text: 'hello' } });
  assert.match(created.content[0].text, /File created/);
  assert.deepEqual(written, ['/memories/notes/x.md']);
  const outside = await client.callTool({ name: 'memory', arguments: { command: 'view', path: '/etc/passwd' } });
  assert.equal(outside.isError, true);
  await client.close();
  grant.revoke();
  const res = await fetch(grant.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(res.status, 404);
});

test('a Kimi run uses the shared memory, records its work and picks K3.1 Pro with max thinking', async () => {
  const project = newProject('kimi-site');
  const run = await runAndWait(project.id);
  assert.equal(run.status, 'success', run.error);
  assert.equal(run.agent, 'kimi');
  assert.equal(run.model, 'kimi-code/k3.1-pro');
  assert.equal(run.effort, 'max');
  assert.equal(run.cost_usd, null);
  assert.equal(run.session_mode, 'fresh');
  assert.deepEqual(JSON.parse(run.changed_files).added, ['hello.txt']);
  assert.ok(JSON.parse(run.memory_written).includes('/memories/progress.md'));
  assert.match(getEntry(project.id, '/memories/progress.md').content, /Fake session work/);
  assert.ok(run.logs.some((l) => l.type === 'memory' && /Memory view: \/memories/.test(l.content)));
  assert.ok(run.logs.some((l) => l.type === 'assistant' && /recorded progress/.test(l.content)));
  assert.ok(run.logs.some((l) => l.type === 'prompt' && /mcp__agent_memory__memory/.test(l.content)));
  const after = getProject(project.id);
  assert.match(after.session_id, /^session_fake_/);
  assert.equal(after.runs_on_session, 1);
  const history = db.prepare("SELECT changed_by FROM memory_history WHERE project_id = ? AND path = '/memories/progress.md' ORDER BY id DESC LIMIT 1").get(project.id);
  assert.equal(history.changed_by, `run #${run.id}`);
});

test('the next Kimi run continues the same session without replaying old history into the log', async () => {
  const project = getProject(db.prepare("SELECT id FROM projects WHERE name = 'kimi-site'").get().id);
  const before = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions.json'), 'utf8')).loads;
  const run = await runAndWait(project.id);
  assert.equal(run.status, 'success', run.error);
  assert.equal(run.session_mode, 'resumed');
  assert.equal(run.session_id, project.session_id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'sessions.json'), 'utf8')).loads, before + 1);
  assert.ok(!run.logs.some((l) => /REPLAYED OLD HISTORY/.test(l.content)));
  assert.equal(getProject(project.id).runs_on_session, 2);
});

test('after the project folder moves, the next run starts a fresh session instead of continuing the old one', async () => {
  const project = newProject('kimi-moving');
  const first = await runAndWait(project.id);
  assert.equal(first.status, 'success', first.error);
  assert.equal(getProject(project.id).session_folder, project.folder);

  const moved = path.join(tmp, 'kimi-moving (new place)');
  fs.renameSync(project.folder, moved);
  updateProject(project.id, { folder: moved });
  const second = await runAndWait(project.id);
  assert.equal(second.status, 'success', second.error);
  assert.equal(second.session_mode, 'fresh');
  assert.notEqual(second.session_id, first.session_id);
  assert.ok(second.logs.some((l) => /the project folder has moved/.test(l.content)));
  assert.equal(getProject(project.id).session_folder, moved);

  const third = await runAndWait(project.id);
  assert.equal(third.session_mode, 'resumed');
  assert.equal(third.session_id, second.session_id);
});

test('a missing Kimi session falls back to a fresh session', async () => {
  const project = newProject('kimi-lost-session');
  setProjectFields(project.id, { session_id: 'session_that_does_not_exist', runs_on_session: 1 });
  const run = await runAndWait(project.id);
  assert.equal(run.status, 'success', run.error);
  assert.equal(run.session_mode, 'fresh (resume failed)');
  assert.notEqual(run.session_id, 'session_that_does_not_exist');
});

test('when Kimi forgets the progress entry, the app asks once in the same session', async () => {
  const project = newProject('kimi-forgetful', { task: 'Work on it. [fake:no-progress]' });
  const run = await runAndWait(project.id);
  assert.equal(run.status, 'success', run.error);
  assert.ok(run.logs.some((l) => l.type === 'warning' && /Asking it to write one now/.test(l.content)));
  assert.match(getEntry(project.id, '/memories/progress.md').content, /Progress written after reminder/);
});

test('when Kimi keeps working in a new turn by itself, the app waits for it instead of cutting it off', async () => {
  const project = newProject('kimi-continues', { task: 'Work on it. [fake:continues]' });
  const run = await runAndWait(project.id);
  assert.equal(run.status, 'success', run.error);
  assert.ok(!run.logs.some((l) => /Asking it to write one now/.test(l.content)), 'no reminder should be needed');
  assert.match(getEntry(project.id, '/memories/progress.md').content, /Finished in a second turn/);
  assert.ok(run.logs.some((l) => l.type === 'assistant' && /second turn/.test(l.content)));
  assert.match(run.summary, /second turn/);
});

test('while a session runs, the icon next to the clock says what is being worked on', async () => {
  const { trayStatus } = await import('../src/status.js');
  const project = newProject('kimi-tray', { task: 'Take your time. [fake:slow]' });
  const done = runAndWait(project.id, { stopAfterMs: 2500 });
  await new Promise((r) => setTimeout(r, 1200));
  const busy = trayStatus({ kimi: { installed: true, loggedIn: true } });
  assert.equal(busy.state, 'working');
  assert.match(busy.tooltip, /^Claude Agent Runner\nWorking on kimi-tray$/);
  assert.match(busy.lines[0].text, /^Working on kimi-tray \(since \d\d:\d\d\)$/);
  await done;
  assert.notEqual(trayStatus({ kimi: { installed: true, loggedIn: true } }).state, 'working');
});

test('Stop ends a Kimi run cleanly', async () => {
  const project = newProject('kimi-stop', { task: 'Take your time. [fake:slow]' });
  const run = await runAndWait(project.id, { stopAfterMs: 2500 });
  assert.equal(run.status, 'stopped');
  assert.ok(run.duration_ms < 15_000, `stop took ${run.duration_ms} ms`);
  assert.match(getEntry(project.id, '/memories/progress.md').content, /Session ended early \(run #\d+, stopped\)/);
});

test('the step limit ends a runaway Kimi run as limit reached', async () => {
  const project = newProject('kimi-loop', { task: 'Loop. [fake:loop]', turn_limit: 3 });
  const run = await runAndWait(project.id);
  assert.equal(run.status, 'limit_reached', run.error);
  assert.match(run.error, /Step limit reached \(3 steps\)/);
});

test('a logged-out Kimi gives a clear message', async () => {
  const project = newProject('kimi-logged-out');
  process.env.FAKE_KIMI_AUTH = '1';
  try {
    const run = await runAndWait(project.id);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /not logged in.*kimi login/);
  } finally {
    delete process.env.FAKE_KIMI_AUTH;
  }
});

test('the Install / Log in windows get valid PowerShell scripts', { skip: process.platform !== 'win32' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const { kimiSetupScript } = await import('../src/agents/kimiInfo.js');
  const odd = "C:\\Users\\O'Neil G\u00f6khan \u00e7\u011f\u0131\u015f\\.kimi-code\\bin\\kimi.exe";
  for (const [action, kimiPath] of [['install', null], ['login', null], ['login', odd], ['install', odd]]) {
    const script = `$Host.UI.RawUI.WindowTitle = 'Install Kimi Code CLI'\n${kimiSetupScript(action, kimiPath)}`;
    const check = `$s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script, 'utf8').toString('base64')}'))
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$null, [ref]$errors)
Write-Output "errors=$($errors.Count)"`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(check, 'utf16le').toString('base64')], { encoding: 'utf8' });
    assert.match(r.stdout, /errors=0/, `${action} ${kimiPath ?? ''}: ${r.stdout}${r.stderr}`);
    assert.match(script, /& \$kimi login/);
    if (action === 'install') assert.match(script, /irm https:\/\/code\.kimi\.com\/kimi-code\/install\.ps1 \| iex/);
  }
});

test('the agent of a project is fixed and an interval schedule is required to be regular', async () => {
  const { scheduleToCron, describeSchedule, INTERVAL_MINUTES } = await import('../src/scheduler.js');
  assert.equal(scheduleToCron({ type: 'interval', minutes: 15 }), '*/15 * * * *');
  assert.equal(scheduleToCron({ type: 'interval', minutes: 60 }), '0 * * * *');
  assert.equal(scheduleToCron({ type: 'interval', minutes: 360 }), '0 */6 * * *');
  assert.throws(() => scheduleToCron({ type: 'interval', minutes: 45 }));
  assert.equal(describeSchedule({ type: 'interval', minutes: 30 }), 'Every 30 minutes');
  assert.equal(describeSchedule({ type: 'interval', minutes: 120 }), 'Every 2 hours');
  assert.ok(INTERVAL_MINUTES.every((m) => (m < 60 ? 60 % m === 0 : 1440 % m === 0)));
  assert.throws(() => createProject({ name: 'x', folder: tmp, agent: 'gpt' }), /Choose which agent/);
});
