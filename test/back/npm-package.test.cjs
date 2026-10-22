const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { checkPackedFiles } = require('../../scripts/verify-panel-package.cjs');
const { restorePackageLock } = require('../../shell/install-package.cjs');
const { restoreEnvironment } = require('../../shell/install-package.cjs');

async function packageFixture(t) {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ql-npm-contract-')),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'source'),
    output = path.join(temp, 'archives');
  await fs.mkdir(root);
  await fs.mkdir(output);
  const copy = async (name) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.copyFile(path.resolve(name), path.join(root, name));
  };
  for (const name of [
    '.gitignore',
    'docker/verify-build.cjs',
    'docker/build-manifest.cjs',
    '.env.example',
    'ecosystem.config.js',
    'version.yaml',
    'README.md',
    'LICENSE',
    'scripts/prepare-npm-package.cjs',
    'back/protos/api.proto',
  ])
    await copy(name);
  for (const directory of ['shell', 'sample', 'cli/src/internal/maintenance']) {
    await fs.cp(directory, path.join(root, directory), {
      recursive: true,
      filter: (source) =>
        !/[/\\](?:__pycache__|node_modules)(?:[/\\]|$)|[/\\]preload[/\\](?:env\.|notify\.|__ql_notify__\.|lang_env\.sh)/.test(
          source,
        ),
    });
  }
  const metadata = JSON.parse(await fs.readFile('package.json', 'utf8'));
  // The structural test stays offline; full production installation and service
  // upgrades run against the unmodified package in verify-panel-package.cjs.
  metadata.dependencies = {};
  metadata.devDependencies = {};
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(metadata));
  const lock = 'lockfileVersion: 6.0\n';
  await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), lock);
  const files = {};
  for (const name of [
    'build/app.js',
    'build/token.js',
    'build/bootstrap/upgradeProbe.js',
    'dist/index.html',
    'build/app.js.map',
    'dist/app.js.gz',
    ...[
      'databaseClient',
      'databaseErrors',
      'databaseProcess',
      'databaseWorker',
      'repository',
      'schema',
      'queries',
      'cacheStore',
      'statistics',
    ].map((name) => `build/data/${name}.js`),
  ]) {
    const bytes = name.endsWith('.html') ? '<html>pack fixture</html>' : '{}';
    await fs.mkdir(path.dirname(path.join(root, 'static', name)), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, 'static', name), bytes);
    files[name] = createHash('sha256').update(bytes).digest('hex');
  }
  for (const name of [
    '.env',
    '.env.local',
    '.env.production',
    '.aws/credentials',
    '.ssh/id_rsa',
    '.vscode/settings.json',
    '.github/workflows/private.yml',
    '.tmp/private.json',
    '.DS_Store',
    'output/private.json',
    'data/config/auth.json',
    'back/private.json',
    'back/private.ts',
    'sample/tool.ts',
    'sample/private.json',
    'sample/__pycache__/notify.pyc',
    'shell/preload/env.js',
    'shell/preload/env.py',
    'shell/preload/notify.js',
    'shell/preload/__ql_notify__.js',
    'shell/preload/lang_env.sh',
    'shell/preload/task-notify.json',
    'shell/preload/__pycache__/env.pyc',
    'cli/dist/npm/ql.js',
    'cli/src/internal/private.cjs',
  ]) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), 'DO_NOT_PUBLISH');
  }
  await fs.writeFile(path.join(root, '.npmrc'), '# DO_NOT_PUBLISH\n');
  const env = { ...process.env, HOME: temp, NODE_ENV: 'production' };
  await execute('git', ['init', '-q'], { cwd: root, env });
  await execute('git', ['add', '-A'], { cwd: root, env });
  await execute(
    'git',
    [
      '-c',
      'user.name=Package Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: root, env },
  );
  await fs.writeFile(
    path.join(root, 'static/build-info.json'),
    JSON.stringify({
      version: 1,
      dirty: false,
      sourceCommit: (
        await execute('git', ['rev-parse', 'HEAD'], { cwd: root })
      ).stdout.trim(),
      files,
      lockfileSha256: createHash('sha256').update(lock).digest('hex'),
    }),
  );
  const pack = () =>
    execute(
      'npm',
      [
        'pack',
        '--json',
        '--cache',
        path.join(temp, 'cache'),
        '--pack-destination',
        output,
      ],
      { cwd: root, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
    );
  return { root, output, temp, env, lock, files, pack };
}

test('real npm pack excludes local state and its installed lifecycle restores verified runtime files', async (t) => {
  const { root, output, temp, env, lock, files, pack } = await packageFixture(
    t,
  );
  // The whitelist must work by itself, even for artifacts ignored by Git.
  await assert.rejects(fs.access(path.join(root, '.npmignore')), {
    code: 'ENOENT',
  });
  const packed = await pack();
  const [archive] = JSON.parse(packed.stdout);
  checkPackedFiles(archive.files);
  const names = new Set(archive.files.map((file) => file.path));
  assert.ok(names.has('shell/upgrade-lock.yaml'));
  for (const name of Object.keys(files)) assert.ok(names.has('static/' + name));
  await assert.rejects(fs.access(path.join(root, 'shell/upgrade-lock.yaml')), {
    code: 'ENOENT',
  });
  const prefix = path.join(temp, 'installed');
  await execute(
    'npm',
    [
      'install',
      '--offline',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--cache',
      path.join(temp, 'cache'),
      '--prefix',
      prefix,
      path.join(output, archive.filename),
    ],
    { cwd: temp, env, timeout: 60000 },
  );
  const installed = path.join(prefix, 'node_modules/@whyour/qinglong');
  for (const { path: name } of archive.files)
    assert.equal(
      (await fs.readFile(path.join(installed, name))).includes(
        Buffer.from('DO_NOT_PUBLISH'),
      ),
      false,
      `Private fixture content in npm package: ${name}`,
    );
  await assert.rejects(fs.access(path.join(installed, '.env')), {
    code: 'ENOENT',
  });
  assert.equal(
    await fs.readFile(path.join(installed, 'pnpm-lock.yaml'), 'utf8'),
    lock,
  );
  assert.equal(
    typeof require(path.join(installed, 'shell/upgrade.cjs')).stageUpgrade,
    'function',
  );
  assert.ok(
    (await fs.stat(path.join(installed, 'shell/update.sh'))).mode & 0o111,
  );
  for (const [name, file] of Object.entries(
    JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'))
      .bin,
  )) {
    await fs.access(path.join(prefix, 'node_modules/.bin', name));
    assert.ok((await fs.stat(path.join(installed, file))).mode & 0o111, file);
  }
  await fs.writeFile(
    path.join(installed, 'shell/upgrade-lock.yaml'),
    'tampered',
  );
  assert.throws(() => restorePackageLock(installed), /does not match/);
  assert.equal(
    await fs.readFile(path.join(installed, 'pnpm-lock.yaml'), 'utf8'),
    lock,
  );
  assert.ok(
    !(await fs.readdir(installed)).some((name) =>
      name.startsWith('.upgrade-lock-'),
    ),
  );
});

test('postinstall still supports minimal Docker dependency stages before shell files are copied', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-npm-builder-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const metadata = JSON.parse(await fs.readFile('package.json', 'utf8'));
  await fs.writeFile(
    path.join(temp, 'package.json'),
    JSON.stringify({ scripts: { postinstall: metadata.scripts.postinstall } }),
  );
  await fs.writeFile(path.join(temp, 'pnpm-lock.yaml'), 'source lock');
  await execute(
    'npm',
    ['run', 'postinstall', '--cache', path.join(temp, 'cache')],
    { cwd: temp, timeout: 30000 },
  );
});

