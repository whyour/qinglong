import { translate } from '../i18n';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { LocalContext } from './context';
import { checkedProcess } from './process';
import { replaceAndReload } from './upgrade';

export function botSystemPackages(
  os: string,
  environment: NodeJS.ProcessEnv = process.env,
): {
  program: string;
  args: string[];
} {
  if (os === 'alpine')
    return {
      program: 'apk',
      args: [
        '--no-cache',
        'add',
        '-f',
        'zlib-dev',
        'gcc',
        'jpeg-dev',
        'python3-dev',
        'musl-dev',
        'freetype-dev',
      ],
    };
  if (os === 'debian' || os === 'ubuntu')
    return {
      program: 'apt-get',
      args: [
        'install',
        '-y',
        'gcc',
        'python3-dev',
        'musl-dev',
        'zlib1g-dev',
        'libjpeg-dev',
        'libfreetype-dev',
      ],
    };
  throw new Error(
    translate(environment, 'Bot 安装不支持此操作系统：%s。', os || 'unknown'),
  );
}

export async function operatingSystem(context: LocalContext): Promise<string> {
  if (context.env.QL_OS_TYPE) return context.env.QL_OS_TYPE;
  const release = await fs.readFile('/etc/os-release', 'utf8').catch(() => '');
  return release.match(/^ID=["']?([a-zA-Z0-9_-]+)["']?\s*$/m)?.[1] ?? '';
}

// Validate source links before copying: bot-owned links must stay inside its tree.
async function validateBotTree(
  root: string,
  environment: NodeJS.ProcessEnv,
  boundary = root,
): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await validateBotTree(file, environment, boundary);
    else if (entry.isSymbolicLink()) {
      const relative = path.relative(
        await fs.realpath(boundary),
        await fs.realpath(file),
      );
      if (
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error(
          translate(environment, 'Bot 仓库包含指向目录外部的符号链接。'),
        );
    } else if (!entry.isFile())
      throw new Error(translate(environment, 'Bot 仓库包含不支持的文件类型。'));
  }
}

export async function prepareBot(context: LocalContext): Promise<{
  repository: string;
  staged: string;
  requirements: string;
  config: string;
}> {
  const packages = botSystemPackages(
    await operatingSystem(context),
    context.env,
  );
  const privileged = process.getuid?.() === 0;
  await checkedProcess(
    privileged ? packages.program : 'sudo',
    privileged ? packages.args : [packages.program, ...packages.args],
    { cwd: context.root, env: context.env },
  );
  await fs.mkdir(context.paths.dir_repo!, { recursive: true });
  await fs.mkdir(context.data, { recursive: true });
  await fs.mkdir(context.paths.dir_config!, { recursive: true });
  const repository = path.join(
    context.paths.dir_repo!,
    context.env.BotRepoUrl ? 'diybot' : 'dockerbot',
  );
  const url = context.env.BotRepoUrl || 'https://github.com/SuMaiKaDe/bot.git';
  const git = await fs
    .stat(path.join(repository, '.git'))
    .catch(() => undefined);
  if (!git?.isDirectory()) {
    const temp = await fs.mkdtemp(
      path.join(context.paths.dir_repo!, '.bot-clone-'),
    );
    try {
      await checkedProcess(
        'git',
        [
          'clone',
          '--depth=1',
          '--branch',
          'main',
          '--',
          url,
          path.join(temp, 'repository'),
        ],
        { cwd: context.root, env: context.env },
      );
      await fs.access(path.join(temp, 'repository/jbot/requirements.txt'));
      const backup = `${repository}.previous-${randomUUID()}`;
      const exists = !!(await fs.lstat(repository).catch(() => undefined));
      if (exists) await fs.rename(repository, backup);
      try {
        await fs.rename(path.join(temp, 'repository'), repository);
      } catch (error) {
        if (exists) await fs.rename(backup, repository);
        throw error;
      }
      if (exists) await fs.rm(backup, { recursive: true, force: true });
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  const source = path.join(repository, 'jbot');
  if (!(await fs.lstat(source)).isDirectory())
    throw new Error(translate(context.env, 'Bot 源必须为普通目录。'));
  await validateBotTree(source, context.env);
  const staged = await fs.mkdtemp(path.join(context.data, '.bot-stage-'));
  try {
    await fs.cp(source, path.join(staged, 'jbot'), {
      recursive: true,
      verbatimSymlinks: true,
    });
    const requirements = path.join(staged, 'jbot/requirements.txt');
    const config = path.join(repository, 'config/bot.json');
    if (!(await fs.lstat(config)).isFile())
      throw new Error(translate(context.env, 'Bot 配置模板必须为普通文件。'));
    await checkedProcess(
      'pip3',
      ['--default-timeout=100', 'install', '-r', requirements],
      { cwd: context.data, env: context.env },
    );
    return { repository, staged, requirements, config };
  } catch (error) {
    await fs.rm(staged, { recursive: true, force: true });
    throw error;
  }
}

export async function stopBot(context: LocalContext): Promise<void> {
  // Supported installations are Linux. Match cwd as well as argv so another
  // QingLong instance's Telegram bot is never selected by a global pkill.
  if (process.platform !== 'linux')
    throw new Error(translate(context.env, 'Bot 进程管理需要 Linux。'));
  const cwd = await fs.realpath(context.data);
  for (const pid of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      const args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8'))
        .split('\0')
        .filter(Boolean);
      if (
        !/^python3(?:\.\d+)?$/.test(path.basename(args[0] ?? '')) ||
        args[1] !== '-m' ||
        args[2] !== 'jbot'
      )
        continue;
      if ((await fs.realpath(`/proc/${pid}/cwd`)) !== cwd) continue;
      // Legacy script used SIGKILL; retain deterministic stop before replacement.
      process.kill(Number(pid), 'SIGKILL');
    } catch (error) {
      if (
        !['ENOENT', 'ESRCH', 'EACCES'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
    }
  }
}

export async function launchBot(
  context: LocalContext,
): Promise<{ pid: number }> {
  const directory = path.join(context.paths.dir_log!, 'bot');
  await fs.mkdir(directory, { recursive: true });
  const log = await fs.open(path.join(directory, 'nohup.log'), 'w', 0o600);
  try {
    const child = spawn('python3', ['-m', 'jbot'], {
      cwd: context.data,
      env: context.env,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    await new Promise<void>((resolve, reject) => {
      const failed = (code: number | null) => {
        clearTimeout(timer);
        reject(
          new Error(translate(context.env, 'Bot 在启动期间退出（%s）。', code)),
        );
      };
      const timer = setTimeout(() => {
        child.removeListener('exit', failed);
        resolve();
      }, 1000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', failed);
    });
    child.unref();
    return { pid: child.pid! };
  } finally {
    await log.close();
  }
}

export async function installAndStartBot(
  context: LocalContext,
  lifecycle = { stop: stopBot, start: launchBot },
): Promise<unknown> {
  if (lifecycle.stop === stopBot && process.platform !== 'linux')
    throw new Error(translate(context.env, 'Bot 安装和进程管理需要 Linux。'));
  const prepared = await prepareBot(context);
  try {
    const config = path.join(context.paths.dir_config!, 'bot.json');
    try {
      await fs.copyFile(prepared.config, config, fs.constants.COPYFILE_EXCL);
      await fs.chmod(config, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const result = await replaceAndReload(
      context,
      [
        {
          source: path.join(prepared.staged, 'jbot'),
          target: path.join(context.data, 'jbot'),
        },
        {
          source: prepared.requirements,
          target: path.join(context.data, 'requirements.txt'),
        },
      ],
      lifecycle,
    );
    return { repository: prepared.repository, result };
  } finally {
    await fs.rm(prepared.staged, { recursive: true, force: true });
  }
}
