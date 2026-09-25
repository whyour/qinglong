import { translate } from '../i18n';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import type { LocalContext } from './context';
import { LocalApi } from './api';
import { checkedProcess } from './process';
import { regularFiles, within } from './files';
import { isRecord } from '../api/client';
import { fail } from '../errors';
import { operationOutput } from './output';
import { matchSubscriptionPaths } from './subscriptionFilter';

export interface SubscriptionInput {
  url: string;
  branch?: string;
  include?: string;
  exclude?: string;
  dependencies?: string;
  extensions?: string;
  proxy?: string;
  autoAdd?: boolean;
  autoDelete?: boolean;
  subscriptionId?: number;
}

export function repositoryName(
  url: string,
  branch?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const normalized = url.replace(/\/$/, '');
  const last = normalized.lastIndexOf('/');
  const base = normalized.slice(last + 1).replace(/\.[^.]*$/, '');
  const owner = normalized
    .slice(0, last)
    .split('/')
    .at(-1)!
    .split(':')
    .at(-1)!
    .split('.')
    .at(-1)!;
  const result = `${owner}_${base}${branch ? '_' + branch : ''}`;
  if (
    !result ||
    result.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\0\r\n]/.test(result)
  )
    fail(translate(environment, '仓库路径无效。'), 2);
  return result;
}

