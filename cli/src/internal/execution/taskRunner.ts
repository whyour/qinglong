import { extendedLifecycle } from '../runtime/lifecycle';
import fs from 'node:fs/promises';
import { writeSync } from 'node:fs';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { LocalContext } from '../runtime/context';
import { sourceEnvironment } from '../runtime/context';
import { LocalApi } from '../runtime/api';
import { cancellationExitCode, runProcess } from '../runtime/process';
import { within } from '../runtime/files';
import { fail } from '../../shared/errors';
import { orderedConcurrent } from './concurrent';
import { shellSessionArguments } from './shellSession';
import { taskDependencyEnvironment } from './dependencies';
import { translate } from '../../shared/i18n/index';
import { matchesDelayExtension } from './taskDelay';
import { prepareLanguagePreload } from './languagePreload';

export interface ExecutionOptions {
  argv: string[];
  scriptArgs?: string[];
  mode?: 'normal' | 'now' | 'conc' | 'desi';
  variable?: string;
  selection?: string;
  timeout?: string;
  output?: (chunk: Buffer) => void;
  signal?: AbortSignal;
}
export interface ExecutionResult {
  exitCode: number;
  logPath: string;
  durationSeconds: number;
  executionId?: string;
  taskId?: number;
  timedOut: boolean;
}

export function selectedAccounts(
  selection: string,
  count: number,
  environment: NodeJS.ProcessEnv = process.env,
): number[] {
  const result = new Set<number>();
  for (const item of (selection || '1-max').trim().split(/\s+/)) {
    const expanded = item.replace(/max/g, String(count));
    const match = expanded.match(/^(\d+)(?:[-~_](\d+))?$/);
    if (!match) fail(translate(environment, '账号选择格式无效。'), 2);
    const first = Number(match[1]),
      last = Number(match[2] ?? match[1]);
    if (
      ![first, last].every(
        (value) => Number.isSafeInteger(value) && value >= 1 && value <= count,
      )
    )
      fail(translate(environment, '账号选择超出环境变量的账号范围。'), 2);
    const step = first <= last ? 1 : -1;
    for (let value = first; ; value += step) {
      result.add(value);
      if (value === last) break;
    }
  }
  return [...result];
}

export function durationMs(
  value?: string,
  environment: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);
  if (!match)
    fail(translate(environment, '超时必须为正时长，例如 30s 或 5m。'), 2);
  const result =
    Number(match[1]) *
    { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2] || 's']!;
  if (!Number.isFinite(result) || result <= 0 || result > 2147483647)
    fail(translate(environment, '超时时长超出支持范围。'), 2);
  return result;
}

function timestamp(now: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    pad(now.getMilliseconds(), 3),
  ].join('-');
}

async function exists(file: string): Promise<boolean> {
  return (await fs.stat(file).catch(() => undefined))?.isFile() ?? false;
}

