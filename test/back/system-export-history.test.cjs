const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');
const { ScriptHistory } = load('back/shared/scriptHistory.ts', {
  '../config/util': {},
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-history-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataPath = path.join(root, 'data');
  for (const dir of ['db', 'upload', 'scripts'])
    await fs.mkdir(path.join(dataPath, dir), { recursive: true });
  const archive = path.join(root, 'backup.tgz');
  const Service = load('back/services/system.ts', {
    '../config': { dataPath, dataTgzFile: archive },
    '../config/const': {},
    '../config/util': {},
    '../data/dependence': {},
    '../data/notify': {},
    '../data/system': {},
    '../shared/pLimit': {},
    '../schedule/client': {},
    '../shared/i18n': { t: (x) => x },
    './notify': class {},
    './schedule': class {},
    './sock': class {},
  }).default;
  const service = new Service({}, {}, {});
  let downloaded, status, error;
  const res = {
    download: (file) => {
      downloaded = file;
    },
    status: (code) => {
      status = code;
      return res;
    },
    send: (value) => {
      error = value;
      return res;
    },
  };
  const exportData = async (types) => {
    downloaded = status = error = undefined;
    await service.exportData(res, types);
    return { downloaded, status, error };
  };
  return { root, dataPath, archive, exportData };
}

test('a scripts backup preserves history versions and they remain readable and restorable after extraction', async (t) => {
  const f = await fixture(t);
  const scripts = path.join(f.dataPath, 'scripts');
  const historyRoot = path.join(f.dataPath, 'script-history');
  await fs.writeFile(path.join(scripts, 'history.js'), 'baseline');
  const history = new ScriptHistory(scripts, historyRoot);
  await history.save('', 'history.js', 'second');
  await history.save('', 'history.js', 'third');
  const before = await history.list('', 'history.js');
  assert.ok(before.versions.length >= 2);
  assert.deepEqual(await f.exportData(['scripts']), {
    downloaded: f.archive,
    status: undefined,
    error: undefined,
  });
  const restored = path.join(f.root, 'restored');
  await fs.mkdir(restored);
  execFileSync('tar', ['-zxf', f.archive, '-C', restored]);
  const after = new ScriptHistory(
    path.join(restored, 'data/scripts'),
    path.join(restored, 'data/script-history'),
  );
  assert.deepEqual(await after.list('', 'history.js'), before);
  const oldest = before.versions.at(-1);
  const detail = await after.detail('', 'history.js', oldest.id);
  assert.equal(detail.version.content, 'baseline');
  await after.restore('', 'history.js', oldest.id, before.currentHash);
  assert.equal(
    await fs.readFile(path.join(restored, 'data/scripts/history.js'), 'utf8'),
    'baseline',
  );
});

test('fresh installations export scripts without requiring a history directory', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dataPath, 'scripts/job.js'), 'fresh');
  assert.equal((await f.exportData(['scripts'])).downloaded, f.archive);
  const entries = execFileSync('tar', ['-ztf', f.archive], {
    encoding: 'utf8',
  });
  assert.match(entries, /data\/scripts\/job.js/);
  assert.doesNotMatch(entries, /script-history/);
});

test('history can be exported explicitly, while directory traversal is rejected before tar runs', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dataPath, 'script-history'));
  await fs.writeFile(
    path.join(f.dataPath, 'script-history/version.br'),
    'history',
  );
  assert.equal((await f.exportData(['script-history'])).downloaded, f.archive);
  assert.match(
    execFileSync('tar', ['-ztf', f.archive], { encoding: 'utf8' }),
    /script-history\/version.br/,
  );
  await fs.rm(f.archive);
  for (const type of ['../outside', '/etc', 'scripts/../../outside']) {
    const result = await f.exportData([type]);
    assert.equal(result.status, 400);
    assert.equal(result.downloaded, undefined);
  }
  await assert.rejects(fs.stat(f.archive), { code: 'ENOENT' });
});
