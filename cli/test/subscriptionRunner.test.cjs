const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createContext } = require('../dist/local/context');
const {
  syncRepository,
  repositoryName,
  cronMetadata,
} = require('../dist/local/subscriptionRunner');

const git = process.platform === 'darwin' ? '/usr/bin/git' : 'git';

test('repository metadata matches legacy names and cron annotations', () => {
  assert.equal(
    repositoryName('https://github.com/owner/repo.git', 'main'),
    'owner_repo_main',
  );
  assert.equal(repositoryName('git@github.com:owner/repo.git'), 'owner_repo');
  assert.deepEqual(
    cronMetadata(
      'const $ = new Env("Example");\n// cron: 0 9 * * *',
      'example.js',
      '1 1 * * *',
    ),
    { name: 'Example', schedule: '0 9 * * *' },
  );
});

test('local repository sync copies selected scripts/dependencies and preserves last good version on clone failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'owner/repository');
  fs.mkdirSync(path.join(source, 'lib'), { recursive: true });
  const execute = (args) =>
    execFileSync(git, args, { cwd: source, stdio: 'ignore' });
  execute(['init']);
  fs.writeFileSync(path.join(source, 'main.js'), 'v1');
  fs.writeFileSync(path.join(source, 'skip.js'), 'skip');
  fs.writeFileSync(path.join(source, 'lib/helper.js'), 'helper');
  execute(['add', '.']);
  execute([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'fixture',
  ]);
  const context = createContext(
    { root },
    {
      PATH:
        process.platform === 'darwin'
          ? `/usr/bin:/bin:${process.env.PATH}`
          : process.env.PATH,
    },
  );
  const input = {
    url: source,
    include: 'main',
    dependencies: 'lib/',
    autoAdd: false,
    autoDelete: false,
  };
  const result = await syncRepository(context, input);
  assert.deepEqual(result.files, ['owner_repository/main.js']);
  const destination = path.join(context.paths.dir_scripts, 'owner_repository');
  assert.equal(
    fs.readFileSync(path.join(destination, 'main.js'), 'utf8'),
    'v1',
  );
  assert.equal(
    fs.readFileSync(path.join(destination, 'lib/helper.js'), 'utf8'),
    'helper',
  );
  assert.equal(fs.existsSync(path.join(destination, 'skip.js')), false);
  fs.renameSync(source, source + '.unavailable');
  await assert.rejects(syncRepository(context, input));
  assert.equal(
    fs.readFileSync(path.join(destination, 'main.js'), 'utf8'),
    'v1',
  );
});

test('subscription reconciliation scopes removals to canonical paths and the current subscription', async (t) => {
  const http = require('node:http');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-reconcile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'owner/repository');
  fs.mkdirSync(source, { recursive: true });
  const run = (args) =>
    execFileSync(git, args, { cwd: source, stdio: 'ignore' });
  run(['init']);
  fs.writeFileSync(
    path.join(source, 'new.js'),
    '// cron: 0 9 * * *\nnew Env("New task")',
  );
  run(['add', '.']);
  run([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const context = createContext(
    { root },
    { PATH: `/usr/bin:/bin:${process.env.PATH}` },
  );
  const requests = [];
  const rows = [
    { id: 1, sub_id: 7, command: 'task owner_repository/old.js' },
    { id: 2, sub_id: 8, command: 'task owner_repository/other.js' },
    { id: 3, sub_id: 7, command: 'task owner_repository/../outside.js' },
    { id: 4, sub_id: 7, command: 'task owner_repository_other/old.js' },
  ];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({
      method: req.method,
      url: req.url,
      body: body ? JSON.parse(body) : undefined,
    });
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        code: 200,
        data: req.method === 'GET' ? { data: rows, total: rows.length } : {},
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  context.env.QlPort = String(server.address().port);
  fs.mkdirSync(context.paths.dir_config, { recursive: true });
  fs.writeFileSync(
    context.paths.file_auth_token,
    JSON.stringify({
      value: 'fixture-token',
      expiration: Date.now() / 1000 + 1000,
    }),
  );
  const dest = path.join(context.paths.dir_scripts, 'owner_repository');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'old.js'), 'old');
  fs.writeFileSync(path.join(dest, 'other.js'), 'other');
  fs.writeFileSync(
    path.join(context.paths.dir_scripts, 'outside.js'),
    'outside',
  );
  const result = await syncRepository(context, {
    url: source,
    subscriptionId: 7,
    autoAdd: true,
    autoDelete: true,
  });
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  assert.deepEqual(requests.find((r) => r.method === 'DELETE').body, [1]);
  assert.deepEqual(requests.find((r) => r.method === 'POST').body, {
    name: 'New task',
    schedule: '0 9 * * *',
    command: 'task owner_repository/new.js',
    sub_id: 7,
  });
  assert.equal(fs.existsSync(path.join(dest, 'old.js')), false);
  assert.equal(fs.readFileSync(path.join(dest, 'other.js'), 'utf8'), 'other');
  assert.equal(
    fs.readFileSync(path.join(context.paths.dir_scripts, 'outside.js'), 'utf8'),
    'outside',
  );
});

