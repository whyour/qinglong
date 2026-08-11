import { ChildProcess, SpawnOptions } from 'child_process';
import { Readable } from 'stream';
import { v7 as uuidV7 } from 'uuid';
import { spawn } from 'cross-spawn';
import type {
  ExecutionContext,
  ExecutionDiagnostic,
  ExecutionHandle,
  ExecutionInspection,
  ExecutionOutputStream,
  ExecutionResult,
  ExecutionSpec,
  ExecutionStopReason,
  ExecutionStopResult,
  ExecutorCapabilities,
} from '../../domain/execution';
import {
  ExecutorCapabilityUnavailableError,
  ExecutorHandleNotFoundError,
  ExecutorStartError,
  InvalidExecutionSpecError,
} from '../../domain/executorErrors';
import { assertExecutionSpec as assertDomainExecutionSpec } from '../../domain/executionSpec';
export {
  MAX_EXECUTION_ARGUMENTS,
  MAX_EXECUTION_COMMAND_BYTES,
  MAX_EXECUTION_TIMEOUT_MS,
  MAX_TERMINATION_GRACE_MS,
} from '../../domain/executionSpec';
import type { Executor } from '../../ports/executor';
import {
  createLocalProcessDurableHandle,
  LinuxProcProcessIdentityProvider,
  type LocalProcessIdentityProvider,
} from './localProcessIdentity';
import {
  PosixProcessTerminator,
  type ProcessTerminator,
} from './processTerminator';
import { durableLocalProcessOutput } from './durableLocalProcessOutput';
import {
  prepareDurableLocalProcessLaunch,
  type DurableLocalProcessLaunch,
} from './durableLocalProcessLaunch';

export const MAX_EXECUTION_ENVIRONMENT_ENTRIES = 1024;
export const MAX_EXECUTION_ENVIRONMENT_BYTES = 512 * 1024;

const DEFAULT_POSIX_SHELL = '/bin/bash';
const ISOLATED_ENVIRONMENT_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
] as const;

const LOCAL_PROCESS_CAPABILITIES: ExecutorCapabilities = Object.freeze({
  timeout: true,
  processGroupTermination: process.platform !== 'win32',
  workingDirectory: true,
  isolatedEnvironment: true,
  memoryLimit: 'none',
  cpuLimit: 'none',
  filesystemIsolation: 'none',
  networkIsolation: 'none',
});

export interface ExecutorClock {
  now(): number;
}

export interface LocalProcessExecutorOptions {
  clock?: ExecutorClock;
  createHandleId?: () => string;
  terminator?: ProcessTerminator;
  identityProvider?: LocalProcessIdentityProvider;
  durableLauncherPath?: string;
}

interface LocalExecutionLifecycle {
  startedAtMs: number;
  closedObserved: boolean;
  finished: boolean;
  result?: ExecutionResult;
  terminationReason?: ExecutionStopReason;
  runtimeError: boolean;
  diagnostics: ExecutionDiagnostic[];
  timeout?: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

interface LocalExecutionState {
  child: ChildProcess;
  processGroup: boolean;
  graceMs: number;
  closed: Promise<void>;
  lifecycle: LocalExecutionLifecycle;
  stopPromise?: Promise<ExecutionStopResult>;
}

function assertHandleIdentifier(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new InvalidExecutionSpecError(
      'handleId must be between 1 and 255 characters and contain no control characters',
    );
  }
}

function assertResourcePolicy(spec: ExecutionSpec): void {
  const policy = spec.resourcePolicy;
  if (!policy) return;

  if (policy.memoryBytes?.enforcement === 'required') {
    throw new ExecutorCapabilityUnavailableError('memoryLimit');
  }
  if (policy.cpuMillisPerSecond?.enforcement === 'required') {
    throw new ExecutorCapabilityUnavailableError('cpuLimit');
  }
  if (policy.filesystemIsolation === 'required') {
    throw new ExecutorCapabilityUnavailableError('filesystemIsolation');
  }
  if (policy.networkIsolation === 'required') {
    throw new ExecutorCapabilityUnavailableError('networkIsolation');
  }
}

