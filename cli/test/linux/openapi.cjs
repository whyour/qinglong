// Fresh disposable official panel only; never run against an initialized panel.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');

(async () => {
  assert.equal(process.env.QL_PANEL_INTEGRATION, '1');
  const url = 'http://127.0.0.1:5700';
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(url + '/api/' + route, { method,
      headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.equal(result.code, 200); return result.data;
  };
  const info = await api('system'); assert.equal(info.isInitialized, false, 'Refuse initialized panels');
  const credentials = { username: 'fixture-' + randomUUID(), password: randomUUID() };
  await api('user/init', 'PUT', credentials);
  const owner = (await api('user/login', 'POST', credentials)).token;
  const config = '/tmp/ql-openapi-auth.json';
  const entry = path.resolve(__dirname, '../../dist/npm/ql.js');
  const cli = (args, ownerMode = false, extra = {}) => {
    const result = spawnSync(process.execPath, [entry, ...args, '--json'], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, QL_CLI_CONFIG: config, QL_URL: ownerMode ? url : '', QL_ACCESS_TOKEN: ownerMode ? owner : '', ...extra },
    });
    // Report only the command name, never request bodies or application credentials.
    assert.equal(result.status, 0, args.slice(0, 2).join(' ') + ': ' + result.stderr);
    return JSON.parse(result.stdout).data;
  };
  const app = cli(['app', 'create', '--name', 'cli-fixture', '--scopes', 'crons,subscriptions,envs,configs,scripts,logs,dependencies,system,dashboard,apps', '--show-secrets'], true);
  assert.ok(app.client_id && app.client_secret);
  cli(['login', '--url', url], false, { QL_CLIENT_ID: app.client_id, QL_CLIENT_SECRET: app.client_secret });
  cli(['auth', 'status', '--scope', 'apps']);
  cli(['app', 'update', String(app.id), '--name', 'cli-updated', '--scopes', 'crons,subscriptions,envs,configs,scripts,logs,dependencies,system,dashboard,apps']);
  assert.ok(cli(['app', 'list']).every(item => !('client_secret' in item) && !('tokens' in item)));
  const task = cli(['task', 'create', '--name', 'cli-task', '--command', 'echo OPENAPI_FIXTURE', '--schedule', '0 0 * * *']);
  cli(['task', 'update', String(task.id), '--name', 'cli-task-updated', '--command', 'echo OPENAPI_UPDATED', '--schedule', '0 1 * * *']);
  cli(['task', 'disable', String(task.id)]); cli(['task', 'enable', String(task.id)]);
  assert.equal(cli(['task', 'get', String(task.id)]).name, 'cli-task-updated');
  const sub = cli(['subscription', 'create', '--type', 'file', '--url', url + '/fixture.js', '--alias', 'cli-sub', '--schedule-type', 'crontab', '--schedule', '0 0 * * *']);
  cli(['subscription', 'update', String(sub.id), '--data', JSON.stringify({ type: 'file', url: url + '/fixture.js', alias: 'cli-sub', name: 'cli-sub-updated', schedule_type: 'crontab', schedule: '0 1 * * *' })]);
  cli(['subscription', 'disable', String(sub.id)]); cli(['subscription', 'enable', String(sub.id)]);
  assert.equal(cli(['subscription', 'get', String(sub.id)]).name, 'cli-sub-updated');
  const env = cli(['env', 'create', '--data', '[{"name":"CLI_FIXTURE","value":"one"}]'])[0];
  cli(['env', 'update', String(env.id), '--data', '{"name":"CLI_FIXTURE","value":"two"}']);
  assert.equal(cli(['env', 'get', String(env.id)]).value, 'two');
  cli(['env', 'delete', String(env.id)]);
  cli(['script', 'create', '--data', '{"filename":"cli-openapi.js","content":"console.log(1)","path":""}']);
  assert.equal(cli(['script', 'get', '--query', '{"file":"cli-openapi.js"}']), 'console.log(1)');
  cli(['config', 'save', '--data', '{"name":"cli-openapi.sh","content":"# fixture"}']);
  assert.equal(cli(['config', 'get', '--query', '{"path":"cli-openapi.sh"}']), '# fixture');
  cli(['log', 'list']); cli(['dependency', 'list']);
  cli(['task', 'delete', String(task.id)]); cli(['subscription', 'delete', String(sub.id)]);
  const reset = cli(['app', 'reset-secret', String(app.id), '--show-secrets'], true);
  assert.ok(reset.client_secret !== app.client_secret);
  cli(['login', '--url', url], false, { QL_CLIENT_ID: app.client_id, QL_CLIENT_SECRET: reset.client_secret });
  cli(['auth', 'status']); cli(['app', 'delete', String(app.id)], true);
  await fs.rm(config, { force: true });
  console.log(JSON.stringify({ panelVersion: info.version, taskCrud: true, subscriptionCrud: true, appCrudAndSecretRotation: true, envCrud: true, scriptCreateRead: true, configSaveRead: true, logAndDependencyRead: true }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
