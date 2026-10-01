const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');
const load = require('../helpers/load-security-module.cjs');

test('Python environment generation escapes backslashes and triple quotes together', async () => {
  const output = {};
  const Env = load(path.resolve('back/services/env.ts'), {
    typedi: { Service: () => (x) => x, Inject: () => () => {} },
    '../config': { envFile: 'sh', jsEnvFile: 'js', pyEnvFile: 'py' },
    '../data/env': { EnvStatus: { normal: 0 } },
    '../data': {},
    '../shared/utils': {
      writeFileWithLock: async (file, text) => (output[file] = text),
    },
  }).default;
  const values = [
    "\\'''; injected = True; #",
    "'''",
    '\\\\\\',
    'quotes\'"`\n中文\u2028',
    '${1+2}',
  ];
  const service = new Env({});
  service.envs = async () =>
    values.map((value, i) => ({ name: `VALUE_${i}`, value }));
  await service.set_envs();
  const result = execFileSync(
    'python3',
    [
      '-c',
      output.py +
        '\nimport json\nprint(json.dumps([os.environ["VALUE_"+str(i)] for i in range(5)]))\nassert "injected" not in globals()',
    ],
    { encoding: 'utf8' },
  );
  assert.deepEqual(JSON.parse(result), values);
});

test('cron lookup treats regex and shell metacharacters as literal command text', () => {
  const { findCronId } = load(path.resolve('back/shared/cronCommand.ts'));
  const command = 'task file[1].js --value "$(touch ignored)"';
  const crontab =
    `* * * * * real_time=false no_tee=true ID=17 ${command}\n` +
    '* * * * * real_time=false no_tee=true ID=18 task other.js\n';
  assert.equal(findCronId(crontab, command), '17');
  assert.equal(findCronId(crontab, 'task file1.js'), '');
  assert.equal(findCronId(crontab, '.*'), '');
  assert.equal(findCronId(crontab, 'task other.js'), '18');
  assert.equal(findCronId('', command), '');
  assert.equal(findCronId(crontab, ''), '');
});

test('command route does not execute input while looking up the cron id', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'unexpected');
  const command = `task demo.js "$(touch ${marker})"`;
  const crontabFile = path.join(root, 'crontab');
  fs.writeFileSync(
    crontabFile,
    `* * * * * real_time=false no_tee=true ID=42 ${command}\n`,
  );
  const seen = [];
  const app = express.Router();
  load(path.resolve('back/api/system.ts'), {
    '../config': { crontabFile, tmpPath: root },
    '../services/system': {},
    '../services/user': {},
    '../shared/i18n': { t: (x) => x },
    '../shared/logStreamManager': { logStreamManager: {} },
    typedi: {
      Container: { get: () => ({ run: async (value) => seen.push(value) }) },
    },
    '../config/util': {
      getUniqPath: async (_command, id) => {
        assert.equal(id, '42');
        return 'test';
      },
      promiseExec: async (cmd) => {
        return execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
      },
    },
  }).default(app);
  const router = app.stack.find((x) => x.name === 'router').handle;
  const route = router.stack.find(
    (x) => x.route?.path === '/command-run',
  ).route;
  await route.stack
    .at(-1)
    .handle({ body: { command } }, { setHeader() {} }, (e) => {
      throw e;
    });
  assert.equal(fs.existsSync(marker), false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, command);
});

test('anonymous token exchange is limited per source across both API mounts', async (t) => {
  let attempts = 0;
  const app = express();
  const router = express.Router();
  load(path.resolve('back/api/open.ts'), {
    '../services/open': {},
    typedi: {
      Container: {
        get: () => ({
          authToken: async () => {
            attempts++;
            return { code: 401 };
          },
        }),
      },
    },
  }).default(router);
  app.use('/api', router);
  app.use('/open', router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (let i = 0; i < 101; i++) {
    const response = await fetch(
      `${base}/${
        i % 2 ? 'api' : 'open'
      }/auth/token?client_id=id&client_secret=wrong`,
    );
    await response.text();
    assert.equal(response.status, i < 100 ? 200 : 429, `request ${i + 1}`);
  }
  assert.equal(attempts, 100);
});
