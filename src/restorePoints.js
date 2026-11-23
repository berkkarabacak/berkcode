import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { BACKUP_DIR, TMP_DIR } from './paths.js';

const execFileAsync = promisify(execFile);
const KEEP_BACKUPS = 5;

/** Folders that are skipped by zip backups and change tracking (dependencies, caches, VCS data). */
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.turbo', '.cache',
  '.gradle', '.tox', '.mypy_cache', '.pytest_cache', 'bower_components', '.parcel-cache', '.svelte-kit',
]);

const STORED_EXTENSIONS = /\.(zip|png|jpe?g|gif|webp|avif|mp4|mov|mp3|ogg|gz|tgz|7z|rar|woff2?|pdf)$/i;

function walk(root, onFile) {
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let items;
    try {
      items = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      const relPath = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (!IGNORED_DIRS.has(item.name)) stack.push(relPath);
      } else if (item.isFile()) {
        onFile(relPath, path.join(root, relPath));
      }
    }
  }
}

/** Size + modification time of every file (outside ignored folders), used to list what a run changed. */
export function fingerprintFolder(folder) {
  const map = new Map();
  walk(folder, (rel, full) => {
    try {
      const stat = fs.statSync(full);
      map.set(rel, `${stat.size}:${Math.round(stat.mtimeMs)}`);
    } catch {
      /* file vanished or is locked */
    }
  });
  return map;
}

export function diffFingerprints(before, after) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [file, print] of after) {
    if (!before.has(file)) added.push(file);
    else if (before.get(file) !== print) changed.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) removed.push(file);
  return { added: added.sort(), changed: changed.sort(), removed: removed.sort() };
}

/** Every file of a folder outside the ignored folders: { files: [{ rel, full, size, mtime }], total }. */
export function listFiles(folder) {
  const files = [];
  let total = 0;
  walk(folder, (rel, full) => {
    try {
      const stat = fs.statSync(full);
      files.push({ rel, full, size: stat.size, mtime: stat.mtime });
      total += stat.size;
    } catch {
      /* ignore */
    }
  });
  return { files, total };
}

