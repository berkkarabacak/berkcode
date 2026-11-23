// "Share the app with family and friends": the ZIP for another computer, and the settings a copy brings along.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-share-'));
process.env.RUNNER_DATA_DIR = path.join(tmp, 'data');

const { listAppFiles, writeShareCopy, applyCopySettings } = await import('../src/shareCopy.js');
const { getSetting, setSetting, publicSettings } = await import('../src/settings.js');
const { db } = await import('../src/db.js');

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A pretend app folder: the app's own files, next to everything that must stay out of a copy.
const app = path.join(tmp, 'app');
const put = (rel, text = 'x') => {
  const file = path.join(app, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const OWN = ['README.md', 'package-lock.json', 'package.json', 'public/index.html', 'public/js/chat.js', 'scripts/start.ps1', 'src/server.js', 'start.bat', 'test/data/sample.txt'];
for (const rel of OWN) put(rel);
for (const rel of [
  'data/app.db', 'projects/My site/index.html', 'runtime/node/node.exe', 'node_modules/express/index.js', 'src/node_modules/x.js',
  '.git/HEAD', 'claudeapi.key', 'API.key', 'claudeapi.txt', 'copy-settings.json', 'server.log', 'Claude Agent Runner.zip', 'START HERE.txt',
]) put(rel, 'secret');

function zipEntries(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const entries = new Map();
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(entries));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

test("a copy holds the app itself, never the owner's data, projects, downloads or keys", () => {
  assert.deepEqual(listAppFiles(app).map((f) => f.rel).sort(), [...OWN].sort());
});

test('the ZIP brings the key and the settings for the new computer only when asked', async () => {
  const target = path.join(tmp, 'with-key.zip');
  const r = await writeShareCopy(target, { root: app, key: 'sk-ant-test-0123456789abcdef', settings: { monthly_cap_usd: 20, api_key: 'not allowed' } });
  assert.equal(r.files, OWN.length);
  const entries = await zipEntries(target);
  assert.equal(entries.get('claudeapi.key').trim(), 'sk-ant-test-0123456789abcdef');
  assert.deepEqual(JSON.parse(entries.get('copy-settings.json')), { monthly_cap_usd: 20 });
  assert.match(entries.get('START HERE.txt'), /Claude is already set up/);
  // The files sit at the top, so "Extract All" gives a folder with start.bat in it.
  assert.ok(entries.has('start.bat') && entries.has('src/server.js') && entries.has('package-lock.json'));
  assert.ok(![...entries.keys()].some((n) => /^(data|projects|runtime|\.git)\/|node_modules\/|API\.key|server\.log|\.zip$/.test(n)));
  assert.ok(![...entries.values()].includes('secret'), 'nothing from the left-out files');

  const plain = path.join(tmp, 'plain.zip');
  await writeShareCopy(plain, { root: app, settings: { monthly_cap_usd: null } });
  const without = await zipEntries(plain);
  assert.ok(!without.has('claudeapi.key'));
  assert.ok(!without.has('copy-settings.json'));
  assert.match(without.get('START HERE.txt'), /paste a Claude API key/);
});

test('a copy applies its settings once, at its first start; later changes on that computer stay', () => {
  fs.writeFileSync(path.join(app, 'copy-settings.json'), JSON.stringify({ monthly_cap_usd: 20 }));
  assert.equal(getSetting('monthly_cap_usd'), 100);
  assert.deepEqual(applyCopySettings(app), ['monthly_cap_usd']);
  assert.equal(getSetting('monthly_cap_usd'), 20);
  setSetting('monthly_cap_usd', 35); // changed on that computer later
  assert.equal(applyCopySettings(app), null);
  assert.equal(getSetting('monthly_cap_usd'), 35);
  assert.ok(!('copy_settings_hash' in publicSettings()), 'the marker is not sent to the browser');
  fs.rmSync(path.join(app, 'copy-settings.json'));
  assert.equal(applyCopySettings(app), null, 'no file, nothing to do');
});
