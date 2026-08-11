// PostgreSQL Remote Execution activation persistence is owned by this domain.
import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import {
  RemoteRunActivationFenceRejectedError,
  RemoteRunActivationUnavailableError,
  assertAcknowledgeRemoteRunRunningCommand,
  assertAcknowledgeRemoteRunStartingCommand,
  assertFailRemoteRunStartCommand,
  type AcknowledgeRemoteRunRunningCommand,
  type AcknowledgeRemoteRunStartingCommand,
  type FailRemoteRunStartCommand,
  type RemoteRunActivationFence,
  type RemoteRunActivationRepository,
  type RemoteRunActivationResult,
  type RemoteRunActivationSnapshot,
} from '@qinglong/runtime-core/remote-activation';
import { digestRunDispatchLeaseToken } from '@qinglong/runtime-core';
import {
  normalizeStepRunRecord,
  transitionStepRunMutation,
  type StepRunMutation,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';
import { lockAttemptAuthority } from '../run/attemptAuthorityLock';

type Row = Record<string, unknown>;

interface LockedAuthority {
  readonly worker: Row | undefined;
  readonly aggregate: Row | undefined;
  readonly lease: Row | undefined;
  readonly observedAtMs: number;
}

interface StartFailureMapping {
  readonly status: 'failed' | 'cancelled' | 'timed_out';
  readonly errorCode:
    | 'EXECUTOR_START_FAILED'
    | 'EXECUTION_CANCELLED'
    | 'EXECUTION_TIMED_OUT';
  readonly errorSummary: string;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new TypeError(`PostgreSQL Remote Run activation ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const raw = row[key];
  const value =
    typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw)
      ? Number(raw)
      : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TypeError(`PostgreSQL Remote Run activation ${key} is invalid`);
  }
  return value;
}

function optionalInteger(row: Row, key: string): number | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : integer(row, key);
}

function optionalText(row: Row, key: string): string | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : text(row, key);
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
      'PostgreSQL Remote Run activation Workflow StepRun is invalid',
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
  command: Pick<RemoteRunActivationFence, 'attemptId'>,
  reason: ConstructorParameters<typeof RemoteRunActivationFenceRejectedError>[1],
): never {
  throw new RemoteRunActivationFenceRejectedError(command.attemptId, reason);
}

function snapshot(
  aggregate: Row,
  lease: Row,
  overrides: Partial<RemoteRunActivationSnapshot> = {},
): Readonly<RemoteRunActivationSnapshot> {
  const startedAtMs = optionalInteger(aggregate, 'startedAtMs');
  const deadlineAtMs = optionalInteger(aggregate, 'deadlineAtMs');
  const finishedAtMs = optionalInteger(aggregate, 'finishedAtMs');
  const executorHandle = optionalText(aggregate, 'executorHandle');
  const logArtifactId = optionalText(aggregate, 'logArtifactId');
  const errorCode = optionalText(aggregate, 'attemptErrorCode');
  return Object.freeze({
    runId: text(aggregate, 'runId'),
    attemptId: text(aggregate, 'attemptId'),
    runStatus: text(aggregate, 'runStatus') as RemoteRunActivationSnapshot['runStatus'],
    attemptStatus: text(aggregate, 'attemptStatus') as RemoteRunActivationSnapshot['attemptStatus'],
    leaseVersion: integer(lease, 'leaseVersion'),
    leaseGeneration: integer(lease, 'leaseGeneration'),
    callbackSequence: integer(aggregate, 'callbackSequence'),
    ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
    ...(startedAtMs === undefined ? {} : { startedAtMs }),
    ...(finishedAtMs === undefined ? {} : { finishedAtMs }),
    ...(executorHandle === undefined ? {} : { executorHandle }),
    ...(logArtifactId === undefined ? {} : { logArtifactId }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...overrides,
  });
}

function executionTimeoutMs(aggregate: Row): number | undefined {
  const plan = aggregate.planJson;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TypeError('PostgreSQL Remote Run activation plan is invalid');
  }
  const value = (plan as Record<string, unknown>).timeoutMs;
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 365 * 24 * 60 * 60_000
  ) {
    throw new TypeError('PostgreSQL Remote Run activation timeout is invalid');
  }
  return value as number;
}

function result(
  status: RemoteRunActivationResult['status'],
  value: Readonly<RemoteRunActivationSnapshot>,
): Readonly<RemoteRunActivationResult> {
  return Object.freeze({ status, snapshot: value });
}

function failureMapping(
  aggregate: Row,
  observedAtMs: number,
): StartFailureMapping {
  if (aggregate.cancelRequestedAtMs !== null) {
    if (aggregate.cancelReason === 'timeout') {
      return Object.freeze({
        status: 'timed_out',
        errorCode: 'EXECUTION_TIMED_OUT',
        errorSummary: 'Execution timed out before the executor started',
      });
    }
    return Object.freeze({
      status: 'cancelled',
      errorCode: 'EXECUTION_CANCELLED',
      errorSummary: 'Execution was cancelled before the executor started',
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
      errorSummary: 'Execution timed out before the executor started',
    });
  }
  return Object.freeze({
    status: 'failed',
    errorCode: 'EXECUTOR_START_FAILED',
    errorSummary: 'Executor failed before execution ownership was established',
  });
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
    throw new TypeError('PostgreSQL Remote Run activation clock is invalid');
  }
  return integer(observed.rows[0]!, 'nowMs');
}

function assertWorkerCurrent(
  command: RemoteRunActivationFence,
  worker: Row | undefined,
  observedAtMs: number,
): void {
  if (!worker) reject(command, 'worker_unavailable');
  if (worker.workerId !== command.workerId) reject(command, 'worker_mismatch');
  if (worker.sessionId !== command.workerSessionId) {
    reject(command, 'worker_session_mismatch');
  }
  if (integer(worker, 'workerGeneration') !== command.workerGeneration) {
    reject(command, 'worker_generation_mismatch');
  }
  if (
    !['online', 'draining'].includes(String(worker.workerStatus)) ||
    integer(worker, 'workerLeaseExpiresAtMs') <= observedAtMs
  ) {
    reject(command, 'worker_unavailable');
  }
}

function assertAggregateIdentity(
  command: RemoteRunActivationFence,
  aggregate: Row | undefined,
): asserts aggregate is Row {
  if (!aggregate) reject(command, 'missing');
  if (aggregate.runId !== command.runId || aggregate.attemptRunId !== command.runId) {
    reject(command, 'run_mismatch');
  }
  if (aggregate.executionOwner !== 'runtime') {
    reject(command, 'execution_owner_mismatch');
  }
  if (aggregate.executorType !== 'remote_worker') {
    reject(command, 'executor_mismatch');
  }
  if (isWorkflowTaskAttempt(aggregate)) {
    workflowStepRun(aggregate);
  } else if (
    aggregate.attemptStepRunId !== null &&
    aggregate.attemptStepRunId !== undefined
  ) {
    reject(command, 'run_mismatch');
  }
}

function assertAuthorityProjection(
  command: RemoteRunActivationFence,
  aggregate: Row,
  lease: Row | undefined,
  options: { allowCompletedReplay: boolean },
): asserts lease is Row {
  if (!lease) reject(command, 'missing');
  if (lease.runId !== command.runId) reject(command, 'run_mismatch');
  if (lease.workerId !== command.workerId || aggregate.attemptWorkerId !== command.workerId) {
    reject(command, 'worker_mismatch');
  }
  if (
    lease.workerSessionId !== command.workerSessionId ||
    aggregate.attemptWorkerSessionId !== command.workerSessionId
  ) {
    reject(command, 'worker_session_mismatch');
  }
  if (
    integer(lease, 'workerGeneration') !== command.workerGeneration ||
    integer(aggregate, 'attemptWorkerGeneration') !== command.workerGeneration
  ) {
    reject(command, 'worker_generation_mismatch');
  }
  if (
    integer(lease, 'leaseGeneration') !== command.leaseGeneration ||
    integer(aggregate, 'attemptLeaseGeneration') !== command.leaseGeneration
  ) {
    reject(command, 'lease_generation_mismatch');
  }
  const digest = digestRunDispatchLeaseToken(command.leaseToken);
  if (
    lease.leaseTokenDigest !== digest ||
    aggregate.attemptLeaseTokenDigest !== digest
  ) {
    reject(command, 'lease_token_mismatch');
  }
  if (lease.offerId !== command.offerId || aggregate.attemptOfferId !== command.offerId) {
    reject(command, 'offer_mismatch');
  }
  const leaseVersion = integer(lease, 'leaseVersion');
  const attemptLeaseVersion = integer(aggregate, 'attemptLeaseVersion');
  if (
    options.allowCompletedReplay &&
    lease.leaseStatus === 'completed' &&
    leaseVersion === command.expectedLeaseVersion + 1 &&
    attemptLeaseVersion === leaseVersion
  ) {
    return;
  }
  if (
    lease.leaseStatus !== 'leased' ||
    leaseVersion !== command.expectedLeaseVersion ||
    attemptLeaseVersion !== command.expectedLeaseVersion
  ) {
    reject(command, 'version_mismatch');
  }
}

function assertLiveLease(
  command: RemoteRunActivationFence,
  lease: Row,
  observedAtMs: number,
): void {
  if (lease.leaseStatus !== 'leased') reject(command, 'version_mismatch');
  if (integer(lease, 'leaseExpiresAtMs') <= observedAtMs) {
    reject(command, 'lease_expired');
  }
}

export class PostgresRemoteRunActivationRepository
  implements RemoteRunActivationRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL Remote Run activation pool is invalid');
    }
  }

  async acknowledgeStarting(
    command: AcknowledgeRemoteRunStartingCommand,
  ): Promise<Readonly<RemoteRunActivationResult>> {
    assertAcknowledgeRemoteRunStartingCommand(command);
    return this.transaction(async (client) => {
      const authority = await this.lockAuthority(client, command);
      this.assertLiveAuthority(command, authority);
      const aggregate = authority.aggregate!;
      const lease = authority.lease!;
      const workflowTask = isWorkflowTaskAttempt(aggregate);
      const expectedRunStatus = workflowTask ? 'running' : 'dispatching';
      if (aggregate.attemptStatus === 'starting') {
        if (
          aggregate.runStatus !== expectedRunStatus ||
          (workflowTask &&
            (workflowStepRun(aggregate).status !== 'ready' ||
              !workflowStepAtAdmissionEpoch(aggregate)))
        ) {
          reject(command, 'run_state_mismatch');
        }
        return result('already_starting', snapshot(aggregate, lease));
      }
      if (aggregate.attemptStatus === 'running') {
        if (
          aggregate.runStatus !== 'running' ||
          (workflowTask && workflowStepRun(aggregate).status !== 'running')
        ) {
          reject(command, 'run_state_mismatch');
        }
        return result('already_running', snapshot(aggregate, lease));
      }
      if (aggregate.attemptStatus !== 'claimed') reject(command, 'attempt_state_mismatch');
      if (
        aggregate.runStatus !== expectedRunStatus ||
        (workflowTask &&
          (workflowStepRun(aggregate).status !== 'ready' ||
            !workflowStepAtAdmissionEpoch(aggregate)))
      ) {
        reject(command, 'run_state_mismatch');
      }
      const timeoutMs = executionTimeoutMs(aggregate);
      const deadlineAtMs = timeoutMs === undefined
        ? undefined
        : authority.observedAtMs + timeoutMs;
      if (deadlineAtMs !== undefined && !Number.isSafeInteger(deadlineAtMs)) {
        throw new RangeError('Remote Run activation deadline overflowed');
      }
      const runVersion = integer(aggregate, 'runVersion');
      const sequence = integer(aggregate, 'eventSequence') + 1;
      const attemptUpdate = await client.query(
        `
          UPDATE "ql3"."run_attempts"
          SET status = 'starting', deadline_at_ms = $10
          WHERE id = $1 AND run_id = $2 AND status = 'claimed'
            AND executor_type = 'remote_worker'
            AND worker_id = $3 AND worker_session_id = $4
            AND worker_generation = $5 AND lease_generation = $6
            AND lease_version = $7 AND lease_token_digest = $8 AND offer_id = $9
        `,
        [
          command.attemptId, command.runId, command.workerId,
          command.workerSessionId, command.workerGeneration,
          command.leaseGeneration, command.expectedLeaseVersion,
          digestRunDispatchLeaseToken(command.leaseToken), command.offerId,
          deadlineAtMs ?? null,
        ],
      );
      const runUpdate = await client.query(
        `
          UPDATE "ql3"."runs"
          SET version = $2, event_sequence = $3
          WHERE id = $1 AND version = $4 AND status = $5
            AND execution_owner = 'runtime'
        `,
        [
          command.runId,
          runVersion + 1,
          sequence,
          runVersion,
          expectedRunStatus,
        ],
      );
      if (attemptUpdate.rowCount !== 1 || runUpdate.rowCount !== 1) {
        reject(command, 'version_mismatch');
      }
      await this.insertEvent(client, {
        id: command.eventId,
        runId: command.runId,
        sequence,
        type: workflowTask
          ? 'workflow.task_attempt.starting'
          : 'attempt.starting',
        dedupeKey: `remote-activation:${command.attemptId}:${command.leaseGeneration}:starting`,
        workerId: command.workerId,
        attemptId: command.attemptId,
        ...(workflowTask
          ? { stepRunId: text(aggregate, 'workflowStepRunId') }
          : {}),
        payload: {
          attempt_id: command.attemptId,
          lease_generation: command.leaseGeneration,
          execution_scope: workflowTask ? 'workflow_task' : 'run',
          from_status: 'claimed',
          to_status: 'starting',
          deadline_at_ms: deadlineAtMs ?? null,
        },
        createdAtMs: authority.observedAtMs,
      });
      return result('applied', snapshot(aggregate, lease, {
        attemptStatus: 'starting',
        ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
      }));
    });
  }

  async acknowledgeRunning(
    command: AcknowledgeRemoteRunRunningCommand,
  ): Promise<Readonly<RemoteRunActivationResult>> {
    assertAcknowledgeRemoteRunRunningCommand(command);
    return this.transaction(async (client) => {
      const authority = await this.lockAuthority(client, command);
      this.assertLiveAuthority(command, authority);
      const aggregate = authority.aggregate!;
      const lease = authority.lease!;
      const workflowTask = isWorkflowTaskAttempt(aggregate);
      if (aggregate.attemptStatus === 'running') {
        if (
          aggregate.runStatus !== 'running' ||
          (workflowTask && workflowStepRun(aggregate).status !== 'running') ||
          aggregate.executorHandle !== command.executorHandle ||
          optionalText(aggregate, 'logArtifactId') !== command.logArtifactId ||
          integer(aggregate, 'callbackSequence') !== command.callbackSequence ||
          aggregate.callbackTokenDigest !== command.callbackTokenDigest
        ) reject(command, 'replay_mismatch');
        return result('already_running', snapshot(aggregate, lease));
      }
      if (aggregate.attemptStatus !== 'starting') reject(command, 'attempt_state_mismatch');
      if (
        aggregate.runStatus !== (workflowTask ? 'running' : 'dispatching') ||
        (workflowTask &&
          (workflowStepRun(aggregate).status !== 'ready' ||
            !workflowStepAtAdmissionEpoch(aggregate)))
      ) {
        reject(command, 'run_state_mismatch');
      }
      if (command.callbackSequence !== integer(aggregate, 'callbackSequence') + 1) {
        reject(command, 'replay_mismatch');
      }
      const runVersion = integer(aggregate, 'runVersion');
      const firstSequence = integer(aggregate, 'eventSequence') + 1;
      const secondSequence = firstSequence + 1;
      const stepMutation = workflowTask
        ? transitionStepRunMutation(
            workflowStepRun(aggregate),
            {
              expectedVersion: integer(aggregate, 'workflowStepVersion'),
              expectedDigest: text(aggregate, 'workflowStepDigest'),
              mutationId: command.runEventId,
              to: 'running',
              atMs: authority.observedAtMs,
            },
            {
              expectedRunVersion: runVersion + 1,
              expectedRunEventSequence: firstSequence,
              eventId: command.runEventId,
              dedupeKey:
                `remote-activation:${command.attemptId}:` +
                `${command.leaseGeneration}:running-step`,
              actor: { type: 'worker', id: command.workerId },
            },
          )
        : null;
      const attemptUpdate = await client.query(
        `
          UPDATE "ql3"."run_attempts"
          SET status = 'running', executor_handle = $10, log_artifact_id = $11,
              callback_sequence = $12, callback_token_hash = $13,
              started_at_ms = $14
          WHERE id = $1 AND run_id = $2 AND status = 'starting'
            AND executor_type = 'remote_worker'
            AND worker_id = $3 AND worker_session_id = $4
            AND worker_generation = $5 AND lease_generation = $6
            AND lease_version = $7 AND lease_token_digest = $8 AND offer_id = $9
        `,
        [
          command.attemptId, command.runId, command.workerId,
          command.workerSessionId, command.workerGeneration,
          command.leaseGeneration, command.expectedLeaseVersion,
          digestRunDispatchLeaseToken(command.leaseToken), command.offerId,
          command.executorHandle, command.logArtifactId ?? null,
          command.callbackSequence, command.callbackTokenDigest,
          authority.observedAtMs,
        ],
      );
      const runUpdate = await client.query(
        `
          UPDATE "ql3"."runs"
          SET status = $2::varchar,
              started_at_ms = CASE
                WHEN $2::varchar = 'running' AND status = 'dispatching' THEN $3
                ELSE started_at_ms
              END,
              version = $4, event_sequence = $5
          WHERE id = $1 AND version = $6 AND status = $7
            AND execution_owner = 'runtime'
        `,
        [
          command.runId,
          'running',
          authority.observedAtMs,
          runVersion + 2,
          secondSequence,
          runVersion,
          workflowTask ? 'running' : 'dispatching',
        ],
      );
      if (attemptUpdate.rowCount !== 1 || runUpdate.rowCount !== 1) {
        reject(command, 'version_mismatch');
      }
      if (stepMutation) {
        await this.persistStepMutation(
          client,
          stepMutation,
          command.attemptId,
        );
      }
      await this.insertEvent(client, {
        id: command.attemptEventId,
        runId: command.runId,
        sequence: firstSequence,
        type: workflowTask
          ? 'workflow.task_attempt.running'
          : 'attempt.running',
        dedupeKey: `remote-activation:${command.attemptId}:${command.leaseGeneration}:running-attempt`,
        workerId: command.workerId,
        attemptId: command.attemptId,
        ...(workflowTask
          ? { stepRunId: text(aggregate, 'workflowStepRunId') }
          : {}),
        payload: {
          attempt_id: command.attemptId,
          lease_generation: command.leaseGeneration,
          execution_scope: workflowTask ? 'workflow_task' : 'run',
          from_status: 'starting',
          to_status: 'running',
          callback_sequence: command.callbackSequence,
        },
        createdAtMs: authority.observedAtMs,
      });
      if (!stepMutation) {
        await this.insertEvent(client, {
          id: command.runEventId,
          runId: command.runId,
          sequence: secondSequence,
          type: 'run.running',
          dedupeKey: `remote-activation:${command.attemptId}:${command.leaseGeneration}:running-run`,
          workerId: command.workerId,
          attemptId: command.attemptId,
          payload: {
            attempt_id: command.attemptId,
            lease_generation: command.leaseGeneration,
            execution_scope: 'run',
            from_status: 'dispatching',
            to_status: 'running',
          },
          createdAtMs: authority.observedAtMs,
        });
      }
      return result('applied', snapshot(aggregate, lease, {
        runStatus: 'running',
        attemptStatus: 'running',
        callbackSequence: command.callbackSequence,
        startedAtMs: authority.observedAtMs,
        executorHandle: command.executorHandle,
        ...(command.logArtifactId === undefined
          ? {}
          : { logArtifactId: command.logArtifactId }),
      }));
    });
  }

  async failStart(
    command: FailRemoteRunStartCommand,
  ): Promise<Readonly<RemoteRunActivationResult>> {
    assertFailRemoteRunStartCommand(command);
    return this.transaction(async (client) => {
      const authority = await this.lockAuthority(client, command);
      assertWorkerCurrent(command, authority.worker, authority.observedAtMs);
      assertAggregateIdentity(command, authority.aggregate);
      const aggregate = authority.aggregate;
      assertAuthorityProjection(command, aggregate, authority.lease, {
        allowCompletedReplay: true,
      });
      const lease = authority.lease;
      const mapping = failureMapping(aggregate, authority.observedAtMs);
      const workflowTask = isWorkflowTaskAttempt(aggregate);
      if (lease.leaseStatus === 'completed') {
        if (
          aggregate.runStatus !==
            (workflowTask ? 'running' : mapping.status) ||
          aggregate.attemptStatus !== mapping.status ||
          (workflowTask &&
            workflowStepRun(aggregate).status !== mapping.status) ||
          (!workflowTask && aggregate.runErrorCode !== mapping.errorCode) ||
          aggregate.attemptErrorCode !== mapping.errorCode ||
          optionalInteger(aggregate, 'finishedAtMs') === undefined
        ) reject(command, 'replay_mismatch');
        return result('already_terminal', snapshot(aggregate, lease));
      }
      assertLiveLease(command, lease, authority.observedAtMs);
      if (aggregate.attemptStatus !== 'starting') reject(command, 'attempt_state_mismatch');
      if (
        aggregate.runStatus !== (workflowTask ? 'running' : 'dispatching') ||
        (workflowTask &&
          (workflowStepRun(aggregate).status !== 'ready' ||
            !workflowStepAtAdmissionEpoch(aggregate)))
      ) {
        reject(command, 'run_state_mismatch');
      }
      const runVersion = integer(aggregate, 'runVersion');
      const firstSequence = integer(aggregate, 'eventSequence') + 1;
      const secondSequence = firstSequence + 1;
      const nextLeaseVersion = command.expectedLeaseVersion + 1;
      const nextCallbackSequence = integer(aggregate, 'callbackSequence') + 1;
      if (nextLeaseVersion > 2_147_483_647 || nextCallbackSequence > 2_147_483_647) {
        throw new RangeError('Remote Run activation sequence overflowed');
      }
      const stepMutation = workflowTask
        ? transitionStepRunMutation(
            workflowStepRun(aggregate),
            {
              expectedVersion: integer(aggregate, 'workflowStepVersion'),
              expectedDigest: text(aggregate, 'workflowStepDigest'),
              mutationId: command.runEventId,
              to: mapping.status,
              atMs: authority.observedAtMs,
              resultCode: mapping.errorCode.toLowerCase(),
              ...(mapping.status === 'cancelled'
                ? {}
                : { errorSummary: mapping.errorSummary }),
            },
            {
              expectedRunVersion: runVersion + 1,
              expectedRunEventSequence: firstSequence,
              eventId: command.runEventId,
              dedupeKey:
                `remote-activation:${command.attemptId}:` +
                `${command.leaseGeneration}:start-failed-step`,
              actor: { type: 'worker', id: command.workerId },
            },
          )
        : null;
      const leaseUpdate = await client.query(
        `
          UPDATE "ql3"."run_dispatch_leases"
          SET status = 'completed', version = $2, completed_at_ms = $3,
              released_at_ms = NULL, release_reason = NULL, updated_at_ms = $3
          WHERE attempt_id = $1 AND status = 'leased' AND version = $4
        `,
        [
          command.attemptId, nextLeaseVersion, authority.observedAtMs,
          command.expectedLeaseVersion,
        ],
      );
      const attemptUpdate = await client.query(
        `
          UPDATE "ql3"."run_attempts"
          SET status = $10, lease_version = $11, callback_sequence = $12,
              finished_at_ms = $13, error_code = $14, error_summary = $15
          WHERE id = $1 AND run_id = $2 AND status = 'starting'
            AND executor_type = 'remote_worker'
            AND worker_id = $3 AND worker_session_id = $4
            AND worker_generation = $5 AND lease_generation = $6
            AND lease_version = $7 AND lease_token_digest = $8 AND offer_id = $9
        `,
        [
          command.attemptId, command.runId, command.workerId,
          command.workerSessionId, command.workerGeneration,
          command.leaseGeneration, command.expectedLeaseVersion,
          digestRunDispatchLeaseToken(command.leaseToken), command.offerId,
          mapping.status, nextLeaseVersion, nextCallbackSequence,
          authority.observedAtMs, mapping.errorCode, mapping.errorSummary,
        ],
      );
      const runUpdate = await client.query(
        `
          UPDATE "ql3"."runs"
          SET status = $2,
              finished_at_ms = $3, error_code = $4,
              error_summary = $5, version = $6, event_sequence = $7
          WHERE id = $1 AND version = $8 AND status = $9
            AND execution_owner = 'runtime'
        `,
        [
          command.runId,
          workflowTask ? 'running' : mapping.status,
          workflowTask ? null : authority.observedAtMs,
          workflowTask ? null : mapping.errorCode,
          workflowTask ? null : mapping.errorSummary,
          runVersion + 2,
          secondSequence,
          runVersion,
          workflowTask ? 'running' : 'dispatching',
        ],
      );
      if (
        leaseUpdate.rowCount !== 1 ||
        attemptUpdate.rowCount !== 1 ||
        runUpdate.rowCount !== 1
      ) reject(command, 'version_mismatch');
      if (stepMutation) {
        await this.persistStepMutation(
          client,
          stepMutation,
          command.attemptId,
        );
      }
      await this.insertEvent(client, {
        id: command.attemptEventId,
        runId: command.runId,
        sequence: firstSequence,
        type: workflowTask
          ? `workflow.task_attempt.${mapping.status}`
          : `attempt.${mapping.status}`,
        dedupeKey: `remote-activation:${command.attemptId}:${command.leaseGeneration}:start-failed-attempt`,
        workerId: command.workerId,
        attemptId: command.attemptId,
        ...(workflowTask
          ? { stepRunId: text(aggregate, 'workflowStepRunId') }
          : {}),
        payload: {
          attempt_id: command.attemptId,
          lease_generation: command.leaseGeneration,
          execution_scope: workflowTask ? 'workflow_task' : 'run',
          from_status: 'starting',
          to_status: mapping.status,
          error_code: mapping.errorCode,
        },
        createdAtMs: authority.observedAtMs,
      });
      if (!stepMutation) {
        await this.insertEvent(client, {
          id: command.runEventId,
          runId: command.runId,
          sequence: secondSequence,
          type: `run.${mapping.status}`,
          dedupeKey: `remote-activation:${command.attemptId}:${command.leaseGeneration}:start-failed-run`,
          workerId: command.workerId,
          attemptId: command.attemptId,
          payload: {
            attempt_id: command.attemptId,
            lease_generation: command.leaseGeneration,
            execution_scope: 'run',
            from_status: 'dispatching',
            to_status: mapping.status,
            error_code: mapping.errorCode,
          },
          createdAtMs: authority.observedAtMs,
        });
      }
      return result('applied', snapshot(aggregate, lease, {
        runStatus: workflowTask ? 'running' : mapping.status,
        attemptStatus: mapping.status,
        leaseVersion: nextLeaseVersion,
        callbackSequence: nextCallbackSequence,
        finishedAtMs: authority.observedAtMs,
        errorCode: mapping.errorCode,
      }));
    });
  }

  private async lockAuthority(
    client: PostgresClient,
    command: RemoteRunActivationFence,
  ): Promise<LockedAuthority> {
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
        SELECT run.id AS "runId", run.status AS "runStatus",
               run.execution_owner AS "executionOwner",
               run.cancel_requested_at_ms AS "cancelRequestedAtMs",
               run.cancel_reason AS "cancelReason",
               run.error_code AS "runErrorCode",
               run.version AS "runVersion",
               run.event_sequence AS "eventSequence",
               execution.plan_json AS "planJson",
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
               attempt.executor_handle AS "executorHandle",
               attempt.log_artifact_id AS "logArtifactId",
               attempt.deadline_at_ms AS "deadlineAtMs",
               attempt.started_at_ms AS "startedAtMs",
               attempt.finished_at_ms AS "finishedAtMs",
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
        INNER JOIN "ql3"."task_execution_revisions" AS execution
          ON execution.project_id =
            COALESCE(workflow_task.project_id, run.project_id)
         AND execution.task_id =
            COALESCE(workflow_task.task_id, run.task_id)
         AND execution.task_revision =
            COALESCE(workflow_task.task_revision, run.task_revision)
         AND execution.executor_type = attempt.executor_type
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

  private assertLiveAuthority(
    command: RemoteRunActivationFence,
    authority: LockedAuthority,
  ): void {
    assertWorkerCurrent(command, authority.worker, authority.observedAtMs);
    assertAggregateIdentity(command, authority.aggregate);
    assertAuthorityProjection(command, authority.aggregate, authority.lease, {
      allowCompletedReplay: false,
    });
    assertLiveLease(command, authority.lease, authority.observedAtMs);
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
        event.id, event.runId, event.sequence, event.type, event.dedupeKey,
        event.workerId, event.attemptId, event.stepRunId ?? null,
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
      throw new RemoteRunActivationFenceRejectedError(
        attemptId,
        'version_mismatch',
      );
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
      throw new RemoteRunActivationUnavailableError({ cause: error });
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
      if (error instanceof RemoteRunActivationFenceRejectedError) {
        throw error;
      }
      throw new RemoteRunActivationUnavailableError({ cause: error });
    } finally {
      client.release();
    }
  }
}