export function cronMetadata(
  contents: string,
  filename: string,
  fallback: string,
): { name: string; schedule: string } {
  const name =
    contents.match(/new\s+Env\(\s*['"]([^'"\r\n]+)['"]/)?.[1] ||
    contents.match(/^\s*(?:#\s*)?name:\s*(.+)$/m)?.[1]?.trim() ||
    path.basename(filename);
  const explicit =
    contents
      .match(/\bcron:\s*([^\r\n]+)/)?.[1]
      ?.replace(/["',]+$/, '')
      .trim() || contents.match(/\bcron\s+["']([^"']+)["']/)?.[1];
  // Legacy add_cron selects a filename-bearing expression before annotations,
  // deduplicates/sorts the matches, and takes the first expression.
  const matching = contents
    .split('\n')
    .filter((item) => item.includes(path.basename(filename)))
    .map((item) =>
      item
        .match(
          /(?:[\d*](?:[\d*/,-]*[\d*])?\s+){4,5}[\d*](?:[\d*/,-]*[\d*])?/,
        )?.[0]
        ?.trim(),
    )
    .filter((value): value is string => !!value);
  const schedule = [...new Set(matching)].sort()[0] || explicit || fallback;
  return { name, schedule };
}

function taskPath(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined;
  const match = command.match(
    /^task\s+(?:'((?:[^']|'\\'')*)'|"([^"\n]*)"|(\S+))/,
  );
  return match
    ? match[1]?.replace(/'\\''/g, "'") ?? match[2] ?? match[3]
    : undefined;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function copyRegular(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rm(destination, { force: true });
  await fs.copyFile(source, destination);
}

export async function replaceDirectory(
  staged: string,
  destination: string,
): Promise<void> {
  const backup = `${destination}.${randomUUID()}.previous`;
  const incoming = `${destination}.${randomUUID()}.incoming`;
  let moved = false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    try {
      await fs.rename(staged, incoming);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await fs.cp(staged, incoming, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      });
    }
    try {
      await fs.rename(destination, backup);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.rename(incoming, destination);
  } catch (error) {
    if (moved) await fs.rename(backup, destination);
    throw error;
  } finally {
    await fs.rm(incoming, { force: true, recursive: true });
  }
  if (moved) await fs.rm(backup, { force: true, recursive: true });
}

async function reconcile(
  context: LocalContext,
  input: SubscriptionInput,
  namespace: string,
  paths: string[],
): Promise<{ added: number; removed: number }> {
  const autoAdd = input.autoAdd ?? context.env.AutoAddCron === 'true';
  const autoDelete = input.autoDelete ?? context.env.AutoDelCron === 'true';
  if (!autoAdd && !autoDelete) return { added: 0, removed: 0 };
  const api = new LocalApi(context);
  const response = await api.call('crons');
  if (!isRecord(response.data) || !Array.isArray(response.data.data))
    fail(translate(context.env, '订阅任务同步返回了无效任务列表。'));
  const scoped = response.data.data.filter(
    (row): row is Record<string, unknown> =>
      isRecord(row) &&
      typeof row.id === 'number' &&
      Number.isSafeInteger(row.id) &&
      row.id > 0 &&
      (input.subscriptionId === undefined ||
        row.sub_id === input.subscriptionId) &&
      (() => {
        const file = taskPath(row.command);
        if (!file || file.includes('\\') || path.posix.normalize(file) !== file)
          return false;
        return namespace.endsWith('/')
          ? file.startsWith(namespace)
          : file === namespace;
      })(),
  );
  const existing = new Set(scoped.map((row) => taskPath(row.command)));
  const expected = new Set(paths);
  const obsolete = scoped.filter(
    (row) => !expected.has(taskPath(row.command)!),
  );
  let added = 0,
    removed = 0;
  if (autoAdd) {
    for (const relative of paths) {
      if (existing.has(relative)) continue;
      const contents = await fs.readFile(
        within(context.paths.dir_scripts!, relative, context.env),
        'utf8',
      );
      const fallback =
        context.env.DefaultCronRule ||
        `${randomInt(0, 59)} ${randomInt(0, 23)} * * *`;
      const meta = cronMetadata(contents, relative, fallback);
      await api.call('crons', 'POST', {
        ...meta,
        command: `task ${
          /^[\w./-]+$/.test(relative) ? relative : quote(relative)
        }`,
        sub_id: input.subscriptionId ?? null,
      });
      added++;
    }
  }
  if (autoDelete && obsolete.length) {
    await api.call(
      'crons',
      'DELETE',
      obsolete.map((row) => row.id),
    );
    for (const row of obsolete) {
      await fs.rm(
        within(context.paths.dir_scripts!, taskPath(row.command)!, context.env),
        {
          force: true,
        },
      );
      removed++;
    }
  }
  if (added || removed) {
    try {
      await api.call('system/notify', 'PUT', {
        title: `${namespace} 订阅同步`,
        content: `新增 ${added} 个任务，删除 ${removed} 个任务`,
      });
    } catch {
      operationOutput(
        Buffer.from(
          translate(
            context.env,
            '订阅同步已完成，但通知发送失败，请检查面板通知设置。\n',
          ),
        ),
      );
    }
  }
  return { added, removed };
}

export async function syncRepository(
  context: LocalContext,
  input: SubscriptionInput,
): Promise<unknown> {
  const name = repositoryName(input.url, input.branch, context.env);
  const destination = within(context.paths.dir_scripts!, name, context.env);
  const repoDestination = within(context.paths.dir_repo!, name, context.env);
  const extensions = (
    input.extensions ||
    context.env.RepoFileExtensions ||
    'js py'
  )
    .split(/[|\s]+/)
    .filter(Boolean);
  await fs.mkdir(context.paths.dir_tmp!, { recursive: true });
  const stage = await fs.mkdtemp(
    path.join(context.paths.dir_tmp!, 'subscription-'),
  );
  const checkout = path.join(stage, 'checkout'),
    scripts = path.join(stage, 'scripts');
  try {
    const env = { ...context.env };
    const proxy = input.proxy || env.ProxyUrl;
    if (proxy) {
      env.http_proxy = proxy;
      env.https_proxy = proxy;
    }
    await checkedProcess(
      'git',
      [
        'clone',
        '-q',
        '--depth=1',
        ...(input.branch ? ['--branch', input.branch] : []),
        '--',
        input.url,
        checkout,
      ],
      { env, cwd: context.root },
    );
    const candidates = (await regularFiles(checkout)).filter(
      (file) =>
        !file.split(path.sep).includes('.git') &&
        extensions.includes(path.extname(file).slice(1)),
    );
    const included = await matchSubscriptionPaths(
      candidates,
      input.include,
      stage,
      env,
    );
    const excluded = input.exclude
      ? await matchSubscriptionPaths(candidates, input.exclude, stage, env)
      : new Set<string>();
    const dependencies = input.dependencies
      ? await matchSubscriptionPaths(candidates, input.dependencies, stage, env)
      : new Set<string>();
    const selected = candidates.filter(
      (file) => included.has(file) && !excluded.has(file),
    );
    await fs.mkdir(scripts);
    // Retain previous files unless task reconciliation explicitly removes them.
    for (const file of await regularFiles(destination))
      await copyRegular(
        path.join(destination, file),
        within(scripts, file, context.env),
      );
    for (const key of ['file_notify_js', 'file_notify_py']) {
      const source = context.paths[key]!;
      if ((await fs.stat(source).catch(() => undefined))?.isFile())
        await copyRegular(source, path.join(scripts, path.basename(source)));
    }
    // Preserve gen_list_repo precedence: notification defaults, repository
    // dependencies, local dependency overrides, then selected task scripts.
    for (const file of candidates.filter((file) => dependencies.has(file)))
      await copyRegular(
        path.join(checkout, file),
        within(scripts, file, context.env),
      );
    for (const file of await regularFiles(context.paths.dir_dep!))
      await copyRegular(
        path.join(context.paths.dir_dep!, file),
        within(scripts, file, context.env),
      );
    for (const file of selected)
      await copyRegular(
        path.join(checkout, file),
        within(scripts, file, context.env),
      );
    await replaceDirectory(scripts, destination);
    await replaceDirectory(checkout, repoDestination);
    const relativePaths = selected.map((file) =>
      path.posix.join(name, file.split(path.sep).join('/')),
    );
    const changes = await reconcile(context, input, `${name}/`, relativePaths);
    return { repository: name, files: relativePaths, ...changes };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function syncRaw(
  context: LocalContext,
  input: SubscriptionInput,
): Promise<unknown> {
  const url = new URL(input.url);
  if (!['http:', 'https:'].includes(url.protocol))
    fail(translate(context.env, '单文件订阅需要 HTTP(S) 地址。'), 2);
  const name =
    repositoryName(input.url, undefined, context.env) +
    path.extname(url.pathname);
  const raw = within(context.paths.dir_raw!, name, context.env);
  const relative = `raw_${name}`;
  await fs.mkdir(path.dirname(raw), { recursive: true });
  const temporary = `${raw}.${randomUUID()}.tmp`;
  try {
    const env = { ...context.env };
    const proxy = input.proxy || env.ProxyUrl;
    if (proxy) {
      env.http_proxy = proxy;
      env.https_proxy = proxy;
    }
    await checkedProcess(
      'curl',
      [
        '--fail',
        '--netrc-optional',
        '--location',
        '--silent',
        '--show-error',
        '--output',
        temporary,
        '--url',
        input.url,
      ],
      { env, timeoutMs: 120000 },
    );
    await fs.rename(temporary, raw);
    await copyRegular(
      raw,
      within(context.paths.dir_scripts!, relative, context.env),
    );
    const changes = await reconcile(
      context,
      { ...input, autoDelete: false },
      relative,
      [relative],
    );
    return { file: relative, ...changes };
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
