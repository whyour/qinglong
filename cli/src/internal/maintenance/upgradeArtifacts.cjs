// Shared by the image's Bash updater and the optional local CLI. Use only
// installed code to validate downloads; never execute a downloaded verifier.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const releaseBranch = (env) =>
  ['develop', 'debian-dev'].includes(env.QL_BRANCH) ? 'develop' : 'master';

async function manifestAt(staticRoot) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(staticRoot, 'build-info.json'), 'utf8'),
  );
  if (
    manifest.version !== 1 ||
    manifest.dirty !== false ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
    !/^[a-f0-9]{64}$/.test(manifest.lockfileSha256) ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files)
  )
    throw new Error('Invalid or dirty build manifest / 构建清单无效。');
  for (const required of ['build/app.js', 'dist/index.html'])
    if (!Object.hasOwn(manifest.files, required))
      throw new Error(`Missing build output / 缺少构建产物: ${required}`);
  return manifest;
}

async function verifyUpgrade(source, staticRoot) {
  const manifest = await manifestAt(staticRoot);
  if (
    hash(await fs.readFile(path.join(source, 'pnpm-lock.yaml'))) !==
    manifest.lockfileSha256
  )
    throw new Error(
      'Source and build lockfiles differ / 源码与构建依赖不一致。',
    );
  await fs.access(path.join(source, 'package.json'));
  await fs.access(path.join(source, 'sample/config.sample.sh'));
  const files = {};
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (name === 'build-info.json') continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename, `${name}/`);
      else if (entry.isFile()) files[name] = hash(await fs.readFile(filename));
      else
        throw new Error(`Unsupported build entry / 构建包含非法文件: ${name}`);
    }
  }
  await visit(staticRoot);
  const actual = Object.keys(files).sort(),
    expected = Object.keys(manifest.files).sort();
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    actual.some((name) => files[name] !== manifest.files[name])
  )
    throw new Error(
      'Build checksum mismatch / 构建文件缺失、损坏或混入旧文件。',
    );
  return manifest;
}

async function withUpgradeLock(tmp, operation) {
  await fs.mkdir(tmp, { recursive: true });
  const lock = path.join(tmp, 'upgrade.lock');
  const token = randomUUID();
  const owner = `owner-${process.pid}-${token}`;
  const candidate = path.join(tmp, `upgrade-lock-${token}`);
  let acquired = false;
  await fs.mkdir(candidate, { mode: 0o700 });
  try {
    // Publish a nonempty directory atomically: a live lock can never be
    // replaced, and a crash before publication cannot leave an ownerless lock.
    await fs.writeFile(path.join(candidate, owner), '', {
      flag: 'wx',
      mode: 0o600,
    });
    for (;;) {
      try {
        await fs.rename(candidate, lock);
        acquired = true;
        break;
      } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
      let entries;
      try {
        entries = await fs.readdir(lock);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!entries.length) continue;
      const heldOwner = entries[0];
      const match = /^owner-([1-9]\d*)-[a-f0-9-]{36}$/.exec(heldOwner);
      let pid = match ? Number(match[1]) : 0;
      if (entries.length === 1 && heldOwner === 'pid') {
        try {
          pid = Number(await fs.readFile(path.join(lock, heldOwner), 'utf8'));
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
      }
      let stale = false;
      if (
        entries.length === 1 &&
        Number.isSafeInteger(pid) &&
        pid > 0 &&
        pid <= 0x7fffffff
      ) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') stale = true;
        }
      }
      if (!stale)
        throw new Error(
          'Another upgrade is running / 已有更新或重载正在执行。',
        );
      // Removing the observed unique marker is a compare-and-delete. A
      // contender cannot unlink the marker belonging to a replacement lock.
      // Legacy pid files are supported; new owners never reuse that filename.
      try {
        await fs.unlink(path.join(lock, heldOwner));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return await operation();
  } finally {
    if (acquired) {
      await fs.unlink(path.join(lock, owner)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await fs.rmdir(lock).catch((error) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code))
          throw error;
      });
    }
    await fs.rm(candidate, { recursive: true, force: true });
  }
}

