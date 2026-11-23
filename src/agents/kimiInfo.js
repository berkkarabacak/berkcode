// Finds Kimi Code CLI and checks it is ready (installed, logged in, which models it offers).
// The check opens a session without sending a prompt, so it does not use any subscription quota.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from '../paths.js';
import { JsonRpcConnection } from './jsonrpc.js';

const execFileAsync = promisify(execFile);

/** Preferred Kimi models, best first: K3.1 Pro, then K3, then K2.8. */
export const PREFERRED_KIMI_MODELS = ['kimi-code/k3.1-pro', 'kimi-code/k3', 'kimi-code/kimi-for-coding'];

export const ACP_CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };

/** How to start Kimi Code CLI. RUNNER_KIMI_COMMAND (a JSON array) overrides it, which the tests use. */
export function kimiCommand() {
  if (process.env.RUNNER_KIMI_COMMAND) {
    const [command, ...args] = JSON.parse(process.env.RUNNER_KIMI_COMMAND);
    return { command, args };
  }
  const exe = process.platform === 'win32' ? 'kimi.exe' : 'kimi';
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir.replace(/^"(.*)"$/, '$1'), exe);
    if (fs.existsSync(candidate)) return { command: candidate, args: [] };
  }
  const fallback = path.join(os.homedir(), '.kimi-code', 'bin', exe);
  return fs.existsSync(fallback) ? { command: fallback, args: [] } : null;
}

/**
 * The PowerShell script for the visible "Install Kimi Code CLI" / "Log in to Kimi" window.
 * Installing uses Kimi's official installer; both actions end with "kimi login" (a device-code login).
 */
export function kimiSetupScript(action, kimiPath = null) {
  const lines = ["$kimi = Join-Path $env:USERPROFILE '.kimi-code\\bin\\kimi.exe'"];
  if (kimiPath) lines.push(`$kimi = '${kimiPath.replace(/'/g, "''")}'`);
  if (action === 'install') {
    lines.push(
      "Write-Host 'Installing Kimi Code CLI with the official installer from code.kimi.com ...' -ForegroundColor Cyan",
      // A separate process, because the installer ends with "exit", which would close this window.
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://code.kimi.com/kimi-code/install.ps1 | iex"',
      "$kimi = Join-Path $env:USERPROFILE '.kimi-code\\bin\\kimi.exe'"
    );
  }
  lines.push(
    'if (Test-Path $kimi) {',
    "  Write-Host ''",
    "  Write-Host 'Log in with your Kimi account: open the web page shown below (it may open by itself) and confirm the code.' -ForegroundColor Cyan",
    '  & $kimi login',
    "  Write-Host ''",
    "  Write-Host 'Finished. Close this window and press \"Check again\" in the app (Settings, Kimi Code CLI).' -ForegroundColor Green",
    '} else {',
    "  Write-Host ''",
    "  Write-Host 'Kimi Code CLI is not installed. Check the internet connection, then press \"Install Kimi Code CLI\" in the app again.' -ForegroundColor Red",
    '}'
  );
  return lines.join('\n');
}

export function pickKimiModel(available) {
  return PREFERRED_KIMI_MODELS.find((m) => available.includes(m)) ?? available[0] ?? null;
}

export function modelOptionsFrom(configOptions) {
  const option = (configOptions ?? []).find((o) => o.id === 'model');
  return (option?.options ?? [])
    .map((v) => ({ id: v.value ?? v.id, name: v.name ?? v.label ?? v.value ?? v.id }))
    .filter((m) => m.id);
}

export function currentOptionValue(configOptions, id) {
  return (configOptions ?? []).find((o) => o.id === id)?.currentValue ?? null;
}

export function isAuthError(err) {
  return err?.code === -32000 || /auth(entication)? required|not logged in|no credential/i.test(String(err?.message ?? ''));
}

export function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  } else {
    child.kill('SIGKILL');
  }
}

async function probe(cmd) {
  const dir = path.join(DATA_DIR, 'kimi-check');
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(cmd.command, [...cmd.args, 'acp'], {
    cwd: dir,
    env: { ...process.env, KIMI_CODE_NO_AUTO_UPDATE: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const rpc = new JsonRpcConnection(child);
  try {
    await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: ACP_CLIENT_CAPABILITIES }, 45_000);
    let session;
    try {
      session = await rpc.request('session/new', { cwd: dir, mcpServers: [] }, 45_000);
    } catch (err) {
      if (isAuthError(err)) return { loggedIn: false, models: [] };
      throw err;
    }
    const models = modelOptionsFrom(session.configOptions);
    const current = currentOptionValue(session.configOptions, 'model');
    await rpc.request('session/delete', { sessionId: session.sessionId }, 15_000).catch(() => {});
    return { loggedIn: true, models, current };
  } finally {
    child.stdin.end();
    setTimeout(() => killTree(child), 1500).unref();
  }
}

let cache = null;
let inflight = null;

export function invalidateKimiStatus() {
  cache = null;
}

/** The last known Kimi status, without checking again (null when not known yet). */
export function peekKimiStatus() {
  return cache?.value ?? null;
}

/** How old the last known Kimi status is, in milliseconds (Infinity when there is none). */
export function kimiStatusAge() {
  return cache ? Date.now() - cache.at : Infinity;
}

/** Returns { installed, path, version, loggedIn, models, preferredModel, hasK31, message }. Cached for 10 minutes. */
export async function kimiStatus({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < 10 * 60_000) return cache.value;
  if (inflight) return inflight;
  inflight = (async () => {
    const cmd = kimiCommand();
    if (!cmd) {
      return { installed: false, loggedIn: false, models: [], message: 'Kimi Code CLI is not installed on this computer. In Settings, press "Install Kimi Code CLI".' };
    }
    let version = null;
    try {
      const { stdout } = await execFileAsync(cmd.command, [...cmd.args, '--version'], { timeout: 20_000, windowsHide: true });
      version = stdout.trim().split('\n')[0];
    } catch {
      /* still try the handshake */
    }
    try {
      const result = await probe(cmd);
      const ids = result.models.map((m) => m.id);
      return {
        installed: true,
        path: cmd.command,
        version,
        loggedIn: result.loggedIn,
        models: result.models,
        currentModel: result.current ?? null,
        preferredModel: pickKimiModel(ids),
        hasK31: ids.includes('kimi-code/k3.1-pro'),
        message: result.loggedIn ? 'Ready.' : 'Kimi Code CLI is installed but not logged in. In Settings, press "Log in to Kimi" (or run "kimi login" in PowerShell).',
      };
    } catch (err) {
      return { installed: true, path: cmd.command, version, loggedIn: false, models: [], message: `Kimi Code CLI did not respond: ${err.message}` };
    }
  })();
  try {
    const value = await inflight;
    cache = { at: Date.now(), value };
    return value;
  } finally {
    inflight = null;
  }
}
