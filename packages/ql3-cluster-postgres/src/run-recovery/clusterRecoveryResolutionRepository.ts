// PostgreSQL authority adapter for cluster run recovery resolution.
import { randomUUID } from 'node:crypto';
import {
  ClusterControlRecoveryStoreError,
  buildClusterControlRecoveryLostTransition,
  buildPluginPackageWorkflowTaskRecovery,
  type ClusterControlRecoveryClaim,
  type ClusterControlRecoveryLostAction,
  type ClusterControlRecoveryResolutionRepository,
  type ClusterControlRecoverySnapshot,
  type PostgresClient,
  type PostgresPool,
  type RunAttemptRecord,
  type RunEventRecord,
  type RunRecord,
} from '@qinglong/runtime-core';
import type {
  PluginPackageWorkflowTaskAttemptAdmissionReceipt,
} from '@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission';
import type {
  StepRunMutation,
  StepRunRecord,
} from '@qinglong/runtime-core/step-run';
import { lockAttemptAuthority } from '../run/attemptAuthorityLock';
import { PostgresRunTransaction } from '../run/runRepository';

type ObservationRow = Record<string, unknown> & {
  observedAtMs: unknown;
};

type WorkflowTaskRow = Record<string, unknown> & {
  admissionJson: unknown;
  stepRunJson: unknown;
};

const LOAD_FENCE_SQL = `
WITH observation AS (
  SELECT floor(
    extract(epoch FROM statement_timestamp()) * 1000
  )::bigint AS observed_at_ms
)
SELECT observation.observed_at_ms AS "observedAtMs"
FROM "ql3"."run_recovery_controls" AS control
CROSS JOIN observation
WHERE control.target_kind = $1
  AND control.target_id = $2
  AND control.state = 'claimed'
  AND control.claim_owner = $3
  AND control.claim_token = $4
  AND control.claim_version = $5
  AND control.claim_expires_at_ms > observation.observed_at_ms
`.trim();

const LOCK_FENCE_SQL = `${LOAD_FENCE_SQL}
FOR UPDATE OF control`.trim();

const TRANSACTION_STATEMENT_TIMEOUT_MS = 5_000;
const TRANSACTION_LOCK_TIMEOUT_MS = 1_000;
const TRANSACTION_IDLE_TIMEOUT_MS = 10_000;

class RecoverySnapshotStaleError extends Error {}

function observedAtMs(value: unknown): number {
  const converted =
    typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (
    typeof converted !== 'number' ||
    !Number.isSafeInteger(converted) ||
    converted < 0
  ) {
    throw new TypeError(
      'PostgreSQL recovery resolution observation is invalid',
    );
  }
  return converted;
}

function oneObservation(rows: readonly ObservationRow[]): number | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new TypeError(
      'PostgreSQL recovery resolution returned duplicate control rows',
    );
  }
  return observedAtMs(rows[0]!.observedAtMs);
}

function frozenRun(run: RunRecord | null): Readonly<RunRecord> | null {
  return run === null ? null : Object.freeze({ ...run });
}

function frozenAttempt(
  attempt: RunAttemptRecord | null,
): Readonly<RunAttemptRecord> | null {
  return attempt === null ? null : Object.freeze({ ...attempt });
}

async function readSnapshot(
  client: PostgresClient,
  runs: PostgresRunTransaction,
  claim: ClusterControlRecoveryClaim,
  observation: number,
): Promise<ClusterControlRecoverySnapshot> {
  const run = await runs.findRunById(claim.candidate.runId);
  const attempt =
    claim.candidate.kind === 'attempt'
      ? await runs.findAttemptById(claim.candidate.id)
      : await runs.findLatestAttemptByRunId(claim.candidate.runId);
  let workflowTask:
    | Readonly<{
        admission:
          Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt>;
        stepRun: Readonly<StepRunRecord>;
      }>
    | null = null;
  if (claim.candidate.kind === 'attempt') {
    const result = await client.query<WorkflowTaskRow>(
      `SELECT admission.receipt_json AS "admissionJson",
              step.step_run_json AS "stepRunJson"
       FROM "ql3"."plugin_package_workflow_task_attempt_admissions"
         AS admission
       JOIN "ql3"."step_runs" AS step
         ON step.id = admission.step_run_id
        AND step.run_id = admission.run_id
       WHERE admission.attempt_id = $1
         AND admission.run_id = $2
       LIMIT 2`,
      [claim.candidate.id, claim.candidate.runId],
    );
    if (result.rows.length > 1) {
      throw new TypeError(
        'PostgreSQL recovery returned duplicate Workflow Task authority',
      );
    }
    const row = result.rows[0];
    if (row) {
      if (
        !row.admissionJson ||
        typeof row.admissionJson !== 'object' ||
        Array.isArray(row.admissionJson) ||
        !row.stepRunJson ||
        typeof row.stepRunJson !== 'object' ||
        Array.isArray(row.stepRunJson)
      ) {
        throw new TypeError(
          'PostgreSQL recovery returned invalid Workflow Task authority',
        );
      }
      workflowTask = Object.freeze({
        admission: Object.freeze({
          ...(row.admissionJson as
            PluginPackageWorkflowTaskAttemptAdmissionReceipt),
        }),
        stepRun: Object.freeze({
          ...(row.stepRunJson as StepRunRecord),
        }),
      });
    }
  }
  return Object.freeze({
    observedAtMs: observation,
    run: frozenRun(run),
    attempt: frozenAttempt(attempt),
    workflowTask,
  });
}

