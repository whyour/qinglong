// PostgreSQL Remote Worker lease control is owned by this domain.
import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import { digestRunDispatchLeaseToken } from '@qinglong/runtime-core';
import {
  InvalidRemoteWorkerLeaseControlError,
  RemoteWorkerLeaseControlFenceRejectedError,
  RemoteWorkerLeaseControlUnavailableError,
  assertRemoteWorkerLeaseControlDuration,
  normalizeRemoteWorkerLeaseControlCommand,
  normalizeRemoteWorkerLeaseControlResult,
  type RemoteWorkerLeaseControlCommand,
  type RemoteWorkerLeaseControlRepository,
  type RemoteWorkerLeaseControlResult,
  type RemoteWorkerStopReason,
  type RemoteWorkerTerminalStatus,
} from '@qinglong/runtime-core/remote-worker-lease-control';
import {
  normalizeStepRunRecord,
  type StepRunRecord,
} from '@qinglong/runtime-core/step-run';
import { lockAttemptAuthority } from '../run/attemptAuthorityLock';

type Row = Record<string, unknown>;
type MutationCommand = RemoteWorkerLeaseControlCommand & Readonly<{
  leaseDurationMs: number;
  timeoutEventId: string;
}>;

const TERMINAL = new Set<RemoteWorkerTerminalStatus>([
  'succeeded', 'failed', 'cancelled', 'timed_out', 'lost',
]);
const STOP_REASONS = new Set<RemoteWorkerStopReason>([
  'user', 'policy', 'shutdown', 'reconcile', 'timeout',
]);

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new TypeError(`PostgreSQL Worker lease control ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const raw = row[key];
  const value = typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw)
    ? Number(raw)
    : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`PostgreSQL Worker lease control ${key} is invalid`);
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
      'PostgreSQL Worker lease control Workflow StepRun is invalid',
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
  command: Pick<RemoteWorkerLeaseControlCommand, 'attemptId'>,
  reason: ConstructorParameters<
    typeof RemoteWorkerLeaseControlFenceRejectedError
  >[1],
): never {
  throw new RemoteWorkerLeaseControlFenceRejectedError(
    command.attemptId,
    reason,
  );
}

function normalizeMutationCommand(value: MutationCommand): MutationCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRemoteWorkerLeaseControlError(
      'lease control mutation is invalid',
    );
  }
  const { leaseDurationMs, timeoutEventId, ...wire } = value;
  const command = normalizeRemoteWorkerLeaseControlCommand(wire);
  assertRemoteWorkerLeaseControlDuration(leaseDurationMs);
  if (
    typeof timeoutEventId !== 'string' || timeoutEventId.length < 1 ||
    timeoutEventId.length > 36 || /[\u0000-\u001f\u007f]/.test(timeoutEventId)
  ) {
    throw new InvalidRemoteWorkerLeaseControlError(
      'timeout event identity is invalid',
    );
  }
  return Object.freeze({ ...command, leaseDurationMs, timeoutEventId });
}

async function begin(client: PostgresClient): Promise<void> {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
}

async function databaseNow(client: PostgresClient): Promise<number> {
  const result = await client.query<Row>(`
    SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS "nowMs"
  `);
  if (result.rows.length !== 1) {
    throw new TypeError('PostgreSQL Worker lease control clock is invalid');
  }
  return integer(result.rows[0]!, 'nowMs');
}

function common(
  command: RemoteWorkerLeaseControlCommand,
): Pick<
  RemoteWorkerLeaseControlResult,
  'projectId' | 'runId' | 'attemptId' | 'offerId' | 'leaseGeneration'
> {
  return {
    projectId: command.projectId,
    runId: command.runId,
    attemptId: command.attemptId,
    offerId: command.offerId,
    leaseGeneration: command.leaseGeneration,
  };
}

function assertIdentity(
  command: RemoteWorkerLeaseControlCommand,
  worker: Row | undefined,
  aggregate: Row | undefined,
  lease: Row | undefined,
  observedAtMs: number,
): asserts aggregate is Row {
  if (!aggregate || !lease) reject(command, 'missing');
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
  ) reject(command, 'worker_unavailable');
  const digest = digestRunDispatchLeaseToken(command.leaseToken);
  if (
    aggregate.runId !== command.runId ||
    aggregate.attemptRunId !== command.runId ||
    lease.runId !== command.runId
  ) reject(command, 'run_mismatch');
  if (aggregate.projectId !== command.projectId) {
    reject(command, 'project_mismatch');
  }
  if (aggregate.executionOwner !== 'runtime') {
    reject(command, 'execution_owner_mismatch');
  }
  if (aggregate.executorType !== 'remote_worker') {
    reject(command, 'executor_mismatch');
  }
  if (
    lease.workerId !== command.workerId ||
    aggregate.attemptWorkerId !== command.workerId
  ) reject(command, 'worker_mismatch');
  if (
    lease.workerSessionId !== command.workerSessionId ||
    aggregate.attemptWorkerSessionId !== command.workerSessionId
  ) reject(command, 'worker_session_mismatch');
  if (
    integer(lease, 'workerGeneration') !== command.workerGeneration ||
    integer(aggregate, 'attemptWorkerGeneration') !== command.workerGeneration
  ) reject(command, 'worker_generation_mismatch');
  if (
    integer(lease, 'leaseGeneration') !== command.leaseGeneration ||
    integer(aggregate, 'attemptLeaseGeneration') !== command.leaseGeneration
  ) reject(command, 'lease_generation_mismatch');
  if (
    lease.leaseTokenDigest !== digest ||
    aggregate.attemptLeaseTokenDigest !== digest
  ) reject(command, 'lease_token_mismatch');
  if (
    lease.offerId !== command.offerId ||
    aggregate.attemptOfferId !== command.offerId
  ) reject(command, 'offer_mismatch');
  if (isWorkflowTaskAttempt(aggregate)) {
    workflowStepRun(aggregate);
  } else if (
    aggregate.attemptStepRunId !== null &&
    aggregate.attemptStepRunId !== undefined
  ) {
    reject(command, 'run_mismatch');
  }
}

export class PostgresRemoteWorkerLeaseControlRepository
  implements RemoteWorkerLeaseControlRepository {
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL Worker lease control pool is invalid');
    }
  }

  async control(
    value: MutationCommand,
  ): Promise<Readonly<RemoteWorkerLeaseControlResult>> {
    const command = normalizeMutationCommand(value);
    return this.transaction(async (client) => {
      await lockAttemptAuthority(client, command.attemptId);
      const worker = await client.query<Row>(`
        SELECT worker_id AS "workerId", session_id AS "sessionId",
               generation AS "workerGeneration", status AS "workerStatus",
               lease_expires_at_ms AS "workerLeaseExpiresAtMs"
        FROM "ql3"."worker_sessions" WHERE worker_id = $1 FOR UPDATE
      `, [command.workerId]);
      const aggregate = await client.query<Row>(`
        SELECT run.id AS "runId",
               COALESCE(workflow_task.project_id, run.project_id)
                 AS "projectId",
               run.status AS "runStatus", run.execution_owner AS "executionOwner",
               run.cancel_requested_at_ms AS "cancelRequestedAtMs",
               run.cancel_reason AS "cancelReason", run.version AS "runVersion",
               run.event_sequence AS "eventSequence",
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
               attempt.deadline_at_ms AS "deadlineAtMs",
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
        WHERE run.id = $1 FOR UPDATE OF run, attempt
      `, [command.runId, command.attemptId]);
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
      const lease = await client.query<Row>(`
        SELECT run_id AS "runId", status AS "leaseStatus",
               version AS "leaseVersion", lease_generation AS "leaseGeneration",
               worker_id AS "workerId", worker_session_id AS "workerSessionId",
               worker_generation AS "workerGeneration",
               lease_token_digest AS "leaseTokenDigest", offer_id AS "offerId",
               expires_at_ms AS "leaseExpiresAtMs"
        FROM "ql3"."run_dispatch_leases"
        WHERE attempt_id = $1 FOR UPDATE
      `, [command.attemptId]);
      const observedAtMs = await databaseNow(client);
      assertIdentity(
        command,
        worker.rows[0],
        lockedAggregate,
        lease.rows[0],
        observedAtMs,
      );
      const state = lockedAggregate!;
      const currentLease = lease.rows[0]!;
      const runStatus = String(state.runStatus);
      const attemptStatus = String(state.attemptStatus);
      const workflowTask = isWorkflowTaskAttempt(state);
      const stepStatus = workflowTask
        ? workflowStepRun(state).status
        : undefined;
      const attemptTerminal = TERMINAL.has(
        attemptStatus as RemoteWorkerTerminalStatus,
      );
      const scopeTerminal = workflowTask
        ? TERMINAL.has(stepStatus as RemoteWorkerTerminalStatus)
        : TERMINAL.has(runStatus as RemoteWorkerTerminalStatus);
      if (
        scopeTerminal ||
        attemptTerminal
      ) {
        if (
          (workflowTask ? stepStatus !== attemptStatus : runStatus !== attemptStatus) ||
          !scopeTerminal ||
          !attemptTerminal ||
          currentLease.leaseStatus !== 'completed'
        ) reject(command, 'state_mismatch');
        return normalizeRemoteWorkerLeaseControlResult({
          status: 'terminal',
          ...common(command),
          terminalStatus: attemptStatus as RemoteWorkerTerminalStatus,
        });
      }
      if (
        currentLease.leaseStatus !== 'leased' ||
        integer(currentLease, 'leaseVersion') !== command.expectedLeaseVersion ||
        integer(state, 'attemptLeaseVersion') !== command.expectedLeaseVersion
      ) reject(command, 'version_mismatch');
      if (integer(currentLease, 'leaseExpiresAtMs') <= observedAtMs) {
        reject(command, 'lease_expired');
      }
      if (
        !['claimed', 'starting', 'running'].includes(attemptStatus) ||
        (workflowTask
          ? runStatus !== 'running' ||
            (attemptStatus === 'running'
              ? stepStatus !== 'running'
              : stepStatus !== 'ready' ||
                !workflowStepAtAdmissionEpoch(state))
          : !['dispatching', 'running'].includes(runStatus) ||
            (attemptStatus === 'running') !== (runStatus === 'running'))
      ) reject(command, 'state_mismatch');

      let cancelRequestedAtMs = optionalInteger(state, 'cancelRequestedAtMs');
      let cancelReason = optionalText(state, 'cancelReason');
      let workflowTimeoutRequestedAtMs: number | undefined;
      const deadlineAtMs = optionalInteger(state, 'deadlineAtMs');
      if (
        cancelRequestedAtMs === undefined &&
        deadlineAtMs !== undefined &&
        deadlineAtMs <= observedAtMs
      ) {
        const runVersion = integer(state, 'runVersion');
        const eventSequence = integer(state, 'eventSequence') + 1;
        if (runVersion >= 2_147_483_647 || eventSequence > 2_147_483_647) {
          throw new RangeError('Worker lease control Run counter overflowed');
        }
        const timeoutDedupeKey =
          `remote-timeout:${command.attemptId}:${command.leaseGeneration}`;
        if (workflowTask) {
          const existing = await client.query<Row>(
            `SELECT created_at_ms AS "createdAtMs"
             FROM "ql3"."run_events"
             WHERE run_id = $1 AND dedupe_key = $2`,
            [command.runId, timeoutDedupeKey],
          );
          if (existing.rows.length > 1) {
            throw new TypeError(
              'PostgreSQL Worker Workflow timeout event is invalid',
            );
          }
          if (existing.rows.length === 1) {
            workflowTimeoutRequestedAtMs = integer(
              existing.rows[0]!,
              'createdAtMs',
            );
          } else {
            const updated = await client.query(`
              UPDATE "ql3"."runs"
              SET version = $2, event_sequence = $3
              WHERE id = $1 AND version = $4
                AND cancel_requested_at_ms IS NULL
                AND status = 'running'
            `, [
              command.runId,
              runVersion + 1,
              eventSequence,
              runVersion,
            ]);
            if (updated.rowCount !== 1) reject(command, 'version_mismatch');
            await client.query(`
              INSERT INTO "ql3"."run_events" (
                id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
                attempt_id, step_run_id, payload, created_at_ms
              ) VALUES (
                $1, $2, $3, 'workflow.task_timeout_requested', $4, 'system',
                'runtime:timeout', $5, $6, $7::jsonb, $8
              )
            `, [
              command.timeoutEventId,
              command.runId,
              eventSequence,
              timeoutDedupeKey,
              command.attemptId,
              text(state, 'workflowStepRunId'),
              JSON.stringify({
                attempt_id: command.attemptId,
                step_run_id: text(state, 'workflowStepRunId'),
                lease_generation: command.leaseGeneration,
                execution_scope: 'workflow_task',
                reason: 'timeout',
                deadline_at_ms: deadlineAtMs,
              }),
              observedAtMs,
            ]);
            workflowTimeoutRequestedAtMs = observedAtMs;
          }
        } else {
          const updated = await client.query(`
            UPDATE "ql3"."runs"
            SET cancel_requested_at_ms = $2, cancel_reason = 'timeout',
                version = $3, event_sequence = $4
            WHERE id = $1 AND version = $5 AND cancel_requested_at_ms IS NULL
              AND status IN ('dispatching', 'running')
          `, [
            command.runId,
            observedAtMs,
            runVersion + 1,
            eventSequence,
            runVersion,
          ]);
          if (updated.rowCount !== 1) reject(command, 'version_mismatch');
          await client.query(`
            INSERT INTO "ql3"."run_events" (
              id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
              attempt_id, step_run_id, payload, created_at_ms
            ) VALUES ($1, $2, $3, 'run.cancel_requested', $4, 'system',
              'runtime:timeout', $5, NULL, $6::jsonb, $7)
          `, [
            command.timeoutEventId,
            command.runId,
            eventSequence,
            timeoutDedupeKey,
            command.attemptId,
            JSON.stringify({
              attempt_id: command.attemptId,
              lease_generation: command.leaseGeneration,
              reason: 'timeout',
              deadline_at_ms: deadlineAtMs,
            }),
            observedAtMs,
          ]);
          cancelRequestedAtMs = observedAtMs;
          cancelReason = 'timeout';
        }
      }
      if (
        (cancelRequestedAtMs === undefined) !== (cancelReason === undefined) ||
        (cancelReason !== undefined &&
          !STOP_REASONS.has(cancelReason as RemoteWorkerStopReason))
      ) {
        throw new TypeError('PostgreSQL Worker cancellation intent is invalid');
      }
      const stopReason =
        cancelReason ??
        (workflowTimeoutRequestedAtMs === undefined ? undefined : 'timeout');
      const stopRequestedAtMs =
        cancelRequestedAtMs ?? workflowTimeoutRequestedAtMs;

      const nextVersion = command.expectedLeaseVersion + 1;
      if (nextVersion > 2_147_483_647) {
        throw new RangeError('Worker lease control version overflowed');
      }
      const expiresAtMs = observedAtMs + command.leaseDurationMs;
      const renewed = await client.query<Row>(`
        UPDATE "ql3"."run_dispatch_leases"
        SET version = $2, renewed_at_ms = $3, expires_at_ms = $4,
            updated_at_ms = $3
        WHERE attempt_id = $1 AND status = 'leased' AND version = $5
        RETURNING renewed_at_ms AS "renewedAtMs", expires_at_ms AS "expiresAtMs"
      `, [
        command.attemptId,
        nextVersion,
        observedAtMs,
        expiresAtMs,
        command.expectedLeaseVersion,
      ]);
      const attempt = await client.query(`
        UPDATE "ql3"."run_attempts"
        SET lease_version = $2, lease_expires_at_ms = $3
        WHERE id = $1 AND lease_version = $4
          AND status IN ('claimed', 'starting', 'running')
      `, [
        command.attemptId,
        nextVersion,
        expiresAtMs,
        command.expectedLeaseVersion,
      ]);
      if (renewed.rows.length !== 1 || attempt.rowCount !== 1) {
        reject(command, 'version_mismatch');
      }
      const result = {
        status: stopReason === undefined
          ? 'renewed' as const
          : 'stop_requested' as const,
        ...common(command),
        leaseVersion: nextVersion,
        renewedAtMs: integer(renewed.rows[0]!, 'renewedAtMs'),
        expiresAtMs: integer(renewed.rows[0]!, 'expiresAtMs'),
        ...(stopReason === undefined
          ? {}
          : {
              stop: Object.freeze({
                reason: stopReason as RemoteWorkerStopReason,
                requestedAtMs: stopRequestedAtMs!,
              }),
            }),
      };
      return normalizeRemoteWorkerLeaseControlResult(result);
    });
  }

  private async transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new RemoteWorkerLeaseControlUnavailableError({ cause: error });
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
      if (
        error instanceof RemoteWorkerLeaseControlFenceRejectedError ||
        error instanceof InvalidRemoteWorkerLeaseControlError
      ) throw error;
      throw new RemoteWorkerLeaseControlUnavailableError({ cause: error });
    } finally {
      client.release();
    }
  }
}
