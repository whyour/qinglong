const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stageUpgrade } = require('../../shell/upgrade.cjs');
const {
  writeManifest,
  sourceCommit,
} = require('../helpers/upgrade-fixture.cjs');
async function fixture(
  t,
  fail,
  fallbackMirror = 'gitee',
  corrupt = false,
  signal,
) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-download-fallback-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root'),
    tmp = path.join(base, 'tmp'),
    payload = path.join(base, 'payload'),
    source = path.join(payload, 'qinglong-' + sourceCommit),
    staticRoot = path.join(payload, 'qinglong-static-develop');
  for (const dir of [
    root,
    tmp,
    path.join(root, 'node_modules'),
    path.join(source, 'sample'),
    path.join(staticRoot, 'build'),
  ])
    fs.mkdirSync(dir, { recursive: true });
  for (const dir of [root, source]) {
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lock');
  }
  fs.writeFileSync(path.join(source, 'sample/config.sample.sh'), 'sample');
  fs.writeFileSync(path.join(staticRoot, 'build/app.js'), 'backend');
  writeManifest(source, staticRoot);
  if (corrupt)
    fs.writeFileSync(path.join(staticRoot, 'build/app.js'), 'tampered');
  for (const repo of ['qinglong-static', 'qinglong'])
    execFileSync(
      'zip',
      [
        '-qr',
        path.join(base, repo + '.zip'),
        repo === 'qinglong-static'
          ? 'qinglong-static-develop'
          : 'qinglong-' + sourceCommit,
      ],
      { cwd: payload },
    );
  const urls = [];
  const operation = stageUpgrade({
    root,
    tmp,
    env: { QL_BRANCH: 'develop' },
    mirror: 'github',
    fallbackMirror,
    signal,
    install: async () => assert.fail('unchanged dependencies'),
    run: async (program, args) => {
      if (program === 'curl') {
        const url = args.at(-1);
        urls.push(url);
        assert.ok(args.includes('--speed-time'));
        if (fail(url)) throw new Error('download failed');
        const repo = url.includes('/qinglong-static/')
          ? 'qinglong-static'
          : 'qinglong';
        fs.copyFileSync(
          path.join(base, repo + '.zip'),
          args[args.indexOf('--output') + 1],
        );
        return { stdout: '' };
      }
      return { stdout: execFileSync(program, args, { encoding: 'utf8' }) };
    },
  });
  return { operation, urls, tmp };
}
test('automatic source selection falls back after GitHub network failure and pins the matching source commit', async (t) => {
  const f = await fixture(t, (url) => url.startsWith('https://codeload.'));
  await f.operation;
  assert.equal(f.urls.length, 4);
  assert.match(f.urls[1], /gitee.com.*qinglong-static.*develop/);
  assert.ok(f.urls[3].includes(sourceCommit));
  assert.ok(fs.existsSync(path.join(f.tmp, 'upgrade-ready-develop.json')));
});
test('source-only network failure keeps the manifest commit when changing mirrors', async (t) => {
  const f = await fixture(
    t,
    (url) => url.startsWith('https://codeload.') && url.includes('/qinglong/'),
  );
  await f.operation;
  assert.equal(f.urls.length, 3);
  assert.ok(f.urls[2].endsWith(sourceCommit + '.zip'));
});
test('explicit CLI GitHub selection does not switch providers', async (t) => {
  const f = await fixture(t, () => true, null);
  await assert.rejects(f.operation, /download failed/);
  assert.equal(f.urls.length, 1);
  assert.deepEqual(fs.readdirSync(f.tmp), []);
});
test('checksum validation failure never retries from another mirror', async (t) => {
  const f = await fixture(t, () => false, 'gitee', true);
  await assert.rejects(f.operation, /checksum mismatch|构建文件缺失、损坏或混入旧文件/);
  assert.equal(f.urls.length, 2);
  assert.deepEqual(fs.readdirSync(f.tmp), []);
});
test('cancellation does not trigger mirror failover', async (t) => {
  const controller = new AbortController();
  const f = await fixture(
    t,
    () => {
      controller.abort(new Error('cancelled'));
      return true;
    },
    'gitee',
    false,
    controller.signal,
  );
  await assert.rejects(f.operation, /cancelled/);
  assert.equal(f.urls.length, 1);
});
