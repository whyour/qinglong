const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const load = require('../helpers/load-security-module.cjs');
const { getSubscriptionStorageNames, getSubscriptionStorageCandidates } = load(
  'back/shared/subscriptionStorage.ts',
);
const { formatUrl } = load('back/config/subscription.ts');
const cases = [
  {
    type: 'public-repo',
    url: 'git://127.0.0.1:9418/public.git',
    branch: 'main',
  },
  {
    type: 'public-repo',
    url: 'https://github.com/owner/repo.git',
    branch: 'feature/release+hotfix',
  },
  { type: 'public-repo', url: 'https://github.com/owner/repo.git/' },
  {
    type: 'private-repo',
    pull_type: 'ssh-key',
    url: 'root@127.0.0.1:/qa/fixtures/private.git',
    branch: 'main',
  },
  {
    type: 'private-repo',
    pull_type: 'ssh-key',
    url: 'git@github.com:owner/repo.git',
    branch: 'dev',
  },
  {
    type: 'private-repo',
    pull_type: 'user-pwd',
    pull_option: { username: 'tester', password: 'password' },
    url: 'http://127.0.0.1:8788/git/http_private.git',
    branch: 'main',
  },
  { type: 'file', url: 'http://127.0.0.1:8788/raw.js' },
  { type: 'file', url: 'https://example.com/owner/job.py', branch: 'ignored' },
].map((doc, index) => ({
  ...doc,
  id: index + 1,
  alias: `custom/alias+${index}`,
}));
const source = fs.readFileSync('shell/update.sh', 'utf8');
const bashFunction = source.match(/^get_uniq_path\(\) \{[\s\S]*?^\}/m)[0];
function shellNames(doc) {
  const url = formatUrl(doc).url;
  const stem = execFileSync(
    'bash',
    [
      '-c',
      `${bashFunction}\nget_uniq_path "$1" "$2"\nprintf '%s' "$uniq_path"`,
      '--',
      url,
      doc.type === 'file' ? '' : doc.branch || '',
    ],
    { encoding: 'utf8' },
  );
  if (doc.type === 'file') {
    const raw = `${stem}.${url.slice(url.lastIndexOf('.') + 1)}`;
    return { script: `raw_${raw}`, raw };
  }
  return { script: stem, repo: stem };
}

test('subscription deletion paths match the actual shell URL/branch naming for public, private and raw subscriptions', () => {
  for (const doc of cases)
    assert.deepEqual(
      getSubscriptionStorageNames(doc),
      shellNames(doc),
      doc.url,
    );
});

function fixture(t, values) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    dataPath: root,
    scriptPath: path.join(root, 'scripts'),
    repoPath: path.join(root, 'repo'),
  };
  fs.mkdirSync(config.scriptPath, { recursive: true });
  fs.mkdirSync(config.repoPath, { recursive: true });
  const events = [];
  const docs = values.map((value) => ({
    ...value,
    get() {
      return { ...this };
    },
  }));
  const Service = load('back/services/subscription.ts', {
    '../config': config,
    '../data/subscription': {
      Subscription: class {
        constructor(value) {
          Object.assign(this, value);
        }
      },
      SubscriptionModel: {
        findAll: async ({ where }) =>
          docs.filter((doc) => !where.id || where.id.includes(doc.id)),
        create: async (value) => {
          const doc = {
            ...value,
            get() {
              return { ...this };
            },
          };
          docs.push(doc);
          return doc;
        },
        findOne: async ({ where }) => docs.find((doc) => doc.id === where.id),
        update: async (value, { where }) => {
          Object.assign(
            docs.find((doc) => doc.id === where.id),
            value,
          );
        },
        destroy: async ({ where }) => {
          events.push('destroy');
          for (let i = docs.length - 1; i >= 0; i--) {
            if (where.id.includes(docs[i].id)) docs.splice(i, 1);
          }
        },
      },
    },
    '../data/cron': { CrontabModel: { findAll: async () => [{ id: 99 }] } },
    '../config/util': {
      rmPath: (p) => fs.promises.rm(p, { recursive: true, force: true }),
    },
    '../config/const': {},
    '../shared/i18n': { t: (x) => x, tf: (x) => x },
    '../shared/pLimit': {},
    './schedule': {},
    './sock': {},
    './sshKey': {},
    './cron': {},
  }).default;
  const service = new Service(
    {},
    {},
    {},
    { removeSSHKey: async (alias) => events.push(['key', alias]) },
    { remove: async (ids) => events.push(['crons', ids]) },
  );
  service.handleTask = async () => events.push('cancel');
  service.setSshConfig = async () => {};
  const paths = (doc) =>
    Object.entries(shellNames(doc)).map(([kind, name]) =>
      path.join(
        kind === 'script'
          ? config.scriptPath
          : kind === 'repo'
          ? config.repoPath
          : path.join(root, 'raw'),
        name,
      ),
    );
  const write = (target) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'fixture');
  };
  return { root, config, docs, events, service, paths, write };
}

