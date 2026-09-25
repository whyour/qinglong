import type { LocalContext } from './context';
import { executableAvailable } from './operator';
import { checkedProcess } from './process';
import { fail } from '../errors';
import { translate } from '../i18n';

export async function registerHostServices(
  context: LocalContext,
  os: string,
): Promise<void> {
  const options = { cwd: context.root, env: context.env };
  const run = (program: string, args: string[]) =>
    checkedProcess(
      process.getuid?.() === 0 ? program : 'sudo',
      process.getuid?.() === 0 ? args : [program, ...args],
      options,
    );
  if (await executableAvailable('rc-update', context.env)) {
    for (const name of ['nginx', 'crond']) {
      await run('rc-update', ['add', name, 'default']);
      // Bootstrap already started/reloaded nginx directly. Starting it again
      // through init cannot adopt that PID and can fail or compete for its port.
      if (name === 'crond') await run('rc-service', [name, 'start']);
    }
    return;
  }
  if (
    ['debian', 'ubuntu'].includes(os) &&
    (await executableAvailable('systemctl', context.env))
  ) {
    // Minimal Debian/Ubuntu installations need not contain a cron daemon.
    await run('apt-get', ['install', '-y', 'cron']);
    await run('systemctl', ['enable', 'nginx']);
    await run('systemctl', ['enable', '--now', 'cron']);
    return;
  }
  fail(
    translate(
      context.env,
      '主机开机注册需要 OpenRC 或 systemd；仅在其他管理器负责服务时使用 --no-startup。',
    ),
    2,
  );
}
