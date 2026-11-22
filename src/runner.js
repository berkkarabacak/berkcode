import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { db, now } from './db.js';
import { AGENT_HOME, appVersion } from './paths.js';
import { emit } from './events.js';
import { getSetting, setSetting } from './settings.js';
import { redact } from './redact.js';
import { getProject, setProjectFields, effectiveLimits, monthCost, budgetPaused, currentMonthKey } from './projects.js';
import { ensureStandardEntries, getEntry, memoryStore, parsePlan } from './memory.js';
import { createMemoryServer, MEMORY_SERVER, MEMORY_TOOL, SEARCH_TOOL } from './memoryTools.js';
import { buildPrompt, progressFollowUp, sessionStamp, SYSTEM_APPEND } from './prompt.js';
import { createRestorePoint, fingerprintFolder, diffFingerprints } from './restorePoints.js';
import { formatMessage } from './logFormat.js';

/** Built-in tools that make no sense in an unattended, scheduled session. */
const DISALLOWED_TOOLS = [
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'PushNotification', 'RemoteTrigger',
  'EnterWorktree', 'ExitWorktree', 'SendMessage', 'ListAgents', 'DesignSync', 'Workflow',
];
const FATAL_API_ERRORS = new Set(['authentication_failed', 'billing_error', 'model_not_found', 'oauth_org_not_allowed', 'account_on_hold']);
const HARD_STOP_MS = 20_000;

/** projectId -> run context */
const active = new Map();

class RunError extends Error {}

export function activeRunId(projectId) {
  return active.get(Number(projectId))?.runId ?? null;
}

export function activeRunCount() {
  return active.size;
}

const insertRun = db.prepare('INSERT INTO runs(project_id, trigger, started_at, status, ended_at, error) VALUES (?, ?, ?, ?, ?, ?)');
const insertLog = db.prepare('INSERT INTO run_logs(run_id, seq, ts, type, content) VALUES (?, ?, ?, ?, ?)');

function recordSkipped(projectId, trigger, reason) {
  const ts = now();
  const res = insertRun.run(projectId, trigger, ts, 'skipped', ts, reason);
  const runId = Number(res.lastInsertRowid);
  emit('run-updated', { projectId, runId, status: 'skipped' });
  return { runId, status: 'skipped', reason };
}

function capReached() {
  const cap = getSetting('monthly_cap_usd');
  return budgetPaused() || (cap > 0 && monthCost() >= cap);
}

/** Starts a run unless one is already active for the project. Returns immediately. */
export function startRun(projectId, trigger = 'manual') {
  projectId = Number(projectId);
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');

  if (active.has(projectId)) return recordSkipped(projectId, trigger, 'skipped: previous run still active');
  if (capReached()) return recordSkipped(projectId, trigger, 'skipped: monthly budget cap reached');

  const res = insertRun.run(projectId, trigger, now(), 'running', null, null);
  const runId = Number(res.lastInsertRowid);
  const ctx = {
    runId,
    abort: new AbortController(),
    stopReason: null,
    conversation: null,
    hardStopTimer: null,
    requestStop(reason) {
      if (this.stopReason) return;
      this.stopReason = reason;
      this.conversation?.q.interrupt().catch(() => {});
      this.conversation?.input.close();
      this.hardStopTimer = setTimeout(() => this.abort.abort(), HARD_STOP_MS);
    },
  };
  active.set(projectId, ctx);
  emit('run-updated', { projectId, runId, status: 'running' });
  console.log(`Run #${runId} started for project "${project.name}" (${trigger}).`);

  executeRun(project, runId, ctx).catch((err) => console.error(`Run ${runId} crashed:`, err));
  return { runId, status: 'running' };
}

export function stopRun(projectId) {
  const ctx = active.get(Number(projectId));
  if (!ctx) return false;
  ctx.requestStop('stopped');
  return true;
}

/** Stops every active run and resolves once all of them have been recorded (or after the timeout). */
export async function stopAllRuns(timeoutMs = 30_000) {
  for (const ctx of active.values()) ctx.requestStop('stopped');
  const deadline = Date.now() + timeoutMs;
  while (active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
}

/** A tiny async queue used as the streaming prompt, so follow-up messages and interrupts are possible. */
function promptQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(text) {
      if (closed) return;
      items.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length) yield items.shift();
        else if (closed) return;
        else await new Promise((resolve) => (wake = resolve));
        wake = null;
      }
    },
  };
}

function agentEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH|CLAUDE_CONFIG_DIR$|AWS_BEARER_TOKEN_BEDROCK$)/i.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    ANTHROPIC_API_KEY: getSetting('api_key'),
    CLAUDE_CONFIG_DIR: AGENT_HOME,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_MAX_RETRIES: '4',
    CLAUDE_AGENT_SDK_CLIENT_APP: `claude-agent-runner/${appVersion()}`,
  };
}

function explainApiError(code, model) {
  switch (code) {
    case 'authentication_failed':
      return 'The Claude API key was rejected. Open Settings, paste a valid key and press "Test key".';
    case 'billing_error':
      return 'The Anthropic account behind the API key has a billing problem (for example no credit left). Check the Claude Console (console.anthropic.com → Billing).';
    case 'model_not_found':
      return `The model "${model}" is not available for this API key. Choose another model in the project's Setup tab or in Settings.`;
    case 'rate_limit':
      return 'The Anthropic API is limiting requests right now. The app retried several times and then gave up. The next run will try again.';
    case 'overloaded':
    case 'server_error':
      return 'The Anthropic API is overloaded or having problems right now. The app retried several times and then gave up. The next run will try again.';
    case 'account_on_hold':
    case 'oauth_org_not_allowed':
      return 'The Anthropic account cannot be used right now. Check the Claude Console.';
    default:
      return null;
  }
}

