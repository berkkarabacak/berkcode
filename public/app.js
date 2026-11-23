// Claude Agent Runner – browser UI (plain JavaScript, no build step)

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

if (window.marked) {
  window.marked.use({ renderer: { html: (token) => esc(token.text ?? token.raw ?? '') } });
}
const md = (s) => (window.marked ? window.marked.parse(String(s ?? '')) : `<pre>${esc(s)}</pre>`);

const state = {
  settings: null,
  budgetPaused: false,
  monthCost: 0,
  route: null,
  project: null,
  models: null,
  memory: null,
  memorySection: 'brief',
  editing: false,
  live: null, // { runId, lastSeq, buffer, container }
};

// ---------------- utilities ----------------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toast-root').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

async function attempt(fn, success) {
  try {
    const r = await fn();
    if (success) toast(success);
    return r;
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  }
}

const fmtTime = (iso, tz) => {
  if (!iso) return '—';
  const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  if (tz) opts.timeZone = tz;
  try {
    return new Date(iso).toLocaleString(undefined, opts);
  } catch {
    return new Date(iso).toLocaleString();
  }
};
const fmtCost = (v) => (v == null ? '—' : `$${Number(v).toFixed(v < 1 ? 3 : 2)}`);
const fmtDuration = (ms) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
const agentBadge = (agent) => `<span class="agent-badge ${agent === 'kimi' ? 'kimi' : 'claude'}">${agent === 'kimi' ? 'Kimi' : 'Claude'}</span>`;
/** Kimi runs are covered by the subscription, so they show no dollar cost. */
const runCost = (agent, value) => (agent === 'kimi' ? 'Subscription' : fmtCost(value));
const statusChip = (s) => `<span class="status ${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;
const timeAgo = (iso) => {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  return `${Math.round(diff / 86400)} days ago`;
};

function modal(html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  const close = () => (root.innerHTML = '');
  $('.modal-backdrop', root).addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) close();
  });
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', close));
  onMount?.($('.modal', root), close);
  return close;
}

function confirmModal(title, message, confirmLabel = 'Confirm', danger = true) {
  return new Promise((resolve) => {
    modal(
      `<h2>${esc(title)}</h2><p>${message}</p>
       <div class="row" style="justify-content:flex-end"><button data-close>Cancel</button>
       <button class="${danger ? 'danger' : 'primary'}" id="confirm-yes">${esc(confirmLabel)}</button></div>`,
      (el, close) => {
        $('[data-close]', el).addEventListener('click', () => resolve(false));
        $('#confirm-yes', el).addEventListener('click', () => {
          close();
          resolve(true);
        });
      }
    );
  });
}

async function loadModels() {
  if (!state.models) state.models = await api('GET', '/api/models').catch(() => ({ models: [] }));
  return state.models.models;
}

function modelOptions(models, selected, includeDefault) {
  const ids = models.map((m) => m.id);
  let html = includeDefault ? `<option value="">Use default (${esc(state.settings?.default_model)})</option>` : '';
  if (selected && !ids.includes(selected)) html += `<option value="${esc(selected)}" selected>${esc(selected)}</option>`;
  html += models.map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.display_name || m.id)} (${esc(m.id)})</option>`).join('');
  return html;
}

// ---------------- plan & progress parsing (mirrors the server format) ----------------

const MARKS = { todo: ' ', in_progress: '~', done: 'x', blocked: '!' };
const STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', done: 'Done', blocked: 'Blocked' };

function parsePlanDoc(content) {
  const head = [];
  const steps = [];
  for (const line of String(content ?? '').replace(/\r/g, '').split('\n')) {
    const m = line.match(/^\s*[-*]\s+\[([ xX~!])\]\s+(.*)$/);
    if (m) {
      const k = m[1].toLowerCase();
      steps.push({ status: k === 'x' ? 'done' : k === '~' ? 'in_progress' : k === '!' ? 'blocked' : 'todo', text: m[2], details: [] });
    } else if (steps.length) {
      steps[steps.length - 1].details.push(line);
    } else {
      head.push(line);
    }
  }
  for (const s of steps) {
    while (s.details.length && !s.details[s.details.length - 1].trim()) s.details.pop();
  }
  while (head.length && !head[head.length - 1].trim()) head.pop();
  return { head, steps };
}

function serializePlan(doc) {
  const lines = [...doc.head, ''];
  for (const s of doc.steps) {
    lines.push(`- [${MARKS[s.status]}] ${s.text.trim()}`);
    lines.push(...s.details);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function parseProgress(content) {
  const sections = [];
  let cur = null;
  for (const line of String(content ?? '').split('\n')) {
    if (/^##\s+/.test(line)) {
      cur = { title: line.replace(/^##\s+/, ''), body: '' };
      sections.push(cur);
    } else if (cur) cur.body += line + '\n';
  }
  return sections;
}

// ---------------- banner & nav ----------------

async function refreshState() {
  const s = await api('GET', '/api/state');
  state.settings = s.settings;
  state.budgetPaused = s.budget_paused;
  state.monthCost = s.month_cost;
  state.canRestart = s.can_restart;
  state.counts = { all: s.project_count, claude: s.claude_projects, kimi: s.kimi_projects };
  renderBanner();
  // Kimi projects need Kimi Code CLI on this computer (for example after copying the app to a new PC).
  if (s.kimi_projects > 0 && Date.now() - (state.kimiCheckedAt ?? 0) > 120_000) {
    state.kimiCheckedAt = Date.now();
    loadAgents(false).then(renderBanner);
  }
}

function renderBanner() {
  const b = $('#banner');
  const parts = [];
  const counts = state.counts ?? { all: 0, claude: 0, kimi: 0 };
  if (state.settings && !state.settings.has_api_key && (counts.claude > 0 || counts.all === 0)) {
    parts.push(counts.claude > 0
      ? `<div class="banner"><span>No Claude API key is set yet, so your Claude projects cannot run. Add the key in Settings.</span><a class="btn small" href="#/settings">Open Settings</a></div>`
      : `<div class="banner"><span>To use Claude, add your Claude API key in Settings. (Projects that use Kimi do not need it.)</span><a class="btn small" href="#/settings">Open Settings</a></div>`);
  }
  let recovered = null;
  try {
    recovered = state.settings?.db_recovered ? JSON.parse(state.settings.db_recovered) : null;
  } catch {
    /* ignore */
  }
  if (recovered) {
    parts.push(`<div class="banner danger"><span><b>The app's database was damaged</b> (this can happen when the app folder is copied while the app is running), so the app ${
      recovered.from
        ? `went back to its daily backup from ${esc(recovered.from.slice(4, 14))}. Runs and memory changes made after that backup are missing`
        : 'had to start with a new, empty database'
    }. The damaged file was kept in the data folder as ${esc(recovered.damaged)}.</span><button class="small" id="db-recovered-ok">OK</button></div>`);
  }
  const kimi = agentsCache?.kimi;
  if (counts.kimi > 0 && kimi && !(kimi.installed && kimi.loggedIn)) {
    parts.push(`<div class="banner"><span>${kimi.installed ? 'Kimi Code CLI is not logged in on this computer' : 'Kimi Code CLI is not installed on this computer'}, so your Kimi projects cannot run. Setting it up takes a few minutes.</span><a class="btn small" href="#/settings">Set up Kimi</a></div>`);
  }
  if (state.budgetPaused) {
    parts.push(`<div class="banner danger"><span><b>Monthly budget cap reached</b> (${fmtCost(state.monthCost)} of ${fmtCost(state.settings.monthly_cap_usd)}). Claude schedules are paused until next month or until you raise the cap. Kimi projects keep running (they use your subscription).</span>
      <a class="btn small" href="#/settings">Change cap</a><button class="small" id="resume-budget">Resume schedules</button></div>`);
  }
  b.innerHTML = parts.join('');
  $('#resume-budget')?.addEventListener('click', () => attempt(() => api('POST', '/api/budget/resume'), 'Schedules resumed').then(refreshState));
  $('#db-recovered-ok')?.addEventListener('click', () => attempt(() => api('PUT', '/api/settings', { db_recovered: '' })).then(refreshState));
}

function setNav(name) {
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
}

// ---------------- router ----------------

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!parts.length) return { name: 'dashboard' };
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'new') return { name: 'new' };
  if (parts[0] === 'project') return { name: 'project', id: Number(parts[1]), tab: parts[2] || 'runs', sub: parts[3] };
  return { name: 'dashboard' };
}

let ignoreNextRoute = false;
let currentHash = location.hash;
let routeSeq = 0;
/** Returns a check that tells whether a newer navigation has started since this render began. */
const routeGuard = () => {
  const seq = routeSeq;
  return () => seq !== routeSeq;
};

async function router() {
  if (ignoreNextRoute) {
    ignoreNextRoute = false;
    return;
  }
  if (state.editing && !confirm('You have unsaved changes. Leave anyway?')) {
    ignoreNextRoute = true;
    location.hash = currentHash;
    return;
  }
  currentHash = location.hash;
  routeSeq++;
  state.editing = false;
  state.live = null;
  state.route = parseRoute();
  const r = state.route;
  setNav(r.name === 'settings' ? 'settings' : 'dashboard');
  try {
    if (r.name === 'dashboard') await renderDashboard();
    else if (r.name === 'settings') await renderSettings();
    else if (r.name === 'new') await renderNewProject();
    else if (r.name === 'project') await renderProject();
  } catch (err) {
    view.innerHTML = `<div class="panel"><h2>Something went wrong</h2><p>${esc(err.message)}</p><a href="#/">Back to projects</a></div>`;
  }
}

// ---------------- dashboard ----------------

async function renderDashboard() {
  const stale = routeGuard();
  const projects = await api('GET', '/api/projects');
  if (stale() || parseRoute().name !== 'dashboard') return;
  const cards = projects
    .map((p) => {
      const scheduleState = p.active_run_id ? statusChip('running') : p.enabled ? '<span class="status active">scheduled</span>' : '<span class="status paused">paused</span>';
      return `<div class="card">
        <div class="spread"><h3><a href="#/project/${p.id}">${esc(p.name)}</a> ${agentBadge(p.agent)}</h3>${scheduleState}</div>
        <dl>
          <dt>Schedule</dt><dd>${esc(p.schedule_text)}</dd>
          <dt>Next run</dt><dd>${p.enabled ? (state.budgetPaused && p.billing === 'api' ? 'Paused (budget cap)' : esc(fmtTime(p.next_run, p.timezone))) : 'Paused'}</dd>
          <dt>Last run</dt><dd>${p.last_run ? `${statusChip(p.last_run.status)} <span class="muted small">${esc(timeAgo(p.last_run.started_at))}</span>` : '<span class="muted">Never</span>'}</dd>
          <dt>Last run cost</dt><dd>${p.last_run ? runCost(p.agent, p.last_run.cost_usd) : '—'}</dd>
          <dt>This month</dt><dd>${runCost(p.agent, p.month_cost)}</dd>
        </dl>
        ${p.paused_reason ? `<div class="warn">${esc(p.paused_reason)}</div>` : ''}
        ${p.folder_exists ? '' : `<div class="warn">The project folder was not found on this computer. Open the project and choose where its folder is in the Setup tab.</div>`}
        <div class="row">
          ${p.active_run_id ? `<button data-stop="${p.id}" class="danger">Stop run</button>` : `<button class="primary" data-run="${p.id}">Run now</button>`}
          <button data-toggle="${p.id}" data-enabled="${p.enabled ? 1 : 0}">${p.enabled ? 'Pause schedule' : 'Resume schedule'}</button>
          <a class="btn" href="#/project/${p.id}">Open</a>
        </div>
      </div>`;
    })
    .join('');

  view.innerHTML = `
    <div class="spread"><div><h1>Projects</h1><p class="muted">Spent this month across all projects: ${fmtCost(state.monthCost)} of ${fmtCost(state.settings?.monthly_cap_usd)} cap</p></div>
      <a class="btn primary big" href="#/new">+ Add project</a></div>
    ${projects.some((p) => p.enabled) && !state.settings?.start_with_windows ? `<div class="hint-box row" style="margin-bottom:16px;justify-content:space-between">
      <span>Scheduled runs only happen while this app is running. Let it start by itself when you turn on the computer?</span>
      <button class="small" id="enable-autostart">Yes, start with Windows</button></div>` : ''}
    ${projects.length ? `<div class="cards">${cards}</div>` : `<div class="empty panel"><h2>No projects yet</h2><p>Add a project, describe what you want built, and the agent you choose (Claude or Kimi) will work on it step by step on your schedule.</p><a class="btn primary big" href="#/new">+ Add your first project</a></div>`}`;

  $('#enable-autostart')?.addEventListener('click', async () => {
    if (await attempt(() => api('PUT', '/api/settings', { start_with_windows: true }), 'The app will now start by itself when you log in to Windows.')) {
      await refreshState();
      renderDashboard();
    }
  });
  $$('[data-run]').forEach((b) => b.addEventListener('click', () => runNow(b.dataset.run)));
  $$('[data-stop]').forEach((b) => b.addEventListener('click', () => stopRunFor(b.dataset.stop)));
  $$('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => attempt(() => api('POST', `/api/projects/${b.dataset.toggle}/enabled`, { enabled: b.dataset.enabled !== '1' })).then(renderDashboard))
  );
}

async function runNow(projectId, goLive = false) {
  const r = await attempt(() => api('POST', `/api/projects/${projectId}/run`));
  if (!r) return;
  if (r.status === 'skipped') toast(`Run skipped: ${r.reason.replace(/^skipped: /, '')}`, 'error');
  else {
    toast('Run started');
    if (goLive) location.hash = `#/project/${projectId}/live`;
  }
  refreshCurrent();
}

async function stopRunFor(projectId) {
  if (!(await confirmModal('Stop the run?', 'The agent will be cancelled. Changes it already made stay in the folder (you can restore the folder from the Runs tab).', 'Stop run'))) return;
  await attempt(() => api('POST', `/api/projects/${projectId}/stop`), 'Stopping…');
}

// ---------------- schedule editor ----------------

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Europe/Istanbul', 'UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York'];
  }
})();

