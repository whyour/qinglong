const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const { serverRuntimeArgs } = require('./nodeRuntime.cjs');

function probeLimits(target) {
  const small = target.arch === 'armv6';
  return { heapMb: small ? 128 : 192, timeoutMs: small ? 300000 : 60000 };
}

function dependencyFailure(error) {
  const text = `${error.message || ''}\n${error.stack || ''}\n${
    error.stderr || ''
  }`;
  if (error.signal || /timed out|heap out of memory|ENOMEM/i.test(text))
    return false;
  if (
    /ERR_DLOPEN_FAILED/.test(`${error.code} ${text}`) &&
    /node_modules[/\\]/.test(text)
  )
    return true;
  const missing = /Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(
    text,
  )?.[1];
  const importer = /Require stack:\r?\n-\s+([^\r\n]+)/.exec(text)?.[1];
  const inDependencies = (filename) =>
    /(?:^|[/\\])node_modules[/\\]/.test(filename || '');
  // Node reports a missing package entry as an absolute path and missing
  // package-internal imports as relative paths. Neither is an app source error.
  const dependencyMissing =
    missing &&
    ((!missing.startsWith('.') &&
      !path.isAbsolute(missing) &&
      !missing.startsWith('node:')) ||
      inDependencies(missing) ||
      inDependencies(importer));
  // Missing backend files, bad config and database errors must never trigger npm.
  return (
    (/MODULE_NOT_FOUND/.test(`${error.code} ${text}`) &&
      Boolean(dependencyMissing)) ||
    (/Could not locate the bindings file/.test(text) &&
      /node_modules[/\\]/.test(text))
  );
}

