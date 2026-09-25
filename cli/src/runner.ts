#!/usr/bin/env node
import { standaloneHelp } from './i18n/standalone';
import { translate } from './i18n';
import { parseFlags, isArgumentError } from './framework/options';
import { createContext, localContext } from './local/context';
import { executeTask, type ExecutionOptions } from './local/taskRunner';
import { CliError, fail } from './errors';
import { cancellationExitCode } from './local/process';
import { commandSignals } from './local/cancellation';

export function parseExecution(args: string[]): {
  values: Record<string, string | boolean | undefined>;
  execution?: ExecutionOptions;
} {
  const schema = {
    root: { type: 'string' },
    'data-dir': { type: 'string' },
    timeout: { type: 'string', short: 'm' },
    log: { type: 'boolean', short: 'l' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } as const;
  let parsed: ReturnType<typeof parseFlags>;
  try {
    // Commander stops parsing at the first positional argument. Everything
    // from the script onward belongs to the legacy runner, including flags.
    parsed = parseFlags(args, schema, { passThrough:true, rejectDuplicates:false });
  } catch (error) {
    if (!isArgumentError(error)) throw error;
    fail(translate(process.env, '任务执行器选项无效。'), 2);
  }
  const { values, positionals: body } = parsed;
  if (values.help || !body.length) return { values };
  const separator = body.indexOf('--');
  const positional = separator >= 0 ? body.slice(0, separator) : body;
  const scriptArgs = separator >= 0 ? body.slice(separator + 1) : [];
  const mode = ['now', 'conc', 'desi'].includes(positional[1] ?? '')
    ? (positional[1] as 'now' | 'conc' | 'desi')
    : 'normal';
  return {
    values,
    execution: {
      argv: mode === 'normal' ? positional : [positional[0]!],
      mode,
      scriptArgs,
      variable: mode === 'conc' || mode === 'desi' ? positional[2] : undefined,
      selection: positional.slice(3).join(' '),
      timeout: values.timeout as string | undefined,
    },
  };
}

export async function runnerMain(
  args = process.argv.slice(2),
): Promise<number> {
  // Parsing can fail before returning its values. Preserve an explicit JSON
  // request in that case; successful parsing still owns the script boundary.
  let json = args
    .slice(0, args.indexOf('--') < 0 ? undefined : args.indexOf('--'))
    .includes('--json');
  const controller = new AbortController();
  const cancel = (signal: NodeJS.Signals) => controller.abort(signal);
  try {
    const parsed = parseExecution(args);
    json = parsed.values.json === true;
    if (!parsed.execution) {
      const usage = standaloneHelp('runner');
      const scripts =
        !parsed.values.help && (parsed.values.root || process.env.QL_DIR)
          ? await (
              await import('./local/scriptInventory')
            ).listTaskScripts(createContext(parsed.values))
          : undefined;
      const listing =
        scripts === undefined
          ? ''
          : '\n' +
            (scripts.length
              ? translate(process.env, '当前有以下脚本可以运行:') +
                '\n' +
                scripts
                  .map(
                    (script, index) =>
                      `${index + 1}. ${script.name ?? script.file}：${
                        script.file
                      }`,
                  )
                  .join('\n')
              : translate(process.env, '暂无脚本可以执行')) +
            '\n';
      process.stdout.write(
        json
          ? JSON.stringify({ code: 200, data: { help: usage, scripts } }) + '\n'
          : usage + listing,
      );
      return 0;
    }
    for (const signal of commandSignals) process.on(signal, cancel);
    const context = await localContext(
      {
        values: parsed.values,
        positionals: parsed.execution.argv,
      },
      { signal: controller.signal },
    );
    const result = await executeTask(context, {
      ...parsed.execution,
      signal: controller.signal,
      output: (chunk) => {
        (json ? process.stderr : process.stdout).write(chunk);
      },
    });
    if (json)
      process.stdout.write(JSON.stringify({ code: 200, data: result }) + '\n');
    return result.exitCode;
  } catch (error) {
    const cancelled =
      controller.signal.aborted &&
      error instanceof Error &&
      error.name === 'AbortError' &&
      (error as NodeJS.ErrnoException).code === 'ABORT_ERR';
    const code = cancelled
      ? cancellationExitCode(controller.signal)
      : error instanceof CliError
      ? error.exitCode
      : 1;
    const message = cancelled
      ? translate(process.env, '本机任务在加载配置时已取消。')
      : error instanceof CliError
      ? error.message
      : translate(process.env, '本机任务执行失败，请检查面板环境和任务日志。');
    process.stderr.write(
      (json ? JSON.stringify({ code, message }) : message) + '\n',
    );
    return code;
  } finally {
    for (const signal of commandSignals) process.removeListener(signal, cancel);
  }
}

if (require.main === module)
  void runnerMain().then((code) => {
    process.exitCode = code;
  });