function resourcePolicyDiagnostics(spec: ExecutionSpec): ExecutionDiagnostic[] {
  const policy = spec.resourcePolicy;
  if (!policy) return [];

  const unavailable = [
    policy.memoryBytes?.enforcement === 'best_effort' ? 'memoryLimit' : null,
    policy.cpuMillisPerSecond?.enforcement === 'best_effort'
      ? 'cpuLimit'
      : null,
    policy.filesystemIsolation === 'best_effort' ? 'filesystemIsolation' : null,
    policy.networkIsolation === 'best_effort' ? 'networkIsolation' : null,
  ].filter((value): value is string => value !== null);
  return unavailable.length === 0
    ? []
    : [
        {
          code: 'RESOURCE_POLICY_BEST_EFFORT_UNAVAILABLE',
          summary: `Best-effort capabilities were unavailable: ${unavailable.join(
            ', ',
          )}`,
        },
      ];
}

function assertExecutionSpec(spec: ExecutionSpec): void {
  assertDomainExecutionSpec(spec);
  assertResourcePolicy(spec);
}

function environmentBytes(environment: NodeJS.ProcessEnv): number {
  return Object.entries(environment).reduce(
    (total, [key, value]) =>
      total +
      Buffer.byteLength(key, 'utf8') +
      Buffer.byteLength(value ?? '', 'utf8'),
    0,
  );
}

function buildEnvironment(
  policy: ExecutionSpec['environmentPolicy'],
  supplied: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  if (Object.keys(supplied).length > MAX_EXECUTION_ENVIRONMENT_ENTRIES) {
    throw new InvalidExecutionSpecError(
      'execution environment has too many entries',
    );
  }

  const environment: NodeJS.ProcessEnv = {};
  if (policy === 'inherit') {
    Object.assign(environment, process.env);
  } else {
    for (const key of ISOLATED_ENVIRONMENT_KEYS) {
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
  }

  for (const [key, value] of Object.entries(supplied)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) {
      throw new InvalidExecutionSpecError(
        'execution environment contains an invalid key or NUL value',
      );
    }
    environment[key] = value;
  }

  if (environmentBytes(environment) > MAX_EXECUTION_ENVIRONMENT_BYTES) {
    throw new InvalidExecutionSpecError('execution environment is too large');
  }
  return environment;
}

function diagnosticOnce(
  lifecycle: LocalExecutionLifecycle,
  diagnostic: ExecutionDiagnostic,
): void {
  if (!lifecycle.diagnostics.some((item) => item.code === diagnostic.code)) {
    lifecycle.diagnostics.push(diagnostic);
  }
}

function createResult(
  lifecycle: LocalExecutionLifecycle,
  code: number | null,
  signal: NodeJS.Signals | null,
  finishedAtMs: number,
): ExecutionResult {
  const base = {
    startedAtMs: lifecycle.startedAtMs,
    finishedAtMs: Math.max(finishedAtMs, lifecycle.startedAtMs),
    ...(code === null ? {} : { exitCode: code }),
    ...(signal === null ? {} : { signal }),
    ...(lifecycle.diagnostics.length === 0
      ? {}
      : { diagnostics: [...lifecycle.diagnostics] }),
  };

  if (lifecycle.terminationReason?.kind === 'timeout') {
    return {
      ...base,
      outcome: 'timed_out',
      errorCode: 'EXECUTION_TIMED_OUT',
      errorSummary: 'Execution exceeded its configured timeout',
    };
  }
  if (lifecycle.terminationReason) {
    return {
      ...base,
      outcome: 'cancelled',
      errorCode: 'EXECUTION_CANCELLED',
      errorSummary: 'Execution was cancelled',
    };
  }
  if (lifecycle.runtimeError) {
    return {
      ...base,
      outcome: 'failed',
      errorCode: 'PROCESS_RUNTIME_ERROR',
      errorSummary: 'The child process reported a runtime error',
    };
  }
  if (code === 0) return { ...base, outcome: 'succeeded' };
  if (code !== null) {
    return {
      ...base,
      outcome: 'failed',
      errorCode: 'PROCESS_EXIT_NON_ZERO',
      errorSummary: `Process exited with code ${code}`,
    };
  }
  if (signal !== null) {
    return {
      ...base,
      outcome: 'failed',
      errorCode: 'PROCESS_SIGNALLED',
      errorSummary: `Process exited after signal ${signal}`,
    };
  }
  return {
    ...base,
    outcome: 'failed',
    errorCode: 'PROCESS_EXIT_UNKNOWN',
    errorSummary: 'Process exited without an exit code or signal',
  };
}

export class LocalProcessExecutor implements Executor {
  readonly type = 'local_process' as const;