test('a missing npm runtime lockfile fails instead of claiming an installed package is ready', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-npm-lock-missing-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  assert.throws(
    () => restorePackageLock(temp),
    /Missing npm package upgrade lockfile/,
  );
});

test('real npm overwrites preserve .env automatically and failed installs restore the old package', async (t) => {
  const { root, output, temp, env, pack } = await packageFixture(t);
  const [packed] = JSON.parse((await pack()).stdout);
  const archive = path.join(output, packed.filename);
  const legacy = path.join(temp, 'legacy');
  await fs.mkdir(legacy);
  await fs.writeFile(
    path.join(legacy, 'package.json'),
    JSON.stringify({ name: '@whyour/qinglong', version: '2.22.0' }),
  );
  await fs.writeFile(path.join(legacy, 'old-package-marker'), 'legacy');
  const [old] = JSON.parse(
    (
      await execute(
        'npm',
        [
          'pack',
          '--ignore-scripts',
          '--json',
          '--cache',
          path.join(temp, 'cache'),
        ],
        { cwd: legacy, env },
      )
    ).stdout,
  );
  const broken = path.join(temp, 'broken');
  await fs.mkdir(broken);
  await fs.cp(root, broken, { recursive: true });
  await fs.writeFile(
    path.join(broken, 'shell/upgrade-lock.yaml'),
    'invalid lock',
  );
  const [bad] = JSON.parse(
    (
      await execute(
        'npm',
        [
          'pack',
          '--ignore-scripts',
          '--json',
          '--cache',
          path.join(temp, 'cache'),
        ],
        { cwd: broken, env },
      )
    ).stdout,
  );

  for (const global of [false, true]) {
    await t.test(
      global ? 'global npm install' : 'local npm install',
      async () => {
        const prefix = path.join(temp, global ? 'global' : 'local');
        const linkedPrefix = prefix + '-link';
        await fs.mkdir(prefix);
        await fs.symlink(prefix, linkedPrefix);
        const installed = path.join(
          prefix,
          global
            ? 'lib/node_modules/@whyour/qinglong'
            : 'node_modules/@whyour/qinglong',
        );
        const install = (file) =>
          execute(
            'npm',
            [
              'install',
              ...(global ? ['--global'] : []),
              '--prefix',
              linkedPrefix,
              '--force',
              '--offline',
              '--omit=dev',
              '--no-audit',
              '--no-fund',
              '--cache',
              path.join(temp, 'cache'),
              file,
            ],
            { cwd: temp, env, timeout: 60000 },
          );
        await install(path.join(legacy, old.filename));
        const bytes = Buffer.from(
          'QL_DATA_DIR=/external/data\r\nSECRET="配置 test"\r\n# no trailing newline',
        );
        const external = path.join(prefix, 'external.env');
        await fs.writeFile(external, bytes);
        await fs.symlink(external, path.join(installed, '.env'));
        await assert.rejects(install(archive), (error) => {
          assert.match(error.stderr, /must be a regular file/);
          return true;
        });
        assert.equal(
          JSON.parse(await fs.readFile(path.join(installed, 'package.json')))
            .version,
          '2.22.0',
        );
        assert.equal(await fs.readlink(path.join(installed, '.env')), external);
        assert.deepEqual(await fs.readFile(external), bytes);
        await fs.rm(path.join(installed, '.env'));
        await fs.writeFile(path.join(installed, '.env'), bytes, {
          mode: 0o644,
        });
        await assert.rejects(
          install(path.join(broken, bad.filename)),
          (error) => {
            assert.match(error.stderr, /does not match its build manifest/);
            return true;
          },
        );
        assert.equal(
          JSON.parse(await fs.readFile(path.join(installed, 'package.json')))
            .version,
          '2.22.0',
        );
        assert.equal(
          await fs.readFile(path.join(installed, 'old-package-marker'), 'utf8'),
          'legacy',
        );
        assert.deepEqual(
          await fs.readFile(path.join(installed, '.env')),
          bytes,
        );
        await install(archive);
        assert.deepEqual(
          await fs.readFile(path.join(installed, '.env')),
          bytes,
        );
        assert.equal(
          (await fs.stat(path.join(installed, '.env'))).mode & 0o777,
          0o600,
        );
        await assert.rejects(
          fs.access(path.join(installed, 'old-package-marker')),
          { code: 'ENOENT' },
        );
        // Same-version forced reinstall must also retain custom configuration.
        await install(archive);
        assert.deepEqual(
          await fs.readFile(path.join(installed, '.env')),
          bytes,
        );
        assert.ok(
          !(await fs.readdir(installed)).some((name) =>
            name.startsWith('.upgrade-env-'),
          ),
        );
      },
    );
  }
});

