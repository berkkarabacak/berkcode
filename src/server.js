import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import yazl from 'yazl';
import { SERVER_MODE, PUBLIC_URL, PUBLIC_HOST, PUBLIC_ORIGIN, LISTEN_HOST } from './serverMode.js';
import { mountAuth, ensurePassword } from './auth.js';
import { APP_ROOT, DATA_DIR, LOG_DIR, RUNTIME_INFO, PROJECTS_DIR, appVersion, samePath, isInside } from './paths.js';
import { db, backupDatabaseIfDue } from './db.js';
import { bus, emit } from './events.js';
import { getSetting, setSetting, publicSettings, DEFAULTS } from './settings.js';
import { importKeyFile } from './keyfile.js';
import { writeShareCopy, applyCopySettings, SHARE_FILE_NAME } from './shareCopy.js';
import { listProjects, getProject, createProject, updateProject, deleteProject, setProjectFields, monthCost, budgetPaused, effectiveLimits, AGENTS, KIMI_EFFORTS } from './projects.js';
import { kimiStatus } from './agents/kimiInfo.js';
import { mountMemoryMcp, setServerPort } from './mcpHttp.js';
import {
  listEntries, getEntry, memoryStore, searchMemory, entryHistory, historyVersion, ensureStandardEntries,
  exportMemory, importMemory, normalizePath, MemoryError,
} from './memory.js';
import {
  startRun, stopRun, stopAllRuns, activeRunId, activeConversationId, recoverInterruptedRuns, freshSessionReason,
  sendMessage, queuedMessages, clearQueue, removeQueued, releaseQueued, holdQueueAfterRestart, MAX_MESSAGE_LENGTH,
} from './runner.js';
import { listConversations, conversationRuns, conversationTitle } from './conversations.js';
import { startScheduler, refreshSchedule, removeSchedule, previewSchedule, nextRunFor, describeSchedule, scheduleToCron } from './scheduler.js';
import { isGitRepo, restoreFolder, restorePointAvailable, listFiles } from './restorePoints.js';
import { testKey, listModels, pickDefaultModel } from './anthropicApi.js';
import { setStartWithWindows, syncStartWithWindows, startWithWindowsHere } from './autostart.js';
import { trayStatus } from './status.js';
import { initTray, startTray, trayAvailable, trayCheckedIn, trayShuttingDown } from './tray.js';
import { BRIEF_TEMPLATE, DEFAULT_TASK_PROMPT, buildBrief } from './templates.js';
import {
  pickFolder, suggestProjectFolder, openPath, showInFolder, diagnostics, documentsDir, desktopDir, uniqueFolder, moveFolder, openPowerShellWindow,
} from './system.js';
import { kimiCommand, invalidateKimiStatus, kimiSetupScript } from './agents/kimiInfo.js';

const EXIT_ALREADY_RUNNING = 3;
const EXIT_RESTART = 75;
const args = process.argv.slice(2);

process.on('uncaughtException', (err) => console.error('Unexpected error (the app keeps running):', err));
process.on('unhandledRejection', (err) => console.error('Unexpected error (the app keeps running):', err));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

// On a computer only its own browser, on pages served by this app, may use it (protects against other websites poking
// at localhost). The web version also answers its public address, behind the server's HTTPS proxy.
const publicHost = SERVER_MODE ? PUBLIC_HOST : null;
const publicOrigin = SERVER_MODE ? PUBLIC_ORIGIN : null;
if (SERVER_MODE) app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use((req, res, next) => {
  const host = String(req.hostname ?? '').toLowerCase();
  if (!['127.0.0.1', 'localhost'].includes(host) && host !== publicHost) return res.status(403).send('Forbidden');
  next();
});
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) && origin !== publicOrigin) return res.status(403).json({ error: 'Forbidden' });
  next();
});
// The web version: everybody signs in with the shared password first.
if (SERVER_MODE) mountAuth(app);

const wrap = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json(result ?? { ok: true });
  } catch (err) {
    const status = err.status ?? (err instanceof MemoryError ? 400 : 500);
    if (status === 500) console.error(err);
    if (!res.headersSent) res.status(status).json({ error: err.message });
  }
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Features that act on the computer the app runs on (folders, windows) are not part of the web version. */
function desktopOnly() {
  if (SERVER_MODE) throw httpError(400, 'This is not available in the web version of the app.');
}
const KIMI_SERVER_SETUP = 'On the server, Kimi is set up once by its administrator: docker exec -it agent-runner kimi login';

function requireProject(id) {
  const project = getProject(id);
  if (!project) throw httpError(404, 'Project not found');
  return project;
}

function parseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function runRow(r) {
  if (!r) return null;
  const changed = parseJson(r.changed_files, null);
  const restoreRef = parseJson(r.restore_ref, null);
  return {
    ...r,
    changed_files: changed,
    changed_count: changed ? changed.added.length + changed.changed.length + changed.removed.length : null,
    memory_written: parseJson(r.memory_written, []),
    restore_ref: restoreRef ? { type: restoreRef.type, commit: restoreRef.commit, warning: restoreRef.warning, files: restoreRef.files } : null,
    restore_available: restorePointAvailable(restoreRef),
  };
}

