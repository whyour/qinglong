import { translate } from '../../shared/i18n/index';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { LocalContext } from '../runtime/context';
import { atomicWrite } from '../runtime/files';
import { runProcess, checkedProcess } from '../runtime/process';
import { findDirectBackendPids } from '../runtime/backendProcesses';

export async function repairConfiguration(
  context: LocalContext,
): Promise<string[]> {
  for (const name of [
    'tmp',
    'static',
    'data',
    'config',
    'log',
    'db',
    'scripts',
    'list_tmp',
    'repo',
    'raw',
    'update_log',
    'dep',
  ])
    await fs.mkdir(context.paths[`dir_${name}`]!, { recursive: true });
  const restored: string[] = [];
  const templates: [string, string, boolean][] = [
    ['file_config_user', 'file_config_sample', true],
    ['file_task_before', 'file_task_sample', false],
    ['file_task_after', 'file_task_sample', false],
    ['file_extra_shell', 'file_extra_sample', false],
    ['file_notify_py', 'file_notify_py_sample', true],
    ['file_notify_js', 'file_notify_js_sample', true],
    ['file_test_js', 'file_test_js_sample', true],
    ['file_test_py', 'file_test_py_sample', true],
    ['dep_notify_js', 'file_notify_js_sample', true],
    ['dep_notify_py', 'file_notify_py_sample', true],
  ];
  for (const [destination, source, fillEmpty] of templates) {
    const target = context.paths[destination]!;
    const stat = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (stat && (!fillEmpty || stat.size > 0)) continue;
    await atomicWrite(target, await fs.readFile(context.paths[source]!));
    restored.push(target);
  }
  return restored;
}

export async function executableAvailable(
  program: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    try {
      await fs.access(path.join(directory, program), fs.constants.X_OK);
      return true;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return false;
}

export async function installPanelDependencies(
  context: LocalContext,
  cwd = context.root,
): Promise<void> {
  const termux = context.env.is_termux === '1';
  const pnpm = !termux && (await executableAvailable('pnpm', context.env));
  await checkedProcess(
    pnpm ? 'pnpm' : 'npm',
    pnpm
      ? ['install', '--loglevel', 'error', '--production']
      : ['install', '--production', ...(termux ? ['--no-bin-links'] : [])],
    { cwd, env: context.env },
  );
}

// Match only this installation's backend; the legacy broad pkill pattern could
// terminate another panel running on the same host.
async function stopDirectBackend(context: LocalContext): Promise<void> {
  const entry = path.join(context.paths.dir_static!, 'build/app.js');
  if (process.platform === 'linux') {
    const stopping = new Set(await findDirectBackendPids(entry));
    for (const pid of stopping) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const deadline = Date.now() + 5000;
    while (
      (await findDirectBackendPids(entry)).some((pid) => stopping.has(pid))
    ) {
      if (Date.now() >= deadline)
        throw new Error(
          translate(context.env, '后端进程未在 5 秒内停止，已取消重启。'),
        );
      await delay(50);
    }
    return;
  }
  const result = await runProcess('ps', ['-eo', 'pid=,args='], {
    capture: true,
    env: context.env,
  });
  if (result.code !== 0)
    throw new Error(translate(context.env, '无法检查运行中的后端进程。'));
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || !/^node(?:\d+)?$/.test(path.basename(match[2]!))) continue;
    if (match[3] !== entry) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

export async function stopPanel(context: LocalContext): Promise<void> {
  if (await executableAvailable('pm2', context.env))
    await runProcess('pm2', ['delete', 'ecosystem.config.js'], {
      cwd: context.root,
      env: context.env,
    });
  await stopDirectBackend(context);
}

export async function startPanel(
  context: LocalContext,
): Promise<{ manager: 'pm2' | 'node'; pid?: number }> {
  // Match container startup even when invoked from a fresh administrative CLI
  // process. Legacy dotenv files can still contain BACK_PORT=5600.
  const options = {
    cwd: context.root,
    env: {
      ...context.env,
      BACK_PORT: context.env.QlPort || '5700',
      GRPC_PORT: context.env.QlGrpcPort || '5500',
    },
  };
  if (await executableAvailable('pm2', context.env)) {
    const flushed = await runProcess('pm2', ['flush'], options);
    if (flushed.code === 0) {
      const started = await runProcess(
        'pm2',
        ['startOrGracefulReload', 'ecosystem.config.js', '--update-env'],
        options,
      );
      if (started.code === 0) return { manager: 'pm2' };
    }
  }
  await stopDirectBackend(context);
  const entry = path.join(context.paths.dir_static!, 'build/app.js');
  await fs.access(entry);
  await fs.mkdir(context.paths.dir_log!, { recursive: true });
  const log = await fs.open(
    path.join(context.paths.dir_log!, 'qinglong.log'),
    'a',
    0o600,
  );
  try {
    const child = spawn(process.execPath, [entry], {
      ...options,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      const failed = (code: number | null) => {
        clearTimeout(timer);
        reject(
          new Error(
            translate(
              context.env,
              '直接运行的后端在启动期间退出（%s）。',
              code,
            ),
          ),
        );
      };
      const timer = setTimeout(() => {
        child.removeListener('exit', failed);
        resolve();
      }, 1000);
      child.once('exit', failed);
    });
    child.unref();
    return { manager: 'node', pid: child.pid };
  } finally {
    await log.close();
  }
}
