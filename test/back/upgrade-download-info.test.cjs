const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  publishUpgradeInfo,
} = require('../../scripts/publish-upgrade-info.cjs');
const {
  stageUpgrade,
  downloadWithProgress,
} = require('../../shell/upgrade.cjs');
const { writeManifest } = require('../helpers/upgrade-fixture.cjs');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-download-info-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
  const source = path.join(tmp, 'source'),
    built = path.join(tmp, 'built'),
    remote = path.join(tmp, 'remote.git');
  for (const dir of [source]) {
    git('init', '-b', 'develop', dir);
    git('-C', dir, 'config', 'user.name', 'Fixture');
    git('-C', dir, 'config', 'user.email', 'fixture@example.invalid');
  }
  fs.mkdirSync(path.join(source, 'sample'));
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"2.24.0"}');
  fs.writeFileSync(path.join(source, 'pnpm-lock.yaml'), 'lock');
  fs.writeFileSync(path.join(source, 'sample/config.sample.sh'), '# config');
  git('-C', source, 'add', '.');
  git('-C', source, 'commit', '-m', 'source');
  const sourceCommit = git('-C', source, 'rev-parse', 'HEAD');
  fs.mkdirSync(path.join(built, 'build'), { recursive: true });
  fs.writeFileSync(path.join(built, 'build/app.js'), 'backend');
  writeManifest(source, built);
  // Fixture helper defaults to its fixed source revision.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(built, 'build-info.json')),
  );
  manifest.sourceCommit = sourceCommit;
  fs.writeFileSync(
    path.join(built, 'build-info.json'),
    JSON.stringify(manifest),
  );
  git('init', '-b', 'develop', built);
  git('-C', built, 'config', 'user.name', 'Fixture');
  git('-C', built, 'config', 'user.email', 'fixture@example.invalid');
  git('-C', built, 'add', '.');
  git('-C', built, 'commit', '-m', 'built');
  const staticCommit = git('-C', built, 'rev-parse', 'HEAD');
  git('init', '--bare', remote);
  git('-C', built, 'push', remote, 'develop');
  const archives = {};
  for (const [repo, dir, commit] of [
    ['qinglong', source, sourceCommit],
    ['qinglong-static', built, staticCommit],
  ])
    archives[repo] = execFileSync('git', [
      '-C',
      dir,
      'archive',
      '--format=zip',
      `--prefix=${repo}-${commit}/`,
      commit,
    ]);
  const execute = (program, args, options) => {
    if (program !== 'curl') return execFileSync(program, args, options);
    const url = args.at(-1),
      repo = url.includes('/qinglong-static/') ? 'qinglong-static' : 'qinglong';
    assert.ok(url.endsWith(repo === 'qinglong' ? sourceCommit : staticCommit));
    fs.writeFileSync(args[args.indexOf('--output') + 1], archives[repo]);
    return '';
  };
  return {
    tmp,
    source,
    built,
    remote,
    git,
    sourceCommit,
    staticCommit,
    archives,
    execute,
  };
}

