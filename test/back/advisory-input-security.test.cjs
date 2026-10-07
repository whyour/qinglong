const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');
const decorators = { Service: () => (x) => x, Inject: () => () => {} };
const logger = { info() {}, warn() {}, error() {} };
const translate = { t: (x) => x, tf: (x) => x };
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-advisory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('environment values remain literal when the generated JavaScript loads', async () => {
  const output = {};
  const Env = load(path.resolve('back/services/env.ts'), {
    typedi: decorators,
    '../config': { envFile: 'sh', jsEnvFile: 'js', pyEnvFile: 'py' },
    '../data/env': { EnvStatus: { normal: 0 } },
    '../data': {},
    '../shared/utils': {
      writeFileWithLock: async (file, text) => (output[file] = text),
    },
  }).default;
  const service = new Env(logger);
  const values = [
    '${globalThis.injected = true}',
    'quotes\'"` \\ newline\n中文\u2028',
    '${1 + 2}',
  ];
  service.envs = async () =>
    values.map((value, i) => ({ name: `VALUE_${i}`, value }));
  await service.set_envs();
  const context = { process: { env: {} } };
  vm.runInNewContext(output.js, context);
  assert.equal(context.injected, undefined);
  values.forEach((value, i) =>
    assert.equal(context.process.env[`VALUE_${i}`], value),
  );
});

test('subscription shell parameters round trip without expansion or command substitution', () => {
  const { formatCommand } = load(path.resolve('back/config/subscription.ts'));
  const payload =
    'a $(printf INJECTED) `printf INJECTED` " ; echo BAD; # \' 中文\nnext';
  for (const type of ['file', 'repo']) {
    const fields =
      type === 'file'
        ? ['url', 'proxy']
        : [
            'url',
            'whitelist',
            'blacklist',
            'dependences',
            'branch',
            'extensions',
            'proxy',
          ];
    for (const field of fields) {
      const doc = {
        id: 12,
        type,
        url: 'https://example.invalid/repo',
        [field]: payload,
      };
      const command = formatCommand(doc);
      const stdout = execFileSync('/bin/bash', [
        '-c',
        `ql() { printf '%s\\0' "$@"; }; ${command}`,
      ]);
      const args = stdout.toString().split('\0').slice(0, -1);
      assert.equal(
        args[fields.indexOf(field) + 1],
        payload,
        `${type}:${field}`,
      );
      assert.equal(args[0], type === 'file' ? 'raw' : 'repo');
      assert.equal(args.length, fields.length + 3);
    }
  }
});

test('SSH alias traversal and symlinks cannot write or remove outside files', async (t) => {
  const base = temporary(t);
  const root = path.join(base, 'ssh');
  fs.mkdirSync(root);
  const outside = path.join(base, 'outside');
  fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(root, 'link'));
  const Ssh = load(path.resolve('back/services/sshKey.ts'), {
    typedi: decorators,
    '../config': { sshdPath: root },
    '../config/util': {
      rmPath: (p) => fs.promises.rm(p, { recursive: true, force: true }),
    },
    '../shared/utils': {
      writeFileWithLock: (p, value) => fs.promises.writeFile(p, value),
    },
  }).default;
  const service = Object.assign(Object.create(Ssh.prototype), {
    sshPath: root,
    logger,
  });
  for (const alias of [
    '../outside',
    '..',
    '.',
    '/tmp/outside',
    'link',
    'x\nHost *',
  ]) {
    await service.generatePrivateKeyFile(alias, 'overwrite');
    await service.removePrivateKeyFile(alias);
    await assert.rejects(service.generateSingleSshConfig(alias, 'github.com'));
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  }
  await service.generatePrivateKeyFile('仓库-main', 'private-key');
  await service.generateSingleSshConfig(
    '仓库-main',
    'github.com',
    '127.0.0.1:1080',
  );
  assert.equal(
    fs.readFileSync(path.join(root, '仓库-main'), 'utf8').trim(),
    'private-key',
  );
  await service.generatePrivateKeyFile('~global_default', 'global-key');
  await service.generateGlobalSshConfig('~global_default');
  assert.match(
    fs.readFileSync(path.join(root, '~global_default.config'), 'utf8'),
    /Host \*/,
  );
  await assert.rejects(
    service.generateSingleSshConfig('safe', 'host\nProxyCommand bad'),
  );
  await assert.rejects(
    service.generateSingleSshConfig('safe', 'host', '$(printf BAD)'),
  );
});

