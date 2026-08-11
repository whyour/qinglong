import type { ExecutionStopReason, ExecutorType } from '../domain/execution';

export type PersistedExecutionStopStatus =
  | 'termination_requested'
  | 'already_exited'
  | 'identity_mismatch'
  | 'pid_mismatch'
  | 'unsupported'
  | 'invalid';

export interface PersistedExecutionStopResult {
  status: PersistedExecutionStopStatus;
  termSignalSent: boolean;
  killSignalSent: boolean;
}

export interface PersistedExecutionController {
  readonly executorType: ExecutorType;
  stop(input: {
    durableHandle: string;
    expectedPid?: number;
    reason: ExecutionStopReason;
  }): Promise<PersistedExecutionStopResult>;
}