/** Regular repeat intervals (minutes). They divide an hour or a day evenly, so the rhythm never drifts. */
const INTERVALS = [15, 30, 60, 120, 180, 240, 360, 480, 720];
const intervalLabel = (m) => (m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`);

function scheduleEditorHtml(schedule, timezone) {
  let s = schedule || { type: 'daily', time: '09:00' };
  // Older projects saved "every N hours"; show them as the equivalent interval when possible.
  if (s.type === 'hours' && INTERVALS.includes(Number(s.every) * 60)) s = { type: 'interval', minutes: Number(s.every) * 60 };
  const type = s.type === 'hours' ? 'cron' : s.type || 'daily';
  const expr = s.type === 'hours' ? `0 */${s.every} * * *` : s.expr ?? '';
  const minutes = Number(s.minutes ?? 60);
  const days = new Set(s.days ?? [1, 2, 3, 4, 5]);
  return `
    <div class="schedule-editor">
      <div class="inline-choice">
        ${[['interval', 'Repeat every…'], ['daily', 'Every day'], ['weekdays', 'On selected weekdays'], ['cron', 'Advanced']]
          .map(([v, l]) => `<label><input type="radio" name="stype" value="${v}" ${type === v ? 'checked' : ''}/> ${l}</label>`)
          .join('')}
      </div>
      <div data-s="interval" class="row" style="margin-top:12px">Repeat every
        <select name="interval" style="width:auto">${INTERVALS.map((m) => `<option value="${m}" ${m === minutes ? 'selected' : ''}>${intervalLabel(m)}</option>`).join('')}</select></div>
      <div data-s="daily" class="row" style="margin-top:12px">Run every day at <input type="time" name="time_daily" value="${esc(s.time ?? '09:00')}"/></div>
      <div data-s="weekdays" style="margin-top:12px">
        <div class="inline-choice days">${DAY_LABELS.map((d, i) => `<label><input type="checkbox" name="day" value="${i}" ${days.has(i) ? 'checked' : ''}/> ${d}</label>`).join('')}</div>
        <div class="row" style="margin-top:10px">at <input type="time" name="time_weekdays" value="${esc(s.time ?? '09:00')}"/></div>
      </div>
      <div data-s="cron" style="margin-top:12px">
        <input type="text" name="expr" placeholder="minute hour day month weekday, e.g. 0 9 * * 1-5" value="${esc(expr)}"/>
        <div class="muted small">Standard cron syntax with 5 fields. Only for advanced use.</div>
      </div>
      <label>Timezone</label>
      <input type="text" name="timezone" list="tz-list" value="${esc(timezone || 'Europe/Istanbul')}" style="max-width:320px"/>
      <datalist id="tz-list">${TIMEZONES.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <div class="field-msg" data-preview></div>
    </div>`;
}

function readSchedule(root) {
  const type = $('[name=stype]:checked', root)?.value || 'daily';
  const timezone = $('[name=timezone]', root).value.trim() || 'Europe/Istanbul';
  let schedule;
  if (type === 'interval') schedule = { type, minutes: Number($('[name=interval]', root).value) || 60 };
  else if (type === 'daily') schedule = { type, time: $('[name=time_daily]', root).value || '09:00' };
  else if (type === 'weekdays') schedule = { type, time: $('[name=time_weekdays]', root).value || '09:00', days: $$('[name=day]:checked', root).map((c) => Number(c.value)) };
  else schedule = { type: 'cron', expr: $('[name=expr]', root).value.trim() };
  return { schedule, timezone };
}

function wireScheduleEditor(root) {
  const update = async () => {
    const type = $('[name=stype]:checked', root)?.value;
    $$('[data-s]', root).forEach((el) => (el.style.display = el.dataset.s === type ? '' : 'none'));
    const { schedule, timezone } = readSchedule(root);
    const preview = $('[data-preview]', root);
    const r = await api('POST', '/api/schedule/preview', { schedule, timezone }).catch((e) => ({ ok: false, message: e.message }));
    if (r.ok) {
      preview.className = 'field-msg ok';
      preview.innerHTML = `Next runs: ${r.next.map((d) => esc(fmtTime(d, timezone))).join(' · ')}`;
    } else {
      preview.className = 'field-msg bad';
      preview.textContent = r.message;
    }
  };
  root.addEventListener('input', update);
  root.addEventListener('change', update);
  update();
}

// ---------------- new project ----------------

/** Opens the Windows folder picker (it appears on this computer, possibly behind the browser). */
async function browseFolder(input, button, onPicked) {
  button.disabled = true;
  const old = button.textContent;
  button.textContent = 'Waiting for the folder window…';
  toast('A "Choose folder" window opened. If you do not see it, look for it in the taskbar.');
  try {
    const r = await api('POST', '/api/pick-folder', { initial: input.value });
    if (r.folder) {
      input.value = r.folder;
      onPicked?.();
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
}

async function checkFolderField(input, msg) {
  const r = await api('POST', '/api/validate-folder', { folder: input.value }).catch((e) => ({ ok: false, message: e.message }));
  msg.className = `field-msg ${r.ok ? 'ok' : 'bad'}`;
  msg.textContent = r.message + (r.ok && r.is_git ? ' It is a git repository, so you can switch restore points to git commits in Setup.' : '');
  if (r.ok && r.folder) input.value = r.folder;
  return r.ok;
}

// ---- Agents (Claude or Kimi) ----

let agentsCache = null;
async function loadAgents(refresh = false) {
  if (!agentsCache || refresh) agentsCache = await api('GET', `/api/agents${refresh ? '?refresh=1' : ''}`).catch(() => null);
  return agentsCache;
}

const kimiModelName = (kimi, id) => kimi?.models?.find((m) => m.id === id)?.name ?? id;

function agentStatusHtml(agent, info) {
  if (!info) return '<span class="muted">Checking…</span>';
  if (agent === 'claude') {
    return info.claude.ready
      ? '<span class="field-msg ok">✓ API key is set</span>'
      : '<span class="field-msg bad">No API key yet — add it in Settings before the first run.</span>';
  }
  const k = info.kimi;
  if (!k.installed) return '<span class="field-msg bad">Kimi Code CLI is not installed on this computer. <a href="#/settings">Set it up in Settings</a>.</span>';
  if (!k.loggedIn) return '<span class="field-msg bad">Kimi Code CLI is not logged in on this computer. <a href="#/settings">Log in from Settings</a>.</span>';
  return `<span class="field-msg ok">✓ Ready (version ${esc(k.version ?? '?')}) · best model: ${esc(kimiModelName(k, k.preferredModel) ?? 'default')}</span>`;
}

/** Model (and, for Kimi, thinking effort) fields for the chosen agent. */
function agentOptionsHtml(agent, info, project = {}) {
  if (agent === 'claude') {
    const models = info?.claude?.models ?? state.models?.models ?? [];
    return `<label>Claude model</label><select name="model">${modelOptions(models, project.model || '', true)}</select>`;
  }
  const kimi = info?.kimi;
  const models = kimi?.models ?? [];
  const best = kimi?.preferredModel ? kimiModelName(kimi, kimi.preferredModel) : 'Kimi default';
  const current = project.model || '';
  const options = [`<option value="">Best available (${esc(best)})</option>`]
    .concat(current && !models.some((m) => m.id === current) ? [`<option value="${esc(current)}" selected>${esc(current)}</option>`] : [])
    .concat(models.map((m) => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(m.name)} (${esc(m.id)})</option>`));
  const effort = project.effort || 'max';
  return `<div class="row" style="gap:28px;align-items:flex-start">
      <div><label>Kimi model</label><select name="model">${options.join('')}</select>
        ${kimi && kimi.loggedIn && !kimi.hasK31 ? '<div class="muted small">K3.1 Pro is not in your Kimi model list yet. In Kimi, type /logout and then /login to refresh it.</div>' : ''}</div>
      <div><label>Thinking</label><select name="effort">${['max', 'high', 'low'].map((e) => `<option value="${e}" ${e === effort ? 'selected' : ''}>${e === 'max' ? 'Max (best results)' : e === 'high' ? 'High' : 'Low (fastest)'}</option>`).join('')}</select></div>
    </div>`;
}

