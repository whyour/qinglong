// Worker Execution owns the fenced POSIX launch adapter and spawn barrier.
import { createHash } from 'node:crypto';
import {
  LocalProcessLaunchError,
  LocalProcessLauncher,
  type LocalProcessIdentityProvider,
} from '@qinglong/local-process';
import { assertRunDispatchId } from '@qinglong/runtime-core/run-dispatch-lease';
import {
  normalizeWorkerRemoteExecutionInboxRecord,
  type WorkerRemoteExecutionInbox,
} from '../remote-execution/executionInbox';
import type {
  WorkerRemoteExecutionExecutor,
  WorkerRemoteExecutionLaunch,
} from '../remote-execution/executionInboxProcessor';
import { workerFileLogOutputPlan } from './workerFileLogArtifactAllocator';

export interface WorkerRemoteExecutionSpawnBarrier {
  verify(input: Readonly<{
    offerId: string;
    runId: string;
    attemptId: string;
    callbackSequence: number;
    callbackTokenDigest: string;
    logArtifactId: string;
    executorStartedAtMs: number;
  }>): Promise<void>;
}

export class WorkerInboxExecutionSpawnBarrier
  implements WorkerRemoteExecutionSpawnBarrier {
  constructor(private readonly inbox: Pick<WorkerRemoteExecutionInbox, 'readOffer'>) {
    if (!inbox || typeof inbox.readOffer !== 'function') {
      throw new TypeError('Worker execution spawn barrier inbox is invalid');
    }
  }

  async verify(input: Readonly<{
    offerId: string;
    runId: string;
    attemptId: string;
    callbackSequence: number;
    callbackTokenDigest: string;
    logArtifactId: string;
    executorStartedAtMs: number;
  }>): Promise<void> {
    const record = await this.inbox.readOffer(input.offerId);
    if (!record) throw new Error('Worker execution spawn barrier is missing');
    const current = normalizeWorkerRemoteExecutionInboxRecord(record);
    if (
      current.state !== 'launching' ||
      current.offer.offerId !== input.offerId ||
      current.offer.candidate.runId !== input.runId ||
      current.offer.candidate.attemptId !== input.attemptId ||
      current.completionReceiptCallbackSequence !== input.callbackSequence ||
      current.completionReceiptTokenDigest !== input.callbackTokenDigest ||
      current.logArtifactId !== input.logArtifactId ||
      current.executorStartedAtMs !== input.executorStartedAtMs
    ) {
      throw new Error('Worker execution spawn barrier authority drifted');
    }
  }
}

export interface WorkerPosixExecutionExecutorOptions {
  readonly barrier: WorkerRemoteExecutionSpawnBarrier;
  readonly receiptRoot: string;
  readonly launcherPath?: string;
  readonly expectedLauncherSha256?: string;
  readonly identityProvider?: LocalProcessIdentityProvider;
  readonly clock?: { now(): number };
  readonly createHandleId?: () => string;
}

