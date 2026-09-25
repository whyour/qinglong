#!/usr/bin/env node
import { translate } from './i18n';
import { standaloneHelp } from './i18n/standalone';
import { withCommandCancellation, interruptedCode } from './local/cancellation';
import { CliError, fail } from './errors';

export interface CompatibilityRoute {
  surface: 'local' | 'subscription';
  args: string[];
}

export function compatibilityRoute(input: string[]): CompatibilityRoute {
  const args = input[0] === '-l' ? input.slice(1) : [...input];
  const [action, ...values] = args;
  if (action === 'repo' || action === 'raw')
    return { surface: 'subscription', args };
  if (action === 'update') {
    if (
      values.length > 1 ||
      (values.length && !['true', 'false'].includes(values[0]!))
    )
      fail(translate(process.env, '用法：ql-compat update [true|false]'), 2);
    return {
      surface: 'local',
      args: ['update', ...(values[0] === 'false' ? ['--download-only'] : [])],
    };
  }
  if (action === 'reload') {
    if (
      values.length > 1 ||
      (values.length && !['services', 'system', 'data'].includes(values[0]!))
    )
      fail(
        translate(process.env, '用法：ql-compat reload [services|system|data]'),
        2,
      );
    return {
      surface: 'local',
      args: ['reload', '--target', values[0] || 'services'],
    };
  }
  if (
    action &&
    [
      'rmlog',
      'extra',
      'bot',
      'check',
      'resetlet',
      'resettfa',
      'resetpwd',
      'resetname',
    ].includes(action)
  ) {
    // A legacy positional value beginning with '-' is data, never a CLI option.
    return { surface: 'local', args: [action, '--', ...values] };
  }
  fail(translate(process.env, '未知旧命令，请运行 ql-compat --help。'), 2);
}

export async function compatibilityMain(
  args = process.argv.slice(2),
): Promise<number> {
  return withCommandCancellation(async (signal) => {
    try {
      if (
        !args.length ||
        (args.length === 1 && ['--help', '-h'].includes(args[0]!))
      ) {
        process.stdout.write(standaloneHelp('compat'));
        return 0;
      }
      const route = compatibilityRoute(args);
      if (route.surface === 'subscription') {
        const { subscriptionWorker } = await import('./subscription-worker');
        return subscriptionWorker(route.args);
      }
      const { parse } = await import('./arguments');
      const { localContext } = await import('./local/context');
      const { maintenance } = await import('./local/maintenance');
      const { loggedOperation } = await import('./local/commandLog');
      const command = parse(route.args, 'local');
      const context = await localContext(command, { signal });
      const { result, logPath } = await loggedOperation(
        context,
        route.args[0]!,
        () => maintenance(command, context),
        signal,
      );
      process.stdout.write(
        JSON.stringify({ code: 200, data: result, logPath }) + '\n',
      );
      return 0;
    } catch (error) {
      const code =
        interruptedCode(signal) ??
        (error instanceof CliError ? error.exitCode : 1);
      process.stderr.write(
        JSON.stringify({
          code,
          message: signal.aborted
            ? translate(process.env, '命令已中断。')
            : error instanceof CliError
            ? error.message
            : translate(process.env, '旧命令适配器执行失败。'),
        }) + '\n',
      );
      return code;
    }
  });
}

if (require.main === module)
  void compatibilityMain().then((code) => {
    process.exitCode = code;
  });
