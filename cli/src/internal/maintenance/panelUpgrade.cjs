// Persistent panel jobs run independently of HTTP requests and browser sessions.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const artifacts = require('./upgradeArtifacts.cjs');
const { nodeRuntimeArgs } = require('./platformBundle.cjs');

const active = new Set(['starting', 'running', 'restarting']);
const stateFile = (tmp) => path.join(tmp, 'panel-upgrade.json');
const logFile = (tmp) => path.join(tmp, 'panel-upgrade.log');
const launches = new Map();

async function withPanelLifecycle(root, tmp, env, operation, signal) {
  if (!env.QL_CLI_ROOT)
    return artifacts.withLifecycleHooks(root, tmp, env, operation);
  if (!path.isAbsolute(env.QL_CLI_ROOT))
    throw new Error('QL_CLI_ROOT must be absolute');
  const internal = path.join(env.QL_CLI_ROOT, 'dist/internal');
  // Keep the selected installation's operators loaded across file replacement.
  const { createContext, sourceEnvironment } = require(path.join(
    internal,
    'runtime/context.js',
  ));
  const { cancellableOperation } = require(path.join(
    internal,
    'runtime/cancellation.js',
  ));
  const operator = require(path.join(internal, 'maintenance/operator.js'));
  const { prepareUpgradeSelection } = require(path.join(
    internal,
    'maintenance/upgradeSelection.js',
  ));
  const context = createContext(
    { root, 'data-dir': env.dir_data || env.QL_DATA_DIR },
    env,
  );
  context.env = await sourceEnvironment(
    context.env,
    [
      context.paths.file_config_user,
      path.join(context.paths.dir_preload, 'lang_env.sh'),
    ],
    [],
    { signal },
  );
  const hook = (name, args = [], signal) =>
    cancellableOperation(signal, () => {
      if (name === 'install')
        return operator.installPanelDependencies(context, args[0]);
      if (name === 'stop') return operator.stopPanel(context);
      if (name === 'start') return operator.startPanel(context);
      throw new Error('Invalid lifecycle operation');
    });
  return operation(hook, (selected) =>
    prepareUpgradeSelection(context, selected.source, selected.static),
  );
}

async function targetVersion(source) {
  const text = await fs.readFile(path.join(source, 'version.yaml'), 'utf8');
  const version = text.match(/^\uFEFF?version:\s*["']?(\d+\.\d+\.\d+)/m)?.[1];
  if (!version) throw new Error('Invalid update version');
  return version;
}

async function readRunningBuild(env) {
  let base = env.QlBaseUrl || '';
  if (base && !base.startsWith('/')) base = `/${base}`;
  base = base.replace(/\/$/, '');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => request.destroy(new Error('Version check timed out')),
      5000,
    );
    const request = http.get(
      {
        hostname: '127.0.0.1',
        port: Number(env.QlPort || 5700),
        path: `${base}/api/health`,
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 65536)
            request.destroy(new Error('Invalid version response'));
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (
              response.statusCode !== 200 ||
              result.code !== 200 ||
              result.data?.status !== 'ok'
            )
              throw new Error('后端启动检查失败。');
            resolve(result.data.build);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.on('close', () => clearTimeout(timer));
  });
}

async function verifyRunningVersion(env, expected, previousBuild) {
  const build = await readRunningBuild(env);
  if (
    !build ||
    !build.instanceId ||
    build.instanceId === previousBuild?.instanceId ||
    (previousBuild?.parentPid !== undefined &&
      build.parentPid === previousBuild.parentPid) ||
    build.version !== expected.version ||
    build.sourceCommit !== expected.sourceCommit ||
    build.backendSha256 !== expected.backendSha256
  )
    throw new Error('启动版本与更新包不一致');
}

async function stagedMetadata(selected) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(selected.static, 'build-info.json'), 'utf8'),
  );
  return {
    version: await targetVersion(selected.source),
    sourceCommit: manifest.sourceCommit,
    backendSha256: manifest.files['build/app.js'],
    stageDirectory: path.basename(path.dirname(selected.source)),
  };
}

function assertSelected(expected, actual) {
  for (const key of [
    'sourceCommit',
    'backendSha256',
    'stageDirectory',
    'version',
  ]) {
    if (expected[key] !== actual[key])
      throw new Error('暂存更新已变化，请重新下载更新。');
  }
}