async function renderNewProject() {
  const stale = routeGuard();
  const [templates] = await Promise.all([api('GET', '/api/templates'), loadModels()]);
  if (stale()) return;
  view.innerHTML = `
    <h1>Add a project</h1>
    <p class="muted">Set this up once. The agent you choose will then work on the project on your schedule, one step at a time.</p>
    <form id="new-form" class="panel">
      <label>1. Project name</label>
      <input type="text" name="name" placeholder="For example: My website" required autofocus/>

      <label>2. Who should do the work? <span class="hint">You choose this once. It cannot be changed later.</span></label>
      <div class="agent-choices">
        <label class="agent-card"><input type="radio" name="agent" value="claude"/>
          <div><b>Claude</b> <span class="muted small">· uses your Anthropic API key · you pay per use</span>
          <div class="small" data-agent-status="claude"><span class="muted">Checking…</span></div></div></label>
        <label class="agent-card"><input type="radio" name="agent" value="kimi"/>
          <div><b>Kimi Code CLI</b> <span class="muted small">· uses your Kimi subscription · no per-use cost</span>
          <div class="small" data-agent-status="kimi"><span class="muted">Checking Kimi…</span></div></div></label>
      </div>
      <div id="agent-options"></div>

      <label>3. Folder on this computer <span class="hint">The agent only works inside this folder. A new folder in the app's "projects" folder is suggested, so the project moves along if you ever copy the app to another computer.</span></label>
      <div class="row"><input type="text" name="folder" style="flex:1"/>
        <button type="button" id="browse-folder">Browse…</button></div>
      <div class="field-msg" id="folder-msg"></div>

      <label>4. What should be built? <span class="hint">Describe it in your own words. The agent reads this at the start of every session.</span></label>
      <textarea name="brief" class="big" placeholder="For example: A simple personal website for me with a short introduction, my hobbies, a photo gallery and a contact section. It should look clean and work on phones."></textarea>
      <div class="muted small" style="margin-top:6px"><a href="javascript:void 0" id="use-template">Use a detailed template instead</a></div>

      <h2>5. When should it work on it?</h2>
      <p class="muted small" style="margin-top:-6px">You can change this any time later in the project's Schedule tab.</p>
      <div id="schedule-box">${scheduleEditorHtml(null, 'Europe/Istanbul')}</div>
      <label class="inline-choice" style="margin-top:16px"><input type="checkbox" name="enabled" checked/> Turn the schedule on now</label>

      <details class="advanced">
        <summary>Advanced options</summary>
        <label>Standing instruction for every session</label>
        <textarea name="task_prompt">${esc(templates.task_prompt)}</textarea>
      </details>

      <div class="row" style="margin-top:22px"><button class="primary big" type="submit">Create project</button><a class="btn" href="#/">Cancel</a></div>
    </form>`;
  state.editing = false;
  wireScheduleEditor($('#schedule-box'));
  const form = $('#new-form');
  const msg = $('#folder-msg');
  let folderTouched = false;
  let agentsInfo = null;

  const showAgentOptions = () => {
    const agent = $('[name=agent]:checked', form)?.value;
    $$('.agent-card', form).forEach((card) => card.classList.toggle('selected', $('input', card).checked));
    $('#agent-options').innerHTML = agent ? agentOptionsHtml(agent, agentsInfo) : '';
  };
  $$('[name=agent]', form).forEach((r) => r.addEventListener('change', showAgentOptions));
  loadAgents(true).then((info) => {
    if (stale()) return;
    agentsInfo = info;
    for (const agent of ['claude', 'kimi']) $(`[data-agent-status=${agent}]`, form).innerHTML = agentStatusHtml(agent, info);
    showAgentOptions();
  });

  const suggest = async () => {
    if (folderTouched) return;
    const r = await api('GET', `/api/suggest-folder?name=${encodeURIComponent(form.name.value.trim() || 'My project')}`).catch(() => null);
    if (r?.folder && !folderTouched) {
      form.folder.value = r.folder;
      checkFolderField(form.folder, msg);
    }
  };
  let suggestTimer = null;
  form.name.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(suggest, 300);
  });
  form.folder.addEventListener('input', () => (folderTouched = true));
  form.folder.addEventListener('change', () => checkFolderField(form.folder, msg));
  $('#browse-folder').addEventListener('click', (e) =>
    browseFolder(form.folder, e.currentTarget, () => {
      folderTouched = true;
      checkFolderField(form.folder, msg);
    })
  );
  $('#use-template').addEventListener('click', () => {
    if (form.brief.value.trim() && !confirm('Replace what you wrote with the template?')) return;
    form.brief.value = templates.brief;
  });
  suggest();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.name.value.trim()) return toast('Give the project a name', 'error');
    const agent = $('[name=agent]:checked', form)?.value;
    if (!agent) return toast('Choose who should do the work: Claude or Kimi', 'error');
    if (form.brief.value.trim().length < 15) return toast('Describe what should be built (a few sentences are enough)', 'error');
    if (!(await checkFolderField(form.folder, msg))) return toast('Please fix the folder first', 'error');
    const { schedule, timezone } = readSchedule($('#schedule-box'));
    const submit = $('button[type=submit]', form);
    submit.disabled = true;
    const p = await attempt(() =>
      api('POST', '/api/projects', {
        name: form.name.value.trim(),
        agent,
        folder: form.folder.value.trim(),
        brief: form.brief.value,
        task_prompt: form.task_prompt.value,
        model: form.model?.value || '',
        effort: form.effort?.value || undefined,
        schedule,
        timezone,
        enabled: form.enabled.checked,
      })
    );
    submit.disabled = false;
    if (p) {
      toast('Project created. Press "Run now" to start the first session.');
      location.hash = `#/project/${p.id}/runs`;
    }
  });
}

// ---------------- project page ----------------

const TABS = [
  ['runs', 'Runs'],
  ['live', 'Live'],
  ['memory', 'Memory'],
  ['schedule', 'Schedule'],
  ['setup', 'Setup'],
];

async function renderProject() {
  const stale = routeGuard();
  const r = state.route;
  const p = await api('GET', `/api/projects/${r.id}`);
  if (stale()) return;
  state.project = p;
  view.innerHTML = `<div id="project-header"></div><div id="tab-content"></div>`;
  renderProjectHeader();
  const content = $('#tab-content');
  if (r.tab === 'setup') await renderSetupTab(content);
  else if (r.tab === 'schedule') renderScheduleTab(content);
  else if (r.tab === 'memory') await renderMemoryTab(content);
  else if (r.tab === 'live') await renderLiveTab(content);
  else if (r.tab === 'runs' && r.sub) await renderRunDetail(content, Number(r.sub));
  else await renderRunsTab(content);
}

function renderProjectHeader() {
  const p = state.project;
  const r = state.route;
  const header = $('#project-header');
  if (!header) return;
  header.innerHTML = `
    <div class="spread">
      <div>
        <h1>${esc(p.name)} ${agentBadge(p.agent)}</h1>
        <div class="muted small">${esc(p.folder)} · ${esc(p.schedule_text)} · ${p.enabled ? `next run ${esc(fmtTime(p.next_run, p.timezone))}` : 'schedule paused'} · ${p.agent === 'kimi' ? 'uses your Kimi subscription' : `this month ${fmtCost(p.month_cost)}`}</div>
        ${p.paused_reason ? `<div class="field-msg bad">${esc(p.paused_reason)}</div>` : ''}
      </div>
      <div class="row">
        ${p.active_run_id ? `${statusChip('running')} <button class="danger" id="hdr-stop">Stop</button>` : `<button class="primary" id="hdr-run">Run now</button>`}
        <button id="hdr-toggle">${p.enabled ? 'Pause schedule' : 'Resume schedule'}</button>
        <button id="hdr-folder" title="Open the project folder in Explorer">Open folder</button>
        ${p.has_index_html ? '<button id="hdr-index" title="Open index.html in your browser">Open website</button>' : ''}
      </div>
    </div>
    ${p.folder_exists ? '' : '<div class="field-msg bad">The project folder cannot be found. Check the folder in the Setup tab.</div>'}
    <div class="tabs">${TABS.map(([k, l]) => `<a href="#/project/${p.id}/${k}" class="${r.tab === k ? 'active' : ''}">${l}${k === 'live' && p.active_run_id ? '<span class="dot"></span>' : ''}</a>`).join('')}</div>`;
  $('#hdr-run')?.addEventListener('click', () => runNow(p.id, true));
  $('#hdr-stop')?.addEventListener('click', () => stopRunFor(p.id));
  $('#hdr-folder').addEventListener('click', () => attempt(() => api('POST', `/api/projects/${p.id}/open`, { target: 'folder' })));
  $('#hdr-index')?.addEventListener('click', () => attempt(() => api('POST', `/api/projects/${p.id}/open`, { target: 'index' })));
  $('#hdr-toggle').addEventListener('click', async () => {
    await attempt(() => api('POST', `/api/projects/${p.id}/enabled`, { enabled: !p.enabled }), p.enabled ? 'Schedule paused' : 'Schedule resumed');
    await refreshProjectHeader();
  });
}

async function refreshProjectHeader() {
  if (state.route?.name !== 'project') return;
  state.project = await api('GET', `/api/projects/${state.route.id}`);
  renderProjectHeader();
}

// ---- Setup tab

