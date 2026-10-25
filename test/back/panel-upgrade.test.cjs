const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const {
  startJob,
  getStatus,
  runJob,
} = require('../../cli/src/internal/maintenance/panelUpgrade.cjs');
const { downloadWithProgress } = require('../../shell/upgrade.cjs');
const {
  writeManifest,
  sourceCommit,
} = require('../helpers/upgrade-fixture.cjs');

async function fixture(t, targetVersion = '2.24.0') {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-panel-job-'));
  const root = path.join(base, 'panel'),
    tmp = path.join(root, '.tmp');
  const source = path.join(base, `qinglong-${sourceCommit}`);
  const staticRoot = path.join(base, 'qinglong-static-master');
  const write = async (name, contents) => {
    await fs.mkdir(path.dirname(name), { recursive: true });
    await fs.writeFile(name, contents);
  };
  for (const dir of [root, source]) {
    await write(
      path.join(dir, 'package.json'),
      JSON.stringify({ version: targetVersion }),
    );
    await write(path.join(dir, 'pnpm-lock.yaml'), 'lock');
    await write(path.join(dir, 'sample/config.sample.sh'), '# config');
  }
  await write(
    path.join(root, 'node_modules/dependency'),
    'installed dependency',
  );
  await write(path.join(root, 'version.yaml'), 'version: 2.23.0');
  await write(path.join(source, 'version.yaml'), `version: ${targetVersion}`);
  await write(path.join(staticRoot, 'build/app.js'), 'new backend');
  writeManifest(source, staticRoot);
  for (const repo of ['qinglong', 'qinglong-static'])
    execFileSync(
      'zip',
      [
        '-qr',
        path.join(base, `${repo}.zip`),
        repo === 'qinglong' ? path.basename(source) : path.basename(staticRoot),
      ],
      { cwd: base },
    );
  await write(
    path.join(root, 'shell/share.sh'),
    `
import_config() { :; }
delete_pm2() { printf stopped >> "$QL_DIR/stops"; }
reload_pm2() { printf started >> "$QL_DIR/starts"; }
npm_install_2() { mkdir -p "$1/node_modules"; printf installed > "$1/node_modules/dependency"; exit_status=0; }
`,
  );
  await write(path.join(root, 'shell/env.sh'), '');
  await write(
    path.join(base, 'bin/curl'),
    `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (process.env.CHECK_WORKER_PARENT === 'true') {
  const { execFileSync } = require('node:child_process');
  const parent = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim());
  fs.writeFileSync(path.join(process.env.ARCHIVES, 'worker-parent.json'), JSON.stringify({ worker: process.ppid, parent }));
}
const repo = args.at(-1).includes('/qinglong-static/') ? 'qinglong-static' : 'qinglong';
if (process.env.FAIL_DOWNLOAD === 'true') process.exit(22);
const buffer = fs.readFileSync(path.join(process.env.ARCHIVES, repo + '.zip'));
fs.writeFileSync(args[args.indexOf('--dump-header') + 1], 'HTTP/1.1 200 OK\\r\\nContent-Length: ' + buffer.length + '\\r\\n\\r\\n');
fs.writeFileSync(args[args.indexOf('--output') + 1], buffer);
`,
  );
  await fs.chmod(path.join(base, 'bin/curl'), 0o700);
  const runtime = {
    version: targetVersion,
    sourceCommit,
    instanceId: 'after-restart',
    parentPid: 100002,
    backendSha256: JSON.parse(
      await fs.readFile(path.join(staticRoot, 'build-info.json'), 'utf8'),
    ).files['build/app.js'],
  };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        code: 200,
        data: req.url.endsWith('/api/system')
          ? { version: runtime.version }
          : {
              status: 'ok',
              build: {
                ...runtime,
                instanceId: syncFs.existsSync(path.join(root, 'starts'))
                  ? runtime.instanceId
                  : 'before-restart',
                parentPid: syncFs.existsSync(path.join(root, 'starts'))
                  ? runtime.parentPid
                  : 100001,
              },
            },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const env = {
    ...process.env,
    PATH: `${base}/bin:${process.env.PATH}`,
    ARCHIVES: base,
    QL_BRANCH: 'master',
    QlPort: String(server.address().port),
  };
  t.after(async () => {
    server.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  return { root, tmp, env, base, runtime };
}

async function finished(tmp) {
  for (let i = 0; i < 200; i++) {
    const status = await getStatus(tmp);
    if (['ready', 'completed', 'failed'].includes(status.status)) return status;
    await delay(25);
  }
  assert.fail('Worker did not finish');
}

test('panel jobs are reparented before running outside the initiating backend process tree', async (t) => {
  const f = await fixture(t);
  f.env.CHECK_WORKER_PARENT = 'true';
  await startJob(f, 'download');
  const ready = await finished(f.tmp);
  assert.equal(ready.status, 'ready', ready.log);
  const relationship = JSON.parse(
    await fs.readFile(path.join(f.base, 'worker-parent.json'), 'utf8'),
  );
  assert.equal(relationship.worker, ready.pid);
  assert.notEqual(
    relationship.parent,
    process.pid,
    'PM2 must not find the upgrade worker in the backend process tree',
  );
});

test('detached download survives its initiating request and is idempotent; applying is explicit', async (t) => {
  const f = await fixture(t);
  const [first, duplicate] = await Promise.all([
    startJob(f, 'download'),
    startJob(f, 'download'),
  ]);
  assert.equal(first.id, duplicate.id);
  const ready = await finished(f.tmp);
  assert.equal(ready.status, 'ready', ready.log);
  assert.equal(ready.version, '2.24.0');
  assert.equal(ready.sourceCommit, sourceCommit);
  assert.equal(syncFs.existsSync(path.join(f.root, 'stops')), false);
  assert.equal((await startJob(f, 'download')).id, ready.id);
  const applying = await startJob(f, 'apply');
  assert.notEqual(applying.id, ready.id);
  const complete = await finished(f.tmp);
  assert.equal(complete.status, 'completed', complete.log);
  assert.equal(
    await fs.readFile(path.join(f.root, 'stops'), 'utf8'),
    'stopped',
  );
  assert.equal(
    await fs.readFile(path.join(f.root, 'version.yaml'), 'utf8'),
    'version: 2.24.0',
  );
  assert.equal(
    await fs.readFile(path.join(f.root, 'node_modules/dependency'), 'utf8'),
    'installed dependency',
  );
});

test('prerelease version is retained through download and restart verification', async (t) => {
  const f = await fixture(t, '2.24.0-dev.0');
  await startJob(f, 'download');
  const ready = await finished(f.tmp);
  assert.equal(ready.status, 'ready', ready.log);
  assert.equal(ready.version, '2.24.0-dev.0');
  await startJob(f, 'apply');
  const complete = await finished(f.tmp);
  assert.equal(complete.status, 'completed', complete.log);
  assert.equal(
    await fs.readFile(path.join(f.root, 'version.yaml'), 'utf8'),
    'version: 2.24.0-dev.0',
  );
});

test('invalid staged payload fails asynchronously before stopping the panel', async (t) => {
  const f = await fixture(t);
  await startJob(f, 'download');
  assert.equal((await finished(f.tmp)).status, 'ready');
  const pointer = JSON.parse(
    await fs.readFile(path.join(f.tmp, 'upgrade-ready-master.json'), 'utf8'),
  );
  await fs.writeFile(
    path.join(f.tmp, pointer.directory, 'qinglong-static-master/build/app.js'),
    'corrupted',
  );
  const queued = await startJob(f, 'apply');
  assert.equal(queued.status, 'starting');
  const failed = await finished(f.tmp);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /checksum|损坏/);
  assert.equal(syncFs.existsSync(path.join(f.root, 'stops')), false);
  assert.equal(
    await fs.readFile(path.join(f.root, 'version.yaml'), 'utf8'),
    'version: 2.23.0',
  );
});

test('failed download persists its failure without stopping the panel and can be retried', async (t) => {
  const f = await fixture(t);
  await startJob(
    { ...f, env: { ...f.env, FAIL_DOWNLOAD: 'true' } },
    'download',
  );
  const failed = await finished(f.tmp);
  assert.equal(failed.status, 'failed');
  assert.match(failed.log, /curl failed/);
  assert.equal(syncFs.existsSync(path.join(f.root, 'stops')), false);
  await startJob(f, 'download');
  assert.equal((await finished(f.tmp)).status, 'ready');
});

test('orphaned jobs become retryable and status log reads are bounded', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-orphan-job-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(tmp, 'panel-upgrade.json'),
    JSON.stringify({ status: 'starting', startedAt: 0 }),
  );
  await fs.writeFile(path.join(tmp, 'panel-upgrade.log'), 'x'.repeat(100000));
  const result = await getStatus(tmp);
  assert.equal(result.status, 'failed');
  assert.equal(Buffer.byteLength(result.log), 32768);
});

