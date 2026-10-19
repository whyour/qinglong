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

async function packageFixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ql-npm-contract-')));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'source'), output = path.join(temp, 'archives');
  await fs.mkdir(root);
  await fs.mkdir(output);
  const copy = async (name) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.copyFile(path.resolve(name), path.join(root, name));
  };
  for (const name of ['.gitignore', '.npmignore', 'docker/verify-build.cjs', 'docker/build-manifest.cjs', '.env.example', 'ecosystem.config.js', 'version.yaml', 'README.md', 'LICENSE', 'scripts/prepare-npm-package.cjs', 'back/protos/api.proto']) await copy(name);
  for (const directory of ['shell', 'sample', 'cli/src/internal/maintenance']) {
    await fs.cp(directory, path.join(root, directory), {
      recursive: true,
      filter: (source) => !/[/\\](?:__pycache__|node_modules)(?:[/\\]|$)|[/\\]preload[/\\](?:env\.|notify\.|__ql_notify__\.|lang_env\.sh)/.test(source),
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
  for (const name of ['build/app.js', 'build/token.js', 'build/bootstrap/upgradeProbe.js', 'dist/index.html', 'build/app.js.map', 'dist/app.js.gz']) {
    const bytes = name.endsWith('.html') ? '<html>pack fixture</html>' : '{}';
    await fs.mkdir(path.dirname(path.join(root, 'static', name)), { recursive: true });
    await fs.writeFile(path.join(root, 'static', name), bytes);
    files[name] = createHash('sha256').update(bytes).digest('hex');
  }
  for (const name of ['.env', 'output/private.json', 'data/config/auth.json', 'shell/preload/env.js', 'shell/preload/__ql_notify__.js', 'shell/preload/__pycache__/env.pyc', 'cli/dist/npm/ql.js']) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), 'DO_NOT_PUBLISH');
  }
  const env = { ...process.env, HOME: temp, NODE_ENV: 'production' };
  await execute('git', ['init', '-q'], { cwd: root, env });
  await execute('git', ['add', '-A'], { cwd: root, env });
  await execute('git', ['-c', 'user.name=Package Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'], { cwd: root, env });
  await fs.writeFile(path.join(root, 'static/build-info.json'), JSON.stringify({
    version: 1, dirty: false, sourceCommit: (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(), files,
    lockfileSha256: createHash('sha256').update(lock).digest('hex'),
  }));
  const pack = () => execute('npm', ['pack', '--json', '--cache', path.join(temp, 'cache'), '--pack-destination', output], { cwd: root, env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  return { root, output, temp, env, lock, files, pack };
}

test('real npm pack excludes local state and its installed lifecycle restores verified runtime files', async (t) => {
  const { root, output, temp, env, lock, files, pack } = await packageFixture(t);
  const packed = await pack();
  const [archive] = JSON.parse(packed.stdout);
  checkPackedFiles(archive.files);
  const names = new Set(archive.files.map((file) => file.path));
  assert.ok(names.has('shell/upgrade-lock.yaml'));
  for (const name of Object.keys(files)) assert.ok(names.has('static/' + name));
  await assert.rejects(fs.access(path.join(root, 'shell/upgrade-lock.yaml')), { code: 'ENOENT' });
  const prefix = path.join(temp, 'installed');
  await execute('npm', ['install', '--offline', '--omit=dev', '--no-audit', '--no-fund', '--cache', path.join(temp, 'cache'), '--prefix', prefix, path.join(output, archive.filename)], { cwd: temp, env, timeout: 60000 });
  const installed = path.join(prefix, 'node_modules/@whyour/qinglong');
  assert.equal(await fs.readFile(path.join(installed, 'pnpm-lock.yaml'), 'utf8'), lock);
  assert.equal(typeof require(path.join(installed, 'shell/upgrade.cjs')).stageUpgrade, 'function');
  assert.ok((await fs.stat(path.join(installed, 'shell/update.sh'))).mode & 0o111);
  for (const name of ['ql', 'task', 'qinglong']) await fs.access(path.join(prefix, 'node_modules/.bin', name));
  await fs.writeFile(path.join(installed, 'shell/upgrade-lock.yaml'), 'tampered');
  assert.throws(() => restorePackageLock(installed), /does not match/);
  assert.equal(await fs.readFile(path.join(installed, 'pnpm-lock.yaml'), 'utf8'), lock);
  assert.ok(!(await fs.readdir(installed)).some((name) => name.startsWith('.upgrade-lock-')));
});

test('postinstall still supports minimal Docker dependency stages before shell files are copied', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-npm-builder-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const metadata = JSON.parse(await fs.readFile('package.json', 'utf8'));
  await fs.writeFile(path.join(temp, 'package.json'), JSON.stringify({ scripts: { postinstall: metadata.scripts.postinstall } }));
  await fs.writeFile(path.join(temp, 'pnpm-lock.yaml'), 'source lock');
  await execute('npm', ['run', 'postinstall', '--cache', path.join(temp, 'cache')], { cwd: temp, timeout: 30000 });
});

test('a missing npm runtime lockfile fails instead of claiming an installed package is ready', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-npm-lock-missing-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  assert.throws(() => restorePackageLock(temp), /Missing npm package upgrade lockfile/);
});