function cronService(config, updates = []) {
  const Cron = load(path.resolve('back/services/cron.ts'), {
    typedi: decorators,
    '../config': config,
    '../data/cron': {
      CrontabStatus: { running: 0, idle: 1, queued: 3 },
      CrontabModel: { update: async (v) => updates.push(v) },
    },
    '../data/runningInstance': { RunningInstanceModel: {}, InstanceStatus: {} },
    '../config/util': { fileExist: async (p) => fs.existsSync(p) },
    '../config/const': {},
    '../schedule/client': {},
    '../shared/pLimit': {},
    '../shared/utils': {},
    '../shared/i18n': translate,
    '../shared/logStreamManager': {},
    '../shared/cronSchedule': {},
  }).default;
  return new Cron(logger);
}
function subscriptionService(config, model = {}) {
  const Subscription = load(path.resolve('back/services/subscription.ts'), {
    typedi: decorators,
    '../config': config,
    '../data/subscription': {
      SubscriptionModel: model,
      SubscriptionStatus: {},
    },
    '../data/cron': {},
    '../config/util': { fileExist: async (p) => fs.existsSync(p) },
    '../config/const': {},
    '../shared/i18n': translate,
    '../shared/pLimit': {},
    '../shared/logStreamManager': {},
    './schedule': {},
    './sock': {},
    './sshKey': {},
    './cron': {},
  }).default;
  return new Subscription(logger, {}, {}, {}, {});
}

test('stored cron/subscription paths cannot read or enumerate outside the log root', async (t) => {
  const base = temporary(t);
  const root = path.join(base, 'log');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(base, 'outside'));
  const secret = path.join(base, 'outside', 'secret');
  fs.writeFileSync(secret, 'SECRET');
  fs.symlinkSync(path.dirname(secret), path.join(root, 'escape'));
  fs.writeFileSync(path.join(root, 'normal.log'), 'NORMAL');
  const updates = [];
  const cron = cronService({ logPath: root }, updates);
  const subscription = subscriptionService(
    { logPath: root },
    { update: async (v) => updates.push(v) },
  );
  for (const log_path of [secret, '../outside/secret', 'escape/secret']) {
    cron.getDb = subscription.getDb = async () => ({ log_path, status: 1 });
    await assert.rejects(cron.log(1), /outside the log directory/);
    await assert.rejects(cron.logs(1), /outside the log directory/);
    await assert.rejects(subscription.logs(1), /outside the log directory/);
    await assert.rejects(
      cron.status({ ids: [1], status: 0, log_path }),
      /outside the log directory/,
    );
    await assert.rejects(
      subscription.status({ ids: [1], status: 0, log_path }),
      /outside the log directory/,
    );
  }
  assert.equal(updates.length, 0);
  cron.getDb = subscription.getDb = async () => ({
    log_path: 'normal.log',
    status: 1,
  });
  assert.equal((await cron.log(1)).content, 'NORMAL');
  assert.ok((await cron.logs(1)).some((x) => x.filename === 'normal.log'));
  assert.ok(
    (await subscription.logs(1)).some((x) => x.filename === 'normal.log'),
  );
});

test('subscription aliases are checked before persistence and forced deletion', async (t) => {
  const base = temporary(t);
  for (const dir of ['scripts', 'repo']) fs.mkdirSync(path.join(base, dir));
  let writes = 0;
  const service = subscriptionService(
    {
      scriptPath: path.join(base, 'scripts'),
      repoPath: path.join(base, 'repo'),
    },
    {
      findAll: async () => [{ alias: '../victim' }],
      destroy: async () => writes++,
    },
  );
  service.insert = service.updateDb = async () => writes++;
  await assert.rejects(
    service.create({ alias: '../victim' }),
    /Invalid subscription alias/,
  );
  await assert.rejects(
    service.update({ alias: '../victim' }),
    /Invalid subscription alias/,
  );
  await assert.rejects(
    service.remove([1], { force: true }),
    /Invalid subscription alias/,
  );
  assert.equal(writes, 0);
});

function systemService(config, overrides = {}) {
  const System = load(path.resolve('back/services/system.ts'), {
    typedi: decorators,
    '../config': config,
    '../config/const': {},
    '../data/dependence': {
      DependenceModel: { findAll: async () => [] },
      DependenceTypes: {},
      DependenceStatus: {},
    },
    '../data/system': {},
    '../shared/pLimit': {},
    '../schedule/client': {},
    '../shared/i18n': { ...translate, setLang() {} },
    './notify': {},
    './schedule': {},
    './sock': {},
    '../config/util': {},
    ...overrides,
  }).default;
  return new System(logger, {}, {});
}

