import { Cron } from 'croner';
import { listProjects, getProject, budgetPaused, AGENTS } from './projects.js';
import { getSetting, setSetting } from './settings.js';
import { startRun, activeRunCount } from './runner.js';
import { emit } from './events.js';
import { db, checkpoint } from './db.js';

const jobs = new Map();
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Regular repeat intervals offered in the UI, in minutes. Each divides an hour or a day evenly, so the rhythm never drifts. */
export const INTERVAL_MINUTES = [15, 30, 60, 120, 180, 240, 360, 480, 720];

export function describeInterval(minutes) {
  if (minutes < 60) return `Every ${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? 'Every hour' : `Every ${hours} hours`;
}

/** The monthly API budget pause only applies to agents billed per use. */
function blockedByBudget(project) {
  return AGENTS[project.agent]?.billing === 'api' && budgetPaused();
}

function parseTime(time) {
  const m = String(time ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('Time must look like 09:30');
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Converts the plain-language schedule definition into a cron expression. */
export function scheduleToCron(schedule) {
  switch (schedule?.type) {
    case 'interval': {
      const minutes = Number(schedule.minutes);
      if (!INTERVAL_MINUTES.includes(minutes)) throw new Error('Choose how often it should repeat');
      if (minutes < 60) return `*/${minutes} * * * *`;
      return minutes === 60 ? '0 * * * *' : `0 */${minutes / 60} * * *`;
    }
    case 'hours': {
      const every = Math.round(Number(schedule.every));
      if (!(every >= 1 && every <= 24)) throw new Error('Hours must be between 1 and 24');
      const minute = Math.min(59, Math.max(0, Number(schedule.minute ?? 0) || 0));
      return every === 24 ? `${minute} 0 * * *` : `${minute} */${every} * * *`;
    }
    case 'daily': {
      const { hour, minute } = parseTime(schedule.time);
      return `${minute} ${hour} * * *`;
    }
    case 'weekdays': {
      const { hour, minute } = parseTime(schedule.time);
      const days = [...new Set((schedule.days ?? []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
      if (!days.length) throw new Error('Pick at least one weekday');
      return `${minute} ${hour} * * ${days.join(',')}`;
    }
    case 'cron':
      if (!schedule.expr?.trim()) throw new Error('Enter a cron expression');
      return schedule.expr.trim();
    default:
      throw new Error('Unknown schedule type');
  }
}

export function describeSchedule(schedule) {
  try {
    switch (schedule?.type) {
      case 'interval':
        return describeInterval(Number(schedule.minutes));
      case 'hours':
        return Number(schedule.every) === 1 ? 'Every hour' : `Every ${schedule.every} hours`;
      case 'daily':
        return `Every day at ${schedule.time}`;
      case 'weekdays':
        return `${(schedule.days ?? []).map((d) => DAY_NAMES[d]).join(', ')} at ${schedule.time}`;
      case 'cron':
        return `Custom: ${schedule.expr}`;
      default:
        return 'Not set';
    }
  } catch {
    return 'Invalid schedule';
  }
}

export function previewSchedule(schedule, timezone, count = 3) {
  const cron = new Cron(scheduleToCron(schedule), { timezone, paused: true });
  return cron.nextRuns(count).map((d) => d.toISOString());
}

export function nextRunFor(project) {
  if (!project.enabled || blockedByBudget(project)) return null;
  try {
    return previewSchedule(project.schedule, project.timezone, 1)[0] ?? null;
  } catch {
    return null;
  }
}

function fire(projectId) {
  const project = getProject(projectId);
  if (!project?.enabled || blockedByBudget(project)) return;
  try {
    console.log(`Scheduled run for project "${project.name}".`);
    startRun(projectId, 'schedule');
  } catch (err) {
    console.error(`Scheduled run for project ${projectId} failed to start:`, err.message);
  }
}

export function refreshSchedule(projectId) {
  projectId = Number(projectId);
  jobs.get(projectId)?.stop();
  jobs.delete(projectId);
  const project = getProject(projectId);
  if (!project?.enabled) return;
  try {
    const job = new Cron(scheduleToCron(project.schedule), { timezone: project.timezone }, () => fire(projectId));
    jobs.set(projectId, job);
  } catch (err) {
    console.error(`Invalid schedule for project ${projectId}:`, err.message);
  }
}

export function removeSchedule(projectId) {
  jobs.get(Number(projectId))?.stop();
  jobs.delete(Number(projectId));
}

/**
 * Returns the most recent scheduled time that was missed because the app was not running
 * (between the last moment the app was alive and now), or null.
 */
export function missedRunAt(schedule, timezone, lastAlive, now = new Date()) {
  if (!lastAlive) return null;
  try {
    const cron = new Cron(scheduleToCron(schedule), { timezone, paused: true });
    const previous = cron.previousRuns(1, now)[0];
    return previous && previous > new Date(lastAlive) ? previous : null;
  } catch {
    return null;
  }
}

/**
 * Starts all schedules. If the app was closed during a scheduled time, runs at most
 * one catch-up session per project (when the setting is on).
 */
export function startScheduler() {
  const lastAlive = getSetting('heartbeat');
  for (const project of listProjects()) {
    refreshSchedule(project.id);
    if (!project.enabled || !getSetting('catch_up_missed') || blockedByBudget(project)) continue;
    const missed = missedRunAt(project.schedule, project.timezone, lastAlive);
    if (!missed) continue;
    const ranSince = db.prepare('SELECT 1 FROM runs WHERE project_id = ? AND started_at >= ? LIMIT 1').get(project.id, missed.toISOString());
    if (ranSince) continue;
    console.log(`Project "${project.name}": a scheduled run was missed at ${missed.toISOString()} while the app was closed. Running once now.`);
    setTimeout(() => fire(project.id), 10_000);
  }
  const beat = () => {
    setSetting('heartbeat', new Date().toISOString());
    if (!activeRunCount()) checkpoint();
  };
  beat();
  setInterval(beat, 60_000).unref();
  emit('projects-changed', {});
}