function projectSummary(p) {
  const last = db.prepare("SELECT * FROM runs WHERE project_id = ? AND status != 'skipped' ORDER BY id DESC LIMIT 1").get(p.id);
  let folderExists = false;
  let hasIndex = false;
  try {
    folderExists = fs.statSync(p.folder).isDirectory();
    hasIndex = folderExists && fs.existsSync(path.join(p.folder, 'index.html'));
  } catch {
    /* missing */
  }
  return {
    ...p,
    agent_label: AGENTS[p.agent].label,
    agent_long: AGENTS[p.agent].long,
    billing: AGENTS[p.agent].billing,
    schedule_text: describeSchedule(p.schedule),
    next_run: nextRunFor(p),
    last_run: last ? { id: last.id, status: last.status, started_at: last.started_at, cost_usd: last.cost_usd, model: last.model } : null,
    month_cost: monthCost(p.id),
    active_run_id: activeRunId(p.id),
    active_conversation_id: activeConversationId(p.id),
    queued: queuedMessages(p.id),
    limits: effectiveLimits(p),
    next_fresh_reason: freshSessionReason(p),
    folder_exists: folderExists,
    has_index_html: hasIndex,
  };
}

/** Rejects folders where an unattended agent should never work: drive roots, system folders, whole user folders. */
async function checkFolderSafety(folder) {
  const resolved = path.resolve(folder);
  const lower = resolved.toLowerCase().replace(/[\\/]+$/, '');
  if ((samePath(resolved, APP_ROOT) || isInside(resolved, APP_ROOT)) && !isInside(resolved, PROJECTS_DIR)) {
    return `Inside the app folder, each project needs its own folder within the "projects" folder, for example ${path.join(PROJECTS_DIR, 'My website')}`;
  }
  if (path.parse(resolved).root.toLowerCase().replace(/[\\/]+$/, '') === lower) return 'Please do not use a whole drive. Choose or create a separate folder for this project.';
  const home = os.homedir();
  const forbidden = [
    home,
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    path.join(home, 'OneDrive'),
    await documentsDir(),
    process.env.OneDrive,
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
  ].filter(Boolean).map((f) => path.resolve(f).toLowerCase());
  if (forbidden.includes(lower)) return 'Please choose or create a separate folder just for this project (not your whole Desktop, Documents or user folder).';
  for (const sys of [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    if (lower.startsWith(path.resolve(sys).toLowerCase() + path.sep)) return 'Please do not use a Windows system folder. Choose a folder in your Documents instead.';
  }
  return null;
}

async function validateFolder(folder, { create = false } = {}) {
  folder = String(folder ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!folder) return { ok: false, message: 'Choose a folder.' };
  if (!path.isAbsolute(folder)) return { ok: false, message: `Use a full path, for example ${path.join(PROJECTS_DIR, 'My app')}, or press "Browse…".` };
  const resolved = path.resolve(folder);
  const unsafe = await checkFolderSafety(resolved);
  if (unsafe) return { ok: false, message: unsafe };
  const portability = isInside(resolved, PROJECTS_DIR)
    ? ' It is inside the app folder, so it moves along when you copy the app to another computer.'
    : ' Note: it is outside the app folder, so copying the app folder to another computer does not take it along.';
  if (!fs.existsSync(resolved)) {
    if (!create) return { ok: true, folder: resolved, missing: true, empty: true, is_git: false, message: `This folder does not exist yet. It will be created for you.${portability}` };
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (err) {
      return { ok: false, message: `The folder could not be created: ${err.message}` };
    }
  }
  if (!fs.statSync(resolved).isDirectory()) return { ok: false, message: 'This path is a file, not a folder.' };
  const items = fs.readdirSync(resolved);
  return {
    ok: true,
    folder: resolved,
    empty: items.length === 0,
    is_git: await isGitRepo(resolved),
    message: (items.length ? `Folder found (${items.length} items inside). The agent will work with what is already there.` : 'Empty folder found.') + portability,
  };
}

// ---------- App state & settings ----------

// The web version answers the health check without revealing anything about the server.
app.get('/api/ping', (req, res) =>
  res.json(SERVER_MODE ? { app: 'claude-agent-runner', version: appVersion() } : { app: 'claude-agent-runner', version: appVersion(), pid: process.pid, root: APP_ROOT })
);

/** Settings for the browser. "Start with Windows" shows whether the Startup entry starts THIS copy of the app. */
const uiSettings = () => ({ ...publicSettings(), start_with_windows: getSetting('start_with_windows') && startWithWindowsHere() });

app.get('/api/state', wrap(() => {
  const projects = listProjects();
  return {
    settings: uiSettings(),
    budget_paused: budgetPaused(),
    month_cost: monthCost(),
    version: appVersion(),
    can_restart: process.env.RUNNER_LAUNCHER === '1' || SERVER_MODE,
    tray_available: trayAvailable(),
    server_mode: SERVER_MODE,
    public_url: SERVER_MODE ? PUBLIC_URL : null,
    project_count: projects.length,
    claude_projects: projects.filter((p) => p.agent === 'claude').length,
    kimi_projects: projects.filter((p) => p.agent === 'kimi').length,
  };
}));

app.get('/api/settings', wrap(() => uiSettings()));

app.put('/api/settings', wrap(async (req) => {
  const body = req.body ?? {};
  // The web version has no Windows start-up, no icon next to the clock and a fixed port.
  if (SERVER_MODE) for (const key of ['start_with_windows', 'tray_icon', 'port']) delete body[key];
  for (const [key, value] of Object.entries(body)) {
    if (key === 'api_key') {
      const v = String(value ?? '').trim();
      if (v) {
        setSetting('api_key', v);
        setSetting('api_key_source', 'settings');
      }
      continue;
    }
    if (key === 'start_with_windows') {
      // The settings form always sends this box; only touch the Startup folder when it was actually changed.
      const wanted = Boolean(value);
      if (wanted !== Boolean(uiSettings().start_with_windows)) {
        const r = setStartWithWindows(wanted);
        if (!r.ok) throw httpError(400, r.message);
      }
      setSetting(key, wanted);
      continue;
    }
    if (key in DEFAULTS && !['heartbeat', 'budget_paused_month', 'key_file_hash', 'api_key_source', 'copy_settings_hash', 'access_password_hash'].includes(key)) setSetting(key, value);
  }
  if (budgetPaused() && monthCost() < getSetting('monthly_cap_usd')) setSetting('budget_paused_month', '');
  // Switching the icon on starts it right away; switching it off makes it close itself within a few seconds.
  if ('tray_icon' in body && getSetting('tray_icon')) startTray();
  emit('projects-changed', {});
  return uiSettings();
}));

app.post('/api/settings/test-key', wrap(async (req) => testKey(String(req.body?.api_key || '').trim() || getSetting('api_key'))));

app.post('/api/budget/resume', wrap(() => {
  if (monthCost() >= getSetting('monthly_cap_usd')) throw httpError(400, "This month's spending is still above the monthly cap. Raise the cap in Settings first.");
  setSetting('budget_paused_month', '');
  emit('projects-changed', {});
}));

app.get('/api/models', wrap(() => listModels()));

/**
 * Opens a visible PowerShell window to install Kimi Code CLI (official installer) or to log in to it.
 * Used after copying the app to a new computer, where Kimi is not set up yet.
 */
app.post('/api/agents/kimi/setup', wrap((req) => {
  const action = req.body?.action;
  if (action !== 'install' && action !== 'login') throw httpError(400, 'Unknown action');
  if (SERVER_MODE) throw httpError(400, KIMI_SERVER_SETUP);
  const cmd = process.env.RUNNER_KIMI_COMMAND ? null : kimiCommand();
  openPowerShellWindow(action === 'install' ? 'Install Kimi Code CLI' : 'Log in to Kimi Code CLI', kimiSetupScript(action, cmd?.command));
  invalidateKimiStatus();
}));

/** Readiness of both agents, for the "Add project" page and Settings. Checking Kimi uses no subscription quota. */
app.get('/api/agents', wrap(async (req) => {
  const refresh = req.query.refresh === '1';
  const [claudeModels, kimi] = await Promise.all([listModels(), kimiStatus({ refresh })]);
  return {
    claude: { ready: Boolean(getSetting('api_key')), models: claudeModels.models, default_model: getSetting('default_model') },
    kimi,
  };
}));

app.get('/api/templates', wrap(() => ({ brief: BRIEF_TEMPLATE, task_prompt: DEFAULT_TASK_PROMPT })));

app.get('/api/diagnostics', wrap(() => diagnostics()));

app.post('/api/open', wrap((req) => {
  desktopOnly();
  const what = req.body?.what;
  const target = what === 'logs' ? LOG_DIR : what === 'data' ? DATA_DIR : what === 'app' ? APP_ROOT : null;
  if (!target) throw httpError(400, 'Unknown folder');
  openPath(target);
}));

/** For the icon next to the clock: state, tooltip and menu lines. "show: false" makes the icon close itself. */
app.get('/api/tray', wrap(() => {
  trayCheckedIn();
  return {
    ...trayStatus(),
    show: Boolean(getSetting('tray_icon')),
    start_with_windows: Boolean(uiSettings().start_with_windows),
  };
}));

app.post('/api/shutdown', wrap((req, res) => {
  // The web version is a service for everybody: it can be restarted, not switched off from the browser.
  desktopOnly();
  res.json({ ok: true });
  setTimeout(() => shutdown(0), 200);
}));

app.post('/api/restart', wrap((req, res) => {
  // On the server the container starts the app again by itself.
  if (process.env.RUNNER_LAUNCHER !== '1' && !SERVER_MODE) throw httpError(400, 'Restart only works when the app was started with start.bat.');
  res.json({ ok: true });
  setTimeout(() => shutdown(EXIT_RESTART), 200);
}));

// ---------- Helpers for forms ----------

app.post('/api/validate-folder', wrap((req) => {
  desktopOnly();
  return validateFolder(req.body?.folder, { create: Boolean(req.body?.create) });
}));

app.get('/api/suggest-folder', wrap(async (req) => ({ folder: await suggestProjectFolder(String(req.query.name ?? '')) })));

app.post('/api/pick-folder', wrap(async (req) => {
  desktopOnly();
  try {
    return { folder: await pickFolder(String(req.body?.initial ?? '')) };
  } catch (err) {
    throw httpError(400, err.killed ? 'The folder window was open too long and was closed.' : err.message);
  }
}));

app.post('/api/schedule/preview', wrap((req) => {
  try {
    const { schedule, timezone } = req.body ?? {};
    return { ok: true, cron: scheduleToCron(schedule), text: describeSchedule(schedule), next: previewSchedule(schedule, timezone || 'Europe/Istanbul', 3) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}));

// ---------- Projects ----------

app.get('/api/projects', wrap(() => listProjects().map(projectSummary)));

function checkSchedule(body) {
  if (!body.schedule) return;
  try {
    scheduleToCron(body.schedule);
    previewSchedule(body.schedule, body.timezone || 'Europe/Istanbul', 1);
  } catch (err) {
    throw httpError(400, `Schedule: ${err.message}`);
  }
}

function checkAgentOptions(agent, body) {
  if (agent === 'kimi') {
    if (body.effort != null && body.effort !== '' && !KIMI_EFFORTS.includes(body.effort)) throw httpError(400, 'Thinking effort must be low, high or max.');
    if (body.budget_usd) delete body.budget_usd;
  } else if (body.effort) {
    delete body.effort;
  }
}

app.post('/api/projects', wrap(async (req) => {
  const body = req.body ?? {};
  if (!String(body.name ?? '').trim()) throw httpError(400, 'Give the project a name.');
  if (!AGENTS[body.agent]) throw httpError(400, 'Choose which agent should work on this project (Claude or Kimi).');
  checkAgentOptions(body.agent, body);
  // In the web version the app chooses the folder: a new one in its projects folder, named after the project.
  const folder = await validateFolder(SERVER_MODE ? uniqueFolder(PROJECTS_DIR, String(body.name)) : body.folder, { create: true });
  if (!folder.ok) throw httpError(400, folder.message);
  checkSchedule(body);
  const project = createProject({
    ...body,
    name: String(body.name).trim(),
    folder: folder.folder,
    task_prompt: String(body.task_prompt ?? '').trim() || DEFAULT_TASK_PROMPT,
  });
  ensureStandardEntries(project.id);
  if (String(body.brief ?? '').trim()) memoryStore(project.id, { changedBy: 'owner' }).save('/memories/brief.md', buildBrief(body.brief));
  refreshSchedule(project.id);
  emit('projects-changed', {});
  return projectSummary(project);
}));

app.get('/api/projects/:id', wrap(async (req) => {
  const p = requireProject(req.params.id);
  return { ...projectSummary(p), is_git: await isGitRepo(p.folder) };
}));

app.put('/api/projects/:id', wrap(async (req) => {
  const current = requireProject(req.params.id);
  const body = { ...req.body };
  if ('agent' in body && body.agent !== current.agent) {
    throw httpError(400, 'The agent of a project cannot be changed. Create a new project to use another agent.');
  }
  delete body.agent;
  checkAgentOptions(current.agent, body);
  checkSchedule({ timezone: current.timezone, ...body });
  if (SERVER_MODE) delete body.folder;
  if (body.folder && !samePath(String(body.folder).trim().replace(/^"(.*)"$/, '$1'), current.folder)) {
    if (activeRunId(current.id)) throw httpError(409, 'Stop the active run before changing the folder.');
    const folder = await validateFolder(body.folder, { create: true });
    if (!folder.ok) throw httpError(400, folder.message);
    body.folder = folder.folder;
  } else {
    delete body.folder;
  }
  if ('name' in body && !String(body.name).trim()) throw httpError(400, 'The project needs a name.');
  const p = updateProject(current.id, body);
  refreshSchedule(p.id);
  emit('projects-changed', {});
  return projectSummary(p);
}));

app.delete('/api/projects/:id', wrap((req) => {
  const p = requireProject(req.params.id);
  if (activeRunId(p.id)) throw httpError(409, 'Stop the active run first.');
  removeSchedule(p.id);
  deleteProject(p.id);
  emit('projects-changed', {});
}));

/** Fails with a plain message when the project's agent cannot work right now. */
async function ensureAgentReady(p) {
  if (p.agent === 'claude' && !getSetting('api_key')) throw httpError(400, 'No Claude API key is set yet. Open Settings and enter your API key first.');
  if (p.agent === 'kimi') {
    const kimi = await kimiStatus();
    if (!kimi.installed) throw httpError(400, 'Kimi Code CLI is not installed on this computer. Open Settings and press "Install Kimi Code CLI".');
    if (!kimi.loggedIn) {
      const fresh = await kimiStatus({ refresh: true });
      if (!fresh.loggedIn) throw httpError(400, fresh.message);
    }
  }
}

app.post('/api/projects/:id/run', wrap(async (req) => {
  const p = requireProject(req.params.id);
  await ensureAgentReady(p);
  return startRun(p.id, 'manual');
}));

/**
 * A message from the owner in the chat. It starts the agent in the project's current conversation (or a new
 * conversation), or, while the agent is busy, it waits in the queue for its turn.
 */
app.post('/api/projects/:id/chat', wrap(async (req) => {
  const p = requireProject(req.params.id);
  const message = String(req.body?.message ?? '').trim();
  if (!message) throw httpError(400, 'Write a message first.');
  if (message.length > MAX_MESSAGE_LENGTH) throw httpError(400, `The message is too long (${message.length} characters, the limit is ${MAX_MESSAGE_LENGTH}).`);
  // Starting the agent needs it to be ready; a message that only joins the queue does not.
  if (!activeRunId(p.id)) await ensureAgentReady(p);
  const r = sendMessage(p.id, message, { newConversation: Boolean(req.body?.new_conversation) });
  if (r.status === 'skipped') throw httpError(409, `The message was not sent: ${r.reason.replace(/^skipped: /, '')}.`);
  return r;
}));

/** Removes every message from the queue. */
app.delete('/api/projects/:id/queue', wrap((req) => {
  const p = requireProject(req.params.id);
  clearQueue(p.id);
}));

/** Removes one message from the queue ("Remove", and "Edit", which takes it back into the message box). */
app.delete('/api/projects/:id/queue/:qid', wrap((req) => {
  const p = requireProject(req.params.id);
  if (!removeQueued(p.id, req.params.qid)) throw httpError(404, 'This message is no longer in the queue: the agent already has it.');
}));

/** "Send" for held messages: all of them, or one. */
app.post('/api/projects/:id/queue/send', wrap(async (req) => {
  const p = requireProject(req.params.id);
  if (!activeRunId(p.id)) await ensureAgentReady(p);
  if (!releaseQueued(p.id)) throw httpError(404, 'There are no held messages to send.');
}));

app.post('/api/projects/:id/queue/:qid/send', wrap(async (req) => {
  const p = requireProject(req.params.id);
  if (!activeRunId(p.id)) await ensureAgentReady(p);
  if (!releaseQueued(p.id, req.params.qid)) throw httpError(404, 'This message is no longer held: it was sent or removed.');
}));

app.get('/api/projects/:id/conversations', wrap((req) => {
  const p = requireProject(req.params.id);
  return listConversations(p.id, activeConversationId(p.id));
}));

app.get('/api/projects/:id/conversations/:cid', wrap((req) => {
  const p = requireProject(req.params.id);
  const cid = Number(req.params.cid);
  const { runs, earlier } = conversationRuns(p.id, cid, { before: Number(req.query.before) || null });
  if (!runs.length && !req.query.before) throw httpError(404, 'This conversation was not found.');
  const logsFor = db.prepare('SELECT seq, ts, type, content FROM run_logs WHERE run_id = ? ORDER BY seq');
  return {
    id: cid,
    title: conversationTitle(cid),
    earlier,
    current: p.conversation_id === cid,
    runs: runs.map((r) => ({ ...runRow(r), logs: logsFor.all(r.id) })),
  };
}));

app.post('/api/projects/:id/stop', wrap((req) => {
  const p = requireProject(req.params.id);
  return { stopped: stopRun(p.id) };
}));

app.post('/api/projects/:id/enabled', wrap((req) => {
  const p = requireProject(req.params.id);
  const updated = updateProject(p.id, { enabled: Boolean(req.body?.enabled) });
  refreshSchedule(p.id);
  emit('projects-changed', {});
  return projectSummary(updated);
}));

app.post('/api/projects/:id/fresh-session', wrap((req) => {
  const p = requireProject(req.params.id);
  setProjectFields(p.id, { fresh_pending: 1 });
  emit('projects-changed', {});
  return projectSummary(getProject(p.id));
}));

/** Moves a project folder that lives elsewhere into the app's "projects" folder, so it travels with the app. */
app.post('/api/projects/:id/move-into-app', wrap((req) => {
  desktopOnly();
  const p = requireProject(req.params.id);
  if (activeRunId(p.id)) throw httpError(409, 'Stop the active run before moving the folder.');
  if (isInside(p.folder, PROJECTS_DIR)) throw httpError(400, 'This project folder is already inside the app folder.');
  if (!fs.existsSync(p.folder)) throw httpError(400, 'The project folder cannot be found on this computer. Choose its new location in Setup first.');
  const target = uniqueFolder(PROJECTS_DIR, path.basename(p.folder));
  if (fs.existsSync(target)) fs.rmdirSync(target);
  try {
    moveFolder(p.folder, target);
  } catch (err) {
    throw httpError(400, err.message);
  }
  const updated = updateProject(p.id, { folder: target });
  console.log(`Project "${p.name}" folder moved into the app folder: ${target}`);
  emit('projects-changed', {});
  return projectSummary(updated);
}));

app.post('/api/projects/:id/open', wrap((req) => {
  desktopOnly();
  const p = requireProject(req.params.id);
  const target = req.body?.target === 'index' ? path.join(p.folder, 'index.html') : p.folder;
  openPath(target);
}));

/** The project's files as a ZIP (without dependency and cache folders): how the web version hands them over. */
app.get('/api/projects/:id/download', wrap(async (req, res) => {
  const p = requireProject(req.params.id);
  if (!fs.existsSync(p.folder)) throw httpError(404, 'The project folder was not found.');
  const { files } = listFiles(p.folder);
  const zip = new yazl.ZipFile();
  for (const f of files) zip.addFile(f.full, f.rel, { mtime: f.mtime });
  zip.end();
  const name = String(p.name).replace(/[^\w .-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'project';
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${name}.zip"; filename*=UTF-8''${encodeURIComponent(name)}.zip`,
    'Cache-Control': 'no-store',
  });
  await pipeline(zip.outputStream, res);
}));

// ---------- Memory ----------

app.get('/api/projects/:id/memory', wrap((req) => {
  const p = requireProject(req.params.id);
  ensureStandardEntries(p.id);
  return listEntries(p.id).map((e) => ({ path: e.path, content: e.content, created_at: e.created_at, updated_at: e.updated_at }));
}));

app.put('/api/projects/:id/memory', wrap((req) => {
  const p = requireProject(req.params.id);
  const { path: entryPath, content } = req.body ?? {};
  memoryStore(p.id, { changedBy: 'owner' }).save(entryPath, String(content ?? ''));
  emit('memory-changed', { projectId: p.id });
  return getEntry(p.id, normalizePath(entryPath));
}));

app.post('/api/projects/:id/memory/delete', wrap((req) => {
  const p = requireProject(req.params.id);
  const target = normalizePath(req.body?.path);
  if (['/memories/brief.md', '/memories/plan.md', '/memories/progress.md', '/memories/decisions.md'].includes(target)) {
    throw httpError(400, 'Standard entries cannot be deleted. Edit them instead.');
  }
  memoryStore(p.id, { changedBy: 'owner' }).remove(target);
  emit('memory-changed', { projectId: p.id });
}));

app.get('/api/projects/:id/memory/search', wrap((req) => {
  const p = requireProject(req.params.id);
  return searchMemory(p.id, String(req.query.q ?? ''), 50);
}));

app.get('/api/projects/:id/memory/history', wrap((req) => {
  const p = requireProject(req.params.id);
  return entryHistory(p.id, String(req.query.path ?? ''));
}));

app.get('/api/projects/:id/memory/version/:hid', wrap((req) => {
  const p = requireProject(req.params.id);
  const v = historyVersion(p.id, req.params.hid);
  if (!v) throw httpError(404, 'Version not found');
  return v;
}));

app.post('/api/projects/:id/memory/restore', wrap((req) => {
  const p = requireProject(req.params.id);
  const restoredPath = memoryStore(p.id, { changedBy: 'owner (restore)' }).restoreVersion(Number(req.body?.history_id));
  emit('memory-changed', { projectId: p.id });
  return { path: restoredPath };
}));

app.post('/api/projects/:id/memory/export', wrap((req) => {
  desktopOnly();
  const p = requireProject(req.params.id);
  const folder = String(req.body?.folder ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!folder || !path.isAbsolute(folder)) throw httpError(400, 'Choose a folder to export to.');
  if ((path.resolve(folder) + path.sep).toLowerCase().startsWith((path.resolve(p.folder) + path.sep).toLowerCase())) {
    throw httpError(400, 'Export memory to a folder outside the project folder, so memory files do not end up in the project.');
  }
  return { count: exportMemory(p.id, path.resolve(folder)), folder: path.resolve(folder) };
}));

app.post('/api/projects/:id/memory/import', wrap((req) => {
  desktopOnly();
  const p = requireProject(req.params.id);
  const folder = String(req.body?.folder ?? '').trim().replace(/^"(.*)"$/, '$1');
  if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw httpError(400, 'That folder does not exist.');
  const count = importMemory(p.id, path.resolve(folder));
  emit('memory-changed', { projectId: p.id });
  return { count };
}));

// ---------- Runs ----------

app.get('/api/projects/:id/runs', wrap((req) => {
  const p = requireProject(req.params.id);
  const limit = Math.min(500, Number(req.query.limit) || 100);
  return db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(p.id, limit).map(runRow);
}));

app.get('/api/runs/:id', wrap((req) => {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(req.params.id));
  if (!run) throw httpError(404, 'Run not found');
  const logs = db.prepare('SELECT seq, ts, type, content FROM run_logs WHERE run_id = ? ORDER BY seq').all(run.id);
  return { ...runRow(run), logs };
}));

app.post('/api/runs/:id/restore', wrap(async (req) => {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(req.params.id));
  if (!run) throw httpError(404, 'Run not found');
  const project = requireProject(run.project_id);
  if (activeRunId(project.id)) throw httpError(409, 'A run is active on this project. Stop it before restoring.');
  const ref = parseJson(run.restore_ref, null);
  if (!restorePointAvailable(ref)) throw httpError(400, 'No restore point is available for this run.');
  const { problems } = await restoreFolder(project.folder, ref);
  console.log(`Project "${project.name}" folder restored to before run #${run.id}.`);
  return { ok: true, problems };
}));

// ---------- Sharing the app with family and friends ----------

const shareTarget = async () => path.join(await desktopDir(), SHARE_FILE_NAME);

/** Saves a ZIP of the app for another computer on the Desktop, with the Claude API key if asked (never sent back). */
app.post('/api/share-copy', wrap(async (req) => {
  desktopOnly();
  const includeKey = Boolean(req.body?.include_key);
  const key = getSetting('api_key');
  if (includeKey && !key) throw httpError(400, 'There is no Claude API key to include yet. Enter it under "Claude API key" first, or untick the box.');
  const capText = String(req.body?.monthly_cap_usd ?? '').trim();
  const cap = capText === '' ? null : Number(capText);
  if (cap != null && !(cap >= 1)) throw httpError(400, 'Enter a monthly limit of at least 1 dollar, or leave the field empty.');
  const target = await shareTarget();
  try {
    const r = await writeShareCopy(target, { key: includeKey ? key : null, settings: { monthly_cap_usd: cap } });
    return { file: r.file, files: r.files, bytes: r.bytes, include_key: includeKey, monthly_cap_usd: cap };
  } catch (err) {
    if (['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
      throw httpError(409, `The ZIP file could not be saved, because the old one is open in another program: ${target}. Close it and try again.`);
    }
    throw err;
  }
}));

app.post('/api/share-copy/show', wrap(async () => {
  desktopOnly();
  const target = await shareTarget();
  if (!fs.existsSync(target)) throw httpError(404, 'The ZIP file is not on the Desktop any more. Create it again.');
  showInFolder(target);
}));

// ---------- Live updates (Server-Sent Events) ----------

app.get('/api/events', (req, res) => {
  // X-Accel-Buffering: a proxy in front (nginx on the server) must pass every update on at once.
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  // Only write while the browser is still connected; a write after the connection ended would raise an error.
  const write = (chunk) => {
    if (!res.writableEnded && !res.destroyed) res.write(chunk);
  };
  const send = (event) => write(`data: ${JSON.stringify(event)}\n\n`);
  bus.on('event', send);
  const ping = setInterval(() => write(': ping\n\n'), 25_000);
  const stop = () => {
    clearInterval(ping);
    bus.off('event', send);
  };
  req.on('close', stop);
  res.on('close', stop);
  res.on('error', stop);
});

// ---------- Memory tools for agents that run as separate programs (Kimi) ----------

mountMemoryMcp(app);

// ---------- Website preview: the project's own files, as the web version's "Open website" ----------

// The page runs in a sandbox with an origin of its own, so scripts in it cannot use the app as the signed-in visitor.
const PREVIEW_HEADERS = {
  'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-cache',
};
app.use('/preview/:id', (req, res) => {
  const p = getProject(req.params.id);
  if (!p || !fs.existsSync(p.folder)) return res.status(404).send('This project has no files yet.');
  res.set(PREVIEW_HEADERS);
  express.static(p.folder, { dotfiles: 'deny', index: ['index.html'], fallthrough: false })(req, res, (err) => {
    res.status(err?.status ?? 404).send(err?.status === 403 ? 'Not allowed' : 'Not found');
  });
});

// ---------- Static UI ----------

app.get('/vendor/marked.js', (req, res) => res.sendFile(path.join(APP_ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js')));
app.use(express.static(path.join(APP_ROOT, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- Startup & shutdown ----------

function pingPort(port) {
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
 * True when this same installation (this app folder) already answers on the port. A copy of the app in
 * another folder is a different installation, even when its data/runtime.json was copied along.
 */
async function pingOurs(port) {
  const info = await pingPort(port);
  if (info?.app !== 'claude-agent-runner') return false;
  if (info.root) return samePath(info.root, APP_ROOT);
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_INFO, 'utf8')).pid === info.pid;
  } catch {
    return false;
  }
}

/** Another server of this installation that is still running (found through data/runtime.json). */
async function existingInstance() {
  try {
    const recorded = JSON.parse(fs.readFileSync(RUNTIME_INFO, 'utf8'));
    if (recorded.root && !samePath(recorded.root, APP_ROOT)) return null; // copied from another place: stale
    const info = await pingPort(recorded.port);
    const ours = info?.app === 'claude-agent-runner' && info.pid === recorded.pid && (!info.root || samePath(info.root, APP_ROOT));
    return ours ? recorded : null;
  } catch {
    return null;
  }
}

async function listen(firstPort) {
  // On a server the port is fixed: the proxy in front expects the app exactly there.
  const tries = SERVER_MODE ? 1 : 20;
  for (let port = firstPort; port < firstPort + tries; port++) {
    const server = http.createServer(app);
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, LISTEN_HOST, resolve);
      });
      return { server, port };
    } catch (err) {
      server.close();
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      if (await pingOurs(port)) return { alreadyRunning: true, port };
      if (SERVER_MODE) throw new Error(`Port ${port} is already in use.`);
      console.log(`Port ${port} is used by another program (or another copy of this app), trying ${port + 1}…`);
    }
  }
  throw new Error(`No free port found between ${firstPort} and ${firstPort + 19}.`);
}

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  trayShuttingDown();
  console.log('Shutting down: stopping active runs…');
  await stopAllRuns(25_000);
  try {
    const info = JSON.parse(fs.readFileSync(RUNTIME_INFO, 'utf8'));
    if (info.pid === process.pid) fs.rmSync(RUNTIME_INFO, { force: true });
  } catch {
    /* ignore */
  }
  try {
    // Fold the write-ahead log into app.db and close it, so the data folder is complete and safe to copy.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (err) {
    console.error('Could not close the database cleanly:', err.message);
  }
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => shutdown(0));

async function checkDefaultModel() {
  const { models, source } = await listModels();
  if (source !== 'api' || !models.length) return;
  const current = getSetting('default_model');
  if (models.some((m) => m.id === current)) return;
  const pick = pickDefaultModel(models);
  if (pick) {
    setSetting('default_model', pick);
    console.log(`The default model "${current}" is not available for this API key; using "${pick}" instead.`);
  }
}

const portArg = args.find((a) => a.startsWith('--port='));
const firstPort = Number(portArg?.split('=')[1]) || Number(process.env.PORT) || getSetting('port') || 4280;

if (SERVER_MODE) {
  if (!PUBLIC_HOST) {
    console.error('The web version needs its public address: set RUNNER_PUBLIC_URL, for example https://agents.example.com.');
    process.exit(1);
  }
  // The agents' home (Kimi's login, npm and git settings) can live in the data volume, which may be empty at first.
  fs.mkdirSync(os.homedir(), { recursive: true });
  const passwordFile = ensurePassword();
  if (passwordFile) console.log(`A sign-in password was made and saved in ${passwordFile} (only readable on the server). Change it in Settings after signing in.`);
  console.log(`Web version: ${PUBLIC_URL} (everybody signs in with the shared password).`);
}
const running = await existingInstance();
if (running) {
  console.log(`The app is already running at ${running.url}`);
  process.exit(EXIT_ALREADY_RUNNING);
}
const result = await listen(firstPort);
if (result.alreadyRunning) {
  console.log(`The app is already running at http://127.0.0.1:${result.port}`);
  process.exit(EXIT_ALREADY_RUNNING);
}

const url = `http://127.0.0.1:${result.port}`;
setServerPort(result.port);
fs.writeFileSync(RUNTIME_INFO, JSON.stringify({ port: result.port, url, pid: process.pid, root: APP_ROOT, startedAt: new Date().toISOString(), version: appVersion() }, null, 2));
console.log(`Claude Agent Runner ${appVersion()} is running at ${url}`);

// After the app folder was copied to another computer or moved, point "Start with Windows" at this folder.
if (getSetting('start_with_windows')) {
  try {
    const sync = syncStartWithWindows();
    if (sync.changed) console.log('"Start with Windows" now starts the app from this folder.');
    else if (sync.other) console.log(`"Start with Windows" starts another copy of the app (${sync.other}); it was left unchanged.`);
  } catch (err) {
    console.error('Could not update "Start with Windows":', err.message);
  }
}
for (const p of listProjects()) {
  if (!fs.existsSync(p.folder)) console.log(`Project "${p.name}": its folder was not found on this computer (${p.folder}). Choose its location in the project's Setup tab.`);
}
initTray(result.port);

try {
  const keyResult = importKeyFile();
  if (keyResult?.imported) console.log(`Loaded the API key from ${keyResult.file}.`);
  else if (keyResult && keyResult.reason !== 'unchanged') console.log(`${keyResult.file}: ${keyResult.reason}.`);
} catch (err) {
  console.error('Could not read the API key file:', err.message);
}
try {
  const applied = applyCopySettings();
  if (applied?.length) console.log(`Applied the settings this copy of the app came with: ${applied.join(', ')}.`);
} catch (err) {
  console.error('Could not apply copy-settings.json:', err.message);
}

recoverInterruptedRuns();
holdQueueAfterRestart();
startScheduler();
const dailyBackup = () => {
  try {
    backupDatabaseIfDue();
  } catch (err) {
    console.error('Database backup failed:', err.message);
  }
};
dailyBackup();
setInterval(dailyBackup, 3600_000).unref();
checkDefaultModel().catch(() => {});