async function executeRun(project, runId, ctx) {
  const projectId = project.id;
  const limits = effectiveLimits(project);
  const startedMs = Date.now();
  let seq = 0;
  const log = (type, content) => {
    const entry = { runId, projectId, seq: ++seq, ts: now(), type, content: redact(content) };
    insertLog.run(runId, entry.seq, entry.ts, type, entry.content);
    emit('log', entry);
  };

  let status = 'failed';
  let error = null;
  let summary = null;
  let turns = 0;
  let cost = 0;
  let lastTotalCost = null;
  let sessionId = null;
  let sessionMode = null;
  let before = null;
  let progressBefore = '';
  const memoryWritten = new Set();
  const stderrTail = [];

  const timer = setTimeout(() => ctx.requestStop('timeout'), limits.maxMinutes * 60_000);
  const progressContent = () => getEntry(projectId, '/memories/progress.md')?.content ?? '';
  const progressWritten = () => {
    const after = progressContent();
    return memoryWritten.has('/memories/progress.md') && after !== progressBefore && after.length > progressBefore.length;
  };

  /** Runs one agent conversation. The follow-up asking for a progress entry is sent in the same session. */
  async function converse(prompt, resumeId) {
    const input = promptQueue();
    input.push(prompt);
    const out = { sessionId: null, results: [], assistantCount: 0, apiError: null, exception: null };
    let followUpSent = false;
    const q = query({
      prompt: input,
      options: {
        cwd: project.folder,
        model: limits.model,
        maxTurns: limits.maxTurns,
        maxBudgetUsd: limits.budgetUsd,
        resume: resumeId || undefined,
        abortController: ctx.abort,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        mcpServers: { [MEMORY_SERVER]: createMemoryServer(projectId, { changedBy: `run #${runId}`, onWrite: (p) => memoryWritten.add(p) }) },
        allowedTools: [MEMORY_TOOL, SEARCH_TOOL],
        disallowedTools: DISALLOWED_TOOLS,
        strictMcpConfig: true,
        settingSources: [],
        settings: { autoMemoryEnabled: false },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
        env: agentEnv(),
        stderr: (data) => {
          stderrTail.push(redact(String(data)));
          if (stderrTail.length > 40) stderrTail.shift();
        },
      },
    });
    ctx.conversation = { q, input };
    if (ctx.stopReason) {
      q.interrupt().catch(() => {});
      input.close();
    }
    try {
      for await (const msg of q) {
        if (msg.session_id) out.sessionId = msg.session_id;
        if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
          out.assistantCount++;
          if (msg.error) {
            out.apiError = msg.error;
            if (FATAL_API_ERRORS.has(msg.error)) input.close();
          }
        }
        for (const entry of formatMessage(msg)) log(entry.type, entry.content);
        if (msg.type === 'result') {
          out.results.push(msg);
          const mainOk = msg.subtype === 'success' && !msg.is_error;
          if (!ctx.stopReason && mainOk && !followUpSent && !progressWritten()) {
            followUpSent = true;
            log('warning', 'The agent finished without writing a progress entry. Asking it to write one now.');
            input.push(progressFollowUp(sessionStamp(project.timezone)));
          } else {
            input.close();
          }
        }
      }
    } catch (err) {
      out.exception = err;
    } finally {
      input.close();
      ctx.conversation = null;
    }
    for (const r of out.results) turns += r.num_turns ?? 0;
    const last = out.results.at(-1);
    if (last && typeof last.total_cost_usd === 'number') lastTotalCost = last.total_cost_usd;
    if (out.sessionId) sessionId = out.sessionId;
    return out;
  }

  try {
    if (!getSetting('api_key')) throw new RunError('No Claude API key is set. Open Settings and enter your API key.');
    let stat = null;
    try {
      stat = fs.statSync(project.folder);
    } catch {
      /* missing */
    }
    if (!stat?.isDirectory()) throw new RunError(`The project folder does not exist any more: ${project.folder}. Check the folder in the Setup tab.`);

    ensureStandardEntries(projectId);
    progressBefore = progressContent();

    log('system', 'Saving a restore point of the project folder…');
    const restoreRef = await createRestorePoint(project, runId, getSetting('backup_size_limit_mb'));
    if (restoreRef.type === 'git') log('system', `Restore point saved: git commit ${restoreRef.commit.slice(0, 10)}`);
    else if (restoreRef.type === 'zip') log('system', `Restore point saved (${restoreRef.files} files).`);
    if (restoreRef.warning) log('warning', restoreRef.warning);
    db.prepare('UPDATE runs SET restore_ref = ? WHERE id = ?').run(JSON.stringify(restoreRef), runId);
    if (ctx.stopReason) throw new RunError('Stopped before the agent started.');

    before = fingerprintFolder(project.folder);

    const fresh = getProject(projectId);
    const freshDue = !fresh.session_id || fresh.fresh_pending || fresh.runs_on_session >= fresh.fresh_every;
    const resumeId = freshDue ? null : fresh.session_id;
    let baseline = resumeId ? fresh.session_cost_total || 0 : 0;
    sessionMode = resumeId ? 'resumed' : 'fresh';
    log('system', resumeId ? `Continuing the previous session (run ${fresh.runs_on_session + 1} on this session).` : 'Starting a fresh session. The agent will rely on its memory.');

    const prompt = buildPrompt(fresh);
    log('prompt', prompt);

    let r = await converse(prompt, resumeId);

    const resumeFailed =
      resumeId && !ctx.stopReason && r.assistantCount === 0 && !FATAL_API_ERRORS.has(r.apiError) &&
      (r.exception || r.results.length === 0 || r.results.every((x) => x.is_error));
    if (resumeFailed) {
      const reason = r.exception?.message || r.results.flatMap((x) => x.errors ?? []).join('; ') || 'unknown reason';
      log('warning', `The previous session could not be continued (${redact(reason)}). Starting a fresh session instead; memory carries the project state.`);
      sessionMode = 'fresh (resume failed)';
      sessionId = null;
      baseline = 0;
      r = await converse(prompt, null);
    }

    if (lastTotalCost != null) cost = lastTotalCost >= baseline - 1e-9 ? lastTotalCost - baseline : lastTotalCost;
    else if (turns > 0) log('warning', 'The cost of this run could not be read because it ended abruptly.');

    const main = r.results[0];
    const fatal = explainApiError(r.apiError, limits.model);
    if (ctx.stopReason) {
      // status set in finally
    } else if (r.apiError && FATAL_API_ERRORS.has(r.apiError)) {
      throw new RunError(fatal);
    } else if (main?.subtype === 'success' && !main.is_error) {
      summary = main.result || r.results.at(-1)?.result || null;
      if (progressWritten()) {
        status = 'success';
      } else {
        status = 'failed';
        error = 'The session ended without writing a progress entry, even after being asked.';
      }
    } else if (main?.subtype === 'error_max_turns' || main?.subtype === 'error_max_budget_usd') {
      status = 'limit_reached';
      error = main.subtype === 'error_max_turns' ? `Turn limit reached (${limits.maxTurns} turns).` : `Budget limit for one run reached ($${limits.budgetUsd}).`;
    } else {
      status = 'failed';
      error =
        fatal ||
        main?.errors?.filter(Boolean).join('\n') ||
        (main?.is_error ? main.result : null) ||
        r.exception?.message ||
        'The agent stopped unexpectedly.';
      if (!main && stderrTail.length) error += `\n${stderrTail.slice(-5).join('').trim()}`;
    }
  } catch (err) {
    status = 'failed';
    error = err instanceof RunError ? err.message : `Unexpected error: ${err.message}`;
    if (!(err instanceof RunError)) console.error(err);
  } finally {
    clearTimeout(timer);
    clearTimeout(ctx.hardStopTimer);
    if (ctx.stopReason === 'stopped') {
      status = 'stopped';
      error = 'Stopped by the owner.';
    } else if (ctx.stopReason === 'timeout') {
      status = 'limit_reached';
      error = `Time limit reached (${limits.maxMinutes} minutes).`;
    }

    let changedFiles = null;
    if (before) {
      try {
        changedFiles = diffFingerprints(before, fingerprintFolder(project.folder));
      } catch {
        /* folder gone */
      }
    }

    let agentNote = null;
    try {
      if (status !== 'success' && turns > 0 && !progressWritten()) {
        agentNote = `## ${sessionStamp(project.timezone)} — Session ended early (run #${runId}, ${status.replace('_', ' ')})\n` +
          `- Done: not recorded by the agent. See run #${runId} in the app for the full log.\n` +
          `- Problem: ${(error ?? 'unknown').split('\n')[0]}\n` +
          `- Next step: check the project folder against the plan, then continue the step that was in progress.\n`;
        const current = progressContent();
        memoryStore(projectId, { changedBy: 'app', onWrite: (p) => memoryWritten.add(p) }).save('/memories/progress.md', `${current.replace(/\s*$/, '')}\n\n${agentNote}`);
      }
    } catch (err) {
      console.error('Could not write the automatic progress note:', err.message);
    }

    if (error) log(status === 'stopped' ? 'warning' : 'error', error);

    let planFinished = false;
    if (status === 'success') {
      const steps = parsePlan(getEntry(projectId, '/memories/plan.md')?.content);
      planFinished = steps.length > 0 && steps.every((s) => s.status === 'done');
      if (planFinished && getProject(projectId)?.enabled) {
        log('system', 'Every step of the plan is done, so the schedule was paused to save money. Add new steps to the plan and resume the schedule when you want more work done.');
      }
    }

    db.prepare(
      `UPDATE runs SET ended_at = ?, status = ?, session_id = ?, session_mode = ?, turns = ?, cost_usd = ?, duration_ms = ?,
       summary = ?, changed_files = ?, memory_written = ?, error = ?, agent_note = ? WHERE id = ?`
    ).run(
      now(), status, sessionId, sessionMode, turns, Math.round(cost * 10000) / 10000, Date.now() - startedMs,
      summary ? redact(summary) : null, changedFiles ? JSON.stringify(changedFiles) : null,
      JSON.stringify([...memoryWritten].sort()), error ? redact(error) : null, agentNote, runId
    );

    const latest = getProject(projectId);
    if (latest) {
      const fields = {};
      if (sessionId && turns > 0) {
        fields.session_id = sessionId;
        fields.runs_on_session = sessionMode?.startsWith('fresh') ? 1 : latest.runs_on_session + 1;
        fields.fresh_pending = 0;
        if (lastTotalCost != null) fields.session_cost_total = lastTotalCost;
      }
      if (status === 'failed') {
        fields.consecutive_failures = latest.consecutive_failures + 1;
        if (fields.consecutive_failures >= 3 && latest.enabled) {
          fields.enabled = 0;
          fields.paused_reason = `The schedule was paused after 3 failed runs in a row. Last problem: ${redact(error ?? 'unknown').slice(0, 300)}`;
        }
      } else if (status === 'success') {
        fields.consecutive_failures = 0;
        if (planFinished && latest.enabled) {
          fields.enabled = 0;
          fields.paused_reason = 'All plan steps are done, so the schedule was paused to save money. Add new steps to the plan, then press "Resume schedule".';
        }
      }
      setProjectFields(projectId, fields);
    }

    active.delete(projectId);
    console.log(`Run #${runId} finished: ${status}${error ? ` (${error.split('\n')[0]})` : ''}, ${turns} turns, $${cost.toFixed(4)}.`);

    const cap = getSetting('monthly_cap_usd');
    if (cap > 0 && monthCost() >= cap && !budgetPaused()) {
      setSetting('budget_paused_month', currentMonthKey());
      emit('budget-paused', { cap });
    }
    emit('run-updated', { projectId, runId, status });
    emit('projects-changed', {});
  }
}

/** Marks runs left in "running" state by a crash or power cut as failed. */
export function recoverInterruptedRuns() {
  db.prepare("UPDATE runs SET status = 'failed', ended_at = ?, error = 'The app was closed or the computer was turned off while this run was active.' WHERE status = 'running'").run(now());
}
