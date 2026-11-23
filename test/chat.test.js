// Chatting with the agent: messages start runs, conversations group them, and messages typed while the agent
// works are handed over at its next pause. Uses the fake Kimi agent (test/fixtures/fake-kimi.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-chat-'));
process.env.RUNNER_DATA_DIR = path.join(tmp, 'data');
process.env.FAKE_KIMI_STATE = tmp;
process.env.RUNNER_KIMI_COMMAND = JSON.stringify([process.execPath, fileURLToPath(new URL('./fixtures/fake-kimi.mjs', import.meta.url))]);
process.env.RUNNER_KIMI_QUIET_MS = '800';

const express = (await import('express')).default;
const { mountMemoryMcp, setServerPort } = await import('../src/mcpHttp.js');
const { createProject, getProject } = await import('../src/projects.js');
const { ensureStandardEntries } = await import('../src/memory.js');
const {
  startRun, stopRun, stopAllRuns, activeRunId, queueMessage, queuedMessages, sendMessage, releaseQueued, removeQueued, clearQueue,
  holdQueueAfterRestart, freshSessionReason,
} = await import('../src/runner.js');
const { listConversations } = await import('../src/conversations.js');
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

const folder = path.join(tmp, 'chat-site');
fs.mkdirSync(folder, { recursive: true });
const project = createProject({ name: 'Chat site', folder, agent: 'kimi', task_prompt: 'Keep going.', schedule: { type: 'interval', minutes: 30 } });
ensureStandardEntries(project.id);

