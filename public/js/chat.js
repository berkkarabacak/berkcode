// The conversation view: the runs of one conversation shown as a chat, live while the agent works, with the
// message box. app.js shows it for #/project/:id/chat/:conversation and #/project/:id/chat/new.
import {
  $, $$, esc, md, api, toast, attempt, confirmModal, fmtTime, fmtDuration, fmtCost, agentLabel, agentAvatar, agentBadge, icon, state,
} from './util.js';

/** Log entries that are the agent's working steps; they are folded into a "steps" box. */
const STEP_TYPES = new Set(['tool', 'tool_result', 'tool_error', 'memory']);
/** App notes worth showing in the conversation; the other system lines are bookkeeping. */
const SHOWN_SYSTEM = /^Starting a fresh|plan is done|schedule was paused/i;

let view = null;

const isNearBottom = () => !view || view.scroll.scrollHeight - view.scroll.scrollTop - view.scroll.clientHeight < 140;
function scrollToBottom(force = false) {
  if (!view || (!force && !view.stick)) return;
  view.scroll.scrollTop = view.scroll.scrollHeight;
}

/** The project's folder shortened for the message box, e.g. "projects\My site". */
function shortFolder(folder) {
  const text = String(folder);
  const lower = text.toLowerCase();
  const i = Math.max(lower.lastIndexOf('\\projects\\'), lower.lastIndexOf('/projects/'));
  return i >= 0 ? text.slice(i + 1) : text;
}

/** Turns absolute paths inside the project folder into short relative ones. */
function relativize(text, folder) {
  if (!folder) return text;
  const variants = [folder, folder.replace(/\\/g, '/')].map((f) => f.replace(/[\\/]+$/, ''));
  let out = String(text);
  for (const v of variants) out = out.split(`${v}\\`).join('').split(`${v}/`).join('').split(v).join('.');
  return out;
}

export function closeChat() {
  if (view?.timer) clearInterval(view.timer);
  view = null;
}

/** Shows a conversation (a number) or a new, empty one ('new') in `el`. */
export async function renderChat(el, project, conversationId, { focusRun = null, stale = () => false } = {}) {
  closeChat();
  const isNew = conversationId === 'new';
  const data = isNew ? null : await api('GET', `/api/projects/${project.id}/conversations/${conversationId}`);
  if (stale()) return;
  const writable = isNew || data.current;
  el.innerHTML = `
    <div class="chat">
      <div class="chat-scroll" id="chat-scroll">
        <div class="chat-inner">
          ${isNew ? introHtml(project) : ''}
          ${data?.earlier ? `<div class="earlier"><button class="linklike" id="load-earlier">Show ${data.earlier} earlier session${data.earlier === 1 ? '' : 's'}</button></div>` : ''}
          <div id="turns"></div>
          <div id="working"></div>
          <div id="moved"></div>
        </div>
      </div>
      ${writable ? composerHtml(project, isNew) : readOnlyHtml(project)}
    </div>`;
  view = {
    projectId: project.id,
    conversationId: isNew ? 'new' : Number(conversationId),
    project,
    el,
    scroll: $('#chat-scroll', el),
    turns: new Map(),
    pending: new Map(),
    timer: null,
    stick: true,
    writable,
    sent: new Set(), // ids of queued messages written (or sent) in this view
  };
  view.scroll.addEventListener('scroll', () => view && (view.stick = isNearBottom()));
  for (const run of data?.runs ?? []) addTurn(run);
  renderQueue();
  renderWorking();
  if (writable) wireComposer(isNew);
  $('#load-earlier', el)?.addEventListener('click', () => loadEarlier(data.runs[0]?.id));
  $$('[data-suggest]', el).forEach((b) =>
    b.addEventListener('click', () => {
      const input = $('#composer-input');
      input.value = b.dataset.suggest;
      input.dispatchEvent(new Event('input'));
      input.focus();
    })
  );
  const target = focusRun && view.turns.get(Number(focusRun));
  if (target) {
    target.el.scrollIntoView({ block: 'start' });
    target.el.classList.add('highlight');
    setTimeout(() => target.el.classList.remove('highlight'), 2500);
    view.stick = isNearBottom();
  } else {
    scrollToBottom(true);
  }
}