test('environment recovery uses only the exact retired package and never overwrites existing configuration', async (t) => {
  const temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'ql-npm-env-')),
  );
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'node_modules/@whyour/qinglong');
  await fs.mkdir(root, { recursive: true });
  const suffix = createHash('sha1')
    .update(root)
    .digest('base64')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .slice(0, 8);
  const retired = path.join(path.dirname(root), `.qinglong-${suffix}`);
  const destination = path.join(root, '.env');
  const other = path.join(path.dirname(root), '.qinglong-unrelated');
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, '.env'), 'unrelated');
  restoreEnvironment(root);
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
  await fs.mkdir(retired);
  await fs.writeFile(
    path.join(retired, 'package.json'),
    JSON.stringify({ name: 'another-package' }),
  );
  await fs.writeFile(path.join(retired, '.env'), 'private');
  assert.throws(
    () => restoreEnvironment(root),
    /Unexpected retired npm package/,
  );
  await fs.writeFile(
    path.join(retired, 'package.json'),
    JSON.stringify({ name: '@whyour/qinglong' }),
  );
  await fs.rm(path.join(retired, '.env'));
  restoreEnvironment(root);
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
  await fs.symlink(path.join(other, '.env'), path.join(retired, '.env'));
  assert.throws(() => restoreEnvironment(root), /must be a regular file/);
  await fs.rm(path.join(retired, '.env'));
  await fs.mkdir(path.join(retired, '.env'));
  assert.throws(() => restoreEnvironment(root), /must be a regular file/);
  await fs.rm(path.join(retired, '.env'), { recursive: true });
  await fs.writeFile(path.join(retired, '.env'), '');
  restoreEnvironment(root);
  assert.equal(await fs.readFile(destination, 'utf8'), '');
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  await fs.writeFile(destination, 'new custom configuration');
  await fs.writeFile(path.join(retired, '.env'), 'old configuration');
  restoreEnvironment(root);
  assert.equal(
    await fs.readFile(destination, 'utf8'),
    'new custom configuration',
  );
  assert.ok(
    !(await fs.readdir(root)).some((name) => name.startsWith('.upgrade-env-')),
  );
});

