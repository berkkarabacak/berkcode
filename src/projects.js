import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, now } from './db.js';
import { getSetting } from './settings.js';
import { APP_ROOT, PROJECTS_DIR, isInside, canonicalPath } from './paths.js';

/**
 * Folders inside the app folder are stored relative to it, so the app folder can be copied to another
 * computer (or another place) and every project still finds its folder.
 */
export function storeFolder(folder) {
  const abs = path.resolve(String(folder));
  return isInside(abs, APP_ROOT) ? path.relative(APP_ROOT, canonicalPath(abs)) : abs;
}

/** Turns a stored folder back into a full path. Also finds folders that moved along with a Windows user folder. */
export function resolveFolder(stored) {
  if (!stored) return stored;
  if (!path.isAbsolute(stored)) return path.join(APP_ROOT, stored);
  if (fs.existsSync(stored)) return stored;
  // Copied to another computer: try the same place inside this user's folder (C:\Users\<someone else>\...).
  const match = stored.match(/^[a-zA-Z]:[\\/]Users[\\/][^\\/]+[\\/](.+)$/);
  if (match) {
    const candidate = path.join(os.homedir(), match[1]);
    if (fs.existsSync(candidate)) return candidate;
  }
  return stored;
}

/** The agents a project can use. The agent is chosen when a project is created and cannot be changed. */
export const AGENTS = {
  claude: { id: 'claude', label: 'Claude', long: 'Claude (Anthropic API key)', billing: 'api' },
  kimi: { id: 'kimi', label: 'Kimi', long: 'Kimi Code CLI (your Kimi subscription)', billing: 'subscription' },
};
export const KIMI_EFFORTS = ['low', 'high', 'max'];

// Columns the owner may change after creation. "agent" is deliberately not here.
const COLUMNS = [
  'name', 'folder', 'task_prompt', 'model', 'effort', 'schedule', 'timezone', 'enabled', 'restore_mode',
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
  const agent = AGENTS[row.agent] ? row.agent : 'claude';
  const folder = resolveFolder(row.folder);
  return {
    ...row,
    folder,
    folder_in_app: Boolean(folder) && isInside(folder, PROJECTS_DIR),
    agent,
    schedule,
    enabled: Boolean(row.enabled),
    fresh_pending: Boolean(row.fresh_pending),
    // 1: the owner asked for a fresh session; 2: the previous session ended with a problem (see runner.js).
    fresh_after_failure: row.fresh_pending === 2,
  };
}

export function getProject(id) {
  return hydrate(db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id)));
}

export function listProjects() {
  return db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all().map(hydrate);
}

function serialize(key, value) {
  if (key === 'schedule') return JSON.stringify(value);
  if (key === 'folder') return storeFolder(value);
  if (key === 'enabled') return value ? 1 : 0;
  if (['fresh_every', 'turn_limit', 'max_minutes'].includes(key)) return value === '' || value == null ? null : Math.max(1, Math.round(Number(value)));
  if (key === 'budget_usd') return value === '' || value == null ? null : Math.max(0.01, Number(value));
  if (key === 'effort') return KIMI_EFFORTS.includes(value) ? value : null;
  return value == null || value === '' ? null : String(value);
}

export function createProject(data) {
  const agent = AGENTS[data.agent] ? data.agent : null;
  if (!agent) throw new Error('Choose which agent should work on the project.');
  const res = db
    .prepare(
      `INSERT INTO projects(name, folder, task_prompt, agent, model, effort, schedule, timezone, enabled, restore_mode, fresh_every, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.name || 'New project',
      storeFolder(data.folder),
      data.task_prompt ?? '',
      agent,
      data.model || null,
      agent === 'kimi' ? serialize('effort', data.effort ?? 'max') : null,
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

/**
 * Effective per-run limits: project overrides, else global defaults.
 * Kimi runs have no dollar budget (subscription); their model is resolved at run time when not set.
 */
export function effectiveLimits(project) {
  const kimi = project.agent === 'kimi';
  return {
    model: kimi ? project.model || null : project.model || getSetting('default_model'),
    effort: kimi ? project.effort || 'max' : null,
    maxTurns: project.turn_limit || getSetting('default_turn_limit'),
    budgetUsd: kimi ? null : project.budget_usd || getSetting('default_budget_usd'),
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