async function renderSetupTab(el) {
  const p = state.project;
  const [, agentsInfo] = await Promise.all([loadModels(), loadAgents()]);
  const s = state.settings;
  const kimi = p.agent === 'kimi';
  el.innerHTML = `
    <form id="setup-form" class="panel">
      <label>Project name</label>
      <input type="text" name="name" value="${esc(p.name)}"/>

      <label>Agent</label>
      <div class="hint-box">${agentBadge(p.agent)} <b>${esc(p.agent_long)}</b><br/>
        <span class="muted small">The agent is chosen when a project is created and cannot be changed. To use another agent, create a new project.</span></div>
      ${agentOptionsHtml(p.agent, agentsInfo, p)}
      ${!kimi && state.models?.error ? `<div class="field-msg bad">Could not load the model list: ${esc(state.models.error)}</div>` : ''}

      <label>Project folder</label>
      <div class="row"><input type="text" name="folder" value="${esc(p.folder)}" style="flex:1"/><button type="button" id="browse-folder">Browse…</button></div>
      <div class="field-msg ${p.folder_exists ? 'ok' : 'bad'}" id="folder-msg">${
        !p.folder_exists
          ? 'This folder was not found on this computer. If the app was copied from another computer, copy the project folder too, or choose where it is now with Browse… and press Save.'
          : p.folder_in_app
            ? 'Folder found. It is inside the app folder, so it moves along when you copy the app to another computer.'
            : 'Folder found.'
      }</div>
      ${p.folder_exists && !p.folder_in_app ? `<div class="hint-box row" style="justify-content:space-between;margin-top:10px">
        <span class="small">This folder is outside the app folder, so copying the app folder to another computer does not take it along. Move it into the app's "projects" folder to fix that.</span>
        <button type="button" class="small" id="move-into-app">Move into the app folder</button></div>` : ''}

      <label>Task prompt <span class="hint">the standing instruction that applies to every session</span></label>
      <textarea name="task_prompt" class="big">${esc(p.task_prompt)}</textarea>

      <label>Restore points <span class="hint">taken before every run so you can undo it</span></label>
      <div class="inline-choice">
        <label><input type="radio" name="restore_mode" value="zip" ${p.restore_mode !== 'git' ? 'checked' : ''}/> Zip backup (recommended)</label>
        <label title="${p.is_git ? '' : 'Only available when the folder is already a git repository'}"><input type="radio" name="restore_mode" value="git" ${p.restore_mode === 'git' ? 'checked' : ''} ${p.is_git ? '' : 'disabled'}/> Git commits ${p.is_git ? '' : '<span class="muted small">(folder is not a git repository)</span>'}</label>
      </div>

      <h2>Limits per run</h2>
      <div class="row" style="gap:28px">
        <div><label>Step limit</label><input type="number" name="turn_limit" min="1" value="${esc(p.turn_limit ?? '')}" placeholder="${esc(s.default_turn_limit)}"/></div>
        ${kimi ? '' : `<div><label>Budget (USD)</label><input type="number" name="budget_usd" min="0.1" step="0.1" value="${esc(p.budget_usd ?? '')}" placeholder="${esc(s.default_budget_usd)}"/></div>`}
        <div><label>Time limit (minutes)</label><input type="number" name="max_minutes" min="1" value="${esc(p.max_minutes ?? '')}" placeholder="${esc(s.default_max_minutes)}"/></div>
        <div><label>Fresh session every N runs</label><input type="number" name="fresh_every" min="1" value="${esc(p.fresh_every)}"/></div>
      </div>
      <p class="muted small">Leave a limit empty to use the default from Settings.${kimi ? ' Kimi runs use your subscription, so there is no dollar budget per run.' : ''}${kimi ? ' Changing the model or thinking level starts a fresh Kimi session on the next run.' : ''}</p>

      <div class="row" style="margin-top:18px"><button class="primary" type="submit">Save</button></div>
    </form>
    <div class="panel">
      <h3>Delete project</h3>
      <p class="muted small">Removes the project, its run history and all of its memory from the app. The project folder itself is not touched.</p>
      <button class="danger" id="delete-project">Delete project</button>
    </div>`;
  const form = $('#setup-form');
  form.addEventListener('input', () => (state.editing = true));
  form.folder.addEventListener('change', () => checkFolderField(form.folder, $('#folder-msg')));
  $('#browse-folder').addEventListener('click', (e) =>
    browseFolder(form.folder, e.currentTarget, () => {
      state.editing = true;
      checkFolderField(form.folder, $('#folder-msg'));
    })
  );
  $('#move-into-app')?.addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const ok = await confirmModal(
      'Move the project folder into the app folder?',
      `<b>${esc(p.folder)}</b> moves into the app's "projects" folder. Its contents stay exactly the same.<br/><br/>Close any window or program that has this folder open first. The next run starts a fresh ${esc(p.agent_label)} session, because the old one remembers the old location; the project memory carries everything over.`,
      'Move folder',
      false
    );
    if (!ok) return;
    button.disabled = true;
    const moved = await attempt(() => api('POST', `/api/projects/${p.id}/move-into-app`), 'The folder was moved into the app folder.');
    button.disabled = false;
    if (moved) {
      state.editing = false;
      await refreshProjectHeader();
      await renderSetupTab(el);
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: form.name.value.trim(),
      folder: form.folder.value.trim(),
      task_prompt: form.task_prompt.value,
      model: form.model?.value ?? '',
      restore_mode: $('[name=restore_mode]:checked', form)?.value || 'zip',
      turn_limit: form.turn_limit.value,
      max_minutes: form.max_minutes.value,
      fresh_every: form.fresh_every.value || 10,
    };
    if (form.budget_usd) body.budget_usd = form.budget_usd.value;
    if (form.effort) body.effort = form.effort.value;
    if (await attempt(() => api('PUT', `/api/projects/${p.id}`, body), 'Saved')) {
      state.editing = false;
      await refreshProjectHeader();
    }
  });
  $('#delete-project').addEventListener('click', async () => {
    if (!(await confirmModal('Delete this project?', `This deletes <b>${esc(p.name)}</b>, its run history and all of its memory from the app. The folder on disk is not changed.`, 'Delete project'))) return;
    if (await attempt(() => api('DELETE', `/api/projects/${p.id}`), 'Project deleted')) {
      state.editing = false;
      location.hash = '#/';
    }
  });
}

// ---- Schedule tab

function renderScheduleTab(el) {
  const p = state.project;
  el.innerHTML = `
    <div class="panel">
      <div class="spread"><h2 style="margin-top:0">When should ${esc(p.agent_label)} work on this project?</h2>
        <label class="inline-choice"><input type="checkbox" id="sched-enabled" ${p.enabled ? 'checked' : ''}/> Schedule is on</label></div>
      <div id="schedule-box">${scheduleEditorHtml(p.schedule, p.timezone)}</div>
      <div class="row" style="margin-top:18px"><button class="primary" id="save-schedule">Save schedule</button></div>
      <p class="muted small">Scheduled runs only happen while this app is running. If the computer was off at a scheduled time, the app runs once when it starts again (you can turn this off in Settings).</p>
    </div>`;
  const box = $('#schedule-box');
  wireScheduleEditor(box);
  box.addEventListener('input', () => (state.editing = true));
  $('#sched-enabled').addEventListener('change', async (e) => {
    await attempt(() => api('POST', `/api/projects/${p.id}/enabled`, { enabled: e.target.checked }), e.target.checked ? 'Schedule turned on' : 'Schedule paused');
    await refreshProjectHeader();
  });
  $('#save-schedule').addEventListener('click', async () => {
    const { schedule, timezone } = readSchedule(box);
    if (await attempt(() => api('PUT', `/api/projects/${p.id}`, { schedule, timezone }), 'Schedule saved')) {
      state.editing = false;
      await refreshProjectHeader();
    }
  });
}

// ---- Runs tab