async function stageUpgrade({ root, tmp, env, mirror, run, install, signal }) {
  const workspace = await fs.mkdtemp(path.join(tmp, 'upgrade-'));
  const branch = releaseBranch(env);
  try {
    async function extract(repository, ref) {
      const archive = path.join(workspace, `${repository}.zip`);
      const url =
        mirror === 'github'
          ? `https://github.com/whyour/${repository}/archive/${ref}.zip`
          : `https://gitee.com/whyour/${repository}/repository/archive/${ref}.zip`;
      await run('curl', [
        '--fail',
        '--location',
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--connect-timeout',
        '30',
        '--max-time',
        '600',
        '--output',
        archive,
        url,
      ]);
      const listing = await run('unzip', ['-Z1', archive], true);
      const expected = `${repository}-${ref}`;
      const names = listing.stdout.split('\n').filter(Boolean);
      if (
        !names.length ||
        names.some(
          (name) =>
            name.includes('\\') ||
            name.includes('\r') ||
            name.startsWith('/') ||
            name.split('/').includes('..') ||
            name.split('/')[0] !== expected,
        )
      )
        throw new Error('Invalid archive paths / 升级归档路径无效。');
      const modes = await run('unzip', ['-Z', '-l', archive], true);
      if (modes.stdout.split('\n').some((line) => /^l[rwx-]{9}\s/.test(line)))
        throw new Error('Archive contains symlinks / 升级归档包含符号链接。');
      await run('unzip', ['-oq', archive, '-d', workspace]);
      return path.join(workspace, expected);
    }
    // Static branches are mutable snapshots. Their manifest pins the exact
    // source revision, avoiding a race between two independent branch reads.
    const staticRoot = await extract('qinglong-static', branch);
    const manifest = await manifestAt(staticRoot);
    const downloadedSource = await extract('qinglong', manifest.sourceCommit);
    const source = path.join(workspace, `qinglong-${branch}`);
    await fs.rename(downloadedSource, source);
    await verifyUpgrade(source, staticRoot);
    let dependenciesChanged = false;
    for (const name of ['package.json', 'pnpm-lock.yaml']) {
      const current = await fs
        .readFile(path.join(root, name))
        .catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return Buffer.alloc(0);
        });
      if (!(await fs.readFile(path.join(source, name))).equals(current))
        dependenciesChanged = true;
    }
    if (
      !(await fs.stat(path.join(root, 'node_modules')).catch(() => undefined))
    )
      dependenciesChanged = true;
    if (dependenciesChanged) {
      await install(source, staticRoot, manifest.sourceCommit);
      await fs.access(path.join(source, 'node_modules'));
      await verifyUpgrade(source, staticRoot);
    }
    signal?.throwIfAborted();
    const selected = { source, static: staticRoot };
    await fs.writeFile(
      path.join(workspace, 'ready.json'),
      JSON.stringify({
        ...selected,
        sourceCommit: manifest.sourceCommit,
        dependenciesChanged,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    const pointer = path.join(workspace, 'pointer.json');
    await fs.writeFile(
      pointer,
      JSON.stringify({ directory: path.basename(workspace) }),
      { flag: 'wx', mode: 0o600 },
    );
    const readyPointer = path.join(tmp, `upgrade-ready-${branch}.json`);
    const previous = await fs
      .readFile(readyPointer, 'utf8')
      .catch(() => undefined);
    signal?.throwIfAborted();
    await fs.rename(pointer, readyPointer);
    // Retire only our previous successful stage, after publishing its replacement.
    try {
      const directory = previous && JSON.parse(previous).directory;
      if (
        typeof directory === 'string' &&
        /^upgrade-[A-Za-z0-9_-]+$/.test(directory) &&
        directory !== path.basename(workspace)
      )
        await fs.rm(path.join(tmp, directory), {
          recursive: true,
          force: true,
        });
    } catch {
      /* Cleanup cannot invalidate the newly published stage. */
    }
    return selected;
  } catch (error) {
    await fs.rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

async function selectedUpgrade(tmp, branch) {
  const pointer = JSON.parse(
    await fs.readFile(path.join(tmp, `upgrade-ready-${branch}.json`), 'utf8'),
  );
  if (
    typeof pointer.directory !== 'string' ||
    !/^upgrade-[A-Za-z0-9_-]+$/.test(pointer.directory)
  )
    throw new Error('Invalid staged upgrade pointer / 暂存升级指针无效。');
  const workspace = path.join(tmp, pointer.directory);
  const selected = {
    source: path.join(workspace, `qinglong-${branch}`),
    static: path.join(workspace, `qinglong-static-${branch}`),
  };
  for (const directory of [workspace, selected.source, selected.static]) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Invalid staging directory / 暂存目录无效。');
  }
  const ready = JSON.parse(
    await fs.readFile(path.join(workspace, 'ready.json'), 'utf8'),
  );
  if (ready.source !== selected.source || ready.static !== selected.static)
    throw new Error('Invalid upgrade readiness / 暂存升级就绪记录不匹配。');
  const manifest = await verifyUpgrade(selected.source, selected.static);
  if (ready.sourceCommit !== manifest.sourceCommit)
    throw new Error('Invalid upgrade readiness / 暂存升级就绪记录不匹配。');
  if (ready.dependenciesChanged)
    await fs.access(path.join(selected.source, 'node_modules'));
  return selected;
}

async function replaceAndReload(replacements, lifecycle) {
  const changed = [];
  let attemptedStart = false;
  lifecycle.signal?.throwIfAborted();
  try {
    await lifecycle.stop();
    for (const { source, target } of replacements) {
      lifecycle.signal?.throwIfAborted();
      await fs.mkdir(path.dirname(target), { recursive: true });
      const backup = `${target}.ql-backup-${randomUUID()}`;
      const existed = !!(await fs.lstat(target).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      }));
      if (existed) {
        try {
          await fs.rename(target, backup);
        } catch (error) {
          if (error.code !== 'EXDEV') throw error;
          try {
            await fs.cp(target, backup, {
              recursive: true,
              verbatimSymlinks: true,
            });
          } catch (copyError) {
            await fs.rm(backup, { recursive: true, force: true });
            throw copyError;
          }
          changed.push({ target, backup, existed });
          await fs.rm(target, { recursive: true });
        }
      }
      if (changed.at(-1)?.target !== target)
        changed.push({ target, backup, existed });
      await fs.cp(source, target, {
        recursive: true,
        verbatimSymlinks: true,
        force: false,
        errorOnExist: true,
      });
    }
    lifecycle.signal?.throwIfAborted();
    attemptedStart = true;
    await lifecycle.start();
    lifecycle.signal?.throwIfAborted();
  } catch (error) {
    // Do not modify files under a still-running failed startup. Keep backups
    // for recovery if stopping the new process itself fails.
    if (attemptedStart) await lifecycle.stop();
    for (const item of changed.reverse()) {
      await fs.rm(item.target, { recursive: true, force: true });
      if (item.existed) {
        try {
          await fs.rename(item.backup, item.target);
        } catch (restoreError) {
          if (restoreError.code !== 'EXDEV') throw restoreError;
          await fs.cp(item.backup, item.target, {
            recursive: true,
            verbatimSymlinks: true,
          });
          await fs.rm(item.backup, { recursive: true });
        }
      }
    }
    await lifecycle.start(true);
    throw error;
  }
  for (const item of changed)
    if (item.existed)
      await fs
        .rm(item.backup, { recursive: true, force: true })
        .catch(() =>
          console.error(`Retained backup / 保留备份: ${item.backup}`),
        );
}