test('npm publication consumes the exact archive whose isolated installation passed', () => {
  const yaml = require('js-yaml');
  const sync = require('node:fs');
  const workflow = yaml.load(sync.readFileSync('.github/workflows/build-docker-image.yml', 'utf8'));
  const verify = workflow.jobs['verify-npm-package'];
  assert.deepEqual(verify.needs, ['build-static', 'build-npm-migration-bundle']);
  assert.ok(verify.steps.some((step) => step.with?.name === 'npm-migration-bundle-${{ github.sha }}'));
  const migration = workflow.jobs['build-npm-migration-bundle'];
  assert.equal(migration.needs, 'build-debian');
  assert.ok(migration.steps.some((step) => /Dockerfile.upgrade-bundle/.test(step.run || '')));
  assert.ok(!migration.steps.some((step) => /publish-upgrade-bundles/.test(step.run || '')));
  assert.deepEqual(verify.strategy.matrix.node, ['20.18.1', '24']);
  assert.match(verify.container, /node:.*bookworm/);
  const tools = verify.steps.find((step) => step.name === 'Install isolated service test tools');
  assert.match(tools.run, /npm install --global --prefix \/usr\/local.*pm2@6\.0\.14/);
  const service = verify.steps.find((step) => step.name === 'Install and upgrade the exact npm archive');
  assert.equal(service.env.QL_PANEL_TEST_PM2, '/usr/local/bin/pm2');
  assert.ok(workflow.jobs.publish.needs.includes('verify-npm-package'));
  const download = workflow.jobs.publish.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, 'qinglong-npm-${{ github.sha }}');
  const publication = workflow.jobs.publish.steps.find((step) => step.name === 'Publish npm package with OIDC');
  assert.match(publication.run, /npm publish "\$archive" --ignore-scripts/);
  assert.ok(!workflow.jobs.publish.steps.some((step) => /pnpm build/.test(step.run || '')));
});

for (const scenario of ['dirty-source', 'stale-commit', 'dirty-build', 'changed-lock', 'changed-output', 'missing-output', 'extra-output']) {
  test(`native npm pack rejects ${scenario} before producing an archive`, async (t) => {
    const { root, output, pack } = await packageFixture(t);
    const manifestFile = path.join(root, 'static/build-info.json');
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    if (scenario === 'dirty-source') await fs.appendFile(path.join(root, 'shell/start.sh'), '\n# uncommitted change\n');
    if (scenario === 'stale-commit') {
      await fs.appendFile(path.join(root, 'shell/start.sh'), '\n# committed change after build\n');
      await execute('git', ['add', '-A'], { cwd: root });
      await execute('git', ['-c', 'user.name=Package Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'new source'], { cwd: root });
    }
    if (scenario === 'dirty-build') { manifest.dirty = true; await fs.writeFile(manifestFile, JSON.stringify(manifest)); }
    if (scenario === 'changed-lock') {
      await fs.appendFile(path.join(root, 'pnpm-lock.yaml'), '# changed lock\n');
      await execute('git', ['add', '-A'], { cwd: root });
      await execute('git', ['-c', 'user.name=Package Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'new lock'], { cwd: root });
      manifest.sourceCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
      await fs.writeFile(manifestFile, JSON.stringify(manifest));
    }
    if (scenario === 'changed-output') await fs.appendFile(path.join(root, 'static/build/app.js'), 'changed');
    if (scenario === 'missing-output') await fs.rm(path.join(root, 'static/build/app.js'));
    if (scenario === 'extra-output') await fs.writeFile(path.join(root, 'static/build/leftover.js'), 'old');
    await assert.rejects(pack(), (error) => {
      assert.match(error.stderr, /clean source|do not match|checksum mismatch|file set mismatch/i);
      return true;
    });
    assert.deepEqual(await fs.readdir(output), []);
    await assert.rejects(fs.access(path.join(root, 'shell/upgrade-lock.yaml')), { code: 'ENOENT' });
  });
}
