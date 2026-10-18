const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const tar = require('tar');
const bundle = require('../../cli/src/internal/maintenance/platformBundle.cjs');
const artifacts = require('../../shell/upgrade.cjs');

test('ready is published only after prestart; dependency failure repairs once and keeps application hashes', async (t) => {
  const f = await fixture(t);
  const pointer = path.join(f.tmp, 'upgrade-ready-develop.json');
  await fs.writeFile(pointer, 'previous-ready');
  let probes = 0,
    repairs = 0,
    starts = 0;
  const options = {
    root: f.root,
    tmp: f.tmp,
    env: {
      QL_BRANCH: 'develop',
      QL_UPGRADE_FILE: f.archive,
      QL_UPGRADE_REPAIR_DEPS: '1',
    },
    verifyStatic: artifacts.verifyUpgrade,
    probe: async () => {
      if (++probes === 1)
        throw Object.assign(
          new Error(
            'dlopen node_modules/sqlite3/node.node: invalid ELF header',
          ),
          { code: 'ERR_DLOPEN_FAILED' },
        );
    },
    repair: async (source) => {
      repairs++;
      await fs.writeFile(
        path.join(source, 'node_modules/sqlite3/repaired'),
        'rebuilt for this device',
      );
    },
    prestart: async () => {
      starts++;
      assert.equal(await fs.readFile(pointer, 'utf8'), 'previous-ready');
    },
  };
  const selected = await bundle.stageBundle(options);
  assert.equal(repairs, 1);
  assert.equal(probes, 2);
  assert.equal(starts, 1);
  const receipt = JSON.parse(
    await fs.readFile(
      path.join(path.dirname(selected.source), 'prestart.json'),
    ),
  );
  assert.ok(receipt.completedAt);
  assert.ok(
    receipt.dependencyFiles[
      'source/node_modules/.pnpm/sqlite/node_modules/sqlite3/repaired'
    ],
  );
  await fs.writeFile(
    path.join(selected.source, 'version.yaml'),
    'version: 9.9.9',
  );
  await assert.rejects(bundle.verifyStagedBundle(selected), /checksums/);
});

test('offline dependency failure never repairs by default; a failed retry keeps old readiness', async (t) => {
  const f = await fixture(t),
    pointer = path.join(f.tmp, 'upgrade-ready-develop.json');
  await fs.writeFile(pointer, 'previous-ready');
  let repairs = 0,
    starts = 0;
  const options = {
    root: f.root,
    tmp: f.tmp,
    env: { QL_BRANCH: 'develop', QL_UPGRADE_FILE: f.archive },
    verifyStatic: artifacts.verifyUpgrade,
    probe: async () => {},
    prestart: async () => {
      starts++;
      throw Object.assign(new Error("Cannot find module 'decimal.js'"), {
        code: 'MODULE_NOT_FOUND',
      });
    },
    repair: async () => {
      repairs++;
    },
    run: () => assert.fail('offline must not access network'),
  };
  await assert.rejects(
    bundle.stageBundle(options),
    /no network access attempted/,
  );
  assert.equal(repairs, 0);
  await assert.rejects(
    bundle.stageBundle({
      ...options,
      env: { ...options.env, QL_UPGRADE_REPAIR_DEPS: '1' },
    }),
    /Cannot find module/,
  );
  assert.equal(repairs, 1);
  assert.equal(starts, 3);
  assert.equal(await fs.readFile(pointer, 'utf8'), 'previous-ready');
  assert.deepEqual(await fs.readdir(f.tmp), ['upgrade-ready-develop.json']);
});

test('dependency repair cannot change verified source or static files', async (t) => {
  const f = await fixture(t);
  let starts = 0;
  await assert.rejects(
    bundle.stageBundle({
      root: f.root,
      tmp: f.tmp,
      env: {
        QL_BRANCH: 'develop',
        QL_UPGRADE_FILE: f.archive,
        QL_UPGRADE_REPAIR_DEPS: '1',
      },
      verifyStatic: artifacts.verifyUpgrade,
      probe: async () => {
        throw Object.assign(new Error("Cannot find module 'decimal.js'"), {
          code: 'MODULE_NOT_FOUND',
        });
      },
      repair: async (source) =>
        fs.writeFile(path.join(source, 'version.yaml'), 'version: 9.9.9'),
      prestart: async () => {
        starts++;
      },
    }),
    /checksums/,
  );
  assert.equal(starts, 0);
  assert.deepEqual(await fs.readdir(f.tmp), []);
});

