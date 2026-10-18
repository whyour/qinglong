// One installed verifier handles release downloads and local offline archives.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const tar = require('tar');
const {
  prestartBackend,
  dependencyFailure,
  repairDependencies,
} = require('./upgradePrestart.cjs');
const execute = promisify(execFile);
// Heavy archive parsing can hit unsupported V8 JIT paths on ARM1176. Keep
// upgrade workers interpreted without changing the installed Node or server.
const nodeRuntimeArgs = (runtime = process) =>
  runtime.arch === 'arm' && Number(runtime.config.variables.arm_version) === 6
    ? ['--jitless']
    : [];
const sha256 = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, filename) => {
  const relative = path.relative(root, filename);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};
const versionParts = (v) => String(v).replace(/^v/, '').split('.').map(Number);
function atLeast(actual, minimum) {
  const a = versionParts(actual),
    b = versionParts(minimum);
  return (
    b.every((n) => Number.isFinite(n)) &&
    a.every((n) => Number.isFinite(n)) &&
    (a[0] > b[0] ||
      (a[0] === b[0] &&
        (a[1] > b[1] || (a[1] === b[1] && (a[2] || 0) >= (b[2] || 0)))))
  );
}

async function runtimeTarget() {
  let libc, libcVersion;
  if (process.platform === 'linux') {
    const header = process.report.getReport().header;
    if (header.glibcVersionRuntime) {
      libc = 'glibc';
      libcVersion = header.glibcVersionRuntime;
    } else {
      let text = '';
      try {
        text = (await execute('ldd', ['--version'])).stdout;
      } catch (error) {
        text = `${error.stdout || ''}\n${error.stderr || ''}`;
      }
      const match = text.match(/musl[\s\S]*?Version\s+(\d+\.\d+\.\d+)/i);
      if (!match)
        throw new Error(
          'Cannot identify Linux libc; refusing a native dependency bundle',
        );
      libc = 'musl';
      libcVersion = match[1];
    }
  }
  const armVersion =
    process.arch === 'arm'
      ? Number(process.config.variables.arm_version)
      : undefined;
  if (process.arch === 'arm' && ![6, 7, 8].includes(armVersion))
    throw new Error('Cannot identify ARM instruction set');
  const arch =
    process.arch === 'arm' ? `armv${armVersion >= 7 ? 7 : 6}` : process.arch;
  const armFloatAbi =
    process.arch === 'arm' ? process.config.variables.arm_float_abi : undefined;
  if (
    process.arch === 'arm' &&
    !['hard', 'soft', 'softfp'].includes(armFloatAbi)
  )
    throw new Error('Cannot identify ARM floating-point ABI');
  return {
    platform: process.platform,
    arch,
    libc,
    libcVersion,
    endianness: os.endianness(),
    armFloatAbi,
  };
}

function targetKey(target) {
  return [target.platform, target.arch, target.libc].filter(Boolean).join('-');
}

function assertCompatible(manifest, target, node = process.versions.node) {
  if (
    manifest.format !== 2 ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
    !/^[a-f0-9]{64}$/.test(manifest.lockfileSha256) ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files) ||
    !Number.isSafeInteger(manifest.nodeApi) ||
    manifest.nodeApi < 6
  )
    throw new Error('Invalid platform bundle manifest');
  if (targetKey(manifest.target || {}) !== targetKey(target))
    throw new Error(`Bundle platform mismatch: need ${targetKey(target)}`);
  if (
    !atLeast(node, manifest.nodeMinimum) ||
    Number(process.versions.napi) < manifest.nodeApi
  )
    throw new Error(
      `Bundle requires Node >= ${manifest.nodeMinimum} and Node-API ${manifest.nodeApi}; the existing Node is retained`,
    );
  if (
    manifest.target.endianness !== target.endianness ||
    manifest.target.armFloatAbi !== target.armFloatAbi
  )
    throw new Error(
      'Bundle native byte order or ARM floating-point ABI mismatch',
    );
  if (target.libc && !atLeast(target.libcVersion, manifest.target.libcMinimum))
    throw new Error(
      `Bundle requires ${target.libc} >= ${manifest.target.libcMinimum}`,
    );
}

