// Run with: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
process.env.RUNNER_DATA_DIR = tmp;
after(async () => {
  try {
    (await import('../src/db.js')).db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* the database may still be open on Windows */
  }
});

const { createProject } = await import('../src/projects.js');
const { memoryStore, ensureStandardEntries, getEntry, searchMemory, entryHistory, normalizePath, parsePlan, parseProgress } = await import('../src/memory.js');

const project = createProject({ name: 'Test', folder: tmp });
const other = createProject({ name: 'Other', folder: tmp });
const writes = [];
const mem = memoryStore(project.id, { changedBy: 'run #1', onWrite: (p) => writes.push(p) });

test('rejects paths outside /memories', () => {
  for (const bad of ['/etc/passwd', '/memories/../secret', '/memories/%2e%2e/x', 'memories/a', '/memories//a', '/memoriesX/a', '/memories/a\\b']) {
    assert.throws(() => normalizePath(bad), undefined, bad);
  }
  assert.equal(normalizePath('/memories/notes/'), '/memories/notes');
});

test('standard entries are created', () => {
  ensureStandardEntries(project.id);
  for (const p of ['/memories/brief.md', '/memories/plan.md', '/memories/progress.md', '/memories/decisions.md']) {
    assert.ok(getEntry(project.id, p), p);
  }
});

test('create / view / str_replace / insert', () => {
  let r = mem.execute({ command: 'create', path: '/memories/notes/a.md', file_text: 'line one\nline two\n' });
  assert.equal(r.isError, false);
  r = mem.execute({ command: 'view', path: '/memories/notes/a.md' });
  assert.match(r.text, /     1\tline one\n     2\tline two/);
  r = mem.execute({ command: 'view', path: '/memories/notes/a.md', view_range: [2, -1] });
  assert.doesNotMatch(r.text, /line one/);
  r = mem.execute({ command: 'str_replace', path: '/memories/notes/a.md', old_str: 'line two', new_str: 'line 2' });
  assert.equal(r.isError, false);
  assert.match(r.text, /has been edited/);
  r = mem.execute({ command: 'str_replace', path: '/memories/notes/a.md', old_str: 'line', new_str: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Multiple occurrences/);
  r = mem.execute({ command: 'insert', path: '/memories/notes/a.md', insert_line: 0, insert_text: 'first\n' });
  assert.equal(getEntry(project.id, '/memories/notes/a.md').content, 'first\nline one\nline 2\n');
  r = mem.execute({ command: 'insert', path: '/memories/notes/a.md', insert_line: 99, insert_text: 'x' });
  assert.equal(r.isError, true);
  assert.ok(writes.includes('/memories/notes/a.md'));
});

test('directory view lists entries', () => {
  const r = mem.execute({ command: 'view', path: '/memories' });
  assert.match(r.text, /up to 2 levels deep in \/memories/);
  assert.match(r.text, /\t\/memories\/notes\/a\.md/);
  assert.match(r.text, /\t\/memories\/brief\.md/);
});

test('rename and delete, root protected', () => {
  let r = mem.execute({ command: 'rename', old_path: '/memories/notes/a.md', new_path: '/memories/notes/b.md' });
  assert.equal(r.isError, false);
  assert.equal(getEntry(project.id, '/memories/notes/a.md'), null);
  r = mem.execute({ command: 'rename', old_path: '/memories/notes/b.md', new_path: '/memories/brief.md' });
  assert.equal(r.isError, true);
  r = mem.execute({ command: 'delete', path: '/memories' });
  assert.equal(r.isError, true);
  r = mem.execute({ command: 'delete', path: '/memories/notes' });
  assert.equal(r.isError, false);
  assert.equal(getEntry(project.id, '/memories/notes/b.md'), null);
});

test('projects are isolated', () => {
  const otherMem = memoryStore(other.id);
  otherMem.execute({ command: 'create', path: '/memories/secret.md', file_text: 'other project' });
  const r = mem.execute({ command: 'view', path: '/memories/secret.md' });
  assert.equal(r.isError, true);
  assert.equal(searchMemory(project.id, 'other project').length, 0);
});

test('history and restore', () => {
  mem.save('/memories/brief.md', 'version A');
  mem.save('/memories/brief.md', 'version B');
  const hist = entryHistory(project.id, '/memories/brief.md');
  const a = hist.find((h) => h.size === 'version A'.length);
  assert.ok(a);
  mem.restoreVersion(a.id);
  assert.equal(getEntry(project.id, '/memories/brief.md').content, 'version A');
});

test('full-text search and redaction', () => {
  mem.save('/memories/decisions.md', '## Use PostgreSQL\nBecause of JSON support. Key sk-ant-test-abcdef123');
  const hits = searchMemory(project.id, 'postgres');
  assert.equal(hits[0].path, '/memories/decisions.md');
  assert.doesNotMatch(getEntry(project.id, '/memories/decisions.md').content, /abcdef123/);
});

test('the session prompt contains the memory snapshot and the exact session timestamp', async () => {
  const { buildPrompt, sessionStamp } = await import('../src/prompt.js');
  mem.save('/memories/brief.md', '# Brief\nBuild a tiny calculator.');
  mem.save('/memories/plan.md', '# Plan\n- [x] Setup\n- [ ] Add division\n');
  mem.save('/memories/progress.md', '# Progress log\n\n## 2026-01-01 10:00 — First\n- Next step: Add division\n');
  const when = new Date('2026-03-04T07:05:00Z');
  const prompt = buildPrompt({ ...project, task_prompt: 'Keep going.', timezone: 'Europe/Istanbul' }, { now: when });
  assert.equal(sessionStamp('Europe/Istanbul', when), '2026-03-04 10:05');
  assert.match(prompt, /## 2026-03-04 10:05 — <short title>/);
  assert.match(prompt, /Build a tiny calculator/);
  assert.match(prompt, /- \[ \] Add division/);
  assert.doesNotMatch(prompt, /- \[x\] Setup/);
  assert.match(prompt, /Next step: Add division/);
  assert.match(prompt, /Keep going\./);
});

test('plan and progress parsing', () => {
  const steps = parsePlan('# Plan\n- [ ] a\n- [x] b\n- [~] c\n- [!] d\n');
  assert.deepEqual(steps.map((s) => s.status), ['todo', 'done', 'in_progress', 'blocked']);
  const prog = parseProgress('# Log\n## 2026-01-01 10:00 — One\n- Done: x\n## 2026-01-02 — Two\nbody');
  assert.equal(prog.length, 2);
  assert.equal(prog[1].title, '2026-01-02 — Two');
});