test('ARMv6 offline entry re-executes with an interpreted Node while preserving CLI errors', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-armv6-entry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const preload = path.join(directory, 'armv6.cjs');
  const observed = path.join(directory, 'child.json');
  await fs.writeFile(
    preload,
    `if(process.execArgv.includes('--jitless'))require('node:fs').writeFileSync(${JSON.stringify(
      observed,
    )},JSON.stringify({args:process.execArgv,execPath:process.execPath}));else{Object.defineProperty(process,'arch',{value:'arm'});Object.defineProperty(process,'config',{value:{variables:{arm_version:6}}});}`,
  );
  const { execFile } = require('node:child_process');
  const result = await new Promise((resolve) =>
    execFile(
      process.execPath,
      [path.resolve(__dirname, '../../shell/install-bundle.cjs')],
      {
        timeout: 10000,
        env: {
          ...process.env,
          NODE_OPTIONS: '--require ' + JSON.stringify(preload),
        },
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    ),
  );
  assert.equal(result.error.code, 1);
  const child = JSON.parse(await fs.readFile(observed));
  assert.ok(child.args.includes('--jitless'));
  assert.equal(child.execPath, process.execPath);
  assert.match(result.stderr, /Usage: node install-bundle.cjs/);
});
const {
  writeManifest,
  sourceCommit,
} = require('../helpers/upgrade-fixture.cjs');
const {
  releaseIndex,
  platforms,
} = require('../../scripts/publish-upgrade-bundles.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-bundle-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'installed'),
    tmp = path.join(root, '.tmp');
  const payload = path.join(directory, 'qinglong');
  const source = path.join(payload, 'source'),
    staticRoot = path.join(payload, 'static');
  await fs.mkdir(tmp, { recursive: true });
  await fs.mkdir(
    path.join(source, 'node_modules/.pnpm/sqlite/node_modules/sqlite3'),
    { recursive: true },
  );
  await fs.symlink(
    '.pnpm/sqlite/node_modules/sqlite3',
    path.join(source, 'node_modules/sqlite3'),
  );
  await fs.writeFile(
    path.join(source, 'node_modules/sqlite3/package.json'),
    '{"name":"sqlite3"}',
  );
  await fs.mkdir(path.join(source, 'sample'));
  await fs.writeFile(path.join(source, 'sample/config.sample.sh'), '# config');
  await fs.writeFile(
    path.join(source, 'package.json'),
    '{"version":"2.24.0","qinglongUpgradeFormat":2}',
  );
  await fs.writeFile(
    path.join(root, 'package.json'),
    '{"qinglongUpgradeFormat":2}',
  );
  await fs.mkdir(path.join(staticRoot, 'build'), { recursive: true });
  await fs.writeFile(path.join(staticRoot, 'build/app.js'), 'backend');
  await fs.writeFile(path.join(source, 'version.yaml'), 'version: 2.24.0\n');
  await fs.mkdir(path.join(staticRoot, 'build/bootstrap'));
  await fs.writeFile(
    path.join(staticRoot, 'build/bootstrap/upgradeProbe.js'),
    `
    const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    if(process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.QL_CLI_ROOT)throw new Error('Leaked host environment');
    const info=JSON.parse(fs.readFileSync(path.join(__dirname,'../../build-info.json')));
    process.send({type:'upgrade-probe',ok:true,build:{version:'2.24.0',sourceCommit:info.sourceCommit,
      backendSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../app.js'))).digest('hex')}});
    process.disconnect();
  `,
  );
  writeManifest(source, staticRoot);
  const target = await bundle.runtimeTarget();
  const manifest = {
    format: 2,
    sourceCommit,
    lockfileSha256: bundle.sha256(
      await fs.readFile(path.join(source, 'pnpm-lock.yaml')),
    ),
    target: { ...target, libcMinimum: target.libcVersion },
    nodeMinimum: '20.18.1',
    nodeApi: 6,
    files: await bundle.inventory({ source, static: staticRoot }),
  };
  const archive = path.join(directory, 'package.tar.gz');
  const pack = async () => {
    await fs.writeFile(
      path.join(payload, 'bundle.json'),
      JSON.stringify(manifest),
    );
    await tar.c(
      {
        file: archive,
        cwd: directory,
        gzip: true,
        portable: true,
        noMtime: true,
      },
      ['qinglong'],
    );
  };
  await pack();
  return {
    directory,
    root,
    tmp,
    source,
    staticRoot,
    target,
    manifest,
    archive,
    pack,
  };
}

