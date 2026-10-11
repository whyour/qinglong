const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { replaceAndReload } = require('../../shell/upgrade.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ql-upgrade-transaction-'),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'),
    target = path.join(root, 'target');
  for (const directory of [source, target]) await fs.mkdir(directory);
  await fs.writeFile(path.join(source, 'version'), 'new');
  await fs.writeFile(path.join(target, 'version'), 'old');
  return { root, source, target };
}

for (const failure of ['backup', 'remove', 'replacement', 'start'])
  test(`Bash transaction restores the full original after an overlay ${failure} failure`, async (t) => {
    const f = await fixture(t);
    const rename = fs.rename,
      cp = fs.cp,
      rm = fs.rm;
    t.mock.method(fs, 'rename', async (source, target) => {
      if (source === f.target || source.includes('.ql-backup-')) {
        const error = new Error('overlay rename');
        error.code = 'EXDEV';
        throw error;
      }
      return rename(source, target);
    });
    let injected = false;
    t.mock.method(fs, 'cp', async (source, target, options) => {
      if (
        !injected &&
        ((failure === 'backup' && source === f.target) ||
          (failure === 'replacement' && source === f.source))
      ) {
        injected = true;
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, 'partial'), 'partial');
        throw new Error('copy failed');
      }
      return cp(source, target, options);
    });
    t.mock.method(fs, 'rm', async (target, options) => {
      if (!injected && failure === 'remove' && target === f.target) {
        injected = true;
        await fs.unlink(path.join(target, 'version'));
        throw new Error('remove failed');
      }
      return rm(target, options);
    });
    let starts = 0;
    await assert.rejects(
      replaceAndReload([f], {
        stop: async () => {},
        start: async () => {
          if (++starts === 1 && failure === 'start')
            throw new Error('start failed');
          assert.equal(
            await fs.readFile(path.join(f.target, 'version'), 'utf8'),
            'old',
          );
        },
      }),
      /failed/,
    );
    assert.deepEqual(await fs.readdir(f.target), ['version']);
    assert.ok(
      !(await fs.readdir(f.root)).some((name) => name.includes('.ql-backup-')),
    );
  });

test('interrupted upgrade recovers the previous service outside cancellation', async (t) => {
  const f = await fixture(t),
    controller = new AbortController();
  let starts = 0;
  await assert.rejects(
    replaceAndReload([f], {
      signal: controller.signal,
      stop: async () => {},
      start: async (recover) => {
        if (++starts === 1) {
          assert.equal(
            await fs.readFile(path.join(f.target, 'version'), 'utf8'),
            'new',
          );
          controller.abort(new Error('interrupted'));
        } else {
          assert.equal(recover, true);
          assert.equal(
            await fs.readFile(path.join(f.target, 'version'), 'utf8'),
            'old',
          );
        }
      },
    }),
    /interrupted/,
  );
  assert.equal(starts, 2);
});

test('failed stop during rollback retains backups without overwriting running files', async (t) => {
  const f = await fixture(t);
  let stops = 0;
  await assert.rejects(
    replaceAndReload([f], {
      stop: async () => {
        if (++stops === 2) throw new Error('stop failed');
      },
      start: async () => {
        throw new Error('start failed');
      },
    }),
    /stop failed/,
  );
  const backup = (await fs.readdir(f.root)).find((name) =>
    name.includes('.ql-backup-'),
  );
  assert.ok(backup);
  assert.equal(
    await fs.readFile(path.join(f.root, backup, 'version'), 'utf8'),
    'old',
  );
  assert.equal(
    await fs.readFile(path.join(f.target, 'version'), 'utf8'),
    'new',
  );
});
