// Signing in, for the web version (server mode): one shared password for everybody. The password is kept only as a
// scrypt hash; a signed-in browser holds a random session token in a cookie, of which only the SHA-256 is stored.
// Wrong passwords are rate-limited per address and overall.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, now } from './db.js';
import { getSetting, setSetting } from './settings.js';
import { APP_ROOT, DATA_DIR } from './paths.js';
import { PUBLIC_URL } from './serverMode.js';

export const SESSION_COOKIE = 'ar_session';
const SESSION_DAYS = 30;
export const MIN_PASSWORD_LENGTH = 8;
/** Where a newly made password is left for the server's administrator (readable by the app's own user only). */
export const INITIAL_PASSWORD_FILE = path.join(DATA_DIR, 'initial-password.txt');

// ---------- The shared password ----------

const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  try {
    const actual = crypto.scryptSync(String(password ?? ''), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export const hasPassword = () => Boolean(getSetting('access_password_hash'));
export const checkPassword = (password) => verifyPassword(password, getSetting('access_password_hash'));

/**
 * Sets the shared password and signs everybody out, except the session with `keepSessionHash` (the browser that
 * changed it). A password file left from the first start no longer applies, so it is removed.
 */
export function setPassword(password, { keepSessionHash = null } = {}) {
  const value = String(password ?? '');
  if (value.trim().length < MIN_PASSWORD_LENGTH) throw new Error(`The password needs at least ${MIN_PASSWORD_LENGTH} characters.`);
  setSetting('access_password_hash', hashPassword(value));
  if (keepSessionHash) db.prepare('DELETE FROM sessions WHERE token_hash != ?').run(keepSessionHash);
  else db.prepare('DELETE FROM sessions').run();
  fs.rmSync(INITIAL_PASSWORD_FILE, { force: true });
}

const WORDS = `apple arrow autumn badge baker bamboo banana beach berry birch blossom border bottle branch bread breeze brick
bridge brook brush bubble bucket butter button cabin cactus camel candle canyon carpet carrot castle cedar chalk cherry
chess cider circle cliff clock cloud clover coast cocoa coffee comet coral cotton cousin crane crayon cricket daisy dancer
delta desert diamond dinner dolphin dragon dream drum eagle earth echo elbow ember engine falcon feather fence fern ferry
fiddle field finch flame flute forest fossil fox garden garlic giant ginger glacier globe grape gravel guitar hammer harbor
harvest hazel helmet heron hill honey horizon island ivory jacket jasmine jelly jungle kettle kitten koala ladder lagoon
lantern lemon letter lily lime lizard lobster lotus magnet mango maple marble meadow melon mint mirror monkey moon mosaic
mountain muffin napkin needle nest noodle oasis ocean olive onion orange orbit orchid otter owl paddle palace panda paper
parrot peach pearl pebble pencil pepper piano pillow pine planet plum pocket pond poppy potato prairie puzzle quilt rabbit
radio rainbow raven river robin rocket saddle sailor salmon sandal scarf shadow shell silver sketch sleigh slipper snow
sparrow spider spoon spring star stone storm sugar summer sunset swan table teapot temple thunder tiger timber tomato
tower trail tulip tunnel turtle valley velvet violin volcano wagon walnut water whale wheat willow window winter wizard
wolf yogurt zebra`.split(/\s+/);

/** A password that is easy to read out on the phone, such as "maple-river-candle-4821". */
export function generatePassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${pick()}-${crypto.randomInt(1000, 10000)}`;
}

/** Writes a file only the app's own user can read (replacing an older one). */
export function writePrivateFile(file, text) {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

/**
 * Makes a new password, signs everybody out and leaves the password in INITIAL_PASSWORD_FILE for the administrator.
 * It is never printed or logged. Returns the file.
 */
export function newPassword() {
  const password = generatePassword();
  setPassword(password);
  writePrivateFile(INITIAL_PASSWORD_FILE, `${password}\n`);
  return INITIAL_PASSWORD_FILE;
}

/** At the first start of a server there is no password yet: one is made (see newPassword). Returns its file, or null. */
export function ensurePassword() {
  return hasPassword() ? null : newPassword();
}

// ---------- Sessions ----------

const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const expiry = () => new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();

function readCookie(req, name) {
  for (const part of String(req.headers?.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Starts a session for a browser that gave the right password. Returns the token for its cookie. */
export function createSession(req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const at = now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(at);
  db.prepare('INSERT INTO sessions(token_hash, created_at, last_seen, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)').run(
    tokenHash(token), at, at, expiry(), String(req.ip ?? ''), String(req.headers?.['user-agent'] ?? '').slice(0, 300)
  );
  return token;
}

/** The session of a request, or null. A session in use is renewed, so people who use the app stay signed in. */
export function sessionOf(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const hash = tokenHash(token);
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  if (Date.now() - Date.parse(row.last_seen) > 3_600_000) {
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').run(now(), expiry(), hash);
  }
  return { ...row };
}

export function endSession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function sessionCookie(token, req) {
  const secure = req.secure || PUBLIC_URL.startsWith('https://');
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${secure ? '; Secure' : ''}`;
}

const clearedCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// ---------- Wrong passwords ----------

const WINDOW_MS = 15 * 60_000;
const MAX_PER_ADDRESS = 8;
const MAX_OVERALL = 100;
const failures = new Map(); // address -> times of wrong passwords
let overall = [];

const recent = (times, t) => times.filter((x) => t - x < WINDOW_MS);

/** Seconds this address has to wait before trying again (0: it may try now). */
export function loginWait(address, t = Date.now()) {
  overall = recent(overall, t);
  const mine = recent(failures.get(address) ?? [], t);
  if (mine.length) failures.set(address, mine);
  else failures.delete(address);
  const waits = [];
  if (mine.length >= MAX_PER_ADDRESS) waits.push(mine[0] + WINDOW_MS - t);
  if (overall.length >= MAX_OVERALL) waits.push(overall[0] + WINDOW_MS - t);
  return waits.length ? Math.max(1, Math.ceil(Math.max(...waits) / 1000)) : 0;
}

export function loginFailed(address, t = Date.now()) {
  failures.set(address, [...recent(failures.get(address) ?? [], t), t]);
  overall.push(t);
}

export function loginSucceeded(address) {
  failures.delete(address);
}

export function resetLoginLimits() {
  failures.clear();
  overall = [];
}

// ---------- Routes ----------

/** Reachable without signing in: the sign-in page and what it needs, and the health check. */
const OPEN_PATHS = new Set(['/login', '/api/login', '/api/ping', '/style.css', '/icon.png', '/icon.ico', '/js/login.js']);

/**
 * Adds signing in and out to the app and makes every other page and API call require a session. The memory
 * addresses for agents (/mcp/...) have their own one-time tokens and only answer this machine (src/mcpHttp.js).
 */
export function mountAuth(app) {
  app.get('/login', (req, res) => {
    if (sessionOf(req)) return res.redirect(302, '/');
    res.set('Cache-Control', 'no-store').sendFile(path.join(APP_ROOT, 'public', 'login.html'));
  });

  app.post('/api/login', (req, res) => {
    const address = String(req.ip ?? '');
    const wait = loginWait(address);
    if (wait) {
      const minutes = Math.ceil(wait / 60);
      return res.status(429).json({ error: `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
    }
    if (!checkPassword(req.body?.password)) {
      loginFailed(address);
      return res.status(401).json({ error: 'That password is not right.' });
    }
    loginSucceeded(address);
    res.set('Set-Cookie', sessionCookie(createSession(req), req)).json({ ok: true });
  });

  app.use((req, res, next) => {
    if (OPEN_PATHS.has(req.path) || req.path.startsWith('/mcp/')) return next();
    const session = sessionOf(req);
    if (session) {
      req.session = session;
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please sign in again.', sign_in: true });
    if (req.method === 'GET') return res.redirect(302, '/login');
    return res.status(401).send('Please sign in.');
  });

  app.post('/api/logout', (req, res) => {
    endSession(req);
    res.set('Set-Cookie', clearedCookie()).json({ ok: true });
  });

  app.post('/api/password', (req, res) => {
    const { current, password } = req.body ?? {};
    if (!checkPassword(current)) return res.status(400).json({ error: 'The current password is not right.' });
    try {
      setPassword(password, { keepSessionHash: req.session.token_hash });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    return res.json({ ok: true });
  });
}
