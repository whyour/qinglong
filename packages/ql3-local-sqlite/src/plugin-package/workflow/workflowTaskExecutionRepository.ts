import type { DatabaseSync } from 'node:sqlite';

import type {
  RunAttemptRecord,
  RunRecord,
} from '@qinglong/runtime-core/run-repository';
import {
  normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt,
  type PluginPackageWorkflowTaskAttemptAdmissionReceipt,
} from '@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission';
import {
  buildPluginPackageWorkflowTaskRecovery,
} from '@qinglong/runtime-core';
import {
  normalizeStepRunRecord,
  transitionStepRunMutation,
  type StepRunMutation,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';

import { LocalSqliteOperationAuthority } from '../../authority/operationAuthority';

type Row = Record<string, unknown>;

type RejectionReason =
  | 'aggregate_mismatch'
  | 'run_not_running'
  | 'attempt_not_claimed'
  | 'attempt_not_starting'
  | 'cancellation_requested'
  | 'stale_execution_authority';

type MutationResult =
  | Readonly<{
      status: 'applied';
      snapshot: Readonly<{
        runVersion: number;
        runEventSequence: number;
        attemptStatus: RunAttemptRecord['status'];
        callbackSequence: number;
      }>;
    }>
  | Readonly<{ status: 'rejected'; reason: RejectionReason }>;

interface Authority {
  readonly runId: string;
  readonly runStatus: string;
  readonly runVersion: number;
  readonly runEventSequence: number;
  readonly cancelRequestedAtMs?: number;
  readonly cancelReason?: string;
  readonly attemptId: string;
  readonly attemptRunId: string;
  readonly attemptStepRunId?: string;
  readonly attemptStatus: string;
  readonly executorType: string;
  readonly callbackSequence: number;
  readonly callbackTokenHash?: string;
  readonly deadlineAtMs?: number;
  readonly logArtifactId?: string;
  readonly executorHandle?: string;
  readonly pid?: number;
  readonly attemptCreatedAtMs: number;
  readonly attemptStartedAtMs?: number;
  readonly workflowTimeoutRequestedAtMs?: number;
  readonly admittedStepRunId?: string;
  readonly admittedStepRunVersion?: number;
  readonly admittedStepRunDigest?: string;
  readonly stepRun?: Readonly<StepRunRecord>;
}

const TERMINAL = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);

class LocalWorkflowTaskExecutionConcurrentWriteError extends Error {}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new TypeError(`Local SQLite Workflow Task ${key} is invalid`);
  }
  return value;
}

