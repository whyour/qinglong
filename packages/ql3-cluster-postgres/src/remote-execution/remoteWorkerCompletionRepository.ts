// PostgreSQL Remote Worker completion persistence is owned by this domain.
import { createHash } from 'node:crypto';

import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import { digestRunDispatchLeaseToken } from '@qinglong/runtime-core';
import {
  InvalidRemoteWorkerCompletionError,
  RemoteWorkerCompletionFenceRejectedError,
  RemoteWorkerCompletionUnavailableError,
  normalizeRemoteWorkerArtifactUploadCommand,
  normalizeRemoteWorkerCompletionCommand,
  type RemoteWorkerArtifactUploadAuthorityRepository,
  type RemoteWorkerArtifactUploadCommand,
  type RemoteWorkerCompletionCommand,
  type RemoteWorkerCompletionRepository,
  type RemoteWorkerCompletionResult,
  type RemoteWorkerExecutionFence,
} from '@qinglong/runtime-core/remote-worker-completion';
import {
  normalizeStepRunRecord,
  transitionStepRunMutation,
  type StepRunMutation,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';
import { lockAttemptAuthority } from '../run/attemptAuthorityLock';

type Row = Record<string, unknown>;

const TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);
const MAX_REMOTE_WORKER_CLOCK_SKEW_MS = 5 * 60_000;

interface LockedRemoteWorkerCompletionAuthority {
  readonly worker: Row | undefined;
  readonly aggregate: Row | undefined;
  readonly lease: Row | undefined;
  readonly observedAtMs: number;
}

interface CompletionMapping {
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  readonly errorCode?:
    | 'EXECUTION_FAILED'
    | 'EXECUTION_CANCELLED'
    | 'EXECUTION_TIMED_OUT';
  readonly errorSummary?: string;
}

type CompletionMutationCommand = RemoteWorkerCompletionCommand & Readonly<{
  attemptEventId: string;
  runEventId: string;
}>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new TypeError(`PostgreSQL Remote Worker completion ${key} is invalid`);
  }
  return value;
}

function optionalText(row: Row, key: string): string | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : text(row, key);
}

function integer(row: Row, key: string): number {
  const raw = row[key];
  const value =
    typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw)
      ? Number(raw)
      : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`PostgreSQL Remote Worker completion ${key} is invalid`);
  }
  return value;
}

function optionalInteger(row: Row, key: string): number | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : integer(row, key);
}

function isWorkflowTaskAttempt(aggregate: Row): boolean {
  return (
    aggregate.workflowAttemptId !== null &&
    aggregate.workflowAttemptId !== undefined
  );
}

function workflowStepRun(aggregate: Row): Readonly<StepRunRecord> {
  try {
    const value = normalizeStepRunRecord(
      aggregate.workflowStepJson as StepRunRecord,
    );
    if (
      value.runId !== aggregate.runId ||
      value.id !== aggregate.workflowStepRunId ||
      value.id !== aggregate.attemptStepRunId ||
      value.version !== integer(aggregate, 'workflowStepVersion') ||
      value.stepRunDigest !== aggregate.workflowStepDigest
    ) {
      throw new TypeError();
    }
    return value;
  } catch {
    throw new TypeError(
      'PostgreSQL Remote Worker completion Workflow StepRun is invalid',
    );
  }
}

function workflowStepAtAdmissionEpoch(aggregate: Row): boolean {
  const stepRun = workflowStepRun(aggregate);
  return (
    stepRun.version === integer(aggregate, 'admittedWorkflowStepVersion') &&
    stepRun.stepRunDigest === aggregate.admittedWorkflowStepDigest
  );
}

function reject(
  command: Pick<RemoteWorkerExecutionFence, 'attemptId'>,
  reason: ConstructorParameters<
    typeof RemoteWorkerCompletionFenceRejectedError
  >[1],
): never {
  throw new RemoteWorkerCompletionFenceRejectedError(command.attemptId, reason);
}

function result(
  status: RemoteWorkerCompletionResult['status'],
  command: Pick<
    RemoteWorkerCompletionCommand,
    'runId' | 'attemptId' | 'callbackSequence'
  >,
): Readonly<RemoteWorkerCompletionResult> {
  return Object.freeze({
    status,
    runId: command.runId,
    attemptId: command.attemptId,
    callbackSequence: command.callbackSequence,
  });
}

