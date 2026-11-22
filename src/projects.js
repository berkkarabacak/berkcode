import { db, now } from './db.js';
import { getSetting } from './settings.js';

const COLUMNS = [
  'name', 'folder', 'task_prompt', 'model', 'schedule', 'timezone', 'enabled', 'restore_mode',
  'fresh_every', 'turn_limit', 'budget_usd', 'max_minutes',
];

function hydrate(row) {
  if (!row) return null;
  let schedule;
  try {
    schedule = JSON.parse(row.schedule);
  } catch {
    schedule = { type: 'daily', time: '09:00' };
  }
  return { ...row, schedule, enabled: Boolean(row.enabled), fresh_pending: Boolean(row.fresh_pending) };
}

export function getProject(id) {
  return hydrate(db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id)));
}

export function listProjects() {
  return db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all().map(hydrate);
}

function serialize(key, value) {
  if (key === 'schedule') return JSON.stringify(value);
  if (key === 'enabled') return value ? 1 : 0;
  if (['fresh_every', 'turn_limit', 'max_minutes'].includes(key)) return value === '' || value == null ? null : Math.max(1, Math.round(Number(value)));
  if (key === 'budget_usd') return value === '' || value == null ? null : Math.max(0.01, Number(value));
  return value == null ? null : String(value);
}

export function createProject(data) {
  const res = db
    .prepare(
      `INSERT INTO projects(name, folder, task_prompt, model, schedule, timezone, enabled, restore_mode, fresh_every, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.name || 'New project',
      data.folder,
      data.task_prompt ?? '',
      data.model || null,
      JSON.stringify(data.schedule ?? { type: 'daily', time: '09:00' }),
      data.timezone || 'Europe/Istanbul',
      data.enabled ? 1 : 0,
      data.restore_mode === 'git' ? 'git' : 'zip',
      data.fresh_every ?? 10,
      now()
    );
  return getProject(Number(res.lastInsertRowid));
}

export function updateProject(id, data) {
  const sets = [];
  const values = [];
  for (const key of COLUMNS) {
    if (key in data) {
      sets.push(`${key} = ?`);
      values.push(serialize(key, data[key]));
    }
  }
  if ('enabled' in data && data.enabled) {
    sets.push('paused_reason = NULL', 'consecutive_failures = 0');
  }
  if (sets.length) db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values, Number(id));
  return getProject(id);
}

export function setProjectFields(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
    ...keys.map((k) => (typeof fields[k] === 'boolean' ? (fields[k] ? 1 : 0) : fields[k])),
    Number(id)
  );
}

export function deleteProject(id) {
  db.prepare('DELETE FROM projects WHERE id = ?').run(Number(id));
}

/** Effective per-run limits: project overrides, else global defaults. */
export function effectiveLimits(project) {
  return {
    model: project.model || getSetting('default_model'),
    maxTurns: project.turn_limit || getSetting('default_turn_limit'),
    budgetUsd: project.budget_usd || getSetting('default_budget_usd'),
    maxMinutes: project.max_minutes || getSetting('default_max_minutes'),
  };
}

function monthStartIso() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

export function monthCost(projectId = null) {
  const row = projectId
    ? db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE started_at >= ? AND project_id = ?').get(monthStartIso(), Number(projectId))
    : db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE started_at >= ?').get(monthStartIso());
  return row.c;
}

export function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function budgetPaused() {
  return getSetting('budget_paused_month') === currentMonthKey();
}