async function save(tmp, state) {
  const temporary = `${stateFile(tmp)}.${randomUUID()}`;
  await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(temporary, stateFile(tmp));
}

async function readState(tmp) {
  try {
    return JSON.parse(await fs.readFile(stateFile(tmp), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'idle' };
    throw error;
  }
}

async function getStatus(tmp) {
  const state = await readState(tmp);
  if (active.has(state.status)) {
    let alive = false;
    if (Number.isSafeInteger(state.pid) && state.pid > 0) {
      try {
        process.kill(state.pid, 0);
        alive = true;
      } catch (error) {
        alive = error.code === 'EPERM';
      }
    } else alive = Date.now() - state.startedAt < 10000;
    if (!alive) {
      state.status = 'failed';
      state.error = '升级任务意外中断，请重试';
    }
  }
  // Bound reads even when an installer produces a very large log.
  const handle = await fs.open(logFile(tmp), 'r').catch(() => undefined);
  if (handle) {
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(size, 32768));
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        Math.max(0, size - buffer.length),
      );
      state.log = buffer.subarray(0, bytesRead).toString();
    } finally {
      await handle.close();
    }
  }
  return state;
}

async function startJob({ root, tmp, env = process.env }, action) {
  if (!['download', 'apply'].includes(action))
    throw new Error('Invalid upgrade action');
  await fs.mkdir(tmp, { recursive: true });
  const preceding = launches.get(tmp) || Promise.resolve();
  const launching = preceding
    .catch(() => {})
    .then(() =>
      artifacts.withUpgradeLock(
        path.join(tmp, 'panel-job-launch'),
        async () => {
          const previous = await getStatus(tmp);
          if (active.has(previous.status)) {
            if (previous.action !== action)
              throw new Error('已有更新或重载正在执行。');
            return previous;
          }
          let selected;
          let metadata;
          if (action === 'apply') {
            // Fail before launching a process or stopping the working panel.
            try {
              selected = await artifacts.selectedUpgrade(
                tmp,
                artifacts.releaseBranch(env),
                env,
              );
              metadata = await stagedMetadata(selected);
              if (previous.status === 'ready')
                assertSelected(previous, metadata);
            } catch (error) {
              const { log, ...record } = previous;
              await save(tmp, {
                ...record,
                status: 'failed',
                phase: 'verifying',
                error: error.message,
              });
              throw error;
            }
          } else if (previous.status === 'ready') return previous;
          const state = {
            id: randomUUID(),
            action,
            status: 'starting',
            phase: action === 'apply' ? 'verifying' : 'downloading',
            startedAt: Date.now(),
            ...metadata,
          };
          await save(tmp, state);
          const log = await fs.open(logFile(tmp), 'w', 0o600);
          try {
            const child = spawn(
              process.execPath,
              [__filename, 'launch', state.id],
              {
                env: { ...env, QL_DIR: root, dir_tmp: tmp },
                detached: true,
                stdio: ['ignore', log.fd, log.fd],
              },
            );
            await new Promise((resolve, reject) => {
              child.once('exit', (code, signal) => {
                if (code === 0) resolve();
                else
                  reject(
                    new Error(`Upgrade launcher exited (${signal || code})`),
                  );
              });
              child.once('error', reject);
            });
            child.unref();
          } catch (error) {
            await save(tmp, {
              ...state,
              status: 'failed',
              error: error.message,
            });
            throw error;
          } finally {
            await log.close();
          }
          return state;
        },
        env,
      ),
    );
  launches.set(tmp, launching);
  try {
    return await launching;
  } finally {
    if (launches.get(tmp) === launching) launches.delete(tmp);
  }
}