function mapping(
  aggregate: Row,
  command: RemoteWorkerCompletionCommand,
  observedAtMs: number,
): Readonly<CompletionMapping> {
  if (aggregate.cancelRequestedAtMs !== null) {
    return aggregate.cancelReason === 'timeout'
      ? Object.freeze({
          status: 'timed_out' as const,
          errorCode: 'EXECUTION_TIMED_OUT' as const,
          errorSummary: 'Execution exceeded its configured timeout',
        })
      : Object.freeze({
          status: 'cancelled' as const,
          errorCode: 'EXECUTION_CANCELLED' as const,
          errorSummary: 'Execution was cancelled',
        });
  }
  if (
    isWorkflowTaskAttempt(aggregate) &&
    optionalInteger(aggregate, 'deadlineAtMs') !== undefined &&
    optionalInteger(aggregate, 'deadlineAtMs')! <= observedAtMs
  ) {
    return Object.freeze({
      status: 'timed_out',
      errorCode: 'EXECUTION_TIMED_OUT',
      errorSummary: 'Execution exceeded its configured timeout',
    });
  }
  return command.result.exitCode === 0
    ? Object.freeze({ status: 'succeeded' as const })
    : Object.freeze({
        status: 'failed' as const,
        errorCode: 'EXECUTION_FAILED' as const,
        errorSummary: 'Execution completed without success',
      });
}

function persistedCompletionMapping(
  aggregate: Row,
): Readonly<CompletionMapping> {
  switch (aggregate.attemptStatus) {
    case 'succeeded':
      return Object.freeze({ status: 'succeeded' });
    case 'failed':
      return Object.freeze({
        status: 'failed',
        errorCode: 'EXECUTION_FAILED',
        errorSummary: 'Execution completed without success',
      });
    case 'cancelled':
      return Object.freeze({
        status: 'cancelled',
        errorCode: 'EXECUTION_CANCELLED',
        errorSummary: 'Execution was cancelled',
      });
    case 'timed_out':
      return Object.freeze({
        status: 'timed_out',
        errorCode: 'EXECUTION_TIMED_OUT',
        errorSummary: 'Execution exceeded its configured timeout',
      });
    default:
      throw new TypeError(
        'PostgreSQL Remote Worker completion terminal state is invalid',
      );
  }
}

function workflowStartedEventId(
  command: CompletionMutationCommand,
): string {
  const digest = createHash('sha256')
    .update('qinglong/workflow-task-completion-start-event@v1\0')
    .update(command.attemptEventId)
    .update('\0')
    .update(command.runEventId)
    .digest('hex');
  return `wfs-${digest.slice(0, 32)}`;
}

async function begin(client: PostgresClient): Promise<void> {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
}

async function databaseNow(client: PostgresClient): Promise<number> {
  const observed = await client.query<Row>(`
    SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS "nowMs"
  `);
  if (observed.rows.length !== 1) {
    throw new TypeError('PostgreSQL Remote Worker completion clock is invalid');
  }
  return integer(observed.rows[0]!, 'nowMs');
}

function eventIdentity(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 36 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new InvalidRemoteWorkerCompletionError(`${label} is invalid`);
  }
  return value;
}

function normalizeCompletionMutationCommand(
  value: CompletionMutationCommand,
): Readonly<CompletionMutationCommand> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRemoteWorkerCompletionError(
      'completion mutation command is invalid',
    );
  }
  const { attemptEventId, runEventId, ...wire } = value;
  const command = normalizeRemoteWorkerCompletionCommand(wire);
  return Object.freeze({
    ...command,
    attemptEventId: eventIdentity(attemptEventId, 'attemptEventId'),
    runEventId: eventIdentity(runEventId, 'runEventId'),
  });
}

function assertWorkerCurrent(
  command: RemoteWorkerExecutionFence,
  worker: Row | undefined,
  observedAtMs: number,
): asserts worker is Row {
  if (
    !worker ||
    worker.workerId !== command.workerId ||
    worker.sessionId !== command.workerSessionId ||
    integer(worker, 'workerGeneration') !== command.workerGeneration
  ) {
    reject(command, 'worker_unavailable');
  }
  if (
    !['online', 'draining'].includes(String(worker.workerStatus)) ||
    integer(worker, 'workerLeaseExpiresAtMs') <= observedAtMs
  ) {
    reject(command, 'worker_unavailable');
  }
}