function introHtml(project) {
  const label = agentLabel(project.agent);
  const suggestions = [
    ['Where are we?', 'What is the current state of the project? Summarise what is done and what comes next, in plain words.'],
    ['Continue the plan', 'Continue with the next step of the plan.'],
    ['Check for problems', 'Check the project for problems and fix the most important one.'],
  ];
  return `<div class="chat-intro">
      <div class="intro-mark">${agentAvatar(project.agent)}</div>
      <h1>What should ${label} do?</h1>
      <p class="muted">A new conversation starts a fresh ${label} session. ${label} reads the project's memory first, so it knows the brief, the plan and what earlier sessions did.</p>
      <div class="suggestions">${suggestions.map(([t, s]) => `<button type="button" data-suggest="${esc(s)}">${esc(t)}</button>`).join('')}</div>
    </div>`;
}

function composerHtml(project, isNew) {
  const label = agentLabel(project.agent);
  return `<div class="composer-wrap">
      <div class="queue" id="queue" hidden></div>
      <form class="composer" id="composer">
        <textarea id="composer-input" rows="1" placeholder="${isNew ? `Tell ${label} what to do…` : `Reply to ${label}…`}" aria-label="Message for ${label}"></textarea>
        <div class="composer-bar">
          <div class="composer-info">${agentBadge(project.agent)}<span title="${esc(project.folder)}">${icon('folder', 13)} ${esc(shortFolder(project.folder))}</span></div>
          <div class="composer-actions">
            <button type="button" class="stop-btn" id="composer-stop" hidden>${icon('stop', 12)} Stop</button>
            <button type="submit" class="send-btn" id="composer-send" title="Send (Enter)" aria-label="Send" disabled>${icon('send', 18)}</button>
          </div>
        </div>
      </form>
      <div class="composer-hint" id="composer-hint">Enter to send, Shift+Enter for a new line. ${label} only works inside the project folder, and every session can be undone.</div>
    </div>`;
}

function readOnlyHtml(project) {
  const current = project.conversation_id;
  return `<div class="composer-wrap"><div class="readonly-bar">${icon('clock', 14)} This is an earlier conversation.
      ${current ? `<a href="#/project/${project.id}/chat/${current}">Go to the current conversation</a> or` : ''}
      <a href="#/project/${project.id}/chat/new">start a new chat</a>.</div></div>`;
}

// ---------- Runs ("turns") ----------

function addTurn(run, { prepend = false } = {}) {
  if (view.turns.has(run.id)) return updateTurn(run);
  const el = document.createElement('section');
  el.className = 'turn';
  el.dataset.run = run.id;
  el.innerHTML = `${run.user_message ? '' : dividerHtml(run)}<div class="turn-body"></div><div class="turn-end"></div>`;
  const turns = $('#turns', view.el);
  if (prepend) turns.prepend(el);
  else turns.append(el);
  const turn = { run, el, body: $('.turn-body', el), end: $('.turn-end', el), lastSeq: 0, group: null };
  view.turns.set(run.id, turn);
  for (const e of run.logs ?? []) appendEntry(turn, e);
  for (const e of view.pending.get(run.id) ?? []) appendEntry(turn, e);
  view.pending.delete(run.id);
  if (run.status !== 'running') closeGroup(turn);
  renderTurnEnd(turn);
  return turn;
}

function updateTurn(run) {
  const turn = view.turns.get(run.id);
  turn.run = run;
  for (const e of run.logs ?? []) appendEntry(turn, e);
  if (run.status !== 'running') closeGroup(turn);
  renderTurnEnd(turn);
  return turn;
}

function dividerHtml(run) {
  const label = run.trigger === 'schedule' ? 'Scheduled session' : run.trigger === 'manual' ? 'Session started with "Run now"' : 'Session';
  return `<div class="turn-divider"><span>${icon('clock', 13)} ${label} · ${esc(fmtTime(run.started_at))}</span></div>`;
}