test('a healthy backend with the wrong version rolls the update back', async (t) => {
  const f = await fixture(t);
  await startJob(f, 'download');
  assert.equal((await finished(f.tmp)).status, 'ready');
  f.runtime.version = '2.23.0';
  await startJob(f, 'apply');
  const failed = await finished(f.tmp);
  assert.equal(failed.status, 'failed', failed.log);
  assert.match(failed.error, /版本/);
  assert.equal(
    await fs.readFile(path.join(f.root, 'version.yaml'), 'utf8'),
    'version: 2.23.0',
  );
  assert.equal(
    await fs.readFile(path.join(f.root, 'starts'), 'utf8'),
    'startedstarted',
  );
});

for (const [name, patch] of [
  ['same version but old commit', { sourceCommit: 'b'.repeat(40) }],
  ['same commit but wrong backend', { backendSha256: '0'.repeat(64) }],
  ['process did not restart', { instanceId: 'before-restart' }],
  ['only the HTTP worker restarted', { parentPid: 100001 }],
])
  test(`a healthy backend cannot claim update success: ${name}`, async (t) => {
    const f = await fixture(t);
    await startJob(f, 'download');
    assert.equal((await finished(f.tmp)).status, 'ready');
    Object.assign(f.runtime, patch);
    await startJob(f, 'apply');
    const status = await finished(f.tmp);
    assert.equal(status.status, 'failed', status.log);
    assert.match(status.error, /版本/);
    assert.equal(
      await fs.readFile(path.join(f.root, 'version.yaml'), 'utf8'),
      'version: 2.23.0',
    );
  });

