import { translate } from '../i18n';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { LocalContext } from './context';
import { checkedProcess, runProcess } from './process';
import { repairConfiguration, startPanel } from './operator';
import { operatingSystem } from './bot';
import { fail } from '../errors';
import { registerHostServices } from './hostServices';

export function bootstrapPackages(
  os: string,
  environment: NodeJS.ProcessEnv = process.env,
): {
  program: string;
  calls: string[][];
} {
  if (os === 'alpine')
    return {
      program: 'apk',
      calls: [
        ['update'],
        [
          'add',
          '-f',
          'bash',
          'coreutils',
          'git',
          'curl',
          'wget',
          'tzdata',
          'perl',
          'openssl',
          'jq',
          'nginx',
          'openssh',
          'procps',
          'netcat-openbsd',
        ],
      ],
    };
  if (os === 'debian' || os === 'ubuntu')
    return {
      program: 'apt-get',
      calls: [
        ['update'],
        [
          'install',
          '-y',
          'git',
          'curl',
          'wget',
          'tzdata',
          'perl',
          'openssl',
          'jq',
          'nginx',
          'procps',
          'netcat-openbsd',
          'openssh-client',
        ],
      ],
    };
  fail(
    translate(environment, '不支持此部署操作系统：%s。', os || 'unknown'),
    2,
  );
}

export function runtimeEnvironment(
  context: LocalContext,
  pythonVersion: string,
): NodeJS.ProcessEnv {
  if (!/^\d+\.\d+$/.test(pythonVersion))
    fail(translate(context.env, 'Python 返回了无效版本。'));
  const node = path.join(context.data, 'dep_cache/node');
  const python = path.join(context.data, 'dep_cache/python3');
  return {
    ...context.env,
    PYTHON_SHORT_VERSION: pythonVersion,
    PNPM_HOME: node,
    PYTHON_HOME: python,
    PYTHONUSERBASE: python,
    PIP_CACHE_DIR: path.join(python, 'pip'),
    PATH: [
      context.env.PATH,
      '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      node,
      path.join(python, 'bin'),
    ]
      .filter(Boolean)
      .join(path.delimiter),
    NODE_PATH: [
      '/usr/local/bin',
      '/usr/local/lib/node_modules',
      path.join(node, 'global/5/node_modules'),
    ].join(path.delimiter),
    PYTHONPATH: [
      python,
      path.join(python, `lib/python${pythonVersion}`),
      path.join(python, `lib/python${pythonVersion}/site-packages`),
    ].join(path.delimiter),
  };
}

export async function launchStartupHook(
  context: LocalContext,
  action: 'bot' | 'extra',
): Promise<number> {
  const log = await fs.open(
    path.join(context.paths.dir_log!, `${action}.log`),
    'w',
    0o600,
  );
  try {
    const child = spawn(
      process.execPath,
      [
        path.resolve(__dirname, '../admin.js'),
        action,
        '--root',
        context.root,
        '--data-dir',
        context.data,
        '--json',
      ],
      {
        cwd: context.root,
        env: context.env,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return child.pid!;
  } finally {
    await log.close();
  }
}

export interface BootstrapSystem {
  nginxConfig: string;
  nginxIncludes: string;
  nginxRun: string;
  background: typeof launchStartupHook;
  registerServices?: typeof registerHostServices;
}
const systemDefaults: BootstrapSystem = {
  nginxConfig: '/etc/nginx/nginx.conf',
  nginxIncludes: '/etc/nginx/conf.d',
  nginxRun: '/run/nginx',
  background: launchStartupHook,
};

export async function bootstrapPanel(
  context: LocalContext,
  reload = false,
  system: BootstrapSystem = systemDefaults,
  startupOptions: { registerStartup?: boolean } = {},
): Promise<unknown> {
  const registerStartup = startupOptions.registerStartup !== false;
  if (path.basename(context.data) !== 'data')
    fail(translate(context.env, '启动需要以 /data 结尾的绝对数据目录。'), 2);
  const os = await operatingSystem(context);
  const packages = bootstrapPackages(os, context.env);
  if (!reload) {
    const root = process.getuid?.() === 0;
    for (const args of packages.calls)
      await checkedProcess(
        root ? packages.program : 'sudo',
        root ? args : [packages.program, ...args],
        { cwd: context.root, env: context.env },
      );
    await checkedProcess(
      'npm',
      ['install', '-g', 'pnpm@8.3.1', 'pm2', 'ts-node', 'typescript@5'],
      { cwd: context.root, env: context.env },
    );
  }
  const python = await checkedProcess(
    'python3',
    [
      '-c',
      'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")',
    ],
    { cwd: context.root, env: context.env, capture: true },
  );
  const runtime = {
    ...context,
    env: runtimeEnvironment(context, python.stdout.trim()),
  };
  if (!reload)
    await checkedProcess(
      'pip3',
      ['install', '--prefix', runtime.env.PYTHON_HOME!, 'requests'],
      { cwd: runtime.root, env: runtime.env },
    );
  try {
    await fs.copyFile(
      path.join(runtime.root, '.env.example'),
      path.join(runtime.root, '.env'),
      fs.constants.COPYFILE_EXCL,
    );
    await fs.chmod(path.join(runtime.root, '.env'), 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const restored = await repairConfiguration(runtime);
  await fs.mkdir(system.nginxIncludes, { recursive: true });
  await fs.mkdir(system.nginxRun, { recursive: true });
  const options = { cwd: runtime.root, env: runtime.env };
  await checkedProcess('pm2', ['l'], options);
  const nginx = await runProcess(
    'nginx',
    ['-c', system.nginxConfig, '-s', 'reload'],
    options,
  );
  if (nginx.code !== 0)
    await checkedProcess('nginx', ['-c', system.nginxConfig], options);
  const service = await startPanel(runtime);
  const background: { action: string; pid: number }[] = [];
  if (!reload) {
    if (runtime.env.AutoStartBot === 'true')
      background.push({
        action: 'bot',
        pid: await system.background(runtime, 'bot'),
      });
    if (runtime.env.EnableExtraShell === 'true')
      background.push({
        action: 'extra',
        pid: await system.background(runtime, 'extra'),
      });
    if (service.manager === 'pm2') {
      if (registerStartup) {
        await (system.registerServices ?? registerHostServices)(runtime, os);
        await checkedProcess('pm2', ['startup'], options);
      }
      await checkedProcess('pm2', ['save'], options);
    }
  }
  return {
    startup:
      reload || service.manager !== 'pm2'
        ? 'not-requested'
        : registerStartup
        ? 'registered'
        : 'skipped',
    mode: reload ? 'reload' : 'install',
    os,
    restored,
    service,
    background,
  };
}