function appendEntry(turn, e) {
  if (e.seq <= turn.lastSeq) return;
  turn.lastSeq = e.seq;
  if (STEP_TYPES.has(e.type)) {
    addStep(turn, e);
    return;
  }
  const html = entryHtml(turn, e);
  if (!html) return;
  closeGroup(turn);
  turn.body.insertAdjacentHTML('beforeend', html);
}

function entryHtml(turn, e) {
  const agent = turn.run.agent ?? view.project.agent;
  switch (e.type) {
    case 'user':
      return `<div class="msg user"><div class="bubble" title="${esc(fmtTime(e.ts))}">${esc(e.content)}</div></div>`;
    case 'assistant':
      return `<div class="msg agent">${agentAvatar(agent)}<div class="prose markdown">${md(relativize(e.content, view.project.folder))}</div></div>`;
    case 'prompt':
      return turn.run.user_message ? '' : `<details class="instructions"><summary>Instructions the app gave ${agentLabel(agent)}</summary><pre>${esc(e.content)}</pre></details>`;
    case 'warning':
      return e.content === 'Stopped by the owner.' ? '' : `<div class="note warn">${icon('alert', 14)}<span>${esc(e.content)}</span></div>`;
    case 'system':
      // A new chat is obviously a fresh session; other reasons (a changed model, a long session) are worth showing.
      if (turn.run.user_message && /^Starting a fresh .*\((no previous session|a fresh session was requested)\)/.test(e.content)) return '';
      return SHOWN_SYSTEM.test(e.content) ? `<div class="note">${esc(e.content)}</div>` : '';
    default:
      // "error" and "result" are summed up in the line under the run.
      return '';
  }
}

function addStep(turn, e) {
  if (!turn.group) {
    const box = document.createElement('details');
    box.className = 'steps';
    box.open = turn.run.status === 'running';
    box.innerHTML = `<summary>${icon('terminal', 14)}<span class="steps-label"></span>${icon('chevron', 14)}</summary><div class="steps-list"></div>`;
    box.addEventListener('toggle', () => {
      if (!box.dataset.auto) box.dataset.touched = '1';
      delete box.dataset.auto;
    });
    turn.body.append(box);
    turn.group = { box, list: $('.steps-list', box), count: 0, labels: [], last: null };
  }
  const g = turn.group;
  const text = relativize(e.content, view.project.folder);
  if (e.type === 'tool' || e.type === 'memory') {
    const [first, ...rest] = text.split('\n');
    g.count++;
    if (g.labels.length < 3) g.labels.push(first.length > 60 ? `${first.slice(0, 59)}…` : first);
    const row = document.createElement('div');
    row.className = `step ${e.type}`;
    row.innerHTML = `<span class="step-dot"></span><span class="step-text">${esc(first)}</span>${rest.length ? `<pre class="step-more">${esc(rest.join('\n'))}</pre>` : ''}`;
    g.list.append(row);
    g.last = row;
  } else {
    const long = text.length > 200 || text.split('\n').length > 3;
    const out = document.createElement(long ? 'details' : 'div');
    out.className = `step-out${e.type === 'tool_error' ? ' bad' : ''}`;
    out.innerHTML = long ? `<summary>${esc(text.split('\n')[0].slice(0, 120))} …</summary><pre>${esc(text)}</pre>` : `<pre>${esc(text)}</pre>`;
    (g.last ?? g.list).append(out);
  }
  $('.steps-label', g.box).textContent = `${g.count} step${g.count === 1 ? '' : 's'}${g.labels.length ? ` · ${g.labels.join(' · ')}` : ''}`;
}

/** Ends the current steps box; it folds up unless the owner opened or closed it by hand. */
function closeGroup(turn) {
  const g = turn.group;
  if (!g) return;
  if (!g.box.dataset.touched && g.box.open) {
    g.box.dataset.auto = '1';
    g.box.open = false;
  }
  turn.group = null;
}

