const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const base = process.env.QL_URL || 'http://127.0.0.1:5700';
const slug = process.env.QL_ARCH_SLUG || 'unknown';
const platform = process.env.QL_PLATFORM || 'unknown';
const image = process.env.QL_IMAGE || 'unknown';
const expectedCommit = '2efc5e45037662aaf898cd7f8db68421df0908b2';
const output = process.env.QL_OUTPUT || path.resolve('evidence', slug);
const cliPath = process.env.QL_CLI;
const nonce = crypto.randomBytes(4).toString('hex');
const username = `acceptance-${slug}-${nonce}`;
const password = crypto.randomBytes(24).toString('base64url');
const marker = `QL_MULTIARCH_${slug.toUpperCase().replaceAll('-', '_')}_${nonce}`;
const state = { token: '', taskId: null, taskName: `image acceptance ${slug}`, envName: `QL_TEST_${nonce.toUpperCase()}`, envValue: `value_${nonce}` };
const result = { image, platform, slug, expectedCommit, startedAt: new Date().toISOString(), cases: [] };
fs.mkdirSync(output, { recursive: true });

function multiarchWriteResult() {
  result.finishedAt = new Date().toISOString();
  result.status = result.cases.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL';
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
}

async function multiarchRequest(method, route, body, expectedCode = 200) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${method} ${route}: non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`); }
  assert.equal(data.code, expectedCode, `${method} ${route}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}

function multiarchCli(args) {
  assert.ok(cliPath, 'QL_CLI is missing');
  const call = spawnSync(process.execPath, [cliPath, ...args, '--json'], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, QL_URL: base, QL_ACCESS_TOKEN: state.token },
  });
  assert.equal(call.status, 0, `${args.join(' ')}: ${call.stderr.slice(0, 700)}`);
  let response;
  try { response = JSON.parse(call.stdout); } catch { throw new Error(`${args.join(' ')}: invalid JSON ${call.stdout.slice(0, 300)}`); }
  assert.equal(response.code, 200, `${args.join(' ')}: ${JSON.stringify(response).slice(0, 500)}`);
  return response.data;
}

async function multiarchPoll(label, attempt, tries = 80, interval = 3000) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await attempt();
    if (last?.done) return last.value;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last).slice(0, 500)}`);
}

async function multiarchCase(name, action) {
  const started = Date.now();
  try {
    const details = await action();
    result.cases.push({ name, status: 'PASS', elapsedMs: Date.now() - started, ...(details || {}) });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    result.cases.push({ name, status: 'FAIL', elapsedMs: Date.now() - started, error: String(error.stack || error).slice(0, 2000) });
    process.stderr.write(`FAIL ${name}: ${error.stack || error}\n`);
  }
  multiarchWriteResult();
}

async function multiarchRunTask(extension, source, command, expectedMarker, name) {
  const filename = `acceptance_${slug.replaceAll('-', '_')}_${nonce}.${extension}`;
  const localFile = path.join(output, filename);
  fs.writeFileSync(localFile, source);
  multiarchCli(['script', 'create', '--file', localFile, '--data', JSON.stringify({ filename, path: '' })]);
  assert.ok(JSON.stringify(multiarchCli(['script', 'get', '--query', JSON.stringify({ file: filename, path: '' })])).includes(expectedMarker));
  const task = multiarchCli(['task', 'create', '--data', JSON.stringify({
    name,
    command: `${command} /ql/data/scripts/${filename}`,
    schedule: '0 0 * * *',
    extra_schedules: [{ schedule: '30 0 * * *' }],
    allow_multiple_instances: 0,
  })]);
  assert.ok(Number.isInteger(task.id));
  const detail = multiarchCli(['task', 'get', String(task.id)]);
  assert.ok(JSON.stringify(detail.extra_schedules).includes('30 0 * * *'));
  multiarchCli(['task', 'run', String(task.id)]);
  const log = await multiarchPoll(`${extension} task`, () => {
    const data = multiarchCli(['task', 'logs', String(task.id), '--tail', '200']);
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return { done: text.includes(expectedMarker) && (text.includes('Completed') || text.includes('执行结束') || text.includes('完成')), value: text };
  }, 90, 2000);
  assert.ok(log.includes('Completed') || log.includes('执行结束') || log.includes('完成'), log.slice(0, 400));
  fs.writeFileSync(path.join(output, `task-${extension}.log`), log);
  return { taskId: task.id, filename, logMarker: expectedMarker };
}

async function multiarchRunUi() {
  const { chromium } = require(process.env.PLAYWRIGHT_CORE);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const pages = [
    ['dashboard', '仪表盘'], ['crontab', '定时任务'], ['subscription', '订阅管理'],
    ['env', '环境变量'], ['config', '配置文件'], ['script', '脚本管理'],
    ['dependence', '依赖管理'], ['log', '日志管理'], ['diff', '对比工具'], ['setting', '系统设置'],
  ];
  try {
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input[type="text"]').first().fill(username);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL('**/dashboard', { timeout: 60000 });
    await page.locator('.ant-notification-notice-close').first().click({ timeout: 3000 }).catch(() => {});
    const visited = [];
    for (const [route, title] of pages) {
      await page.goto(`${base}/${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.locator('.ant-layout-content').first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(route === 'diff' ? 2500 : 900);
      const body = await page.locator('body').innerText();
      assert.ok(body.length > 50, `${route}: empty page`);
      assert.ok(!body.includes('Application error'), `${route}: application error`);
      await page.screenshot({ path: path.join(output, `ui-${route}.png`), fullPage: true });
      visited.push({ route, title: await page.title(), bodyLength: body.length });
    }
    await page.goto(`${base}/crontab`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByText(state.taskName, { exact: true }).first().waitFor({ timeout: 30000 });
    const row = page.locator('tr').filter({ hasText: state.taskName }).first();
    await row.getByText('日志', { exact: true }).click();
    await page.getByText(marker, { exact: false }).first().waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(output, 'ui-task-log.png'), fullPage: true });
    return { visited };
  } finally {
    await browser.close();
  }
}