function optionalText(row: Row, key: string): string | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : text(row, key);
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Local SQLite Workflow Task ${key} is invalid`);
  }
  return value as number;
}

function optionalInteger(row: Row, key: string): number | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : integer(row, key);
}

function snapshot(
  authority: Authority,
  increment: number,
  attemptStatus: RunAttemptRecord['status'],
  callbackSequence = authority.callbackSequence,
): MutationResult {
  return Object.freeze({
    status: 'applied' as const,
    snapshot: Object.freeze({
      runVersion: authority.runVersion + increment,
      runEventSequence: authority.runEventSequence + increment,
      attemptStatus,
      callbackSequence,
    }),
  });
}

function rejected(reason: RejectionReason): MutationResult {
  return Object.freeze({ status: 'rejected' as const, reason });
}

function load(
  client: DatabaseSync,
  runId: string,
  attemptId: string,
): Authority | null {
  const rows = client
    .prepare(
      `SELECT
         run.id AS "runId", run.status AS "runStatus",
         run.version AS "runVersion",
         run.event_sequence AS "runEventSequence",
         run.cancel_requested_at_ms AS "cancelRequestedAtMs",
         run.cancel_reason AS "cancelReason",
         attempt.id AS "attemptId", attempt.run_id AS "attemptRunId",
         attempt.step_run_id AS "attemptStepRunId",
         attempt.status AS "attemptStatus",
         attempt.executor_type AS "executorType",
         attempt.callback_sequence AS "callbackSequence",
         attempt.callback_token_hash AS "callbackTokenHash",
         attempt.deadline_at_ms AS "deadlineAtMs",
         attempt.log_artifact_id AS "logArtifactId",
         attempt.executor_handle AS "executorHandle",
         attempt.pid AS "pid",
         attempt.created_at_ms AS "attemptCreatedAtMs",
         attempt.started_at_ms AS "attemptStartedAtMs",
         (
           SELECT event.created_at_ms
           FROM "RunEvents" AS event
           WHERE event.run_id = run.id
             AND event.attempt_id = attempt.id
             AND event.type = 'workflow.task_timeout_requested'
           ORDER BY event.sequence DESC
           LIMIT 1
         ) AS "workflowTimeoutRequestedAtMs",
         admission.step_run_id AS "admittedStepRunId",
         admission.step_run_version AS "admittedStepRunVersion",
         admission.step_run_digest AS "admittedStepRunDigest",
         step.step_run_json AS "stepRunJson"
       FROM "Runs" AS run
       JOIN "RunAttempts" AS attempt
         ON attempt.run_id = run.id AND attempt.id = ?
       LEFT JOIN "QingLong3PluginPackageWorkflowTaskAttemptAdmissions"
         AS admission ON admission.attempt_id = attempt.id
       LEFT JOIN "StepRuns" AS step
         ON step.run_id = admission.run_id
        AND step.id = admission.step_run_id
       WHERE run.id = ?
       LIMIT 2`,
    )
    .all(attemptId, runId) as Row[];
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new TypeError('Local SQLite Workflow Task authority is ambiguous');
  }
  const row = rows[0]!;
  let stepRun: Readonly<StepRunRecord> | undefined;
  const stepRunJson = optionalText(row, 'stepRunJson');
  if (stepRunJson !== undefined) {
    try {
      stepRun = normalizeStepRunRecord(
        JSON.parse(stepRunJson) as StepRunRecord,
      );
    } catch {
      throw new TypeError(
        'Local SQLite Workflow Task StepRun is invalid',
      );
    }
  }
  return Object.freeze({
    runId: text(row, 'runId'),
    runStatus: text(row, 'runStatus'),
    runVersion: integer(row, 'runVersion'),
    runEventSequence: integer(row, 'runEventSequence'),
    ...(optionalInteger(row, 'cancelRequestedAtMs') === undefined
      ? {}
      : {
          cancelRequestedAtMs: optionalInteger(
            row,
            'cancelRequestedAtMs',
          )!,
        }),
    ...(optionalText(row, 'cancelReason') === undefined
      ? {}
      : { cancelReason: optionalText(row, 'cancelReason')! }),
    attemptId: text(row, 'attemptId'),
    attemptRunId: text(row, 'attemptRunId'),
    ...(optionalText(row, 'attemptStepRunId') === undefined
      ? {}
      : { attemptStepRunId: optionalText(row, 'attemptStepRunId')! }),
    attemptStatus: text(row, 'attemptStatus'),
    executorType: text(row, 'executorType'),
    callbackSequence: integer(row, 'callbackSequence'),
    ...(optionalText(row, 'callbackTokenHash') === undefined
      ? {}
      : { callbackTokenHash: optionalText(row, 'callbackTokenHash')! }),
    ...(optionalInteger(row, 'deadlineAtMs') === undefined
      ? {}
      : { deadlineAtMs: optionalInteger(row, 'deadlineAtMs')! }),
    ...(optionalText(row, 'logArtifactId') === undefined
      ? {}
      : { logArtifactId: optionalText(row, 'logArtifactId')! }),
    ...(optionalText(row, 'executorHandle') === undefined
      ? {}
      : { executorHandle: optionalText(row, 'executorHandle')! }),
    ...(optionalInteger(row, 'pid') === undefined
      ? {}
      : { pid: optionalInteger(row, 'pid')! }),
    attemptCreatedAtMs: integer(row, 'attemptCreatedAtMs'),
    ...(optionalInteger(row, 'attemptStartedAtMs') === undefined
      ? {}
      : {
          attemptStartedAtMs: optionalInteger(
            row,
            'attemptStartedAtMs',
          )!,
        }),
    ...(optionalInteger(row, 'workflowTimeoutRequestedAtMs') === undefined
      ? {}
      : {
          workflowTimeoutRequestedAtMs: optionalInteger(
            row,
            'workflowTimeoutRequestedAtMs',
          )!,
        }),
    ...(optionalText(row, 'admittedStepRunId') === undefined
      ? {}
      : { admittedStepRunId: optionalText(row, 'admittedStepRunId')! }),
    ...(optionalInteger(row, 'admittedStepRunVersion') === undefined
      ? {}
      : {
          admittedStepRunVersion: optionalInteger(
            row,
            'admittedStepRunVersion',
          )!,
        }),
    ...(optionalText(row, 'admittedStepRunDigest') === undefined
      ? {}
      : {
          admittedStepRunDigest: optionalText(
            row,
            'admittedStepRunDigest',
          )!,
        }),
    ...(stepRun === undefined ? {} : { stepRun }),
  });
}

function exactWorkflowTask(
  authority: Authority,
  runId: string,
  attemptId: string,
  stepRunId: string,
): boolean {
  return Boolean(
    authority.runId === runId &&
      authority.attemptId === attemptId &&
      authority.attemptRunId === runId &&
      authority.attemptStepRunId === stepRunId &&
      authority.admittedStepRunId === stepRunId &&
      authority.stepRun?.runId === runId &&
      authority.stepRun.id === stepRunId &&
      authority.executorType === 'local_process',
  );
}

function atAdmissionEpoch(authority: Authority): boolean {
  return Boolean(
    authority.stepRun &&
      authority.stepRun.version === authority.admittedStepRunVersion &&
      authority.stepRun.stepRunDigest ===
        authority.admittedStepRunDigest,
  );
}

function updateRun(
  client: DatabaseSync,
  authority: Authority,
  increment: number,
): boolean {
  return (
    client
      .prepare(
        `UPDATE "Runs"
         SET version = version + ?, event_sequence = event_sequence + ?
         WHERE id = ? AND status = 'running'
           AND version = ? AND event_sequence = ?`,
      )
      .run(
        increment,
        increment,
        authority.runId,
        authority.runVersion,
        authority.runEventSequence,
      ).changes === 1
  );
}

function insertAttemptEvent(
  client: DatabaseSync,
  command: Readonly<{
    id: string;
    authority: Authority;
    sequence: number;
    type: string;
    dedupeKey: string;
    payload: Readonly<Record<string, unknown>>;
    atMs: number;
    actorType?: string;
    actorId?: string;
  }>,
): void {
  client
    .prepare(
      `INSERT INTO "RunEvents" (
         id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
         attempt_id, step_run_id, payload, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      command.id,
      command.authority.runId,
      command.sequence,
      command.type,
      command.dedupeKey,
      command.actorType ?? 'executor',
      command.actorId ?? 'local_process',
      command.authority.attemptId,
      command.authority.attemptStepRunId!,
      JSON.stringify(command.payload),
      command.atMs,
    );
}

