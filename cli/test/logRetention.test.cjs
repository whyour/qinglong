const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createContext } = require('../dist/local/context');
const { LocalApi } = require('../dist/local/api');
const { pruneLogs } = require('../dist/local/maintenance');

test('undated logs use modification calendar date and preserve active references at retention boundary', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-retention-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = new Date(2026, 0, 8, 12).getTime();
  const modified = new Date(2026, 0, 1, 18);
  t.mock.method(Date, 'now', () => now);
  const queries = [];
  t.mock.method(LocalApi.prototype, 'call', async (endpoint) => {
    const log = new URL(`http://fixture/${endpoint}`).searchParams.get(
      'log_path',
    );
    queries.push(log);
    return { data: log.includes('active') ? { id: 1 } : null };
  });
  const createLogs = async (directory) => {
    await fs.mkdir(directory, { recursive: true });
    for (const name of [
      'undated.log',
      'active.log',
      '2026-01-01-dated.log',
      'ignore.txt',
    ]) {
      await fs.writeFile(path.join(directory, name), 'fixture');
      await fs.utimes(path.join(directory, name), modified, modified);
    }
  };
  const context = createContext({ root }, {});
  await createLogs(context.paths.dir_log);
  const result = await pruneLogs(context, 7);
  assert.deepEqual(result.removed, ['2026-01-01-dated.log', 'undated.log']);
  assert.deepEqual(result.retained, ['active.log']);
  assert.deepEqual(queries.sort(), [
    '2026-01-01-dated.log',
    'active.log',
    'undated.log',
  ]);
  assert.deepEqual((await fs.readdir(context.paths.dir_log)).sort(), [
    'active.log',
    'ignore.txt',
  ]);
  if (process.platform === 'linux') {
    const legacy = path.join(root, 'legacy');
    await createLogs(legacy);
    execFileSync(
      '/bin/bash',
      [
        path.join(__dirname, 'fixtures/log-retention.sh'),
        path.resolve(__dirname, '../../shell/rmlog.sh'),
      ],
      {
        env: {
          PATH: '/usr/bin:/bin',
          dir_log: legacy,
          is_macos: '0',
          FIXED_NOW: String(now / 1000),
          TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        stdio: 'pipe',
      },
    );
    assert.deepEqual((await fs.readdir(legacy)).sort(), [
      'active.log',
      'ignore.txt',
    ]);
  }
});
