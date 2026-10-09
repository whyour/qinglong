import { prepareUpgradeSelection } from './upgradeSelection';
import { translate } from '../../shared/i18n/index';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LocalContext } from '../runtime/context';
import { checkedProcess } from '../runtime/process';
import { operationSignal, withoutCancellation } from '../runtime/cancellation';
import { installPanelDependencies, startPanel, stopPanel } from './operator';

// The Bash image updater and local CLI must enforce the same build provenance.
const artifacts = require('./upgradeArtifacts.cjs') as {
  releaseBranch(env: NodeJS.ProcessEnv): string;
  verifyUpgrade(source: string, staticRoot: string): Promise<unknown>;
  waitForHealth(
    env: NodeJS.ProcessEnv,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<void>;
  withUpgradeLock<T>(tmp: string, operation: () => Promise<T>): Promise<T>;
  stageUpgrade(options: {
    root: string;
    tmp: string;
    env: NodeJS.ProcessEnv;
    mirror: 'github' | 'gitee';
    signal?: AbortSignal;
    run(program: string, args: string[], capture?: boolean): Promise<unknown>;
    install(source: string, staticRoot: string, sourceCommit: string): Promise<void>;
  }): Promise<{ source: string; static: string }>;
  selectedUpgrade(
    tmp: string,
    branch: string,
  ): Promise<{ source: string; static: string }>;
};

export function releaseBranch(context: LocalContext): string {
  return artifacts.releaseBranch(context.env);
}

async function validateTree(
  root: string,
  environment: NodeJS.ProcessEnv,
  boundary = root,
): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = await fs.realpath(filename);
      const relation = path.relative(await fs.realpath(boundary), resolved);
      if (
        !relation ||
        relation === '..' ||
        relation.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relation)
      )
        throw new Error(
          translate(environment, '升级文件包含指向目录外部的符号链接。'),
        );
      continue;
    }
    if (!entry.isFile() && !entry.isDirectory())
      throw new Error(translate(environment, '升级文件包含不支持的文件类型。'));
    if (entry.isDirectory())
      await validateTree(filename, environment, boundary);
  }
}

export async function stageUpgrade(
  context: LocalContext,
  mirror: 'github' | 'gitee',
): Promise<{ source: string; static: string }> {
  return artifacts.withUpgradeLock(context.paths.dir_tmp!, () =>
    artifacts.stageUpgrade({
      root: context.root,
      tmp: context.paths.dir_tmp!,
      env: context.env,
      mirror,
      signal: operationSignal(),
      run: (program, args, capture) =>
        checkedProcess(program, args, { env: context.env, capture }),
      install: (source, staticRoot, sourceCommit) =>
        installPanelDependencies(context, source, staticRoot, sourceCommit),
    }),
  );
}

async function selectedUpgrade(
  context: LocalContext,
): Promise<{ source: string; static: string }> {
  return artifacts.selectedUpgrade(
    context.paths.dir_tmp!,
    releaseBranch(context),
  );
}

export interface ReloadLifecycle {
  stop(context: LocalContext): Promise<void>;
  start(context: LocalContext): Promise<unknown>;
}