test('force deletion cleans URL-derived clone/script/raw artifacts and associated jobs, preserving unrelated alias folders', async (t) => {
  const f = fixture(t, cases);
  const artifacts = [];
  for (const doc of cases) {
    for (const dir of f.paths(doc)) {
      const artifact = doc.type === 'file' ? dir : path.join(dir, 'job.js');
      artifacts.push(artifact);
      f.write(artifact);
    }
    f.write(path.join(f.config.scriptPath, doc.alias, 'unrelated.js'));
  }
  await f.service.remove(
    cases.map((doc) => doc.id),
    { force: true },
  );
  for (const artifact of artifacts)
    assert.equal(fs.existsSync(artifact), false, artifact);
  for (const doc of cases)
    assert.equal(
      fs.readFileSync(
        path.join(f.config.scriptPath, doc.alias, 'unrelated.js'),
        'utf8',
      ),
      'fixture',
    );
  assert.ok(f.events.some((e) => Array.isArray(e) && e[0] === 'crons'));
  assert.equal(
    f.events.filter((e) => Array.isArray(e) && e[0] === 'key').length,
    2,
  );
});

test('ordinary deletion preserves subscription artifacts', async (t) => {
  const f = fixture(t, [cases[0]]);
  const file = path.join(f.paths(cases[0])[0], 'job.js');
  f.write(file);
  await f.service.remove([1], {});
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixture');
});

test('a URL-derived symlink escape rejects the entire force deletion before cancelling jobs or deleting rows', async (t) => {
  const f = fixture(t, [cases[0], cases[6]]);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  fs.mkdirSync(f.config.repoPath, { recursive: true });
  fs.symlinkSync(outside, f.paths(cases[0])[1]);
  await assert.rejects(
    f.service.remove([1, 7], { force: true }),
    /Invalid subscription path/,
  );
  assert.deepEqual(f.events, []);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
});

const cliCases = [
  {
    type: 'public-repo',
    url: 'https://github.com/owner/repo.git/',
    branch: 'main',
  },
  {
    type: 'private-repo',
    url: 'git@github.com:repo.git',
    branch: 'main',
    pull_type: 'ssh-key',
  },
  { type: 'file', url: 'https://example.com/owner/job.py?version=2' },
  { type: 'file', url: 'https://example.com/owner/job' },
].map((doc, index) => ({ ...doc, id: index + 1, alias: `cli-${index}` }));

test('cleanup candidates match both actual CLI naming and legacy Shell naming', () => {
  const { repositoryName } = load(
    'cli/src/internal/subscription/subscriptionRunner.ts',
  );
  for (const doc of [...cases, ...cliCases]) {
    const url = formatUrl(doc).url;
    const stem = repositoryName(
      url,
      doc.type === 'file' ? undefined : doc.branch,
    );
    const raw =
      doc.type === 'file'
        ? stem + path.extname(new URL(url).pathname)
        : undefined;
    assert.deepEqual(
      getSubscriptionStorageNames(doc, 'cli'),
      raw === undefined
        ? { script: stem, repo: stem }
        : { script: `raw_${raw}`, raw },
    );
    assert.deepEqual(getSubscriptionStorageNames(doc), shellNames(doc));
  }
});

test('force deletion removes CLI and legacy artifacts for trailing slashes, SCP URLs and raw URL queries', async (t) => {
  const f = fixture(t, cliCases);
  const artifacts = [];
  for (const doc of cliCases)
    for (const names of getSubscriptionStorageCandidates(doc)) {
      for (const [kind, name] of Object.entries(names)) {
        const base =
          kind === 'script'
            ? f.config.scriptPath
            : kind === 'repo'
            ? f.config.repoPath
            : path.join(f.root, 'raw');
        const target = path.join(
          base,
          name,
          ...(doc.type === 'file' ? [] : ['job.js']),
        );
        artifacts.push(target);
        f.write(target);
      }
    }
  await f.service.remove(
    cliCases.map((doc) => doc.id),
    { force: true },
  );
  for (const file of artifacts) assert.equal(fs.existsSync(file), false, file);
});

for (const type of ['public-repo', 'file']) {
  test(`force deletion retains shared ${type} artifacts until the last subscription is removed`, async (t) => {
    const first = { ...cases[type === 'file' ? 6 : 0], id: 1, alias: 'first' };
    const second = { ...first, id: 2, alias: 'second' };
    const f = fixture(t, [first, second]);
    const artifacts = f
      .paths(first)
      .map((p) => (type === 'file' ? p : path.join(p, 'job.js')));
    artifacts.forEach(f.write);
    await f.service.remove([1], { force: true });
    for (const file of artifacts) assert.equal(fs.existsSync(file), true, file);
    await f.service.remove([2], { force: true });
    for (const file of artifacts)
      assert.equal(fs.existsSync(file), false, file);
  });
}