for (const name of ['package.json', 'pnpm-lock.yaml', 'node_modules'])
  test(`reused dependencies are checked again before stopping: ${name}`, async (t) => {
    const f = await fixture(t);
    await startJob(f, 'download');
    assert.equal((await finished(f.tmp)).status, 'ready');
    if (name === 'node_modules')
      await fs.rm(path.join(f.root, name), { recursive: true });
    else await fs.writeFile(path.join(f.root, name), 'changed after download');
    await assert.rejects(startJob(f, 'apply'), /依赖已变化/);
    assert.equal(syncFs.existsSync(path.join(f.root, 'stops')), false);
  });

test('changed dependencies are fully staged and installed instead of reusing the current tree', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'pnpm-lock.yaml'), 'old lock');
  await startJob(f, 'download');
  assert.equal((await finished(f.tmp)).status, 'ready');
  await startJob(f, 'apply');
  const status = await finished(f.tmp);
  assert.equal(status.status, 'completed', status.log);
  assert.equal(
    await fs.readFile(path.join(f.root, 'node_modules/dependency'), 'utf8'),
    'installed',
  );
  assert.equal(
    await fs.readFile(path.join(f.root, 'pnpm-lock.yaml'), 'utf8'),
    'lock',
  );
});

async function replaceStage(f) {
  const pointer = path.join(f.tmp, 'upgrade-ready-master.json');
  const selected = JSON.parse(await fs.readFile(pointer, 'utf8'));
  const directory = `upgrade-${randomUUID()}`;
  const workspace = path.join(f.tmp, directory);
  await fs.cp(path.join(f.tmp, selected.directory), workspace, {
    recursive: true,
  });
  const readyFile = path.join(workspace, 'ready.json');
  const ready = JSON.parse(await fs.readFile(readyFile, 'utf8'));
  ready.source = path.join(workspace, 'qinglong-master');
  ready.static = path.join(workspace, 'qinglong-static-master');
  await fs.writeFile(readyFile, JSON.stringify(ready));
  await fs.writeFile(pointer, JSON.stringify({ directory }));
}

test('replacing even a same-commit stage requires explicit preparation again', async (t) => {
  const f = await fixture(t);
  await startJob(f, 'download');
  assert.equal((await finished(f.tmp)).status, 'ready');
  await replaceStage(f);
  await assert.rejects(startJob(f, 'apply'), /暂存更新已变化/);
  assert.equal(syncFs.existsSync(path.join(f.root, 'stops')), false);
});

test('the worker revalidates its accepted target under the upgrade lock', async (t) => {
  const f = await fixture(t);
  await startJob(f, 'download');
  const ready = await finished(f.tmp);
  assert.equal(ready.status, 'ready');
  const accepted = {
    ...ready,
    id: randomUUID(),
    status: 'starting',
    action: 'apply',
  };
  delete accepted.log;
  await fs.writeFile(
    path.join(f.tmp, 'panel-upgrade.json'),
    JSON.stringify(accepted),
  );
  await replaceStage(f);
  await runJob(f, accepted.id);
  const failed = await getStatus(f.tmp);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /暂存更新已变化/);
  assert.equal(syncFs.existsSync(path.join(f.root, 'stops')), false);
});

test('an in-progress download cannot be reported as an accepted restart', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.tmp, { recursive: true });
  await fs.writeFile(
    path.join(f.tmp, 'panel-upgrade.json'),
    JSON.stringify({
      id: randomUUID(),
      status: 'running',
      action: 'download',
      pid: process.pid,
    }),
  );
  await assert.rejects(startJob(f, 'apply'), /已有更新/);
  assert.equal(syncFs.existsSync(path.join(f.root, 'stops')), false);
});

