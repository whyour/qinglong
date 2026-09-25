const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  prepareContainerEnvironment,
} = require('../../dist/internal/runtime/containerEnvironment');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-container-env-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'panel');
  const data = path.join(base, 'external/data');
  const systemDirectory = path.join(base, 'etc');
  for (const dir of [root, data, systemDirectory])
    await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(systemDirectory, 'alpine-release'), '3.20');
  return {
    root,
    data,
    systemDirectory,
    env: { PATH: process.env.PATH, HOME: path.join(base, 'absent') },
  };
}

test('container preparation retains data and existing temporary files, and does not mutate caller environment', async (t) => {
  const options = await fixture(t);
  const original = { ...options.env };
  await fs.mkdir(path.join(options.root, '.tmp'));
  await fs.writeFile(path.join(options.root, '.tmp/keep'), 'pending upgrade');
  await fs.writeFile(path.join(options.data, 'keep'), 'user data');
  const result = await prepareContainerEnvironment(options);
  assert.equal(result.env.HOME, path.join(options.root, '.tmp'));
  assert.deepEqual(options.env, original);
  assert.deepEqual(await fs.readdir(options.data), ['keep']);
  assert.equal(
    await fs.readFile(path.join(options.root, '.tmp/keep'), 'utf8'),
    'pending upgrade',
  );
  assert.deepEqual(result.warnings, []);
});

test('network initialization appends complete lines once and matches localhost as a hostname token', async (t) => {
  const options = await fixture(t);
  const hosts = path.join(options.systemDirectory, 'hosts');
  const resolv = path.join(options.systemDirectory, 'resolv.conf');
  await fs.writeFile(
    hosts,
    '# 127.0.0.1 localhost\n127.0.0.1 localhost.example\n::1 alias localhost',
  );
  await fs.writeFile(resolv, 'nameserver 127.0.0.11');
  await prepareContainerEnvironment(options);
  const expectedHosts =
    '# 127.0.0.1 localhost\n127.0.0.1 localhost.example\n::1 alias localhost\n127.0.0.1 localhost\n';
  assert.equal(await fs.readFile(hosts, 'utf8'), expectedHosts);
  assert.equal(
    await fs.readFile(resolv, 'utf8'),
    'nameserver 127.0.0.11\noptions ndots:0\n',
  );
  await prepareContainerEnvironment(options);
  assert.equal(await fs.readFile(hosts, 'utf8'), expectedHosts);
  assert.equal(
    await fs.readFile(resolv, 'utf8'),
    'nameserver 127.0.0.11\noptions ndots:0\n',
  );
});

test('existing HOME, DNS options and non-Alpine DNS are preserved', async (t) => {
  const options = await fixture(t);
  options.env.HOME = options.root;
  const resolv = path.join(options.systemDirectory, 'resolv.conf');
  await fs.writeFile(resolv, 'options timeout:1 ndots:0 # configured\n');
  assert.equal(
    (await prepareContainerEnvironment(options)).env.HOME,
    options.root,
  );
  assert.equal(
    await fs.readFile(resolv, 'utf8'),
    'options timeout:1 ndots:0 # configured\n',
  );
  await fs.rm(path.join(options.systemDirectory, 'alpine-release'));
  await fs.writeFile(resolv, 'nameserver 1.2.3.4');
  await prepareContainerEnvironment(options);
  assert.equal(await fs.readFile(resolv, 'utf8'), 'nameserver 1.2.3.4');
});

test('network failures are reported without hiding permission preflight errors', async (t) => {
  const options = await fixture(t);
  await fs.mkdir(path.join(options.systemDirectory, 'hosts'));
  const result = await prepareContainerEnvironment(options);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /hosts[:：] ?EISDIR/);
  const absent = path.join(options.root, 'absent');
  await assert.rejects(
    prepareContainerEnvironment({ ...options, data: absent }),
    /not writable\/searchable|不可写或不可访问/,
  );
  await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
  await assert.rejects(
    prepareContainerEnvironment({ ...options, root: 'relative' }),
    /absolute paths|必须为绝对路径/,
  );
});

test(
  'non-root preflight rejects an inaccessible data directory without creating volume files',
  { skip: process.getuid?.() === 0 },
  async (t) => {
    const options = await fixture(t);
    await fs.chmod(options.data, 0o400);
    try {
      await assert.rejects(
        prepareContainerEnvironment(options),
        /not writable\/searchable|不可写或不可访问/,
      );
    } finally {
      await fs.chmod(options.data, 0o700);
    }
    assert.deepEqual(await fs.readdir(options.data), []);
    assert.deepEqual(await fs.readdir(options.systemDirectory), [
      'alpine-release',
    ]);
  },
);

for (const language of ['zh', 'en', 'unsupported']) {
  test(`container preflight and network warnings preserve language and data: ${language}`, async (t) => {
    const options = await fixture(t);
    options.env.QL_LANG = language;
    const expected = (zh, en) => (language === 'en' ? en : zh);
    await assert.rejects(
      prepareContainerEnvironment({ ...options, root: 'relative' }),
      (error) => {
        assert.equal(error.exitCode, 2);
        assert.match(
          error.message,
          expected(/必须为绝对路径/, /absolute paths/),
        );
        return true;
      },
    );
    const absent = path.join(options.root, 'missing-data');
    await assert.rejects(
      prepareContainerEnvironment({ ...options, data: absent }),
      expected(/不可写或不可访问/, /not writable\/searchable/),
    );
    await assert.rejects(fs.access(absent), { code: 'ENOENT' });
    await fs.writeFile(path.join(options.data, 'retained'), 'keep');
    await fs.mkdir(path.join(options.systemDirectory, 'hosts'));
    const result = await prepareContainerEnvironment(options);
    assert.equal(result.warnings.length, 1);
    assert.match(
      result.warnings[0],
      expected(/无法初始化.*EISDIR/, /Cannot initialize.*EISDIR/),
    );
    assert.equal(
      await fs.readFile(path.join(options.data, 'retained'), 'utf8'),
      'keep',
    );
  });
}