function updateStepRun(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
): void {
  const stepRun = mutation.stepRun;
  const updated = client
    .prepare(
      `UPDATE "StepRuns"
       SET status = ?, version = ?, attempt_count = ?, output_ref = ?,
           approval_request_id = ?, ready_at_ms = ?, started_at_ms = ?,
           finished_at_ms = ?, result_code = ?, error_summary = ?,
           updated_at_ms = ?, last_mutation_id = ?, step_run_digest = ?,
           step_run_json = ?
       WHERE id = ? AND run_id = ? AND version = ?
         AND step_run_digest = ? AND status = ?`,
    )
    .run(
      stepRun.status,
      stepRun.version,
      stepRun.attemptCount,
      stepRun.outputRef,
      stepRun.approvalRequestId,
      stepRun.readyAtMs,
      stepRun.startedAtMs,
      stepRun.finishedAtMs,
      stepRun.resultCode,
      stepRun.errorSummary,
      stepRun.updatedAtMs,
      stepRun.lastMutationId,
      stepRun.stepRunDigest,
      JSON.stringify(stepRun),
      stepRun.id,
      stepRun.runId,
      mutation.expectedStepRunVersion,
      mutation.expectedStepRunDigest,
      mutation.previousStatus,
    );
  if (updated.changes !== 1) {
    throw new TypeError('Local SQLite Workflow Task StepRun changed');
  }
}

