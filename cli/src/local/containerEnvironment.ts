import { translate } from '../i18n';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './process';
import { fail } from '../errors';

export interface ContainerEnvironmentOptions {
  root: string;
  data: string;
  env: NodeJS.ProcessEnv;
  systemDirectory?: string;
}

async function writableDirectory(directory: string): Promise<boolean> {
  try {
    if (!(await fs.stat(directory)).isDirectory()) return false;
    await fs.access(directory, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function requireContainerDirectory(
  directory: string,
  recursive: boolean,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (await writableDirectory(directory)) return;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined && gid !== undefined && uid !== 0) {
    await runProcess(
      'chown',
      [...(recursive ? ['-R'] : []), `${uid}:${gid}`, directory],
      { env, capture: true, stderrOutput: () => {} },
    ).catch(() => undefined);
    if (await writableDirectory(directory)) return;
  }
  fail(
    translate(
      env,
      '容器目录不可写或不可访问：%s（UID %s）。请检查挂载目录的所有者和权限。',
      directory,
      uid ?? 'unknown',
    ),
  );
}

async function appendNetworkEntries(
  filename: string,
  entries: { matches: (line: string) => boolean; value: string }[],
  warnings: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    let content: string;
    try {
      content = await fs.readFile(filename, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      content = '';
    }
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.split('#', 1)[0]!.trim());
    const missing = entries.filter((entry) => !lines.some(entry.matches));
    if (!missing.length) return;
    // Append in place: Docker may mount these files individually, so rename
    // based replacement would fail with EBUSY. Keep existing administrator data.
    await fs.appendFile(
      filename,
      `${content && !content.endsWith('\n') ? '\n' : ''}${missing
        .map((entry) => entry.value)
        .join('\n')}\n`,
    );
  } catch (error) {
    warnings.push(
      translate(
        env,
        '无法初始化 %s：%s',
        filename,
        (error as NodeJS.ErrnoException).code ?? 'IO_ERROR',
      ),
    );
  }
}

/** Container-only preparation; no package installation or service startup. */
export async function prepareContainerEnvironment(
  options: ContainerEnvironmentOptions,
): Promise<{ env: NodeJS.ProcessEnv; warnings: string[] }> {
  const { root, data } = options;
  if (!path.isAbsolute(root) || !path.isAbsolute(data))
    fail(translate(options.env, '容器安装目录和数据目录必须为绝对路径。'), 2);
  const env = { ...options.env };
  await requireContainerDirectory(root, true, env);
  await requireContainerDirectory(data, false, env);
  // Do not create probes inside a user volume, or remove an existing .tmp.
  if (!env.HOME || !(await writableDirectory(env.HOME))) {
    env.HOME = path.join(root, '.tmp');
    await fs.mkdir(env.HOME, { recursive: true });
    await requireContainerDirectory(env.HOME, false, env);
  }
  const warnings: string[] = [];
  const system = options.systemDirectory ?? '/etc';
  const alpine = await fs.stat(path.join(system, 'alpine-release')).then(
    () => true,
    () => false,
  );
  if (alpine)
    await appendNetworkEntries(
      path.join(system, 'resolv.conf'),
      [
        {
          matches: (line) =>
            /^options\s/.test(line) && line.split(/\s+/).includes('ndots:0'),
          value: 'options ndots:0',
        },
      ],
      warnings,
      env,
    );
  await appendNetworkEntries(
    path.join(system, 'hosts'),
    [
      {
        matches: (line) =>
          /^127\.0\.0\.1\s/.test(line) &&
          line.split(/\s+/).slice(1).includes('localhost'),
        value: '127.0.0.1 localhost',
      },
      {
        matches: (line) =>
          /^::1\s/.test(line) &&
          line.split(/\s+/).slice(1).includes('localhost'),
        value: '::1 localhost ip6-localhost ip6-loopback',
      },
    ],
    warnings,
    env,
  );
  return { env, warnings };
}
