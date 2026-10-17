#!/usr/bin/env node
// Also published as a standalone, bundled installer for devices with Node only.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);
const { parseArgs } = require('node:util');
const artifacts = require('../cli/src/internal/maintenance/upgradeArtifacts.cjs');
const jobs = require('../cli/src/internal/maintenance/panelUpgrade.cjs');
const {
  nodeRuntimeArgs,
} = require('../cli/src/internal/maintenance/platformBundle.cjs');

async function runInstallerMain(argv = process.argv.slice(2)) {
  const flags = nodeRuntimeArgs();
  if (!flags.length || process.execArgv.includes('--jitless'))
    return installBundle(argv);
  const child = require('node:child_process').spawn(
    process.execPath,
    [...flags, __filename, ...argv],
    { stdio: 'inherit', env: process.env },
  );
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Offline installer exited: ${signal || code}`));
      });
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

async function installBundle(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string' },
      file: { type: 'string' },
      'download-only': { type: 'boolean' },
      install: { type: 'boolean' },
    },
  });
  if (!values.file || !(values.root || env.QL_DIR))
    throw new Error(
      'Usage: node install-bundle.cjs --root /path/to/qinglong --file /path/to/bundle.tar.gz [--download-only | --install]',
    );
  if (values.install && values['download-only'])
    throw new Error('Choose --install or --download-only');
  const root = path.resolve(values.root || env.QL_DIR);
  const existing = await fs.readdir(root).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  if (values.install && existing.length)
    throw new Error('--install requires an empty installation directory');
  if (!values.install) await fs.access(path.join(root, 'shell/share.sh'));
  let environment = {
    ...env,
    QL_DIR: root,
    QL_UPGRADE_FILE: path.resolve(values.file),
  };
  if (!values.install) {
    const captured = await execute(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        '. "$1/shell/share.sh"\n. "$1/shell/env.sh"\nimport_config\nexport QlPort="${ql_port:-${QlPort:-5700}}" QlBaseUrl="${ql_base_url:-${QlBaseUrl:-/}}"\nenv -0',
        'ql-offline',
        root,
      ],
      { env: environment, maxBuffer: 1024 * 1024 },
    );
    const loaded = Object.fromEntries(
      captured.stdout.split('\0').flatMap((line) => {
        const match = /^([A-Za-z_][A-Za-z_0-9]*)=([\s\S]*)$/.exec(line);
        return match ? [[match[1], match[2]]] : [];
      }),
    );
    environment = {
      ...environment,
      ...loaded,
      QL_DIR: root,
      QL_UPGRADE_FILE: path.resolve(values.file),
    };
  }
  const freshWorkspace = values.install
    ? await fs.mkdtemp(path.join(os.tmpdir(), 'ql-offline-install-'))
    : undefined;
  const tmp = freshWorkspace || path.join(root, '.tmp');
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('离线升级已中断'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const operation = () =>
      artifacts.withUpgradeLock(
        tmp,
        async () => {
          let state;
          const report = async (patch) => {
            if (patch.phase) console.log(patch.phase);
            if (state) {
              state = {
                ...state,
                ...patch,
                pid: process.pid,
                updatedAt: Date.now(),
              };
              await jobs.saveState(tmp, state);
            }
          };
          if (!values.install) {
            const previous = await jobs.getStatus(tmp);
            if (['starting', 'running', 'restarting'].includes(previous.status))
              throw new Error('已有更新或重载正在执行。');
            state = {
              id: randomUUID(),
              action: values['download-only'] ? 'download' : 'apply',
              status: 'running',
              phase: 'verifying',
              startedAt: Date.now(),
            };
            await report({});
            await fs.writeFile(
              path.join(tmp, 'panel-upgrade.log'),
              'Offline bundle verification\n',
              { mode: 0o600 },
            );
          }
          try {
            const selected = await artifacts.stageUpgrade({
              root,
              tmp,
              env: environment,
              run: (program, args, capture) =>
                artifacts.runProcess(
                  environment,
                  program,
                  args,
                  capture,
                  controller.signal,
                ),
              signal: controller.signal,
              onProgress: report,
              install: async () => {
                throw new Error(
                  'Offline bundles never install npm dependencies',
                );
              },
            });
            if (state)
              await report({
                status: 'ready',
                phase: 'ready',
                ...(await jobs.stagedMetadata(selected)),
              });
            if (values['download-only']) {
              console.log('更新已就绪；执行 ql reload system 应用更新。');
              return selected;
            }
            if (values.install) {
              // Build beside the destination, then atomically replace only an empty root.
              await fs.mkdir(path.dirname(root), { recursive: true });
              const publication = await fs.mkdtemp(
                path.join(path.dirname(root), '.qinglong-install-'),
              );
              try {
                await fs.chmod(publication, 0o755);
                await fs.cp(selected.source, publication, {
                  recursive: true,
                  verbatimSymlinks: true,
                });
                await fs.cp(selected.static, path.join(publication, 'static'), {
                  recursive: true,
                });
                await fs.copyFile(
                  path.join(publication, '.env.example'),
                  path.join(publication, '.env'),
                  require('node:fs').constants.COPYFILE_EXCL,
                );
                await fs.chmod(path.join(publication, '.env'), 0o600);
                controller.signal.throwIfAborted();
                await fs.rename(publication, root);
              } finally {
                await fs.rm(publication, { recursive: true, force: true });
              }
              await fs.rm(path.dirname(selected.source), {
                recursive: true,
                force: true,
              });
              await fs.rm(
                path.join(
                  tmp,
                  `upgrade-ready-${artifacts.releaseBranch(environment)}.json`,
                ),
                { force: true },
              );
              console.log(
                `离线安装完成，保留现有 Node ${
                  process.version
                }。启动服务：QL_DIR=${JSON.stringify(
                  root,
                )} bash ${JSON.stringify(
                  path.join(root, 'shell/start-simplify.sh'),
                )}`,
              );
              return;
            }
            const result = await jobs.withPanelLifecycle(
              root,
              tmp,
              environment,
              async (hook, prepareSelection) => {
                const expected = await jobs.stagedMetadata(selected);
                const previous = await jobs
                  .readRunningBuild(environment)
                  .catch(() => undefined);
                const selection = await prepareSelection?.(selected);
                try {
                  return await artifacts.reloadSystem({
                    root,
                    tmp,
                    env: environment,
                    data: environment.dir_data || path.join(root, 'data'),
                    staticRoot: path.join(root, 'static'),
                    config:
                      environment.dir_config || path.join(root, 'data/config'),
                    lifecycle: {
                      signal: controller.signal,
                      stop: async () => {
                        await report({
                          status: 'restarting',
                          phase: 'restarting',
                        });
                        await hook('stop', [], controller.signal);
                      },
                      start: async (recover) => {
                        await hook(
                          'start',
                          [],
                          recover ? undefined : controller.signal,
                        );
                        await artifacts.waitForHealth(
                          environment,
                          60000,
                          recover ? undefined : controller.signal,
                        );
                        if (!recover)
                          await jobs.verifyRunningVersion(
                            environment,
                            expected,
                            previous,
                          );
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
              },
              controller.signal,
            );
            await report({ status: 'completed', phase: 'completed' });
            console.log('升级成功，已保留现有 Node 并运行更新后的版本。');
            return result;
          } catch (error) {
            if (state) await report({ status: 'failed', error: error.message });
            throw error;
          }
        },
        environment,
      );
    return values.install
      ? await operation()
      : await artifacts.withUpgradeLock(
          path.join(tmp, 'panel-job-launch'),
          operation,
          environment,
        );
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    if (freshWorkspace)
      await fs.rm(freshWorkspace, { recursive: true, force: true });
  }
}

module.exports = { installBundle, runInstallerMain };
if (require.main === module)
  runInstallerMain().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
