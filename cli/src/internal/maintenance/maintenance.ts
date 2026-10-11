import fs from 'node:fs/promises';
import path from 'node:path';
import type { Invocation } from '../../shared/cli/arguments';
import { localContext, type LocalContext } from '../runtime/context';
import { LocalApi } from '../runtime/api';
import { regularFiles } from '../runtime/files';
import { checkedProcess } from '../runtime/process';

export async function pruneLogs(
  context: LocalContext,
  days: number,
): Promise<{ removed: string[]; retained: string[] }> {
  const api = new LocalApi(context);
  const root = context.paths.dir_log!;
  const removed: string[] = [],
    retained: string[] = [];
  for (const relative of await regularFiles(root)) {
    if (!relative.endsWith('.log')) continue;
    const file = path.join(root, relative);
    const datePart = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    const modified = datePart
      ? new Date(`${datePart}T00:00:00`)
      : (await fs.stat(file)).mtime;
    // Legacy Linux retention compares calendar dates, including undated logs.
    const age = modified.setHours(0, 0, 0, 0);
    if (!Number.isFinite(age) || Date.now() - age <= days * 86400000) continue;
    const response = await api.call(
      `crons/detail?${new URLSearchParams({ log_path: relative })}`,
    );
    if (response.data) {
      retained.push(relative);
      continue;
    }
    await fs.unlink(file);
    removed.push(relative);
  }
  for (const entry of await fs
    .readdir(root, { withFileTypes: true })
    .catch(() => [])) {
    if (entry.isDirectory())
      await fs
        .rmdir(path.join(root, entry.name))
        .catch((error: NodeJS.ErrnoException) => {
          if (!['ENOTEMPTY', 'ENOENT'].includes(error.code ?? '')) throw error;
        });
  }
  return { removed, retained };
}

export async function maintenance(
  command: Invocation,
  prepared?: LocalContext,
): Promise<unknown> {
  const context = prepared ?? (await localContext(command));
  const action = command.name.split(' ')[1];
  if (action === 'start') {
    const { bootstrapPanel } = await import('./bootstrap');
    return bootstrapPanel(context, command.values.reload === true, undefined, {
      registerStartup: command.values['no-startup'] !== true,
    });
  }
  if (action === 'bot') {
    const { installAndStartBot } = await import('./bot');
    return installAndStartBot(context);
  }
  if (action === 'check') {
    const { checkAndRepair } = await import('./check');
    return checkAndRepair(context);
  }
  if (action === 'repair-config') {
    const { repairConfiguration } = await import('./operator');
    return { restored: await repairConfiguration(context) };
  }
  if (action === 'reload' || action === 'update') {
    const { reloadPanel, stageUpgrade } = await import('./upgrade');
    if (action === 'reload')
      return reloadPanel(
        context,
        command.values.target as 'services' | 'system' | 'data',
      );
    const { repairConfiguration } = await import('./operator');
    await repairConfiguration(context);
    const staged = await stageUpgrade(
      context,
      command.values.mirror as 'github' | 'gitee',
    );
    return command.values['download-only']
      ? { staged }
      : { staged, result: await reloadPanel(context, 'system', staged) };
  }
  if (action === 'rmlog')
    return pruneLogs(context, Number(command.positionals[0]));
  if (action === 'extra') {
    const file = context.paths.file_extra_shell!;
    if (!(await fs.stat(file).catch(() => undefined))?.isFile())
      return { skipped: true, reason: 'extra.sh is absent' };
    await checkedProcess(
      'bash',
      ['--noprofile', '--norc', '-c', '. "$1"', 'ql-extra', file],
      { cwd: context.root, env: context.env },
    );
    return { completed: true };
  }
  const payload =
    action === 'resetlet'
      ? { retries: 0 }
      : action === 'resettfa'
      ? { twoFactorActivated: false }
      : action === 'resetpwd'
      ? { password: command.positionals[0] }
      : { username: command.positionals[0] };
  await new LocalApi(context).call('system/auth/reset', 'PUT', payload);
  return { action, completed: true };
}
