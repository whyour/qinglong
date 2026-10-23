const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const bundle = require('../../cli/src/internal/maintenance/platformBundle.cjs');
const {
  getStatus,
  saveState,
} = require('../../cli/src/internal/maintenance/panelUpgrade.cjs');
const { prepareBridge } = require('../../scripts/build-migration-bridge.cjs');
const baseline = require('../../docker/migration-bridge-images.json');
const tar = require('tar');

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-migration-bridge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('new online/offline engines reject an upgrader bridge rather than downgrade the runtime', async (t) => {
  const root = await directory(t),
    tmp = path.join(root, '.tmp');
  await fs.mkdir(tmp);
  await fs.mkdir(path.join(root, 'qinglong'));
  await fs.writeFile(
    path.join(root, 'qinglong/bundle.json'),
    JSON.stringify({ migrationBridge: { format: 1 } }),
  );
  const archive = path.join(root, 'bridge.tar.gz');
  await tar.c({ cwd: root, file: archive, gzip: true }, ['qinglong']);
  await assert.rejects(
    bundle.stageBundle({
      root,
      tmp,
      env: { QL_UPGRADE_FILE: archive },
      run: async () => {
        throw new Error('must not run commands');
      },
    }),
    /download the runtime package instead/,
  );
  assert.deepEqual(await fs.readdir(tmp), []);
});

test('a pending second hop cannot use an old index without runtimePackages', async (t) => {
  const root = await directory(t),
    tmp = path.join(root, '.tmp');
  await fs.mkdir(tmp);
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      qinglongUpgradeFormat: 2,
      qinglongMigrationBridge: { format: 1 },
    }),
  );
  const key = bundle.targetKey(await bundle.runtimeTarget());
  const entry = {
    url: 'https://example.com/legacy.tar.gz',
    size: 10,
    sha256: 'b'.repeat(64),
  };
  const index = {
    format: 2,
    sourceCommit: 'a'.repeat(40),
    packages: { [key]: entry },
  };
  let downloaded = false;
  await assert.rejects(
    bundle.stageBundle({
      root,
      tmp,
      env: { QL_UPGRADE_INDEX_URL: 'https://example.com/latest.json' },
      run: async (_program, args) =>
        fs.writeFile(args[args.indexOf('--output') + 1], JSON.stringify(index)),
      download: async () => {
        downloaded = true;
        throw new Error('legacy download requested');
      },
    }),
    /尚未提供第二步运行包/,
  );
  assert.equal(downloaded, false);
});

test('a runtime index cannot prepare a correctly hashed legacy database backend as the second hop', async (t) => {
  const root = await directory(t),
    tmp = path.join(root, '.tmp');
  await fs.mkdir(tmp);
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ qinglongUpgradeFormat: 2 }),
  );
  const selected = {
    source: root + '/qinglong/source',
    static: root + '/qinglong/static',
  };
  await fs.mkdir(selected.source + '/node_modules/sqlite3', {
    recursive: true,
  });
  await fs.mkdir(selected.static, { recursive: true });
  await fs.writeFile(
    selected.source + '/package.json',
    JSON.stringify({
      dependencies: { sqlite3: 'legacy', sequelize: 'legacy' },
    }),
  );
  await fs.writeFile(
    selected.source + '/node_modules/sqlite3/package.json',
    '{}',
  );
  await fs.writeFile(selected.source + '/pnpm-lock.yaml', 'legacy lock');
  const target = await bundle.runtimeTarget(),
    sourceCommit = 'a'.repeat(40);
  await fs.writeFile(
    root + '/qinglong/bundle.json',
    JSON.stringify({
      format: 2,
      sourceCommit,
      lockfileSha256: bundle.sha256(Buffer.from('legacy lock')),
      nodeApi: 6,
      nodeMinimum: '22.17.0',
      target: { ...target, libcMinimum: target.libcVersion },
      files: await bundle.inventory(selected),
    }),
  );
  const archive = root + '/legacy.tar.gz';
  await tar.c({ cwd: root, file: archive, gzip: true }, ['qinglong']);
  const bytes = await fs.readFile(archive),
    key = bundle.targetKey(target);
  const index = {
    format: 2,
    sourceCommit,
    runtimePackages: {
      [key]: {
        url: 'https://example.com/runtime.tar.gz',
        size: bytes.length,
        sha256: bundle.sha256(bytes),
      },
    },
  };
  let probed = false;
  await assert.rejects(
    bundle.stageBundle({
      root,
      tmp,
      env: { QL_UPGRADE_INDEX_URL: 'https://example.com/latest.json' },
      run: async (_program, args) =>
        fs.writeFile(args[args.indexOf('--output') + 1], JSON.stringify(index)),
      download: async (_run, file) => fs.copyFile(archive, file),
      verifyStatic: async () => ({ sourceCommit }),
      probe: async () => {
        probed = true;
      },
      prestart: async () => {},
    }),
    /第二步更新包仍是旧数据库后端/,
  );
  assert.equal(probed, false);
  await assert.rejects(fs.access(tmp + '/upgrade-ready-master.json'), {
    code: 'ENOENT',
  });
});