async function runMultiarchAcceptance() {
  await multiarchCase('health and build identity', async () => {
    const health = await multiarchRequest('GET', '/health');
    assert.equal(health.data.status, 'ok');
    assert.equal(health.data.build.sourceCommit, expectedCommit);
    assert.equal(health.data.build.version, '2.24.0-dev.0');
    assert.equal(health.data.services.http, true);
    assert.equal(health.data.services.grpc, true);
    result.build = health.data.build;
    return { version: health.data.build.version, sourceCommit: health.data.build.sourceCommit };
  });
  await multiarchCase('account initialization and login', async () => {
    await multiarchRequest('PUT', '/user/init', { username, password });
    const login = await multiarchRequest('POST', '/user/login', { username, password });
    assert.ok(login.data.token);
    state.token = login.data.token;
    await multiarchRequest('GET', '/user');
    await multiarchRequest('GET', '/user/login-log');
  });
  if (!state.token) throw new Error('cannot continue without an authenticated test account');

  await multiarchCase('CLI access scopes and application list', async () => {
    for (const scope of ['crons', 'envs', 'scripts']) {
      assert.equal(multiarchCli(['auth', 'status', '--scope', scope]).scopeChecked, scope);
    }
    multiarchCli(['app', 'list']);
  });

  await multiarchCase('environment create, edit, disable and enable', async () => {
    const created = multiarchCli(['env', 'create', '--data', JSON.stringify([{ name: state.envName, value: state.envValue, remarks: 'multiarch acceptance' }])]);
    const envId = Array.isArray(created) ? created[0]?.id : created?.id;
    assert.ok(Number.isInteger(envId));
    state.envId = envId;
    assert.ok(JSON.stringify(multiarchCli(['env', 'list'])).includes(state.envName));
    await multiarchRequest('PUT', '/envs', { id: envId, name: state.envName, value: `edited_${nonce}`, remarks: 'edited' });
    assert.equal((await multiarchRequest('GET', `/envs/${envId}`)).data.value, `edited_${nonce}`);
    await multiarchRequest('PUT', '/envs/disable', [envId]);
    await multiarchRequest('PUT', '/envs/enable', [envId]);
    await multiarchRequest('PUT', '/envs', { id: envId, name: state.envName, value: state.envValue, remarks: 'restored' });
    return { envId };
  });

  await multiarchCase('configuration read, save and compare source', async () => {
    const filename = `acceptance_${slug.replaceAll('-', '_')}.sh`;
    const content = `export ${state.envName}=${state.envValue}\n`;
    await multiarchRequest('GET', '/configs/samples');
    await multiarchRequest('POST', '/configs/save', { name: filename, content });
    const files = await multiarchRequest('GET', '/configs/files');
    assert.ok(JSON.stringify(files.data).includes(filename));
    const detail = await multiarchRequest('GET', `/configs/detail?path=${encodeURIComponent(filename)}`);
    assert.ok(JSON.stringify(detail.data).includes(state.envName));
    return { filename };
  });

  await multiarchCase('JavaScript script and scheduled task', async () => {
    const source = `console.log('${marker}', process.version, process.env.${state.envName});\n`;
    const task = await multiarchRunTask('js', source, 'node', marker, state.taskName);
    state.taskId = task.taskId;
    const log = fs.readFileSync(path.join(output, 'task-js.log'), 'utf8');
    assert.ok(log.includes(state.envValue));
    await multiarchRequest('PUT', '/crons/disable', [task.taskId]);
    await multiarchRequest('PUT', '/crons/enable', [task.taskId]);
    return task;
  });

  await multiarchCase('Python script and scheduled task', async () => {
    const pyMarker = `${marker}_PY`;
    return await multiarchRunTask('py', `print('${pyMarker}')\n`, 'python3', pyMarker, `python acceptance ${slug}`);
  });

  await multiarchCase('Shell script and scheduled task', async () => {
    const shMarker = `${marker}_SH`;
    return await multiarchRunTask('sh', `#!/bin/bash\necho '${shMarker}'\n`, 'bash', shMarker, `shell acceptance ${slug}`);
  });

  await multiarchCase('TypeScript script and scheduled task', async () => {
    const tsMarker = `${marker}_TS`;
    return await multiarchRunTask('ts', `const value: string = '${tsMarker}';\nconsole.log(value);\n`, 'node', tsMarker, `typescript acceptance ${slug}`);
  });

  await multiarchCase('dashboard and task logs', async () => {
    for (const route of ['/dashboard/overview', '/dashboard/trend', '/dashboard/runtime', '/dashboard/system', '/logs']) {
      await multiarchRequest('GET', route);
    }
    assert.ok(JSON.stringify(multiarchCli(['task', 'logs', String(state.taskId), '--tail', '100'])).includes(marker));
  });

  await multiarchCase('dependency installation and status', async () => {
    const created = await multiarchRequest('POST', '/dependencies', [{ name: 'is-number@7.0.0', type: 0, remark: 'multiarch acceptance' }]);
    const depId = Array.isArray(created.data) ? created.data[0]?.id : created.data?.id;
    assert.ok(Number.isInteger(depId));
    const dependency = await multiarchPoll('dependency install', async () => {
      const list = await multiarchRequest('GET', '/dependencies');
      const doc = list.data.find(item => item.id === depId);
      return { done: doc?.status === 1 || doc?.status === 2, value: doc };
    }, 120, 5000);
    assert.equal(dependency.status, 1, JSON.stringify(dependency).slice(0, 500));
    return { dependencyId: depId, status: dependency.status };
  });

  await multiarchCase('subscription download and automatic task', async () => {
    const fixtureMarker = `${marker}_SUB`;
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      response.end(`console.log('${fixtureMarker}');\n`);
    });
    await new Promise(resolve => server.listen(18080, '0.0.0.0', resolve));
    try {
      const created = await multiarchRequest('POST', '/subscriptions', {
        type: 'file', schedule_type: 'crontab', schedule: '0 0 1 1 *',
        name: `subscription acceptance ${slug}`, alias: `sub_${nonce}`,
        url: 'http://host.docker.internal:18080/fixture.js', autoAddCron: true, autoDelCron: false,
      });
      const subscriptionId = created.data?.id;
      assert.ok(Number.isInteger(subscriptionId));
      await multiarchRequest('PUT', '/subscriptions/run', [subscriptionId]);
      const run = await multiarchPoll('subscription download', async () => {
        const log = await multiarchRequest('GET', `/subscriptions/${subscriptionId}/log?tail=true`);
        const text = typeof log.data === 'string' ? log.data : JSON.stringify(log.data);
        const cronList = await multiarchRequest('GET', '/crons');
        return { done: text.includes('fixture.js') && JSON.stringify(cronList.data).includes('fixture.js'), value: { log: text, tasks: cronList.data } };
      }, 90, 3000);
      fs.writeFileSync(path.join(output, 'subscription.log'), run.log);
      return { subscriptionId, generatedTask: true };
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await multiarchCase('notification audit and system settings', async () => {
    const notify = await multiarchRequest('PUT', '/system/notify', { title: marker, content: 'isolated acceptance without a push provider' }, 400);
    assert.equal(notify.code, 400);
    const audit = await multiarchPoll('notification audit', async () => {
      const logs = await multiarchRequest('GET', '/system/notify-log');
      const entry = logs.data.find(item => item.title === marker);
      return { done: Boolean(entry), value: entry };
    }, 30, 1000);
    assert.equal(audit.status, 1);
    assert.equal(audit.source, 'system');
    await multiarchRequest('GET', '/system');
    await multiarchRequest('PUT', '/system/config/panel-title', { panelTitle: `Acceptance ${slug}` });
    return { auditStatus: audit.status };
  });

  await multiarchCase('all panel module routes and screenshots', multiarchRunUi);
  multiarchWriteResult();
  if (result.status !== 'PASS') process.exitCode = 1;
}

runMultiarchAcceptance().catch(error => {
  result.cases.push({ name: 'fatal prerequisite', status: 'FAIL', error: String(error.stack || error).slice(0, 2000) });
  multiarchWriteResult();
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