async function renderRunsTab(el) {
  const p = state.project;
  const runs = await api('GET', `/api/projects/${p.id}/runs`);
  if (!runs.length) {
    el.innerHTML = `<div class="empty panel"><h2>No runs yet</h2><p>Press <b>Run now</b> to start the first session, or wait for the schedule.</p></div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>#</th><th>Started</th><th>Trigger</th><th>Status</th><th>Duration</th><th>Steps</th><th>Cost</th><th>Files changed</th></tr></thead>
      <tbody>${runs
        .map(
          (r) => `<tr class="clickable" data-run="${r.id}">
            <td>${r.id}</td><td>${esc(fmtTime(r.started_at))}</td><td>${r.trigger === 'schedule' ? 'Schedule' : 'Manual'}</td>
            <td>${statusChip(r.status)}${r.status === 'skipped' && r.error ? `<div class="muted small">${esc(r.error.replace(/^skipped: /, ''))}</div>` : ''}</td>
            <td>${fmtDuration(r.duration_ms)}</td><td>${r.turns ?? '—'}</td><td>${r.status === 'skipped' ? '—' : runCost(r.agent ?? p.agent, r.cost_usd)}</td><td>${r.changed_count ?? '—'}</td></tr>`
        )
        .join('')}</tbody>
    </table>`;
  $$('tr[data-run]', el).forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/project/${p.id}/runs/${tr.dataset.run}`)));
}

// ---- Run log rendering (shared by run detail and live view)

function logEntryHtml(e) {
  const t = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let body;
  if (e.type === 'assistant') body = `<div class="body markdown">${md(e.content)}</div>`;
  else if (e.type === 'prompt') body = `<div class="body"><details><summary>Prompt sent to the agent (preamble + memory snapshot + task)</summary>${esc(e.content)}</details></div>`;
  else if ((e.type === 'tool_result' || e.type === 'tool_error') && (e.content.length > 240 || e.content.split('\n').length > 4)) {
    const first = e.content.split('\n')[0].slice(0, 160);
    body = `<div class="body"><details><summary>${esc(first)} …</summary>${esc(e.content)}</details></div>`;
  } else body = `<div class="body">${esc(e.content)}</div>`;
  return `<div class="entry ${esc(e.type)}"><div class="ts">${t}</div>${body}</div>`;
}

function appendLog(container, entries) {
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  container.insertAdjacentHTML('beforeend', entries.map(logEntryHtml).join(''));
  if (nearBottom) container.scrollTop = container.scrollHeight;
}

function startLiveLog(runId, container, existing) {
  const buffered = state.live?.runId === runId ? state.live.buffer : [];
  state.live = { runId, lastSeq: 0, buffer: [], container };
  appendLog(container, existing);
  state.live.lastSeq = existing.length ? existing[existing.length - 1].seq : 0;
  const pending = buffered.filter((e) => e.seq > state.live.lastSeq);
  if (pending.length) {
    appendLog(container, pending);
    state.live.lastSeq = pending[pending.length - 1].seq;
  }
  container.scrollTop = container.scrollHeight;
}

function onLiveLog(entry) {
  const live = state.live;
  if (!live || live.runId !== entry.runId) return;
  if (!live.container) {
    live.buffer.push(entry);
    return;
  }
  if (entry.seq <= live.lastSeq) return;
  live.lastSeq = entry.seq;
  appendLog(live.container, [entry]);
}

function filesHtml(changed) {
  if (!changed) return '<p class="muted">Not recorded.</p>';
  const total = changed.added.length + changed.changed.length + changed.removed.length;
  if (!total) return '<p class="muted">No files changed.</p>';
  const items = [
    ...changed.added.map((f) => `<div class="a">+ ${esc(f)}</div>`),
    ...changed.changed.map((f) => `<div class="m">~ ${esc(f)}</div>`),
    ...changed.removed.map((f) => `<div class="d">− ${esc(f)}</div>`),
  ];
  return `<p class="muted small">${changed.added.length} added · ${changed.changed.length} changed · ${changed.removed.length} removed</p><div class="files">${items.join('')}</div>`;
}

async function renderRunDetail(el, runId) {
  const p = state.project;
  state.live = { runId, lastSeq: 0, buffer: [], container: null };
  const run = await api('GET', `/api/runs/${runId}`);
  el.innerHTML = `
    <p><a href="#/project/${p.id}/runs">← All runs</a></p>
    <div class="panel">
      <div class="spread"><h2 style="margin:0">Run #${run.id} ${statusChip(run.status)}</h2>
        <div class="row">
          ${run.status === 'running' ? `<button class="danger" id="run-stop">Stop</button>` : ''}
          ${run.restore_available && run.status !== 'running' ? `<button id="run-restore">Restore folder to before this run</button>` : ''}
        </div></div>
      <dl class="kv" style="margin-top:14px">
        <dt>Started</dt><dd>${esc(fmtTime(run.started_at))} (${run.trigger === 'schedule' ? 'schedule' : 'manual'})</dd>
        <dt>Duration</dt><dd>${fmtDuration(run.duration_ms)}</dd>
        <dt>Steps</dt><dd>${run.turns ?? '—'}</dd>
        <dt>Agent</dt><dd>${agentBadge(run.agent ?? p.agent)} ${run.model ? esc(kimiModelName(agentsCache?.kimi, run.model)) : ''}${run.effort ? ` · thinking ${esc(run.effort)}` : ''}</dd>
        <dt>Cost</dt><dd>${(run.agent ?? p.agent) === 'kimi' ? 'Included in your Kimi subscription' : fmtCost(run.cost_usd)}</dd>
        <dt>Session</dt><dd>${run.session_mode ? esc(run.session_mode) : '—'} <span class="muted small mono">${esc(run.session_id ?? '')}</span></dd>
        <dt>Restore point</dt><dd>${run.restore_ref ? (run.restore_ref.type === 'git' ? `git commit <span class="mono">${esc(run.restore_ref.commit?.slice(0, 10))}</span>` : run.restore_ref.type === 'zip' ? (run.restore_available ? 'zip backup' : 'zip backup (already removed – only the last 5 are kept)') : esc(run.restore_ref.warning ?? 'none')) : '—'}</dd>
        ${run.error ? `<dt>Problem</dt><dd class="field-msg bad">${esc(run.error)}</dd>` : ''}
      </dl>
      ${run.agent_note ? `<p class="hint-box" style="margin-top:12px">The agent did not write a progress note, so the app added one to the Progress log for the next session.</p>` : ''}
    </div>
    ${run.summary ? `<div class="panel"><h3 style="margin-top:0">Agent's summary</h3><div class="markdown">${md(run.summary)}</div></div>` : ''}
    <div class="panel"><h3 style="margin-top:0">Changed files</h3>${filesHtml(run.changed_files)}</div>
    <div class="panel"><h3 style="margin-top:0">Memory entries written</h3>${
      run.memory_written?.length ? `<div class="files">${run.memory_written.map((m) => `<div>${esc(m)}</div>`).join('')}</div>` : '<p class="muted">None.</p>'
    }</div>
    <h3>Full log</h3>
    <div class="log" id="run-log"></div>`;
  startLiveLog(run.id, $('#run-log'), run.logs);
  if (run.status !== 'running') state.live = null;
  $('#run-stop')?.addEventListener('click', () => stopRunFor(p.id));
  $('#run-restore')?.addEventListener('click', async () => {
    const ok = await confirmModal(
      'Restore the project folder?',
      `The folder <b>${esc(p.folder)}</b> will be put back exactly as it was before run #${run.id} started. All changes made since then — by this run, later runs or yourself — will be lost. Memory is not changed.`,
      'Restore folder'
    );
    if (!ok) return;
    const r = await attempt(() => api('POST', `/api/runs/${run.id}/restore`));
    if (!r) return;
    if (r.problems?.length) {
      toast(`Folder restored, but ${r.problems.length} file(s) could not be replaced because they are open in another program: ${r.problems.slice(0, 3).join(', ')}`, 'error');
    } else {
      toast('Folder restored');
    }
  });
}

// ---- Live tab

async function renderLiveTab(el) {
  const p = state.project;
  if (!p.active_run_id) {
    const runs = await api('GET', `/api/projects/${p.id}/runs?limit=1`);
    el.innerHTML = `<div class="empty panel"><h2>No run is active</h2><p>When a run is active, its output streams here live.</p>
      <div class="row" style="justify-content:center"><button class="primary" id="live-run">Run now</button>
      ${runs[0] ? `<a class="btn" href="#/project/${p.id}/runs/${runs[0].id}">Open the last run</a>` : ''}</div></div>`;
    $('#live-run').addEventListener('click', () => runNow(p.id, true));
    return;
  }
  const runId = p.active_run_id;
  state.live = { runId, lastSeq: 0, buffer: [], container: null };
  const run = await api('GET', `/api/runs/${runId}`);
  el.innerHTML = `
    <div class="spread" style="margin-bottom:12px"><div>${statusChip(run.status)} Run #${run.id} · started ${esc(fmtTime(run.started_at))}</div>
      <div class="row"><a class="btn" href="#/project/${p.id}/runs/${run.id}">Run details</a><button class="danger" id="live-stop">Stop</button></div></div>
    <div class="log" id="live-log"></div>`;
  startLiveLog(run.id, $('#live-log'), run.logs);
  $('#live-stop').addEventListener('click', () => stopRunFor(p.id));
}

// ---- Memory tab

const MEMORY_SECTIONS = [
  ['brief', 'Brief'],
  ['plan', 'Plan'],
  ['progress', 'Progress'],
  ['notes', 'Decisions & notes'],
  ['search', 'Search'],
  ['session', 'Session & export'],
];
const STANDARD_PATHS = ['/memories/brief.md', '/memories/plan.md', '/memories/progress.md', '/memories/decisions.md'];

async function loadMemory() {
  const entries = await api('GET', `/api/projects/${state.project.id}/memory`);
  state.memory = Object.fromEntries(entries.map((e) => [e.path, e]));
}

async function renderMemoryTab(el) {
  const section = state.route.sub || 'brief';
  state.memorySection = section;
  await loadMemory();
  el.innerHTML = `
    <div class="memory-layout">
      <nav class="subnav">${MEMORY_SECTIONS.map(([k, l]) => `<a href="#/project/${state.project.id}/memory/${k}" class="${section === k ? 'active' : ''}">${l}</a>`).join('')}</nav>
      <div id="memory-content"></div>
    </div>`;
  renderMemorySection();
}

function renderMemorySection() {
  const box = $('#memory-content');
  if (!box) return;
  const s = state.memorySection;
  if (s === 'brief') renderBrief(box);
  else if (s === 'plan') renderPlan(box);
  else if (s === 'progress') renderProgress(box);
  else if (s === 'notes') renderNotes(box);
  else if (s === 'search') renderSearch(box);
  else if (s === 'session') renderSession(box);
}

function entryEditor(box, entryPath, title, { onSaved, hint = '' } = {}) {
  const entry = state.memory[entryPath];
  box.innerHTML = `
    <div class="spread"><h2 style="margin-top:0">${esc(title)}</h2></div>
    ${hint ? `<p class="muted small">${hint}</p>` : ''}
    <textarea class="big code" id="entry-text" style="min-height:420px">${esc(entry?.content ?? '')}</textarea>
    <div class="row" style="margin-top:10px"><button class="primary" id="entry-save">Save</button><button id="entry-cancel">Cancel</button></div>`;
  state.editing = true;
  $('#entry-text').focus();
  $('#entry-cancel').addEventListener('click', () => {
    state.editing = false;
    renderMemorySection();
  });
  $('#entry-save').addEventListener('click', async () => {
    const saved = await attempt(() => api('PUT', `/api/projects/${state.project.id}/memory`, { path: entryPath, content: $('#entry-text').value }), 'Saved');
    if (saved) {
      state.editing = false;
      await loadMemory();
      onSaved ? onSaved() : renderMemorySection();
    }
  });
}

function renderBrief(box) {
  const entry = state.memory['/memories/brief.md'];
  box.innerHTML = `
    <div class="spread"><h2 style="margin-top:0">Brief</h2>
      <div class="row"><button id="brief-edit">Edit</button><button id="brief-history">History</button></div></div>
    <p class="muted small">The project goal, scope, standing rules and conventions. The agent reads this at the start of every session.</p>
    <div class="panel markdown">${md(entry?.content)}</div>`;
  $('#brief-edit').addEventListener('click', () => entryEditor(box, '/memories/brief.md', 'Edit brief'));
  $('#brief-history').addEventListener('click', () => showHistory('/memories/brief.md'));
}