function filesHtml(changed) {
  if (!changed) return '';
  const items = [
    ...changed.added.map((f) => `<div class="a">+ ${esc(f)}</div>`),
    ...changed.changed.map((f) => `<div class="m">~ ${esc(f)}</div>`),
    ...changed.removed.map((f) => `<div class="d">− ${esc(f)}</div>`),
  ];
  return `<div class="files">${items.join('')}</div>`;
}

function renderTurnEnd(turn) {
  const r = turn.run;
  if (r.status === 'running') {
    turn.end.innerHTML = '';
    return;
  }
  const agent = r.agent ?? view.project.agent;
  const head = {
    success: `${icon('check', 14)} Done`,
    stopped: `${icon('stop', 12)} Stopped`,
    limit_reached: `${icon('clock', 14)} ${esc(r.error ?? 'Limit reached')}`,
    skipped: `${icon('clock', 14)} Skipped`,
  }[r.status] ?? `${icon('alert', 14)} Did not finish`;
  const facts = [
    r.duration_ms != null ? fmtDuration(r.duration_ms) : null,
    r.turns ? `${r.turns} step${r.turns === 1 ? '' : 's'}` : null,
    agent === 'kimi' ? null : r.cost_usd != null ? fmtCost(r.cost_usd) : null,
  ].filter(Boolean);
  const changed = r.changed_count ?? 0;
  const canRestore = r.restore_available && !view.project.active_run_id;
  turn.end.innerHTML = `
    <div class="end-row ${esc(r.status)}">
      <span class="end-head">${head}</span>
      ${facts.length ? `<span class="end-facts">${facts.map(esc).join(' · ')}</span>` : ''}
      ${changed ? `<button type="button" class="linklike" data-files>${icon('file', 13)} ${changed} file${changed === 1 ? '' : 's'} changed</button>` : ''}
      ${canRestore && (changed || r.status !== 'success') ? `<button type="button" class="linklike" data-restore>${icon('undo', 13)} Undo: restore the folder to before this</button>` : ''}
    </div>
    ${r.status !== 'success' && r.status !== 'stopped' && r.error && r.status !== 'limit_reached' ? `<div class="end-error">${esc(r.error)}</div>` : ''}
    ${r.agent_note ? `<div class="end-note">The agent did not write a progress note, so the app added one to the project's memory.</div>` : ''}
    <div class="end-files" hidden>${filesHtml(r.changed_files)}</div>`;
  turn.end.querySelector('[data-files]')?.addEventListener('click', () => {
    const box = turn.end.querySelector('.end-files');
    box.hidden = !box.hidden;
  });
  turn.end.querySelector('[data-restore]')?.addEventListener('click', () => restoreBefore(r));
}

async function restoreBefore(run) {
  const ok = await confirmModal(
    'Restore the project folder?',
    `The folder <b>${esc(view.project.folder)}</b> will be put back exactly as it was before this session started. All changes made since then (by this session, later sessions or yourself) will be lost. The project's memory is not changed.`,
    'Restore folder'
  );
  if (!ok) return;
  const r = await attempt(() => api('POST', `/api/runs/${run.id}/restore`));
  if (!r) return;
  if (r.problems?.length) toast(`Folder restored, but ${r.problems.length} file(s) are open in another program and could not be replaced: ${r.problems.slice(0, 3).join(', ')}`, 'error');
  else toast('The folder was restored.');
}

async function loadEarlier(firstRunId) {
  if (!view || !firstRunId) return;
  const shown = view;
  const data = await attempt(() => api('GET', `/api/projects/${view.projectId}/conversations/${view.conversationId}?before=${firstRunId}`));
  if (!data || view !== shown) return;
  const height = view.scroll.scrollHeight;
  for (const run of [...data.runs].reverse()) addTurn(run, { prepend: true });
  view.scroll.scrollTop += view.scroll.scrollHeight - height;
  const box = $('.earlier', view.el);
  if (!data.earlier) box?.remove();
  else {
    box.innerHTML = `<button class="linklike" id="load-earlier">Show ${data.earlier} earlier session${data.earlier === 1 ? '' : 's'}</button>`;
    $('#load-earlier', box).addEventListener('click', () => loadEarlier(data.runs[0]?.id));
  }
}

