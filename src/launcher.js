// Starts the web server in the background, writes its output to data/logs, and restarts it if it crashes.
// start.bat (via scripts/start.ps1) and "Start with Windows" both run this file.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { APP_ROOT, LOG_DIR, RUNTIME_DIR, RUNTIME_INFO, samePath } from './paths.js';

const SERVER = path.join(APP_ROOT, 'src', 'server.js');
const EXIT_ALREADY_RUNNING = 3;
const EXIT_RESTART = 75;
const KEEP_LOG_DAYS = 14;

const logFile = () => path.join(LOG_DIR, `app-${new Date().toISOString().slice(0, 10)}.log`);

function writeLog(text) {
  const stamp = new Date().toISOString();
  const lines = String(text)
    .replace(/sk-ant-[A-Za-z0-9_\-]*/g, 'sk-ant-[REDACTED]')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => `${stamp} ${l}`)
    .join('\n');
  if (!lines) return;
  try {
    fs.appendFileSync(logFile(), `${lines}\n`);
  } catch {
    /* disk full or locked: nothing sensible to do */
  }
  if (process.stdout.isTTY) process.stdout.write(`${lines}\n`);
}

function pruneLogs() {
  try {
    const cutoff = Date.now() - KEEP_LOG_DAYS * 86400_000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      const full = path.join(LOG_DIR, f);
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    }
  } catch {
    /* ignore */
  }
}

/** Environment for the server and the agent: our own Node.js and portable Git come first on the PATH. */
function prepareEnv() {
  const env = { ...process.env, RUNNER_LAUNCHER: '1' };
  const extra = [path.dirname(process.execPath)];
  const gitCmd = path.join(RUNTIME_DIR, 'git', 'cmd');
  const gitBash = path.join(RUNTIME_DIR, 'git', 'bin', 'bash.exe');
  if (fs.existsSync(gitCmd)) extra.push(gitCmd);
  if (fs.existsSync(gitBash) && !env.CLAUDE_CODE_GIT_BASH_PATH) env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [...extra, env[pathKey] ?? ''].join(path.delimiter);
  return env;
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/**
 * This installation's server is running if the process recorded in data/runtime.json answers on its port
 * from this same app folder. A runtime.json copied from another place (or computer) is ignored.
 */
async function alreadyRunning() {
  try {
    const recorded = JSON.parse(fs.readFileSync(RUNTIME_INFO, 'utf8'));
    if (recorded.root && !samePath(recorded.root, APP_ROOT)) return false;
    const info = await ping(recorded.port);
    return info?.app === 'claude-agent-runner' && info.pid === recorded.pid && (!info.root || samePath(info.root, APP_ROOT));
  } catch {
    return false;
  }
}

const env = prepareEnv();
const crashes = [];
let child = null;

function startServer() {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER, ...process.argv.slice(2)], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', writeLog);
  child.stderr.on('data', writeLog);
  child.on('error', (err) => writeLog(`Could not start the server: ${err.message}`));
  child.on('exit', (code, signal) => {
    child = null;
    if (code === 0) {
      writeLog('The app was shut down.');
      process.exit(0);
    }
    if (code === EXIT_ALREADY_RUNNING) {
      writeLog('The app is already running.');
      process.exit(0);
    }
    if (code === EXIT_RESTART) {
      writeLog('Restarting the app…');
      startServer();
      return;
    }
    const nowMs = Date.now();
    crashes.push(nowMs);
    while (crashes.length && crashes[0] < nowMs - 10 * 60_000) crashes.shift();
    if (crashes.length >= 5) {
      writeLog(`The server stopped unexpectedly ${crashes.length} times in 10 minutes. Giving up; start the app again with start.bat.`);
      process.exit(1);
    }
    const delay = 2000 * crashes.length;
    writeLog(`The server stopped unexpectedly (exit code ${code ?? signal}). Restarting in ${delay / 1000} seconds…`);
    setTimeout(startServer, delay);
  });
}

// Keep the launcher alive on Ctrl+C / console close until the server has shut down cleanly.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(sig, () => {
    if (!child) process.exit(0);
  });
}

pruneLogs();
if (await alreadyRunning()) {
  writeLog('The app is already running; not starting a second copy.');
  process.exit(0);
}
writeLog(`Starting Claude Agent Runner with Node.js ${process.version}.`);
startServer();