function assertAuthorityIdentity(
  command: RemoteWorkerExecutionFence,
  aggregate: Row | undefined,
  lease: Row | undefined,
): asserts aggregate is Row {
  if (!aggregate || !lease) reject(command, 'missing');
  const digest = digestRunDispatchLeaseToken(command.leaseToken);
  if (
    aggregate.runId !== command.runId ||
    aggregate.attemptRunId !== command.runId ||
    aggregate.projectId !== command.projectId ||
    aggregate.executionOwner !== 'runtime' ||
    aggregate.executorType !== 'remote_worker' ||
    lease.runId !== command.runId ||
    lease.workerId !== command.workerId ||
    aggregate.attemptWorkerId !== command.workerId ||
    lease.workerSessionId !== command.workerSessionId ||
    aggregate.attemptWorkerSessionId !== command.workerSessionId ||
    integer(lease, 'workerGeneration') !== command.workerGeneration ||
    integer(aggregate, 'attemptWorkerGeneration') !== command.workerGeneration ||
    integer(lease, 'leaseGeneration') !== command.leaseGeneration ||
    integer(aggregate, 'attemptLeaseGeneration') !== command.leaseGeneration ||
    lease.leaseTokenDigest !== digest ||
    aggregate.attemptLeaseTokenDigest !== digest ||
    lease.offerId !== command.offerId ||
    aggregate.attemptOfferId !== command.offerId
  ) {
    reject(command, 'authority_mismatch');
  }
  if (isWorkflowTaskAttempt(aggregate)) {
    workflowStepRun(aggregate);
  } else if (
    aggregate.attemptStepRunId !== null &&
    aggregate.attemptStepRunId !== undefined
  ) {
    reject(command, 'authority_mismatch');
  }
}

function assertLiveLease(
  command: RemoteWorkerExecutionFence,
  aggregate: Row,
  lease: Row,
  observedAtMs: number,
): void {
  if (
    lease.leaseStatus !== 'leased' ||
    integer(lease, 'leaseVersion') !== command.expectedLeaseVersion ||
    integer(aggregate, 'attemptLeaseVersion') !== command.expectedLeaseVersion
  ) {
    reject(command, 'authority_mismatch');
  }
  if (integer(lease, 'leaseExpiresAtMs') <= observedAtMs) {
    reject(command, 'lease_expired');
  }
}

function assertActiveState(
  command: RemoteWorkerExecutionFence,
  aggregate: Row,
): 'starting' | 'running' {
  if (isWorkflowTaskAttempt(aggregate)) {
    const stepRun = workflowStepRun(aggregate);
    if (
      aggregate.attemptStatus === 'starting' &&
      aggregate.runStatus === 'running' &&
      stepRun.status === 'ready' &&
      workflowStepAtAdmissionEpoch(aggregate)
    ) {
      return 'starting';
    }
    if (
      aggregate.attemptStatus === 'running' &&
      aggregate.runStatus === 'running' &&
      stepRun.status === 'running'
    ) {
      return 'running';
    }
    reject(command, 'state_mismatch');
  }
  if (
    aggregate.attemptStatus === 'starting' &&
    aggregate.runStatus === 'dispatching'
  ) return 'starting';
  if (
    aggregate.attemptStatus === 'running' &&
    aggregate.runStatus === 'running'
  ) return 'running';
  reject(command, 'state_mismatch');
}

function assertUploadState(
  command: RemoteWorkerArtifactUploadCommand,
  aggregate: Row,
): void {
  const state = assertActiveState(command, aggregate);
  const persistedArtifact = optionalText(aggregate, 'logArtifactId');
  if (
    (persistedArtifact !== undefined &&
      persistedArtifact !== command.logArtifactId) ||
    (state === 'running' && persistedArtifact === undefined)
  ) {
    reject(command, 'state_mismatch');
  }
}

function assertCompletionEvidence(
  command: RemoteWorkerCompletionCommand,
  aggregate: Row,
  state: 'starting' | 'running',
  observedAtMs: number,
): void {
  const currentSequence = integer(aggregate, 'callbackSequence');
  const callbackDigest = optionalText(aggregate, 'callbackTokenDigest');
  const artifactId = optionalText(aggregate, 'logArtifactId');
  if (
    command.result.startedAtMs < integer(aggregate, 'attemptCreatedAtMs') ||
    command.result.startedAtMs > observedAtMs + MAX_REMOTE_WORKER_CLOCK_SKEW_MS ||
    command.result.finishedAtMs > observedAtMs + MAX_REMOTE_WORKER_CLOCK_SKEW_MS
  ) {
    reject(command, 'state_mismatch');
  }
  if (state === 'starting') {
    if (
      command.callbackSequence !== currentSequence + 1 ||
      (callbackDigest !== undefined &&
        callbackDigest !== command.callbackTokenDigest) ||
      (artifactId !== undefined &&
        artifactId !== command.artifact.logArtifactId)
    ) {
      reject(command, 'replay_mismatch');
    }
    return;
  }
  if (
    command.callbackSequence !== currentSequence ||
    callbackDigest !== command.callbackTokenDigest ||
    artifactId !== command.artifact.logArtifactId
  ) {
    reject(command, 'replay_mismatch');
  }
}