test('published archive metadata retains history and supplies percentages without Content-Length', async (t) => {
  const f = fixture(t);
  const info = publishUpgradeInfo(
    f.remote,
    'develop',
    f.sourceCommit,
    f.execute,
  );
  for (const [repo, bytes] of Object.entries(f.archives)) {
    assert.equal(info.archives[repo].size, bytes.length);
    assert.equal(info.archives[repo].sha256, digest(bytes));
  }
  const stored = JSON.parse(
    f.git('-C', f.remote, 'show', `upgrade-info:${f.sourceCommit}.json`),
  );
  assert.deepEqual(stored, info);
  const first = f.git('-C', f.remote, 'rev-parse', 'upgrade-info');
  publishUpgradeInfo(f.remote, 'develop', f.sourceCommit, f.execute);
  assert.equal(f.git('-C', f.remote, 'rev-parse', 'upgrade-info^'), first);
  const root = path.join(f.tmp, 'panel'),
    tmp = path.join(root, '.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'));
  for (const name of ['package.json', 'pnpm-lock.yaml'])
    fs.copyFileSync(path.join(f.source, name), path.join(root, name));
  const reports = [],
    urls = [];
  const run = async (program, args) => {
    if (program !== 'curl')
      return { stdout: execFileSync(program, args, { encoding: 'utf8' }) };
    const url = args.at(-1);
    urls.push(url);
    const out = args[args.indexOf('--output') + 1];
    if (new URL(url).pathname.endsWith('/build-info.json'))
      fs.writeFileSync(out, JSON.stringify({ sourceCommit: f.sourceCommit }));
    else if (url.endsWith('.json')) fs.writeFileSync(out, JSON.stringify(info));
    else {
      const repo = url.includes('/qinglong-static/')
        ? 'qinglong-static'
        : 'qinglong';
      fs.writeFileSync(out, f.archives[repo]);
    }
    fs.writeFileSync(
      args[args.indexOf('--dump-header') + 1],
      'HTTP/2 200 OK\r\n\r\n',
    );
  };
  await stageUpgrade({
    root,
    tmp,
    env: { QL_BRANCH: 'develop' },
    mirror: 'github',
    run,
    install: () => assert.fail('no changed dependencies'),
    onProgress: async (r) => reports.push(r),
  });
  assert.ok(urls.some((url) => url.endsWith(`/zip/${f.staticCommit}`)));
  for (const artifact of ['qinglong', 'qinglong-static']) {
    assert.ok(reports.some((r) => r.artifact === artifact && r.percent === 0));
    assert.ok(
      reports.some((r) => r.artifact === artifact && r.percent === 100),
    );
  }
  const pointer = JSON.parse(
    fs.readFileSync(path.join(tmp, 'upgrade-ready-develop.json')),
  );
  assert.ok(
    fs.existsSync(
      path.join(
        tmp,
        pointer.directory,
        'qinglong-static-develop/build-info.json',
      ),
    ),
  );
});

test('publisher rejects a static artifact from a different source before publishing metadata', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      publishUpgradeInfo(
        f.remote,
        'develop',
        'a'.repeat(40),
        (program, args, options) => {
          if (program === 'curl') {
            fs.writeFileSync(
              args[args.indexOf('--output') + 1],
              f.archives['qinglong-static'],
            );
            return '';
          }
          return execFileSync(program, args, options);
        },
      ),
    /does not match/,
  );
  assert.equal(f.git('-C', f.remote, 'branch', '--list', 'upgrade-info'), '');
});

for (const mismatch of ['size', 'sha256'])
  test(`archive metadata ${mismatch} mismatch never reports completion`, async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-wrong-download-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const bytes = Buffer.alloc(100),
      reports = [];
    await assert.rejects(
      downloadWithProgress(
        async (program, args) => {
          fs.writeFileSync(args[args.indexOf('--output') + 1], bytes);
        },
        path.join(tmp, 'file.zip'),
        'https://example.invalid/file.zip',
        'qinglong',
        async (r) => reports.push(r),
        true,
        {
          size: mismatch === 'size' ? 101 : 100,
          sha256: mismatch === 'sha256' ? '0'.repeat(64) : digest(bytes),
        },
      ),
      /checksum mismatch/,
    );
    assert.ok(!reports.some((r) => r.percent === 100));
  });

test('published size gives intermediate real percentages when the response omits its length', async (t) => {
  const { setTimeout: delay } = require('node:timers/promises');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-sized-download-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const bytes = Buffer.alloc(100),
    reports = [];
  await downloadWithProgress(
    async (program, args) => {
      const out = args[args.indexOf('--output') + 1];
      fs.writeFileSync(
        args[args.indexOf('--dump-header') + 1],
        'HTTP/2 200 OK\r\n\r\n',
      );
      fs.writeFileSync(out, bytes.subarray(0, 50));
      await delay(1150);
      fs.writeFileSync(out, bytes);
    },
    path.join(tmp, 'file.zip'),
    'https://example.invalid/file.zip',
    'qinglong',
    async (r) => reports.push(r),
    true,
    { size: 100, sha256: digest(bytes) },
  );
  assert.ok(reports.some((r) => r.downloadedBytes === 50 && r.percent === 50));
  assert.equal(reports.at(-1).percent, 100);
});
