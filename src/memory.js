import fs from 'node:fs';
import path from 'node:path';
import { db, now, transaction } from './db.js';
import { redact } from './redact.js';
import { STANDARD_ENTRIES, STANDARD_DIRS } from './templates.js';

export const ROOT = '/memories';
const VIEW_CHAR_LIMIT = 16000;
const MAX_ENTRY_CHARS = 200_000;

export class MemoryError extends Error {}

/** Validates and normalises a memory path. Throws MemoryError for anything outside /memories. */
export function normalizePath(input) {
  if (typeof input !== 'string' || !input.trim()) throw new MemoryError('Error: A path is required.');
  let p = input.trim();
  let decoded = p;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    throw new MemoryError(`Error: Invalid path ${p}`);
  }
  if (decoded !== p && /\.\.|%2e|%2f|%5c/i.test(p)) throw new MemoryError(`Error: Invalid path ${p}`);
  if (p.includes('\\') || p.includes('\0')) throw new MemoryError(`Error: Invalid path ${p}. Use forward slashes.`);
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  if (p !== ROOT && !p.startsWith(ROOT + '/')) {
    throw new MemoryError(`Error: The path ${input} is outside the memory directory. All paths must start with ${ROOT}`);
  }
  const segments = p.split('/').slice(1);
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') throw new MemoryError(`Error: Invalid path ${input}`);
  }
  return p;
}