async function runJob({ root, tmp, env = process.env }, id) {
  let state = await readState(tmp);
  if (state.id !== id || state.status !== 'starting')
    throw new Error('Stale upgrade job');
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('升级任务意外中断，请重试'));
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  // Serialize progress writes so an older tick cannot overwrite ready/completed.
  let writes = Promise.resolve();
  const report = (patch) => {
    state = { ...state, ...patch, pid: process.pid, updatedAt: Date.now() };
    const snapshot = { ...state };
    writes = writes.then(() => save(tmp, snapshot));
    return writes;
  };
  try {
    await report({ status: 'running' });
    let terminal;
    await artifacts.withUpgradeLock(
      tmp,
      () =>
        withPanelLifecycle(
          root,
          tmp,
          env,
          async (hook, prepareSelection) => {
            const run = (program, args, capture) =>
              artifacts.runProcess(
                env,
                program,
                args,
                capture,
                controller.signal,
              );
            if (state.action === 'download') {
              const selected = await artifacts.stageUpgrade({
                root,
                tmp,
                env,
                mirror: 'github',
                fallbackMirror: 'gitee',
                run,
                signal: controller.signal,
                onProgress: report,
                install: (source) =>
                  hook('install', [source], controller.signal),
              });
              terminal = {
                status: 'ready',
                phase: 'ready',
                ...(await stagedMetadata(selected)),
              };
            } else {
              const selected = await artifacts.selectedUpgrade(
                tmp,
                artifacts.releaseBranch(env),
                env,
              );
              assertSelected(state, await stagedMetadata(selected));
              const previousBuild = await readRunningBuild(env).catch(
                () => undefined,
              );
              const selection = await prepareSelection?.(selected);
              try {
                await artifacts.reloadSystem({
                  root,
                  tmp,
                  env,
                  data:
                    env.dir_data || env.QL_DATA_DIR || path.join(root, 'data'),
                  staticRoot: env.dir_static || path.join(root, 'static'),
                  config:
                    env.dir_config ||
                    path.join(
                      env.QL_DATA_DIR || path.join(root, 'data'),
                      'config',
                    ),
                  lifecycle: {
                    signal: controller.signal,
                    stop: async () => {
                      await report({
                        status: 'restarting',
                        phase: 'restarting',
                      });
                      await hook('stop');
                    },
                    start: async (recover) => {
                      await hook(
                        'start',
                        [],
                        recover ? undefined : controller.signal,
                      );
                      await artifacts.waitForHealth(
                        env,
                        undefined,
                        recover ? undefined : controller.signal,
                      );
                      if (!recover)
                        await verifyRunningVersion(env, state, previousBuild);
                    },
                  },
                  additionalReplacements: selection
                    ? [{ source: selection.source, target: selection.target }]
                    : [],
                });
              } finally {
                if (selection)
                  await fs.rm(selection.directory, {
                    recursive: true,
                    force: true,
                  });
              }
              terminal = { status: 'completed', phase: 'completed' };
            }
          },
          controller.signal,
        ),
      env,
    );
    await report(terminal);
  } catch (error) {
    console.error(error);
    // A failed write must not prevent recording the final failure.
    await writes.catch(() => {});
    writes = Promise.resolve();
    await report({ status: 'failed', error: error.message });
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    await writes;
  }
}

module.exports = {
  getStatus,
  saveState: save,
  startJob,
  runJob,
  withPanelLifecycle,
  readRunningBuild,
  verifyRunningVersion,
  stagedMetadata,
};
async function launchWorker(id) {
  // detached creates a session but keeps the original parent. PM2 kills the
  // backend's entire descendant tree, so an intermediate launcher must exit
  // before the worker is allowed to stop that backend.
  const child = spawn(
    process.execPath,
    [...nodeRuntimeArgs(), __filename, 'worker', id],
    {
      env: { ...process.env, QL_UPGRADE_LAUNCHER_PID: String(process.pid) },
      detached: true,
      stdio: 'inherit',
    },
  );
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
}

async function runOrphanedWorker(id) {
  const launcher = Number(process.env.QL_UPGRADE_LAUNCHER_PID);
  const deadline = Date.now() + 10000;
  while (process.platform !== 'win32' && process.ppid === launcher) {
    if (Date.now() >= deadline)
      throw new Error('Upgrade launcher did not exit');
    await delay(10);
  }
  const root = process.env.QL_DIR;
  await runJob(
    { root, tmp: process.env.dir_tmp || path.join(root, '.tmp') },
    id,
  );
}

if (require.main === module && ['launch', 'worker'].includes(process.argv[2])) {
  const operation =
    process.argv[2] === 'launch' ? launchWorker : runOrphanedWorker;
  operation(process.argv[3]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
