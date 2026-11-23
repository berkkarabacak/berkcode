// The run lifecycle shared by all agents: lock, checks, restore point, prompt, limits, progress check,
// change tracking and bookkeeping. The conversation itself is done by an agent adapter (src/agents/*).
// A run is started by the schedule, by "Run now", or by a message the owner types in the chat.
import fs from 'node:fs';
import { db, now, checkpoint } from './db.js';
import { emit } from './events.js';
import { samePath } from './paths.js';
import { getSetting, setSetting } from './settings.js';
import { redact } from './redact.js';
import { getProject, setProjectFields, effectiveLimits, monthCost, budgetPaused, currentMonthKey, AGENTS } from './projects.js';
import { ensureStandardEntries, getEntry, memoryStore, parsePlan } from './memory.js';
import { buildPrompt, buildChatPrompt, chatTurnPrompt, progressFollowUp, sessionStamp, SYSTEM_APPEND, CHAT_SYSTEM_APPEND } from './prompt.js';
import { createRestorePoint, fingerprintFolder, diffFingerprints } from './restorePoints.js';
import { runClaudeConversation } from './agents/claude.js';
import { runKimiConversation, KIMI_RULES } from './agents/kimi.js';

const HARD_STOP_MS = 20_000;
export const PLAN_DONE_NOTE = 'All plan steps are done, so the schedule was paused. Add new steps to the plan, then turn the schedule on again under Scheduled tasks.';
const ADAPTERS = { claude: runClaudeConversation, kimi: runKimiConversation };
export const MAX_MESSAGE_LENGTH = 20_000;

/** projectId -> run context */
const active = new Map();

class RunError extends Error {}

export function activeRunId(projectId) {
  return active.get(Number(projectId))?.runId ?? null;
}

export function activeRunCount() {
  return active.size;
}

/** The conversation the active run of a project belongs to (or null). */
export function activeConversationId(projectId) {
  return active.get(Number(projectId))?.conversationId ?? null;
}

// ---------- The queue: messages waiting for their turn ----------
// A message the owner sends while the agent is busy waits in the queue (in the database, so a restart does not lose
// it). The agent gets the messages one at a time and in order: each one when it finishes its current reply, in the
// same session; whatever still waits when the run is over starts the next run. A message that starts a new
// conversation waits until the current run is over. After Stop, a failed run or a restart, waiting messages are
// held: they stay in the queue, but are only sent when the owner says so.

export const HELD_STOPPED = 'Not sent, because you pressed Stop.';
export const HELD_FAILED = 'Not sent, because the session before it ended with a problem.';
export const HELD_RESTART = 'Not sent, because the app was closed before it was its turn.';

const queueRows = db.prepare('SELECT * FROM chat_queue WHERE project_id = ? ORDER BY id');
const firstWaiting = db.prepare('SELECT * FROM chat_queue WHERE project_id = ? AND held_reason IS NULL ORDER BY id LIMIT 1');
const deleteQueued = db.prepare('DELETE FROM chat_queue WHERE id = ?');
const queueItem = (r) => ({ id: r.id, text: r.text, at: r.created_at, new_conversation: Boolean(r.new_conversation), held_reason: r.held_reason ?? null });
const queueChanged = (projectId, extra = {}) => emit('chat-queued', { projectId: Number(projectId), ...extra });

export function queuedMessages(projectId) {
  return queueRows.all(Number(projectId)).map(queueItem);
}

/**
 * Puts a message at the end of the queue. `newConversation`: it starts a new conversation. Messages for that new
 * chat written before it has started continue it, instead of starting yet another one.
 */
export function queueMessage(projectId, text, { newConversation = false } = {}) {
  projectId = Number(projectId);
  const startsNew =
    newConversation && !db.prepare('SELECT 1 FROM chat_queue WHERE project_id = ? AND new_conversation = 1 AND held_reason IS NULL').get(projectId);
  const res = db
    .prepare('INSERT INTO chat_queue(project_id, text, created_at, new_conversation) VALUES (?, ?, ?, ?)')
    .run(projectId, String(text), now(), startsNew ? 1 : 0);
  queueChanged(projectId);
  return queueItem(db.prepare('SELECT * FROM chat_queue WHERE id = ?').get(Number(res.lastInsertRowid)));
}

/** The next waiting message, for the agent's pause; null when there is none or it must start a new conversation. */
function takeForPause(projectId) {
  const next = firstWaiting.get(projectId);
  if (!next || next.new_conversation) return null;
  deleteQueued.run(next.id);
  queueChanged(projectId);
  return next;
}

