import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { APP_ROOT, DATA_DIR, LOG_DIR, appVersion } from './paths.js';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

function powershell(script, { timeout = 20_000, sta = false } = {}) {
  const encoded = Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`, 'utf16le').toString('base64');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
  if (sta) args.push('-STA');
  args.push('-EncodedCommand', encoded);
  return execFileAsync('powershell.exe', args, { timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }).then((r) => r.stdout.trim());
}

let documentsCache = null;
export async function documentsDir() {
  if (documentsCache) return documentsCache;
  let dir = null;
  if (isWindows) {
    try {
      dir = await powershell("[Environment]::GetFolderPath('MyDocuments')");
    } catch {
      /* fall back below */
    }
  }
  if (!dir || !fs.existsSync(dir)) dir = path.join(os.homedir(), 'Documents');
  if (!fs.existsSync(dir)) dir = os.homedir();
  documentsCache = dir;
  return dir;
}

/** Suggests a new, unused folder for a project, e.g. Documents\Claude Projects\My website. */
export async function suggestProjectFolder(name) {
  const base = path.join(await documentsDir(), 'Claude Projects');
  const clean = String(name || 'My project').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'My project';
  let candidate = path.join(base, clean);
  for (let i = 2; fs.existsSync(candidate) && fs.readdirSync(candidate).length > 0; i++) candidate = path.join(base, `${clean} ${i}`);
  return candidate;
}

/** Shows the Windows "choose folder" dialog on this computer and returns the chosen path (or null). */
export async function pickFolder(initial) {
  if (!isWindows) throw new Error('The folder picker is only available on Windows. Type the path instead.');
  const start = initial && fs.existsSync(initial) ? initial : await documentsDir();
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose the folder Claude should work in (you can also make a new folder here)'
$dialog.ShowNewFolderButton = $true
$dialog.SelectedPath = '${start.replace(/'/g, "''")}'
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }
$owner.Dispose()
`;
  const chosen = await powershell(script, { timeout: 15 * 60_000, sta: true });
  return chosen || null;
}

/** Opens a folder in Explorer, or a file with its default program. */
export function openPath(target) {
  if (!fs.existsSync(target)) throw new Error(`Not found: ${target}`);
  if (isWindows) {
    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function commandVersion(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000, windowsHide: true });
    return stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

function agentEngineInfo() {
  const scope = path.join(APP_ROOT, 'node_modules', '@anthropic-ai');
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(scope, 'claude-agent-sdk', 'package.json'), 'utf8')).version;
  } catch {
    /* not installed */
  }
  let binaryFound = false;
  try {
    const dir = path.join(scope, `claude-agent-sdk-${process.platform}-${process.arch}`);
    binaryFound = fs.readdirSync(dir).some((f) => /^claude(\.exe)?$/.test(f));
  } catch {
    /* not installed */
  }
  return { version, binaryFound };
}

export async function diagnostics() {
  let freeGb = null;
  try {
    const s = fs.statfsSync(DATA_DIR);
    freeGb = Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    /* unsupported */
  }
  const gitBash = process.env.CLAUDE_CODE_GIT_BASH_PATH || (isWindows ? 'C:\\Program Files\\Git\\bin\\bash.exe' : null);
  return {
    app_version: appVersion(),
    node_version: process.version,
    node_path: process.execPath,
    platform: `${os.type()} ${os.release()} (${process.arch})`,
    agent_engine: agentEngineInfo(),
    git_version: await commandVersion('git', ['--version']),
    git_bash: gitBash && fs.existsSync(gitBash) ? gitBash : null,
    app_folder: APP_ROOT,
    data_folder: DATA_DIR,
    log_folder: LOG_DIR,
    free_disk_gb: freeGb,
  };
}
