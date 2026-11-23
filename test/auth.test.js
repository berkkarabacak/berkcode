// Signing in for the web version: the shared password, sessions and the limit on wrong passwords.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-auth-'));
process.env.RUNNER_DATA_DIR = path.join(tmp, 'data');

const auth = await import('../src/auth.js');
const { db } = await import('../src/db.js');
const { publicSettings } = await import('../src/settings.js');

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const request = (cookie = '', ip = '203.0.113.5') => ({ headers: { cookie, 'user-agent': 'test' }, ip, secure: true });
const cookieFor = (token) => `other=1; ${auth.SESSION_COOKIE}=${token}`;

test('passwords are stored as salted scrypt hashes and checked exactly', () => {
  const a = auth.hashPassword('correct horse');
  const b = auth.hashPassword('correct horse');
  assert.notEqual(a, b, 'every hash has its own salt');
  assert.match(a, /^scrypt\$16384\$8\$1\$/);
  assert.equal(auth.verifyPassword('correct horse', a), true);
  assert.equal(auth.verifyPassword('correct horsE', a), false);
  assert.equal(auth.verifyPassword('', a), false);
  assert.equal(auth.verifyPassword('correct horse', 'garbage'), false);
});

test('a made-up password is easy to read out, and different every time', () => {
  const made = new Set(Array.from({ length: 40 }, () => auth.generatePassword()));
  assert.equal(made.size, 40);
  for (const p of made) assert.match(p, /^[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
});

test('the first start of a server makes a password and leaves it in a file for the administrator', () => {
  assert.equal(auth.hasPassword(), false);
  const file = auth.ensurePassword();
  assert.equal(file, auth.INITIAL_PASSWORD_FILE);
  const password = fs.readFileSync(file, 'utf8').trim();
  assert.equal(auth.checkPassword(password), true);
  assert.equal(auth.ensurePassword(), null, 'only when there is none yet');
  assert.ok(!('access_password_hash' in publicSettings()), 'the hash is never sent to the browser');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  assert.throws(() => auth.setPassword('short'), /at least 8 characters/);
  auth.setPassword('a new password');
  assert.equal(auth.checkPassword('a new password'), true);
  assert.equal(auth.checkPassword(password), false);
  assert.equal(fs.existsSync(file), false, 'the old password file no longer applies');
});

test('sessions: signed in until signing out or expiry; a new password signs everybody else out', () => {
  const mine = auth.createSession(request());
  const theirs = auth.createSession(request('', '198.51.100.7'));
  assert.ok(auth.sessionOf(request(cookieFor(mine))));
  assert.equal(auth.sessionOf(request(cookieFor('made-up-token'))), null);
  assert.equal(auth.sessionOf(request('')), null);

  const keep = auth.sessionOf(request(cookieFor(mine))).token_hash;
  auth.setPassword('another password', { keepSessionHash: keep });
  assert.ok(auth.sessionOf(request(cookieFor(mine))), 'the browser that changed it stays signed in');
  assert.equal(auth.sessionOf(request(cookieFor(theirs))), null, 'everybody else signs in again');

  auth.endSession(request(cookieFor(mine)));
  assert.equal(auth.sessionOf(request(cookieFor(mine))), null);

  const old = auth.createSession(request());
  db.prepare('UPDATE sessions SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
  assert.equal(auth.sessionOf(request(cookieFor(old))), null, 'an expired session is over');

  assert.match(auth.sessionCookie('abc', { secure: true }), /^ar_session=abc; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
});

test('wrong passwords: one address is held back after 8 tries, everybody after 100 in 15 minutes', () => {
  auth.resetLoginLimits();
  const t = Date.now();
  for (let i = 0; i < 7; i++) auth.loginFailed('203.0.113.9', t);
  assert.equal(auth.loginWait('203.0.113.9', t), 0);
  auth.loginFailed('203.0.113.9', t);
  assert.ok(auth.loginWait('203.0.113.9', t + 1000) > 800, 'about 15 minutes');
  assert.equal(auth.loginWait('198.51.100.1', t), 0, 'other addresses may still try');
  assert.equal(auth.loginWait('203.0.113.9', t + 16 * 60_000), 0, 'the wait ends');
  auth.loginSucceeded('203.0.113.9');

  auth.resetLoginLimits();
  for (let i = 0; i < 100; i++) auth.loginFailed(`10.0.${Math.floor(i / 250)}.${i % 250}`, t);
  assert.ok(auth.loginWait('192.0.2.50', t) > 0, 'a flood of wrong passwords holds everybody back for a while');
  auth.resetLoginLimits();
});