function completionDedupeKey(
  command: RemoteWorkerCompletionCommand,
  kind: 'attempt' | 'run',
): string {
  return `remote-completion:${command.attemptId}:${command.leaseGeneration}:${command.callbackSequence}:${kind}`;
}

function completionEventPayload(
  command: RemoteWorkerCompletionCommand,
  terminal: CompletionMapping,
  fromStatus: string,
  workflowStepRunId?: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    attempt_id: command.attemptId,
    lease_generation: command.leaseGeneration,
    from_status: fromStatus,
    to_status: terminal.status,
    callback_sequence: command.callbackSequence,
    callback_token_digest: command.callbackTokenDigest,
    worker_started_at_ms: command.result.startedAtMs,
    worker_finished_at_ms: command.result.finishedAtMs,
    exit_code: command.result.exitCode,
    log_artifact_id: command.artifact.logArtifactId,
    artifact_byte_length: command.artifact.byteLength,
    artifact_sha256: command.artifact.sha256,
    artifact_truncated: command.artifact.truncated ?? null,
    error_code: terminal.errorCode ?? null,
    ...(workflowStepRunId === undefined
      ? {}
      : {
          execution_scope: 'workflow_task',
          step_run_id: workflowStepRunId,
        }),
  });
}

function assertReplayPayload(
  command: RemoteWorkerCompletionCommand,
  terminal: CompletionMapping,
  row: Row | undefined,
  workflowStepRunId?: string,
): void {
  const payload = row?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    reject(command, 'replay_mismatch');
  }
  const record = payload as Record<string, unknown>;
  const fromStatus = String(record.from_status ?? '');
  if (fromStatus !== 'starting' && fromStatus !== 'running') {
    reject(command, 'replay_mismatch');
  }
  const expected = completionEventPayload(
    command,
    terminal,
    fromStatus,
    workflowStepRunId,
  );
  const keys = Object.keys(record).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some((key) => record[key] !== expected[key])
  ) {
    reject(command, 'replay_mismatch');
  }
}