test('npm publication consumes the exact archive whose isolated installation passed', () => {
  const yaml = require('js-yaml');
  const sync = require('node:fs');
  const workflow = yaml.load(
    sync.readFileSync('.github/workflows/build-docker-image.yml', 'utf8'),
  );
  const verify = workflow.jobs['verify-npm-package'];
  assert.deepEqual(verify.needs, [
    'build-static',
    'build-npm-migration-bundle',
  ]);
  assert.ok(
    verify.steps.some(
      (step) => step.with?.name === 'npm-migration-bundle-${{ github.sha }}',
    ),
  );
  const migration = workflow.jobs['build-npm-migration-bundle'];
  assert.equal(migration.needs, 'build-debian');
  assert.ok(
    migration.steps.some((step) =>
      /Dockerfile.upgrade-bundle/.test(step.run || ''),
    ),
  );
  assert.ok(
    !migration.steps.some((step) =>
      /publish-upgrade-bundles/.test(step.run || ''),
    ),
  );
  assert.deepEqual(verify.strategy.matrix.node, ['20.18.1', '22.17.0', '24']);
  assert.match(verify.container, /node:.*bookworm/);
  const tools = verify.steps.find(
    (step) => step.name === 'Install isolated service test tools',
  );
  assert.match(
    tools.run,
    /npm install --global --prefix \/usr\/local.*pm2@6\.0\.14/,
  );
  const service = verify.steps.find(
    (step) => step.name === 'Install and upgrade the exact npm archive',
  );
  assert.equal(service.if, "matrix.node != '20.18.1'");
  assert.ok(
    verify.steps.some(
      (step) =>
        step.if === "matrix.node == '20.18.1'" &&
        /verify-panel-runtime-floor/.test(step.run || ''),
    ),
  );
  assert.equal(service.env.QL_PANEL_TEST_PM2, '/usr/local/bin/pm2');
  assert.ok(workflow.jobs.publish.needs.includes('verify-npm-package'));
  const download = workflow.jobs.publish.steps.find((step) =>
    step.uses?.startsWith('actions/download-artifact@'),
  );
  assert.equal(download.with.name, 'qinglong-npm-${{ github.sha }}');
  const publication = workflow.jobs.publish.steps.find(
    (step) => step.name === 'Publish npm package with OIDC',
  );
  assert.match(publication.run, /npm publish "\$archive" --ignore-scripts/);
  assert.ok(
    !workflow.jobs.publish.steps.some((step) =>
      /pnpm build/.test(step.run || ''),
    ),
  );
});