test('backup rejects unrecognized paths before spawning; valid export uses argv without a shell', async (t) => {
  const base = temporary(t);
  const calls = [];
  const service = systemService(
    {
      dataPath: path.join(base, 'data'),
      dataTgzFile: path.join(base, 'backup file.tgz'),
    },
    {
      child_process: {
        execFile: (...args) => {
          calls.push(args.slice(0, -1));
          args.at(-1)(null, '', '');
        },
      },
      '../config/util': {
        promiseExec: () => assert.fail('must not invoke shell'),
      },
    },
  );
  let downloaded = false;
  const res = {
    status() {
      return this;
    },
    send(body) {
      return body;
    },
    download() {
      downloaded = true;
    },
  };
  for (const entry of [
    '$(printf BAD)',
    '../outside',
    '/etc',
    'scripts;echo BAD',
    '--checkpoint-action=exec=bad',
  ]) {
    assert.equal((await service.exportData(res, [entry])).code, 400);
  }
  assert.equal(calls.length, 0);
  await service.exportData(res, ['base', 'scripts', 'config', 'scripts']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'tar');
  assert.deepEqual(calls[0][1].slice(2), [
    '--',
    'data/db',
    'data/upload',
    'data/scripts',
    'data/config',
  ]);
  assert.equal(calls[0][2].shell, undefined);
  assert.equal(downloaded, true);
});

test('proxy, language and mirror settings stay literal at their shell boundaries', async (t) => {
  const base = temporary(t);
  const commands = [];
  const service = systemService(
    {
      dependenceProxyFile: path.join(base, 'proxy.sh'),
      langEnvFile: path.join(base, 'lang.sh'),
    },
    {
      '../config/util': {
        promiseExec: async (command) => commands.push(command),
      },
    },
  );
  service.getSystemConfig = async () => ({ info: {} });
  service.updateAuthDb = async () => {};
  service.scheduleService = { runTask: (command) => commands.push(command) };
  const value = 'x\'$(printf BAD)`printf BAD`"; echo BAD; #';
  await service.updateDependenceProxy({ dependenceProxy: value });
  await service.updateLanguage({ lang: value });
  const stdout = execFileSync('/bin/bash', [
    '-c',
    'source "$1"; source "$2"; printf "%s\\0%s" "$http_proxy" "$QL_LANG"',
    'bash',
    path.join(base, 'proxy.sh'),
    path.join(base, 'lang.sh'),
  ]).toString();
  assert.equal(stdout, value + '\0' + value);
  await service.updatePythonMirror({ pythonMirror: value });
  await service.updateNodeMirror({ nodeMirror: value });
  for (const command of commands) {
    const stdout = execFileSync('/bin/bash', [
      '-c',
      `pip3() { printf '%s\\0' "$@"; }; pnpm() { printf '%s\\0' "$@"; }; ${command}`,
    ]).toString();
    assert.equal(stdout.split('\0').at(-2), value);
  }
  assert.equal((await service.reloadSystem('$(printf BAD)')).code, 400);
});

test('the ignored-log sentinel remains supported without exposing device files', async (t) => {
  const root = temporary(t);
  const cron = cronService({ logPath: root });
  cron.getDb = async () => ({ log_path: '/dev/null', log_name: '/dev/null' });
  assert.equal((await cron.log(1)).status, 'ignored');
  assert.deepEqual(await cron.logs(1), []);
  await cron.status({ ids: [], status: 0, log_path: '/dev/null' });
  await assert.rejects(
    cron.status({ ids: [], status: 0, log_path: '/dev/zero' }),
  );
});

test('normal backup creates an archive containing the selected data directories', async (t) => {
  const base = temporary(t);
  const dataPath = path.join(base, 'data');
  for (const name of ['db', 'upload', 'scripts'])
    fs.mkdirSync(path.join(dataPath, name), { recursive: true });
  fs.writeFileSync(path.join(dataPath, 'scripts/example.js'), 'literal script');
  const dataTgzFile = path.join(base, 'backup with spaces.tgz');
  const service = systemService({ dataPath, dataTgzFile });
  let downloaded;
  await service.exportData(
    {
      download(file) {
        downloaded = file;
      },
      send(error) {
        assert.fail(JSON.stringify(error));
      },
    },
    ['scripts'],
  );
  assert.equal(downloaded, dataTgzFile);
  const content = execFileSync('tar', [
    '-xzOf',
    dataTgzFile,
    'data/scripts/example.js',
  ]).toString();
  assert.equal(content, 'literal script');
});