async function selectCli(f) {
  const cliRoot = path.join(f.base, 'selected-cli');
  const write = async (relative, contents) => {
    const file = path.join(cliRoot, 'dist/internal', relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  };
  await write(
    'runtime/context.js',
    `exports.createContext = (values, env) => ({ root: values.root, env, paths: { file_config_user: values.root + '/data/config/config.sh', dir_preload: values.root + '/shell/preload' } }); exports.sourceEnvironment = async env => env;`,
  );
  await write(
    'runtime/cancellation.js',
    `exports.cancellableOperation = async (signal, operation) => { signal?.throwIfAborted(); return operation(); };`,
  );
  await write(
    'maintenance/operator.js',
    `
const fs = require('node:fs/promises'), path = require('node:path');
exports.stopPanel = ctx => fs.appendFile(path.join(ctx.root, 'cli-stops'), 'stopped');
exports.startPanel = ctx => fs.appendFile(path.join(ctx.root, 'starts'), 'started');
exports.installPanelDependencies = async (ctx, source) => {
  await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(source, 'node_modules/dependency'), 'selected-cli');
};`,
  );
  await write(
    'maintenance/upgradeSelection.js',
    `
const fs = require('node:fs/promises'), path = require('node:path');
exports.prepareUpgradeSelection = async (ctx) => {
  const directory = await fs.mkdtemp(path.join(ctx.root, '.tmp/selected-loader-'));
  const target = path.join(ctx.root, 'static/build/loaders/deps.js');
  const source = path.join(directory, 'deps.js');
  await fs.copyFile(target, source);
  return { directory, source, target };
};`,
  );
  const loader = path.join(f.root, 'static/build/loaders/deps.js');
  await fs.mkdir(path.dirname(loader), { recursive: true });
  await fs.writeFile(loader, '// selected CLI loader');
  f.env.QL_CLI_ROOT = cliRoot;
  return loader;
}

for (const fail of [false, true])
  test(`selected CLI lifecycle and loader survive panel updating; rollback=${fail}`, async (t) => {
    const f = await fixture(t);
    const loader = await selectCli(f);
    await fs.writeFile(path.join(f.root, 'pnpm-lock.yaml'), 'old lock');
    await startJob(f, 'download');
    const ready = await finished(f.tmp);
    assert.equal(ready.status, 'ready', ready.log);
    if (fail) f.runtime.sourceCommit = 'b'.repeat(40);
    await startJob(f, 'apply');
    const status = await finished(f.tmp);
    assert.equal(status.status, fail ? 'failed' : 'completed', status.log);
    assert.equal(await fs.readFile(loader, 'utf8'), '// selected CLI loader');
    assert.equal(
      syncFs.existsSync(path.join(f.root, 'stops')),
      false,
      'legacy broad shell stop was not used',
    );
    assert.match(
      await fs.readFile(path.join(f.root, 'cli-stops'), 'utf8'),
      /stopped/,
    );
    if (!fail)
      assert.equal(
        await fs.readFile(path.join(f.root, 'node_modules/dependency'), 'utf8'),
        'selected-cli',
      );
  });

for (const knownSize of [true, false])
  test(`download progress measures real bytes and handles unknown totals; known=${knownSize}`, async (t) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-progress-'));
    t.after(() => fs.rm(tmp, { recursive: true, force: true }));
    const reports = [];
    await downloadWithProgress(
      async (program, args) => {
        assert.equal(program, 'curl');
        await fs.writeFile(
          args[args.indexOf('--dump-header') + 1],
          `HTTP/1.1 302 Found\r\nContent-Length: 1\r\n\r\nHTTP/2 200 OK\r\n${
            knownSize ? 'Content-Length: 100\r\n' : ''
          }\r\n`,
        );
        const archive = args[args.indexOf('--output') + 1];
        await fs.writeFile(archive, Buffer.alloc(50));
        await delay(1150);
        await fs.writeFile(archive, Buffer.alloc(100));
      },
      path.join(tmp, 'file.zip'),
      'https://example.test/file.zip',
      'qinglong',
      async (report) => reports.push(report),
    );
    assert.ok(reports.some((r) => r.downloadedBytes === 50));
    assert.equal(reports[0].percent, knownSize ? 50 : null);
    assert.equal(reports.at(-1).downloadedBytes, 100);
    assert.equal(reports.at(-1).percent, knownSize ? 100 : null);
  });

test('asynchronous apply still rejects unsafe stage pointers before dispatch', async (t) => {
  const f = await fixture(t);
  await startJob(f, 'download');
  assert.equal((await finished(f.tmp)).status, 'ready');
  await fs.writeFile(
    path.join(f.tmp, 'upgrade-ready-master.json'),
    JSON.stringify({ directory: '../outside' }),
  );
  await assert.rejects(startJob(f, 'apply'), /指针|pointer/);
  assert.equal(syncFs.existsSync(path.join(f.root, 'stops')), false);
});
