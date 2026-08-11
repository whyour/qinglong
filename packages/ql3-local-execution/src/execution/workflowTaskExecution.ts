import type {
  RunAttemptRecord,
  RunRecord,
} from '@qinglong/runtime-core/run-repository';

export type LocalWorkflowTaskTerminalStatus =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface LocalWorkflowTaskExecutionSnapshot {
  readonly runVersion: number;
  readonly runEventSequence: number;
  readonly attemptStatus: RunAttemptRecord['status'];
  readonly callbackSequence: number;
}

export type LocalWorkflowTaskExecutionMutationResult =
  | Readonly<{
      status: 'applied';
      snapshot: Readonly<LocalWorkflowTaskExecutionSnapshot>;
    }>
  | Readonly<{
      status: 'rejected';
      reason:
        | 'aggregate_mismatch'
        | 'run_not_running'
        | 'attempt_not_claimed'
        | 'attempt_not_starting'
        | 'cancellation_requested'
        | 'stale_execution_authority';
    }>;

export interface LocalWorkflowTaskExecutionRepository {
  prepare(command: Readonly<{
    runId: string;
    attemptId: string;
    stepRunId: string;
    callbackTokenHash: string;
    deadlineAtMs?: number;
    logArtifactId?: string;
    atMs: number;
    eventId: string;
  }>): Promise<Readonly<LocalWorkflowTaskExecutionMutationResult>>;
  recordRunning(command: Readonly<{
    run: Readonly<RunRecord>;
    attempt: Readonly<RunAttemptRecord>;
    callbackTokenHash: string;
    executorHandle: string;
    pid: number;
    startedAtMs: number;
    attemptEventId: string;
    stepMutationId: string;
  }>): Promise<Readonly<LocalWorkflowTaskExecutionMutationResult>>;
  recordStartFailure(command: Readonly<{
    run: Readonly<RunRecord>;
    attempt: Readonly<RunAttemptRecord>;
    callbackTokenHash: string;
    status: 'failed';
    errorCode: string;
    errorSummary: string;
    finishedAtMs: number;
    attemptEventId: string;
    stepMutationId: string;
  }>): Promise<Readonly<LocalWorkflowTaskExecutionMutationResult>>;
  complete(command: Readonly<{
    run: Readonly<RunRecord>;
    attempt: Readonly<RunAttemptRecord>;
    callbackSequence: number;
    startedAtMs: number;
    finishedAtMs: number;
    exitCode: number;
    terminalStatus: LocalWorkflowTaskTerminalStatus;
    errorCode?: string;
    errorSummary?: string;
    attemptEventId: string;
    syntheticStartMutationId: string;
    terminalStepMutationId: string;
  }>): Promise<'completed' | 'already_terminal' | 'stale'>;
  requestTimeout(command: Readonly<{
    run: Readonly<RunRecord>;
    attempt: Readonly<RunAttemptRecord>;
    dueAtMs: number;
    eventId: string;
  }>): Promise<'requested' | 'existing' | 'stale'>;
  recordControlTerminal(command: Readonly<{
    run: Readonly<RunRecord>;
    attempt: Readonly<RunAttemptRecord>;
    reason: 'user' | 'policy' | 'shutdown' | 'reconcile' | 'timeout';
    terminalStatus: 'cancelled' | 'timed_out';
    errorCode: string;
    errorSummary: string;
    finishedAtMs: number;
    attemptEventId: string;
    stepMutationId: string;
  }>): Promise<'terminal' | 'already_terminal' | 'stale'>;
}
