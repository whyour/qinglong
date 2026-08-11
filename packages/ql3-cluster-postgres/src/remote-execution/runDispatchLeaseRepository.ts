// PostgreSQL Remote Execution dispatch leases are owned by this domain.
import type {
  ClaimRunDispatchLeaseCommand,
  ClaimRunDispatchLeaseResult,
  PostgresClient,
  PostgresPool,
  ReleaseRunDispatchLeaseCommand,
  RenewRunDispatchLeaseCommand,
  RunDispatchLeaseRecord,
  RunDispatchLeaseRepository,
  RunDispatchLeaseStatus,
} from '@qinglong/runtime-core';
import {
  RUN_DISPATCH_LEASE_STATUSES,
  RunDispatchLeaseFenceRejectedError,
  assertRunDispatchId,
  assertRunDispatchLeaseDuration,
  assertRunDispatchLeaseFence,
  assertRunDispatchLeaseRecord,
  digestRunDispatchLeaseToken,
} from '@qinglong/runtime-core';
import { lockAttemptAuthority } from '../run/attemptAuthorityLock';

type Row = Record<string, unknown>;

const LEASE_COLUMNS = `
  attempt_id AS "attemptId",
  run_id AS "runId",
  status AS "status",
  version AS "version",
  lease_generation AS "leaseGeneration",
  worker_id AS "workerId",
  worker_session_id AS "workerSessionId",
  worker_generation AS "workerGeneration",
  lease_token_digest AS "leaseTokenDigest",
  acquired_at_ms AS "acquiredAtMs",
  renewed_at_ms AS "renewedAtMs",
  expires_at_ms AS "expiresAtMs",
  released_at_ms AS "releasedAtMs",
  release_reason AS "releaseReason",
  completed_at_ms AS "completedAtMs",
  updated_at_ms AS "updatedAtMs"
`.trim();

