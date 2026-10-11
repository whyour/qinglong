const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const load = require('../helpers/load-security-module.cjs');

for (const failOperation of [false, true]) {
  test(`scheduler lock survives nested file writes and releases after ${
    failOperation ? 'failure' : 'success'
  }`, async (t) => {
    // Match production's canonical /ql path even when macOS temp is a symlink.
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'ql-nested-lock-')),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const config = { crontabFile: path.join(root, 'crontab.list') };
    await fs.writeFile(config.crontabFile, '');
    const { withSchedulerMutation } = load(
      'back/shared/schedulerMutationLock.ts',
      {
        '../config': config,
      },
    );
    const { writeFileWithLock } = load('back/shared/utils.ts', {
      '../config/util': {
        fileExist: async (file) =>
          fs.access(file).then(
            () => true,
            () => false,
          ),
      },
    });
    const failure = new Error('registration failed');
    const operation = withSchedulerMutation(async () => {
      await writeFileWithLock(config.crontabFile, 'first');
      await writeFileWithLock(config.crontabFile, 'second');
      if (failOperation) throw failure;
    });
    if (failOperation)
      await assert.rejects(operation, (error) => error === failure);
    else await operation;
    await assert.rejects(fs.stat(`${config.crontabFile}.scheduler.lock`), {
      code: 'ENOENT',
    });
    await withSchedulerMutation(() =>
      writeFileWithLock(config.crontabFile, 'recovered'),
    );
    assert.equal(await fs.readFile(config.crontabFile, 'utf8'), 'recovered');
  });
}