function insertStepMutation(
  client: DatabaseSync,
  mutation: Readonly<StepRunMutation>,
  committedAtMs: number,
  attemptId: string,
): void {
  const event = mutation.event;
  client
    .prepare(
      `INSERT INTO "RunEvents" (
         id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
         attempt_id, step_run_id, payload, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.id,
      event.runId,
      event.sequence,
      event.type,
      event.dedupeKey ?? null,
      event.actorType,
      event.actorId ?? null,
      attemptId,
      mutation.stepRun.id,
      JSON.stringify(event.payload),
      event.createdAtMs,
    );
  client
    .prepare(
      `INSERT INTO "StepRunMutations" (
         mutation_id, mutation_digest, run_id, step_run_id,
         step_run_digest, event_id, event_sequence, run_version,
         step_run_json, committed_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      mutation.mutationId,
      mutation.mutationDigest,
      mutation.runId,
      mutation.stepRun.id,
      mutation.stepRun.stepRunDigest,
      event.id,
      event.sequence,
      mutation.expectedRunVersion + 1,
      JSON.stringify(mutation.stepRun),
      committedAtMs,
    );
}

function samePrepared(
  authority: Authority,
  run: Readonly<RunRecord>,
  attempt: Readonly<RunAttemptRecord>,
  callbackTokenHash: string,
): boolean {
  return Boolean(
    exactWorkflowTask(
      authority,
      run.id,
      attempt.id,
      attempt.stepRunId ?? '',
    ) &&
      authority.runVersion === run.version &&
      authority.runEventSequence === run.eventSequence &&
      authority.runStatus === 'running' &&
      authority.attemptStatus === 'starting' &&
      authority.callbackSequence === attempt.callbackSequence &&
      authority.callbackTokenHash === callbackTokenHash,
  );
}

function terminalResultCode(
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out',
): string | undefined {
  if (status === 'succeeded') return undefined;
  return status === 'failed'
    ? 'execution_failed'
    : status === 'cancelled'
      ? 'execution_cancelled'
      : 'execution_timed_out';
}

function resolvedTerminal(
  authority: Authority,
  command: Readonly<{
    terminalStatus: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
    errorCode?: string;
    errorSummary?: string;
  }>,
): Readonly<{
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  errorCode?: string;
  errorSummary?: string;
}> {
  if (authority.cancelRequestedAtMs !== undefined) {
    return authority.cancelReason === 'timeout'
      ? Object.freeze({
          status: 'timed_out' as const,
          errorCode: 'EXECUTION_TIMED_OUT',
          errorSummary: 'Execution exceeded its configured timeout',
        })
      : Object.freeze({
          status: 'cancelled' as const,
          errorCode: 'EXECUTION_CANCELLED',
          errorSummary: 'Execution was cancelled',
        });
  }
  if (authority.workflowTimeoutRequestedAtMs !== undefined) {
    return Object.freeze({
      status: 'timed_out' as const,
      errorCode: 'EXECUTION_TIMED_OUT',
      errorSummary: 'Execution exceeded its configured timeout',
    });
  }
  return Object.freeze({
    status: command.terminalStatus,
    ...(command.errorCode === undefined
      ? {}
      : {
          errorCode: command.errorCode,
          errorSummary: command.errorSummary,
        }),
  });
}

/**
 * Persists local-process ownership at Workflow Task scope. The parent Run
 * remains `running`; only its counters, the bound Attempt, and the exact
 * admission-epoch StepRun are mutated.
 */
export class LocalSqliteWorkflowTaskExecutionRepository {
  readonly #authority: LocalSqliteOperationAuthority;

  constructor(authority: LocalSqliteOperationAuthority | DatabaseSync) {
    this.#authority =
      authority instanceof LocalSqliteOperationAuthority
        ? authority
        : new LocalSqliteOperationAuthority(authority);
  }

  #enqueue<T>(work: (client: DatabaseSync) => T): Promise<T> {
    return this.#authority.enqueue(
      async () => {
        let began = false;
        try {
          this.#authority.client.exec('BEGIN IMMEDIATE');
          began = true;
          const result = work(this.#authority.client);
          this.#authority.client.exec('COMMIT');
          began = false;
          return result;
        } catch (error) {
          if (began) {
            try {
              this.#authority.client.exec('ROLLBACK');
            } catch {
              // Preserve the authority failure.
            }
          }
          throw error;
        }
      },
      () =>
        new Error('Local SQLite Workflow Task execution is unavailable'),
    );
  }

  #read<T>(work: (client: DatabaseSync) => T): Promise<T> {
    return this.#authority.enqueue(
      async () => work(this.#authority.client),
      () =>
        new Error('Local SQLite Workflow Task execution is unavailable'),
    );
  }

  prepare(command: Readonly<{
    runId: string;
    attemptId: string;
    stepRunId: string;
    callbackTokenHash: string;
    deadlineAtMs?: number;
    logArtifactId?: string;
    atMs: number;
    eventId: string;
  }>): Promise<Readonly<MutationResult>> {
    return this.#enqueue((client) => {
      const authority = load(client, command.runId, command.attemptId);
      if (
        !authority ||
        !exactWorkflowTask(
          authority,
          command.runId,
          command.attemptId,
          command.stepRunId,
        )
      ) {
        return rejected('aggregate_mismatch');
      }
      if (authority.runStatus !== 'running') {
        return rejected('run_not_running');
      }
      if (authority.cancelRequestedAtMs !== undefined) {
        return rejected('cancellation_requested');
      }
      if (authority.attemptStatus !== 'claimed') {
        return rejected('attempt_not_claimed');
      }
      if (
        authority.stepRun?.status !== 'ready' ||
        !atAdmissionEpoch(authority) ||
        authority.callbackSequence !== 0 ||
        authority.callbackTokenHash !== undefined ||
        authority.deadlineAtMs !== undefined ||
        authority.logArtifactId !== undefined ||
        authority.executorHandle !== undefined ||
        authority.pid !== undefined ||
        command.atMs < authority.attemptCreatedAtMs
      ) {
        return rejected('stale_execution_authority');
      }
      const attempt = client
        .prepare(
          `UPDATE "RunAttempts"
           SET status = 'starting', callback_token_hash = ?,
               deadline_at_ms = ?, log_artifact_id = ?
           WHERE id = ? AND run_id = ? AND step_run_id = ?
             AND status = 'claimed' AND callback_sequence = 0`,
        )
        .run(
          command.callbackTokenHash,
          command.deadlineAtMs ?? null,
          command.logArtifactId ?? null,
          command.attemptId,
          command.runId,
          command.stepRunId,
        );
      if (attempt.changes !== 1 || !updateRun(client, authority, 1)) {
        throw new LocalWorkflowTaskExecutionConcurrentWriteError();
      }
      insertAttemptEvent(client, {
        id: command.eventId,
        authority,
        sequence: authority.runEventSequence + 1,
        type: 'workflow.task_attempt.starting',
        dedupeKey:
          `local-workflow-execution:${command.attemptId}:starting`,
        payload: Object.freeze({
          attempt_id: command.attemptId,
          step_run_id: command.stepRunId,
          execution_scope: 'workflow_task',
          from_status: 'claimed',
          to_status: 'starting',
          deadline_at_ms: command.deadlineAtMs ?? null,
        }),
        atMs: command.atMs,
      });
      return snapshot(authority, 1, 'starting');
    });
  }

  recordRunning(command: Readonly<{
    run: Readonly<RunRecord>;
    attempt: Readonly<RunAttemptRecord>;
    callbackTokenHash: string;
    executorHandle: string;
    pid: number;
    startedAtMs: number;
    attemptEventId: string;
    stepMutationId: string;
  }>): Promise<Readonly<MutationResult>> {
    return this.#enqueue((client) => {
      const authority = load(
        client,
        command.run.id,
        command.attempt.id,
      );
      if (
        !authority ||
        !samePrepared(
          authority,
          command.run,
          command.attempt,
          command.callbackTokenHash,
        )
      ) {
        return rejected('stale_execution_authority');
      }
      if (authority.cancelRequestedAtMs !== undefined) {
        return rejected('cancellation_requested');
      }
      if (
        authority.stepRun?.status !== 'ready' ||
        !atAdmissionEpoch(authority)
      ) {
        return rejected('stale_execution_authority');
      }
      const attempt = client
        .prepare(
          `UPDATE "RunAttempts"
           SET status = 'running', executor_handle = ?, pid = ?,
               started_at_ms = ?
           WHERE id = ? AND run_id = ? AND status = 'starting'
             AND callback_sequence = ?
             AND callback_token_hash = ?`,
        )
        .run(
          command.executorHandle,
          command.pid,
          command.startedAtMs,
          command.attempt.id,
          command.run.id,
          command.attempt.callbackSequence,
          command.callbackTokenHash,
        );
      const mutation = transitionStepRunMutation(
        authority.stepRun,
        {
          expectedVersion: authority.stepRun.version,
          expectedDigest: authority.stepRun.stepRunDigest,
          mutationId: command.stepMutationId,
          to: 'running',
          atMs: command.startedAtMs,
        },
        {
          expectedRunVersion: authority.runVersion + 1,
          expectedRunEventSequence: authority.runEventSequence + 1,
          eventId: command.stepMutationId,
          dedupeKey:
            `local-workflow-execution:${command.attempt.id}:running-step`,
          actor: { type: 'executor', id: 'local_process' },
        },
      );
      if (attempt.changes !== 1 || !updateRun(client, authority, 2)) {
        throw new LocalWorkflowTaskExecutionConcurrentWriteError();
      }
      updateStepRun(client, mutation);
      insertAttemptEvent(client, {
        id: command.attemptEventId,
        authority,
        sequence: authority.runEventSequence + 1,
        type: 'workflow.task_attempt.running',
        dedupeKey:
          `local-workflow-execution:${command.attempt.id}:running-attempt`,
        payload: Object.freeze({
          attempt_id: command.attempt.id,
          step_run_id: command.attempt.stepRunId,
          execution_scope: 'workflow_task',
          from_status: 'starting',
          to_status: 'running',
          pid: command.pid,
        }),
        atMs: command.startedAtMs,
      });
      insertStepMutation(
        client,
        mutation,
        command.startedAtMs,
        command.attempt.id,
      );
      return snapshot(authority, 2, 'running');
    });
  }

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
  }>): Promise<Readonly<MutationResult>> {
    return this.#enqueue((client) => {
      const authority = load(
        client,
        command.run.id,
        command.attempt.id,
      );
      if (
        !authority ||
        !samePrepared(
          authority,
          command.run,
          command.attempt,
          command.callbackTokenHash,
        ) ||
        authority.stepRun?.status !== 'ready' ||
        !atAdmissionEpoch(authority)
      ) {
        return rejected('attempt_not_starting');
      }
      const attempt = client
        .prepare(
          `UPDATE "RunAttempts"
           SET status = 'failed', finished_at_ms = ?,
               error_code = ?, error_summary = ?
           WHERE id = ? AND run_id = ? AND status = 'starting'
             AND callback_sequence = ? AND callback_token_hash = ?`,
        )
        .run(
          command.finishedAtMs,
          command.errorCode,
          command.errorSummary,
          command.attempt.id,
          command.run.id,
          command.attempt.callbackSequence,
          command.callbackTokenHash,
        );
      const mutation = transitionStepRunMutation(
        authority.stepRun,
        {
          expectedVersion: authority.stepRun.version,
          expectedDigest: authority.stepRun.stepRunDigest,
          mutationId: command.stepMutationId,
          to: 'failed',
          atMs: command.finishedAtMs,
          resultCode: command.errorCode.toLowerCase(),
          errorSummary: command.errorSummary,
        },
        {
          expectedRunVersion: authority.runVersion + 1,
          expectedRunEventSequence: authority.runEventSequence + 1,
          eventId: command.stepMutationId,
          dedupeKey:
            `local-workflow-execution:${command.attempt.id}:start-failed-step`,
          actor: { type: 'executor', id: 'local_process' },
        },
      );
      if (attempt.changes !== 1 || !updateRun(client, authority, 2)) {
        throw new LocalWorkflowTaskExecutionConcurrentWriteError();
      }
      updateStepRun(client, mutation);
      insertAttemptEvent(client, {
        id: command.attemptEventId,
        authority,
        sequence: authority.runEventSequence + 1,
        type: 'workflow.task_attempt.failed',
        dedupeKey:
          `local-workflow-execution:${command.attempt.id}:start-failed-attempt`,
        payload: Object.freeze({
          attempt_id: command.attempt.id,
          step_run_id: command.attempt.stepRunId,
          execution_scope: 'workflow_task',
          from_status: 'starting',
          to_status: 'failed',
          error_code: command.errorCode,
        }),
        atMs: command.finishedAtMs,
      });
      insertStepMutation(
        client,
        mutation,
        command.finishedAtMs,
        command.attempt.id,
      );
      return snapshot(authority, 2, 'failed');
    });
  }

  complete(command: Readonly<{
    run: Readonly<RunRecord>;
    attempt: Readonly<RunAttemptRecord>;
    callbackSequence: number;
    startedAtMs: number;
    finishedAtMs: number;
    exitCode: number;
    terminalStatus: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
    errorCode?: string;
    errorSummary?: string;
    attemptEventId: string;
    syntheticStartMutationId: string;
    terminalStepMutationId: string;
  }>): Promise<'completed' | 'already_terminal' | 'stale'> {
    return this.#enqueue((client) => {
      const authority = load(
        client,
        command.run.id,
        command.attempt.id,
      );
      if (
        !authority ||
        !exactWorkflowTask(
          authority,
          command.run.id,
          command.attempt.id,
          command.attempt.stepRunId ?? '',
        ) ||
        !authority.stepRun
      ) {
        return 'stale';
      }
      const terminal = resolvedTerminal(authority, command);
      if (
        TERMINAL.has(authority.attemptStatus) ||
        TERMINAL.has(authority.stepRun.status)
      ) {
        return authority.attemptStatus === terminal.status &&
          authority.stepRun.status === terminal.status
          ? 'already_terminal'
          : 'stale';
      }
      if (
        authority.runStatus !== 'running' ||
        authority.runVersion !== command.run.version ||
        authority.runEventSequence !== command.run.eventSequence ||
        authority.callbackSequence !== command.attempt.callbackSequence ||
        authority.callbackTokenHash !== command.attempt.callbackTokenHash ||
        (authority.attemptStatus !== 'starting' &&
          authority.attemptStatus !== 'running') ||
        (authority.attemptStatus === 'starting'
          ? authority.stepRun.status !== 'ready' ||
            !atAdmissionEpoch(authority)
          : authority.stepRun.status !== 'running')
      ) {
        return 'stale';
      }
      const syntheticStart = authority.attemptStatus === 'starting';
      const increment = syntheticStart ? 3 : 2;
      const attemptSequence =
        authority.runEventSequence + (syntheticStart ? 2 : 1);
      const terminalSequence = authority.runEventSequence + increment;
      const startedMutation = syntheticStart
        ? transitionStepRunMutation(
            authority.stepRun,
            {
              expectedVersion: authority.stepRun.version,
              expectedDigest: authority.stepRun.stepRunDigest,
              mutationId: command.syntheticStartMutationId,
              to: 'running',
              atMs: Math.max(
                command.startedAtMs,
                authority.stepRun.updatedAtMs,
              ),
            },
            {
              expectedRunVersion: authority.runVersion,
              expectedRunEventSequence: authority.runEventSequence,
              eventId: command.syntheticStartMutationId,
              dedupeKey:
                `local-workflow-completion:${command.attempt.id}:synthetic-start`,
              actor: { type: 'executor', id: 'local_process' },
            },
          )
        : null;
      const terminalSource = startedMutation?.stepRun ?? authority.stepRun;
      const resultCode = terminalResultCode(terminal.status);
      const terminalMutation = transitionStepRunMutation(
        terminalSource,
        {
          expectedVersion: terminalSource.version,
          expectedDigest: terminalSource.stepRunDigest,
          mutationId: command.terminalStepMutationId,
          to: terminal.status,
          atMs: Math.max(
            command.finishedAtMs,
            terminalSource.updatedAtMs,
          ),
          ...(resultCode === undefined ? {} : { resultCode }),
          ...(terminal.status === 'failed' ||
          terminal.status === 'timed_out'
            ? { errorSummary: terminal.errorSummary }
            : {}),
        },
        {
          expectedRunVersion:
            authority.runVersion + (syntheticStart ? 2 : 1),
          expectedRunEventSequence: terminalSequence - 1,
          eventId: command.terminalStepMutationId,
          dedupeKey:
            `local-workflow-completion:${command.attempt.id}:terminal-step`,
          actor: { type: 'executor', id: 'local_process' },
        },
      );
      const attempt = client
        .prepare(
          `UPDATE "RunAttempts"
           SET status = ?, callback_sequence = ?,
               started_at_ms = COALESCE(started_at_ms, ?),
               finished_at_ms = ?, exit_code = ?,
               error_code = ?, error_summary = ?
           WHERE id = ? AND run_id = ? AND status = ?
             AND callback_sequence = ? AND callback_token_hash = ?`,
        )
        .run(
          terminal.status,
          command.callbackSequence,
          command.startedAtMs,
          command.finishedAtMs,
          command.exitCode,
          terminal.errorCode ?? null,
          terminal.errorSummary ?? null,
          command.attempt.id,
          command.run.id,
          authority.attemptStatus,
          authority.callbackSequence,
          authority.callbackTokenHash ?? null,
        );
      if (attempt.changes !== 1 || !updateRun(client, authority, increment)) {
        throw new LocalWorkflowTaskExecutionConcurrentWriteError();
      }
      if (startedMutation) {
        updateStepRun(client, startedMutation);
        insertStepMutation(
          client,
          startedMutation,
          command.finishedAtMs,
          command.attempt.id,
        );
      }
      updateStepRun(client, terminalMutation);
      insertAttemptEvent(client, {
        id: command.attemptEventId,
        authority,
        sequence: attemptSequence,
        type: `workflow.task_attempt.${terminal.status}`,
        dedupeKey:
          `local-workflow-completion:${command.attempt.id}:attempt`,
        payload: Object.freeze({
          attempt_id: command.attempt.id,
          step_run_id: command.attempt.stepRunId,
          execution_scope: 'workflow_task',
          from_status: authority.attemptStatus,
          to_status: terminal.status,
          callback_sequence: command.callbackSequence,
          exit_code: command.exitCode,
          error_code: terminal.errorCode ?? null,
        }),
        atMs: command.finishedAtMs,
      });
      insertStepMutation(
        client,
        terminalMutation,
        command.finishedAtMs,
        command.attempt.id,
      );
      return 'completed';
    });
  }

  requestTimeout(command: Readonly<{
    run: Readonly<RunRecord>;
    attempt: Readonly<RunAttemptRecord>;
    dueAtMs: number;
    eventId: string;
  }>): Promise<'requested' | 'existing' | 'stale'> {
    return this.#enqueue((client) => {
      const authority = load(
        client,
        command.run.id,
        command.attempt.id,
      );
      if (
        !authority ||
        !exactWorkflowTask(
          authority,
          command.run.id,
          command.attempt.id,
          command.attempt.stepRunId ?? '',
        ) ||
        !authority.stepRun
      ) {
        return 'stale';
      }
      if (authority.workflowTimeoutRequestedAtMs !== undefined) {
        return 'existing';
      }
      if (
        authority.runStatus !== 'running' ||
        authority.runVersion !== command.run.version ||
        authority.runEventSequence !== command.run.eventSequence ||
        authority.cancelRequestedAtMs !== undefined ||
        authority.callbackSequence !== command.attempt.callbackSequence ||
        authority.deadlineAtMs === undefined ||
        authority.deadlineAtMs > command.dueAtMs ||
        !['claimed', 'starting', 'running'].includes(
          authority.attemptStatus,
        ) ||
        (authority.attemptStatus === 'running'
          ? authority.stepRun.status !== 'running'
          : authority.stepRun.status !== 'ready' ||
            !atAdmissionEpoch(authority))
      ) {
        return 'stale';
      }
      const atMs = Math.max(
        command.dueAtMs,
        authority.deadlineAtMs,
        authority.attemptCreatedAtMs,
        authority.attemptStartedAtMs ?? 0,
      );
      if (!updateRun(client, authority, 1)) {
        throw new LocalWorkflowTaskExecutionConcurrentWriteError();
      }
      insertAttemptEvent(client, {
        id: command.eventId,
        authority,
        sequence: authority.runEventSequence + 1,
        type: 'workflow.task_timeout_requested',
        dedupeKey:
          `local-workflow-control:${command.attempt.id}:timeout`,
        payload: Object.freeze({
          attempt_id: command.attempt.id,
          step_run_id: command.attempt.stepRunId,
          execution_scope: 'workflow_task',
          reason: 'timeout',
          deadline_at_ms: authority.deadlineAtMs,
        }),
        actorType: 'reconciler',
        actorId: 'local-deadline',
        atMs,
      });
      return 'requested';
    });
  }

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
  }>): Promise<'terminal' | 'already_terminal' | 'stale'> {
    return this.#enqueue((client) => {
      const authority = load(
        client,
        command.run.id,
        command.attempt.id,
      );
      if (
        !authority ||
        !exactWorkflowTask(
          authority,
          command.run.id,
          command.attempt.id,
          command.attempt.stepRunId ?? '',
        ) ||
        !authority.stepRun
      ) {
        return 'stale';
      }
      if (
        TERMINAL.has(authority.attemptStatus) ||
        TERMINAL.has(authority.stepRun.status)
      ) {
        return authority.attemptStatus === command.terminalStatus &&
          authority.stepRun.status === command.terminalStatus
          ? 'already_terminal'
          : 'stale';
      }
      const timeoutAuthority =
        command.reason !== 'timeout' ||
        authority.cancelReason === 'timeout' ||
        authority.workflowTimeoutRequestedAtMs !== undefined;
      const cancellationAuthority =
        command.reason === 'timeout' ||
        (authority.cancelRequestedAtMs !== undefined &&
          authority.cancelReason === command.reason);
      if (
        authority.runStatus !== 'running' ||
        authority.runVersion !== command.run.version ||
        authority.runEventSequence !== command.run.eventSequence ||
        authority.callbackSequence !== command.attempt.callbackSequence ||
        authority.attemptStatus !== command.attempt.status ||
        !['claimed', 'starting', 'running'].includes(
          authority.attemptStatus,
        ) ||
        !timeoutAuthority ||
        !cancellationAuthority ||
        (authority.attemptStatus === 'running'
          ? authority.stepRun.status !== 'running'
          : authority.stepRun.status !== 'ready' ||
            !atAdmissionEpoch(authority))
      ) {
        return 'stale';
      }
      const resultCode =
        command.terminalStatus === 'timed_out'
          ? 'execution_timed_out'
          : 'execution_cancelled';
      const mutation = transitionStepRunMutation(
        authority.stepRun,
        {
          expectedVersion: authority.stepRun.version,
          expectedDigest: authority.stepRun.stepRunDigest,
          mutationId: command.stepMutationId,
          to: command.terminalStatus,
          atMs: Math.max(
            command.finishedAtMs,
            authority.stepRun.updatedAtMs,
          ),
          resultCode,
          ...(command.terminalStatus === 'timed_out'
            ? { errorSummary: command.errorSummary }
            : {}),
        },
        {
          expectedRunVersion: authority.runVersion + 1,
          expectedRunEventSequence: authority.runEventSequence + 1,
          eventId: command.stepMutationId,
          dedupeKey:
            `local-workflow-control:${command.attempt.id}:terminal-step`,
          actor: {
            type: 'reconciler',
            id: 'local-execution-control',
          },
        },
      );
      const attempt = client
        .prepare(
          `UPDATE "RunAttempts"
           SET status = ?, finished_at_ms = ?,
               error_code = ?, error_summary = ?
           WHERE id = ? AND run_id = ? AND status = ?
             AND callback_sequence = ?`,
        )
        .run(
          command.terminalStatus,
          command.finishedAtMs,
          command.errorCode,
          command.errorSummary,
          command.attempt.id,
          command.run.id,
          authority.attemptStatus,
          authority.callbackSequence,
        );
      if (attempt.changes !== 1 || !updateRun(client, authority, 2)) {
        throw new LocalWorkflowTaskExecutionConcurrentWriteError();
      }
      updateStepRun(client, mutation);
      insertAttemptEvent(client, {
        id: command.attemptEventId,
        authority,
        sequence: authority.runEventSequence + 1,
        type: `workflow.task_attempt.${command.terminalStatus}`,
        dedupeKey:
          `local-workflow-control:${command.attempt.id}:terminal-attempt`,
        payload: Object.freeze({
          attempt_id: command.attempt.id,
          step_run_id: command.attempt.stepRunId,
          execution_scope: 'workflow_task',
          from_status: authority.attemptStatus,
          to_status: command.terminalStatus,
          reason: command.reason,
          error_code: command.errorCode,
        }),
        actorType: 'reconciler',
        actorId: 'local-execution-control',
        atMs: command.finishedAtMs,
      });
      insertStepMutation(
        client,
        mutation,
        command.finishedAtMs,
        command.attempt.id,
      );
      return 'terminal';
    });
  }

  listRecoveryCandidates(command: Readonly<{
    limit: number;
  }>): Promise<Readonly<{
    candidates: readonly Readonly<{
      runId: string;
      attemptId: string;
      attemptCreatedAtMs: number;
    }>[];
    truncated: boolean;
  }>> {
    if (
      !command ||
      typeof command !== 'object' ||
      Array.isArray(command) ||
      !Number.isSafeInteger(command.limit) ||
      command.limit < 1 ||
      command.limit > 64
    ) {
      throw new RangeError(
        'Local Workflow Task recovery page size is invalid',
      );
    }
    return this.#read((client) => {
      const rows = client
        .prepare(
          `SELECT attempt.run_id AS "runId",
                  attempt.id AS "attemptId",
                  attempt.created_at_ms AS "attemptCreatedAtMs"
           FROM "RunAttempts" AS attempt
           JOIN "Runs" AS run ON run.id = attempt.run_id
           JOIN "QingLong3PluginPackageWorkflowTaskAttemptAdmissions"
             AS admission
             ON admission.attempt_id = attempt.id
            AND admission.run_id = attempt.run_id
            AND admission.step_run_id = attempt.step_run_id
           WHERE run.status = 'running'
             AND run.execution_owner = 'runtime'
             AND run.cancel_requested_at_ms IS NULL
             AND attempt.status IN ('claimed','starting','running')
             AND attempt.executor_type = 'local_process'
           ORDER BY attempt.created_at_ms, attempt.id
           LIMIT ?`,
        )
        .all(command.limit + 1) as Row[];
      const truncated = rows.length > command.limit;
      return Object.freeze({
        candidates: Object.freeze(
          rows.slice(0, command.limit).map((row) =>
            Object.freeze({
              runId: text(row, 'runId'),
              attemptId: text(row, 'attemptId'),
              attemptCreatedAtMs: integer(row, 'attemptCreatedAtMs'),
            }),
          ),
        ),
        truncated,
      });
    });
  }

  recover(command: Readonly<{
    run: Readonly<RunRecord>;
    attempt: Readonly<RunAttemptRecord>;
    reason: 'unstarted_claim_expired' | 'execution_not_running';
    observedAtMs: number;
  }>): Promise<'requeued' | 'failed' | 'already_recovered' | 'stale'> {
    return this.#enqueue((client) => {
      const authority = load(
        client,
        command.run.id,
        command.attempt.id,
      );
      if (!authority) return 'stale';
      if (TERMINAL.has(authority.attemptStatus)) {
        return 'already_recovered';
      }
      if (
        !exactWorkflowTask(
          authority,
          command.run.id,
          command.attempt.id,
          command.attempt.stepRunId ?? '',
        ) ||
        !authority.stepRun ||
        authority.runStatus !== 'running' ||
        authority.runVersion !== command.run.version ||
        authority.runEventSequence !== command.run.eventSequence ||
        authority.cancelRequestedAtMs !== undefined ||
        authority.attemptStatus !== command.attempt.status ||
        authority.callbackSequence !== command.attempt.callbackSequence ||
        authority.callbackTokenHash !== command.attempt.callbackTokenHash ||
        authority.executorHandle !== command.attempt.executorHandle ||
        authority.pid !== command.attempt.pid ||
        authority.attemptCreatedAtMs !== command.attempt.createdAtMs ||
        authority.attemptStartedAtMs !== command.attempt.startedAtMs
      ) {
        return 'stale';
      }
      const receiptRows = client
        .prepare(
          `SELECT receipt_json AS "receiptJson"
           FROM "QingLong3PluginPackageWorkflowTaskAttemptAdmissions"
           WHERE run_id = ? AND attempt_id = ?
           LIMIT 2`,
        )
        .all(command.run.id, command.attempt.id) as Row[];
      if (receiptRows.length !== 1) return 'stale';
      let admission:
        Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt>;
      try {
        admission =
          normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt(
            JSON.parse(
              text(receiptRows[0]!, 'receiptJson'),
            ) as PluginPackageWorkflowTaskAttemptAdmissionReceipt,
          );
      } catch {
        return 'stale';
      }
      const bundle = buildPluginPackageWorkflowTaskRecovery({
        admission,
        run: command.run,
        attempt: command.attempt,
        stepRun: authority.stepRun,
        reason: command.reason,
        observedAtMs: command.observedAtMs,
      });
      const run = client
        .prepare(
          `UPDATE "Runs"
           SET version = ?, event_sequence = ?
           WHERE id = ? AND status = 'running'
             AND cancel_requested_at_ms IS NULL
             AND version = ? AND event_sequence = ?`,
        )
        .run(
          bundle.run.version,
          bundle.run.eventSequence,
          command.run.id,
          command.run.version,
          command.run.eventSequence,
        );
      const attempt = client
        .prepare(
          `UPDATE "RunAttempts"
           SET status = ?, finished_at_ms = ?,
               error_code = ?, error_summary = ?
           WHERE id = ? AND run_id = ? AND status = ?
             AND callback_sequence = ?`,
        )
        .run(
          bundle.attempt.status,
          bundle.attempt.finishedAtMs ?? null,
          bundle.attempt.errorCode ?? null,
          bundle.attempt.errorSummary ?? null,
          command.attempt.id,
          command.run.id,
          command.attempt.status,
          command.attempt.callbackSequence,
        );
      if (run.changes !== 1 || attempt.changes !== 1) {
        throw new LocalWorkflowTaskExecutionConcurrentWriteError();
      }
      insertAttemptEvent(client, {
        id: bundle.attemptEvent.id,
        authority,
        sequence: bundle.attemptEvent.sequence,
        type: bundle.attemptEvent.type,
        dedupeKey: bundle.attemptEvent.dedupeKey!,
        payload: bundle.attemptEvent.payload,
        actorType: bundle.attemptEvent.actorType,
        actorId: bundle.attemptEvent.actorId ?? 'local-startup',
        atMs: bundle.attemptEvent.createdAtMs,
      });
      for (const mutation of bundle.stepMutations) {
        updateStepRun(client, mutation);
        insertStepMutation(
          client,
          mutation,
          command.observedAtMs,
          command.attempt.id,
        );
      }
      return bundle.disposition;
    });
  }
}
