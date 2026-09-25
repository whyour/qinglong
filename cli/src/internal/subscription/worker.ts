#!/usr/bin/env node
import { translate } from '../../shared/i18n/index';
import { standaloneHelp } from '../help/standalone';
import { withCommandCancellation, interruptedCode } from '../runtime/cancellation';
import { localContext } from '../runtime/context';
import {
  syncRaw,
  syncRepository,
  type SubscriptionInput,
} from './subscriptionRunner';
import { CliError, fail } from '../../shared/errors';
import { loggedOperation } from '../runtime/commandLog';

// Compatibility worker for the existing backend SUB_ID=... ql repo/raw contract.
// This is intentionally not registered in the public panel management CLI.
export async function subscriptionWorker(
  args = process.argv.slice(2),
): Promise<number> {
  return withCommandCancellation(async (signal) => {
    try {
      if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
        process.stdout.write(standaloneHelp('worker'));
        return 0;
      }
      const [kind, url, ...options] = args;
      if (!['repo', 'raw'].includes(kind ?? '') || !url)
        fail(
          translate(
            process.env,
            '用法：ql-subscription-worker repo|raw <url> [旧订阅参数]',
          ),
          2,
        );
      const bool = (value?: string) => {
        if (value === undefined || value === '') return undefined;
        if (!['true', 'false'].includes(value))
          fail(
            translate(
              process.env,
              '订阅布尔参数无效，只能使用 true 或 false。',
            ),
            2,
          );
        return value === 'true';
      };
      if (options.length > (kind === 'repo' ? 8 : 3))
        fail(translate(process.env, '订阅参数过多。'), 2);
      const input: SubscriptionInput =
        kind === 'repo'
          ? {
              url,
              include: options[0],
              exclude: options[1],
              dependencies: options[2],
              branch: options[3],
              extensions: options[4],
              proxy: options[5],
              autoAdd: bool(options[6]),
              autoDelete: bool(options[7]),
            }
          : {
              url,
              proxy: options[0],
              autoAdd: bool(options[1]),
              autoDelete: bool(options[2]),
            };
      if (process.env.SUB_ID) {
        const id = Number(process.env.SUB_ID);
        if (!Number.isSafeInteger(id) || id <= 0)
          fail(translate(process.env, 'SUB_ID 无效，必须为正整数。'), 2);
        input.subscriptionId = id;
      }
      const context = await localContext(
        { values: {}, positionals: args },
        { signal },
      );
      const { result, logPath } = await loggedOperation(
        context,
        kind!,
        () =>
          kind === 'repo'
            ? syncRepository(context, input)
            : syncRaw(context, input),
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
            : translate(process.env, '订阅执行器失败，请检查本机日志。'),
        }) + '\n',
      );
      return code;
    }
  });
}

if (require.main === module)
  void subscriptionWorker().then((code) => {
    process.exitCode = code;
  });
