const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { createContext } = require('../../dist/internal/runtime/context');
const { installPanelDependencies } = require('../../dist/internal/maintenance/operator');
const { reloadPanel } = require('../../dist/internal/maintenance/upgrade');
assert.equal(process.env.QL_PANEL_INTEGRATION, '1');
(async () => {
  let token;
  const api = async (endpoint, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:5700/api/${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    assert.equal(result.code, 200, `${method} ${endpoint}: ${result.code}`);
    return result;
  };
  const before = (await api('system')).data;
  assert.equal(before.version, '2.19.0');
  assert.equal(before.isInitialized, false);
  assert.equal(process.env.QL_CLI_ROOT, '/opt/qinglong-cli');
  const verifySelection = async () => {
    for (const [name, module] of [
      ['task', 'runner'],
      ['ql', 'compat'],
    ]) {
      const entry = `/root/bin/${name}`;
      assert.equal((await fs.lstat(entry)).isSymbolicLink(), false);
      assert.ok(
        (await fs.readFile(entry, 'utf8')).includes(
          `/opt/qinglong-cli/dist/${module}.js`,
        ),
      );
    }
  };
  await verifySelection();

  const credentials = {
    username: `upgrade-${randomUUID()}`,
    password: randomUUID(),
  };
  await api('user/init', 'PUT', credentials);
  token = (await api('user/login', 'POST', credentials)).data.token;
  await fs.writeFile(
    '/ql/data/scripts/upgrade-fixture.js',
    'console.log("UPGRADE_PRESERVED_TASK");',
  );
  const task = (
    await api('crons', 'POST', {
      name: 'upgrade retained task',
      command: 'task upgrade-fixture.js',
      schedule: '0 0 1 1 *',
    })
  ).data;
  await fs.appendFile(
    '/ql/data/config/config.sh',
    '\n# UPGRADE_PRESERVED_CONFIG\n',
  );
  const config = await fs.readFile('/ql/data/config/config.sh');
  const dotenv = await fs.readFile('/ql/.env');
  const context = createContext({ root: '/ql' }, process.env);
  await installPanelDependencies(context, '/stage/source');
  const replacement = await reloadPanel(context, 'system', {
    source: '/stage/source',
    static: '/stage/static',
  });
  assert.deepEqual(replacement.retainedBackups, []);
  let after;
  for (let i = 0; i < 60; i++) {
    try {
      after = (await api('system')).data;
      if (after.version === '2.20.1') break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(after?.version, '2.20.1');
  await verifySelection();
  token = (await api('user/login', 'POST', credentials)).data.token;
  const persisted = (await api(`crons/${task.id}`)).data;
  assert.equal(persisted.name, task.name);
  assert.equal(persisted.command, task.command);
  assert.deepEqual(await fs.readFile('/ql/data/config/config.sh'), config);
  assert.deepEqual(await fs.readFile('/ql/.env'), dotenv);
  await api('crons/run', 'PUT', [task.id]);
  let log = '';
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    log = (await api(`crons/${task.id}/log`)).data;
    if (log.includes('UPGRADE_PRESERVED_TASK') && /完成|执行结束/.test(log))
      break;
  }
  assert.match(log, /UPGRADE_PRESERVED_TASK/);
  assert.match(log, /完成|执行结束/);
  console.log(
    JSON.stringify({
      from: before.version,
      to: after.version,
      tsCommandSelectionPreserved: true,
      accountPreserved: true,
      taskPreserved: true,
      scriptExecuted: true,
      configurationPreserved: true,
      dotenvPreserved: true,
      backupsCleaned: true,
    }),
  );
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
