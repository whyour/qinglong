// Run service tests only inside a disposable Linux container or CI job.
// Unlike source-tree tests, these load the published entrypoints and dependencies.
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const execute = promisify(execFile);
const repository = path.resolve(__dirname, '..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const run = (program, args, options = {}) => execute(program, args, {
  encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000,
  ...options,
});
const requiredFiles = [
  '.env.example', 'back/protos/api.proto', 'ecosystem.config.js', 'version.yaml',
  'shell/upgrade.cjs', 'shell/install-bundle.cjs', 'shell/install-package.cjs',
  'shell/upgrade-lock.yaml', 'shell/start.sh', 'shell/start-simplify.sh',
  'shell/task.sh', 'shell/preload/client.js', 'shell/preload/client.py',
  'shell/preload/sitecustomize.js', 'shell/preload/sitecustomize.py',
  'shell/preload/esm-loader.mjs', 'shell/preload/notificationAudit.js',
  'sample/config.sample.sh', 'sample/auth.sample.json',
  'static/build-info.json', 'static/build/app.js', 'static/build/token.js',
  'static/build/bootstrap/upgradeProbe.js',
  'static/dist/index.html',
  ...['upgradeArtifacts', 'platformBundle', 'upgradePrestart', 'panelUpgrade', 'nodeRuntime']
    .map((name) => `cli/src/internal/maintenance/${name}.cjs`),
];

function checkPackedFiles(files) {
  const names = new Set(files.map((file) => file.path));
  for (const name of requiredFiles) assert.ok(names.has(name), `Missing npm runtime: ${name}`);
  for (const name of names) {
    assert.ok(/^(?:package\.json$|LICENSE$|README[^/]*\.md$|\.env\.example$|ecosystem\.config\.js$|version\.yaml$|back\/protos\/api\.proto$|cli\/(?:README[^/]*\.md$|src\/internal\/maintenance\/[^/]+\.cjs$)|sample\/|shell\/|static\/)/.test(name), `Unexpected npm file: ${name}`);
    assert.ok(!/^shell\/(?:pub\.sh$|preload\/(?:env\.|notify\.|__ql_notify__\.|lang_env\.sh|.*-notify\.json))/.test(name), `Generated or release-only runtime file: ${name}`);
    assert.ok(!/(?:^|\/)__pycache__\/|\.pyc$|(?:^|\/)\.DS_Store$/.test(name), name);
    assert.notEqual(name, 'sample/tool.ts');
  }
}

