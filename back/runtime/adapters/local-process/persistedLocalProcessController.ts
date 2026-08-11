import { ExecutorStopError } from '../../domain/executorErrors';
import type {
  PersistedExecutionController,
  PersistedExecutionStopResult,
  PersistedExecutionStopStatus,
} from '../../ports/persistedExecutionController';
import {
  LinuxProcProcessIdentityProvider,
  parseLocalProcessDurableHandle,
  type LocalProcessIdentityProvider,
  type LinuxProcessIdentity,
} from './localProcessIdentity';

export const MAX_PERSISTED_LOCAL_STOP_GRACE_MS = 60_000;

export type PersistedLocalProcessSignalSender = (
  pid: number,
  signal: NodeJS.Signals,
) => void;

export interface PersistedLocalProcessControllerOptions {
  identityProvider?: LocalProcessIdentityProvider;
  sendSignal?: PersistedLocalProcessSignalSender;
  graceMs?: number;
  pollIntervalMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

function isNoSuchProcessError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
}

function withoutSignal(status: PersistedExecutionStopStatus) {
  return { status, termSignalSent: false, killSignalSent: false } as const;
}

function mappedInspectionStatus(
  status: 'identity_mismatch' | 'unsupported' | 'invalid',
  termSignalSent: boolean,
): PersistedExecutionStopResult {
  return {
    status,
    termSignalSent,
    killSignalSent: false,
  };
}

export class LocalProcessPersistedExecutionController
  implements PersistedExecutionController
{
  readonly executorType = 'local_process' as const;
  private readonly identityProvider: LocalProcessIdentityProvider;
  private readonly sendSignal: PersistedLocalProcessSignalSender;
  private readonly graceMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(options: PersistedLocalProcessControllerOptions = {}) {
    this.identityProvider =
      options.identityProvider ?? new LinuxProcProcessIdentityProvider();
    this.sendSignal = options.sendSignal ?? process.kill;
    this.graceMs = options.graceMs ?? 5_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    this.sleep =
      options.sleep ??
      ((delayMs) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    if (
      !Number.isSafeInteger(this.graceMs) ||
      this.graceMs < 0 ||
      this.graceMs > MAX_PERSISTED_LOCAL_STOP_GRACE_MS
    ) {
      throw new RangeError('Persisted local stop graceMs is invalid');
    }
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) {
      throw new RangeError(
        'Persisted local stop pollIntervalMs must be a positive integer',
      );
    }
  }

  async stop({
    durableHandle,
    expectedPid,
  }: Parameters<
    PersistedExecutionController['stop']
  >[0]): Promise<PersistedExecutionStopResult> {
    const parsed = parseLocalProcessDurableHandle(durableHandle);
    if (!parsed) return withoutSignal('invalid');
    const identity = parsed.identity;
    if (expectedPid !== undefined && expectedPid !== identity.pid) {
      return withoutSignal('pid_mismatch');
    }
    // LocalProcessExecutor uses a detached child as process-group leader.
    if (identity.processGroupId !== identity.pid) {
      return withoutSignal('identity_mismatch');
    }

    const initial = await this.identityProvider.inspect(identity);
    if (initial.status === 'exited') return withoutSignal('already_exited');
    if (initial.status !== 'running') {
      return mappedInspectionStatus(initial.status, false);
    }

    if (!this.trySignal(identity, 'SIGTERM')) {
      return withoutSignal('already_exited');
    }

    let waitedMs = 0;
    while (waitedMs < this.graceMs) {
      const delayMs = Math.min(this.pollIntervalMs, this.graceMs - waitedMs);
      await this.sleep(delayMs);
      waitedMs += delayMs;
      const inspection = await this.identityProvider.inspect(identity);
      if (inspection.status === 'exited') {
        return {
          status: 'termination_requested',
          termSignalSent: true,
          killSignalSent: false,
        };
      }
      if (inspection.status !== 'running') {
        return mappedInspectionStatus(inspection.status, true);
      }
    }

    const finalInspection = await this.identityProvider.inspect(identity);
    if (finalInspection.status === 'exited') {
      return {
        status: 'termination_requested',
        termSignalSent: true,
        killSignalSent: false,
      };
    }
    if (finalInspection.status !== 'running') {
      return mappedInspectionStatus(finalInspection.status, true);
    }
    const killSignalSent = this.trySignal(identity, 'SIGKILL');
    return {
      status: 'termination_requested',
      termSignalSent: true,
      killSignalSent,
    };
  }

  private trySignal(
    identity: LinuxProcessIdentity,
    signal: NodeJS.Signals,
  ): boolean {
    try {
      this.sendSignal(-identity.processGroupId, signal);
      return true;
    } catch (error) {
      if (isNoSuchProcessError(error)) return false;
      throw new ExecutorStopError(error);
    }
  }
}