async function git(folder, args) {
  const { stdout } = await execFileAsync('git', ['-C', folder, ...args], { windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(folder) {
  try {
    return (await git(folder, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

async function createGitRestorePoint(folder, label) {
  await git(folder, ['add', '-A']);
  await git(folder, [
    '-c', 'user.name=Claude Agent Runner', '-c', 'user.email=agent-runner@localhost',
    'commit', '--allow-empty', '--no-verify', '-m', `Restore point: ${label}`,
  ]);
  return { type: 'git', commit: await git(folder, ['rev-parse', 'HEAD']) };
}

async function createZipRestorePoint(projectId, runId, folder, sizeLimitMb) {
  const { files, total } = listFiles(folder);
  if (total > sizeLimitMb * 1024 * 1024) {
    return {
      type: 'none',
      warning: `The project folder is ${(total / 1024 / 1024).toFixed(0)} MB, above the ${sizeLimitMb} MB backup limit (dependency folders such as node_modules are already left out). No restore point was made for this run. You can raise the limit in Settings.`,
    };
  }
  const projectDir = path.join(BACKUP_DIR, `project-${projectId}`);
  fs.mkdirSync(projectDir, { recursive: true });
  const name = `run-${String(runId).padStart(6, '0')}.zip`;
  const target = path.join(projectDir, name);
  const partial = `${target}.partial`;

  const zip = new yazl.ZipFile();
  const skipped = [];
  for (const f of files) {
    try {
      fs.closeSync(fs.openSync(f.full, 'r'));
    } catch {
      skipped.push(f.rel);
      continue;
    }
    zip.addFile(f.full, f.rel, { mtime: f.mtime, compress: !STORED_EXTENSIONS.test(f.rel) });
  }
  zip.end();
  try {
    await pipeline(zip.outputStream, fs.createWriteStream(partial));
    fs.renameSync(partial, target);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }

  const zips = fs.readdirSync(projectDir).filter((f) => /^run-\d+\.zip$/.test(f)).sort();
  for (const old of zips.slice(0, Math.max(0, zips.length - KEEP_BACKUPS))) fs.rmSync(path.join(projectDir, old), { force: true });

  const ref = { type: 'zip', name: `project-${projectId}/${name}`, files: files.length - skipped.length };
  if (skipped.length) ref.warning = `${skipped.length} file(s) were in use and are not in the restore point: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ', …' : ''}`;
  return ref;
}

/** Takes a restore point of the project folder. Never throws: a failure is returned as a warning. */
export async function createRestorePoint(project, runId, sizeLimitMb) {
  try {
    if (project.restore_mode === 'git' && (await isGitRepo(project.folder))) {
      return await createGitRestorePoint(project.folder, `before run #${runId}`);
    }
    return await createZipRestorePoint(project.id, runId, project.folder, sizeLimitMb);
  } catch (err) {
    return { type: 'none', warning: `The restore point could not be created (${err.message}). The run continues without one.` };
  }
}

function zipPathFor(ref) {
  if (ref?.type !== 'zip') return null;
  if (ref.name) return path.join(BACKUP_DIR, ...ref.name.split('/'));
  return ref.file ?? null;
}

export function restorePointAvailable(ref) {
  if (!ref) return false;
  if (ref.type === 'git') return true;
  const file = zipPathFor(ref);
  return Boolean(file && fs.existsSync(file));
}

function removeEmptyDirs(dir, isRoot = true) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    if (item.isDirectory() && !IGNORED_DIRS.has(item.name)) removeEmptyDirs(path.join(dir, item.name), false);
  }
  try {
    if (!isRoot && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* in use */
  }
}

async function extractZip(zipPath, dest) {
  const zipfile = await yauzl.openPromise(zipPath);
  const names = [];
  try {
    for await (const entry of zipfile.eachEntry()) {
      if (/\/$/.test(entry.fileName)) continue;
      const target = path.join(dest, ...entry.fileName.split('/'));
      if (!path.resolve(target).startsWith(path.resolve(dest) + path.sep)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await pipeline(await zipfile.openReadStreamPromise(entry), fs.createWriteStream(target));
      if (entry.getLastModDate) {
        try {
          const d = entry.getLastModDate();
          fs.utimesSync(target, d, d);
        } catch {
          /* ignore */
        }
      }
      names.push(entry.fileName);
    }
  } finally {
    zipfile.close();
  }
  return names;
}

/**
 * Puts the project folder back to the state saved in the restore point. The zip is first
 * extracted to a staging folder, so a damaged zip never leaves the project half-restored.
 * Returns a list of files that could not be replaced (for example because they are open).
 */
export async function restoreFolder(folder, ref) {
  if (ref?.type === 'git') {
    await git(folder, ['reset', '--hard', ref.commit]);
    await git(folder, ['clean', '-fd']);
    return { problems: [] };
  }
  const zipPath = zipPathFor(ref);
  if (!zipPath || !fs.existsSync(zipPath)) throw new Error('This run has no restore point any more (only the last 5 are kept).');

  const staging = path.join(TMP_DIR, `restore-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  const problems = [];
  try {
    const names = new Set(await extractZip(zipPath, staging));
    walk(folder, (rel, full) => {
      if (names.has(rel)) return;
      try {
        fs.rmSync(full, { force: true });
      } catch {
        problems.push(rel);
      }
    });
    removeEmptyDirs(folder);
    walk(staging, (rel, full) => {
      const target = path.join(folder, ...rel.split('/'));
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(full, target);
        const stat = fs.statSync(full);
        fs.utimesSync(target, stat.atime, stat.mtime);
      } catch {
        problems.push(rel);
      }
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { problems };
}
