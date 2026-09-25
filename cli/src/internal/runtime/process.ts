import { translate } from '../../shared/i18n/index';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { fail } from '../../shared/errors';
import { operationOutput } from './output';
import { commandSignal, operationSignal } from './cancellation';
import { shellOptionPrelude } from '../execution/shellOptions';

export interface ProcessOptions {
  stdin?: 'inherit' | 'ignore';
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  graceMs?: number;
  capture?: boolean;
  captureFd?: 1 | 3;
  output?: (chunk: Buffer) => void;
  stderrOutput?: (chunk: Buffer) => void;
  maxCaptureBytes?: number;
  signal?: AbortSignal;
}
export interface ProcessResult {
  code: number;
  stdout: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

function cancellationSignal(signal?: AbortSignal): NodeJS.Signals {
  // Only runner-supported termination signals may cross the abort boundary.
  // Generic AbortController callers retain the default SIGTERM contract.
  const reason: unknown = signal?.reason;
  return commandSignal(reason);
}

export function cancellationExitCode(signal?: AbortSignal): number {
  return 128 + constants.signals[cancellationSignal(signal)];
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  // A POSIX process group can outlive its leader while descendants still hold
  // stdout/stderr. Keep signalling the group until runProcess receives close.
  if (
    process.platform === 'win32' &&
    (child.exitCode !== null || child.signalCode !== null)
  )
    return;
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      child.kill(signal);
      return;
    }
    throw error;
  }
}

export async function runProcess(
  program: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  options = { ...options, signal: options.signal ?? operationSignal() };
  // Recognize only the command forms used by our fixed Bash bridges. A -c
  // after a script name or option terminator belongs to the script's argv.
  let commandIndex = 0;
  while (['--noprofile', '--norc'].includes(args[commandIndex] ?? ''))
    commandIndex++;
  if (
    /(?:^|\/)bash$/.test(program) &&
    args[commandIndex] === '-c' &&
    typeof args[commandIndex + 1] === 'string' &&
    typeof (options.env ?? process.env).QL_CLI_SHELLOPTS === 'string'
  ) {
    args = [...args];
    (args as string[])[commandIndex + 1] =
      shellOptionPrelude + args[commandIndex + 1];
  }
  if (options.signal?.aborted)
    return {
      code: cancellationExitCode(options.signal),
      stdout: '',
      signal: cancellationSignal(options.signal),
      timedOut: false,
    };
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio:
        options.captureFd === 3
          ? [options.stdin ?? 'ignore', 'pipe', 'pipe', 'pipe']
          : [options.stdin ?? 'ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    let outputFailure: unknown;
    let aborted = false;
    let terminating = false;
    let timeout: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      terminating = true;
      signalGroup(child, signal);
      escalation ??= setTimeout(
        () => signalGroup(child, 'SIGKILL'),
        options.graceMs ?? 10000,
      );
      escalation.unref();
    };
    const abort = () => {
      aborted = true;
      terminate(cancellationSignal(options.signal));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      options.signal?.removeEventListener('abort', abort);
    };
    child.once('error', () => {
      cleanup();
      reject(
        new Error(
          translate(
            options.env ?? process.env,
            '无法启动必要的可执行程序：%s',
            program,
          ),
        ),
      );
    });
    const emit = (chunk: Buffer, sink = options.output) => {
      if (outputFailure) return;
      try {
        (sink ?? operationOutput)(chunk);
      } catch (error) {
        outputFailure =
          error ||
          new Error(
            translate(options.env ?? process.env, '子进程输出写入失败。'),
          );
        signalGroup(child, 'SIGKILL');
      }
    };
    const capture = (chunk: Buffer) => {
      if (options.capture) {
        bytes += chunk.length;
        if (bytes > (options.maxCaptureBytes ?? 1024 * 1024)) {
          if (!overflow) {
            overflow = true;
            signalGroup(child, 'SIGKILL');
          }
        } else chunks.push(chunk);
      } else emit(chunk);
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      if (options.captureFd === 3) emit(chunk);
      else capture(chunk);
    });
    if (options.captureFd === 3) child.stdio[3]!.on('data', capture);
    child.stderr!.on('data', (chunk: Buffer) =>
      emit(chunk, options.stderrOutput ?? options.output),
    );
    child.once('close', (code, signal) => {
      // Descendants may close their pipes but ignore the first signal. Do not
      // cancel escalation and leave them running when the leader closes early.
      if (terminating && process.platform !== 'win32')
        signalGroup(child, 'SIGKILL');
      cleanup();
      if (outputFailure) {
        reject(outputFailure);
        return;
      }
      if (overflow) {
        reject(
          new Error(
            translate(
              options.env ?? process.env,
              '子进程输出超过配置的捕获上限。',
            ),
          ),
        );
        return;
      }
      resolve({
        code: timedOut
          ? 124
          : aborted
          ? cancellationExitCode(options.signal)
          : code ?? (signal ? 128 + constants.signals[signal] : 1),
        stdout: Buffer.concat(chunks).toString('utf8'),
        signal,
        timedOut,
      });
    });
    if (options.timeoutMs && options.timeoutMs > 0)
      timeout = setTimeout(() => {
        timedOut = true;
        terminate('SIGINT');
      }, options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export async function checkedProcess(
  program: string,
  args: readonly string[],
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const result = await runProcess(program, args, options);
  if (result.code !== 0)
    fail(
      translate(
        options.env ?? process.env,
        '必要的可执行程序失败（%s，退出码 %s）。',
        program,
        result.code,
      ),
    );
  return result;
}