// ---------- Working indicator, waiting messages, message box ----------

function activeTurn() {
  return [...view.turns.values()].find((t) => t.run.status === 'running') ?? null;
}

function renderWorking() {
  if (!view) return;
  const box = $('#working', view.el);
  const turn = activeTurn();
  const stop = $('#composer-stop', view.el);
  if (stop) stop.hidden = !view.project.active_run_id;
  renderComposerState();
  clearInterval(view.timer);
  view.timer = null;
  if (!turn) {
    box.innerHTML = '';
    return;
  }
  const since = new Date(turn.run.started_at).getTime();
  const tick = () => {
    const el = $('.working-time', box);
    if (el) el.textContent = fmtDuration(Date.now() - since);
  };
  box.innerHTML = `<div class="working"><span class="spinner"></span><span>${agentLabel(view.project.agent)} is working</span><span class="working-time"></span></div>`;
  tick();
  view.timer = setInterval(tick, 1000);
}

/** The messages waiting for their turn, above the message box (the same queue in every view of the project). */
function renderQueue() {
  if (!view?.writable) return;
  const box = $('#queue', view.el);
  if (!box) return;
  const items = view.project.queued ?? [];
  box.hidden = !items.length;
  if (!items.length) {
    box.innerHTML = '';
    return;
  }
  const label = agentLabel(view.project.agent);
  const held = items.filter((m) => m.held_reason).length;
  const waiting = items.length - held;
  const sub = !waiting
    ? 'Not sent yet. Send them when you are ready, or remove them.'
    : view.project.active_run_id
      ? `${label} gets them one at a time, each when it finishes its current reply.`
      : `Sending to ${label}…`;
  box.innerHTML = `
    <div class="queue-head">
      <span class="queue-title">${icon('list', 14)} ${items.length === 1 ? '1 message' : `${items.length} messages`} in the queue</span>
      <span class="queue-sub">${esc(sub)}</span>
      <span class="queue-head-actions">
        ${held > 1 ? '<button type="button" class="linklike" data-q-send-all>Send all</button>' : ''}
        ${items.length > 1 ? '<button type="button" class="linklike" data-q-clear>Remove all</button>' : ''}
      </span>
    </div>
    <ol class="queue-list">${items
      .map(
        (m, i) => `<li class="queue-item${m.held_reason ? ' held' : ''}" data-q="${m.id}">
          <span class="queue-num">${i + 1}</span>
          <div class="queue-body">
            ${m.new_conversation ? `<span class="queue-tag">${icon('plus', 11)} Starts a new chat</span>` : ''}
            <div class="queue-text">${esc(m.text)}</div>
            ${m.held_reason ? `<div class="queue-held">${icon('alert', 12)}<span>${esc(m.held_reason)}</span></div>` : ''}
          </div>
          <div class="queue-actions">
            ${m.held_reason ? `<button type="button" class="small" data-q-send title="Give this message to ${label} now">${icon('send', 12)} Send</button>` : ''}
            <button type="button" class="icon-btn" data-q-edit title="Edit: take this message back into the message box" aria-label="Edit">${icon('edit', 14)}</button>
            <button type="button" class="icon-btn" data-q-remove title="Remove it from the queue" aria-label="Remove">${icon('x', 14)}</button>
          </div>
        </li>`
      )
      .join('')}</ol>`;
  const itemOf = (el) => items.find((m) => m.id === Number(el.closest('[data-q]').dataset.q));
  box.querySelectorAll('[data-q-remove]').forEach((b) => b.addEventListener('click', () => takeOutOfQueue(itemOf(b))));
  box.querySelectorAll('[data-q-edit]').forEach((b) => b.addEventListener('click', () => takeOutOfQueue(itemOf(b), { edit: true })));
  box.querySelectorAll('[data-q-send]').forEach((b) => b.addEventListener('click', () => sendHeld(itemOf(b))));
  $('[data-q-send-all]', box)?.addEventListener('click', () => sendHeld(null));
  $('[data-q-clear]', box)?.addEventListener('click', clearQueueAll);
}