function sameRun(
  expected: Readonly<RunRecord> | null,
  current: Readonly<RunRecord> | null,
): boolean {
  if (expected === null || current === null) return expected === current;
  return (
    expected.id === current.id &&
    expected.executionOwner === current.executionOwner &&
    expected.status === current.status &&
    expected.version === current.version &&
    expected.eventSequence === current.eventSequence &&
    expected.createdAtMs === current.createdAtMs &&
    expected.startedAtMs === current.startedAtMs &&
    expected.cancelRequestedAtMs === current.cancelRequestedAtMs &&
    expected.cancelReason === current.cancelReason
  );
}

function sameAttempt(
  expected: Readonly<RunAttemptRecord> | null,
  current: Readonly<RunAttemptRecord> | null,
): boolean {
  if (expected === null || current === null) return expected === current;
  return (
    expected.id === current.id &&
    expected.runId === current.runId &&
    expected.stepRunId === current.stepRunId &&
    expected.attempt === current.attempt &&
    expected.status === current.status &&
    expected.executorType === current.executorType &&
    expected.workerId === current.workerId &&
    expected.workerSessionId === current.workerSessionId &&
    expected.workerGeneration === current.workerGeneration &&
    expected.executorHandle === current.executorHandle &&
    expected.pid === current.pid &&
    expected.leaseToken === current.leaseToken &&
    expected.leaseTokenDigest === current.leaseTokenDigest &&
    expected.leaseGeneration === current.leaseGeneration &&
    expected.leaseVersion === current.leaseVersion &&
    expected.leaseExpiresAtMs === current.leaseExpiresAtMs &&
    expected.offerId === current.offerId &&
    expected.deadlineAtMs === current.deadlineAtMs &&
    expected.callbackTokenHash === current.callbackTokenHash &&
    expected.callbackSequence === current.callbackSequence &&
    expected.createdAtMs === current.createdAtMs &&
    expected.startedAtMs === current.startedAtMs &&
    expected.finishedAtMs === current.finishedAtMs &&
    expected.exitCode === current.exitCode &&
    expected.errorCode === current.errorCode &&
    expected.errorSummary === current.errorSummary
  );
}

function sameWorkflowTask(
  expected: ClusterControlRecoverySnapshot['workflowTask'],
  current: ClusterControlRecoverySnapshot['workflowTask'],
): boolean {
  const left = expected ?? null;
  const right = current ?? null;
  if (left === null || right === null) return left === right;
  return (
    left.admission.receiptDigest === right.admission.receiptDigest &&
    left.admission.attemptId === right.admission.attemptId &&
    left.admission.runId === right.admission.runId &&
    left.admission.stepRunId === right.admission.stepRunId &&
    left.stepRun.id === right.stepRun.id &&
    left.stepRun.runId === right.stepRun.runId &&
    left.stepRun.status === right.stepRun.status &&
    left.stepRun.version === right.stepRun.version &&
    left.stepRun.stepRunDigest === right.stepRun.stepRunDigest
  );
}

function sameSnapshot(
  expected: ClusterControlRecoverySnapshot,
  current: ClusterControlRecoverySnapshot,
): boolean {
  return (
    sameRun(expected.run, current.run) &&
    sameAttempt(expected.attempt, current.attempt) &&
    sameWorkflowTask(expected.workflowTask, current.workflowTask)
  );
}