const q = {
  get: db.prepare('SELECT * FROM memory_entries WHERE project_id = ? AND path = ?'),
  list: db.prepare('SELECT * FROM memory_entries WHERE project_id = ? ORDER BY path'),
  under: db.prepare("SELECT * FROM memory_entries WHERE project_id = ? AND path LIKE ? ESCAPE '\\' ORDER BY path"),
  insert: db.prepare('INSERT INTO memory_entries(project_id, path, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
  update: db.prepare('UPDATE memory_entries SET content = ?, updated_at = ? WHERE id = ?'),
  rename: db.prepare('UPDATE memory_entries SET path = ?, updated_at = ? WHERE id = ?'),
  delete: db.prepare('DELETE FROM memory_entries WHERE id = ?'),
  history: db.prepare(
    'INSERT INTO memory_history(entry_id, project_id, path, previous_content, action, changed_at, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  historyFor: db.prepare(
    'SELECT id, entry_id, path, action, changed_at, changed_by, length(previous_content) AS size FROM memory_history WHERE project_id = ? AND path = ? ORDER BY id DESC LIMIT 200'
  ),
  historyById: db.prepare('SELECT * FROM memory_history WHERE id = ? AND project_id = ?'),
};

const likePrefix = (p) => p.replace(/[\\%_]/g, (c) => '\\' + c) + '/%';

export function getEntry(projectId, p) {
  return q.get.get(projectId, p) ?? null;
}

export function listEntries(projectId) {
  return q.list.all(projectId);
}

function entriesUnder(projectId, dir) {
  return q.under.all(projectId, likePrefix(dir));
}

function isDirectory(projectId, p) {
  if (p === ROOT || STANDARD_DIRS.includes(p)) return true;
  return entriesUnder(projectId, p).length > 0;
}

function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/**
 * A memory store bound to one project. `changedBy` is recorded in version history,
 * `onWrite` is called with each path that was written so runs can report it.
 */
export function memoryStore(projectId, { changedBy = 'owner', onWrite = () => {} } = {}) {
  const pid = Number(projectId);

  function writeContent(p, content, action) {
    content = redact(content ?? '');
    if (content.length > MAX_ENTRY_CHARS) {
      throw new MemoryError(`Error: Content for ${p} is too large (${content.length} characters, limit ${MAX_ENTRY_CHARS}). Split it into smaller entries.`);
    }
    const ts = now();
    const existing = getEntry(pid, p);
    transaction(() => {
      if (existing) {
        if (existing.content === content) return;
        q.history.run(existing.id, pid, p, existing.content, action, ts, changedBy);
        q.update.run(content, ts, existing.id);
      } else {
        const res = q.insert.run(pid, p, content, ts, ts);
        q.history.run(Number(res.lastInsertRowid), pid, p, null, 'create', ts, changedBy);
      }
    });
    onWrite(p);
  }

  function requireFile(p, message) {
    const entry = getEntry(pid, p);
    if (!entry) throw new MemoryError(message ?? `Error: The path ${p} does not exist`);
    return entry;
  }

  function view(rawPath, viewRange) {
    const p = normalizePath(rawPath ?? ROOT);
    const entry = getEntry(pid, p);
    if (entry) {
      const lines = entry.content.replace(/\n$/, '').split('\n');
      if (lines.length > 999_999) throw new MemoryError(`File ${p} exceeds maximum line limit of 999,999 lines.`);
      let start = 1;
      let end = lines.length;
      if (Array.isArray(viewRange) && viewRange.length === 2) {
        start = Math.max(1, Number(viewRange[0]) || 1);
        end = Number(viewRange[1]) === -1 ? lines.length : Math.min(lines.length, Number(viewRange[1]) || lines.length);
      }
      let body = '';
      let truncatedAt = null;
      for (let i = start; i <= end; i++) {
        const line = `${String(i).padStart(6, ' ')}\t${lines[i - 1]}\n`;
        if (body.length + line.length > VIEW_CHAR_LIMIT) {
          truncatedAt = i;
          break;
        }
        body += line;
      }
      let text = `Here's the content of ${p} with line numbers:\n${body.replace(/\n$/, '')}`;
      if (truncatedAt) text += `\n[Output truncated at line ${truncatedAt}. Use view_range [${truncatedAt}, -1] to read the rest.]`;
      return text;
    }
    if (isDirectory(pid, p)) {
      const children = entriesUnder(pid, p);
      const depthOf = (child) => child.slice(p.length + 1).split('/').length;
      const lines = [];
      const dirs = new Map();
      for (const dir of STANDARD_DIRS) if (dir.startsWith(p + '/') && depthOf(dir) <= 2) dirs.set(dir, 0);
      for (const child of children) {
        const rel = child.path.slice(p.length + 1).split('/');
        const size = Buffer.byteLength(child.content);
        for (let i = 1; i < rel.length && i <= 2; i++) {
          const dirPath = `${p}/${rel.slice(0, i).join('/')}`;
          dirs.set(dirPath, (dirs.get(dirPath) ?? 0) + size);
        }
        if (rel.length <= 2) lines.push([child.path, sizeLabel(size)]);
      }
      for (const [dirPath, size] of dirs) lines.push([dirPath, sizeLabel(size)]);
      lines.sort((a, b) => a[0].localeCompare(b[0]));
      const total = children.reduce((sum, c) => sum + Buffer.byteLength(c.content), 0);
      const listing = [`${sizeLabel(total)}\t${p}`, ...lines.map(([lp, s]) => `${s}\t${lp}`)];
      return `Here're the files and directories up to 2 levels deep in ${p}, excluding hidden items and node_modules:\n${listing.join('\n')}`;
    }
    throw new MemoryError(`The path ${p} does not exist. Please provide a valid path.`);
  }

  function create(rawPath, fileText) {
    const p = normalizePath(rawPath);
    if (p === ROOT || (!getEntry(pid, p) && isDirectory(pid, p))) throw new MemoryError(`Error: ${p} is a directory`);
    writeContent(p, fileText ?? '', 'create');
    return `File created successfully at: ${p}`;
  }

  function strReplace(rawPath, oldStr, newStr) {
    const p = normalizePath(rawPath);
    const entry = requireFile(p, `Error: The path ${p} does not exist. Please provide a valid path.`);
    if (typeof oldStr !== 'string' || oldStr === '') throw new MemoryError('Error: old_str is required.');
    const content = entry.content;
    const positions = [];
    for (let i = content.indexOf(oldStr); i !== -1; i = content.indexOf(oldStr, i + 1)) positions.push(i);
    if (positions.length === 0) {
      throw new MemoryError(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${p}.`);
    }
    if (positions.length > 1) {
      const lineNos = positions.map((pos) => content.slice(0, pos).split('\n').length);
      throw new MemoryError(
        `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lineNos.join(', ')}. Please ensure it is unique`
      );
    }
    const updated = content.slice(0, positions[0]) + (newStr ?? '') + content.slice(positions[0] + oldStr.length);
    writeContent(p, updated, 'str_replace');
    const editLine = updated.slice(0, positions[0]).split('\n').length;
    const lines = updated.split('\n');
    const from = Math.max(1, editLine - 3);
    const to = Math.min(lines.length, editLine + (newStr ?? '').split('\n').length + 3);
    const snippet = lines
      .slice(from - 1, to)
      .map((l, i) => `${String(from + i).padStart(6, ' ')}\t${l}`)
      .join('\n');
    return `The memory file has been edited.\n${snippet}`;
  }

  function insert(rawPath, insertLine, insertText) {
    const p = normalizePath(rawPath);
    const entry = requireFile(p);
    const lines = entry.content === '' ? [] : entry.content.replace(/\n$/, '').split('\n');
    const n = Number(insertLine);
    if (!Number.isInteger(n) || n < 0 || n > lines.length) {
      throw new MemoryError(`Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`);
    }
    lines.splice(n, 0, String(insertText ?? '').replace(/\n$/, ''));
    writeContent(p, lines.join('\n') + '\n', 'insert');
    return `The file ${p} has been edited.`;
  }

  function remove(rawPath) {
    const p = normalizePath(rawPath);
    if (p === ROOT) throw new MemoryError('Error: The memory root directory /memories cannot be deleted.');
    const entry = getEntry(pid, p);
    const targets = entry ? [entry] : entriesUnder(pid, p);
    if (targets.length === 0) {
      if (STANDARD_DIRS.includes(p)) return `Successfully deleted ${p}`;
      throw new MemoryError(`Error: The path ${p} does not exist`);
    }
    const ts = now();
    transaction(() => {
      for (const t of targets) {
        q.history.run(t.id, pid, t.path, t.content, 'delete', ts, changedBy);
        q.delete.run(t.id);
      }
    });
    targets.forEach((t) => onWrite(t.path));
    return `Successfully deleted ${p}`;
  }

  function rename(rawOld, rawNew) {
    const oldPath = normalizePath(rawOld);
    const newPath = normalizePath(rawNew);
    if (oldPath === ROOT) throw new MemoryError('Error: The memory root directory /memories cannot be renamed.');
    if (newPath === ROOT || newPath.startsWith(oldPath + '/')) throw new MemoryError(`Error: Cannot rename ${oldPath} to ${newPath}`);
    if (getEntry(pid, newPath) || isDirectory(pid, newPath)) throw new MemoryError(`Error: The destination ${newPath} already exists`);
    const entry = getEntry(pid, oldPath);
    const targets = entry ? [entry] : entriesUnder(pid, oldPath);
    if (targets.length === 0) throw new MemoryError(`Error: The path ${oldPath} does not exist`);
    const ts = now();
    transaction(() => {
      for (const t of targets) {
        const dest = newPath + t.path.slice(oldPath.length);
        q.history.run(t.id, pid, t.path, t.content, `rename → ${dest}`, ts, changedBy);
        q.rename.run(dest, ts, t.id);
        q.history.run(t.id, pid, dest, null, `rename ← ${t.path}`, ts, changedBy);
      }
    });
    targets.forEach((t) => {
      onWrite(t.path);
      onWrite(newPath + t.path.slice(oldPath.length));
    });
    return `Successfully renamed ${oldPath} to ${newPath}`;
  }

  /** Executes one memory tool command. Returns { text, isError }. */
  function execute(input = {}) {
    try {
      let text;
      switch (input.command) {
        case 'view':
          text = view(input.path, input.view_range);
          break;
        case 'create':
          text = create(input.path, input.file_text);
          break;
        case 'str_replace':
          text = strReplace(input.path, input.old_str, input.new_str);
          break;
        case 'insert':
          text = insert(input.path, input.insert_line, input.insert_text);
          break;
        case 'delete':
          text = remove(input.path);
          break;
        case 'rename':
          text = rename(input.old_path, input.new_path);
          break;
        default:
          throw new MemoryError(`Error: Unknown command ${input.command}. Valid commands: view, create, str_replace, insert, delete, rename.`);
      }
      return { text, isError: false };
    } catch (err) {
      if (err instanceof MemoryError) return { text: err.message, isError: true };
      return { text: `Error: ${err.message}`, isError: true };
    }
  }

  function search(query, limit = 20) {
    return searchMemory(pid, query, limit);
  }

  function save(rawPath, content) {
    const p = normalizePath(rawPath);
    if (p === ROOT) throw new MemoryError('Error: Cannot write to the memory root.');
    writeContent(p, content, 'edit');
  }

  function restoreVersion(historyId) {
    const h = q.historyById.get(historyId, pid);
    if (!h) throw new MemoryError('Version not found.');
    if (h.previous_content == null) {
      remove(h.path);
      return h.path;
    }
    writeContent(h.path, h.previous_content, `restore #${historyId}`);
    return h.path;
  }

  return { execute, view, create, strReplace, insert, remove, rename, search, save, restoreVersion };
}

export function searchMemory(projectId, query, limit = 20) {
  const terms = String(query ?? '')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean);
  if (terms.length === 0) return [];
  const match = terms.map((t) => `"${t}"*`).join(' ');
  try {
    return db
      .prepare(
        `SELECT e.path, snippet(memory_fts, 1, '«', '»', '…', 16) AS snippet, e.updated_at
         FROM memory_fts JOIN memory_entries e ON e.id = memory_fts.rowid
         WHERE memory_fts MATCH ? AND e.project_id = ?
         ORDER BY rank LIMIT ?`
      )
      .all(match, Number(projectId), limit);
  } catch {
    const like = `%${terms.join(' ')}%`;
    return db
      .prepare('SELECT path, substr(content, 1, 200) AS snippet, updated_at FROM memory_entries WHERE project_id = ? AND content LIKE ? LIMIT ?')
      .all(Number(projectId), like, limit);
  }
}

export function entryHistory(projectId, p) {
  return q.historyFor.all(Number(projectId), normalizePath(p));
}

export function historyVersion(projectId, historyId) {
  return q.historyById.get(Number(historyId), Number(projectId)) ?? null;
}

export function ensureStandardEntries(projectId, changedBy = 'app') {
  const store = memoryStore(projectId, { changedBy });
  for (const [p, content] of Object.entries(STANDARD_ENTRIES)) {
    if (!getEntry(projectId, p)) store.save(p, content);
  }
}

export function exportMemory(projectId, folder) {
  const entries = listEntries(projectId);
  for (const e of entries) {
    const target = path.join(folder, ...e.path.slice(ROOT.length + 1).split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.content, 'utf8');
  }
  return entries.length;
}

export function importMemory(projectId, folder) {
  const store = memoryStore(projectId, { changedBy: 'owner (import)' });
  let count = 0;
  const walk = (dir, rel) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      const full = path.join(dir, item.name);
      const relPath = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) walk(full, relPath);
      else if (/\.(md|txt|markdown|json|ya?ml)$/i.test(item.name)) {
        store.save(`${ROOT}/${relPath}`, fs.readFileSync(full, 'utf8'));
        count++;
      }
    }
  };
  walk(folder, '');
  return count;
}

/** Splits progress.md into dated sections (## headings), in file order. */
export function parseProgress(content) {
  const sections = [];
  let current = null;
  for (const line of (content ?? '').split('\n')) {
    if (/^##\s+/.test(line)) {
      current = { title: line.replace(/^##\s+/, '').trim(), body: '' };
      sections.push(current);
    } else if (current) {
      current.body += line + '\n';
    }
  }
  return sections.map((s) => ({ ...s, body: s.body.trim() }));
}

/** Parses plan.md into steps. Status markers: ' ' todo, '~' in progress, 'x' done, '!' blocked. */
export function parsePlan(content) {
  const steps = [];
  for (const line of (content ?? '').split('\n')) {
    const m = line.match(/^\s*[-*]\s+\[([ xX~!])\]\s+(.*)$/);
    if (m) {
      const mark = m[1].toLowerCase();
      steps.push({ status: mark === 'x' ? 'done' : mark === '~' ? 'in_progress' : mark === '!' ? 'blocked' : 'todo', text: m[2] });
    }
  }
  return steps;
}