/** "Remove", or "Edit": the message leaves the queue and goes back into the message box. */
async function takeOutOfQueue(item, { edit = false } = {}) {
  if (!view || !item) return;
  const projectId = view.projectId;
  if (!(await attempt(() => api('DELETE', `/api/projects/${projectId}/queue/${item.id}`)))) return;
  if (!view || view.projectId !== projectId) return;
  view.project.queued = (view.project.queued ?? []).filter((m) => m.id !== item.id);
  renderQueue();
  const input = $('#composer-input', view.el);
  if (edit && input) {
    input.value = input.value.trim() ? `${input.value.replace(/\s+$/, '')}\n\n${item.text}` : item.text;
    input.dispatchEvent(new Event('input'));
    input.focus();
  }
}

/** "Send" for held messages (one, or all with `item` null). The queue and the chat update through server events. */
async function sendHeld(item) {
  if (!view) return;
  const projectId = view.projectId;
  const held = item ? [item] : (view.project.queued ?? []).filter((m) => m.held_reason);
  held.forEach((m) => view.sent.add(m.id));
  await attempt(() => api('POST', item ? `/api/projects/${projectId}/queue/${item.id}/send` : `/api/projects/${projectId}/queue/send`));
}

async function clearQueueAll() {
  if (!view) return;
  const projectId = view.projectId;
  const count = (view.project.queued ?? []).length;
  if (!(await confirmModal('Remove all queued messages?', `The ${count} messages in the queue will not be sent to ${esc(agentLabel(view.project.agent))}.`, 'Remove all'))) return;
  if (!(await attempt(() => api('DELETE', `/api/projects/${projectId}/queue`)))) return;
  if (view?.projectId !== projectId) return;
  view.project.queued = [];
  renderQueue();
}

/** The message box tells whether a message starts the agent now or waits in the queue. */
function renderComposerState() {
  if (!view?.writable) return;
  const input = $('#composer-input', view.el);
  if (!input) return;
  const label = agentLabel(view.project.agent);
  const busy = Boolean(view.project.active_run_id);
  const isNew = view.conversationId === 'new';
  input.placeholder = busy ? `${label} is working. Add a message to the queue…` : isNew ? `Tell ${label} what to do…` : `Reply to ${label}…`;
  const send = $('#composer-send', view.el);
  send.title = busy ? 'Add to the queue (Enter)' : 'Send (Enter)';
  send.setAttribute('aria-label', busy ? 'Add to the queue' : 'Send');
  $('#composer-hint', view.el).textContent = !busy
    ? `Enter to send, Shift+Enter for a new line. ${label} only works inside the project folder, and every session can be undone.`
    : isNew
      ? `${label} is still working in the current conversation. Your message waits in the queue and starts this new chat when ${label} is done.`
      : `Messages you send now wait in the queue. ${label} gets them one at a time, each when it finishes its current reply.`;
}

// Unsent text in the message box is kept in this browser, so a reload or a crash of the browser does not lose it.
const DRAFT_PREFIX = 'draft:';

