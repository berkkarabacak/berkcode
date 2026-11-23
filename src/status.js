// What the app is doing right now, in a few short lines, for the icon next to the clock (scripts/tray.ps1).
import fs from 'node:fs';
import { db } from './db.js';
import { getSetting } from './settings.js';
import { listProjects, budgetPaused } from './projects.js';
import { activeRunId } from './runner.js';
import { nextRunFor } from './scheduler.js';
import { kimiStatus, peekKimiStatus, kimiStatusAge } from './agents/kimiInfo.js';

export const APP_NAME = 'Claude Agent Runner';
/** Windows does not accept a longer text for a notification area icon. */
export const TOOLTIP_MAX = 63;

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const timeFormat = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });

/** "14:05", "tomorrow 09:00" or "Mon 09:00", in this computer's time zone. */
export function formatWhen(iso, now = new Date()) {
  const date = new Date(iso);
  const time = timeFormat.format(date);
  if (date.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${dayFormat.format(date)} ${time}`;
}

let lastKimiCheck = 0;
/** Kimi's readiness without making anyone wait: the last known state, refreshed in the background now and then. */
function kimiReadiness() {
  if (kimiStatusAge() > 30 * 60_000 && Date.now() - lastKimiCheck > 2 * 60_000) {
    lastKimiCheck = Date.now();
    kimiStatus({ refresh: true }).catch(() => {});
  }
  return peekKimiStatus();
}

/**
 * The app's state: "attention" (the owner needs to do something), "working" (a session is running) or "idle",
 * with a tooltip and menu lines ({ kind: attention | working | info, text }).
 * `kimi` replaces the Kimi readiness check (tests).
 */
export function trayStatus({ kimi, now = new Date() } = {}) {
  const projects = listProjects();
  const attention = [];
  const working = [];

  if (getSetting('db_recovered')) attention.push('The database was restored from a backup');
  const claudeProjects = projects.filter((p) => p.agent === 'claude');
  if (claudeProjects.length && !getSetting('api_key')) attention.push('No Claude API key is set');
  if (claudeProjects.some((p) => p.enabled) && budgetPaused()) attention.push('Monthly Claude budget cap reached');
  if (projects.some((p) => p.agent === 'kimi')) {
    const k = kimi === undefined ? kimiReadiness() : kimi;
    if (k && !k.installed) attention.push('Kimi Code CLI is not installed');
    else if (k && !k.loggedIn) attention.push(/did not respond/.test(k.message ?? '') ? 'Kimi Code CLI is not responding' : 'Kimi Code CLI is not logged in');
  }

  for (const p of projects) {
    const runId = activeRunId(p.id);
    if (runId) working.push({ name: p.name, since: db.prepare('SELECT started_at FROM runs WHERE id = ?').get(runId)?.started_at });
    if (!fs.existsSync(p.folder)) attention.push(`${p.name}: project folder not found`);
    else if (!p.enabled && p.consecutive_failures >= 3 && p.paused_reason) attention.push(`${p.name}: paused after 3 failed runs`);
  }

  const upcoming = projects
    .map((p) => ({ name: p.name, at: nextRunFor(p) }))
    .filter((x) => x.at)
    .sort((a, b) => a.at.localeCompare(b.at))[0];

  const lines = [
    ...working.map((w) => ({ kind: 'working', text: `Working on ${w.name}${w.since ? ` (since ${formatWhen(w.since, now)})` : ''}` })),
    ...attention.map((text) => ({ kind: 'attention', text })),
  ];
  if (!working.length) lines.push({ kind: 'info', text: upcoming ? `Next run: ${upcoming.name}, ${formatWhen(upcoming.at, now)}` : 'No schedule is on' });

  let tip;
  if (attention.length === 1) tip = attention[0];
  else if (attention.length > 1) tip = `${attention.length} things need your attention`;
  else if (working.length === 1) tip = `Working on ${working[0].name}`;
  else if (working.length > 1) tip = `Working on ${working.length} projects`;
  else if (upcoming) tip = `Next run ${formatWhen(upcoming.at, now)}`;
  else tip = 'Running, no schedule is on';

  return {
    state: attention.length ? 'attention' : working.length ? 'working' : 'idle',
    tooltip: clip(`${APP_NAME}\n${tip}`, TOOLTIP_MAX),
    lines: lines.slice(0, 8).map((l) => ({ ...l, text: clip(l.text.replace(/[\r\n\t]+/g, ' '), 90) })),
  };
}