/** Holds the waiting messages (or the one with `id`). */
function holdQueued(projectId, reason, id = null) {
  const res = id
    ? db.prepare('UPDATE chat_queue SET held_reason = ? WHERE id = ? AND held_reason IS NULL').run(reason, id)
    : db.prepare('UPDATE chat_queue SET held_reason = ? WHERE project_id = ? AND held_reason IS NULL').run(reason, projectId);
  if (res.changes) queueChanged(projectId);
}

/** Starts a run with the first waiting message if the agent is free. Returns the run, or null. */
export function sendNextQueued(projectId) {
  projectId = Number(projectId);
  if (active.has(projectId)) return null;
  const next = firstWaiting.get(projectId);
  if (!next) return null;
  let r;
  try {
    r = startRun(projectId, 'chat', { message: next.text, newConversation: Boolean(next.new_conversation) });
  } catch (err) {
    holdQueued(projectId, `Not sent: ${err.message}`, next.id);
    return null;
  }
  if (r.status === 'skipped') {
    holdQueued(projectId, `Not sent: ${r.reason.replace(/^skipped: /, '')}.`, next.id);
    return null;
  }
  deleteQueued.run(next.id);
  queueChanged(projectId, { started: { id: next.id, runId: r.runId, conversationId: r.conversationId, newConversation: Boolean(next.new_conversation) } });
  return r;
}

/**
 * A message from the owner: it starts the agent when the agent is free and nothing else waits, otherwise it joins
 * the queue. Returns the started run ({ runId, conversationId, status }) or { queued: true, item }.
 */
export function sendMessage(projectId, text, { newConversation = false } = {}) {
  projectId = Number(projectId);
  if (active.has(projectId) || firstWaiting.get(projectId)) {
    const item = queueMessage(projectId, text, { newConversation });
    sendNextQueued(projectId);
    return { queued: true, item };
  }
  return startRun(projectId, 'chat', { message: String(text), newConversation });
}

/** "Send" for held messages (one, or all of them): they wait for their turn again; the agent starts if it is free. */
export function releaseQueued(projectId, id = null) {
  projectId = Number(projectId);
  const res = id
    ? db.prepare('UPDATE chat_queue SET held_reason = NULL WHERE project_id = ? AND id = ? AND held_reason IS NOT NULL').run(projectId, Number(id))
    : db.prepare('UPDATE chat_queue SET held_reason = NULL WHERE project_id = ? AND held_reason IS NOT NULL').run(projectId);
  if (!res.changes) return false;
  queueChanged(projectId);
  sendNextQueued(projectId);
  return true;
}

export function removeQueued(projectId, id) {
  const res = db.prepare('DELETE FROM chat_queue WHERE project_id = ? AND id = ?').run(Number(projectId), Number(id));
  if (res.changes) queueChanged(projectId);
  return res.changes > 0;
}

export function clearQueue(projectId) {
  const res = db.prepare('DELETE FROM chat_queue WHERE project_id = ?').run(Number(projectId));
  if (res.changes) queueChanged(projectId);
}

/** After a restart nothing is sent by itself: messages that were still waiting are held. */
export function holdQueueAfterRestart() {
  db.prepare('UPDATE chat_queue SET held_reason = ? WHERE held_reason IS NULL').run(HELD_RESTART);
}

// ---------- Starting and stopping ----------

const insertRun = db.prepare('INSERT INTO runs(project_id, trigger, started_at, status, ended_at, error, agent) VALUES (?, ?, ?, ?, ?, ?, ?)');
const insertLog = db.prepare('INSERT INTO run_logs(run_id, seq, ts, type, content) VALUES (?, ?, ?, ?, ?)');

function recordSkipped(project, trigger, reason) {
  const ts = now();
  const res = insertRun.run(project.id, trigger, ts, 'skipped', ts, reason, project.agent);
  const runId = Number(res.lastInsertRowid);
  emit('run-updated', { projectId: project.id, runId, status: 'skipped' });
  return { runId, status: 'skipped', reason };
}

/** The monthly cap is about API spending, so it only applies to agents billed per use (Claude). */
function capReached(project) {
  if (AGENTS[project.agent].billing !== 'api') return false;
  const cap = getSetting('monthly_cap_usd');
  return budgetPaused() || (cap > 0 && monthCost() >= cap);
}

