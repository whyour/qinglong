const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

exports.verifyOperator = async function verifyOperator(api) {
  const ql = path.join(os.homedir(), 'bin/ql');
  const invoke = (args) => {
    const result = spawnSync(ql, args, {
      env: { ...process.env, QL_DIR: '/ql' },
      encoding: 'utf8',
      timeout: 45000,
    });
    assert.equal(result.status, 0, `${args[0]} failed: ${result.stderr}`);
    return JSON.parse(result.stdout).data;
  };
  const dir = '/ql/data/log/cli-retention';
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(`${dir}/2000-01-01-unused.log`, 'unused');
  await fs.writeFile(`${dir}/2000-01-01-kept.log`, 'referenced');
  const task = (
    await api('crons', 'POST', {
      name: 'CLI retention reference',
      command: 'echo retention',
      schedule: '0 0 1 1 *',
    })
  ).data;
  try {
    await api('crons/status', 'PUT', {
      ids: [task.id],
      status: '0',
      log_path: 'cli-retention/2000-01-01-kept.log',
    });
    const result = invoke(['rmlog', '7']);
    assert.ok(result.removed.includes('cli-retention/2000-01-01-unused.log'));
    assert.ok(result.retained.includes('cli-retention/2000-01-01-kept.log'));
    await assert.rejects(fs.access(`${dir}/2000-01-01-unused.log`));
    assert.equal(
      await fs.readFile(`${dir}/2000-01-01-kept.log`, 'utf8'),
      'referenced',
    );
  } finally {
    await api('crons', 'DELETE', [task.id]);
  }
  const service = invoke(['reload']);
  assert.ok(['pm2', 'node'].includes(service.manager));
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch('http://127.0.0.1:5700/api/system', {
        signal: AbortSignal.timeout(500),
      });
      if ((await response.json()).code === 200) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'Panel failed to recover after reload');
  const retained = !(await fs.lstat(ql)).isSymbolicLink();
  assert.equal(
    retained,
    true,
    'Panel startup overwrote the TypeScript ql entrypoint',
  );
  return true;
};
