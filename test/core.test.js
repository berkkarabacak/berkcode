import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-core-'));
process.env.RUNNER_DATA_DIR = path.join(tmp, 'data');
after(async () => {
  try {
    (await import('../src/db.js')).db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* the database may still be open on Windows */
  }
});

const { createRestorePoint, restoreFolder, restorePointAvailable, fingerprintFolder, diffFingerprints } = await import('../src/restorePoints.js');
const { extractKey } = await import('../src/keyfile.js');
const { missedRunAt, scheduleToCron, previewSchedule } = await import('../src/scheduler.js');
const { getSetting, setSetting, publicSettings } = await import('../src/settings.js');
const { buildBrief } = await import('../src/templates.js');
const { redact } = await import('../src/redact.js');

function write(root, rel, text) {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

test('zip restore point round trip, with non-English names and ignored folders', async () => {
  const folder = path.join(tmp, 'Proje Klasörü');
  write(folder, 'index.html', '<h1>v1</h1>');
  write(folder, 'css/style.css', 'body{}');
  write(folder, 'notlar/öğrenci çalışması.md', 'ilk sürüm');
  write(folder, 'node_modules/pkg/index.js', 'ignored');

  const ref = await createRestorePoint({ id: 7, folder, restore_mode: 'zip' }, 1, 500);
  assert.equal(ref.type, 'zip', JSON.stringify(ref));
  assert.equal(ref.files, 3);
  assert.ok(restorePointAvailable(ref));

  const before = fingerprintFolder(folder);
  write(folder, 'index.html', '<h1>v2 changed by the agent</h1>');
  write(folder, 'new-page.html', 'new');
  fs.rmSync(path.join(folder, 'css'), { recursive: true });
  const diff = diffFingerprints(before, fingerprintFolder(folder));
  assert.deepEqual(diff.added, ['new-page.html']);
  assert.deepEqual(diff.changed, ['index.html']);
  assert.deepEqual(diff.removed, ['css/style.css']);

  const { problems } = await restoreFolder(folder, ref);
  assert.deepEqual(problems, []);
  assert.equal(fs.readFileSync(path.join(folder, 'index.html'), 'utf8'), '<h1>v1</h1>');
  assert.equal(fs.readFileSync(path.join(folder, 'css', 'style.css'), 'utf8'), 'body{}');
  assert.equal(fs.readFileSync(path.join(folder, 'notlar', 'öğrenci çalışması.md'), 'utf8'), 'ilk sürüm');
  assert.ok(!fs.existsSync(path.join(folder, 'new-page.html')));
  assert.ok(fs.existsSync(path.join(folder, 'node_modules', 'pkg', 'index.js')), 'ignored folders are left alone');
});

test('only the last 5 zip restore points are kept', async () => {
  const folder = path.join(tmp, 'rotate');
  write(folder, 'a.txt', 'a');
  const refs = [];
  for (let run = 10; run < 17; run++) refs.push(await createRestorePoint({ id: 8, folder, restore_mode: 'zip' }, run, 500));
  assert.equal(refs.filter(restorePointAvailable).length, 5);
  assert.ok(!restorePointAvailable(refs[0]));
  assert.ok(restorePointAvailable(refs[6]));
});

test('restore point is skipped (not failed) above the size limit', async () => {
  const folder = path.join(tmp, 'big');
  write(folder, 'big.bin', Buffer.alloc(11 * 1024 * 1024));
  const ref = await createRestorePoint({ id: 9, folder, restore_mode: 'zip' }, 1, 10);
  assert.equal(ref.type, 'none');
  assert.match(ref.warning, /backup limit/);
});

test('API key extraction from a key file', () => {
  const key = 'sk-ant-test-AbC_dEf-000000000fake';
  assert.equal(extractKey(key), key);
  assert.equal(extractKey(`\ufeff  ${key}\r\n`), key);
  assert.equal(extractKey(`ANTHROPIC_API_KEY="${key}"`), key);
  assert.equal(extractKey('nothing here'), null);
});

test('missed scheduled runs are detected only when the app was closed at the time', () => {
  const schedule = { type: 'daily', time: '09:00' };
  const tz = 'Europe/Istanbul';
  // App last alive at 08:00, now 10:00 (Istanbul = UTC+3) -> the 09:00 run was missed.
  const missed = missedRunAt(schedule, tz, '2026-11-20T05:00:00Z', new Date('2026-11-20T07:00:00Z'));
  assert.equal(missed?.toISOString(), '2026-11-20T06:00:00.000Z');
  // App alive until 09:30 -> nothing missed.
  assert.equal(missedRunAt(schedule, tz, '2026-11-20T06:30:00Z', new Date('2026-11-20T07:00:00Z')), null);
  // First start ever -> no catch-up.
  assert.equal(missedRunAt(schedule, tz, '', new Date()), null);
});

test('schedule definitions become cron expressions', () => {
  assert.equal(scheduleToCron({ type: 'daily', time: '09:05' }), '5 9 * * *');
  assert.equal(scheduleToCron({ type: 'hours', every: 6 }), '0 */6 * * *');
  assert.equal(scheduleToCron({ type: 'weekdays', days: [5, 1, 3], time: '18:30' }), '30 18 * * 1,3,5');
  assert.throws(() => scheduleToCron({ type: 'weekdays', days: [], time: '18:30' }));
  assert.throws(() => scheduleToCron({ type: 'daily', time: '25:00' }));
  assert.equal(previewSchedule({ type: 'daily', time: '09:00' }, 'Europe/Istanbul', 3).length, 3);
});

test('settings are validated and the key is never public', () => {
  setSetting('port', 'abc');
  assert.equal(getSetting('port'), 4280);
  setSetting('monthly_cap_usd', 0);
  assert.equal(getSetting('monthly_cap_usd'), 1);
  setSetting('api_key', 'sk-ant-test-fakesecretfakesecret');
  const pub = JSON.stringify(publicSettings());
  assert.doesNotMatch(pub, /fakesecret/);
  assert.match(redact('error with sk-ant-test-fakesecretfakesecret inside'), /REDACTED/);
});

test('plain-language descriptions become a brief', () => {
  const brief = buildBrief('A personal website with my hobbies.');
  assert.match(brief, /^# Project brief/);
  assert.match(brief, /## Goal\nA personal website with my hobbies\./);
  assert.match(brief, /## Standing rules/);
  assert.equal(buildBrief('# My own brief\n\nText'), '# My own brief\n\nText\n');
});