// All old entries stay on the same filesystem until service start succeeds.
// A failed replacement rolls back in reverse order before restarting the old app.
export async function replaceAndReload(
  context: LocalContext,
  replacements: { source?: string; target: string }[],
  lifecycle: ReloadLifecycle = { stop: stopPanel, start: startPanel },
): Promise<unknown> {
  for (const item of replacements) {
    // Missing source denotes deletion, backed up and rolled back like replacement.
    if (item.source === undefined) continue;
    await fs.lstat(item.source);
    if (path.resolve(item.source) === path.resolve(item.target))
      throw new Error(translate(context.env, '替换源与目标相同。'));
    const relation = path.relative(
      path.resolve(item.target),
      path.resolve(item.source),
    );
    if (
      !relation.startsWith(`..${path.sep}`) &&
      relation !== '..' &&
      !path.isAbsolute(relation)
    )
      throw new Error(translate(context.env, '替换源位于目标目录内部。'));
  }
  const changed: { target: string; backup: string; existed: boolean }[] = [];
  const signal = operationSignal();
  signal?.throwIfAborted();
  let result: unknown;
  let attemptedStart = false;
  try {
    await lifecycle.stop(context);
    signal?.throwIfAborted();
    for (const { source, target } of replacements) {
      signal?.throwIfAborted();
      await fs.mkdir(path.dirname(target), { recursive: true });
      const backup = `${target}.ql-backup-${randomUUID()}`;
      const existed = !!(await fs
        .lstat(target)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        }));
      let recorded = false;
      if (existed) {
        try {
          await fs.rename(target, backup);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          // OverlayFS can reject renaming a lower-layer directory even within
          // one mount. Finish its backup before removing any original entry.
          try {
            await fs.cp(target, backup, {
              recursive: true,
              verbatimSymlinks: true,
              dereference: false,
              errorOnExist: true,
              force: false,
            });
          } catch (copyError) {
            await fs.rm(backup, { recursive: true, force: true });
            throw copyError;
          }
          changed.push({ target, backup, existed });
          recorded = true;
          await fs.rm(target, { recursive: true });
        }
      }
      if (!recorded) changed.push({ target, backup, existed });
      // Copy supports an external QL_DATA_DIR on a different filesystem.
      if (source !== undefined)
        await fs.cp(source, target, {
          recursive: true,
          verbatimSymlinks: true,
          dereference: false,
          errorOnExist: true,
          force: false,
        });
    }
    signal?.throwIfAborted();
    attemptedStart = true;
    result = await lifecycle.start(context);
    signal?.throwIfAborted();
  } catch (error) {
    await withoutCancellation(async () => {
      // A failed or interrupted start can leave a partially started service.
      // Stop it before restoring files; retain backups if it cannot be stopped.
      if (attemptedStart) await lifecycle.stop(context);
      for (const item of changed.reverse()) {
        await fs.rm(item.target, { recursive: true, force: true });
        if (item.existed) await fs.rename(item.backup, item.target);
      }
      try {
        await lifecycle.start(context);
      } catch {
        throw new Error(
          translate(
            context.env,
            '重载失败；文件已恢复，但原服务无法重新启动。',
          ),
          { cause: error },
        );
      }
    });
    throw error;
  }
  // Cleanup failure must never initiate rollback after backups have been removed.
  const retainedBackups: string[] = [];
  for (const item of changed)
    if (item.existed) {
      try {
        await fs.rm(item.backup, { recursive: true, force: true });
      } catch {
        retainedBackups.push(item.backup);
      }
    }
  return { service: result, retainedBackups };
}

export async function reloadPanel(
  context: LocalContext,
  target: 'services' | 'system' | 'data',
  staged?: { source: string; static: string },
): Promise<unknown> {
  if (target === 'services') {
    await stopPanel(context);
    return startPanel(context);
  }
  if (target === 'data') {
    if (
      context.data === path.parse(context.data).root ||
      context.data === context.root ||
      context.root.startsWith(`${context.data}${path.sep}`)
    )
      throw new Error(translate(context.env, '数据重载需要独立的数据目录。'));
    const source = path.join(context.paths.dir_tmp!, 'data');
    if (
      source === context.data ||
      source.startsWith(`${context.data}${path.sep}`) ||
      context.data.startsWith(`${source}${path.sep}`)
    )
      throw new Error(
        translate(context.env, '暂存数据与已安装的数据目录必须分离。'),
      );
    await validateTree(source, context.env);
    await fs.mkdir(context.data, { recursive: true });
    const incoming = new Set(await fs.readdir(source));
    const entries = new Set([...(await fs.readdir(context.data)), ...incoming]);
    // A Docker volume's root cannot be renamed. Keep it in place and transact
    // its children, including removals, with backups on the same filesystem.
    return replaceAndReload(
      context,
      [...entries].map((name) => ({
        source: incoming.has(name) ? path.join(source, name) : undefined,
        target: path.join(context.data, name),
      })),
    );
  }
  const selected = staged ?? (await selectedUpgrade(context));
  const source = selected.source;
  const staticRoot = selected.static;
  await validateTree(source, context.env);
  await validateTree(staticRoot, context.env);
  await artifacts.verifyUpgrade(source, staticRoot);
  const entries = await fs.readdir(source);
  const reserved = new Set(['data', '.tmp', 'static', '.git', '.env']);
  const relativeData = path.relative(context.root, context.data);
  if (
    relativeData &&
    !relativeData.startsWith('..') &&
    !path.isAbsolute(relativeData)
  )
    reserved.add(relativeData.split(path.sep)[0]!);
  const replacements = entries
    .filter((name) => !reserved.has(name))
    .map((name) => ({
      source: path.join(source, name),
      target: path.join(context.root, name),
    }));
  replacements.push({ source: staticRoot, target: context.paths.dir_static! });
  replacements.push({
    source: path.join(source, 'sample/config.sample.sh'),
    target: path.join(context.paths.dir_config!, 'config.sample.sh'),
  });
  const selection = await prepareUpgradeSelection(context, source, staticRoot);
  if (selection)
    replacements.push({ source: selection.source, target: selection.target });
  try {
    return await artifacts.withUpgradeLock(context.paths.dir_tmp!, () =>
      replaceAndReload(context, replacements, {
        stop: stopPanel,
        start: async (ctx) => {
          const service = await startPanel(ctx);
          await artifacts.waitForHealth(ctx.env, 60000, operationSignal());
          return service;
        },
      }),
    );
  } finally {
    if (selection)
      await fs.rm(selection.directory, { recursive: true, force: true });
  }
}