test('online and offline stage the same complete payload, preserve pnpm links and never install dependencies', async (t) => {
  const f = await fixture(t),
    bytes = await fs.readFile(f.archive),
    progress = [];
  const entry = {
    size: bytes.length,
    sha256: bundle.sha256(bytes),
    url: 'https://example.invalid/immutable.tar.gz',
  };
  let calls = 0,
    probes = 0;
  const run = async (program, args) => {
    assert.equal(program, 'curl');
    calls++;
    const output = args[args.indexOf('--output') + 1];
    if (args.at(-1).endsWith('latest.json'))
      await fs.writeFile(
        output,
        JSON.stringify({
          format: 2,
          sourceCommit,
          packages: { [bundle.targetKey(f.target)]: entry },
        }),
      );
    else {
      await fs.writeFile(output, bytes);
      await fs.writeFile(
        args[args.indexOf('--dump-header') + 1],
        'HTTP/2 200 OK\r\n\r\n',
      );
    }
  };
  const options = {
    root: f.root,
    tmp: f.tmp,
    env: { QL_BRANCH: 'develop' },
    run,
    verifyStatic: artifacts.verifyUpgrade,
    download: artifacts.downloadWithProgress,
    probe: async () => {
      probes++;
    },
    onProgress: async (p) => progress.push(p),
  };
  const online = await bundle.stageBundle(options);
  const first = await bundle.inventory(online);
  assert.equal(calls, 2);
  assert.equal(probes, 1);
  assert.ok(progress.some((p) => p.percent === 100));
  assert.ok(progress.some((p) => p.percent === 0));
  const offline = await bundle.stageBundle({
    ...options,
    env: { QL_BRANCH: 'develop', QL_UPGRADE_FILE: f.archive },
    run: () => assert.fail('offline network access'),
  });
  assert.equal(probes, 2);
  assert.deepEqual(await bundle.inventory(offline), first);
  assert.equal(
    await fs.readlink(path.join(offline.source, 'node_modules/sqlite3')),
    '.pnpm/sqlite/node_modules/sqlite3',
  );
  await assert.rejects(fs.access(online.source));
});

test('native target compatibility distinguishes ARMv6/ARMv7 and libc and retains the existing Node requirement', async (t) => {
  const f = await fixture(t),
    target = {
      platform: 'linux',
      arch: 'armv6',
      libc: 'musl',
      libcVersion: '1.2.5',
    };
  const manifest = {
    ...f.manifest,
    target: { ...target, libcMinimum: '1.2.4' },
  };
  bundle.assertCompatible(manifest, target, '20.20.2');
  const glibcTarget = {
    ...target,
    libc: 'glibc',
    libcVersion: '2.31',
    endianness: 'LE',
    armFloatAbi: 'hard',
  };
  const glibcManifest = {
    ...manifest,
    target: { ...glibcTarget, libcMinimum: '2.31' },
  };
  bundle.assertCompatible(glibcManifest, glibcTarget, '20.18.1');
  assert.equal(bundle.targetKey(glibcTarget), 'linux-armv6-glibc');
  assert.throws(
    () =>
      bundle.assertCompatible(glibcManifest, {
        ...glibcTarget,
        libcVersion: '2.30',
      }),
    /requires glibc/,
  );
  assert.throws(
    () =>
      bundle.assertCompatible(glibcManifest, {
        ...glibcTarget,
        armFloatAbi: 'soft',
      }),
    /floating-point ABI mismatch/,
  );
  assert.throws(
    () => bundle.assertCompatible(manifest, { ...target, arch: 'armv7' }),
    /platform mismatch/,
  );
  assert.throws(
    () => bundle.assertCompatible(manifest, { ...target, libc: 'glibc' }),
    /platform mismatch/,
  );
  assert.throws(
    () => bundle.assertCompatible(manifest, target, '18.20.0'),
    /requires Node/,
  );
  assert.throws(
    () =>
      bundle.assertCompatible(manifest, { ...target, libcVersion: '1.1.24' }),
    /requires musl/,
  );
});

