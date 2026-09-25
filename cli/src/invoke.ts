import { parse } from './arguments';
import { translate } from './i18n';
import { CliError } from './errors';
import type { Invocation } from './arguments';
import type { CommandSurface } from './framework/registry';

export async function invoke(
  args: string[],
  surface: CommandSurface,
  dispatch: (command: Invocation) => Promise<unknown>,
  signal?: AbortSignal,
  interruptionCode?: () => number | undefined,
): Promise<number> {
  let json = args
    .slice(0, args.indexOf('--') < 0 ? undefined : args.indexOf('--'))
    .includes('--json');
  try {
    const command = parse(args, surface);
    json = command.json;
    if (command.help) {
      process.stdout.write(
        (json
          ? JSON.stringify({ code: 200, data: { help: command.help } })
          : command.help) + '\n',
      );
      return 0;
    }
    const result = await dispatch(command);
    signal?.throwIfAborted();
    process.stdout.write(JSON.stringify(result, null, json ? 0 : 2) + '\n');
    return 0;
  } catch (error) {
    const cancelled = signal?.aborted;
    const code = cancelled
      ? (interruptionCode?.() ?? 1)
      : error instanceof CliError
      ? error.exitCode
      : 1;
    const message = cancelled
      ? translate(process.env, 'CLI 操作已取消。')
      : error instanceof CliError
      ? error.message
      : translate(process.env, 'CLI 操作失败，请检查本机配置和权限。');
    process.stderr.write(
      (json ? JSON.stringify({ code, message }) : message) + '\n',
    );
    return code;
  }
}
