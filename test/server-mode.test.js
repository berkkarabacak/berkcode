// The web version end to end: the real server in server mode (RUNNER_SERVER=1), spoken to over HTTP the way nginx
// passes requests on, and the same server in normal mode to show that nothing changed for the app on a computer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = 'agents.example.test';
const ORIGIN = `https://${PUBLIC}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-server-mode-'));
const children = [];

function startServer(name, extraEnv) {
  const port = 41000 + Math.floor(Math.random() * 8000);
  const dir = path.join(tmp, name);
  const env = {
    ...process.env,
    RUNNER_DATA_DIR: path.join(dir, 'data'),
    RUNNER_PROJECTS_DIR: path.join(dir, 'projects'),
    RUNNER_KIMI_COMMAND: JSON.stringify([process.execPath, path.join(ROOT, 'test', 'fixtures', 'fake-kimi.mjs')]),
    FAKE_KIMI_STATE: dir,
    RUNNER_PUBLIC_URL: ORIGIN,
    RUNNER_SERVER: '',
    RUNNER_LAUNCHER: '',
    ...extraEnv,
  };
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), `--port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  children.push(child);
  return { port, dir, child, output: () => output };
}

function call(server, method, urlPath, { host = PUBLIC, headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path: urlPath,
        headers: {
          Host: host,
          'X-Forwarded-Proto': 'https',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length, Origin: ORIGIN } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(buffer.toString('utf8'));
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString('utf8'), json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitUp(server) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await call(server, 'GET', '/api/ping', { host: '127.0.0.1' });
      if (r.status === 200) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`The server did not start:\n${server.output()}`);
}

const cookieOf = (res) => String(res.headers['set-cookie']?.[0] ?? '').split(';')[0];

let web;
let desktop;
before(async () => {
  web = startServer('web', { RUNNER_SERVER: '1' });
  desktop = startServer('desktop', {});
  await Promise.all([waitUp(web), waitUp(desktop)]);
});