test('batch deletion of every reference removes shared storage once', async (t) => {
  const f = fixture(t, [
    { ...cases[0], id: 1 },
    { ...cases[0], id: 2, alias: 'second' },
  ]);
  const artifacts = f.paths(cases[0]).map((p) => path.join(p, 'job.js'));
  artifacts.forEach(f.write);
  await f.service.remove([1, 2], { force: true });
  for (const file of artifacts) assert.equal(fs.existsSync(file), false, file);
});

test('recursive cleanup retains overlapping parent and nested branch directories', async (t) => {
  const parent = { ...cases[0], id: 1, branch: 'main', alias: 'parent' };
  const child = { ...parent, id: 2, branch: 'main/nested', alias: 'child' };
  for (const removed of [1, 2]) {
    const f = fixture(t, [parent, child]);
    const artifacts = [parent, child].flatMap((doc) =>
      f.paths(doc).map((p) => path.join(p, 'job.js')),
    );
    artifacts.forEach(f.write);
    await f.service.remove([removed], { force: true });
    for (const file of artifacts) assert.equal(fs.existsSync(file), true, file);
  }
});

test('unrelated malformed historical rows do not block force deletion, and malformed shared references still retain storage', async (t) => {
  const selected = { ...cases[1], id: 1, branch: 'main', alias: 'selected' };
  for (const shared of [false, true]) {
    const invalid = {
      id: 2,
      alias: '../historical',
      type: 'private-repo',
      pull_type: 'ssh-key',
      url: `git@github.com:${shared ? 'owner/repo' : 'other/unrelated'}.git`,
      branch: 'main',
    };
    const f = fixture(t, [selected, invalid]);
    const files = f.paths(selected).map((p) => path.join(p, 'job.js'));
    files.forEach(f.write);
    await f.service.remove([1], { force: true });
    assert.deepEqual(
      f.docs.map((doc) => doc.id),
      [2],
    );
    for (const file of files) assert.equal(fs.existsSync(file), shared);
  }
});

test('an unused invalid Shell candidate does not block cleanup of the valid CLI raw files', async (t) => {
  const doc = {
    id: 1,
    alias: 'valid-cli-raw',
    type: 'file',
    url: 'https://example.com/job.js?source=https://foo/bar',
  };
  const f = fixture(t, [doc]);
  const names = getSubscriptionStorageNames(doc, 'cli');
  const files = [
    path.join(f.config.scriptPath, names.script),
    path.join(f.root, 'raw', names.raw),
  ];
  files.forEach(f.write);
  await f.service.remove([1], { force: true });
  assert.deepEqual(f.docs, []);
  for (const file of files) assert.equal(fs.existsSync(file), false);
});