  private readonly clock: ExecutorClock;
  private readonly createHandleId: () => string;
  private readonly terminator: ProcessTerminator;
  private readonly identityProvider: LocalProcessIdentityProvider;
  private readonly durableLauncherPath?: string;
  private readonly states = new WeakMap<ExecutionHandle, LocalExecutionState>();

  constructor(options: LocalProcessExecutorOptions = {}) {
    this.clock = options.clock ?? { now: Date.now };
    this.createHandleId = options.createHandleId ?? uuidV7;
    this.terminator = options.terminator ?? new PosixProcessTerminator();
    this.identityProvider =
      options.identityProvider ?? new LinuxProcProcessIdentityProvider();
    this.durableLauncherPath = options.durableLauncherPath;
  }

  capabilities(): ExecutorCapabilities {
    return LOCAL_PROCESS_CAPABILITIES;
  }

  async start(
    spec: ExecutionSpec,
    context: ExecutionContext,
  ): Promise<ExecutionHandle> {
    assertExecutionSpec(spec);
    const environment = buildEnvironment(
      spec.environmentPolicy,
      context.environment,
    );
    const handleId = this.createHandleId();
    assertHandleIdentifier(handleId);
    if (context.signal?.aborted) {
      throw new ExecutorStartError(
        new Error('Execution was aborted before spawn'),
      );
    }
    if (
      context.signal &&
      (!context.signal.addEventListener || !context.signal.removeEventListener)
    ) {
      throw new InvalidExecutionSpecError(
        'Execution abort signal must support event listeners',
      );
    }

    const processGroup = process.platform !== 'win32';
    const durableOutput = durableLocalProcessOutput(context.output);
    let durableLaunch: DurableLocalProcessLaunch | undefined;
    if (durableOutput) {
      durableLaunch = await prepareDurableLocalProcessLaunch(
        spec,
        context,
        environment,
        durableOutput,
        this.durableLauncherPath,
        this.clock.now(),
      );
    }
    const options: SpawnOptions = {
      cwd: spec.workingDirectory,
      env: durableLaunch?.environment ?? environment,
      detached: processGroup,
      stdio: durableLaunch
        ? [
            'ignore',
            durableLaunch.outputDescriptor,
            durableLaunch.outputDescriptor,
          ]
        : ['ignore', 'pipe', 'pipe'],
    };
    let child: ChildProcess;
    try {
      child = durableLaunch
        ? spawn(durableLaunch.file, [...durableLaunch.args], options)
        : spec.command.kind === 'argv'
        ? spawn(spec.command.file, [...spec.command.args], options)
        : spawn(spec.command.command, {
            ...options,
            shell: spec.command.shell ?? DEFAULT_POSIX_SHELL,
          });
    } catch (error) {
      await durableLaunch?.closeParentOutput().catch(() => undefined);
      throw new ExecutorStartError(error);
    }

    const lifecycle: LocalExecutionLifecycle = {
      startedAtMs: 0,
      closedObserved: false,
      finished: false,
      runtimeError: false,
      diagnostics: resourcePolicyDiagnostics(spec),
    };
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const outputPumps = durableLaunch
      ? []
      : [
          this.pumpOutput(child.stdout, 'stdout', context, lifecycle),
          this.pumpOutput(child.stderr, 'stderr', context, lifecycle),
        ];

    let spawnConfirmed = false;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        spawnConfirmed = true;
        lifecycle.startedAtMs = this.clock.now();
        resolve();
      });
      child.on('error', (error) => {
        if (!spawnConfirmed) reject(error);
        else lifecycle.runtimeError = true;
      });
    });

    const completion = new Promise<ExecutionResult>((resolve) => {
      child.once('close', (code, signal) => {
        lifecycle.closedObserved = true;
        resolveClosed();
        void Promise.all(outputPumps).then(() => {
          if (lifecycle.timeout) clearTimeout(lifecycle.timeout);
          lifecycle.removeAbortListener?.();
          const result = createResult(
            lifecycle,
            code,
            signal,
            this.clock.now(),
          );
          lifecycle.result = result;
          lifecycle.finished = true;
          resolve(result);
        });
      });
    });

    try {
      await spawned;
    } catch (error) {
      await durableLaunch?.closeParentOutput().catch(() => undefined);
      throw new ExecutorStartError(error);
    }
    await durableLaunch?.closeParentOutput().catch(() => undefined);
    if (!child.pid) {
      throw new ExecutorStartError(new Error('Spawn did not return a PID'));
    }

    let durableHandle: string | undefined;
    try {
      const identity = await this.identityProvider.capture(child.pid);
      if (identity) {
        durableHandle = createLocalProcessDurableHandle(handleId, identity);
      }
    } catch {
      // Recovery identity is optional; the Reconciler will conservatively mark
      // an unprovable execution lost and will never signal by PID alone.
    }

    const handle: ExecutionHandle = {
      id: handleId,
      ...(durableHandle === undefined ? {} : { durableHandle }),
      executorType: this.type,
      runId: spec.runId,
      attemptId: spec.attemptId,
      startedAtMs: lifecycle.startedAtMs,
      pid: child.pid,
      completion,
    };
    const state: LocalExecutionState = {
      child,
      processGroup,
      graceMs: spec.terminationGraceMs,
      closed,
      lifecycle,
    };
    this.states.set(handle, state);

    if (!lifecycle.closedObserved && spec.timeoutMs !== undefined) {
      lifecycle.timeout = setTimeout(() => {
        void this.stop(handle, {
          kind: 'timeout',
          requestedAtMs: this.clock.now(),
        }).catch(() => {
          diagnosticOnce(lifecycle, {
            code: 'TIMEOUT_STOP_FAILED',
            summary: 'Executor could not stop the process after timeout',
          });
        });
      }, spec.timeoutMs);
      lifecycle.timeout.unref?.();
    }

    if (!lifecycle.closedObserved && context.signal) {
      const onAbort = () => {
        void this.stop(handle, {
          kind: 'user',
          requestedAtMs: this.clock.now(),
        }).catch(() => {
          diagnosticOnce(lifecycle, {
            code: 'ABORT_STOP_FAILED',
            summary: 'Executor could not stop the process after abort',
          });
        });
      };
      context.signal.addEventListener!('abort', onAbort, { once: true });
      lifecycle.removeAbortListener = () =>
        context.signal?.removeEventListener?.('abort', onAbort);
      if (context.signal.aborted) onAbort();
    }

    return handle;
  }

  async stop(
    handle: ExecutionHandle,
    reason: ExecutionStopReason,
  ): Promise<ExecutionStopResult> {
    const state = this.states.get(handle);
    if (!state) throw new ExecutorHandleNotFoundError(handle.id);
    if (state.lifecycle.closedObserved) {
      return {
        status: 'already_exited',
        termSignalSent: false,
        killSignalSent: false,
      };
    }
    if (state.stopPromise) return state.stopPromise;

    state.lifecycle.terminationReason = reason;
    state.stopPromise = this.terminator
      .terminate({
        pid: state.child.pid!,
        processGroup: state.processGroup,
        graceMs: state.graceMs,
        closed: state.closed,
      })
      .then((result) => ({
        status: result.alreadyExited
          ? ('already_exited' as const)
          : ('termination_requested' as const),
        termSignalSent: result.termSignalSent,
        killSignalSent: result.killSignalSent,
      }));
    return state.stopPromise;
  }

  async inspect(handle: ExecutionHandle): Promise<ExecutionInspection> {
    const state = this.states.get(handle);
    if (!state) throw new ExecutorHandleNotFoundError(handle.id);
    if (state.lifecycle.closedObserved) {
      return {
        status: 'exited',
        ...(state.lifecycle.result === undefined
          ? {}
          : { result: state.lifecycle.result }),
      };
    }
    return {
      status: state.stopPromise ? 'stopping' : 'running',
    };
  }

  private async pumpOutput(
    stream: Readable | null,
    outputStream: ExecutionOutputStream,
    context: ExecutionContext,
    lifecycle: LocalExecutionLifecycle,
  ): Promise<void> {
    if (!stream) return;
    let sinkAvailable = true;
    try {
      for await (const value of stream) {
        if (!sinkAvailable) continue;
        try {
          const chunk =
            value instanceof Uint8Array ? value : Buffer.from(String(value));
          await context.output.write({
            stream: outputStream,
            chunk,
            observedAtMs: this.clock.now(),
          });
        } catch {
          sinkAvailable = false;
          diagnosticOnce(lifecycle, {
            code: 'OUTPUT_SINK_FAILED',
            summary: 'Execution output sink failed; output may be incomplete',
          });
        }
      }
    } catch {
      diagnosticOnce(lifecycle, {
        code: 'OUTPUT_STREAM_FAILED',
        summary: 'Execution output stream failed; output may be incomplete',
      });
    }
  }
}