async function inventory(roots) {
  const files = {};
  async function visit(directory, prefix) {
    for (const name of (await fs.readdir(directory)).sort()) {
      const filename = path.join(directory, name),
        relative = `${prefix}/${name}`;
      const stat = await fs.lstat(filename);
      if (stat.isDirectory()) await visit(filename, relative);
      else if (stat.isFile())
        files[relative] = {
          type: 'file',
          mode: stat.mode & 0o777,
          sha256: sha256(await fs.readFile(filename)),
        };
      else if (stat.isSymbolicLink()) {
        const link = await fs.readlink(filename);
        const boundary = roots[prefix.split('/')[0]];
        if (
          path.isAbsolute(link) ||
          !inside(boundary, path.resolve(path.dirname(filename), link)) ||
          !inside(await fs.realpath(boundary), await fs.realpath(filename))
        )
          throw new Error(`Bundle link escapes its payload: ${relative}`);
        files[relative] = { type: 'link', link };
      } else throw new Error(`Unsupported bundle entry: ${relative}`);
    }
  }
  for (const [name, root] of Object.entries(roots)) await visit(root, name);
  return files;
}

async function verifyPayload(selected, manifest, target) {
  assertCompatible(manifest, target);
  for (const name of ['data', '.tmp', '.git', '.env', 'static']) {
    if (
      await fs.lstat(path.join(selected.source, name)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      })
    )
      throw new Error(`Reserved installation path in bundle: ${name}`);
  }
  const actual = await inventory({
    source: selected.source,
    static: selected.static,
  });
  const names = Object.keys(actual).sort(),
    expected = Object.keys(manifest.files).sort();
  if (
    JSON.stringify(names) !== JSON.stringify(expected) ||
    names.some(
      (name) =>
        JSON.stringify(actual[name]) !== JSON.stringify(manifest.files[name]),
    )
  )
    throw new Error(
      'Platform bundle files or dependency checksums do not match',
    );
  if (
    sha256(await fs.readFile(path.join(selected.source, 'pnpm-lock.yaml'))) !==
    manifest.lockfileSha256
  )
    throw new Error('Platform bundle lockfile mismatch');
  await fs.access(
    path.join(selected.source, 'node_modules/sqlite3/package.json'),
  );
}

async function smokeDependencies(source, signal) {
  // This probe is installed verifier code, never a verifier supplied by an archive.
  const probe = `
    const path = require('node:path'),fs = require('node:fs');
    const root = fs.realpathSync(process.cwd());
    const r = require('node:module').createRequire(path.join(root,'package.json'));
    for (const name of ['sqlite3','sequelize','cron-parser','@grpc/grpc-js','undici']) {
      if (!fs.realpathSync(r.resolve(name)).startsWith(root + path.sep)) throw new Error('Dependency outside staged payload: '+name);
      r(name);
    }
    const sqlite=r('sqlite3'), db=new sqlite.Database(':memory:');
    db.serialize(()=>{db.run('CREATE TABLE verify_bundle(value INTEGER)');db.run('INSERT INTO verify_bundle VALUES(42)');
      db.get('SELECT value FROM verify_bundle',(err,row)=>{if(err||row.value!==42){console.error(err||'SQLite readback failed');process.exitCode=1;}db.close();});});
  `;
  // Match the server's normal runtime. Node 20.18's built-in HTTP parser needs
  // WebAssembly, which --jitless disables; only archive workers need that flag.
  await execute(process.execPath, ['-e', probe], {
    cwd: source,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
    timeout: 30000,
    signal,
  });
}

async function extractArchive(archive, destination) {
  const entries = new Map(),
    links = new Set();
  let unpacked = 0,
    invalid;
  await tar.t({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      try {
        const name = entry.path.replace(/\/$/, '');
        if (
          !name ||
          name.includes('\\') ||
          /[\x00-\x1f\x7f]/.test(name) ||
          name.split('/').some((p) => !p || p === '.' || p === '..') ||
          !(name === 'qinglong' || name.startsWith('qinglong/')) ||
          entries.has(name) ||
          !['File', 'OldFile', 'Directory', 'SymbolicLink'].includes(entry.type)
        )
          throw new Error(`Unsafe bundle archive entry: ${name}`);
        unpacked += entry.size;
        if (unpacked > 2 * 1024 ** 3 || entries.size > 200000)
          throw new Error('Bundle archive exceeds extraction limits');
        entries.set(name, entry.type);
        if (entry.type === 'SymbolicLink') {
          if (
            path.posix.isAbsolute(entry.linkpath) ||
            entry.linkpath.includes('\\') ||
            !inside(
              '/qinglong',
              path.posix.resolve('/', path.posix.dirname(name), entry.linkpath),
            )
          )
            throw new Error('Unsafe bundle symlink');
          links.add(name);
        }
      } catch (error) {
        invalid ||= error;
      }
    },
  });
  if (invalid) throw invalid;
  for (const name of entries.keys()) {
    let parent = path.posix.dirname(name);
    while (parent !== '.') {
      if (links.has(parent))
        throw new Error('Archive writes through a symlink');
      parent = path.posix.dirname(parent);
    }
  }
  await tar.x({
    file: archive,
    cwd: destination,
    strict: true,
    preservePaths: false,
    noChown: true,
    umask: 0,
  });
}