for (const mutation of ['create', 'update']) {
  test(`force deletion prevents a concurrent ${mutation} from changing ownership after its reference snapshot`, async (t) => {
    const selected = { ...cases[0], id: 1, alias: 'selected' };
    const other = {
      ...selected,
      id: 2,
      alias: 'other',
      url: 'https://github.com/other/unrelated.git',
    };
    const f = fixture(
      t,
      mutation === 'update' ? [selected, other] : [selected],
    );
    let release, entered;
    const gate = new Promise((resolve) => (release = resolve));
    const held = new Promise((resolve) => (entered = resolve));
    t.after(() => release());
    f.service.handleTask = async (doc, needCreate) => {
      if (doc.id === 1 && needCreate === false) {
        entered();
        await gate;
      }
    };
    const deletion = f.service.remove([1], { force: true });
    await held;
    const change = f.service[mutation]({ ...selected, id: 2, alias: 'other' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (mutation === 'create')
      assert.deepEqual(
        f.docs.map((doc) => doc.id),
        [1],
      );
    else assert.equal(f.docs.find((doc) => doc.id === 2).url, other.url);
    release();
    await Promise.all([deletion, change]);
    assert.equal(f.docs.find((doc) => doc.id === 2).url, selected.url);
  });

  test(`force deletion observes shared storage ownership established by an in-flight ${mutation}`, async (t) => {
    const selected = { ...cases[0], id: 1, alias: 'selected' };
    const other = {
      ...selected,
      id: 2,
      alias: 'other',
      url: 'https://github.com/other/unrelated.git',
    };
    const f = fixture(
      t,
      mutation === 'update' ? [selected, other] : [selected],
    );
    const file = path.join(f.paths(selected)[0], 'job.js');
    f.write(file);
    let release, entered;
    const gate = new Promise((resolve) => (release = resolve));
    const held = new Promise((resolve) => (entered = resolve));
    t.after(() => release());
    f.service.handleTask = async (doc, needCreate) => {
      if (doc.id === 2 && needCreate !== false) {
        entered();
        await gate;
      }
    };
    const change = f.service[mutation]({ ...selected, id: 2, alias: 'other' });
    await held;
    const deletion = f.service.remove([1], { force: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(
      f.docs.some((doc) => doc.id === 1),
      'deletion waits until the ownership mutation is complete',
    );
    release();
    await Promise.all([change, deletion]);
    assert.deepEqual(
      f.docs.map((doc) => doc.id),
      [2],
    );
    assert.equal(fs.existsSync(file), true);
  });
}

test('an unrelated dangling or outside symlink reference does not block safe cleanup', async (t) => {
  const selected = { ...cases[0], id: 1, alias: 'selected' };
  const other = {
    ...selected,
    id: 2,
    alias: 'other',
    url: 'https://github.com/other/repo.git',
  };
  const f = fixture(t, [selected, other]);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  fs.symlinkSync(outside, f.paths(other)[0]);
  const file = path.join(f.paths(selected)[0], 'job.js');
  f.write(file);
  await f.service.remove([1], { force: true });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
});

test('URL-derived storage accepts legal directory names longer than user aliases and containing spaces', async (t) => {
  const doc = { ...cases[0], id: 1, alias: 'short-alias', url: `/tmp/owner/${'r'.repeat(205)} repo.git` };
  const f = fixture(t, [doc]);
  const files = f.paths(doc).map((p) => path.join(p, 'job.js'));
  files.forEach(f.write);
  await f.service.remove([1], { force: true });
  for (const file of files) assert.equal(fs.existsSync(file), false, file);
});

test('an unrepresentable unused Shell filename does not block valid CLI raw cleanup', async (t) => {
  const doc = {
    id: 1,
    alias: 'long-query',
    type: 'file',
    url: 'https://example.com/job.js?token=' + 'a'.repeat(300),
  };
  const f = fixture(t, [doc]);
  const names = getSubscriptionStorageNames(doc, 'cli');
  const files = [
    path.join(f.config.scriptPath, names.script),
    path.join(f.root, 'raw', names.raw),
  ];
  files.forEach(f.write);
  await f.service.remove([1], { force: true });
  assert.deepEqual(f.docs, []);
  for (const file of files) assert.equal(fs.existsSync(file), false);
});

test('cleanup retains each representable path when only its prefixed Shell script name is too long', async (t) => {
  const doc = { id: 1, alias: 'partial-raw', type: 'file', url: 'https://example.com/job.js?token=' };
  const prefix = getSubscriptionStorageNames(doc).raw;
  doc.url += 'a'.repeat(255 - Buffer.byteLength(prefix));
  const shell = getSubscriptionStorageNames(doc);
  assert.equal(Buffer.byteLength(shell.raw), 255);
  assert.ok(Buffer.byteLength(shell.script) > 255);
  const f = fixture(t, [doc]);
  const cli = getSubscriptionStorageNames(doc, 'cli');
  const files = [
    path.join(f.root, 'raw', shell.raw),
    path.join(f.root, 'raw', cli.raw),
    path.join(f.config.scriptPath, cli.script),
  ];
  files.forEach(f.write);
  await f.service.remove([1], { force: true });
  assert.deepEqual(f.docs, []);
  for (const file of files) assert.equal(fs.existsSync(file), false);
});

test('a legal Unicode alias with an unrepresentable unused directory does not block URL-derived cleanup', async (t) => {
  const doc = { ...cases[0], id: 1, alias: '中'.repeat(86) };
  const f = fixture(t, [doc]);
  const files = f.paths(doc).map((p) => path.join(p, 'job.js'));
  files.forEach(f.write);
  await f.service.remove([1], { force: true });
  assert.deepEqual(f.docs, []);
  for (const file of files) assert.equal(fs.existsSync(file), false);
});

test('Unicode storage follows filesystem limits rather than imposing a UTF-8 byte cap', async (t) => {
  const doc = { ...cases[0], id: 1, alias: 'short-alias', url: `/tmp/owner/${'中'.repeat(86)}.git` };
  const f = fixture(t, [doc]);
  const files = f.paths(doc).map((p) => path.join(p, 'job.js'));
  for (const file of files) {
    try {
      f.write(file);
    } catch (error) {
      // These names are representable on macOS but not Linux.
      assert.equal(error.code, 'ENAMETOOLONG');
    }
  }
  await f.service.remove([1], { force: true });
  assert.deepEqual(f.docs, []);
  for (const file of files) assert.equal(fs.existsSync(file), false);
});