after(async () => {
  for (const child of children) {
    if (child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await exited;
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('the web version lets nobody in without the password', async () => {
  const ping = await call(web, 'GET', '/api/ping');
  assert.equal(ping.status, 200);
  assert.deepEqual(Object.keys(ping.json).sort(), ['app', 'version'], 'the health check reveals nothing about the server');

  const home = await call(web, 'GET', '/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.location, '/login');
  assert.equal((await call(web, 'GET', '/app.js')).status, 302);
  const projects = await call(web, 'GET', '/api/projects');
  assert.equal(projects.status, 401);
  assert.equal(projects.json.sign_in, true);
  assert.equal((await call(web, 'GET', '/api/events')).status, 401);
  assert.equal((await call(web, 'GET', '/preview/1/')).status, 302);

  const login = await call(web, 'GET', '/login');
  assert.equal(login.status, 200);
  assert.match(login.text, /Enter the password you were given/);
  assert.equal((await call(web, 'GET', '/style.css')).status, 200);
  assert.equal((await call(web, 'GET', '/', { host: 'evil.example' })).status, 403, 'other host names are refused');
});

test('signing in: wrong passwords are refused and held back; the right one gives a safe cookie', async () => {
  const wrong = await call(web, 'POST', '/api/login', { body: { password: 'not it' }, headers: { 'X-Forwarded-For': '203.0.113.1' } });
  assert.equal(wrong.status, 401);
  const foreign = await call(web, 'POST', '/api/login', { body: { password: 'x' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403, 'other websites cannot post to the app');

  for (let i = 0; i < 8; i++) await call(web, 'POST', '/api/login', { body: { password: `guess ${i}` }, headers: { 'X-Forwarded-For': '203.0.113.2' } });
  const held = await call(web, 'POST', '/api/login', { body: { password: 'one more guess' }, headers: { 'X-Forwarded-For': '203.0.113.2' } });
  assert.equal(held.status, 429);
  assert.match(held.json.error, /Too many wrong passwords/);

  const password = fs.readFileSync(path.join(web.dir, 'data', 'initial-password.txt'), 'utf8').trim();
  assert.match(password, /^[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
  const ok = await call(web, 'POST', '/api/login', { body: { password }, headers: { 'X-Forwarded-For': '203.0.113.3' } });
  assert.equal(ok.status, 200);
  const setCookie = String(ok.headers['set-cookie']);
  for (const part of ['ar_session=', 'HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/']) assert.ok(setCookie.includes(part), `cookie has ${part}`);
  assert.ok(!web.output().includes(password), 'the password never appears in the log');
});

async function signIn(ip = '203.0.113.4') {
  const password = fs.existsSync(path.join(web.dir, 'data', 'initial-password.txt'))
    ? fs.readFileSync(path.join(web.dir, 'data', 'initial-password.txt'), 'utf8').trim()
    : 'family password 2026';
  return cookieOf(await call(web, 'POST', '/api/login', { body: { password }, headers: { 'X-Forwarded-For': ip } }));
}

test('signed in: the app works; folders are chosen by the app; the website preview runs in a sandbox', async () => {
  const cookie = await signIn();
  const state = await call(web, 'GET', '/api/state', { cookie });
  assert.equal(state.status, 200);
  assert.equal(state.json.server_mode, true);
  assert.equal(state.json.public_url, ORIGIN);
  assert.equal((await call(web, 'GET', '/', { cookie })).status, 200);

  const created = await call(web, 'POST', '/api/projects', {
    cookie,
    body: { name: 'Family site', agent: 'kimi', folder: 'C:\\Windows', brief: 'A small family website with photos.', schedule: { type: 'interval', minutes: 60 } },
  });
  assert.equal(created.status, 200, created.text);
  const project = created.json;
  const projectsDir = path.join(web.dir, 'projects');
  assert.ok(project.folder.startsWith(projectsDir), `the folder asked for is ignored: ${project.folder}`);

  fs.writeFileSync(path.join(project.folder, 'index.html'), '<h1>Hello family</h1>');
  fs.writeFileSync(path.join(project.folder, '.env'), 'SECRET=1');
  const page = await call(web, 'GET', `/preview/${project.id}/`, { cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /Hello family/);
  assert.match(page.headers['content-security-policy'], /^sandbox /);
  assert.equal((await call(web, 'GET', `/preview/${project.id}/.env`, { cookie })).status, 403, 'hidden files are not served');
  const outside = await call(web, 'GET', `/preview/${project.id}/..%2f..%2fdata%2finitial-password.txt`, { cookie });
  assert.ok([403, 404].includes(outside.status), 'nothing outside the project folder');
  assert.ok(!outside.text.includes('-'), 'and certainly not the password');

  const zip = await call(web, 'GET', `/api/projects/${project.id}/download`, { cookie });
  assert.equal(zip.status, 200);
  assert.equal(zip.headers['content-type'], 'application/zip');
  assert.equal(zip.buffer.subarray(0, 2).toString(), 'PK');
});

test('features for one computer are switched off in the web version', async () => {
  const cookie = await signIn('203.0.113.5');
  for (const [url, body] of [['/api/open', { what: 'data' }], ['/api/pick-folder', {}], ['/api/shutdown', {}], ['/api/validate-folder', { folder: 'C:\\' }], ['/api/share-copy', {}]]) {
    const r = await call(web, 'POST', url, { cookie, body });
    assert.equal(r.status, 400, url);
  }
  const kimi = await call(web, 'POST', '/api/agents/kimi/setup', { cookie, body: { action: 'login' } });
  assert.equal(kimi.status, 400);
  assert.match(kimi.json.error, /docker exec -it agent-runner kimi login/);
});

test('changing the password signs everybody else out; signing out ends the session', async () => {
  const mine = await signIn('203.0.113.6');
  const theirs = await signIn('203.0.113.7');
  const current = fs.readFileSync(path.join(web.dir, 'data', 'initial-password.txt'), 'utf8').trim();
  assert.equal((await call(web, 'POST', '/api/password', { cookie: mine, body: { current: 'wrong', password: 'family password 2026' } })).status, 400);
  assert.equal((await call(web, 'POST', '/api/password', { cookie: mine, body: { current, password: 'family password 2026' } })).status, 200);
  assert.equal((await call(web, 'GET', '/api/projects', { cookie: theirs })).status, 401);
  assert.equal((await call(web, 'GET', '/api/projects', { cookie: mine })).status, 200);

  assert.equal((await call(web, 'POST', '/api/logout', { cookie: mine, body: {} })).status, 200);
  assert.equal((await call(web, 'GET', '/api/projects', { cookie: mine })).status, 401);
  const again = await call(web, 'POST', '/api/login', { body: { password: 'family password 2026' }, headers: { 'X-Forwarded-For': '203.0.113.8' } });
  assert.equal(again.status, 200);
});

test('without RUNNER_SERVER nothing changes: no sign-in, and only this computer may use the app', async () => {
  const ping = await call(desktop, 'GET', '/api/ping', { host: '127.0.0.1' });
  assert.ok(ping.json.root, 'the normal health check, as before');
  assert.equal((await call(desktop, 'GET', '/api/projects', { host: '127.0.0.1' })).status, 200);
  assert.equal((await call(desktop, 'GET', '/', { host: PUBLIC })).status, 403, 'a public address is refused without server mode');
  assert.ok(!fs.existsSync(path.join(desktop.dir, 'data', 'initial-password.txt')));
});