function string(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`PostgreSQL Run dispatch lease ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  const normalized =
    typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : value;
  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized)) {
    throw new TypeError(`PostgreSQL Run dispatch lease ${key} is invalid`);
  }
  return normalized;
}

function optionalInteger(row: Row, key: string): number | undefined {
  return row[key] === null || row[key] === undefined ? undefined : integer(row, key);
}

function optionalString(row: Row, key: string): string | undefined {
  return row[key] === null || row[key] === undefined ? undefined : string(row, key);
}

function lease(row: Row): RunDispatchLeaseRecord {
  const status = string(row, 'status');
  if (!RUN_DISPATCH_LEASE_STATUSES.includes(status as RunDispatchLeaseStatus)) {
    throw new TypeError('PostgreSQL Run dispatch lease status is invalid');
  }
  const releasedAtMs = optionalInteger(row, 'releasedAtMs');
  const releaseReason = optionalString(row, 'releaseReason');
  const completedAtMs = optionalInteger(row, 'completedAtMs');
  const value: RunDispatchLeaseRecord = Object.freeze({
    attemptId: string(row, 'attemptId'),
    runId: string(row, 'runId'),
    status: status as RunDispatchLeaseStatus,
    version: integer(row, 'version'),
    leaseGeneration: integer(row, 'leaseGeneration'),
    workerId: string(row, 'workerId'),
    workerSessionId: string(row, 'workerSessionId'),
    workerGeneration: integer(row, 'workerGeneration'),
    leaseTokenDigest: string(row, 'leaseTokenDigest'),
    acquiredAtMs: integer(row, 'acquiredAtMs'),
    renewedAtMs: integer(row, 'renewedAtMs'),
    expiresAtMs: integer(row, 'expiresAtMs'),
    updatedAtMs: integer(row, 'updatedAtMs'),
    ...(releasedAtMs === undefined ? {} : { releasedAtMs }),
    ...(releaseReason === undefined
      ? {}
      : {
          releaseReason: releaseReason as NonNullable<
            RunDispatchLeaseRecord['releaseReason']
          >,
        }),
    ...(completedAtMs === undefined ? {} : { completedAtMs }),
  });
  assertRunDispatchLeaseRecord(value);
  return value;
}

function bounded(name: string, value: string): void {
  assertRunDispatchId(name, value);
}

function assertClaim(command: ClaimRunDispatchLeaseCommand): void {
  bounded('runId', command.runId);
  bounded('attemptId', command.attemptId);
  bounded('eventId', command.eventId);
  bounded('offerId', command.offerId);
  assertRunDispatchLeaseFence({
    ...command,
    leaseGeneration: 1,
    expectedVersion: 0,
  });
  assertRunDispatchLeaseDuration(command.leaseDurationMs);
}

function assertRenew(command: RenewRunDispatchLeaseCommand): void {
  bounded('attemptId', command.attemptId);
  assertRunDispatchLeaseFence(command);
  assertRunDispatchLeaseDuration(command.leaseDurationMs);
}

function assertRelease(command: ReleaseRunDispatchLeaseCommand): void {
  bounded('runId', command.runId);
  bounded('attemptId', command.attemptId);
  bounded('eventId', command.eventId);
  assertRunDispatchLeaseFence(command);
  if (
    !['declined', 'shutdown', 'start_failed', 'capacity_changed'].includes(
      command.reason,
    )
  ) {
    throw new TypeError('Run dispatch release reason is invalid');
  }
}

async function begin(client: PostgresClient): Promise<void> {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
}

async function now(client: PostgresClient): Promise<number> {
  const result = await client.query<Row>(`
    SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint AS "nowMs"
  `);
  if (result.rows.length !== 1) {
    throw new TypeError('PostgreSQL Run lease observation is invalid');
  }
  return integer(result.rows[0]!, 'nowMs');
}

function sameFence(
  current: RunDispatchLeaseRecord,
  command: {
    workerId: string;
    workerSessionId: string;
    workerGeneration: number;
    leaseGeneration: number;
    leaseToken: string;
  },
): boolean {
  return (
    current.workerId === command.workerId &&
    current.workerSessionId === command.workerSessionId &&
    current.workerGeneration === command.workerGeneration &&
    current.leaseGeneration === command.leaseGeneration &&
    current.leaseTokenDigest === digestRunDispatchLeaseToken(command.leaseToken)
  );
}

function assertLeaseFence(
  current: RunDispatchLeaseRecord | null,
  command: RenewRunDispatchLeaseCommand | ReleaseRunDispatchLeaseCommand,
  observedAtMs: number,
): asserts current is RunDispatchLeaseRecord {
  if (!current) throw new RunDispatchLeaseFenceRejectedError(command.attemptId, 'missing');
  if ('runId' in command && current.runId !== command.runId) {
    throw new RunDispatchLeaseFenceRejectedError(command.attemptId, 'run_mismatch');
  }
  if (current.workerId !== command.workerId) {
    throw new RunDispatchLeaseFenceRejectedError(command.attemptId, 'worker_mismatch');
  }
  if (current.workerSessionId !== command.workerSessionId) {
    throw new RunDispatchLeaseFenceRejectedError(
      command.attemptId,
      'worker_session_mismatch',
    );
  }
  if (current.workerGeneration !== command.workerGeneration) {
    throw new RunDispatchLeaseFenceRejectedError(
      command.attemptId,
      'worker_generation_mismatch',
    );
  }
  if (current.leaseGeneration !== command.leaseGeneration) {
    throw new RunDispatchLeaseFenceRejectedError(
      command.attemptId,
      'lease_generation_mismatch',
    );
  }
  if (current.leaseTokenDigest !== digestRunDispatchLeaseToken(command.leaseToken)) {
    throw new RunDispatchLeaseFenceRejectedError(
      command.attemptId,
      'lease_token_mismatch',
    );
  }
  if (current.version !== command.expectedVersion) {
    throw new RunDispatchLeaseFenceRejectedError(command.attemptId, 'version_mismatch');
  }
  if (current.status !== 'leased') {
    throw new RunDispatchLeaseFenceRejectedError(command.attemptId, 'not_leased');
  }
  if (current.expiresAtMs <= observedAtMs) {
    throw new RunDispatchLeaseFenceRejectedError(command.attemptId, 'lease_expired');
  }
}

function workerCurrent(
  row: Row | undefined,
  command: {
    workerId: string;
    workerSessionId: string;
    workerGeneration: number;
  },
  observedAtMs: number,
  allowDraining: boolean,
): boolean {
  return Boolean(
    row &&
      row.workerId === command.workerId &&
      row.sessionId === command.workerSessionId &&
      integer(row, 'generation') === command.workerGeneration &&
      (row.status === 'online' || (allowDraining && row.status === 'draining')) &&
      integer(row, 'leaseExpiresAtMs') > observedAtMs,
  );
}

export class PostgresRunDispatchLeaseRepository
  implements RunDispatchLeaseRepository
{
  constructor(private readonly pool: PostgresPool) {}

  async findByAttemptId(
    attemptId: string,
  ): Promise<RunDispatchLeaseRecord | null> {
    bounded('attemptId', attemptId);
    const result = await this.pool.query<Row>(
      `SELECT ${LEASE_COLUMNS} FROM "ql3"."run_dispatch_leases" WHERE attempt_id = $1`,
      [attemptId],
    );
    if (result.rows.length > 1) {
      throw new TypeError('PostgreSQL Run lease lookup returned multiple rows');
    }
    return result.rows[0] ? lease(result.rows[0]) : null;
  }

  async claim(
    command: ClaimRunDispatchLeaseCommand,
  ): Promise<ClaimRunDispatchLeaseResult> {
    assertClaim(command);
    return this.transaction(async (client) => {
      await lockAttemptAuthority(client, command.attemptId);
      const workerResult = await client.query<Row>(
        `
          SELECT worker_id AS "workerId", session_id AS "sessionId",
                 generation, status, max_concurrent_runs AS "maxConcurrentRuns",
                 available_slots AS "availableSlots",
                 lease_expires_at_ms AS "leaseExpiresAtMs"
          FROM "ql3"."worker_sessions" WHERE worker_id = $1 FOR UPDATE
        `,
        [command.workerId],
      );
      const worker = workerResult.rows[0];
      const aggregateResult = await client.query<Row>(
        `
          SELECT run.id AS "runId", run.status AS "runStatus",
                 run.execution_owner AS "executionOwner",
                 run.cancel_requested_at_ms AS "cancelRequestedAtMs",
                 run.version AS "runVersion", run.event_sequence AS "eventSequence",
                 attempt.id AS "attemptId", attempt.status AS "attemptStatus",
                 attempt.run_id AS "attemptRunId",
                 attempt.step_run_id AS "attemptStepRunId",
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
      const aggregate = aggregateResult.rows[0];
      const workflowAttempt =
        aggregate?.workflowAttemptId !== null &&
        aggregate?.workflowAttemptId !== undefined;
      const workflowStep = workflowAttempt
        ? (
            await client.query<Row>(
              `SELECT status AS "workflowStepStatus",
                      version AS "workflowStepVersion",
                      step_run_digest AS "workflowStepDigest"
               FROM "ql3"."step_runs"
               WHERE run_id = $1 AND id = $2
               FOR UPDATE`,
              [command.runId, aggregate!.workflowStepRunId],
            )
          ).rows[0]
        : undefined;
      const workflowEligible = Boolean(
        workflowAttempt &&
          aggregate!.runStatus === 'running' &&
          aggregate!.attemptStepRunId === aggregate!.workflowStepRunId &&
          workflowStep?.workflowStepStatus === 'ready' &&
          integer(workflowStep!, 'workflowStepVersion') ===
            integer(aggregate!, 'admittedWorkflowStepVersion') &&
          workflowStep!.workflowStepDigest ===
            aggregate!.admittedWorkflowStepDigest,
      );
      const runEligible = Boolean(
        !workflowAttempt &&
          ['queued', 'dispatching'].includes(String(aggregate?.runStatus)),
      );
      if (
        !aggregate ||
        aggregate.executionOwner !== 'runtime' ||
        aggregate.cancelRequestedAtMs !== null ||
        aggregate.attemptRunId !== command.runId ||
        aggregate.attemptStatus !== 'claimed' ||
        (!runEligible && !workflowEligible)
      ) {
        return Object.freeze({ status: 'not_eligible' as const });
      }
      const currentResult = await client.query<Row>(
        `SELECT ${LEASE_COLUMNS}, offer_id AS "offerId" FROM "ql3"."run_dispatch_leases" WHERE attempt_id = $1 FOR UPDATE`,
        [command.attemptId],
      );
      const current = currentResult.rows[0] ? lease(currentResult.rows[0]) : null;
      const observedAtMs = await now(client);
      if (!workerCurrent(worker, command, observedAtMs, false)) {
        return Object.freeze({ status: 'worker_unavailable' as const });
      }
      if (current && current.runId !== command.runId) {
        throw new RunDispatchLeaseFenceRejectedError(command.attemptId, 'run_mismatch');
      }
      if (current?.status === 'leased' && current.expiresAtMs > observedAtMs) {
        if (
          sameFence(current, {
            ...command,
            leaseGeneration: current.leaseGeneration,
          }) &&
          currentResult.rows[0]!.offerId === command.offerId
        ) {
          return Object.freeze({ status: 'idempotent' as const, lease: current });
        }
        return Object.freeze({ status: 'leased' as const, lease: current });
      }
      if (current?.status === 'completed') {
        return Object.freeze({ status: 'not_eligible' as const });
      }
      const active = await client.query<Row>(
        `
          SELECT count(*)::integer AS "activeCount"
          FROM "ql3"."run_dispatch_leases"
          WHERE worker_id = $1 AND worker_session_id = $2
            AND worker_generation = $3 AND status = 'leased'
            AND expires_at_ms > $4 AND attempt_id <> $5
        `,
        [
          command.workerId,
          command.workerSessionId,
          command.workerGeneration,
          observedAtMs,
          command.attemptId,
        ],
      );
      const activeCount = integer(active.rows[0]!, 'activeCount');
      if (
        activeCount >= integer(worker!, 'maxConcurrentRuns') ||
        activeCount >= integer(worker!, 'availableSlots')
      ) {
        return Object.freeze({ status: 'capacity_exhausted' as const });
      }
      const leaseGeneration = (current?.leaseGeneration ?? 0) + 1;
      const version = current ? current.version + 1 : 0;
      if (leaseGeneration > 2_147_483_647 || version > 2_147_483_647) {
        throw new RangeError('Run dispatch lease generation or version overflowed');
      }
      const digest = digestRunDispatchLeaseToken(command.leaseToken);
      const expiresAtMs = observedAtMs + command.leaseDurationMs;
      const persisted = await client.query<Row>(
        `
          INSERT INTO "ql3"."run_dispatch_leases" (
            attempt_id, run_id, status, version, lease_generation,
            worker_id, worker_session_id, worker_generation,
            lease_token_digest, offer_id, acquired_at_ms, renewed_at_ms,
            expires_at_ms, released_at_ms, release_reason, completed_at_ms,
            updated_at_ms
          ) VALUES ($1, $2, 'leased', $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, NULL, NULL, NULL, $10)
          ON CONFLICT (attempt_id) DO UPDATE SET
            run_id = EXCLUDED.run_id,
            status = EXCLUDED.status,
            version = EXCLUDED.version,
            lease_generation = EXCLUDED.lease_generation,
            worker_id = EXCLUDED.worker_id,
            worker_session_id = EXCLUDED.worker_session_id,
            worker_generation = EXCLUDED.worker_generation,
            lease_token_digest = EXCLUDED.lease_token_digest,
            offer_id = EXCLUDED.offer_id,
            acquired_at_ms = EXCLUDED.acquired_at_ms,
            renewed_at_ms = EXCLUDED.renewed_at_ms,
            expires_at_ms = EXCLUDED.expires_at_ms,
            released_at_ms = NULL,
            release_reason = NULL,
            completed_at_ms = NULL,
            updated_at_ms = EXCLUDED.updated_at_ms
          RETURNING ${LEASE_COLUMNS}
        `,
        [
          command.attemptId,
          command.runId,
          version,
          leaseGeneration,
          command.workerId,
          command.workerSessionId,
          command.workerGeneration,
          digest,
          command.offerId,
          observedAtMs,
          expiresAtMs,
        ],
      );
      const attemptUpdate = await client.query(
        `
          UPDATE "ql3"."run_attempts"
          SET worker_id = $3, worker_session_id = $4, worker_generation = $5,
              lease_token = NULL, lease_token_digest = $6,
              lease_generation = $7, lease_version = $8,
              lease_expires_at_ms = $9, offer_id = $10
          WHERE id = $1 AND run_id = $2 AND status = 'claimed'
        `,
        [
          command.attemptId,
          command.runId,
          command.workerId,
          command.workerSessionId,
          command.workerGeneration,
          digest,
          leaseGeneration,
          version,
          expiresAtMs,
          command.offerId,
        ],
      );
      if (attemptUpdate.rowCount !== 1) {
        throw new RunDispatchLeaseFenceRejectedError(command.attemptId, 'version_mismatch');
      }
      const nextSequence = integer(aggregate, 'eventSequence') + 1;
      const nextVersion = integer(aggregate, 'runVersion') + 1;
      const eventType = workflowAttempt
        ? 'workflow.task_dispatch_leased'
        : aggregate.runStatus === 'queued'
          ? 'run.dispatching'
          : 'run.dispatch_reclaimed';
      const runUpdate = await client.query(
        `
          UPDATE "ql3"."runs"
          SET status = $2, version = $3, event_sequence = $4
          WHERE id = $1 AND version = $5
        `,
        [
          command.runId,
          workflowAttempt ? 'running' : 'dispatching',
          nextVersion,
          nextSequence,
          integer(aggregate, 'runVersion'),
        ],
      );
      if (runUpdate.rowCount !== 1) {
        throw new RunDispatchLeaseFenceRejectedError(command.attemptId, 'version_mismatch');
      }
      await client.query(
        `
          INSERT INTO "ql3"."run_events" (
            id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
            attempt_id, step_run_id, payload, created_at_ms
          ) VALUES ($1, $2, $3, $4, $5, 'worker', $6, $7, $8, $9::jsonb, $10)
        `,
        [
          command.eventId,
          command.runId,
          nextSequence,
          eventType,
          `run-dispatch:${command.attemptId}:${leaseGeneration}:claimed`,
          command.workerId,
          command.attemptId,
          workflowAttempt ? aggregate.workflowStepRunId : null,
          JSON.stringify({
            attempt_id: command.attemptId,
            lease_generation: leaseGeneration,
            execution_scope: workflowAttempt ? 'workflow_task' : 'run',
            from_status: workflowAttempt ? 'ready' : aggregate.runStatus,
            to_status: workflowAttempt ? 'ready' : 'dispatching',
          }),
          observedAtMs,
        ],
      );
      if (persisted.rows.length !== 1) {
        throw new TypeError('PostgreSQL Run lease claim returned no row');
      }
      return Object.freeze({ status: 'claimed' as const, lease: lease(persisted.rows[0]!) });
    });
  }

  async renew(
    command: RenewRunDispatchLeaseCommand,
  ): Promise<RunDispatchLeaseRecord> {
    assertRenew(command);
    return this.transaction(async (client) => {
      await lockAttemptAuthority(client, command.attemptId);
      const workerResult = await this.lockWorker(client, command.workerId);
      const current = await this.lockLease(client, command.attemptId);
      const observedAtMs = await now(client);
      if (!workerCurrent(workerResult, command, observedAtMs, true)) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'worker_unavailable',
        );
      }
      assertLeaseFence(current, command, observedAtMs);
      const nextVersion = current.version + 1;
      if (nextVersion > 2_147_483_647) {
        throw new RangeError('Run dispatch lease version overflowed');
      }
      const expiresAtMs = observedAtMs + command.leaseDurationMs;
      const result = await client.query<Row>(
        `
          UPDATE "ql3"."run_dispatch_leases"
          SET version = $2, renewed_at_ms = $3, expires_at_ms = $4, updated_at_ms = $3
          WHERE attempt_id = $1 AND version = $5
          RETURNING ${LEASE_COLUMNS}
        `,
        [command.attemptId, nextVersion, observedAtMs, expiresAtMs, current.version],
      );
      const attempt = await client.query(
        `
          UPDATE "ql3"."run_attempts"
          SET lease_version = $2, lease_expires_at_ms = $3
          WHERE id = $1 AND worker_id = $4 AND worker_session_id = $5
            AND worker_generation = $6 AND lease_generation = $7
            AND lease_token_digest = $8 AND lease_version = $9
            AND status IN ('claimed', 'starting', 'running')
        `,
        [
          command.attemptId,
          nextVersion,
          expiresAtMs,
          command.workerId,
          command.workerSessionId,
          command.workerGeneration,
          command.leaseGeneration,
          digestRunDispatchLeaseToken(command.leaseToken),
          command.expectedVersion,
        ],
      );
      if (result.rows.length !== 1 || attempt.rowCount !== 1) {
        throw new RunDispatchLeaseFenceRejectedError(command.attemptId, 'version_mismatch');
      }
      return lease(result.rows[0]!);
    });
  }

  async release(
    command: ReleaseRunDispatchLeaseCommand,
  ): Promise<RunDispatchLeaseRecord> {
    assertRelease(command);
    return this.transaction(async (client) => {
      await lockAttemptAuthority(client, command.attemptId);
      const worker = await this.lockWorker(client, command.workerId);
      const current = await this.lockLease(client, command.attemptId);
      const aggregate = await client.query<Row>(
        `
          SELECT run.version AS "runVersion", run.event_sequence AS "eventSequence",
                 attempt.status AS "attemptStatus",
                 workflow_task.step_run_id AS "workflowStepRunId"
          FROM "ql3"."runs" AS run
          INNER JOIN "ql3"."run_attempts" AS attempt ON attempt.id = $2
          LEFT JOIN
            "ql3"."plugin_package_workflow_task_attempt_admissions"
              AS workflow_task
            ON workflow_task.attempt_id = attempt.id
          WHERE run.id = $1 AND attempt.run_id = run.id
          FOR UPDATE OF run, attempt
        `,
        [command.runId, command.attemptId],
      );
      const observedAtMs = await now(client);
      if (!workerCurrent(worker, command, observedAtMs, true)) {
        throw new RunDispatchLeaseFenceRejectedError(
          command.attemptId,
          'worker_unavailable',
        );
      }
      assertLeaseFence(current, command, observedAtMs);
      if (aggregate.rows[0]?.attemptStatus !== 'claimed') {
        throw new RunDispatchLeaseFenceRejectedError(command.attemptId, 'not_leased');
      }
      const nextVersion = current.version + 1;
      const result = await client.query<Row>(
        `
          UPDATE "ql3"."run_dispatch_leases"
          SET status = 'released', version = $2, released_at_ms = $3,
              release_reason = $4, completed_at_ms = NULL, updated_at_ms = $3
          WHERE attempt_id = $1 AND version = $5
          RETURNING ${LEASE_COLUMNS}
        `,
        [command.attemptId, nextVersion, observedAtMs, command.reason, current.version],
      );
      const attempt = await client.query(
        `
          UPDATE "ql3"."run_attempts"
          SET worker_id = NULL, worker_session_id = NULL, worker_generation = NULL,
              lease_token = NULL, lease_token_digest = NULL,
              lease_generation = NULL, lease_version = NULL,
              lease_expires_at_ms = NULL, offer_id = NULL
          WHERE id = $1 AND lease_version = $2
        `,
        [command.attemptId, command.expectedVersion],
      );
      const aggregateRow = aggregate.rows[0]!;
      const workflowStepRunId = optionalString(
        aggregateRow,
        'workflowStepRunId',
      );
      const runVersion = integer(aggregateRow, 'runVersion');
      const eventSequence = integer(aggregateRow, 'eventSequence') + 1;
      const run = await client.query(
        `UPDATE "ql3"."runs" SET version = $2, event_sequence = $3 WHERE id = $1 AND version = $4`,
        [command.runId, runVersion + 1, eventSequence, runVersion],
      );
      if (result.rows.length !== 1 || attempt.rowCount !== 1 || run.rowCount !== 1) {
        throw new RunDispatchLeaseFenceRejectedError(command.attemptId, 'version_mismatch');
      }
      await client.query(
        `
          INSERT INTO "ql3"."run_events" (
            id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
            attempt_id, step_run_id, payload, created_at_ms
          ) VALUES ($1, $2, $3, $4, $5, 'worker', $6, $7, $8, $9::jsonb, $10)
        `,
        [
          command.eventId,
          command.runId,
          eventSequence,
          workflowStepRunId
            ? 'workflow.task_dispatch_released'
            : 'run.dispatch_released',
          `run-dispatch:${command.attemptId}:${command.leaseGeneration}:released`,
          command.workerId,
          command.attemptId,
          workflowStepRunId ?? null,
          JSON.stringify({
            attempt_id: command.attemptId,
            lease_generation: command.leaseGeneration,
            execution_scope: workflowStepRunId ? 'workflow_task' : 'run',
            reason: command.reason,
          }),
          observedAtMs,
        ],
      );
      return lease(result.rows[0]!);
    });
  }

  private async lockWorker(
    client: PostgresClient,
    workerId: string,
  ): Promise<Row | undefined> {
    const result = await client.query<Row>(
      `
        SELECT worker_id AS "workerId", session_id AS "sessionId",
               generation, status, lease_expires_at_ms AS "leaseExpiresAtMs"
        FROM "ql3"."worker_sessions" WHERE worker_id = $1 FOR UPDATE
      `,
      [workerId],
    );
    return result.rows[0];
  }

  private async lockLease(
    client: PostgresClient,
    attemptId: string,
  ): Promise<RunDispatchLeaseRecord | null> {
    const result = await client.query<Row>(
      `SELECT ${LEASE_COLUMNS} FROM "ql3"."run_dispatch_leases" WHERE attempt_id = $1 FOR UPDATE`,
      [attemptId],
    );
    return result.rows[0] ? lease(result.rows[0]) : null;
  }

  private async transaction<T>(
    work: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await begin(client);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the originating failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