export class WorkerPosixExecutionExecutor
  implements WorkerRemoteExecutionExecutor {
  private readonly options: WorkerPosixExecutionExecutorOptions;

  constructor(options: WorkerPosixExecutionExecutorOptions) {
    if (!options || typeof options.barrier?.verify !== 'function') {
      throw new TypeError('Worker POSIX Executor barrier is invalid');
    }
    this.options = options;
  }

  async start(launch: WorkerRemoteExecutionLaunch): Promise<
    | Readonly<{
        status: 'started';
        executorHandle: string;
        executorStartedAtMs: number;
      }>
    | Readonly<{ status: 'rejected' }>
  > {
    let callbackToken: Buffer | undefined;
    try {
      assertRunDispatchId('offerId', launch.offerId);
      assertRunDispatchId('runId', launch.runId);
      assertRunDispatchId('attemptId', launch.attemptId);
      assertRunDispatchId('logArtifactId', launch.logArtifactId);
      if (
        (launch.timeoutMs === undefined) !==
          (launch.executionDeadlineAtMs === undefined) ||
        (launch.executionDeadlineAtMs !== undefined &&
          (!Number.isSafeInteger(launch.executionDeadlineAtMs) ||
            launch.executionDeadlineAtMs < 0))
      ) return this.reject(launch);
      const outputPlan = workerFileLogOutputPlan(launch.output);
      if (
        !outputPlan ||
        outputPlan.logArtifactId !== launch.logArtifactId
      ) return this.reject(launch);
      callbackToken = Buffer.from(launch.completionCallback.token);
      if (callbackToken.byteLength !== 32) return this.reject(launch);
      const callbackTokenDigest = createHash('sha256')
        .update(callbackToken)
        .digest('hex');
      const environment: Record<string, string> = {};
      for (const entry of launch.environment) {
        if (Object.hasOwn(environment, entry.name)) return this.reject(launch);
        environment[entry.name] = entry.value;
      }
      await launch.output.close();
      const launcher = new LocalProcessLauncher(
        {
          register: async (registered: Readonly<{
            runId: string;
            attemptId: string;
            registeredAtMs: number;
          }>) => {
            if (
              registered.runId !== launch.runId ||
              registered.attemptId !== launch.attemptId
            ) throw new Error('Worker POSIX Executor journal authority drifted');
            await this.options.barrier.verify(Object.freeze({
              offerId: launch.offerId,
              runId: launch.runId,
              attemptId: launch.attemptId,
              callbackSequence: launch.completionCallback.sequence,
              callbackTokenDigest,
              logArtifactId: launch.logArtifactId,
              executorStartedAtMs: launch.executorStartedAtMs,
            }));
          },
        },
        {
          receiptRoot: this.options.receiptRoot,
          ...(this.options.launcherPath === undefined
            ? {}
            : { launcherPath: this.options.launcherPath }),
          ...(this.options.expectedLauncherSha256 === undefined
            ? {}
            : { expectedLauncherSha256: this.options.expectedLauncherSha256 }),
          ...(this.options.identityProvider === undefined
            ? {}
            : { identityProvider: this.options.identityProvider }),
          ...(this.options.clock === undefined
            ? {}
            : { clock: this.options.clock }),
          ...(this.options.createHandleId === undefined
            ? {}
            : { createHandleId: this.options.createHandleId }),
        },
      );
      const command = launch.command.kind === 'argv'
        ? Object.freeze({
            kind: 'argv' as const,
            file: launch.command.file,
            args: launch.command.args,
          })
        : Object.freeze({
            kind: 'shell' as const,
            command: launch.command.command,
            ...(launch.command.shell === undefined
              ? {}
              : { shell: launch.command.shell as '/bin/sh' | '/bin/bash' }),
          });
      const handle = await launcher.start({
        runId: launch.runId,
        attemptId: launch.attemptId,
        startedAtMs: launch.executorStartedAtMs,
        callbackSequence: launch.completionCallback.sequence,
        callbackToken: callbackToken.toString('base64url'),
        command,
        environment,
        ...(launch.workingDirectory === undefined
          ? {}
          : { workingDirectory: launch.workingDirectory }),
        output: outputPlan,
      });
      void handle.completion;
      return Object.freeze({
        status: 'started' as const,
        executorHandle: handle.durableHandle,
        executorStartedAtMs: handle.startedAtMs,
      });
    } catch (error) {
      await launch?.output?.close?.().catch(() => undefined);
      if (
        error instanceof LocalProcessLaunchError &&
        error.spawnOutcome === 'unknown'
      ) throw error;
      return Object.freeze({ status: 'rejected' as const });
    } finally {
      callbackToken?.fill(0);
    }
  }

  private async reject(
    launch: WorkerRemoteExecutionLaunch,
  ): Promise<Readonly<{ status: 'rejected' }>> {
    await launch.output.close().catch(() => undefined);
    return Object.freeze({ status: 'rejected' as const });
  }
}