async function packPanel(output) {
  const git = (...args) => run('git', args, { cwd: repository });
  assert.equal((await git('status', '--porcelain', '--untracked-files=all')).stdout.trim(), '', 'Pack only from a clean source checkout');
  await run(process.execPath, [path.join(repository, 'docker/verify-build.cjs')], { cwd: repository });
  await fs.mkdir(output, { recursive: true });
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-npm-pack-cache-'));
  try {
    const result = await run('npm', ['pack', '--json', '--cache', cache, '--pack-destination', output], { cwd: repository });
    const [manifest] = JSON.parse(result.stdout);
    checkPackedFiles(manifest.files);
    assert.equal(manifest.name, '@whyour/qinglong');
    const build = await read(path.join(repository, 'static/build-info.json'));
    const names = new Set(manifest.files.map((file) => file.path));
    for (const name of Object.keys(build.files)) assert.ok(names.has(`static/${name}`), `npm filtered a verified build artifact: ${name}`);
    const receipt = {
      filename: manifest.filename, sha256: hash(await fs.readFile(path.join(output, manifest.filename))),
      sourceCommit: build.sourceCommit, size: manifest.size, fileCount: manifest.files.length,
    };
    await fs.writeFile(path.join(output, 'package-receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
    return receipt;
  } finally {
    await fs.rm(cache, { recursive: true, force: true });
    // Also recover an interrupted npm pack whose postpack hook did not execute.
    await fs.rm(path.join(repository, 'shell/upgrade-lock.yaml'), { force: true });
  }
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Consume the unmodified output of Dockerfile.upgrade-bundle / buildBundle.
async function platformFixture(root, directory, expectedCommit) {
  assert.ok(directory, 'Set QL_PANEL_TEST_BUNDLE_DIR to the official platform bundle output');
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith('.tar.gz'));
  assert.equal(names.length, 1, 'Expected one official platform package');
  const archive = path.resolve(directory, names[0]);
  const record = await read(archive + '.json');
  const bytes = await fs.readFile(archive);
  assert.equal(record.format, 2);
  assert.equal(record.sourceCommit, expectedCommit);
  assert.equal(record.filename, names[0]);
  assert.equal(record.sha256, hash(bytes));
  assert.equal(record.size, bytes.length);
  assert.match(record.baseImage, /^ghcr\.io\/[^@]+@sha256:[a-f0-9]{64}$/);
  const local = createRequire(path.join(root, 'package.json'));
  const bundle = local('./cli/src/internal/maintenance/platformBundle.cjs');
  assert.equal(record.target, bundle.targetKey(await bundle.runtimeTarget()));
  return { ...record, archive };
}

async function legacyArchive(temp, env) {
  const directory = path.join(temp, 'legacy');
  await fs.mkdir(directory);
  const result = await run('npm', ['pack', '@whyour/qinglong@2.23.0', '--ignore-scripts', '--json', '--registry=https://registry.npmjs.org', '--pack-destination', directory, '--cache', path.join(temp, 'cache')], { cwd: temp, env, timeout: 300000 });
  const [record] = JSON.parse(result.stdout);
  assert.equal(record.name, '@whyour/qinglong');
  assert.equal(record.version, '2.23.0');
  assert.equal(record.filename, 'whyour-qinglong-2.23.0.tgz');
  const archive = path.join(directory, record.filename);
  const integrity = 'sha512-' + createHash('sha512').update(await fs.readFile(archive)).digest('base64');
  assert.equal(integrity, 'sha512-x6B9s1/SRKkHe7jRQtb3LzMluJ3O3PAAssrr/5jaFMMl7DZvABSEiqkkZMu0r1BNtiCF72uj8OqXN9pCnF2WVw==', 'Published legacy package integrity changed');
  return { archive, integrity, version: record.version };
}

async function verifyPanel(input, output) {
  assert.equal(process.platform, 'linux', 'Service tests require Linux');
  assert.equal(process.env.QL_PANEL_PACKAGE_TEST_ISOLATED, '1', 'Run only inside a disposable Linux container: QL_PANEL_PACKAGE_TEST_ISOLATED=1');
  const stat = await fs.stat(input);
  if (stat.isDirectory()) {
    const names = (await fs.readdir(input)).filter((name) => name.endsWith('.tgz'));
    assert.equal(names.length, 1, 'Expected one exact npm archive');
    input = path.join(input, names[0]);
  }
  const expected = await read(path.join(path.dirname(input), 'package-receipt.json'));
  assert.equal(path.basename(input), expected.filename);
  assert.equal(hash(await fs.readFile(input)), expected.sha256, 'npm archive differs from its build receipt');
  assert.equal((await fs.stat(input)).size, expected.size);
  assert.match(expected.sourceCommit, /^[a-f0-9]{40}$/);
  if (process.env.GITHUB_SHA) assert.equal(expected.sourceCommit, process.env.GITHUB_SHA);
  const nodeSha = hash(await fs.readFile(process.execPath));
  const pm2 = process.env.QL_PANEL_TEST_PM2;
  assert.ok(pm2 && path.isAbsolute(pm2), 'Set QL_PANEL_TEST_PM2 to an isolated PM2 executable');
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ql-npm-install-')));
  const home = path.join(temp, 'home'), prefix = path.join(temp, 'prefix'), data = path.join(temp, 'data');
  await fs.mkdir(home);
  await fs.mkdir(data);
  const port = await unusedPort();
  let grpcPort = await unusedPort();
  while (grpcPort === port) grpcPort = await unusedPort();
  const env = { ...process.env, HOME: home, PM2_HOME: path.join(temp, '.pm2'),
    QL_DATA_DIR: data, QL_BRANCH: 'develop', NODE_ENV: 'production', QL_CONTAINER: 'false',
    BACK_PORT: String(port), GRPC_PORT: String(grpcPort), QlPort: String(port), QlGrpcPort: String(grpcPort),
    BIND_HOST: '127.0.0.1', BIND_HOST_GRPC: '127.0.0.1',
    NODE_PATH: '', NODE_OPTIONS: '',
    PATH: [path.join(prefix, 'bin'), path.dirname(pm2), process.env.PATH].join(path.delimiter),
  };
  for (const key of ['QL_CLI_ROOT', 'QL_DIR', 'QL_UPGRADE_FILE', 'QL_UPGRADE_REPAIR_DEPS', 'QL_UPGRADE_LAUNCHER_PID', 'QL_UPGRADE_INDEX_URL']) delete env[key];
  let root, fixtureServer, token;
  const api = async (route, method = 'GET', body, anonymous = false) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
      method, headers: { 'Content-Type': 'application/json', ...(!anonymous && token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    assert.equal(result.code, 200, `${method} ${route}: ${result.message}`);
    return result.data;
  };
  const healthy = async () => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      try { const value = await api('health', 'GET', undefined, true); if (value.status === 'ok') return value; } catch {}
      await delay(300);
    }
    throw new Error('Installed npm backend did not become healthy');
  };
  const job = async (id, status) => {
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      try {
        const value = await api('system/update-status');
        assert.equal(value.id, id);
        if (value.status === status) return value;
        if (value.status === 'failed' && status !== 'failed') throw new Error(value.error);
      } catch (error) {
        if (!/fetch failed|ECONNRESET|ECONNREFUSED|aborted|timeout/i.test(error.message)) throw error;
      }
      await delay(250);
    }
    throw new Error(`Installed npm update never reached ${status}`);
  };
  try {
    const install = (archive) => run('npm', ['install', '--global', '--prefix', prefix, '--force', '--omit=dev', '--no-audit', '--no-fund', '--cache', path.join(temp, 'cache'), archive], { cwd: temp, env, timeout: 600000 });
    const start = () => run(path.join(prefix, 'bin/qinglong'), ['reload'], { cwd: temp, env, timeout: 180000 });
    const stop = () => run(pm2, ['delete', 'ecosystem.config.js'], { cwd: root, env });
    console.log(`Installing actual npm archive with production lifecycle scripts on ${process.version}`);
    await install(input);
    const globalRoot = (await run('npm', ['root', '--global', '--prefix', prefix], { cwd: temp, env })).stdout.trim();
    root = path.join(globalRoot, '@whyour/qinglong');
    env.QL_DIR = root;
    // Use a subprocess: cached candidate modules must not mask missing files
    // after old-package installation and the real npm overwrite below.
    await run(process.execPath, ['-e', `const root=process.argv[1],p=require('node:path');const m=require(root+'/package.json');for(const target of Object.values(m.bin))require('node:fs').accessSync(p.join(root,target));for(const name of ['platformBundle','upgradePrestart','panelUpgrade'])require(root+'/cli/src/internal/maintenance/'+name+'.cjs');require(root+'/shell/upgrade.cjs').verifyUpgrade(root,p.join(root,'static')).catch(e=>{console.error(e);process.exitCode=1});`, root], { env, cwd: temp });
    env.QL_DATA_DIR = path.join(temp, 'fresh/data');
    await fs.mkdir(env.QL_DATA_DIR, { recursive: true });
    console.log('Starting the freshly installed npm package');
    await start();
    const fresh = await healthy();
    assert.equal(fresh.build.sourceCommit, expected.sourceCommit);
    assert.equal(fresh.services.grpc, true);
    assert.match(await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()), /<html/i);
    await stop();
    await fs.rm(path.join(temp, 'fresh'), { recursive: true, force: true });
    env.QL_DATA_DIR = data;
    console.log('Installing the integrity-pinned published legacy npm package');
    const legacy = await legacyArchive(temp, env);
    await install(legacy.archive);
    assert.equal((await read(path.join(root, 'package.json'))).version, legacy.version);
    await assert.rejects(fs.access(path.join(root, 'cli/src/internal/maintenance/platformBundle.cjs')), { code: 'ENOENT' });
    const legacyBackendSha = hash(await fs.readFile(path.join(root, 'static/build/app.js')));
    await start();
    await healthy();
    const credentials = { username: 'npm_package_verification', password: `Test_${randomUUID()}!` };
    await api('user/init', 'PUT', credentials, true);
    token = (await api('user/login', 'POST', credentials, true)).token;
    const nonce = randomUUID();
    await api('envs', 'POST', [{ name: 'NPM_PACKAGE_PRESERVE', value: nonce }]);
    const script = path.join(data, 'scripts/npm-package-check.js');
    await fs.writeFile(script, `console.log(${JSON.stringify(nonce)});\n`);
    const cron = await api('crons', 'POST', { name: 'npm package retained task', command: `node ${script}`, schedule: '0 0 1 1 *' });
    const userConfig = path.join(data, 'config/config.sh');
    await fs.appendFile(userConfig, `\n# retained npm package setting ${nonce}\n`);
    const userConfigSha = hash(await fs.readFile(userConfig));
    const preservedData = async () => {
      assert.equal((await api('user')).username, credentials.username);
      assert.ok((await api('envs')).some((x) => x.name === 'NPM_PACKAGE_PRESERVE' && x.value === nonce));
      assert.equal((await api(`crons/${cron.id}`)).command, cron.command);
      assert.equal(hash(await fs.readFile(userConfig)), userConfigSha);
      assert.equal(await fs.readFile(script, 'utf8'), `console.log(${JSON.stringify(nonce)});\n`);
    };
    await preservedData();
    console.log('Stopping legacy service and verifying npm automatically preserves its .env during overwrite');
    await stop();
    await fs.appendFile(path.join(root, '.env'), `\n# retained custom npm environment ${nonce}\n`);
    const savedEnv = await fs.readFile(path.join(root, '.env'));
    await install(input);
    assert.deepEqual(await fs.readFile(path.join(root, '.env')), savedEnv);
    assert.equal((await fs.stat(path.join(root, '.env'))).mode & 0o777, 0o600);
    const configSha = hash(savedEnv);
    const local = createRequire(path.join(root, 'package.json'));
    const artifacts = local('./shell/upgrade.cjs');
    const build = await artifacts.verifyUpgrade(root, path.join(root, 'static'));
    assert.equal(build.sourceCommit, expected.sourceCommit);
    assert.notEqual(hash(await fs.readFile(path.join(root, 'static/build/app.js'))), legacyBackendSha);
    assert.equal(hash(await fs.readFile(path.join(root, 'pnpm-lock.yaml'))), build.lockfileSha256);
    const fixture = await platformFixture(root, process.env.QL_PANEL_TEST_BUNDLE_DIR, expected.sourceCommit);
    let badChecksum = true, requests = 0;
    fixtureServer = http.createServer((request, response) => {
      requests++;
      if (request.url === '/latest.json') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ format: 2, sourceCommit: fixture.sourceCommit, packages: { [fixture.target]: { size: fixture.size, sha256: badChecksum ? '0'.repeat(64) : fixture.sha256, url: `http://127.0.0.1:${fixtureServer.address().port}/bundle.tar.gz` } } }));
      } else if (request.url === '/bundle.tar.gz') {
        response.setHeader('Content-Length', fixture.size);
        sync.createReadStream(fixture.archive).pipe(response);
      } else { response.statusCode = 404; response.end(); }
    });
    await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
    env.QL_UPGRADE_INDEX_URL = `http://127.0.0.1:${fixtureServer.address().port}/latest.json`;
    console.log('Starting the overwritten npm package against legacy user data');
    await start();
    const original = await healthy();
    assert.equal(original.build.sourceCommit, build.sourceCommit);
    assert.equal(original.services.grpc, true);
    token = (await api('user/login', 'POST', credentials, true)).token;
    const preserved = async () => {
      await preservedData();
      assert.equal(hash(await fs.readFile(path.join(root, '.env'))), configSha);
    };
    await preserved();
    console.log('Testing a rejected download through the installed panel API');
    const rejected = await api('system/update', 'PUT');
    assert.match((await job(rejected.id, 'failed')).error, /checksum|校验/i);
    assert.equal((await healthy()).build.instanceId, original.build.instanceId);
    await preserved();
    badChecksum = false;
    console.log('Testing installed panel download, prestart and explicit application');
    const accepted = await api('system/update', 'PUT');
    const ready = await job(accepted.id, 'ready');
    assert.equal((await healthy()).build.instanceId, original.build.instanceId);
    const pointer = await read(path.join(root, '.tmp/upgrade-ready-develop.json'));
    const receipt = await read(path.join(root, '.tmp', pointer.directory, 'prestart.json'));
    assert.ok(receipt.completedAt <= ready.updatedAt, 'Readiness was recorded before backend prestart');
    const applying = await api('update/system', 'PUT');
    await job(applying.id, 'completed');
    const afterOnline = await healthy();
    assert.notEqual(afterOnline.build.instanceId, original.build.instanceId);
    assert.equal(afterOnline.build.sourceCommit, fixture.sourceCommit);
    await fs.access(path.join(root, 'node_modules/.pnpm'));
    assert.match(await fs.realpath(path.join(root, 'node_modules/sqlite3')), /[/\\]node_modules[/\\]\.pnpm[/\\]/);
    await fs.access(path.join(root, 'scripts/build-upgrade-bundle.cjs'));
    await artifacts.verifyUpgrade(root, path.join(root, 'static'));
    assert.match(await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text()), /<html/i);
    await preserved();
    console.log('Testing offline installer and Bash reload from the installed npm package');
    const requestsBeforeOffline = requests;
    await run(process.execPath, [path.join(root, 'shell/install-bundle.cjs'), '--root', root, '--file', fixture.archive, '--download-only'], { cwd: temp, env, timeout: 240000 });
    assert.equal(requests, requestsBeforeOffline, 'Offline preparation contacted the index');
    assert.equal((await healthy()).build.instanceId, afterOnline.build.instanceId);
    await run(path.join(prefix, 'bin/ql'), ['reload', 'system'], { cwd: temp, env, timeout: 240000 });
    const afterOffline = await healthy();
    assert.notEqual(afterOffline.build.instanceId, afterOnline.build.instanceId);
    assert.equal(afterOffline.build.sourceCommit, fixture.sourceCommit);
    await fs.access(path.join(root, 'node_modules/.pnpm'));
    assert.equal(hash(await fs.readFile(process.execPath)), nodeSha);
    assert.equal((await api('system/update-status')).status, 'completed');
    await preserved();
    await api('crons/run', 'PUT', [cron.id]);
    let taskExecuted = false;
    for (let i = 0; i < 100; i++) {
      const log = String(await api(`crons/${cron.id}/log`));
      if (log.includes(nonce) && /完成|执行结束|finished|completed/i.test(log)) { taskExecuted = true; break; }
      await delay(300);
    }
    assert.ok(taskExecuted, 'Retained task did not execute after npm package upgrades');
    const result = {
      node: process.version, platform: fixture.target,
      archiveSha256: hash(await fs.readFile(input)), sourceCommit: build.sourceCommit,
      installedProductionDependencies: true, restoredLockVerified: true,
      legacyNpmVersion: legacy.version, legacyNpmIntegrity: legacy.integrity,
      legacyNpmOverwriteInstalled: true, legacyExternalDataPreserved: true,
      customRootEnvironmentPreservedAutomatically: true,
      officialPlatformBundle: { baseImage: fixture.baseImage, sourceCommit: fixture.sourceCommit, sha256: fixture.sha256 },
      migratedFromNpmToOfficialPnpmLayout: true,
      existingNodePreserved: true,
      frontendAndBackendStarted: true, checksumFailureKeptOldService: true,
      prestartBeforeReady: true, onlineActualRestart: true,
      offlinePreparationDidNotContactIndex: true, offlineBashActualRestart: true,
      accountEnvironmentConfigurationAndScriptsPreserved: true, retainedTaskExecuted: true,
      initialBuild: original.build, afterOnline: afterOnline.build, afterOffline: afterOffline.build,
    };
    if (output) {
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(path.join(output, `verification-${process.version}.json`), JSON.stringify(result, null, 2));
    }
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    if (root) {
      for (const file of ['qinglong-error.log', 'qinglong-out.log']) {
        const text = await fs.readFile(path.join(env.PM2_HOME, 'logs', file), 'utf8').catch(() => '');
        if (text) console.error(text.slice(-6000));
      }
    }
    throw error;
  } finally {
    if (fixtureServer) {
      fixtureServer.closeAllConnections();
      await new Promise((resolve) => fixtureServer.close(resolve));
    }
    await run(pm2, ['kill'], { env, cwd: temp }).catch(() => {});
    await run('nginx', ['-s', 'quit'], { env, cwd: temp }).catch(() => {});
    await fs.rm(temp, { recursive: true, force: true });
  }
}

module.exports = { checkPackedFiles, packPanel, verifyPanel };
if (require.main === module) {
  const [action, input, output] = process.argv.slice(2);
  const operation = action === 'pack' && input
    ? packPanel(path.resolve(input))
    : action === 'verify' && input
      ? verifyPanel(path.resolve(input), output && path.resolve(output))
      : Promise.reject(new Error('Usage: node scripts/verify-panel-package.cjs pack OUTPUT | verify ARCHIVE_OR_DIRECTORY [RESULT_DIRECTORY]'));
  operation.catch((error) => { console.error(error); process.exitCode = 1; });
}