test('dependency tampering and payload link escapes are rejected', async (t) => {
  const f = await fixture(t),
    selected = { source: f.source, static: f.staticRoot };
  await bundle.verifyPayload(selected, f.manifest, f.target);
  await fs.writeFile(
    path.join(f.source, 'node_modules/sqlite3/package.json'),
    '{"tampered":true}',
  );
  await assert.rejects(
    bundle.verifyPayload(selected, f.manifest, f.target),
    /checksums/,
  );
  await fs.symlink('/etc/passwd', path.join(f.source, 'outside'));
  await assert.rejects(bundle.inventory(selected), /escapes/);
});

test('archive traversal, absolute links and writes through internal symlinks are rejected before extraction', async (t) => {
  const f = await fixture(t),
    dest = path.join(f.directory, 'extract');
  await fs.mkdir(dest);
  await fs.symlink('/etc', path.join(f.directory, 'qinglong/bad'));
  await tar.c({ cwd: f.directory, file: f.archive, gzip: true }, [
    'qinglong/bad',
  ]);
  await assert.rejects(bundle.extractArchive(f.archive, dest), /symlink/);
  await tar.c(
    { cwd: f.directory, file: f.archive, gzip: true, prefix: '../outside' },
    ['qinglong/source/package.json'],
  );
  await assert.rejects(bundle.extractArchive(f.archive, dest), /Unsafe/);
  await fs.mkdir(path.join(f.directory, 'qinglong/real'));
  await fs.writeFile(path.join(f.directory, 'qinglong/real/file'), 'value');
  await fs.symlink('real', path.join(f.directory, 'qinglong/link'));
  await tar.c({ cwd: f.directory, file: f.archive, gzip: true }, [
    'qinglong/link',
    'qinglong/link/file',
  ]);
  await assert.rejects(
    bundle.extractArchive(f.archive, dest),
    /through a symlink/,
  );
  assert.deepEqual(await fs.readdir(dest), []);
});

test('an incomplete or corrupt platform download cannot replace an existing ready pointer', async (t) => {
  const f = await fixture(t),
    pointer = path.join(f.tmp, 'upgrade-ready-develop.json');
  await fs.writeFile(pointer, 'previous-ready');
  await assert.rejects(
    bundle.stageBundle({
      root: f.root,
      tmp: f.tmp,
      env: { QL_BRANCH: 'develop', QL_UPGRADE_FILE: f.archive },
      verifyStatic: artifacts.verifyUpgrade,
      probe: async () => {
        throw new Error('native addon failed');
      },
    }),
    /native addon failed/,
  );
  assert.equal(await fs.readFile(pointer, 'utf8'), 'previous-ready');
  assert.equal(
    (await fs.readdir(f.tmp)).filter((n) => n.startsWith('upgrade-')).length,
    1,
  );
});

test('publishing requires every platform and validates all immutable archive hashes', async (t) => {
  const f = await fixture(t),
    repository = 'whyour/qinglong';
  assert.throws(() => releaseIndex(f.directory, sourceCommit, repository));
  for (const target of platforms) {
    const filename = `qinglong-${sourceCommit}-${target}.tar.gz`,
      bytes = Buffer.from(target);
    await fs.writeFile(path.join(f.directory, filename), bytes);
    await fs.writeFile(
      path.join(f.directory, filename + '.json'),
      JSON.stringify({
        format: 2,
        sourceCommit,
        target,
        filename,
        size: bytes.length,
        sha256: bundle.sha256(bytes),
      }),
    );
  }
  const index = releaseIndex(f.directory, sourceCommit, repository);
  assert.equal(Object.keys(index.packages).length, 13);
  const armv6 = path.join(
    f.directory,
    `qinglong-${sourceCommit}-linux-armv6-glibc.tar.gz`,
  );
  const armv6Bytes = await fs.readFile(armv6);
  await fs.rm(armv6);
  assert.throws(
    () => releaseIndex(f.directory, sourceCommit, repository),
    /ENOENT/,
  );
  await fs.writeFile(armv6, armv6Bytes);
  await fs.appendFile(
    path.join(f.directory, `qinglong-${sourceCommit}-${platforms[0]}.tar.gz`),
    'corrupt',
  );
  assert.throws(
    () => releaseIndex(f.directory, sourceCommit, repository),
    /Unverified/,
  );
});