async function stageBundle({
  root,
  tmp,
  env,
  run,
  signal,
  onProgress,
  verifyStatic,
  download,
  probe = smokeDependencies,
  prestart = prestartBackend,
  repair = repairDependencies,
}) {
  let local = env.QL_UPGRADE_FILE;
  if (!local) {
    const current = JSON.parse(
      await fs
        .readFile(path.join(root, 'package.json'), 'utf8')
        .catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return '{}';
        }),
    );
    if (current.qinglongUpgradeFormat !== 2) return null; // One-time compatibility path for older releases.
  }
  const target = await runtimeTarget();
  const branch = ['develop', 'debian-dev'].includes(env.QL_BRANCH)
    ? 'develop'
    : 'master';
  const workspace = await fs.mkdtemp(path.join(tmp, 'upgrade-'));
  const report = onProgress || (async () => {});
  try {
    const archive = path.join(workspace, 'bundle.tar.gz');
    let expectedCommit;
    if (local) {
      if (!path.isAbsolute(local))
        throw new Error('Offline bundle path must be absolute');
      // Snapshot the local input so replacing it cannot race validation/extraction.
      await fs.copyFile(local, archive);
    } else {
      const indexUrl =
        env.QL_UPGRADE_INDEX_URL ||
        `https://github.com/whyour/qinglong/releases/download/upgrade-${branch}/latest.json`;
      const checkUrl = (url) => {
        const parsed = new URL(url);
        if (
          parsed.protocol !== 'https:' &&
          !(
            parsed.protocol === 'http:' &&
            ['127.0.0.1', '[::1]'].includes(parsed.hostname)
          )
        )
          throw new Error('Upgrade URLs require HTTPS');
      };
      checkUrl(indexUrl);
      const indexFile = path.join(workspace, 'index.json');
      await run('curl', [
        '--fail',
        '--silent',
        '--show-error',
        '--location',
        '--proto',
        new URL(indexUrl).protocol === 'http:' ? '=http,https' : '=https',
        '--proto-redir',
        '=https',
        '--header',
        'Cache-Control: no-cache',
        '--connect-timeout',
        '10',
        '--max-time',
        '30',
        '--max-filesize',
        '1048576',
        '--output',
        indexFile,
        indexUrl,
      ]);
      const index = JSON.parse(await fs.readFile(indexFile, 'utf8'));
      const entry = index.packages?.[targetKey(target)];
      if (
        index.format !== 2 ||
        !/^[a-f0-9]{40}$/.test(index.sourceCommit) ||
        !entry ||
        !Number.isSafeInteger(entry.size) ||
        entry.size <= 0 ||
        entry.size > 512 * 1024 ** 2 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
      )
        throw new Error(`No verified update bundle for ${targetKey(target)}`);
      checkUrl(entry.url);
      expectedCommit = index.sourceCommit;
      await report({
        phase: 'downloading',
        artifact: 'qinglong-bundle',
        downloadedBytes: 0,
        totalBytes: entry.size,
        percent: 0,
      });
      await download(
        run,
        archive,
        entry.url,
        'qinglong-bundle',
        report,
        true,
        entry,
      );
    }
    if ((await fs.stat(archive)).size > 512 * 1024 ** 2)
      throw new Error('Bundle is too large');
    await report({
      phase: 'extracting',
      artifact: 'qinglong-bundle',
      percent: null,
    });
    await extractArchive(archive, workspace);
    const incoming = path.join(workspace, 'qinglong');
    const manifest = JSON.parse(
      await fs.readFile(path.join(incoming, 'bundle.json'), 'utf8'),
    );
    if (expectedCommit && manifest.sourceCommit !== expectedCommit)
      throw new Error('Update index and bundle commit differ');
    const selected = {
      source: path.join(workspace, `qinglong-${branch}`),
      static: path.join(workspace, `qinglong-static-${branch}`),
    };
    await fs.rename(path.join(incoming, 'source'), selected.source);
    await fs.rename(path.join(incoming, 'static'), selected.static);
    await report({ phase: 'verifying', percent: null });
    await verifyPayload(selected, manifest, target);
    const build = await verifyStatic(selected.source, selected.static, env);
    if (build.sourceCommit !== manifest.sourceCommit)
      throw new Error('Bundle and build commit differ');
    await report({ phase: 'dependencies', percent: null });
    let dependencyFiles;
    const testCandidate = async () => {
      await probe(selected.source, signal);
      await report({ phase: 'prestarting', percent: null });
      return prestart(selected, { target, signal });
    };
    try {
      await testCandidate();
    } catch (error) {
      signal?.throwIfAborted();
      if (!dependencyFailure(error)) throw error;
      if (local && env.QL_UPGRADE_REPAIR_DEPS !== '1')
        throw new Error(
          `Offline dependency check failed; no network access attempted. Use --repair-deps to allow one repair. ${error.message}`,
        );
      await report({ phase: 'repairing', percent: null });
      await repair(selected.source, { target, signal, env });
      const repaired = await inventory({
        source: selected.source,
        static: selected.static,
      });
      dependencyFiles = Object.fromEntries(
        Object.entries(repaired).filter(([name]) =>
          name.startsWith('source/node_modules/'),
        ),
      );
      // A repair may change only dependencies, never bless changed application code.
      await verifyPayload(
        selected,
        manifestWithDependencies(manifest, dependencyFiles),
        target,
      );
      await verifyStatic(selected.source, selected.static, env);
      await testCandidate(); // Exactly one repair; this failure propagates.
    }
    await fs.writeFile(
      path.join(workspace, 'prestart.json'),
      JSON.stringify({
        format: 1,
        sourceCommit: manifest.sourceCommit,
        manifestSha256: sha256(Buffer.from(JSON.stringify(manifest))),
        node: process.version,
        execPath: process.execPath,
        completedAt: Date.now(),
        ...(dependencyFiles ? { dependencyFiles } : {}),
      }),
      { flag: 'wx', mode: 0o600 },
    );
    await fs.writeFile(
      path.join(workspace, 'bundle.json'),
      JSON.stringify(manifest),
      { flag: 'wx', mode: 0o600 },
    );
    await fs.writeFile(
      path.join(workspace, 'ready.json'),
      JSON.stringify({
        ...selected,
        root: path.resolve(root),
        sourceCommit: manifest.sourceCommit,
        dependenciesChanged: true,
        bundle: true,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    const pointer = path.join(workspace, 'pointer.json');
    await fs.writeFile(
      pointer,
      JSON.stringify({ directory: path.basename(workspace) }),
      { flag: 'wx', mode: 0o600 },
    );
    signal?.throwIfAborted();
    const readyPointer = path.join(tmp, `upgrade-ready-${branch}.json`);
    const previous = await fs
      .readFile(readyPointer, 'utf8')
      .catch(() => 'null');
    await fs.rename(pointer, readyPointer);
    try {
      const old = JSON.parse(previous)?.directory;
      if (
        /^upgrade-[A-Za-z0-9_-]+$/.test(old) &&
        old !== path.basename(workspace)
      )
        await fs.rm(path.join(tmp, old), { recursive: true, force: true });
    } catch {
      /* Committed readiness must survive cleanup failure. */
    }
    return selected;
  } catch (error) {
    await fs.rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

function manifestWithDependencies(manifest, dependencyFiles) {
  if (!dependencyFiles) return manifest;
  if (
    typeof dependencyFiles !== 'object' ||
    Array.isArray(dependencyFiles) ||
    !Object.keys(dependencyFiles).length ||
    Object.keys(dependencyFiles).some(
      (name) => !name.startsWith('source/node_modules/'),
    )
  )
    throw new Error('Invalid repaired dependency inventory');
  return {
    ...manifest,
    files: {
      ...Object.fromEntries(
        Object.entries(manifest.files).filter(
          ([name]) => !name.startsWith('source/node_modules/'),
        ),
      ),
      ...dependencyFiles,
    },
  };
}

async function verifyStagedBundle(selected) {
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(path.dirname(selected.source), 'bundle.json'),
      'utf8',
    ),
  );
  const prestart = JSON.parse(
    await fs.readFile(
      path.join(path.dirname(selected.source), 'prestart.json'),
      'utf8',
    ),
  );
  if (
    prestart.format !== 1 ||
    prestart.sourceCommit !== manifest.sourceCommit ||
    prestart.manifestSha256 !== sha256(Buffer.from(JSON.stringify(manifest))) ||
    prestart.node !== process.version ||
    prestart.execPath !== process.execPath ||
    !Number.isSafeInteger(prestart.completedAt)
  )
    throw new Error(
      'Upgrade prestart receipt is missing or stale; prepare the update again',
    );
  await verifyPayload(
    selected,
    manifestWithDependencies(manifest, prestart.dependencyFiles),
    await runtimeTarget(),
  );
  await smokeDependencies(selected.source);
}

module.exports = {
  nodeRuntimeArgs,
  atLeast,
  runtimeTarget,
  targetKey,
  assertCompatible,
  inventory,
  verifyPayload,
  smokeDependencies,
  extractArchive,
  stageBundle,
  verifyStagedBundle,
  sha256,
};