const prompts = () => fs.readFileSync(path.join(tmp, 'prompts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitIdle() {
  for (let i = 0; i < 400 && activeRunId(project.id); i++) await sleep(100);
  assert.equal(activeRunId(project.id), null, 'the run did not finish in time');
}

function run(id) {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  row.logs = db.prepare('SELECT type, content FROM run_logs WHERE run_id = ? ORDER BY seq').all(id);
  return row;
}

async function chat(message, options = {}) {
  const { runId } = startRun(project.id, 'chat', { message, ...options });
  await waitIdle();
  return run(runId);
}

test('a message starts the agent with the memory snapshot, in a conversation of its own', async () => {
  const r = await chat('Please build the home page');
  assert.equal(r.status, 'success', r.error);
  assert.equal(r.trigger, 'chat');
  assert.equal(r.user_message, 'Please build the home page');
  assert.equal(r.conversation_id, r.id);
  assert.deepEqual({ ...r.logs[0] }, { type: 'user', content: 'Please build the home page' });
  const prompt = r.logs.find((l) => l.type === 'prompt').content;
  assert.match(prompt, /# Message from the owner\n\nPlease build the home page/);
  assert.match(prompt, /<brief path="\/memories\/brief\.md">/);
  assert.match(prompt, /chatting with you in the app/);
  assert.doesNotMatch(prompt, /running unattended/);
  assert.equal(getProject(project.id).conversation_id, r.id);
  const list = listConversations(project.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Please build the home page');
  assert.equal(list[0].has_messages, true);
});

test('the next message continues the same conversation with a short prompt', async () => {
  const first = getProject(project.id).conversation_id;
  const r = await chat('Now add a contact page');
  assert.equal(r.status, 'success', r.error);
  assert.equal(r.session_mode, 'resumed');
  assert.equal(r.conversation_id, first);
  const sent = prompts().at(-1).text;
  assert.match(sent, /^\[Message from the owner, sent through the app at /);
  assert.match(sent, /Now add a contact page$/);
  assert.doesNotMatch(sent, /<brief/);
  assert.equal(listConversations(project.id).length, 1);
});

test('a question that changes nothing needs no progress entry', async () => {
  const r = await chat('[fake:answer] How many pages are there?');
  assert.equal(r.status, 'success', r.error);
  assert.ok(!r.logs.some((l) => /Asking it to write one now/.test(l.content)));
  assert.ok(r.logs.some((l) => l.type === 'assistant' && /three pages/.test(l.content)));
  assert.equal(r.agent_note, null);
});

const userMessages = (r) => r.logs.filter((l) => l.type === 'user').map((l) => l.content);

test('messages sent while the agent works wait in the queue and are handed over one at a time, in order', async () => {
  const { runId } = startRun(project.id, 'chat', { message: '[fake:wait] Build the footer' });
  await sleep(500);
  const first = sendMessage(project.id, 'Also make the footer dark');
  const second = sendMessage(project.id, 'Then add a copyright line');
  assert.equal(first.queued, true);
  assert.equal(second.queued, true);
  assert.deepEqual(queuedMessages(project.id).map((m) => m.text), ['Also make the footer dark', 'Then add a copyright line']);
  await waitIdle();
  const r = run(runId);
  assert.equal(r.status, 'success', r.error);
  assert.deepEqual(userMessages(r), ['[fake:wait] Build the footer', 'Also make the footer dark', 'Then add a copyright line']);
  assert.equal(queuedMessages(project.id).length, 0);
  // Each message is its own turn, in the order it was written.
  const sent = prompts().slice(-2).map((p) => p.text);
  assert.match(sent[0], /Also make the footer dark$/);
  assert.match(sent[1], /Then add a copyright line$/);
});

test('Stop holds the waiting messages: they are kept, but only sent when the owner says so', async () => {
  const { runId } = startRun(project.id, 'chat', { message: '[fake:slow] Take your time' });
  await sleep(600);
  const item = queueMessage(project.id, 'Send this later');
  stopRun(project.id);
  await waitIdle();
  assert.equal(run(runId).status, 'stopped');
  const held = queuedMessages(project.id);
  assert.equal(held.length, 1);
  assert.equal(held[0].id, item.id);
  assert.match(held[0].held_reason, /pressed Stop/);
  await sleep(800);
  assert.equal(activeRunId(project.id), null, 'nothing was started by itself');

  // A held message is not handed over at the agent's pauses...
  const other = await chat('[fake:answer] Anything new?');
  assert.deepEqual(userMessages(other), ['[fake:answer] Anything new?']);
  assert.ok(queuedMessages(project.id)[0].held_reason);
  assert.ok(!prompts().some((p) => /Send this later/.test(p.text)));

  // ...until the owner presses Send: then it starts the agent, as the next message of the conversation.
  const conversation = getProject(project.id).conversation_id;
  assert.equal(releaseQueued(project.id, item.id), true);
  const started = activeRunId(project.id);
  assert.ok(started, 'Send starts the agent when it is free');
  await waitIdle();
  const r = run(started);
  assert.equal(r.status, 'success', r.error);
  assert.equal(r.user_message, 'Send this later');
  assert.equal(r.conversation_id, conversation);
  assert.equal(queuedMessages(project.id).length, 0);
  assert.equal(releaseQueued(project.id, item.id), false, 'it is no longer in the queue');
});

test('"New chat" starts a fresh session in a new conversation; scheduled runs continue the current one', async () => {
  const before = getProject(project.id).conversation_id;
  const r = await chat('Start over with a blog', { newConversation: true });
  assert.equal(r.status, 'success', r.error);
  assert.equal(r.session_mode, 'fresh');
  assert.equal(r.conversation_id, r.id);
  assert.notEqual(r.conversation_id, before);
  assert.match(r.logs.find((l) => l.type === 'prompt').content, /<brief/);

  const { runId } = startRun(project.id, 'schedule');
  await waitIdle();
  const scheduled = run(runId);
  assert.equal(scheduled.conversation_id, r.id);
  assert.equal(scheduled.user_message, null);
  assert.match(scheduled.logs.find((l) => l.type === 'prompt').content, /running unattended/);

  const list = listConversations(project.id);
  assert.deepEqual(list.map((c) => c.id), [r.id, before]);
  assert.equal(list[0].title, 'Start over with a blog');
  assert.equal(list[0].runs, 2);
});

async function waitForRun(predicate, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const { id } of db.prepare('SELECT id FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 10').all(project.id)) {
      const r = run(id);
      if (predicate(r)) return r;
    }
    await sleep(100);
  }
  return assert.fail('the expected run did not happen in time');
}

test('a message sent while others still wait goes behind them', async () => {
  queueMessage(project.id, 'First in line'); // still waiting, as in the moment between two runs
  const r = sendMessage(project.id, 'Second in line');
  assert.equal(r.queued, true);
  const runId = activeRunId(project.id);
  assert.ok(runId, 'the first waiting message started the agent');
  await waitIdle();
  assert.deepEqual(userMessages(run(runId)), ['First in line', 'Second in line']);
  assert.equal(queuedMessages(project.id).length, 0);
});

test('a message for a new chat waits until the current work is over; later messages continue that chat', async () => {
  const before = getProject(project.id).conversation_id;
  const { runId: busy } = startRun(project.id, 'chat', { message: '[fake:wait] Polish the footer' });
  await sleep(300);
  const a = sendMessage(project.id, 'Start a guest book', { newConversation: true });
  const b = sendMessage(project.id, 'Add a first entry', { newConversation: true });
  assert.equal(a.item.new_conversation, true);
  assert.equal(b.item.new_conversation, false, 'the second message continues the new chat instead of starting another');
  const started = await waitForRun((r) => r.user_message === 'Start a guest book' && r.status !== 'running');
  await waitIdle();
  const first = run(busy);
  assert.deepEqual(userMessages(first), ['[fake:wait] Polish the footer'], 'the new chat was not mixed into the running one');
  assert.equal(first.conversation_id, before);
  assert.equal(started.status, 'success', started.error);
  assert.equal(started.session_mode, 'fresh');
  assert.equal(started.conversation_id, started.id);
  assert.deepEqual(userMessages(run(started.id)), ['Start a guest book', 'Add a first entry']);
  assert.equal(getProject(project.id).conversation_id, started.id);
  assert.equal(queuedMessages(project.id).length, 0);
});

test('a session that fails holds the messages waiting behind it', async () => {
  process.env.FAKE_KIMI_AUTH = '1'; // Kimi refuses to start a session, as when it is logged out
  try {
    const { runId } = startRun(project.id, 'chat', { message: 'This will not get through', newConversation: true });
    queueMessage(project.id, 'Waiting behind it');
    await waitIdle();
    assert.equal(run(runId).status, 'failed');
  } finally {
    delete process.env.FAKE_KIMI_AUTH;
  }
  const queue = queuedMessages(project.id);
  assert.equal(queue.length, 1);
  assert.match(queue[0].held_reason, /ended with a problem/);
  await sleep(800);
  assert.equal(activeRunId(project.id), null, 'nothing was started by itself');
  clearQueue(project.id);
  assert.equal(queuedMessages(project.id).length, 0);
});

test('closing the app holds the waiting messages instead of dropping them', async () => {
  const { runId } = startRun(project.id, 'chat', { message: '[fake:slow] A long job' });
  await sleep(600);
  queueMessage(project.id, 'After the long job');
  await stopAllRuns();
  const r = run(runId);
  assert.equal(r.status, 'stopped');
  assert.match(r.error, /app was closed/);
  const queue = queuedMessages(project.id);
  assert.equal(queue.length, 1);
  assert.match(queue[0].held_reason, /app was closed/);
  clearQueue(project.id);
});

test('the queue is kept in the database; after a restart nothing is sent by itself', () => {
  const kept = queueMessage(project.id, 'Kept over a restart');
  const removed = queueMessage(project.id, 'Removed by the owner');
  const stored = db.prepare('SELECT text, held_reason FROM chat_queue WHERE project_id = ? ORDER BY id').all(project.id);
  assert.deepEqual(stored.map((r) => r.text), ['Kept over a restart', 'Removed by the owner']);
  holdQueueAfterRestart();
  for (const m of queuedMessages(project.id)) assert.match(m.held_reason, /app was closed/);
  assert.equal(removeQueued(project.id, removed.id), true);
  assert.equal(removeQueued(project.id, removed.id), false, 'it was already removed');
  assert.deepEqual(queuedMessages(project.id).map((m) => m.id), [kept.id]);
  clearQueue(project.id);
  assert.equal(queuedMessages(project.id).length, 0);
});

async function waitIdleFor(projectId) {
  for (let i = 0; i < 400 && activeRunId(projectId); i++) await sleep(100);
  assert.equal(activeRunId(projectId), null, 'the run did not finish in time');
}

const longChatFolder = path.join(tmp, 'long-chat');
fs.mkdirSync(longChatFolder, { recursive: true });
const longChat = createProject({ name: 'Long chat', folder: longChatFolder, agent: 'kimi', task_prompt: 'Keep going.', schedule: { type: 'interval', minutes: 30 }, fresh_every: 2 });
ensureStandardEntries(longChat.id);

async function runIn(projectId, trigger, message = null) {
  const { runId } = startRun(projectId, trigger, message ? { message } : {});
  await waitIdleFor(projectId);
  return run(runId);
}

test('a chat keeps its conversation longer than scheduled runs do, so the agent does not forget the chat', async () => {
  const first = await runIn(longChat.id, 'chat', 'Message one');
  const second = await runIn(longChat.id, 'chat', 'Message two');
  const third = await runIn(longChat.id, 'chat', 'Message three'); // the second run on the session: a scheduled run would start fresh
  for (const r of [first, second, third]) assert.equal(r.status, 'success', r.error);
  assert.deepEqual([first, second, third].map((r) => r.conversation_id), [first.id, first.id, first.id]);
  assert.deepEqual([second, third].map((r) => r.session_mode), ['resumed', 'resumed']);

  const scheduled = await runIn(longChat.id, 'schedule');
  assert.equal(scheduled.session_mode, 'fresh');
  assert.equal(scheduled.conversation_id, scheduled.id);
  assert.ok(scheduled.logs.some((l) => l.type === 'system' && /Starting a fresh .*3 runs on the previous session/.test(l.content)));

  // The limit still applies to chats, three times as high.
  const p = getProject(longChat.id);
  assert.equal(freshSessionReason({ ...p, runs_on_session: 5 }, undefined, { chat: true }), null);
  assert.equal(freshSessionReason({ ...p, runs_on_session: 6 }, undefined, { chat: true }), '6 runs on the previous session');
  assert.equal(freshSessionReason({ ...p, runs_on_session: 2 }), '2 runs on the previous session');
});

test('if the agent session cannot be continued, a chat message starts fresh with the memory snapshot, in a new conversation', async () => {
  const p = getProject(longChat.id);
  // Kimi lost the session (for example after an update): drop it from the fake's saved sessions.
  const stateFile = path.join(tmp, 'sessions.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(saved.sessions[p.session_id], 'the session exists before');
  delete saved.sessions[p.session_id];
  fs.writeFileSync(stateFile, JSON.stringify(saved));

  const r = await runIn(longChat.id, 'chat', 'Are you still there?');
  assert.equal(r.status, 'success', r.error);
  assert.equal(r.session_mode, 'fresh (resume failed)');
  assert.equal(r.conversation_id, r.id, 'the run moved to a new conversation');
  assert.notEqual(r.conversation_id, p.conversation_id);
  assert.equal(getProject(longChat.id).conversation_id, r.id);
  const sent = prompts().filter((x) => x.sessionId === r.session_id)[0].text;
  assert.match(sent, /<brief path="\/memories\/brief\.md">/);
  assert.match(sent, /# Message from the owner\n\nAre you still there\?/);
});

test('after a session ends with a problem, the next run starts fresh instead of continuing the broken session', async () => {
  const failed = await runIn(longChat.id, 'chat', '[fake:fail] Do something that breaks the session');
  assert.equal(failed.status, 'failed');
  assert.ok(failed.turns > 0, 'the session did some work first');
  let p = getProject(longChat.id);
  assert.equal(p.fresh_pending, true);
  assert.equal(p.fresh_after_failure, true);

  const next = await runIn(longChat.id, 'chat', 'Try again please');
  assert.equal(next.status, 'success', next.error);
  assert.equal(next.session_mode, 'fresh');
  assert.equal(next.conversation_id, next.id, 'it starts a new conversation');
  assert.ok(next.logs.some((l) => l.type === 'system' && /Starting a fresh .*\(the previous session ended with a problem\)/.test(l.content)));
  p = getProject(longChat.id);
  assert.equal(p.fresh_pending, false);
  assert.equal(p.consecutive_failures, 0);
});

test('runs made before conversations existed are grouped by agent session', () => {
  const data = path.join(tmp, 'old-data');
  const dbModule = new URL('../src/db.js', import.meta.url).href;
  const load = (code) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, RUNNER_DATA_DIR: data }, encoding: 'utf8' });
  assert.equal(load(`await import(${JSON.stringify(dbModule)});`).status, 0);

  // Turn the new database back into an old one, with runs from the time before conversations.
  const old = new DatabaseSync(path.join(data, 'app.db'));
  old.exec(`DROP INDEX runs_conversation;
    ALTER TABLE runs DROP COLUMN conversation_id; ALTER TABLE runs DROP COLUMN user_message; ALTER TABLE projects DROP COLUMN conversation_id;
    INSERT INTO projects(id, name, folder, created_at) VALUES (1, 'Old', 'C:\\old', '2026-01-01');`);
  const add = old.prepare("INSERT INTO runs(id, project_id, trigger, started_at, status, session_mode) VALUES (?, 1, 'schedule', '2026-01-01', ?, ?)");
  for (const [id, status, mode] of [[1, 'success', 'fresh'], [2, 'success', 'resumed'], [3, 'skipped', null], [4, 'failed', null], [5, 'success', 'fresh (resume failed)'], [6, 'success', 'resumed']]) add.run(id, status, mode);
  old.close();

  const out = load(`const { db } = await import(${JSON.stringify(dbModule)});
    console.log(JSON.stringify({ runs: db.prepare('SELECT id, conversation_id FROM runs ORDER BY id').all(), project: db.prepare('SELECT conversation_id FROM projects WHERE id = 1').get().conversation_id }));`);
  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout.trim().split('\n').at(-1));
  assert.deepEqual(result.runs.map((r) => r.conversation_id), [1, 1, null, 1, 5, 5]);
  assert.equal(result.project, 5);
});