function eventRecord(
  id: string,
  ownerId: string,
  createdAtMs: number,
  draft: Readonly<
    Omit<RunEventRecord, 'id' | 'actorType' | 'actorId' | 'createdAtMs'>
  >,
): RunEventRecord {
  return {
    ...draft,
    id,
    actorType: 'reconciler',
    actorId: ownerId,
    createdAtMs,
  };
}

function eventId(createEventId: () => string): string {
  const id = createEventId();
  if (typeof id !== 'string' || id.length < 1 || id.length > 36) {
    throw new TypeError('PostgreSQL recovery event id is invalid');
  }
  return id;
}

async function releaseExpiredDispatchLease(
  client: PostgresClient,
  attempt: Readonly<RunAttemptRecord>,
  observation: number,
): Promise<number | undefined> {
  if (
    attempt.leaseVersion === undefined ||
    attempt.leaseGeneration === undefined
  ) {
    return undefined;
  }
  if (attempt.leaseVersion >= 2_147_483_647) {
    throw new RecoverySnapshotStaleError();
  }
  const nextVersion = attempt.leaseVersion + 1;
  const result = await client.query(
    `UPDATE "ql3"."run_dispatch_leases"
     SET status = 'released', version = $2, released_at_ms = $3,
         release_reason = 'lease_expired', completed_at_ms = NULL,
         updated_at_ms = $3
     WHERE attempt_id = $1
       AND status = 'leased'
       AND version = $4
       AND lease_generation = $5
       AND expires_at_ms <= $3`,
    [
      attempt.id,
      nextVersion,
      observation,
      attempt.leaseVersion,
      attempt.leaseGeneration,
    ],
  );
  if ((result.rowCount ?? result.rows.length) !== 1) {
    throw new RecoverySnapshotStaleError();
  }
  return nextVersion;
}

function withReleasedLeaseVersion(
  attempt: Readonly<RunAttemptRecord>,
  leaseVersion: number | undefined,
): Readonly<RunAttemptRecord> {
  return leaseVersion === undefined
    ? attempt
    : Object.freeze({ ...attempt, leaseVersion });
}