test('fresh offline installation needs no package manager, keeps Node and publishes a complete directory', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, '.env.example'), 'QlPort=5700\n');
  await fs.writeFile(path.join(f.source, 'version.yaml'), 'version: 2.24.0\n');
  await fs.writeFile(
    path.join(f.source, 'node_modules/sqlite3/index.js'),
    `exports.Database=class {serialize(fn){fn()}run(){}get(sql,cb){cb(null,{value:42})}close(){}};`,
  );
  for (const name of ['sequelize', 'cron-parser', '@grpc/grpc-js', 'undici']) {
    const dir = path.join(f.source, 'node_modules', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.js'), 'module.exports={};');
  }
  f.manifest.files = await bundle.inventory({
    source: f.source,
    static: f.staticRoot,
  });
  await f.pack();
  const destination = path.join(f.directory, 'fresh'),
    node = process.execPath;
  await require('../../shell/install-bundle.cjs').installBundle(
    ['--root', destination, '--file', f.archive, '--install'],
    { ...process.env, PATH: '', QL_BRANCH: 'develop' },
  );
  assert.equal(process.execPath, node);
  assert.equal(
    await fs.readFile(path.join(destination, '.env'), 'utf8'),
    'QlPort=5700\n',
  );
  assert.equal(
    (await fs.stat(path.join(destination, '.env'))).mode & 0o777,
    0o600,
  );
  assert.equal(
    await fs.readFile(path.join(destination, 'static/build/app.js'), 'utf8'),
    'backend',
  );
  assert.ok(
    (
      await fs.stat(path.join(destination, 'node_modules/sqlite3/package.json'))
    ).isFile(),
  );
  assert.equal(
    (await fs.readdir(f.directory)).filter((n) =>
      n.startsWith('.qinglong-install-'),
    ).length,
    0,
  );
  await fs.writeFile(path.join(destination, 'keep-user-data'), 'keep');
  await assert.rejects(
    require('../../shell/install-bundle.cjs').installBundle([
      '--root',
      destination,
      '--file',
      f.archive,
      '--install',
    ]),
    /empty installation directory/,
  );
  assert.equal(
    await fs.readFile(path.join(destination, 'keep-user-data'), 'utf8'),
    'keep',
  );
});

test('offline staging replaces stale panel readiness and refuses an active online job', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'version.yaml'), 'version: 2.24.0\n');
  await fs.writeFile(
    path.join(f.source, 'node_modules/sqlite3/index.js'),
    'exports.Database=class {serialize(fn){fn()}run(){}get(sql,cb){cb(null,{value:42})}close(){}};',
  );
  for (const name of ['sequelize', 'cron-parser', '@grpc/grpc-js', 'undici']) {
    const dir = path.join(f.source, 'node_modules', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.js'), 'module.exports={};');
  }
  f.manifest.files = await bundle.inventory({
    source: f.source,
    static: f.staticRoot,
  });
  await f.pack();
  await fs.mkdir(path.join(f.root, 'shell'));
  await fs.writeFile(
    path.join(f.root, 'shell/share.sh'),
    'import_config() { :; }\n',
  );
  await fs.writeFile(
    path.join(f.root, 'shell/env.sh'),
    'export QL_BRANCH=develop\n',
  );
  const stateFile = path.join(f.tmp, 'panel-upgrade.json');
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      id: 'previous-online-job',
      status: 'ready',
      phase: 'ready',
    }),
  );
  const install = require('../../shell/install-bundle.cjs').installBundle;
  await install(['--root', f.root, '--file', f.archive, '--download-only']);
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(state.status, 'ready');
  assert.equal(state.sourceCommit, sourceCommit);
  assert.notEqual(state.id, 'previous-online-job');
  assert.equal(state.version, '2.24.0');
  const pointer = await fs.readFile(
    path.join(f.tmp, 'upgrade-ready-develop.json'),
    'utf8',
  );
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      id: 'live-online-job',
      status: 'running',
      pid: process.pid,
      startedAt: Date.now(),
    }),
  );
  await assert.rejects(
    install(['--root', f.root, '--file', f.archive, '--download-only']),
    /已有更新/,
  );
  assert.equal(
    JSON.parse(await fs.readFile(stateFile, 'utf8')).id,
    'live-online-job',
  );
  assert.equal(
    await fs.readFile(path.join(f.tmp, 'upgrade-ready-develop.json'), 'utf8'),
    pointer,
  );
});