test('raw download failure preserves the last script and does not reconcile tasks', async (t) => {
  const { syncRaw } = require('../dist/local/subscriptionRunner');
  const http = require('node:http');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-raw-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = createContext(
    { root },
    { PATH: `/usr/bin:/bin:${process.env.PATH}` },
  );
  let failed = false;
  const server = http.createServer((req, res) => {
    res.writeHead(failed ? 503 : 200);
    res.end(failed ? 'failed' : '// version one');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const input = {
    url: `http://127.0.0.1:${server.address().port}/owner/file.js`,
    autoAdd: false,
    autoDelete: false,
  };
  const result = await syncRaw(context, input);
  const installed = path.join(context.paths.dir_scripts, result.file);
  assert.equal(fs.readFileSync(installed, 'utf8'), '// version one');
  failed = true;
  await assert.rejects(syncRaw(context, input));
  assert.equal(fs.readFileSync(installed, 'utf8'), '// version one');
  assert.ok(
    fs
      .readdirSync(context.paths.dir_raw)
      .every((name) => !name.endsWith('.tmp')),
  );
});

test('directory replacement stages on the destination filesystem before switching old files', async (t) => {
  const fsp = require('node:fs/promises');
  const { replaceDirectory } = require('../dist/local/subscriptionRunner');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-cross-device-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, 'staged'),
    destination = path.join(root, 'data/scripts');
  fs.mkdirSync(staged);
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(staged, 'new'), 'new');
  fs.writeFileSync(path.join(destination, 'old'), 'old');
  const rename = fsp.rename.bind(fsp),
    copy = fsp.cp.bind(fsp);
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (from === staged)
      throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' });
    return rename(from, to);
  });
  let copied = false;
  t.mock.method(fsp, 'cp', async (from, to, options) => {
    assert.equal(fs.readFileSync(path.join(destination, 'old'), 'utf8'), 'old');
    await copy(from, to, options);
    copied = true;
  });
  await replaceDirectory(staged, destination);
  assert.equal(copied, true);
  assert.deepEqual(fs.readdirSync(destination), ['new']);
  assert.ok(
    fs
      .readdirSync(path.dirname(destination))
      .every(
        (name) => !name.endsWith('.incoming') && !name.endsWith('.previous'),
      ),
  );
});

test('cross-filesystem preparation failure leaves the old subscription directory untouched', async (t) => {
  const fsp = require('node:fs/promises');
  const { replaceDirectory } = require('../dist/local/subscriptionRunner');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-copy-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, 'staged'),
    destination = path.join(root, 'destination');
  fs.mkdirSync(staged);
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'old'), 'old');
  const rename = fsp.rename.bind(fsp);
  t.mock.method(fsp, 'rename', async (from, to) => {
    if (from === staged)
      throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
    return rename(from, to);
  });
  t.mock.method(fsp, 'cp', async (from, to) => {
    await fsp.mkdir(to);
    throw new Error('fixture disk full');
  });
  await assert.rejects(
    replaceDirectory(staged, destination),
    /fixture disk full/,
  );
  assert.equal(fs.readFileSync(path.join(destination, 'old'), 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(root).sort(), ['destination', 'staged']);
});

