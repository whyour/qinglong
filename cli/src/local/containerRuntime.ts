import { translate } from '../i18n';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type LocalContext, sourceEnvironment } from './context';
import { prepareContainerEnvironment } from './containerEnvironment';
import {
  executableAvailable,
  repairConfiguration,
  startPanel,
  stopPanel,
} from './operator';
import { launchStartupHook } from './bootstrap';
import { stopBot } from './bot';
import { runProcess } from './process';
import {
  cancellableOperation,
  interruptedCode,
  withoutCancellation,
} from './cancellation';

export interface ContainerServices {
  start: typeof startPanel;
  stop: typeof stopPanel;
  hook: typeof launchStartupHook;
}

async function stopStartupGroups(pids: number[]): Promise<void> {
  const alive = new Set(pids);
  const send = (pid: number, signal: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  for (const pid of alive) if (!send(pid, 'SIGTERM')) alive.delete(pid);
  // The hook CLI gives its subprocess groups ten seconds before SIGKILL.
  // Let that owner finish cleanup before terminating the owner itself.
  const deadline = Date.now() + 15000;
  while (alive.size && Date.now() < deadline) {
    await delay(50);
    for (const pid of alive) if (!send(pid, 0)) alive.delete(pid);
  }
  for (const pid of alive) send(pid, 'SIGKILL');
}

/** Owns a dedicated container, with an external init responsible for orphan reaping. */
export async function runContainer(
  context: LocalContext,
  signal: AbortSignal,
  options: {
    systemDirectory?: string;
    services?: ContainerServices;
    event?: (event: Record<string, unknown>) => void;
  } = {},
): Promise<number> {
  const services = options.services ?? {
    start: startPanel,
    stop: stopPanel,
    hook: launchStartupHook,
  };
  let runtime = context;
  let serviceAttempted = false;
  let botAttempted = false;
  const hooks: number[] = [];
  try {
    return await cancellableOperation(signal, async () => {
      const prepared = await prepareContainerEnvironment({
        root: context.root,
        data: context.data,
        env: context.env,
        systemDirectory: options.systemDirectory,
      });
      runtime = { ...context, env: prepared.env };
      for (const warning of prepared.warnings)
        options.event?.({ event: 'warning', message: warning });
      await repairConfiguration(runtime);
      runtime.env = await sourceEnvironment(
        runtime.env,
        [
          runtime.paths.file_config_user!,
          path.join(runtime.paths.dir_preload!, 'lang_env.sh'),
        ],
        [],
        { signal },
      );
      runtime.env.BACK_PORT = runtime.env.QlPort || '5700';
      runtime.env.GRPC_PORT = runtime.env.QlGrpcPort || '5500';
      const scheduler =
        runtime.env.QL_SCHEDULER ||
        ((await executableAvailable('crond', runtime.env)) ? 'system' : 'node');
      if (scheduler !== 'node' && scheduler !== 'system')
        throw new Error(
          translate(runtime.env, 'QL_SCHEDULER 必须为 node 或 system。'),
        );
      runtime.env.QL_SCHEDULER = scheduler;
      // Set scheduler mode before the backend starts, so both agree on ownership.
      signal.throwIfAborted();
      serviceAttempted = true;
      const service = await services.start(runtime);
      signal.throwIfAborted();
      for (const [setting, action] of [
        ['AutoStartBot', 'bot'],
        ['EnableExtraShell', 'extra'],
      ] as const) {
        if (runtime.env[setting] === 'true') {
          if (action === 'bot') botAttempted = true;
          hooks.push(await services.hook(runtime, action));
        }
        signal.throwIfAborted();
      }
      options.event?.({
        event: 'started',
        scheduler,
        manager: service.manager,
      });
      if (scheduler === 'system') {
        const result = await runProcess('crond', ['-f'], {
          cwd: runtime.root,
          env: runtime.env,
          signal,
          graceMs: 3000,
        });
        if (signal.aborted) return interruptedCode(signal)!;
        // A foreground scheduler exiting, even with zero, means supervision failed.
        throw new Error(
          translate(runtime.env, '容器调度器意外退出（%s）。', result.code),
        );
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const keepAlive = setInterval(() => {}, 60000);
        signal.addEventListener(
          'abort',
          () => {
            clearInterval(keepAlive);
            resolve();
          },
          { once: true },
        );
      });
      return interruptedCode(signal)!;
    });
  } catch (error) {
    if (signal.aborted) return interruptedCode(signal)!;
    throw error;
  } finally {
    await withoutCancellation(async () => {
      try {
        await stopStartupGroups(hooks);
      } finally {
        try {
          // The installer can exit after detaching Python into a new session.
          // Stop it only after installation/recovery has finished, scoped to
          // this container's data directory rather than the installer PID.
          if (botAttempted) await stopBot(runtime);
        } finally {
          if (serviceAttempted) await services.stop(runtime);
        }
      }
    });
  }
}