function renderPlan(box) {
  const entry = state.memory['/memories/plan.md'];
  const doc = parsePlanDoc(entry?.content);
  const draw = () => {
    box.innerHTML = `
      <div class="spread"><h2 style="margin-top:0">Plan</h2>
        <div class="row"><button id="plan-text">Edit as text</button><button id="plan-history">History</button></div></div>
      <p class="muted small">The roadmap. The agent works through the steps in order and updates their status. You can add, reorder, edit and tick off steps; the next session follows your changes.</p>
      <div class="panel">
        ${doc.steps.length ? '' : '<p class="muted">No steps yet. Add the first one below.</p>'}
        ${doc.steps
          .map(
            (s, i) => `<div class="plan-step ${s.status === 'done' ? 'done' : ''}" data-i="${i}">
              <div class="row" style="flex-wrap:nowrap"><input type="checkbox" data-act="tick" ${s.status === 'done' ? 'checked' : ''} title="Mark done"/>
                <select data-act="status">${Object.entries(STATUS_LABEL).map(([k, l]) => `<option value="${k}" ${s.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
              <input type="text" data-act="text" value="${esc(s.text)}"/>
              <div class="row" style="flex-wrap:nowrap"><button class="small" data-act="up" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
                <button class="small" data-act="down" ${i === doc.steps.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
                <button class="small danger" data-act="del" title="Remove step">✕</button></div>
              ${s.details.length ? `<div class="details">${esc(s.details.join('\n'))}</div>` : ''}
            </div>`
          )
          .join('')}
        <div class="row" style="margin-top:12px"><input type="text" id="new-step" placeholder="New step…" style="flex:1"/><button id="add-step">Add step</button></div>
      </div>
      <div class="row"><button class="primary" id="plan-save">Save plan</button><span class="muted small" id="plan-dirty"></span></div>`;

    const markDirty = () => {
      state.editing = true;
      $('#plan-dirty').textContent = 'Unsaved changes';
    };
    $$('.plan-step', box).forEach((row) => {
      const i = Number(row.dataset.i);
      row.addEventListener('change', (e) => {
        const act = e.target.dataset.act;
        if (act === 'tick') doc.steps[i].status = e.target.checked ? 'done' : 'todo';
        if (act === 'status') doc.steps[i].status = e.target.value;
        if (act === 'text') doc.steps[i].text = e.target.value;
        markDirty();
        if (act !== 'text') draw(), markDirty();
      });
      row.addEventListener('click', (e) => {
        const act = e.target.dataset.act;
        if (act === 'up' && i > 0) [doc.steps[i - 1], doc.steps[i]] = [doc.steps[i], doc.steps[i - 1]];
        else if (act === 'down' && i < doc.steps.length - 1) [doc.steps[i + 1], doc.steps[i]] = [doc.steps[i], doc.steps[i + 1]];
        else if (act === 'del') doc.steps.splice(i, 1);
        else return;
        draw();
        markDirty();
      });
    });
    const add = () => {
      const text = $('#new-step').value.trim();
      if (!text) return;
      doc.steps.push({ status: 'todo', text, details: [] });
      draw();
      markDirty();
      $('#new-step').focus();
    };
    $('#add-step').addEventListener('click', add);
    $('#new-step').addEventListener('keydown', (e) => e.key === 'Enter' && add());
    $('#plan-save').addEventListener('click', async () => {
      $$('.plan-step input[data-act=text]', box).forEach((inp) => (doc.steps[Number(inp.closest('.plan-step').dataset.i)].text = inp.value));
      const ok = await attempt(() => api('PUT', `/api/projects/${state.project.id}/memory`, { path: '/memories/plan.md', content: serializePlan(doc) }), 'Plan saved');
      if (ok) {
        state.editing = false;
        await loadMemory();
        renderMemorySection();
      }
    });
    $('#plan-text').addEventListener('click', () =>
      entryEditor(box, '/memories/plan.md', 'Edit plan as text', { hint: 'Steps are lines like "- [ ] step". Markers: [ ] to do, [~] in progress, [x] done, [!] blocked.' })
    );
    $('#plan-history').addEventListener('click', () => showHistory('/memories/plan.md'));
  };
  draw();
}

function renderProgress(box) {
  const entry = state.memory['/memories/progress.md'];
  const sections = parseProgress(entry?.content).reverse();
  box.innerHTML = `
    <div class="spread"><h2 style="margin-top:0">Progress</h2>
      <div class="row"><button id="prog-edit">Edit</button><button id="prog-history">History</button></div></div>
    <p class="muted small">One entry per session, newest first. Each entry says what was done, what failed and the next step.</p>
    ${sections.length ? sections.map((s) => `<div class="timeline-item"><h3>${esc(s.title)}</h3><div class="markdown">${md(s.body)}</div></div>`).join('') : '<div class="empty panel">No sessions have written progress yet.</div>'}`;
  $('#prog-edit').addEventListener('click', () => entryEditor(box, '/memories/progress.md', 'Edit progress log'));
  $('#prog-history').addEventListener('click', () => showHistory('/memories/progress.md'));
}

function renderNotes(box, selected) {
  const others = Object.keys(state.memory)
    .filter((p) => !['/memories/brief.md', '/memories/plan.md', '/memories/progress.md'].includes(p))
    .sort((a, b) => (a === '/memories/decisions.md' ? -1 : b === '/memories/decisions.md' ? 1 : a.localeCompare(b)));
  const current = selected && state.memory[selected] ? selected : others[0];
  const entry = current ? state.memory[current] : null;
  box.innerHTML = `
    <div class="spread"><h2 style="margin-top:0">Decisions & notes</h2><button id="new-note">+ New note</button></div>
    <div class="memory-layout" style="grid-template-columns:240px 1fr">
      <nav class="subnav">${others.map((p) => `<a href="javascript:void 0" data-path="${esc(p)}" class="${p === current ? 'active' : ''}">${esc(p.replace('/memories/', ''))}</a>`).join('')}</nav>
      <div>${
        entry
          ? `<div class="spread"><div><b class="mono">${esc(entry.path)}</b> <span class="muted small">updated ${esc(timeAgo(entry.updated_at))}</span></div>
               <div class="row"><button id="note-edit">Edit</button><button id="note-history">History</button>
               ${STANDARD_PATHS.includes(entry.path) ? '' : '<button class="danger" id="note-delete">Delete</button>'}</div></div>
             <div class="panel markdown" style="margin-top:10px">${md(entry.content)}</div>`
          : '<p class="muted">No notes yet.</p>'
      }</div>
    </div>`;
  $$('[data-path]', box).forEach((a) => a.addEventListener('click', () => renderNotes(box, a.dataset.path)));
  $('#new-note').addEventListener('click', () => {
    const name = prompt('Name for the new note (for example "architecture" or "api-keys-needed"):');
    if (!name) return;
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return;
    const p = `/memories/notes/${slug.endsWith('.md') ? slug : slug + '.md'}`;
    if (!state.memory[p]) state.memory[p] = { path: p, content: `# ${name.trim()}\n\n` };
    entryEditor(box, p, `New note: ${p}`, { onSaved: () => renderNotes(box, p) });
  });
  if (entry) {
    $('#note-edit').addEventListener('click', () => entryEditor(box, entry.path, `Edit ${entry.path}`, { onSaved: () => renderNotes(box, entry.path) }));
    $('#note-history').addEventListener('click', () => showHistory(entry.path));
    $('#note-delete')?.addEventListener('click', async () => {
      if (!(await confirmModal('Delete this note?', `<span class="mono">${esc(entry.path)}</span> will be deleted. You can still restore it from its history.`, 'Delete'))) return;
      if (await attempt(() => api('POST', `/api/projects/${state.project.id}/memory/delete`, { path: entry.path }), 'Deleted')) {
        await loadMemory();
        renderNotes(box);
      }
    });
  }
}

function openMemoryPath(p) {
  const map = { '/memories/brief.md': 'brief', '/memories/plan.md': 'plan', '/memories/progress.md': 'progress' };
  if (map[p]) {
    location.hash = `#/project/${state.project.id}/memory/${map[p]}`;
    return;
  }
  state.memorySection = 'notes';
  history.replaceState(null, '', `#/project/${state.project.id}/memory/notes`);
  currentHash = location.hash;
  $$('.memory-layout > .subnav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href').endsWith('/notes')));
  renderNotes($('#memory-content'), p);
}

function renderSearch(box) {
  box.innerHTML = `
    <h2 style="margin-top:0">Search memory</h2>
    <div class="row"><input type="text" id="mem-q" placeholder="Search words…" style="flex:1"/><button class="primary" id="mem-search">Search</button></div>
    <ul class="search-results" id="mem-results" style="margin-top:16px"></ul>`;
  const run = async () => {
    const q = $('#mem-q').value.trim();
    if (!q) return;
    const results = await attempt(() => api('GET', `/api/projects/${state.project.id}/memory/search?q=${encodeURIComponent(q)}`));
    if (!results) return;
    $('#mem-results').innerHTML = results.length
      ? results
          .map((r) => `<li><a href="javascript:void 0" data-path="${esc(r.path)}" class="mono">${esc(r.path)}</a><div class="small">${esc(r.snippet).replace(/«/g, '<mark>').replace(/»/g, '</mark>')}</div></li>`)
          .join('')
      : '<li class="muted">No matches.</li>';
    $$('[data-path]', box).forEach((a) => a.addEventListener('click', () => openMemoryPath(a.dataset.path)));
  };
  $('#mem-search').addEventListener('click', run);
  $('#mem-q').addEventListener('keydown', (e) => e.key === 'Enter' && run());
  $('#mem-q').focus();
}

function renderSession(box) {
  const p = state.project;
  box.innerHTML = `
    <h2 style="margin-top:0">Session</h2>
    <div class="panel">
      <dl class="kv">
        <dt>Current session id</dt><dd class="mono">${esc(p.session_id ?? 'none yet')}</dd>
        <dt>Runs on this session</dt><dd>${p.runs_on_session}</dd>
        <dt>Fresh session every</dt><dd>${p.fresh_every} runs <span class="muted small">(change in Setup)</span></dd>
        <dt>Next run</dt><dd>${p.next_fresh_reason ? `will start a fresh session <span class="muted small">(${esc(p.next_fresh_reason)})</span>` : 'will resume this session'}</dd>
      </dl>
      <p class="muted small">Resuming keeps the agent's conversation context. A fresh session starts with no conversation history and relies only on memory — that is safe, because memory carries the project state.</p>
      <button id="fresh-session" ${p.fresh_pending ? 'disabled' : ''}>${p.fresh_pending ? 'Fresh session requested' : 'Start fresh session'}</button>
    </div>
    <h2>Export / import memory</h2>
    <div class="panel">
      <label>Export all entries as Markdown files to this folder <span class="hint">must be outside the project folder</span></label>
      <div class="row"><input type="text" id="export-folder" placeholder="C:\\Users\\you\\Documents\\memory-export" style="flex:1"/><button id="export-browse">Browse…</button><button id="export-btn">Export memory</button></div>
      <label>Import Markdown files from this folder <span class="hint">files are saved as /memories/&lt;relative path&gt;; existing entries are overwritten but keep their history</span></label>
      <div class="row"><input type="text" id="import-folder" style="flex:1"/><button id="import-browse">Browse…</button><button id="import-btn">Import memory</button></div>
    </div>`;
  $('#fresh-session').addEventListener('click', async () => {
    if (await attempt(() => api('POST', `/api/projects/${p.id}/fresh-session`), 'The next run will start a fresh session')) {
      await refreshProjectHeader();
      renderSession(box);
    }
  });
  $('#export-browse').addEventListener('click', (e) => browseFolder($('#export-folder'), e.currentTarget));
  $('#import-browse').addEventListener('click', (e) => browseFolder($('#import-folder'), e.currentTarget));
  $('#export-btn').addEventListener('click', async () => {
    const r = await attempt(() => api('POST', `/api/projects/${p.id}/memory/export`, { folder: $('#export-folder').value.trim() }));
    if (r) toast(`Exported ${r.count} entries to ${r.folder}`);
  });
  $('#import-btn').addEventListener('click', async () => {
    const r = await attempt(() => api('POST', `/api/projects/${p.id}/memory/import`, { folder: $('#import-folder').value.trim() }));
    if (r) {
      toast(`Imported ${r.count} entries`);
      await loadMemory();
    }
  });
}