test('subscription copy precedence preserves local dependencies while selected scripts win', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-copy-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'owner/repository');
  fs.mkdirSync(path.join(source, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(source, 'main.js'), 'selected-task');
  fs.writeFileSync(path.join(source, 'lib/helper.js'), 'repository-helper');
  fs.writeFileSync(path.join(source, 'sendNotify.js'), 'repository-notify');
  const run = (args) =>
    execFileSync(git, args, { cwd: source, stdio: 'ignore' });
  run(['init']);
  run(['add', '.']);
  run([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'fixture',
  ]);
  const context = createContext(
    { root },
    { PATH: `/usr/bin:/bin:${process.env.PATH}` },
  );
  fs.mkdirSync(path.join(context.paths.dir_dep, 'lib'), { recursive: true });
  fs.mkdirSync(context.paths.dir_config, { recursive: true });
  fs.mkdirSync(context.paths.dir_scripts, { recursive: true });
  fs.writeFileSync(context.paths.file_notify_js, 'default-notify');
  fs.writeFileSync(context.paths.file_notify_py, 'default-python-notify');
  fs.writeFileSync(
    path.join(context.paths.dir_dep, 'lib/helper.js'),
    'local-helper',
  );
  fs.writeFileSync(path.join(context.paths.dir_dep, 'main.js'), 'local-main');
  fs.writeFileSync(
    path.join(context.paths.dir_dep, 'sendNotify.js'),
    'local-notify',
  );
  const input = {
    url: source,
    include: '^main',
    dependencies: 'lib/|sendNotify',
    autoAdd: false,
    autoDelete: false,
  };
  const result = await syncRepository(context, input);
  const destination = path.join(context.paths.dir_scripts, 'owner_repository');
  assert.deepEqual(result.files, ['owner_repository/main.js']);
  assert.equal(
    fs.readFileSync(path.join(destination, 'main.js'), 'utf8'),
    'selected-task',
  );
  assert.equal(
    fs.readFileSync(path.join(destination, 'lib/helper.js'), 'utf8'),
    'local-helper',
  );
  assert.equal(
    fs.readFileSync(path.join(destination, 'sendNotify.js'), 'utf8'),
    'local-notify',
  );
  const legacyRoot = path.join(root, 'legacy');
  fs.mkdirSync(path.join(legacyRoot, 'owner_repository'), { recursive: true });
  fs.mkdirSync(context.paths.dir_list_tmp, { recursive: true });
  fs.writeFileSync(context.paths.list_crontab_user, '');
  const original = fs.readFileSync(
    path.resolve(__dirname, '../../shell/update.sh'),
    'utf8',
  );
  const definition = original.match(/^gen_list_repo\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(definition);
  execFileSync(
    '/bin/bash',
    [
      '-c',
      definition +
        '\nmake_dir() { mkdir -p "$@"; }\ngen_list_repo "$SOURCE" owner "^main" "" "lib/|sendNotify" js',
    ],
    {
      env: {
        ...context.env,
        SOURCE: source,
        dir_scripts: legacyRoot,
        dir_list_tmp: context.paths.dir_list_tmp,
        dir_dep: context.paths.dir_dep,
        file_notify_js: context.paths.file_notify_js,
        file_notify_py: context.paths.file_notify_py,
        list_crontab_user: context.paths.list_crontab_user,
        uniq_path: 'owner_repository',
        cmd_task: 'task',
      },
      stdio: 'pipe',
      timeout: 10000,
    },
  );
  for (const file of ['main.js', 'lib/helper.js', 'sendNotify.js'])
    assert.equal(
      fs.readFileSync(path.join(destination, file), 'utf8'),
      fs.readFileSync(path.join(legacyRoot, 'owner_repository', file), 'utf8'),
    );
  fs.unlinkSync(path.join(context.paths.dir_dep, 'sendNotify.js'));
  await syncRepository(context, input);
  assert.equal(
    fs.readFileSync(path.join(destination, 'sendNotify.js'), 'utf8'),
    'repository-notify',
  );
});

test('cron metadata precedence agrees with unchanged legacy add_cron', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-cron-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = fs.readFileSync(
    path.resolve(__dirname, '../../shell/update.sh'),
    'utf8',
  );
  const definition = original.match(/^add_cron\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(definition);
  fs.mkdirSync(path.join(root, 'repo'));
  fs.writeFileSync(path.join(root, 'list'), 'repo/example.js\n');
  for (const contents of [
    '// cron: 0 9 * * *\n// 10 2 * * * example.js\nconst $ = new Env("Example");',
    '// 50 8 * * * example.js\n// 10 2 * * * example.js\n// cron: 0 9 * * *\nconst $ = new Env("Example");',
    '// cron: 0 9 * * *\nconst $ = new Env("Example");',
    'console.log("no metadata");',
  ]) {
    fs.writeFileSync(path.join(root, 'repo/example.js'), contents);
    const output = execFileSync(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `${definition}\nt() { :; }\nnotify_api() { :; }\nadd_cron_api() { printf '%s' "$1"; }\nadd_cron "$dir_scripts/list" repo`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `/usr/bin:/bin:${process.env.PATH}`,
          LC_ALL: 'C',
          dir_scripts: root,
          cmd_task: 'task',
          default_cron: '1 1 * * *',
          SUB_ID: '7',
        },
      },
    ).trim();
    const [schedule, , name] = output.split(':');
    assert.deepEqual(cronMetadata(contents, 'example.js', '1 1 * * *'), {
      schedule,
      name,
    });
  }
});
