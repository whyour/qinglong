const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const load = require('../helpers/load-security-module.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-system-log-clear-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const SystemService = load('back/services/system.ts', {
    '../config': { systemLogPath: root },
    '../config/const': {},
    '../config/util': {
      readDirs: async () =>
        (await fs.readdir(root)).map((title) => ({ title })),
      rmPath: (file) => fs.rm(file),
    },
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
  return { root, service: new SystemService({}, {}, {}) };
}

test('clearing system logs preserves append handles used by existing workers', async (t) => {
  const { root, service } = await fixture(t);
  const active = path.join(root, '2026-10-17.log');
  const rotated = path.join(root, '2026-10-16.log');
  await fs.writeFile(active, 'old active logs\n');
  await fs.writeFile(rotated, 'old rotated logs\n');
  await fs.writeFile(path.join(root, 'audit.json'), 'rotation metadata');
  const workers = await Promise.all([fs.open(active, 'a'), fs.open(active, 'a')]);
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
  });
  const inode = (await fs.stat(active)).ino;

  for (let clear = 0; clear < 2; clear++) {
    await service.deleteSystemLog();
    assert.equal(await fs.readFile(active, 'utf8'), '');
    assert.equal(await fs.readFile(rotated, 'utf8'), '');
    assert.equal((await fs.stat(active)).ino, inode);
    await workers[0].write('new scheduler log\n');
    await workers[1].write('new queue log\n');
    assert.equal(
      await fs.readFile(active, 'utf8'),
      'new scheduler log\nnew queue log\n',
    );
  }
  assert.equal(
    await fs.readFile(path.join(root, 'audit.json'), 'utf8'),
    'rotation metadata',
  );
});

test('clearing system logs refuses symlinks without truncating their target', async (t) => {
  const { root, service } = await fixture(t);
  const target = path.join(root, 'keep.txt');
  await fs.writeFile(target, 'keep this content');
  await fs.symlink(target, path.join(root, 'linked.log'));
  await assert.rejects(service.deleteSystemLog(), { code: 'ELOOP' });
  assert.equal(await fs.readFile(target, 'utf8'), 'keep this content');
});