async function showHistory(entryPath) {
  const pid = state.project.id;
  const versions = await attempt(() => api('GET', `/api/projects/${pid}/memory/history?path=${encodeURIComponent(entryPath)}`));
  if (!versions) return;
  const current = state.memory[entryPath];
  modal(
    `<div class="spread"><h2 style="margin-top:0">History of <span class="mono">${esc(entryPath)}</span></h2><button data-close>Close</button></div>
     <p class="muted small">Each item is the content as it was <b>before</b> that change. Restoring saves it as the new current version (the current content stays in history).</p>
     <div class="history-layout">
       <div class="history-list">
         <a href="javascript:void 0" data-v="current" class="active"><b>Current version</b><br/><span class="muted">${esc(fmtTime(current?.updated_at))}</span></a>
         ${versions
           .map(
             (v) => `<a href="javascript:void 0" data-v="${v.id}">${esc(fmtTime(v.changed_at))}<br/><span class="muted">${esc(v.action)} by ${esc(v.changed_by)}${v.size == null ? ' · (did not exist)' : ''}</span></a>`
           )
           .join('')}
       </div>
       <div class="history-view" id="hv"></div>
     </div>`,
    (el, close) => {
      const show = async (id) => {
        $$('[data-v]', el).forEach((a) => a.classList.toggle('active', a.dataset.v === String(id)));
        const hv = $('#hv', el);
        if (id === 'current') {
          hv.innerHTML = `<pre>${esc(current?.content ?? '(deleted)')}</pre>`;
          return;
        }
        const v = await api('GET', `/api/projects/${pid}/memory/version/${id}`);
        hv.innerHTML = `<pre>${v.previous_content == null ? '(the entry did not exist before this change)' : esc(v.previous_content)}</pre>
          <button class="primary" id="restore-v">${v.previous_content == null ? 'Restore (delete the entry)' : 'Restore this version'}</button>`;
        $('#restore-v', hv).addEventListener('click', async () => {
          if (await attempt(() => api('POST', `/api/projects/${pid}/memory/restore`, { history_id: id }), 'Version restored')) {
            close();
            await loadMemory();
            renderMemorySection();
          }
        });
      };
      $$('[data-v]', el).forEach((a) => a.addEventListener('click', () => show(a.dataset.v === 'current' ? 'current' : Number(a.dataset.v))));
      show('current');
    }
  );
}

// ---------------- settings ----------------

