import { prepareUpgradeSelection } from './upgradeSelection';
import { translate } from '../../shared/i18n/index';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LocalContext } from '../runtime/context';
import { checkedProcess } from '../runtime/process';
import { operationSignal, withoutCancellation } from '../runtime/cancellation';
import { installPanelDependencies, startPanel, stopPanel } from './operator';

export function releaseBranch(context: LocalContext): string {
  return ['develop', 'debian', 'debian-dev'].includes(
    context.env.QL_BRANCH ?? '',
  )
    ? context.env.QL_BRANCH!
    : 'master';
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
  await fs.mkdir(context.paths.dir_tmp!, { recursive: true });
  const workspace = await fs.mkdtemp(
    path.join(context.paths.dir_tmp!, 'upgrade-'),
  );
  const branch = releaseBranch(context);
  try {
    for (const repository of ['qinglong', 'qinglong-static']) {
      const url =
        mirror === 'github'
          ? `https://github.com/whyour/${repository}/archive/refs/heads/${branch}.zip`
          : `https://gitee.com/whyour/${repository}/repository/archive/${branch}.zip`;
      const archive = path.join(workspace, `${repository}.zip`);
      await checkedProcess(
        'curl',
        [
          '--fail',
          '--location',
          '--proto',
          '=https',
          '--proto-redir',
          '=https',
          '--output',
          archive,
          url,
        ],
        { env: context.env },
      );
      const listing = await checkedProcess('unzip', ['-Z1', archive], {
        env: context.env,
        capture: true,
      });
      const expected = `${repository}-${branch}`;
      for (const name of listing.stdout.split('\n').filter(Boolean)) {
        if (
          name.includes('\\') ||
          name.includes('\r') ||
          name.startsWith('/') ||
          name.split('/').includes('..') ||
          name.split('/')[0] !== expected
        )
          throw new Error(translate(context.env, '升级归档包含无效路径。'));
      }
      // Reject Unix symlinks before extraction, including links that could redirect
      // a later archive entry outside the staging directory.
      const modes = await checkedProcess('unzip', ['-Z', '-l', archive], {
        env: context.env,
        capture: true,
      });
      if (modes.stdout.split('\n').some((line) => /^l[rwx-]{9}\s/.test(line)))
        throw new Error(translate(context.env, '升级归档包含符号链接。'));
      await checkedProcess('unzip', ['-oq', archive, '-d', workspace], {
        env: context.env,
      });
      await validateTree(path.join(workspace, expected), context.env);
    }
    const source = path.join(workspace, `qinglong-${branch}`);
    const staticRoot = path.join(workspace, `qinglong-static-${branch}`);
    await fs.access(path.join(staticRoot, 'build/app.js'));
    const manifest = await fs.readFile(path.join(source, 'package.json'));
    const existing = await fs.readFile(path.join(context.root, 'package.json'));
    if (!manifest.equals(existing))
      await installPanelDependencies(context, source);
    // Publish a marker only after both archives and dependency installation succeed.
    await fs.writeFile(
      path.join(workspace, 'ready.json'),
      JSON.stringify({ source, static: staticRoot }),
      { flag: 'wx', mode: 0o600 },
    );
    const pointer = path.join(workspace, 'pointer.json');
    await fs.writeFile(
      pointer,
      JSON.stringify({ directory: path.basename(workspace) }),
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
    await fs.rename(
      pointer,
      path.join(context.paths.dir_tmp!, `upgrade-ready-${branch}.json`),
    );
    return { source, static: staticRoot };
  } catch (error) {
    await fs.rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

async function selectedUpgrade(
  context: LocalContext,
): Promise<{ source: string; static: string }> {
  const branch = releaseBranch(context);
  const fallback = {
    source: path.join(context.paths.dir_tmp!, `qinglong-${branch}`),
    static: path.join(context.paths.dir_tmp!, `qinglong-static-${branch}`),
  };
  const pointer = await fs
    .readFile(
      path.join(context.paths.dir_tmp!, `upgrade-ready-${branch}.json`),
      'utf8',
    )
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
  if (pointer === undefined) return fallback;
  const directory: unknown = JSON.parse(pointer)?.directory;
  if (
    typeof directory !== 'string' ||
    !/^upgrade-[A-Za-z0-9_-]+$/.test(directory)
  )
    throw new Error(translate(context.env, '暂存升级指针无效。'));
  const workspace = path.join(context.paths.dir_tmp!, directory);
  const selected = {
    source: path.join(workspace, `qinglong-${branch}`),
    static: path.join(workspace, `qinglong-static-${branch}`),
  };
  for (const location of [workspace, selected.source, selected.static]) {
    const stat = await fs.lstat(location);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(translate(context.env, '暂存升级目录无效。'));
  }
  const ready = JSON.parse(
    await fs.readFile(path.join(workspace, 'ready.json'), 'utf8'),
  );
  if (ready?.source !== selected.source || ready?.static !== selected.static)
    throw new Error(translate(context.env, '暂存升级就绪记录与目录不匹配。'));
  return selected;
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
  await fs.access(path.join(source, 'package.json'));
  await fs.access(path.join(staticRoot, 'build/app.js'));
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
    return await replaceAndReload(context, replacements);
  } finally {
    if (selection)
      await fs.rm(selection.directory, { recursive: true, force: true });
  }
}