test('the installed marker explains partial completion and disappears without relying on stale job fields', async (t) => {
  const root = await directory(t);
  await saveState(root, {
    status: 'completed',
    phase: 'completed',
    migrationRequired: true,
  });
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ qinglongMigrationBridge: { format: 1 } }),
  );
  assert.equal((await getStatus(root, { root })).migrationRequired, true);
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  assert.equal((await getStatus(root, { root })).migrationRequired, false);
  await saveState(root, { status: 'failed', error: 'prestart failed' });
  assert.equal((await getStatus(root, { root })).status, 'failed');
});

for (const fault of [
  'none',
  'missing-platform',
  'corrupt-size',
  'empty-runtime',
])
  test(`an upgraded client selects only runtimePackages, never the bridge (${fault})`, async (t) => {
    const root = await directory(t),
      tmp = path.join(root, '.tmp');
    await fs.mkdir(tmp);
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ qinglongUpgradeFormat: 2 }),
    );
    const key = bundle.targetKey(await bundle.runtimeTarget());
    const regular = {
      url: 'https://example.com/runtime.tar.gz',
      size: 10,
      sha256: 'b'.repeat(64),
    };
    const index = {
      format: 2,
      sourceCommit: 'a'.repeat(40),
      packages: {
        [key]: { ...regular, url: 'https://example.com/bridge.tar.gz' },
      },
      runtimePackages: { [key]: regular },
    };
    if (fault === 'missing-platform') delete index.runtimePackages[key];
    if (fault === 'corrupt-size') regular.size = -1;
    if (fault === 'empty-runtime') index.runtimePackages = null;
    let downloaded = false;
    await assert.rejects(
      bundle.stageBundle({
        root,
        tmp,
        env: { QL_UPGRADE_INDEX_URL: 'https://example.com/latest.json' },
        run: async (_program, args) =>
          fs.writeFile(
            args[args.indexOf('--output') + 1],
            JSON.stringify(index),
          ),
        download: async (_run, _file, url) => {
          downloaded = true;
          assert.equal(url, regular.url);
          throw new Error('selected runtime');
        },
      }),
      fault === 'none' ? /selected runtime/ : /No verified update bundle/,
    );
    assert.equal(downloaded, fault === 'none');
    assert.deepEqual(await fs.readdir(tmp), []);
  });

test('bridge construction retains legacy backend, lock and field schema while replacing only updater and frontend', async (t) => {
  const dir = await directory(t);
  async function installation(name, commit, modern) {
    const root = path.join(dir, name);
    for (const sub of [
      'static/build',
      'static/dist',
      'sample',
      'cli/src/internal/maintenance',
    ])
      await fs.mkdir(path.join(root, sub), { recursive: true });
    const files = {
      'build/app.js': modern ? 'new backend' : 'legacy backend',
      'dist/index.html': name,
    };
    for (const [file, content] of Object.entries(files))
      await fs.writeFile(path.join(root, 'static', file), content);
    await fs.writeFile(
      path.join(root, 'sample/config.sample.sh'),
      '# template',
    );
    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), name + ' lock');
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        version: modern ? '2.24.0' : '2.23.0',
        qinglongUpgradeFormat: 2,
        dependencies: modern
          ? { '@mikro-orm/sql': '7.2.5' }
          : { sqlite3: 'legacy', sequelize: '6' },
      }),
    );
    await fs.writeFile(
      path.join(root, 'static/build-info.json'),
      JSON.stringify({
        version: 1,
        dirty: false,
        sourceCommit: commit,
        lockfileSha256: bundle.sha256(Buffer.from(name + ' lock')),
        files: Object.fromEntries(
          Object.entries(files).map(([file, content]) => [
            file,
            bundle.sha256(Buffer.from(content)),
          ]),
        ),
      }),
    );
    await fs.writeFile(
      path.join(root, 'cli/src/internal/maintenance/engine.cjs'),
      name,
    );
    return root;
  }
  const legacy = await installation('legacy', baseline.sourceCommit, false);
  const modern = await installation('modern', 'a'.repeat(40), true);
  for (const file of ['.env', 'data/database.sqlite']) {
    await fs.mkdir(path.dirname(path.join(legacy, file)), { recursive: true });
    await fs.writeFile(path.join(legacy, file), 'synthetic must not ship');
  }
  const dest = path.join(dir, 'bridge');
  await prepareBridge(legacy, modern, dest);
  const pkg = JSON.parse(await fs.readFile(path.join(dest, 'package.json')));
  assert.equal(pkg.version, '2.23.0');
  assert.equal(pkg.qinglongMigrationBridge.targetVersion, '2.24.0');
  assert.equal(
    await fs.readFile(path.join(dest, 'static/build/app.js'), 'utf8'),
    'legacy backend',
  );
  assert.equal(
    await fs.readFile(path.join(dest, 'pnpm-lock.yaml'), 'utf8'),
    'legacy lock',
  );
  assert.equal(
    await fs.readFile(
      path.join(dest, 'cli/src/internal/maintenance/engine.cjs'),
      'utf8',
    ),
    'modern',
  );
  assert.equal(
    await fs.readFile(path.join(dest, 'static/dist/index.html'), 'utf8'),
    'modern',
  );
  await assert.rejects(fs.access(path.join(dest, '.env')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(dest, 'data')), { code: 'ENOENT' });
});