async function renderSettings() {
  const stale = routeGuard();
  await refreshState();
  const s = state.settings;
  const models = await loadModels();
  if (stale()) return;
  view.innerHTML = `
    <h1>Settings</h1>
    <form id="settings-form">
      <div class="panel">
        <h2 style="margin-top:0">Claude API key</h2>
        <p class="muted small">Create a key in the <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Claude Console</a>. Usage is billed per token to that account. The key is stored only on this computer, in the app's database.</p>
        <div class="row"><input type="password" name="api_key" autocomplete="off" placeholder="${s.has_api_key ? `Saved key: ${esc(s.api_key_masked)} – type a new key to replace it` : 'Paste your key here (it starts with sk-ant-)'}" style="flex:1"/>
          <button type="button" id="test-key">Test key</button></div>
        <div class="field-msg" id="key-msg"></div>
        ${s.api_key_source?.startsWith('file:') ? `<p class="muted small">The saved key was loaded from the file <b>${esc(s.api_key_source.slice(5))}</b> next to start.bat.</p>` : ''}
      </div>
      <div class="panel">
        <h2 style="margin-top:0">Defaults for runs</h2>
        <label>Default Claude model</label>
        <select name="default_model">${modelOptions(models, s.default_model, false)}</select>
        ${state.models?.error ? `<div class="field-msg bad">Could not load the model list: ${esc(state.models.error)}</div>` : ''}
        <div class="row" style="gap:28px">
          <div><label>Step limit per run</label><input type="number" name="default_turn_limit" min="1" value="${esc(s.default_turn_limit)}"/></div>
          <div><label>Budget per run (USD, Claude only)</label><input type="number" name="default_budget_usd" min="0.1" step="0.1" value="${esc(s.default_budget_usd)}"/></div>
          <div><label>Time limit per run (minutes)</label><input type="number" name="default_max_minutes" min="1" value="${esc(s.default_max_minutes)}"/></div>
        </div>
        <label>Monthly budget cap for Claude (USD) <span class="hint">when reached, Claude schedules pause until next month; Kimi uses your subscription and is not affected</span></label>
        <input type="number" name="monthly_cap_usd" min="1" step="1" value="${esc(s.monthly_cap_usd)}"/>
        <p class="muted small">Spent this month: ${fmtCost(state.monthCost)}</p>
      </div>
      <div class="panel">
        <h2 style="margin-top:0">App</h2>
        <label class="inline-choice"><input type="checkbox" name="catch_up_missed" ${s.catch_up_missed ? 'checked' : ''}/> Run once at startup if a scheduled run was missed while the app was closed</label>
        <label class="inline-choice"><input type="checkbox" name="start_with_windows" ${s.start_with_windows ? 'checked' : ''}/> Start the app automatically when I log in to Windows (runs in the background)</label>
        <label>Backup size limit (MB) <span class="hint">zip restore points are skipped for bigger folders</span></label>
        <input type="number" name="backup_size_limit_mb" min="10" value="${esc(s.backup_size_limit_mb)}"/>
        <label>Port <span class="hint">takes effect after restarting the app</span></label>
        <input type="number" name="port" min="1024" max="65535" value="${esc(s.port)}"/>
      </div>
      <div class="row"><button class="primary" type="submit">Save settings</button></div>
    </form>
    <div class="panel" style="margin-top:24px">
      <div class="spread"><h2 style="margin-top:0">Kimi Code CLI</h2><button id="kimi-check">Check again</button></div>
      <p class="muted small">Projects that use Kimi run on your Kimi subscription, through the Kimi Code CLI installed on this computer. There is no per-use cost and no API key. Checking does not use any of your quota.</p>
      <dl class="kv" id="kimi-info"><dt>Checking…</dt><dd></dd></dl>
      <div class="row" id="kimi-actions" style="margin-top:12px"></div>
    </div>
    <div class="panel" style="margin-top:24px">
      <h2 style="margin-top:0">Moving the app to another computer</h2>
      <p class="muted small">Everything lives in the app folder: the app, its settings and API key, the memory and run history of every project, and the project folders in its "projects" folder.</p>
      <ol class="steps">
        <li>Press <b>Shut down app</b> below, so everything is saved.</li>
        <li>Copy the whole app folder to the other computer, for example with a USB stick:<br/><span class="mono small" id="app-folder">…</span> <button class="small" id="open-app">Open app folder</button></li>
        <li>On the other computer, double-click <b>start.bat</b> in the copied folder. A desktop icon is created there.</li>
        <li>If you use Kimi, open Settings there and set up Kimi Code CLI (install and log in).</li>
      </ol>
      <div id="outside-projects"></div>
    </div>
    <div class="panel" style="margin-top:24px">
      <h2 style="margin-top:0">Help &amp; troubleshooting</h2>
      <dl class="kv" id="diag"><dt>Checking…</dt><dd></dd></dl>
      <div class="row" style="margin-top:14px">
        <button id="open-logs">Open log folder</button>
        <button id="open-data">Open data folder</button>
        ${state.canRestart ? '<button id="restart">Restart app</button>' : ''}
        <button class="danger" id="shutdown">Shut down app</button>
      </div>
      <p class="muted small">Shutting down stops the app and any active run. Scheduled runs only happen while the app is running. Start it again with the "Claude Agent Runner" icon on your desktop or start.bat.</p>
    </div>`;
  const form = $('#settings-form');
  const testKey = async (keyText) => {
    const msg = $('#key-msg');
    msg.className = 'field-msg';
    msg.textContent = 'Testing the key…';
    const r = await api('POST', '/api/settings/test-key', { api_key: keyText }).catch((e) => ({ ok: false, message: e.message }));
    if (r.ok && keyText) {
      // A typed key that works is saved right away, so nobody forgets to press "Save settings".
      const saved = await api('PUT', '/api/settings', { api_key: keyText }).then(() => true, () => false);
      if (saved) {
        form.api_key.value = '';
        await refreshState();
        form.api_key.placeholder = `Saved key: ${state.settings.api_key_masked} – type a new key to replace it`;
        msg.className = 'field-msg ok';
        msg.textContent = '✓ The key works and has been saved.';
        return;
      }
    }
    msg.className = `field-msg ${r.ok ? 'ok' : 'bad'}`;
    msg.textContent = r.ok ? `✓ ${r.message}` : r.message;
  };
  $('#test-key').addEventListener('click', () => testKey(form.api_key.value.trim()));
  if (s.has_api_key) testKey('');

  api('GET', '/api/diagnostics')
    .then((d) => {
      const ok = (v) => (v ? '✓' : '✗');
      $('#diag').innerHTML = `
        <dt>App version</dt><dd>${esc(d.app_version)}</dd>
        <dt>Claude engine</dt><dd>${ok(d.agent_engine.binaryFound)} Claude Agent SDK ${esc(d.agent_engine.version ?? 'missing')}</dd>
        <dt>Node.js</dt><dd>${esc(d.node_version)}</dd>
        <dt>Git</dt><dd>${d.git_version ? `✓ ${esc(d.git_version)}` : 'not installed (the agent uses PowerShell instead)'}</dd>
        <dt>Windows</dt><dd>${esc(d.platform)}</dd>
        <dt>Free disk space</dt><dd>${d.free_disk_gb == null ? '—' : `${d.free_disk_gb} GB`}${d.free_disk_gb != null && d.free_disk_gb < 2 ? ' <span class="field-msg bad">(low)</span>' : ''}</dd>
        <dt>App folder</dt><dd class="mono">${esc(d.app_folder)}</dd>
        <dt>Data folder</dt><dd class="mono">${esc(d.data_folder)}</dd>`;
      if ($('#app-folder')) $('#app-folder').textContent = d.app_folder;
    })
    .catch(() => ($('#diag').innerHTML = '<dt>Diagnostics</dt><dd>not available</dd>'));
  const showKimi = async (refresh) => {
    const box = $('#kimi-info');
    if (!box) return;
    box.innerHTML = '<dt>Checking…</dt><dd></dd>';
    const info = await loadAgents(refresh);
    const k = info?.kimi;
    if (!k || !$('#kimi-info')) return;
    const yes = (v) => (v ? '✓' : '✗');
    box.innerHTML = k.installed
      ? `<dt>Installed</dt><dd>${yes(true)} version ${esc(k.version ?? '?')} <span class="muted small mono">${esc(k.path ?? '')}</span></dd>
         <dt>Logged in</dt><dd>${k.loggedIn ? '✓ yes' : `<span class="field-msg bad">${k.message?.startsWith('Kimi Code CLI did not respond') ? esc(k.message) : 'Not logged in yet.'}</span>`}</dd>
         ${k.loggedIn ? `<dt>Models</dt><dd>${k.models.map((m) => esc(m.name)).join(', ') || '—'}</dd>
         <dt>Used for new Kimi projects</dt><dd>${esc(kimiModelName(k, k.preferredModel) ?? 'Kimi default')} with Max thinking${k.hasK31 ? '' : '<div class="muted small">K3.1 Pro is not in your Kimi model list yet. Press "Log in to Kimi again" to refresh the list.</div>'}</dd>` : ''}`
      : `<dt>Installed</dt><dd><span class="field-msg bad">Not installed on this computer.</span></dd>`;
    const actions = $('#kimi-actions');
    if (!actions) return;
    actions.innerHTML = !k.installed
      ? `<button class="primary" data-kimi-setup="install">Install Kimi Code CLI</button><span class="muted small">Opens a window that installs Kimi Code CLI with its official installer, then asks you to log in with your Kimi account.</span>`
      : !k.loggedIn
        ? `<button class="primary" data-kimi-setup="login">Log in to Kimi</button><span class="muted small">Opens a window where you log in with your Kimi account.</span>`
        : k.hasK31
          ? ''
          : `<button data-kimi-setup="login">Log in to Kimi again</button>`;
    $$('[data-kimi-setup]', actions).forEach((b) =>
      b.addEventListener('click', () =>
        attempt(() => api('POST', '/api/agents/kimi/setup', { action: b.dataset.kimiSetup })).then((r) => {
          if (r === undefined) return;
          modal(
            `<h2>${b.dataset.kimiSetup === 'install' ? 'Installing Kimi Code CLI' : 'Logging in to Kimi'}</h2>
             <p>A PowerShell window opened (look for it in the taskbar if you do not see it). Follow the steps in that window:
             ${b.dataset.kimiSetup === 'install' ? 'it installs Kimi Code CLI and then shows a web page and a code to log in with your Kimi account.' : 'it shows a web page and a code; open the page, log in with your Kimi account and confirm the code.'}</p>
             <p>When the window says <b>Finished</b>, close it and press <b>Check again</b>.</p>
             <div class="row" style="justify-content:flex-end"><button class="primary" data-close>OK</button></div>`
          );
        })
      )
    );
    renderBanner();
  };
  showKimi(false);
  $('#kimi-check').addEventListener('click', () => showKimi(true));
  $('#open-app').addEventListener('click', () => attempt(() => api('POST', '/api/open', { what: 'app' })));
  const showOutsideProjects = async () => {
    const box = $('#outside-projects');
    if (!box) return;
    const projects = await api('GET', '/api/projects').catch(() => []);
    const outside = projects.filter((p) => !p.folder_in_app);
    if (!$('#outside-projects')) return;
    box.innerHTML = outside.length
      ? `<div class="hint-box"><b>Not copied along:</b> ${outside.length === 1 ? 'this project keeps its folder' : 'these projects keep their folders'} outside the app folder.
          Move ${outside.length === 1 ? 'it' : 'them'} into the app folder first, or copy ${outside.length === 1 ? 'that folder' : 'those folders'} separately.
          <ul class="plain">${outside.map((p) => `<li class="row" style="justify-content:space-between"><span><a href="#/project/${p.id}/setup">${esc(p.name)}</a> <span class="muted small mono">${esc(p.folder)}</span></span>
            ${p.folder_exists ? `<button class="small" data-move="${p.id}" ${p.active_run_id ? 'disabled title="Wait until the active run has finished"' : ''}>Move into the app folder</button>` : '<span class="muted small">folder not found</span>'}</li>`).join('')}</ul></div>`
      : '<p class="field-msg ok">✓ All project folders are inside the app folder, so they are copied along.</p>';
    $$('[data-move]', box).forEach((b) =>
      b.addEventListener('click', async () => {
        const p = outside.find((x) => String(x.id) === b.dataset.move);
        const ok = await confirmModal(
          'Move the project folder into the app folder?',
          `<b>${esc(p.folder)}</b> moves into the app's "projects" folder. Its contents stay exactly the same.<br/><br/>Close any window or program that has this folder open first. The next run of <b>${esc(p.name)}</b> starts a fresh session; the project memory carries everything over.`,
          'Move folder',
          false
        );
        if (!ok) return;
        b.disabled = true;
        await attempt(() => api('POST', `/api/projects/${p.id}/move-into-app`), `"${p.name}" was moved into the app folder.`);
        showOutsideProjects();
      })
    );
  };
  showOutsideProjects();
  $('#open-logs').addEventListener('click', () => attempt(() => api('POST', '/api/open', { what: 'logs' })));
  $('#open-data').addEventListener('click', () => attempt(() => api('POST', '/api/open', { what: 'data' })));
  $('#restart')?.addEventListener('click', async () => {
    if (!(await confirmModal('Restart the app?', 'Any active run will be stopped. The page reconnects by itself after a few seconds.', 'Restart', false))) return;
    await api('POST', '/api/restart').catch(() => {});
    toast('Restarting…');
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      default_model: form.default_model.value,
      default_turn_limit: Number(form.default_turn_limit.value) || 50,
      default_budget_usd: Number(form.default_budget_usd.value) || 5,
      default_max_minutes: Number(form.default_max_minutes.value) || 60,
      monthly_cap_usd: Number(form.monthly_cap_usd.value) || 100,
      catch_up_missed: form.catch_up_missed.checked,
      start_with_windows: form.start_with_windows.checked,
      backup_size_limit_mb: Number(form.backup_size_limit_mb.value) || 500,
      port: Number(form.port.value) || 4280,
    };
    if (form.api_key.value.trim()) body.api_key = form.api_key.value.trim();
    if (await attempt(() => api('PUT', '/api/settings', body), 'Settings saved')) {
      state.models = null;
      await renderSettings();
    }
  });
  $('#shutdown').addEventListener('click', async () => {
    if (!(await confirmModal('Shut down the app?', 'Scheduled runs will stop until you start the app again by double-clicking start.bat.', 'Shut down'))) return;
    state.shutdownRequested = true;
    await api('POST', '/api/shutdown').catch(() => {});
    view.innerHTML = '<div class="empty panel"><h2>The app has been shut down</h2><p>To start it again, double-click the "Claude Agent Runner" icon on your desktop (or start.bat).</p></div>';
  });
}

// ---------------- live updates ----------------

let refreshTimer = null;
function refreshCurrent() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const r = state.route;
    try {
      await refreshState();
      if (r?.name === 'dashboard') await renderDashboard();
      else if (r?.name === 'project') {
        const wasActive = state.project?.active_run_id;
        await refreshProjectHeader();
        const content = $('#tab-content');
        if (!content || state.editing) return;
        if (r.tab === 'runs' && !r.sub) await renderRunsTab(content);
        else if (r.tab === 'runs' && r.sub && !state.live) {
          /* finished run detail: nothing to refresh */
        } else if (r.tab === 'runs' && r.sub && state.live && wasActive && !state.project.active_run_id) await renderRunDetail(content, Number(r.sub));
        else if (r.tab === 'live' && wasActive && !state.project.active_run_id) location.hash = `#/project/${r.id}/runs/${wasActive}`;
        else if (r.tab === 'live' && wasActive !== state.project.active_run_id) await renderLiveTab(content);
        else if (r.tab === 'memory' && !state.project.active_run_id && wasActive) await renderMemoryTab(content);
      }
    } catch {
      /* ignore transient errors */
    }
  }, 300);
}

let offlineTimer = null;
let offline = false;

function showOffline() {
  if ($('#offline')) return;
  const el = document.createElement('div');
  el.id = 'offline';
  el.className = 'offline';
  el.innerHTML = state.shutdownRequested
    ? `<div class="panel"><h2>The app has been shut down</h2><p>To start it again, double-click the <b>Claude Agent Runner</b> icon on your desktop (or start.bat).</p></div>`
    : `<div class="panel"><h2>The app is not running</h2>
        <p>This page cannot reach the app. It may be restarting — this page reconnects by itself.</p>
        <p>If this message stays, start the app again by double-clicking the <b>Claude Agent Runner</b> icon on your desktop (or start.bat).</p></div>`;
  document.body.append(el);
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    clearTimeout(offlineTimer);
    offlineTimer = null;
    if (offline) {
      offline = false;
      $('#offline')?.remove();
      refreshState().catch(() => {});
      if (!state.editing) router();
    }
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) setTimeout(connectEvents, 3000);
    if (!offlineTimer && !offline) {
      offlineTimer = setTimeout(() => {
        offlineTimer = null;
        offline = true;
        showOffline();
      }, 4000);
    }
  };
  es.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.type === 'log') onLiveLog(ev.data);
    else if (['run-updated', 'projects-changed', 'budget-paused'].includes(ev.type)) refreshCurrent();
    else if (ev.type === 'memory-changed' && state.route?.tab === 'memory' && !state.editing) {
      loadMemory().then(renderMemorySection);
    }
  };
}

window.addEventListener('hashchange', router);
window.addEventListener('beforeunload', (e) => {
  if (state.editing) e.preventDefault();
});

(async function init() {
  await refreshState().catch(() => {});
  connectEvents();
  router();
})();