async function prestartBackend(
  selected,
  { target, signal, limits = probeLimits(target) },
) {
  signal?.throwIfAborted();
  const workspace = await fs.mkdtemp(
    path.join(path.dirname(selected.source), 'prestart-'),
  );
  try {
    const data = path.join(workspace, 'data');
    for (const name of ['db', 'config', 'syslog', 'log', 'scripts', 'upload'])
      await fs.mkdir(path.join(data, name), { recursive: true });
    // Copy only backend code/metadata, never all frontend assets or node_modules.
    await fs.mkdir(path.join(workspace, 'static'));
    await fs.cp(
      path.join(selected.static, 'build'),
      path.join(workspace, 'static/build'),
      { recursive: true },
    );
    await fs.copyFile(
      path.join(selected.static, 'build-info.json'),
      path.join(workspace, 'static/build-info.json'),
    );
    await fs.copyFile(
      path.join(selected.source, 'version.yaml'),
      path.join(workspace, 'version.yaml'),
    );
    await fs.symlink(
      path.join(selected.source, 'node_modules'),
      path.join(workspace, 'node_modules'),
      'dir',
    );
    await fs.writeFile(path.join(workspace, '.env'), '', { mode: 0o600 });
    const entry = path.join(
      workspace,
      'static/build/bootstrap/upgradeProbe.js',
    );
    await fs.access(entry);
    const expected = JSON.parse(
      await fs.readFile(path.join(selected.static, 'build-info.json')),
    );
    const backendSha256 = crypto
      .createHash('sha256')
      .update(await fs.readFile(path.join(selected.static, 'build/app.js')))
      .digest('hex');
    const version = (
      await fs.readFile(path.join(selected.source, 'version.yaml'), 'utf8')
    ).match(/^\uFEFF?version:\s*["']?(\d+\.\d+\.\d+)/m)?.[1];
    // An allowlist prevents NODE_OPTIONS, startup hooks, real data paths and
    // package-manager settings from escaping into the disposable backend.
    const env = {
      PATH: process.env.PATH,
      LANG: process.env.LANG || 'C.UTF-8',
      HOME: workspace,
      TMPDIR: workspace,
      NODE_ENV: 'production',
      QL_DIR: workspace,
      QL_DATA_DIR: data,
      QL_UPGRADE_PROBE: '1',
      BACK_PORT: '0',
      GRPC_PORT: '0',
      BIND_HOST: '127.0.0.1',
      BIND_HOST_GRPC: '127.0.0.1',
      QlBaseUrl: '/',
      NODE_PATH: '',
      NODE_OPTIONS: '',
      UV_THREADPOOL_SIZE: '1',
    };
    return await new Promise((resolve, reject) => {
      let report,
        failure,
        output = '',
        finished = false,
        killTimer;
      // No PM2/cluster workers. OpenSSL key generation is sequential in this
      // one backend process. Keep normal V8 mode for Node 20's HTTP/WASM support.
      const child = spawn(
        process.execPath,
        [...serverRuntimeArgs(), `--max-old-space-size=${limits.heapMb}`, entry],
        {
          cwd: workspace,
          env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      try {
        if (child.pid) os.setPriority(child.pid, 10);
      } catch {}
      const kill = (signalName) => {
        try {
          if (process.platform !== 'win32' && child.pid)
            process.kill(-child.pid, signalName);
          else child.kill(signalName);
        } catch (error) {
          if (error.code !== 'ESRCH') failure ||= error;
        }
      };
      const stop = (error) => {
        failure ||= error;
        kill('SIGTERM');
        killTimer ||= setTimeout(() => kill('SIGKILL'), 1500);
      };
      const abort = () =>
        stop(signal.reason || new Error('Upgrade prestart aborted'));
      const timer = setTimeout(
        () => stop(new Error('Upgrade prestart timed out')),
        limits.timeoutMs,
      );
      child.stdout.on('data', (chunk) => {
        output = (output + chunk).slice(-32768);
      });
      child.stderr.on('data', (chunk) => {
        output = (output + chunk).slice(-32768);
      });
      child.on('message', (message) => {
        if (message?.type === 'upgrade-probe') report = message;
      });
      const finish = (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(report);
      };
      child.on('error', (error) => finish(error));
      // Descendants can retain our output pipes after their parent exits.
      // Reap the group on exit rather than waiting for those pipes to close.
      child.once('exit', () => kill('SIGKILL'));
      child.on('close', (code, exitSignal) => {
        // Reap descendants even when the backend exits unexpectedly.
        kill('SIGKILL');
        if (failure) return finish(failure);
        if (code !== 0 || !report?.ok)
          return finish(
            Object.assign(
              new Error(
                report?.message ||
                  `Upgrade prestart exited: ${exitSignal || code}\n${output}`,
              ),
              {
                code: report?.code,
                stack: report?.stack || output,
                signal: exitSignal,
              },
            ),
          );
        if (
          report.build?.sourceCommit !== expected.sourceCommit ||
          report.build?.backendSha256 !== backendSha256 ||
          report.build?.version !== version
        )
          return finish(new Error('Upgrade prestart build identity mismatch'));
        finish();
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

async function cleanSqliteBuildArtifacts(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  if (!entries.length) return;
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const runtimePath = path.posix.normalize(pkg.binary?.module_path || '.');
  const copiedRuntime = runtimePath.startsWith('lib/binding/');
  // Our legacy fork copies its runtime to lib/binding. Other sqlite3 versions
  // load build/Release directly: retain that addon and remove only the compiler
  // helper directory. Never traverse a build-directory symlink while cleaning.
  for (const entry of entries) {
    if (entry.name !== 'build' && !/^build-tmp-napi-v\d+$/.test(entry.name)) continue;
    const build = path.join(directory, entry.name);
    await fs.rm(
      copiedRuntime || entry.isSymbolicLink() ? build : path.join(build, 'node_gyp_bins'),
      { recursive: true, force: true },
    );
  }
}

async function repairDependencies(source, { target, signal, env }) {
  const workspace = await fs.mkdtemp(
    path.join(path.dirname(source), 'repair-'),
  );
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(source, 'package.json')),
    );
    if (pkg.packageManager !== 'pnpm@8.3.1')
      throw new Error('Unsupported frozen-lockfile package manager');
    // Install apart from the verified application: lifecycle scripts cannot
    // rewrite source/static files or use the old installation's node_modules.
    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({ ...pkg, scripts: {} }),
    );
    await fs.copyFile(
      path.join(source, 'pnpm-lock.yaml'),
      path.join(workspace, 'pnpm-lock.yaml'),
    );
    const small = target.arch === 'armv6';
    const childEnv = {
      PATH: env.PATH || process.env.PATH,
      HOME: workspace,
      TMPDIR: workspace,
      NODE_OPTIONS: `${small ? '--jitless ' : ''}--max-old-space-size=${
        small ? 256 : 384
      }`,
      NODE_PATH: '',
      CI: 'true',
      npm_config_jobs: '1',
      MAKEFLAGS: '-j1',
      ...(small
        ? {
            npm_config_build_from_source: 'true',
            npm_config_force_process_config: 'true',
            CFLAGS: '-march=armv6 -mfpu=vfp -mfloat-abi=hard',
            CXXFLAGS: '-march=armv6 -mfpu=vfp -mfloat-abi=hard',
          }
        : {}),
    };
    // Preserve network routing without inheriting Node/preload/compiler settings.
    for (const name of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'no_proxy',
    ])
      if (typeof env[name] === 'string') childEnv[name] = env[name];
    // Reuse matching installed headers on small devices; never inherit a
    // caller's nodedir or accidentally compile against a different Node ABI.
    const prefix = path.resolve(path.dirname(process.execPath), '..');
    const header = await fs
      .readFile(path.join(prefix, 'include/node/node_version.h'), 'utf8')
      .catch(() => '');
    const headerVersion = ['MAJOR', 'MINOR', 'PATCH']
      .map(
        (part) =>
          header.match(
            new RegExp(`#define\\s+NODE_${part}_VERSION\\s+(\\d+)`),
          )?.[1],
      )
      .join('.');
    if (headerVersion === process.versions.node) {
      childEnv.npm_config_nodedir = prefix;
      childEnv.npm_config_force_process_config = 'true';
    }
    const run = (args) =>
      runRepair('pnpm', args, {
        cwd: workspace,
        env: childEnv,
        signal,
        timeoutMs: small ? 1800000 : 600000,
      });
    const version = await run(['--version']);
    if (version.trim() !== '8.3.1')
      throw new Error('Dependency repair requires existing pnpm 8.3.1');
    await run([
      'install',
      '--prod',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--child-concurrency=1',
      '--network-concurrency=2',
    ]);
    if (pkg.dependencies?.sqlite3) {
      await run(['rebuild', 'sqlite3', '@whyour/sqlite3']);
      await cleanSqliteBuildArtifacts(
        path.join(workspace, 'node_modules/sqlite3'),
      );
    }
    if (
      !(await fs.readFile(path.join(source, 'pnpm-lock.yaml'))).equals(
        await fs.readFile(path.join(workspace, 'pnpm-lock.yaml')),
      )
    )
      throw new Error('Dependency repair changed the frozen lockfile');
    await fs.rm(path.join(source, 'node_modules'), {
      recursive: true,
      force: true,
    });
    await fs.rename(
      path.join(workspace, 'node_modules'),
      path.join(source, 'node_modules'),
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}

// Bound output, wall time and the entire npm/node-gyp process group.
async function runRepair(program, args, options) {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    let output = '',
      stdout = '',
      failure,
      killTimer;
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const kill = (sig) => {
      try {
        if (child.pid && process.platform !== 'win32')
          process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {}
    };
    const stop = (error) => {
      failure ||= error;
      kill('SIGTERM');
      killTimer ||= setTimeout(() => kill('SIGKILL'), 1500);
    };
    const abort = () =>
      stop(options.signal.reason || new Error('Dependency repair aborted'));
    const timer = setTimeout(
      () => stop(new Error('Dependency repair timed out')),
      options.timeoutMs,
    );
    const capture = (chunk) => {
      output = (output + chunk).slice(-32768);
    };
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-32768);
      capture(chunk);
    });
    child.stderr.on('data', capture);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      kill('SIGKILL');
    };
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', () => kill('SIGKILL'));
    child.on('close', (code, signal) => {
      cleanup();
      if (failure || code !== 0)
        reject(
          failure ||
            new Error(
              `Dependency repair failed (${signal || code}): ${output}`,
            ),
        );
      else resolve(stdout);
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

module.exports = {
  prestartBackend,
  dependencyFailure,
  repairDependencies,
  cleanSqliteBuildArtifacts,
  probeLimits,
};