async function reloadSystem({
  root,
  data,
  tmp,
  staticRoot,
  config,
  env,
  lifecycle,
}) {
  const selected = await selectedUpgrade(tmp, releaseBranch(env));
  const reserved = new Set(['data', '.tmp', 'static', '.git', '.env']);
  const relative = path.relative(root, data);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    reserved.add(relative.split(path.sep)[0]);
  const replacements = (await fs.readdir(selected.source))
    .filter((name) => !reserved.has(name))
    .map((name) => ({
      source: path.join(selected.source, name),
      target: path.join(root, name),
    }));
  replacements.push(
    { source: selected.static, target: staticRoot },
    {
      source: path.join(selected.source, 'sample/config.sample.sh'),
      target: path.join(config, 'config.sample.sh'),
    },
  );
  await replaceAndReload(replacements, lifecycle);
  // Cleanup after a committed installation must not report a failed update.
  await fs
    .rm(path.join(tmp, `upgrade-ready-${releaseBranch(env)}.json`), {
      force: true,
    })
    .catch(() => {});
  await fs
    .rm(path.dirname(selected.source), { recursive: true, force: true })
    .catch(() => {});
}

async function waitForHealth(env, timeout = 60000, signal) {
  const port = Number(env.QlPort || 5700);
  let base = env.QlBaseUrl || '';
  if (base && !base.startsWith('/')) base = `/${base}`;
  if (base.endsWith('/')) base = base.slice(0, -1);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const healthy = await new Promise((resolve) => {
      let timer;
      const finish = (healthy) => {
        clearTimeout(timer);
        resolve(healthy);
      };
      const req = http.get(
        { hostname: '127.0.0.1', port, path: `${base}/api/health`, signal },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
            if (body.length > 65536) req.destroy();
          });
          res.on('end', () => {
            try {
              const result = JSON.parse(body);
              finish(
                res.statusCode === 200 &&
                  result.code === 200 &&
                  result.data?.status === 'ok',
              );
            } catch {
              finish(false);
            }
          });
          res.on('error', () => finish(false));
        },
      );
      // Socket inactivity timeouts do not bound a response that keeps streaming.
      timer = setTimeout(
        () => req.destroy(new Error('Health probe timed out')),
        Math.min(1000, Math.max(1, deadline - Date.now())),
      );
      req.on('error', () => finish(false));
    });
    signal?.throwIfAborted();
    if (healthy) return;
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      try {
        await delay(Math.min(500, remaining), undefined, { signal });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    }
  }
  throw new Error('Backend failed health check / 后端启动检查失败。');
}

