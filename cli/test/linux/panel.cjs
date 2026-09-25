// Run only inside a fresh, disposable official 2.x panel container.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createContext } = require('../../dist/internal/runtime/context');
const { executeTask } = require('../../dist/internal/execution/taskRunner');

let restoreEntrypoints;
(async () => {
  assert.equal(
    process.env.QL_PANEL_INTEGRATION,
    '1',
    'Disposable-panel opt-in required',
  );
  const base = 'http://127.0.0.1:5700';
  let token;
  async function api(endpoint, method = 'GET', body) {
    const response = await fetch(`${base}/api/${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    assert.equal(
      result.code,
      200,
      `${method} ${endpoint} failed: ${response.status}/${result.code}`,
    );
    return result;
  }
  const system = await api('system');
  assert.equal(
    system.data.isInitialized,
    false,
    'Refuse to alter an initialized panel',
  );
  const switched = process.env.QL_PANEL_ENTRYPOINTS === '1';
  if (switched && process.env.QL_PANEL_PACKAGED === '1') {
    assert.equal(process.env.QL_CLI_ROOT, '/opt/qinglong-cli');
    for (const [name, module] of [['task', 'task'], ['ql', 'ql']]) {
      const target = require('node:path').join(require('node:os').homedir(), 'bin', name);
      assert.equal((await fs.lstat(target)).isSymbolicLink(), false);
      assert.ok((await fs.readFile(target, 'utf8')).includes(Buffer.from(`/opt/qinglong-cli/dist/${module}.js`).toString('base64')));
    }
  } else if (switched)
    restoreEntrypoints =
      await require('./evaluation-entrypoints.cjs').installEvaluationEntrypoints();
  const credentials = {
    username: `fixture-${randomUUID()}`,
    password: randomUUID(),
  };
  await api('user/init', 'PUT', credentials);
  token = (await api('user/login', 'POST', credentials)).data.token;
  assert.equal(typeof token, 'string');
  const app = (
    await api('apps', 'POST', {
      name: 'CLI integration',
      scopes: ['crons', 'subscriptions'],
    })
  ).data;
  const env = {
    ...process.env,
    QL_CLI_CONFIG: '/tmp/ql-integration-auth.json',
    QL_CLIENT_ID: app.client_id,
    QL_CLIENT_SECRET: app.client_secret,
  };
  const cli = (args) => {
    const result = spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../../dist/npm/ql.js'), ...args, '--json'],
      {
        env,
        encoding: 'utf8',
        timeout: 20000,
      },
    );
    assert.equal(
      result.status,
      0,
      `CLI ${args.slice(0, 2).join(' ')} failed: ${result.stderr}`,
    );
    return JSON.parse(result.stdout);
  };
  assert.equal(cli(['login', '--url', base]).data.authenticated, true);
  assert.equal(cli(['auth', 'status']).data.authenticated, true);
  assert.equal(
    cli(['auth', 'status', '--scope', 'subscriptions']).data.authenticated,
    true,
  );
  assert.ok(Array.isArray(cli(['subscription', 'list']).data));
  const filename = 'cli-integration.js';
  await fs.writeFile(
    `/ql/data/scripts/${filename}`,
    'console.log("CLI_REAL_PANEL_MARKER");',
  );
  const task = (
    await api('crons', 'POST', {
      name: 'CLI integration',
      command: `task ${filename}`,
      schedule: '0 0 1 1 *',
    })
  ).data;
  const id = String(task.id);
  assert.equal(cli(['task', 'get', id]).data.id, task.id);
  assert.equal(cli(['task', 'run', id]).data.accepted, true);
  let observed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const logs = cli(['task', 'logs', id]);
    if (
      logs.data.includes('CLI_REAL_PANEL_MARKER') &&
      /完成|执行结束/.test(logs.data)
    ) {
      observed = true;
      break;
    }
  }
  assert.equal(
    observed,
    true,
    'Legacy panel task did not finish with expected logs',
  );
  if (switched) {
    await fs.writeFile(
      '/ql/data/config/extra.sh',
      'printf "CLI_COMPAT_PANEL_MARKER\\n"\n',
    );
    const maintenance = (
      await api('crons', 'POST', {
        name: 'CLI compat maintenance',
        command: 'ql extra',
        schedule: '0 0 1 1 *',
      })
    ).data;
    const maintenanceId = String(maintenance.id);
    cli(['task', 'run', maintenanceId]);
    let done = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const logs = cli(['task', 'logs', maintenanceId]).data;
      if (
        logs.includes('CLI_COMPAT_PANEL_MARKER') &&
        logs.includes('执行结束')
      ) {
        done = true;
        break;
      }
    }
    assert.equal(
      done,
      true,
      'Switched ql did not complete through panel scheduling',
    );
    const saved = cli(['task', 'get', maintenanceId]).data;
    assert.match(saved.log_path, /^ql\//);
    assert.ok(saved.last_execution_time > 0);
    await api('crons', 'DELETE', [maintenance.id]);
  }
  const subscriptionExecution = switched
    ? await require('./panel-subscription.cjs').verifySubscription(api, cli)
    : false;
  const repositoryExecution = switched
    ? await require('./panel-repository.cjs').verifyRepository(api, cli)
    : false;
  // Exercise the migrated runner against the real local-token generator/status API.
  await fs.writeFile(
    `/ql/data/scripts/${filename}`,
    'console.log("CLI_NATIVE_PANEL_MARKER");process.exit(7);',
  );
  const context = createContext(
    { root: '/ql' },
    { ...process.env, ID: id, no_tee: 'true', QlPort: '5700' },
  );
  const result = await executeTask(context, {
    argv: [filename],
    mode: 'now',
    output: () => {},
  });
  assert.equal(result.exitCode, 7);
  const persisted = cli(['task', 'get', id]).data;
  assert.equal(persisted.log_path, result.logPath);
  assert.match(cli(['task', 'logs', id]).data, /CLI_NATIVE_PANEL_MARKER/);
  assert.ok(persisted.last_execution_time > 0);
  await api('crons', 'DELETE', [task.id]);
  const operatorMaintenance = switched
    ? await require('./panel-operator.cjs').verifyOperator(api)
    : false;
  const accountMaintenance = switched
    ? await require('./panel-account.cjs').verifyAccountMaintenance(api)
    : false;
  cli(['auth', 'logout']);
  await fs.rm(`/ql/data/scripts/${filename}`);
  console.log(
    JSON.stringify({
      panelVersion: system.data.version,
      applicationAuth: true,
      subscriptionRead: true,
      subscriptionExecution,
      repositoryExecution,
      accountMaintenance,
      operatorMaintenance,
      remoteRunAndLogs: true,
      switchedEntrypoints: switched,
      localRunnerExitCode: result.exitCode,
      persistedLogPath: true,
    }),
  );
})()
  .catch(() => {
    // Assertions can embed environment values or subprocess output in their message.
    console.error('Disposable panel integration failed; inspect the failing scenario locally.');
    process.exitCode = 1;
  })
  .finally(async () => {
    if (restoreEntrypoints) await restoreEntrypoints();
  });
