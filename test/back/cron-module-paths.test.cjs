const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('the compiled orphan reporter loads cron history without a legacy forwarding entry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-reporter-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const directory of ['shared', 'cron/settlement', 'data']) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
  }
  const reporter = path.join(root, 'shared/managedExit.cjs');
  const report = path.join(root, 'report.json');
  await fs.copyFile(path.resolve('back/shared/managedExit.cjs'), reporter);
  await fs.copyFile(
    path.resolve('back/cron/settlement/exitReceipt.cjs'),
    path.join(root, 'cron/settlement/exitReceipt.cjs'),
  );
  await fs.writeFile(
    path.join(root, 'cron/history.js'),
    `
    exports.triggerHistory = () => ({ complete: (...args) => {
      require('node:fs').writeFileSync(process.env.REPORT, JSON.stringify(args));
      return Promise.resolve();
    } });
  `,
  );
  await fs.writeFile(
    path.join(root, 'data/index.js'),
    'exports.sequelize = { close: async () => {} };',
  );
  const time = Date.now();
  const result = spawnSync(
    process.execPath,
    [reporter, JSON.stringify({ code: 7, signal: null, time })],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        QL_TRIGGER_ID: 'compiled-report',
        REPORT: report,
      },
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(report, 'utf8')), [
    'compiled-report',
    'failed',
    null,
    7,
    time,
    'legacy',
  ]);
});