async function compareAndSetWorkflowRun(
  client: PostgresClient,
  current: Readonly<RunRecord>,
  next: Readonly<RunRecord>,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE "ql3"."runs"
     SET version = $2, event_sequence = $3
     WHERE id = $1 AND status = 'running'
       AND execution_owner = 'runtime'
       AND trigger_type = 'plugin_package_workflow'
       AND cancel_requested_at_ms IS NULL
       AND version = $4 AND event_sequence = $5`,
    [
      current.id,
      next.version,
      next.eventSequence,
      current.version,
      current.eventSequence,
    ],
  );
  return (result.rowCount ?? result.rows.length) === 1;
}

async function updateWorkflowStepRun(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
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
  if ((updated.rowCount ?? updated.rows.length) !== 1) {
    throw new RecoverySnapshotStaleError();
  }
}

async function appendWorkflowStepMutation(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
  committedAtMs: number,
): Promise<void> {
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
      mutation.stepRun.id,
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
      mutation.stepRun.id,
      mutation.stepRun.stepRunDigest,
      event.id,
      event.sequence,
      mutation.expectedRunVersion + 1,
      JSON.stringify(mutation.stepRun),
      committedAtMs,
    ],
  );
}

export class PostgresClusterControlRecoveryResolutionRepository
  implements ClusterControlRecoveryResolutionRepository
{
  constructor(
    private readonly pool: PostgresPool,
    private readonly createEventId: () => string = randomUUID,
  ) {}

  load(
    claim: ClusterControlRecoveryClaim,
  ): Promise<ClusterControlRecoverySnapshot | 'fenced'> {
    return this.transaction(async (client, runs) => {
      const result = await client.query<ObservationRow>(LOAD_FENCE_SQL, [
        claim.candidate.kind,
        claim.candidate.id,
        claim.ownerId,
        claim.token,
        claim.version,
      ]);
      const observation = oneObservation(result.rows);
      if (observation === null) return 'fenced';
      return readSnapshot(client, runs, claim, observation);
    });
  }

  async applyLost(
    claim: ClusterControlRecoveryClaim,
    snapshot: ClusterControlRecoverySnapshot,
    action: ClusterControlRecoveryLostAction,
  ): Promise<'applied' | 'stale' | 'fenced'> {
    try {
      return await this.transaction(async (client, runs) => {
        const result = await client.query<ObservationRow>(LOCK_FENCE_SQL, [
          claim.candidate.kind,
          claim.candidate.id,
          claim.ownerId,
          claim.token,
          claim.version,
        ]);
        const observation = oneObservation(result.rows);
        if (observation === null) return 'fenced';
        if (claim.candidate.kind === 'attempt') {
          await lockAttemptAuthority(client, claim.candidate.id);
        }
        const current = await readSnapshot(
          client,
          runs,
          claim,
          observation,
        );
        if (!sameSnapshot(snapshot, current)) return 'stale';
        if (!current.run) return 'stale';

        if (action.kind === 'recover_workflow_task') {
          if (!current.attempt || !current.workflowTask) {
            throw new RecoverySnapshotStaleError();
          }
          const recovery = buildPluginPackageWorkflowTaskRecovery({
            admission: current.workflowTask.admission,
            run: current.run,
            attempt: current.attempt,
            stepRun: current.workflowTask.stepRun,
            reason: action.reason,
            observedAtMs: observation,
          });
          const releasedLeaseVersion = await releaseExpiredDispatchLease(
            client,
            current.attempt,
            observation,
          );
          const recoveredAttempt = withReleasedLeaseVersion(
            recovery.attempt,
            releasedLeaseVersion,
          );
          if (
            !(await compareAndSetWorkflowRun(
              client,
              current.run,
              recovery.run,
            )) ||
            !(await runs.compareAndSetAttempt(recoveredAttempt, {
              status: current.attempt.status,
              callbackSequence: current.attempt.callbackSequence,
            }))
          ) {
            throw new RecoverySnapshotStaleError();
          }
          await runs.appendEvent(recovery.attemptEvent);
          for (const mutation of recovery.stepMutations) {
            await updateWorkflowStepRun(client, mutation);
            await appendWorkflowStepMutation(
              client,
              mutation,
              observation,
            );
          }
          return 'applied';
        }
        if (current.workflowTask) {
          throw new RecoverySnapshotStaleError();
        }
        const transition = buildClusterControlRecoveryLostTransition(
          current.run,
          current.attempt,
          action,
          observation,
        );
        let persistedRun = current.run;
        if (transition.attempt) {
          if (!current.attempt) throw new RecoverySnapshotStaleError();
          const releasedLeaseVersion = await releaseExpiredDispatchLease(
            client,
            current.attempt,
            observation,
          );
          const recoveredAttempt = withReleasedLeaseVersion(
            transition.attempt.attempt,
            releasedLeaseVersion,
          );
          if (
            !(await runs.compareAndSetRun(
              transition.attempt.run,
              persistedRun.version,
            )) ||
            !(await runs.compareAndSetAttempt(recoveredAttempt, {
              status: current.attempt.status,
              callbackSequence: current.attempt.callbackSequence,
            }))
          ) {
            throw new RecoverySnapshotStaleError();
          }
          await runs.appendEvent(
            eventRecord(
              eventId(this.createEventId),
              claim.ownerId,
              observation,
              transition.attempt.event,
            ),
          );
          persistedRun = transition.attempt.run;
        }
        if (transition.run) {
          if (
            !(await runs.compareAndSetRun(
              transition.run.run,
              persistedRun.version,
            ))
          ) {
            throw new RecoverySnapshotStaleError();
          }
          await runs.appendEvent(
            eventRecord(
              eventId(this.createEventId),
              claim.ownerId,
              observation,
              transition.run.event,
            ),
          );
        }
        return 'applied';
      });
    } catch (error) {
      if (error instanceof RecoverySnapshotStaleError) return 'stale';
      throw error;
    }
  }

  private async transaction<T>(
    work: (client: PostgresClient, runs: PostgresRunTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect().catch((error: unknown) => {
      throw new ClusterControlRecoveryStoreError(error);
    });
    let began = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      began = true;
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
        `${TRANSACTION_STATEMENT_TIMEOUT_MS}ms`,
      ]);
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [
        `${TRANSACTION_LOCK_TIMEOUT_MS}ms`,
      ]);
      await client.query(
        `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
        [`${TRANSACTION_IDLE_TIMEOUT_MS}ms`],
      );
      const result = await work(client, new PostgresRunTransaction(client));
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the originating failure; release discards broken clients.
        }
      }
      if (error instanceof RecoverySnapshotStaleError) throw error;
      if (error instanceof ClusterControlRecoveryStoreError) throw error;
      throw new ClusterControlRecoveryStoreError(error);
    } finally {
      client.release();
    }
  }
}