export class PostgresRemoteWorkerCompletionRepository
  implements
    RemoteWorkerArtifactUploadAuthorityRepository,
    RemoteWorkerCompletionRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL Remote Worker completion pool is invalid');
    }
  }

  async authorizeArtifactUpload(
    value: RemoteWorkerArtifactUploadCommand,
  ): Promise<void> {
    const command = normalizeRemoteWorkerArtifactUploadCommand(value);
    await this.transaction(async (client) => {
      const authority = await this.lockAuthority(client, command);
      assertWorkerCurrent(command, authority.worker, authority.observedAtMs);
      assertAuthorityIdentity(command, authority.aggregate, authority.lease);
      assertLiveLease(
        command,
        authority.aggregate,
        authority.lease!,
        authority.observedAtMs,
      );
      assertUploadState(command, authority.aggregate);
    });
  }

  async complete(
    value: CompletionMutationCommand,
  ): Promise<Readonly<RemoteWorkerCompletionResult>> {
    const command = normalizeCompletionMutationCommand(value);
    return this.transaction(async (client) => {
      const authority = await this.lockAuthority(client, command);
      assertWorkerCurrent(command, authority.worker, authority.observedAtMs);
      assertAuthorityIdentity(command, authority.aggregate, authority.lease);
      const aggregate = authority.aggregate;
      const lease = authority.lease!;
      const workflowTask = isWorkflowTaskAttempt(aggregate);
      const attemptTerminal = TERMINAL_STATUSES.has(
        String(aggregate.attemptStatus),
      );
      const runTerminal = TERMINAL_STATUSES.has(String(aggregate.runStatus));
      const stepTerminal =
        workflowTask &&
        TERMINAL_STATUSES.has(workflowStepRun(aggregate).status);
      const aggregateTerminal = workflowTask ? stepTerminal : runTerminal;
      const terminal =
        workflowTask &&
        attemptTerminal &&
        aggregate.attemptStatus !== 'lost'
          ? persistedCompletionMapping(aggregate)
          : mapping(aggregate, command, authority.observedAtMs);
      if (aggregateTerminal || attemptTerminal) {
        if (!aggregateTerminal || !attemptTerminal) {
          reject(command, 'state_mismatch');
        }
        if (
          lease.leaseStatus !== 'completed' ||
          integer(lease, 'leaseVersion') !== command.expectedLeaseVersion + 1 ||
          integer(aggregate, 'attemptLeaseVersion') !==
            command.expectedLeaseVersion + 1
        ) {
          return result('already_terminal', command);
        }
        if (
          (!workflowTask && aggregate.runStatus !== terminal.status) ||
          (workflowTask &&
            workflowStepRun(aggregate).status !== terminal.status) ||
          aggregate.attemptStatus !== terminal.status ||
          integer(aggregate, 'callbackSequence') !== command.callbackSequence ||
          aggregate.callbackTokenDigest !== command.callbackTokenDigest ||
          aggregate.logArtifactId !== command.artifact.logArtifactId ||
          optionalInteger(aggregate, 'finishedAtMs') === undefined ||
          optionalInteger(aggregate, 'exitCode') !== command.result.exitCode ||
          optionalText(aggregate, 'attemptErrorCode') !== terminal.errorCode ||
          (!workflowTask &&
            optionalText(aggregate, 'runErrorCode') !== terminal.errorCode)
        ) {
          reject(command, 'replay_mismatch');
        }
        const replay = await client.query<Row>(
          `
            SELECT payload
            FROM "ql3"."run_events"
            WHERE run_id = $1 AND dedupe_key = $2
          `,
          [command.runId, completionDedupeKey(command, 'attempt')],
        );
        if (replay.rows.length !== 1) reject(command, 'replay_mismatch');
        assertReplayPayload(
          command,
          terminal,
          replay.rows[0],
          workflowTask ? text(aggregate, 'workflowStepRunId') : undefined,
        );
        return result('already_completed', command);
      }

      assertLiveLease(command, aggregate, lease, authority.observedAtMs);
      const state = assertActiveState(command, aggregate);
      assertCompletionEvidence(
        command,
        aggregate,
        state,
        authority.observedAtMs,
      );
      const nextLeaseVersion = command.expectedLeaseVersion + 1;
      const runVersion = integer(aggregate, 'runVersion');
      const firstSequence = integer(aggregate, 'eventSequence') + 1;
      const workflowRequiresSyntheticStart =
        workflowTask && state === 'starting';
      const eventCount = workflowRequiresSyntheticStart ? 3 : 2;
      const attemptSequence =
        workflowRequiresSyntheticStart ? firstSequence + 1 : firstSequence;
      const finalSequence =
        integer(aggregate, 'eventSequence') + eventCount;
      if (
        nextLeaseVersion > 2_147_483_647 ||
        runVersion > 2_147_483_647 - eventCount ||
        finalSequence > 2_147_483_647
      ) {
        throw new RangeError('Remote Worker completion counter overflowed');
      }
      const startedAtMs = optionalInteger(aggregate, 'startedAtMs') ??
        command.result.startedAtMs;
      const terminalAtMs = Math.max(
        authority.observedAtMs,
        command.result.finishedAtMs,
        startedAtMs,
        integer(aggregate, 'runCreatedAtMs'),
        integer(aggregate, 'attemptCreatedAtMs'),
      );
      const currentWorkflowStep = workflowTask
        ? workflowStepRun(aggregate)
        : null;
      const startedStepMutation =
        workflowRequiresSyntheticStart && currentWorkflowStep
          ? transitionStepRunMutation(
              currentWorkflowStep,
              {
                expectedVersion: currentWorkflowStep.version,
                expectedDigest: currentWorkflowStep.stepRunDigest,
                mutationId: workflowStartedEventId(command),
                to: 'running',
                atMs: Math.max(
                  command.result.startedAtMs,
                  currentWorkflowStep.updatedAtMs,
                ),
              },
              {
                expectedRunVersion: runVersion,
                expectedRunEventSequence: firstSequence - 1,
                eventId: workflowStartedEventId(command),
                dedupeKey:
                  `remote-completion:${command.attemptId}:` +
                  `${command.leaseGeneration}:starting-step`,
                actor: { type: 'worker', id: command.workerId },
              },
            )
          : null;
      const terminalWorkflowStep =
        startedStepMutation?.stepRun ?? currentWorkflowStep;
      const terminalStepMutation =
        terminalWorkflowStep === null
          ? null
          : transitionStepRunMutation(
              terminalWorkflowStep,
              {
                expectedVersion: terminalWorkflowStep.version,
                expectedDigest: terminalWorkflowStep.stepRunDigest,
                mutationId: command.runEventId,
                to: terminal.status,
                atMs: terminalAtMs,
                ...(terminal.errorCode === undefined
                  ? {}
                  : { resultCode: terminal.errorCode.toLowerCase() }),
                ...(terminal.status === 'failed' ||
                terminal.status === 'timed_out'
                  ? { errorSummary: terminal.errorSummary }
                  : {}),
              },
              {
                expectedRunVersion: workflowRequiresSyntheticStart
                  ? runVersion + 2
                  : runVersion + 1,
                expectedRunEventSequence: finalSequence - 1,
                eventId: command.runEventId,
                dedupeKey:
                  `remote-completion:${command.attemptId}:` +
                  `${command.leaseGeneration}:terminal-step`,
                actor: { type: 'worker', id: command.workerId },
              },
            );
      const leaseUpdate = await client.query(
        `
          UPDATE "ql3"."run_dispatch_leases"
          SET status = 'completed', version = $2, completed_at_ms = $3,
              released_at_ms = NULL, release_reason = NULL, updated_at_ms = $3
          WHERE attempt_id = $1 AND status = 'leased' AND version = $4
        `,
        [
          command.attemptId,
          nextLeaseVersion,
          terminalAtMs,
          command.expectedLeaseVersion,
        ],
      );
      const attemptUpdate = await client.query(
        `
          UPDATE "ql3"."run_attempts"
          SET status = $10, lease_version = $11, callback_sequence = $12,
              callback_token_hash = COALESCE(callback_token_hash, $13),
              log_artifact_id = COALESCE(log_artifact_id, $14),
              started_at_ms = COALESCE(started_at_ms, $15),
              finished_at_ms = $16, exit_code = $17,
              error_code = $18, error_summary = $19
          WHERE id = $1 AND run_id = $2 AND status = $20
            AND executor_type = 'remote_worker'
            AND worker_id = $3 AND worker_session_id = $4
            AND worker_generation = $5 AND lease_generation = $6
            AND lease_version = $7 AND lease_token_digest = $8 AND offer_id = $9
            AND callback_sequence = $21
            AND (callback_token_hash IS NULL OR callback_token_hash = $13)
            AND (log_artifact_id IS NULL OR log_artifact_id = $14)
        `,
        [
          command.attemptId,
          command.runId,
          command.workerId,
          command.workerSessionId,
          command.workerGeneration,
          command.leaseGeneration,
          command.expectedLeaseVersion,
          digestRunDispatchLeaseToken(command.leaseToken),
          command.offerId,
          terminal.status,
          nextLeaseVersion,
          command.callbackSequence,
          command.callbackTokenDigest,
          command.artifact.logArtifactId,
          startedAtMs,
          terminalAtMs,
          command.result.exitCode,
          terminal.errorCode ?? null,
          terminal.errorSummary ?? null,
          state,
          integer(aggregate, 'callbackSequence'),
        ],
      );
      const runUpdate = workflowTask
        ? await client.query(
            `
              UPDATE "ql3"."runs"
              SET version = $2, event_sequence = $3
              WHERE id = $1 AND version = $4 AND status = 'running'
                AND execution_owner = 'runtime'
            `,
            [
              command.runId,
              runVersion + eventCount,
              finalSequence,
              runVersion,
            ],
          )
        : await client.query(
            `
              UPDATE "ql3"."runs"
              SET status = $2, started_at_ms = COALESCE(started_at_ms, $3),
                  finished_at_ms = $4, error_code = $5, error_summary = $6,
                  version = $7, event_sequence = $8
              WHERE id = $1 AND version = $9 AND status = $10
                AND execution_owner = 'runtime'
            `,
            [
              command.runId,
              terminal.status,
              startedAtMs,
              terminalAtMs,
              terminal.errorCode ?? null,
              terminal.errorSummary ?? null,
              runVersion + eventCount,
              finalSequence,
              runVersion,
              state === 'starting' ? 'dispatching' : 'running',
            ],
          );
      if (
        leaseUpdate.rowCount !== 1 ||
        attemptUpdate.rowCount !== 1 ||
        runUpdate.rowCount !== 1
      ) {
        reject(command, 'authority_mismatch');
      }
      if (startedStepMutation) {
        await this.persistStepMutation(
          client,
          startedStepMutation,
          command.attemptId,
        );
      }
      const workflowStepRunId = workflowTask
        ? text(aggregate, 'workflowStepRunId')
        : undefined;
      const payload = completionEventPayload(
        command,
        terminal,
        state,
        workflowStepRunId,
      );
      await this.insertEvent(client, {
        id: command.attemptEventId,
        runId: command.runId,
        sequence: attemptSequence,
        type: workflowTask
          ? `workflow.task_attempt.${terminal.status}`
          : `attempt.${terminal.status}`,
        dedupeKey: completionDedupeKey(command, 'attempt'),
        workerId: command.workerId,
        attemptId: command.attemptId,
        ...(workflowStepRunId === undefined
          ? {}
          : { stepRunId: workflowStepRunId }),
        payload,
        createdAtMs: terminalAtMs,
      });
      if (terminalStepMutation) {
        await this.persistStepMutation(
          client,
          terminalStepMutation,
          command.attemptId,
        );
      } else {
        await this.insertEvent(client, {
          id: command.runEventId,
          runId: command.runId,
          sequence: finalSequence,
          type: `run.${terminal.status}`,
          dedupeKey: completionDedupeKey(command, 'run'),
          workerId: command.workerId,
          attemptId: command.attemptId,
          payload: Object.freeze({
            attempt_id: command.attemptId,
            lease_generation: command.leaseGeneration,
            from_status: state === 'starting' ? 'dispatching' : 'running',
            to_status: terminal.status,
            callback_sequence: command.callbackSequence,
            error_code: terminal.errorCode ?? null,
          }),
          createdAtMs: terminalAtMs,
        });
      }
      return result('applied', command);
    });
  }

  private async lockAuthority(
    client: PostgresClient,
    command: RemoteWorkerExecutionFence,
  ): Promise<LockedRemoteWorkerCompletionAuthority> {
    await lockAttemptAuthority(client, command.attemptId);
    const worker = await client.query<Row>(
      `
        SELECT worker_id AS "workerId", session_id AS "sessionId",
               generation AS "workerGeneration", status AS "workerStatus",
               lease_expires_at_ms AS "workerLeaseExpiresAtMs"
        FROM "ql3"."worker_sessions" WHERE worker_id = $1 FOR UPDATE
      `,
      [command.workerId],
    );
    const aggregate = await client.query<Row>(
      `
        SELECT run.id AS "runId",
               COALESCE(workflow_task.project_id, run.project_id)
                 AS "projectId",
               run.status AS "runStatus", run.execution_owner AS "executionOwner",
               run.cancel_requested_at_ms AS "cancelRequestedAtMs",
               run.cancel_reason AS "cancelReason",
               run.error_code AS "runErrorCode",
               run.version AS "runVersion",
               run.event_sequence AS "eventSequence",
               run.created_at_ms AS "runCreatedAtMs",
               run.started_at_ms AS "runStartedAtMs",
               attempt.id AS "attemptId", attempt.run_id AS "attemptRunId",
               attempt.step_run_id AS "attemptStepRunId",
               attempt.status AS "attemptStatus",
               attempt.executor_type AS "executorType",
               attempt.worker_id AS "attemptWorkerId",
               attempt.worker_session_id AS "attemptWorkerSessionId",
               attempt.worker_generation AS "attemptWorkerGeneration",
               attempt.lease_generation AS "attemptLeaseGeneration",
               attempt.lease_version AS "attemptLeaseVersion",
               attempt.lease_token_digest AS "attemptLeaseTokenDigest",
               attempt.offer_id AS "attemptOfferId",
               attempt.callback_sequence AS "callbackSequence",
               attempt.callback_token_hash AS "callbackTokenDigest",
               attempt.log_artifact_id AS "logArtifactId",
               attempt.deadline_at_ms AS "deadlineAtMs",
               attempt.created_at_ms AS "attemptCreatedAtMs",
               attempt.started_at_ms AS "startedAtMs",
               attempt.finished_at_ms AS "finishedAtMs",
               attempt.exit_code AS "exitCode",
               attempt.error_code AS "attemptErrorCode",
               workflow_task.attempt_id AS "workflowAttemptId",
               workflow_task.step_run_id AS "workflowStepRunId",
               workflow_task.step_run_version AS
                 "admittedWorkflowStepVersion",
               workflow_task.step_run_digest AS
                 "admittedWorkflowStepDigest"
        FROM "ql3"."runs" AS run
        INNER JOIN "ql3"."run_attempts" AS attempt ON attempt.id = $2
        LEFT JOIN
          "ql3"."plugin_package_workflow_task_attempt_admissions"
            AS workflow_task
          ON workflow_task.attempt_id = attempt.id
        WHERE run.id = $1
        FOR UPDATE OF run, attempt
      `,
      [command.runId, command.attemptId],
    );
    const aggregateRow = aggregate.rows[0];
    let lockedAggregate = aggregateRow;
    if (aggregateRow && isWorkflowTaskAttempt(aggregateRow)) {
      const step = await client.query<Row>(
        `SELECT version AS "workflowStepVersion",
                step_run_digest AS "workflowStepDigest",
                step_run_json AS "workflowStepJson"
         FROM "ql3"."step_runs"
         WHERE run_id = $1 AND id = $2
         FOR UPDATE`,
        [command.runId, aggregateRow.workflowStepRunId],
      );
      lockedAggregate = Object.freeze({
        ...aggregateRow,
        ...(step.rows[0] ?? {}),
      });
    }
    const lease = await client.query<Row>(
      `
        SELECT attempt_id AS "attemptId", run_id AS "runId",
               status AS "leaseStatus", version AS "leaseVersion",
               lease_generation AS "leaseGeneration",
               worker_id AS "workerId", worker_session_id AS "workerSessionId",
               worker_generation AS "workerGeneration",
               lease_token_digest AS "leaseTokenDigest", offer_id AS "offerId",
               expires_at_ms AS "leaseExpiresAtMs"
        FROM "ql3"."run_dispatch_leases"
        WHERE attempt_id = $1 FOR UPDATE
      `,
      [command.attemptId],
    );
    const observedAtMs = await databaseNow(client);
    return Object.freeze({
      worker: worker.rows[0],
      aggregate: lockedAggregate,
      lease: lease.rows[0],
      observedAtMs,
    });
  }

  private async insertEvent(
    client: PostgresClient,
    event: Readonly<{
      id: string;
      runId: string;
      sequence: number;
      type: string;
      dedupeKey: string;
      workerId: string;
      attemptId: string;
      stepRunId?: string;
      payload: Readonly<Record<string, unknown>>;
      createdAtMs: number;
    }>,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO "ql3"."run_events" (
          id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
          attempt_id, step_run_id, payload, created_at_ms
        ) VALUES ($1, $2, $3, $4, $5, 'worker', $6, $7, $8, $9::jsonb, $10)
      `,
      [
        event.id,
        event.runId,
        event.sequence,
        event.type,
        event.dedupeKey,
        event.workerId,
        event.attemptId,
        event.stepRunId ?? null,
        JSON.stringify(event.payload),
        event.createdAtMs,
      ],
    );
  }

  private async persistStepMutation(
    client: PostgresClient,
    mutation: Readonly<StepRunMutation>,
    attemptId: string,
  ): Promise<void> {
    const stepRun = mutation.stepRun;
    const updated = await client.query(
      `UPDATE "ql3"."step_runs"
       SET status = $1, version = $2, attempt_count = $3, output_ref = $4,
           approval_request_id = $5, ready_at_ms = $6, started_at_ms = $7,
           finished_at_ms = $8, result_code = $9, error_summary = $10,
           updated_at_ms = $11, last_mutation_id = $12,
           step_run_digest = $13, step_run_json = $14::jsonb
       WHERE id = $15 AND run_id = $16 AND version = $17
         AND step_run_digest = $18 AND status = $19`,
      [
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
      ],
    );
    if (updated.rowCount !== 1) {
      reject({ attemptId }, 'authority_mismatch');
    }
    const event = mutation.event;
    await client.query(
      `INSERT INTO "ql3"."run_events" (
         id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
         attempt_id, step_run_id, payload, created_at_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9::jsonb, $10)`,
      [
        event.id,
        event.runId,
        event.sequence,
        event.type,
        event.dedupeKey ?? null,
        event.actorType,
        event.actorId ?? null,
        stepRun.id,
        JSON.stringify(event.payload),
        event.createdAtMs,
      ],
    );
    await client.query(
      `INSERT INTO "ql3"."step_run_mutations" (
         mutation_id, mutation_digest, run_id, step_run_id, step_run_digest,
         event_id, event_sequence, run_version, step_run_json, committed_at_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        mutation.mutationId,
        mutation.mutationDigest,
        mutation.runId,
        stepRun.id,
        stepRun.stepRunDigest,
        event.id,
        event.sequence,
        mutation.expectedRunVersion + 1,
        JSON.stringify(stepRun),
        event.createdAtMs,
      ],
    );
  }

  private async transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new RemoteWorkerCompletionUnavailableError({ cause: error });
    }
    try {
      await begin(client);
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the originating failure.
      }
      if (error instanceof RemoteWorkerCompletionFenceRejectedError) {
        throw error;
      }
      throw new RemoteWorkerCompletionUnavailableError({ cause: error });
    } finally {
      client.release();
    }
  }
}