function runProcess(env, program, args, capture = false, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      env,
      detached: process.platform !== 'win32',
      // Pipes keep close pending until children have released their output.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let aborted = false;
    let failure;
    let escalation;
    const kill = (name) => {
      if (!child.pid) return;
      try {
        process.kill(
          process.platform === 'win32' ? child.pid : -child.pid,
          name,
        );
      } catch (error) {
        if (error.code === 'EPERM') {
          child.kill(name);
          return;
        }
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const abort = () => {
      if (aborted) return;
      aborted = true;
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 1000);
      escalation.unref();
    };
    child.stdout.on('data', (chunk) => {
      if (capture) stdout += chunk;
      else process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', (error) => {
      failure = error;
    });
    child.once('exit', () => {
      // The shell can exit before a descendant that ignores SIGTERM.
      if (aborted) kill('SIGKILL');
    });
    child.once('close', (code) => {
      if (aborted) kill('SIGKILL');
      clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      if (aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code === 0) resolve({ stdout });
      else reject(new Error(`${program} failed (exit ${code})`));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function withLifecycleHooks(root, tmp, env, operation) {
  const helpers = await fs.readFile(path.join(root, 'shell/share.sh'), 'utf8');
  const environment = await fs.readFile(
    path.join(root, 'shell/env.sh'),
    'utf8',
  );
  const directory = await fs.mkdtemp(path.join(tmp, 'upgrade-hooks-'));
  try {
    // Keep the installed functions available through replacement and rollback.
    // Their pkill patterns must never become part of the bash command line.
    const snapshot = path.join(directory, 'lifecycle.sh');
    await fs.writeFile(
      snapshot,
      `${helpers}\n${environment}\nimport_config
case "$1" in
  stop) delete_pm2 ;;
  start) reload_pm2 ;;
  install)
    exit_status=0
    npm_install_2 "$2" "$3" "$4"
    hook_install_status=$?
    [[ "$hook_install_status" -eq 0 ]] || exit "$hook_install_status"
    exit "$exit_status"
    ;;
  *) printf '%s\\n' 'Unknown lifecycle operation' >&2; exit 2 ;;
esac
`,
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
    const hook = (operation, args = [], signal) =>
      runProcess(
        env,
        'bash',
        ['--', snapshot, operation, ...args],
        false,
        signal,
      );
    return await operation(hook);
  } finally {
    await fs
      .rm(directory, { recursive: true, force: true })
      .catch(() =>
        console.error(
          `Retained lifecycle snapshot / 保留生命周期快照: ${directory}`,
        ),
      );
  }
}

async function main() {
  const env = process.env,
    root = env.QL_DIR;
  if (!root || !path.isAbsolute(root))
    throw new Error('QL_DIR must be absolute.');
  const tmp = env.dir_tmp || path.join(root, '.tmp');
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'])
    process.on(name, () =>
      controller.abort(new Error(`Upgrade interrupted (${name})`)),
    );
  const run = (program, args, capture) =>
    runProcess(env, program, args, capture, controller.signal);
  await withUpgradeLock(tmp, () =>
    withLifecycleHooks(root, tmp, env, async (hook) => {
      const lifecycle = {
        signal: controller.signal,
        stop: () => hook('stop'),
        start: async (recover) => {
          await hook('start', [], recover ? undefined : controller.signal);
          await waitForHealth(
            env,
            60000,
            recover ? undefined : controller.signal,
          );
        },
      };
      if (process.argv[2] === 'update') {
        await stageUpgrade({
          root,
          tmp,
          env,
          mirror: process.argv[3],
          run,
          signal: controller.signal,
          install: (source, staticRoot, sourceCommit) =>
            hook('install', [source, staticRoot, sourceCommit], controller.signal),
        });
        console.log('更新包下载及校验成功...');
        if (process.argv[4] !== 'true') return;
      } else if (process.argv[2] !== 'reload')
        throw new Error('Unknown upgrade command.');
      await reloadSystem({
        root,
        tmp,
        env,
        data: env.dir_data || path.join(root, 'data'),
        staticRoot: env.dir_static || path.join(root, 'static'),
        config: env.dir_config || path.join(root, 'data/config'),
        lifecycle,
      });
      console.log('更新及启动检查成功...');
    }),
  );
}

module.exports = {
  releaseBranch,
  verifyUpgrade,
  withUpgradeLock,
  stageUpgrade,
  selectedUpgrade,
  replaceAndReload,
  reloadSystem,
  waitForHealth,
  runProcess,
  withLifecycleHooks,
  main,
};
if (require.main === module)
  main().catch((error) => {
    console.error(`更新失败: ${error.message}`);
    process.exitCode = 1;
  });