test('an actual npm lifecycle failure on Node 20 preserves local and global old installs', async (t) => {
  const node20 = process.env.QL_TEST_NODE20;
  if (!node20)
    return t.skip(
      'Set QL_TEST_NODE20 to exercise actual rejected npm installs',
    );
  const { output, env, pack } = await packageFixture(t);
  await pack();
  const result = await execute(
    node20,
    [path.resolve('scripts/verify-panel-runtime-floor.cjs'), output],
    {
      env: {
        ...env,
        PATH: path.dirname(node20) + path.delimiter + process.env.PATH,
      },
      timeout: 60000,
    },
  );
  assert.equal(JSON.parse(result.stdout).oldServiceStayedHealthy, true);
});

for (const scenario of [
  'dirty-source',
  'stale-commit',
  'dirty-build',
  'changed-lock',
  'changed-output',
  'missing-output',
  'extra-output',
]) {
  test(`native npm pack rejects ${scenario} before producing an archive`, async (t) => {
    const { root, output, pack } = await packageFixture(t);
    const manifestFile = path.join(root, 'static/build-info.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    if (scenario === 'dirty-source')
      await fs.appendFile(
        path.join(root, 'shell/start.sh'),
        '\n# uncommitted change\n',
      );
    if (scenario === 'stale-commit') {
      await fs.appendFile(
        path.join(root, 'shell/start.sh'),
        '\n# committed change after build\n',
      );
      await execute('git', ['add', '-A'], { cwd: root });
      await execute(
        'git',
        [
          '-c',
          'user.name=Package Test',
          '-c',
          'user.email=test@example.invalid',
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '-qm',
          'new source',
        ],
        { cwd: root },
      );
    }
    if (scenario === 'dirty-build') {
      manifest.dirty = true;
      await fs.writeFile(manifestFile, JSON.stringify(manifest));
    }
    if (scenario === 'changed-lock') {
      await fs.appendFile(
        path.join(root, 'pnpm-lock.yaml'),
        '# changed lock\n',
      );
      await execute('git', ['add', '-A'], { cwd: root });
      await execute(
        'git',
        [
          '-c',
          'user.name=Package Test',
          '-c',
          'user.email=test@example.invalid',
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '-qm',
          'new lock',
        ],
        { cwd: root },
      );
      manifest.sourceCommit = (
        await execute('git', ['rev-parse', 'HEAD'], { cwd: root })
      ).stdout.trim();
      await fs.writeFile(manifestFile, JSON.stringify(manifest));
    }
    if (scenario === 'changed-output')
      await fs.appendFile(path.join(root, 'static/build/app.js'), 'changed');
    if (scenario === 'missing-output')
      await fs.rm(path.join(root, 'static/build/app.js'));
    if (scenario === 'extra-output')
      await fs.writeFile(path.join(root, 'static/build/leftover.js'), 'old');
    await assert.rejects(pack(), (error) => {
      assert.match(
        error.stderr,
        /clean source|do not match|checksum mismatch|file set mismatch/i,
      );
      return true;
    });
    assert.deepEqual(await fs.readdir(output), []);
    await assert.rejects(
      fs.access(path.join(root, 'shell/upgrade-lock.yaml')),
      { code: 'ENOENT' },
    );
  });
}