function loadDraft(key) {
  if (key in state.drafts) return state.drafts[key];
  try {
    return localStorage.getItem(DRAFT_PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

function saveDraft(key, text) {
  state.drafts[key] = text;
  try {
    if (text.trim()) localStorage.setItem(DRAFT_PREFIX + key, text);
    else localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    /* storage blocked or full: the draft stays in this page only */
  }
}

function wireComposer(isNew) {
  const form = $('#composer', view.el);
  const input = $('#composer-input', view.el);
  const send = $('#composer-send', view.el);
  const key = `${view.projectId}:${view.conversationId}`;
  const resize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 260)}px`;
    send.disabled = !input.value.trim();
  };
  input.value = loadDraft(key);
  resize();
  input.addEventListener('input', () => {
    saveDraft(key, input.value);
    resize();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message || send.disabled) return;
    send.disabled = true;
    const projectId = view.projectId;
    const conversation = view.conversationId;
    try {
      const r = await api('POST', `/api/projects/${projectId}/chat`, { message, new_conversation: isNew });
      saveDraft(key, '');
      if (!view || view.projectId !== projectId || view.conversationId !== conversation) return;
      input.value = '';
      resize();
      if (r.queued) {
        view.sent.add(r.item.id);
        if (!(view.project.queued ?? []).some((m) => m.id === r.item.id)) view.project.queued = [...(view.project.queued ?? []), r.item];
        renderQueue();
      } else if (isNew || r.conversationId !== conversation) {
        location.hash = `#/project/${projectId}/chat/${r.conversationId}`;
      } else {
        view.project.active_run_id = r.runId;
        const run = await api('GET', `/api/runs/${r.runId}`);
        if (!view || view.conversationId !== conversation) return;
        addTurn(run);
        renderWorking();
        scrollToBottom(true);
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      resize();
    }
  });
  $('#composer-stop', view.el).addEventListener('click', async () => {
    if (!(await confirmModal('Stop the agent?', 'It stops right away. Changes it already made stay in the folder; you can undo the whole session with "Undo" under it.', 'Stop'))) return;
    await attempt(() => api('POST', `/api/projects/${view.projectId}/stop`), 'Stopping…');
  });
  if (!('ontouchstart' in window)) input.focus();
}

// ---------- Live updates (called by app.js for server events) ----------

export function chatOnLog(entry) {
  if (!view || entry.projectId !== view.projectId) return;
  const turn = view.turns.get(entry.runId);
  if (turn) {
    appendEntry(turn, entry);
    scrollToBottom();
    return;
  }
  // A run of this conversation that is not shown yet (it is being loaded): keep its lines until it is.
  if (entry.conversationId !== view.conversationId) return;
  if (!view.pending.has(entry.runId)) view.pending.set(entry.runId, []);
  const lines = view.pending.get(entry.runId);
  if (lines.length < 5000) lines.push(entry);
}

export async function chatOnRunUpdated(ev) {
  if (!view || ev.projectId !== view.projectId) return;
  const turn = view.turns.get(ev.runId);
  const mine = turn || (ev.conversationId != null && ev.conversationId === view.conversationId);
  if (!mine && ev.status !== 'running') view.pending.delete(ev.runId);
  if (mine) {
    const shown = view;
    const run = await api('GET', `/api/runs/${ev.runId}`).catch(() => null);
    if (!run || view !== shown) return; // another conversation was opened meanwhile
    if (run.conversation_id !== view.conversationId && view.turns.has(run.id)) {
      // The run moved to a new conversation (the old agent session could not be continued).
      showMoved(run.conversation_id, 'because the previous session could not be continued');
    }
    if (view.turns.has(run.id)) updateTurn(run);
    else addTurn(run);
    renderWorking();
    scrollToBottom();
  } else if (ev.status === 'running' && view.writable && view.conversationId !== 'new' && ev.conversationId && ev.conversationId !== view.conversationId) {
    showMoved(ev.conversationId);
  }
}

/** The project summary changed (active run, waiting messages, current conversation). */
export function chatProjectUpdated(project) {
  if (!view || project.id !== view.projectId) return;
  view.project = project;
  renderQueue();
  renderWorking();
  for (const turn of view.turns.values()) if (turn.run.status !== 'running') renderTurnEnd(turn);
}

/** A queued message started a run: if it was written in this "new chat" view, follow it into its conversation. */
export function chatOnQueue(ev) {
  const started = ev.started;
  if (!view || !started || ev.projectId !== view.projectId || view.conversationId !== 'new') return;
  const typing = $('#composer-input', view.el)?.value.trim();
  if (view.sent.has(started.id) || (started.newConversation && !typing)) {
    location.hash = `#/project/${view.projectId}/chat/${started.conversationId}`;
  }
}

function showMoved(conversationId, why = '') {
  const box = $('#moved', view.el);
  if (!box || !conversationId) return;
  box.innerHTML = `<div class="note info">${icon('chat', 14)}<span>${agentLabel(view.project.agent)} is now working in a newer conversation${why ? `, ${why}` : ''}.
    <a href="#/project/${view.projectId}/chat/${conversationId}">Open it</a></span></div>`;
}