test('interrupting offline staging records failure, preserves prior readiness and releases both locks', async (t) => {
  const f = await fixture(t);
  const { spawn } = require('node:child_process');
  await fs.writeFile(path.join(f.source, 'version.yaml'), 'version: 2.24.0\n');
  await fs.writeFile(
    path.join(f.source, 'node_modules/sqlite3/index.js'),
    'exports.Database=class {serialize(fn){fn()}run(){}get(sql,cb){setTimeout(()=>cb(null,{value:42}),10000)}close(){}};',
  );
  for (const name of ['sequelize', 'cron-parser', '@grpc/grpc-js', 'undici']) {
    const dir = path.join(f.source, 'node_modules', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.js'), 'module.exports={};');
  }
  f.manifest.files = await bundle.inventory({
    source: f.source,
    static: f.staticRoot,
  });
  await f.pack();
  await fs.mkdir(path.join(f.root, 'shell'));
  await fs.writeFile(
    path.join(f.root, 'shell/share.sh'),
    'import_config() { :; }\n',
  );
  await fs.writeFile(
    path.join(f.root, 'shell/env.sh'),
    'export QL_BRANCH=develop\n',
  );
  const pointer = path.join(f.tmp, 'upgrade-ready-develop.json');
  await fs.writeFile(pointer, 'previous-good-readiness');
  const child = spawn(
    process.execPath,
    [
      path.resolve(__dirname, '../../shell/install-bundle.cjs'),
      '--root',
      f.root,
      '--file',
      f.archive,
      '--download-only',
    ],
    { stdio: 'ignore' },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const exited = new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  let seen = false;
  for (let i = 0; i < 200; i++) {
    const state = await fs
      .readFile(path.join(f.tmp, 'panel-upgrade.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => ({}));
    if (state.phase === 'dependencies') {
      seen = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(seen);
  child.kill('SIGTERM');
  assert.equal(await exited, 1);
  assert.equal(await fs.readFile(pointer, 'utf8'), 'previous-good-readiness');
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(f.tmp, 'panel-upgrade.json'), 'utf8'),
    ).status,
    'failed',
  );
  await assert.rejects(fs.access(path.join(f.tmp, 'upgrade.lock')));
  await assert.rejects(
    fs.access(path.join(f.tmp, 'panel-job-launch/upgrade.lock')),
  );
});

test('portable release archives preserve the permission manifest after normalizing image scripts', async (t) => {
  const f = await fixture(t);
  const script = path.join(f.source, 'sample/config.sample.sh');
  await fs.chmod(script, 0o777);
  const { normalizeModes } = require('../../scripts/build-upgrade-bundle.cjs');
  await normalizeModes(f.source);
  await normalizeModes(f.staticRoot);
  assert.equal((await fs.stat(script)).mode & 0o777, 0o755);
  f.manifest.files = await bundle.inventory({
    source: f.source,
    static: f.staticRoot,
  });
  await f.pack();
  const extracted = path.join(f.directory, 'roundtrip');
  await fs.mkdir(extracted);
  await bundle.extractArchive(f.archive, extracted);
  const selected = {
    source: path.join(extracted, 'qinglong/source'),
    static: path.join(extracted, 'qinglong/static'),
  };
  await bundle.verifyPayload(selected, f.manifest, f.target);
  await fs.chmod(path.join(selected.source, 'sample/config.sample.sh'), 0o777);
  await assert.rejects(
    bundle.verifyPayload(selected, f.manifest, f.target),
    /checksums/,
  );
});

test('full dependency bundles get a bounded slow-link download budget instead of the old ten-minute limit', async (t) => {
  const f = await fixture(t);
  let observed;
  await assert.rejects(
    artifacts.downloadWithProgress(
      async (program, args) => {
        assert.equal(program, 'curl');
        observed = Number(args[args.indexOf('--max-time') + 1]);
        assert.ok(observed > 600 && observed <= 7200);
        assert.equal(args[args.indexOf('--speed-limit') + 1], '1024');
        throw new Error('stop before transfer');
      },
      path.join(f.directory, 'slow.tar.gz'),
      'https://example.invalid/package.tar.gz',
      'qinglong-bundle',
      async () => {},
      true,
      { size: 24 * 1024 * 1024, sha256: 'a'.repeat(64) },
    ),
    /stop before transfer/,
  );
  assert.ok(observed);
});