async function taskIdentity(
  context: LocalContext,
  first: string,
): Promise<number | undefined> {
  if (/^[1-9]\d*$/.test(context.env.ID ?? '')) return Number(context.env.ID);
  const list = await fs
    .readFile(context.paths.list_crontab_user!, 'utf8')
    .catch(() => '');
  for (const line of list.split('\n')) {
    if (!line.includes(` ${first}`)) continue;
    const id = line.match(/\bID=(?:["']?)(\d+)/)?.[1];
    if (id && Number(id) > 0) return Number(id);
  }
  return undefined;
}

async function prepareProgram(
  context: LocalContext,
  argv: string[],
): Promise<{
  program: string;
  args: string[];
  cwd: string;
  languagePreload: boolean;
  shellScript: boolean;
  shellCommand: boolean;
}> {
  const extensions = /\.(?:js|mjs|py|pyc|sh|ts)$/;
  const first = argv[0]!;
  const index = argv.findIndex((arg) => extensions.test(arg));
  const candidate = index >= 0 ? argv[index]! : first;
  let cwd = context.paths.dir_scripts!;
  const workdir = context.env.work_dir;
  const explicit = workdir ? path.resolve(cwd, workdir) : undefined;
  let resolveBasename = false;
  if (
    explicit &&
    (await fs.stat(explicit).catch(() => undefined))?.isDirectory()
  ) {
    cwd = explicit;
    resolveBasename = true;
  } else if (candidate.includes('/')) {
    const directory = path.dirname(path.resolve(cwd, candidate));
    if ((await fs.stat(directory).catch(() => undefined))?.isDirectory()) {
      cwd = directory;
      resolveBasename = true;
    }
  }
  const adjusted = [...argv];
  if (index >= 0 && candidate.includes('/') && resolveBasename)
    adjusted[index] = path.basename(candidate);
  const extension = path.extname(first);
  const program = (
    {
      '.js': process.execPath,
      '.mjs': process.execPath,
      '.py': 'python3',
      '.pyc': 'python3',
      '.ts': 'ts-node-transpile-only',
      '.sh': 'bash',
    } as Record<string, string>
  )[extension];
  const languagePreload =
    !!program && extension !== '.sh' && (await exists(context.paths.file_env!));
  const shellScript = extension === '.sh';
  if (shellScript)
    return {
      program: 'bash',
      args: [
        '--noprofile',
        '--norc',
        '-c',
        'file="$1"; shift; . "$file" "$@"',
        'ql-script',
        path.resolve(cwd, adjusted[0]!),
        ...adjusted.slice(1),
      ],
      cwd,
      languagePreload,
      shellScript,
      shellCommand: false,
    };
  const executable =
    index < 0 && resolveBasename && first.includes('/')
      ? path.resolve(cwd, path.basename(first))
      : first;
  return {
    program: program ?? 'bash',
    // Bash resolves exported user functions and builtins as well as PATH commands.
    // Keep command/arguments as argv data, never interpolate or eval them.
    args: program
      ? adjusted
      : ['--noprofile', '--norc', '-c', '"$@"', 'ql-command', executable, ...adjusted.slice(1)],
    cwd,
    languagePreload,
    shellScript,
    shellCommand: !program,
  };
}

export async function executeTask(
  context: LocalContext,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  if (!options.argv.length)
    fail(translate(context.env, '必须指定脚本或可执行程序。'), 2);
  const start = Date.now();
  const started = Math.floor(start / 1000);
  const first = options.argv[0]!;
  const taskId = await taskIdentity(context, first);
  const extended = await extendedLifecycle(context);
  const executionId =
    extended && context.env.QL_EXECUTION_ORIGIN === 'scheduled_system'
      ? `legacy-system:${started}:${randomUUID()}`
      : undefined;
  const fileName = path.basename(first, path.extname(first));
  const parent = first.includes('/') ? path.basename(path.dirname(first)) : '';
  const folder =
    context.env.log_name ||
    `${parent ? parent + '_' : ''}${fileName}${taskId ? '_' + taskId : ''}`;
  const logPath =
    folder === '/dev/null'
      ? '/dev/null'
      : context.env.real_log_path ||
        path.join(folder, `${timestamp(new Date(start))}.log`);
  const fullLog =
    logPath === '/dev/null'
      ? logPath
      : within(context.paths.dir_log!, logPath, context.env);
  const discardOutput = folder === '/dev/null';
  const persistLog = context.env.real_time !== 'true' && !discardOutput;
  if (persistLog) await fs.mkdir(path.dirname(fullLog), { recursive: true });
  const log = persistLog ? await fs.open(fullLog, 'a', 0o600) : undefined;
  const output = (chunk: Buffer) => {
    if (discardOutput) return;
    // Regular-file writes apply backpressure without retaining task output in memory.
    let offset = 0;
    while (log && offset < chunk.length)
      offset += writeSync(log.fd, chunk, offset);
    if (context.env.no_tee !== 'true' || context.env.real_time === 'true')
      (options.output ?? ((value) => process.stderr.write(value)))(chunk);
  };
  const stderrOutput = discardOutput
    ? options.output ??
      ((value: Buffer) => {
        process.stderr.write(value);
      })
    : undefined;
  const api = new LocalApi(context);
  const report = async (final: boolean, code = 0, duration = 0) => {
    if (!taskId) return;
    try {
      await api.call('crons/status', 'PUT', {
        ids: [taskId],
        status: final ? '1' : '0',
        pid: String(process.pid),
        log_path: logPath,
        last_execution_time: started,
        last_running_time: duration,
        ...(final && extended ? { exit_code: code } : {}),
        ...(executionId ? { execution_id: executionId } : {}),
      });
    } catch {
      output(
        Buffer.from(
          translate(context.env, '任务状态上报失败，请检查本机面板。\n'),
        ),
      );
    }
    if (final && extended) {
      try {
        await api.call('dashboard/record', 'POST', {
          ref_id: taskId,
          code,
          elapsed: duration,
        });
      } catch {
        output(
          Buffer.from(
            translate(context.env, '任务统计上报失败，请检查本机面板。\n'),
          ),
        );
      }
    }
  };
  let exitCode = 1,
    timedOut = false;
  let languageDirectory: string | undefined;
  try {
    await report(false);
    output(
      Buffer.from(
        translate(
          context.env,
          '## 开始执行... %s\n',
          new Date(start).toISOString(),
        ),
      ),
    );
    let program = await prepareProgram(context, options.argv);
    const sharedShell =
      (program.shellScript || program.shellCommand) &&
      (!options.mode || ['normal', 'now', 'desi'].includes(options.mode));
    let env = await taskDependencyEnvironment(context);
    // The panel preloads own generated environment variables and language hooks.
    if (program.languagePreload) {
      languageDirectory = await prepareLanguagePreload(
        context.paths.dir_preload!,
      );
      env.QL_CLI_PRELOAD_ARGS = JSON.stringify([
        ...options.argv,
        ...(options.scriptArgs ?? []),
      ]);
      env.PREV_NODE_OPTIONS = env.NODE_OPTIONS || '';
      env.PREV_PYTHONPATH = env.PYTHONPATH || '';
      if (/\.(?:js|mjs|ts)$/.test(first))
        env.NODE_OPTIONS = `--require ${JSON.stringify(
          path.join(languageDirectory, 'sitecustomize.js'),
        )} ${env.NODE_OPTIONS || ''}`;
      else
        env.PYTHONPATH = [
          languageDirectory,
          context.paths.dir_config,
          env.PYTHONPATH,
        ]
          .filter(Boolean)
          .join(path.delimiter);
    } else if (!sharedShell) {
      env = await sourceEnvironment(
        env,
        [context.paths.file_env!, context.paths.file_task_before!],
        options.argv,
        {
          command:
            'if [ -n "${task_before:-}" ]; then eval "${task_before%;}"; fi',
          signal: options.signal,
          output,
          stderrOutput,
        },
      );
      program = await prepareProgram({ ...context, env }, options.argv);
    }
    const mode = options.mode ?? 'normal';
    let accounts: number[] = [];
    let allAccounts: string[] = [];
    if (mode === 'conc' || mode === 'desi') {
      if (
        !options.variable ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.variable)
      )
        fail(translate(env, '必须指定有效的账号环境变量名。'), 2);
      const accountEnv =
        program.languagePreload || sharedShell
          ? await sourceEnvironment(
              context.env,
              [context.paths.file_env!],
              [],
              { signal: options.signal },
            )
          : env;
      allAccounts = (accountEnv[options.variable] ?? '').split('&');
      accounts = selectedAccounts(
        options.selection ?? '1-max',
        allAccounts.length,
        env,
      );
    }
    const maxDelay = Number(env.RandomDelay || 0);
    const ignored = (env.RandomDelayIgnoredMinutes ?? '0 30')
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    if (
      mode === 'normal' &&
      options.argv.length === 1 &&
      /\.(?:js|mjs|py|pyc|sh|ts)$/.test(first) &&
      context.env.real_time !== 'true' &&
      context.env.no_delay !== 'true' &&
      Number.isSafeInteger(maxDelay) &&
      maxDelay > 0 &&
      !ignored.includes(new Date().getMinutes()) &&
      (await matchesDelayExtension(first, env, options.signal))
    ) {
      const seconds = randomInt(1, maxDelay + 1);
      output(
        Buffer.from(
          translate(
            env,
            '任务随机延迟 %s 秒，将于 %s 开始，配置文件参数 RandomDelay 置空可取消延迟\n',
            seconds,
            new Date(Date.now() + seconds * 1000).toISOString(),
          ),
        ),
      );
      await delay(seconds * 1000, undefined, { signal: options.signal });
    }
    const invoke = async (selection?: number[], sink = output) => {
      const childEnv = { ...env };
      delete childEnv.__ql_selected_name;
      delete childEnv.__ql_selected_value;
      if (selection && options.variable) {
        if (program.languagePreload) {
          childEnv.envParam = options.variable;
          childEnv.numParam = selection.join(' ');
        } else {
          childEnv[options.variable] = selection
            .map((number) => allAccounts[number - 1]!)
            .join('&');
          if (sharedShell) {
            childEnv.__ql_selected_name = options.variable;
            childEnv.__ql_selected_value = childEnv[options.variable];
          }
        }
      }
      return runProcess(
        program.program,
        sharedShell
          ? shellSessionArguments(
              context,
              options.argv,
              options.scriptArgs ?? [],
              program.shellCommand,
            )
          : [...program.args, ...(options.scriptArgs ?? [])],
        {
          cwd: sharedShell ? context.root : program.cwd,
          env: childEnv,
          // Preserve the legacy task's pipe/file input in every execution mode.
          stdin: 'inherit',
          output: sink,
          // Legacy concurrent children merge stderr into their per-account log.
          stderrOutput: mode === 'conc' ? undefined : stderrOutput,
          timeoutMs: durationMs(options.timeout ?? env.CommandTimeoutTime, env),
          signal: options.signal,
        },
      );
    };
    const results =
      mode === 'conc'
        ? await orderedConcurrent(
            context.paths.dir_list_tmp!,
            accounts,
            (account, sink) => invoke([account], sink),
            output,
          )
        : [await invoke(mode === 'desi' ? accounts : undefined)];
    exitCode = results.find((result) => result.code !== 0)?.code ?? 0;
    timedOut = results.some((result) => result.timedOut);
    if (!sharedShell) {
      // JS/Python pre-task hooks run inside the preloader; after hooks run once per task.
      const afterEnv: NodeJS.ProcessEnv = {
        ...env,
        _task_exit_code: String(exitCode),
      };
      afterEnv.NODE_PATH = env.PREV_NODE_PATH;
      delete afterEnv.QL_NODE_GLOBAL_PATH;
      if (program.languagePreload) {
        afterEnv.NODE_OPTIONS = env.PREV_NODE_OPTIONS;
        afterEnv.PYTHONPATH = env.PREV_PYTHONPATH;
      }
      await runProcess(
        'bash',
        [
          '--noprofile',
          '--norc',
          '-c',
          'file="$1"; shift; if [ -f "$file" ]; then . "$file" "$@"; fi; if [ -n "${task_after:-}" ]; then eval "${task_after%;}"; fi',
          'ql-after',
          context.paths.file_task_after!,
          ...options.argv,
        ],
        {
          cwd: program.cwd,
          env: afterEnv,
          output,
          stderrOutput,
          signal: options.signal,
        },
      );
      if (options.signal?.aborted)
        exitCode = cancellationExitCode(options.signal);
    }
  } catch (error) {
    // The timer rejects before any task subprocess exists. Preserve the same
    // cancellation result and lifecycle reporting as an interrupted process.
    if (
      options.signal?.aborted &&
      error instanceof Error &&
      error.name === 'AbortError' &&
      (error as NodeJS.ErrnoException).code === 'ABORT_ERR'
    ) {
      exitCode = cancellationExitCode(options.signal);
    } else throw error;
  } finally {
    if (languageDirectory)
      await fs.rm(languageDirectory, { recursive: true, force: true });
    const durationSeconds = Math.max(
      1,
      Math.floor((Date.now() - start) / 1000),
    );
    await report(true, exitCode, durationSeconds);
    output(
      Buffer.from(
        exitCode === 0
          ? translate(
              context.env,
              '\n## 完成 ✅... %s  耗时 %s 秒%s',
              new Date().toISOString(),
              durationSeconds,
              '　　　　　\n',
            )
          : translate(
              context.env,
              '\n## 失败 ❌(退出码 %s)... %s  耗时 %s 秒%s',
              exitCode,
              new Date().toISOString(),
              durationSeconds,
              '　　　　　\n',
            ),
      ),
    );
    await log?.close();
  }
  return {
    exitCode,
    logPath,
    durationSeconds: Math.max(1, Math.floor((Date.now() - start) / 1000)),
    executionId,
    taskId,
    timedOut,
  };
}
