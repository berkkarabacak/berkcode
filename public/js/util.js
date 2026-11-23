// Shared helpers for the browser UI: DOM, API calls, formatting, dialogs and icons.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

if (window.marked) {
  window.marked.use({ renderer: { html: (token) => esc(token.text ?? token.raw ?? '') } });
}
export const md = (s) => (window.marked ? tidyLinks(window.marked.parse(String(s ?? ''))) : `<pre>${esc(s)}</pre>`);

/**
 * Text written by the agent may contain links and images. Only web and mail links stay clickable, and they open in
 * a new tab, so the app's page never navigates away (to a project file such as "css/site.css", or to script code).
 * Images that are not on the web are shown as their description.
 */
function tidyLinks(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  for (const a of t.content.querySelectorAll('a')) {
    if (/^(https?:|mailto:)/i.test((a.getAttribute('href') ?? '').trim())) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else {
      a.removeAttribute('href');
    }
  }
  for (const img of t.content.querySelectorAll('img')) {
    if (!/^https?:/i.test((img.getAttribute('src') ?? '').trim())) img.replaceWith(img.getAttribute('alt') ?? '');
  }
  return t.innerHTML;
}

/** Shared UI state. */
export const state = {
  settings: null,
  budgetPaused: false,
  monthCost: 0,
  route: null,
  project: null,
  projects: [],
  models: null,
  memory: null,
  memorySection: 'brief',
  editing: false,
  drafts: {},
};

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toast-root').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

export async function attempt(fn, success) {
  try {
    const r = await fn();
    if (success) toast(success);
    return r;
  } catch (err) {
    toast(err.message, 'error');
    return undefined;
  }
}

// ---------- Formatting ----------

export const fmtTime = (iso, tz) => {
  if (!iso) return '—';
  const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  if (tz) opts.timeZone = tz;
  try {
    return new Date(iso).toLocaleString(undefined, opts);
  } catch {
    return new Date(iso).toLocaleString();
  }
};
export const fmtClock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fmtCost = (v) => (v == null ? '—' : `$${Number(v).toFixed(v < 1 ? 3 : 2)}`);
export const fmtDuration = (ms) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
export const timeAgo = (iso) => {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  return `${Math.round(diff / 86400)} days ago`;
};
/** "now", "5m", "3h", "2d" for the sidebar. */
export const shortAgo = (iso) => {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  return `${Math.round(diff / 86400)}d`;
};

export const agentLabel = (agent) => (agent === 'kimi' ? 'Kimi' : 'Claude');
export const agentBadge = (agent) => `<span class="agent-badge ${agent === 'kimi' ? 'kimi' : 'claude'}">${agentLabel(agent)}</span>`;
/** Kimi runs are covered by the subscription, so they show no dollar cost. */
export const runCost = (agent, value) => (agent === 'kimi' ? 'Subscription' : fmtCost(value));
export const statusChip = (s) => `<span class="status ${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;

// ---------- Dialogs ----------

export function modal(html, onMount) {
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

export function confirmModal(title, message, confirmLabel = 'Confirm', danger = true, cancelLabel = 'Cancel') {
  return new Promise((resolve) => {
    modal(
      `<h2>${esc(title)}</h2><p>${message}</p>
       <div class="row" style="justify-content:flex-end"><button data-close>${esc(cancelLabel)}</button>
       <button class="${danger ? 'danger' : 'primary'}" id="confirm-yes">${esc(confirmLabel)}</button></div>`,
      (el, close) => {
        $('[data-close]', el).addEventListener('click', () => resolve(false));
        $('.modal-backdrop')?.addEventListener('click', (e) => e.target.classList.contains('modal-backdrop') && resolve(false));
        $('#confirm-yes', el).addEventListener('click', () => {
          close();
          resolve(true);
        });
      }
    );
  });
}

// ---------- Icons (simple line icons, 24px grid) ----------

const PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  send: '<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  undo: '<path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.6-6.4L3 9.5"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
  terminal: '<path d="M4 17l6-6-6-6M12 19h8"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  spark: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
};

export const icon = (name, size = 16) =>
  `<svg class="ic ic-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ''}</svg>`;

/** The round mark shown next to the agent's messages. */
export const agentAvatar = (agent) =>
  agent === 'kimi'
    ? '<span class="avatar kimi" aria-hidden="true">K</span>'
    : `<span class="avatar claude" aria-hidden="true">${icon('spark', 14)}</span>`;