/** Why the next run should start a fresh session instead of continuing the previous one (or null). */
export function freshSessionReason(project, limits = effectiveLimits(project)) {
  if (!project.session_id) return 'no previous session';
  if (project.fresh_pending) return 'a fresh session was requested';
  // The previous session knows the old location; continuing it could make the agent work in the old folder.
  if (project.session_folder && !samePath(project.session_folder, project.folder)) return 'the project folder has moved';
  if (project.runs_on_session >= project.fresh_every) return `${project.runs_on_session} runs on the previous session`;
  if (project.agent === 'kimi') {
    const last = db
      .prepare('SELECT model, effort FROM runs WHERE project_id = ? AND session_id = ? AND model IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get(project.id, project.session_id);
    if (last && project.model && last.model !== project.model) return 'the model was changed';
    if (last && limits.effort && last.effort && last.effort !== limits.effort) return 'the thinking effort was changed';
  }
  return null;
}

/**
 * The conversation a new run belongs to: the current one when the agent session continues, a new one (named
 * after this run) when it starts fresh. A fresh start whose previous attempt never got a session (for example
 * because Kimi was logged out) stays in that conversation, so retries do not leave a trail of empty ones.
 */
function pickConversation(project, runId, freshReason, forceNew) {
  const current = project.conversation_id;
  if (!current || forceNew) return runId;
  if (!freshReason) return current;
  const started = db.prepare('SELECT 1 FROM runs WHERE conversation_id = ? AND session_id IS NOT NULL LIMIT 1').get(current);
  return started ? runId : current;
}

/**
 * Starts a run unless one is already active for the project. Returns immediately.
 * `message` (chat): the owner's message for the agent. `newConversation`: start a new conversation with it.
 */
export function startRun(projectId, trigger = 'manual', { message = null, newConversation = false } = {}) {
  projectId = Number(projectId);
  let project = getProject(projectId);
  if (!project) throw new Error('Project not found');

  if (active.has(projectId)) return recordSkipped(project, trigger, 'skipped: previous run still active');
  if (capReached(project)) return recordSkipped(project, trigger, 'skipped: monthly budget cap reached');

  if (newConversation && !project.fresh_pending) {
    setProjectFields(projectId, { fresh_pending: 1 });
    project = getProject(projectId);
  }
  const freshReason = freshSessionReason(project);
  const res = insertRun.run(projectId, trigger, now(), 'running', null, null, project.agent);
  const runId = Number(res.lastInsertRowid);
  const conversationId = pickConversation(project, runId, freshReason, newConversation);
  db.prepare('UPDATE runs SET conversation_id = ?, user_message = ? WHERE id = ?').run(conversationId, message ? String(message) : null, runId);
  if (project.conversation_id !== conversationId) setProjectFields(projectId, { conversation_id: conversationId });

  const ctx = {
    runId,
    conversationId,
    freshReason,
    message: message ? String(message) : null,
    abort: new AbortController(),
    stopReason: null,
    conversation: null,
    hardStopTimer: null,
    requestStop(reason) {
      if (this.stopReason) return;
      this.stopReason = reason;
      this.conversation?.interrupt();
      this.hardStopTimer = setTimeout(() => this.abort.abort(), HARD_STOP_MS);
    },
  };
  active.set(projectId, ctx);
  emit('run-updated', { projectId, runId, conversationId, status: 'running' });
  console.log(`Run #${runId} started for project "${project.name}" (${AGENTS[project.agent].label}, ${trigger}).`);

  executeRun(project, runId, ctx).catch((err) => console.error(`Run ${runId} crashed:`, err));
  return { runId, conversationId, status: 'running' };
}

export function stopRun(projectId) {
  const ctx = active.get(Number(projectId));
  if (!ctx) return false;
  ctx.requestStop('stopped');
  return true;
}

/** Stops every active run (the app is closing) and resolves once all of them have been recorded (or after the timeout). */
export async function stopAllRuns(timeoutMs = 30_000) {
  for (const ctx of active.values()) ctx.requestStop('shutdown');
  const deadline = Date.now() + timeoutMs;
  while (active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
}

// ---------- One run ----------

async function executeRun(project, runId, ctx) {
  const projectId = project.id;
  const agent = AGENTS[project.agent];
  const limits = effectiveLimits(project);
  const chat = Boolean(ctx.message);
  const startedMs = Date.now();
  let seq = 0;
  const log = (type, content) => {
    const entry = { runId, projectId, seq: ++seq, ts: now(), type, content: redact(content) };
    insertLog.run(runId, entry.seq, entry.ts, type, entry.content);
    emit('log', entry);
  };
  if (chat) log('user', ctx.message);

  let status = 'failed';
  let error = null;
  let summary = null;
  let turns = 0;
  let cost = null;
  let lastTotalCost = null;
  let sessionId = null;
  let sessionMode = null;
  let model = limits.model;
  let before = null;
  let progressBefore = '';
  const memoryWritten = new Set();

  const timer = setTimeout(() => ctx.requestStop('timeout'), limits.maxMinutes * 60_000);
  const progressContent = () => getEntry(projectId, '/memories/progress.md')?.content ?? '';
  const progressWritten = () => {
    const after = progressContent();
    return memoryWritten.has('/memories/progress.md') && after !== progressBefore && after.length > progressBefore.length;
  };
  const changesSoFar = () => {
    try {
      return before ? diffFingerprints(before, fingerprintFolder(project.folder)) : null;
    } catch {
      return null;
    }
  };
  const filesChanged = () => {
    const c = changesSoFar();
    return Boolean(c && c.added.length + c.changed.length + c.removed.length);
  };

  try {
    if (agent.billing === 'api' && !getSetting('api_key')) throw new RunError('No Claude API key is set. Open Settings and enter your API key.');
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
    const freshReason = ctx.freshReason;
    const resumeId = freshReason ? null : fresh.session_id;
    const baseline = resumeId ? fresh.session_cost_total || 0 : 0;
    sessionMode = resumeId ? 'resumed' : 'fresh';
    log('system', resumeId
      ? `Continuing the previous ${agent.label} session (run ${fresh.runs_on_session + 1} on this session).`
      : `Starting a fresh ${agent.label} session (${freshReason}). The agent relies on its memory.`);

    // Claude gets the standing rules through its system prompt; Kimi has no such channel, so they lead the
    // first prompt of a session (and every scheduled prompt, as before).
    const systemAppend = chat ? CHAT_SYSTEM_APPEND : SYSTEM_APPEND;
    const kimiRules = `${systemAppend.trim()}\n${KIMI_RULES}\n\n`;
    const freshBody = chat ? buildChatPrompt(fresh, ctx.message) : buildPrompt(fresh);
    const freshPrompt = project.agent === 'kimi' ? kimiRules + freshBody : freshBody;
    let prompt = freshPrompt;
    if (resumeId && chat) prompt = chatTurnPrompt(fresh, ctx.message);
    else if (resumeId) prompt = project.agent === 'kimi' ? kimiRules + buildPrompt(fresh) : buildPrompt(fresh);
    log('prompt', prompt);

    let followUpSent = false;
    // Between turns: first hand over messages the owner typed meanwhile, then make sure progress was recorded.
    const onTurnEnd = () => {
      if (ctx.stopReason) return null;
      const queued = takeForPause(projectId);
      if (queued) {
        log('user', queued.text);
        return { text: chatTurnPrompt(getProject(projectId) ?? project, queued.text), limited: true };
      }
      if (followUpSent || progressWritten()) return null;
      if (chat && !filesChanged()) return null; // a question that changed nothing needs no progress note
      followUpSent = true;
      log('warning', 'The agent finished without writing a progress entry. Asking it to write one now.');
      return { text: progressFollowUp(sessionStamp(project.timezone)), limited: false };
    };

    const r = await ADAPTERS[project.agent]({
      ctx, projectId, folder: project.folder, limits, prompt, freshPrompt, resumeId, runId, log, memoryWritten, onTurnEnd, systemAppend,
    });
    sessionId = r.sessionId;
    turns = r.turns;
    model = r.model ?? model;
    if (resumeId && !r.resumed) {
      sessionMode = 'fresh (resume failed)';
      // The old session could not be continued, so this run starts a new conversation.
      ctx.conversationId = runId;
      db.prepare('UPDATE runs SET conversation_id = ? WHERE id = ?').run(runId, runId);
      setProjectFields(projectId, { conversation_id: runId });
      emit('run-updated', { projectId, runId, conversationId: runId, status: 'running' });
    }

    if (agent.billing === 'api') {
      lastTotalCost = r.costTotal;
      const base = sessionMode === 'resumed' ? baseline : 0;
      if (lastTotalCost != null) cost = lastTotalCost >= base - 1e-9 ? lastTotalCost - base : lastTotalCost;
      else if (turns > 0) log('warning', 'The cost of this run could not be read because it ended abruptly.');
    }

    const main = r.outcomes[0];
    if (ctx.stopReason) {
      // status set in finally
    } else if (r.fatal) {
      throw new RunError(r.error);
    } else if (main === 'success') {
      summary = r.summary;
      if (progressWritten() || chat) {
        status = 'success';
      } else {
        status = 'failed';
        error = 'The session ended without writing a progress entry, even after being asked.';
      }
    } else if (main === 'max_turns' || main === 'max_budget') {
      status = 'limit_reached';
      error = main === 'max_turns' ? `Step limit reached (${limits.maxTurns} steps).` : `Budget limit for one run reached ($${limits.budgetUsd}).`;
    } else {
      status = 'failed';
      error = r.error || 'The agent stopped unexpectedly.';
    }
  } catch (err) {
    status = 'failed';
    error = err instanceof RunError ? err.message : `Unexpected error: ${err.message}`;
    if (!(err instanceof RunError)) console.error(err);
  } finally {
    clearTimeout(timer);
    clearTimeout(ctx.hardStopTimer);
    if (ctx.stopReason === 'stopped' || ctx.stopReason === 'shutdown') {
      status = 'stopped';
      error = ctx.stopReason === 'stopped' ? 'Stopped by the owner.' : 'Stopped because the app was closed.';
    } else if (ctx.stopReason === 'timeout') {
      status = 'limit_reached';
      error = `Time limit reached (${limits.maxMinutes} minutes).`;
    }

    const changedFiles = changesSoFar();
    const anyChange = Boolean(changedFiles && changedFiles.added.length + changedFiles.changed.length + changedFiles.removed.length);

    let agentNote = null;
    try {
      // Scheduled sessions must leave a note; chat sessions only when they changed files.
      const needsNote = chat ? anyChange : status !== 'success';
      if (needsNote && turns > 0 && !progressWritten()) {
        const what = status === 'success' ? 'Chat session changed files' : `Session ended early (run #${runId}, ${status.replace('_', ' ')})`;
        agentNote = `## ${sessionStamp(project.timezone)} — ${what}\n` +
          `- Done: not recorded by the agent. See run #${runId} in the app for the full conversation.\n` +
          (status === 'success' ? `- Files changed: ${[...changedFiles.added, ...changedFiles.changed, ...changedFiles.removed].slice(0, 12).join(', ')}\n` : `- Problem: ${(error ?? 'unknown').split('\n')[0]}\n`) +
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
        log('system', 'Every step of the plan is done, so the schedule was paused. Add new steps to the plan (or just ask in the chat) and turn the schedule on again under Scheduled tasks when you want more scheduled work.');
      }
    }

    db.prepare(
      `UPDATE runs SET ended_at = ?, status = ?, session_id = ?, session_mode = ?, turns = ?, cost_usd = ?, duration_ms = ?,
       summary = ?, changed_files = ?, memory_written = ?, error = ?, agent_note = ?, agent = ?, model = ?, effort = ? WHERE id = ?`
    ).run(
      now(), status, sessionId, sessionMode, turns, cost == null ? null : Math.round(cost * 10000) / 10000, Date.now() - startedMs,
      summary ? redact(summary) : null, changedFiles ? JSON.stringify(changedFiles) : null,
      JSON.stringify([...memoryWritten].sort()), error ? redact(error) : null, agentNote, project.agent, model ?? null, limits.effort ?? null, runId
    );

    const latest = getProject(projectId);
    if (latest) {
      const fields = {};
      if (sessionId && turns > 0) {
        fields.session_id = sessionId;
        fields.session_folder = project.folder;
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
          fields.paused_reason = PLAN_DONE_NOTE;
        }
      }
      setProjectFields(projectId, fields);
    }

    active.delete(projectId);
    if (!active.size) checkpoint();
    console.log(`Run #${runId} finished: ${status}${error ? ` (${error.split('\n')[0]})` : ''}, ${turns} steps${cost != null ? `, $${cost.toFixed(4)}` : ''}.`);

    const cap = getSetting('monthly_cap_usd');
    if (agent.billing === 'api' && cap > 0 && monthCost() >= cap && !budgetPaused()) {
      setSetting('budget_paused_month', currentMonthKey());
      emit('budget-paused', { cap });
    }
    emit('run-updated', { projectId, runId, conversationId: ctx.conversationId, status });
    emit('projects-changed', {});

    // Messages still waiting start the next run. After Stop, a failure or when the app closes they are held instead.
    if (firstWaiting.get(projectId)) {
      if (ctx.stopReason === 'stopped') holdQueued(projectId, HELD_STOPPED);
      else if (ctx.stopReason === 'shutdown') holdQueued(projectId, HELD_RESTART);
      else if (status === 'failed') holdQueued(projectId, HELD_FAILED);
      else {
        setTimeout(() => {
          try {
            sendNextQueued(projectId);
          } catch (err) {
            console.error(`The next queued message for project ${projectId} could not be sent:`, err.message);
          }
        }, 300);
      }
    }
  }
}

/** Marks runs left in "running" state by a crash or power cut as failed. */
export function recoverInterruptedRuns() {
  db.prepare("UPDATE runs SET status = 'failed', ended_at = ?, error = 'The app was closed or the computer was turned off while this run was active.' WHERE status = 'running'").run(now());
}
