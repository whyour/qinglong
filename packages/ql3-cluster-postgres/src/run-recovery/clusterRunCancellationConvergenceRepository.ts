// PostgreSQL authority adapter for cancellation convergence and terminal recovery.
import { createHash } from 'node:crypto';
import type { PostgresClient, PostgresPool } from '@qinglong/runtime-core';
import type {
  RunEventRecord,
  RunRecord,
} from '@qinglong/runtime-core';
import {
  ClusterRunCancellationConvergenceUnavailableError,
  normalizeClusterRunCancellationConvergencePageCommand,
  normalizeClusterRunCancellationConvergencePageResult,
  type ClusterRunCancellationConvergencePageCommand,
  type ClusterRunCancellationConvergencePageResult,
  type ClusterRunCancellationConvergenceRepository,
} from '@qinglong/runtime-core/cluster-run-cancellation-convergence';
import {
  resolvePluginPackageWorkflowCancellation,
  type PluginPackageWorkflowCancellationActiveAttempt,
  type PluginPackageWorkflowCancellationResolution,
} from '@qinglong/runtime-core/plugin-package-workflow-cancellation-convergence';
import type {
  PluginPackageWorkflowTaskAttemptAdmissionReceipt,
} from '@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission';
import type {
  StepRunMutation,
  StepRunRecord,
} from '@qinglong/runtime-core/step-run';
import { PostgresRunTransaction } from '../run/runRepository';

type Row = Record<string, unknown>;

const NON_EXECUTING_RUN_STATUSES = Object.freeze([
  'created',
  'queued',
  'waiting_approval',
  'retry_wait',
  'lost',
]);
const TERMINAL_ATTEMPT_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);
const CANCEL_REASONS = new Set([
  'user',
  'policy',
  'shutdown',
  'reconcile',
  'timeout',
]);

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length < 1) {
    throw new TypeError(`PostgreSQL cancellation convergence ${key} is invalid`);
  }
  return value;
}

function integer(row: Row, key: string): number {
  const raw = row[key];
  const value = typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw)
    ? Number(raw)
    : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`PostgreSQL cancellation convergence ${key} is invalid`);
  }
  return value;
}

function optionalText(row: Row, key: string): string | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : text(row, key);
}

function optionalInteger(row: Row, key: string): number | undefined {
  return row[key] === null || row[key] === undefined
    ? undefined
    : integer(row, key);
}

function boolean(row: Row, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') {
    throw new TypeError(`PostgreSQL cancellation convergence ${key} is invalid`);
  }
  return value;
}

function object(row: Row, key: string): Readonly<Record<string, unknown>> {
  const value = row[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`PostgreSQL cancellation convergence ${key} is invalid`);
  }
  return Object.freeze({ ...(value as Record<string, unknown>) });
}

async function begin(client: PostgresClient): Promise<void> {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
    '5000ms',
  ]);
  await client.query(`SELECT set_config('lock_timeout', $1, true)`, ['1000ms']);
  await client.query(
    `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
    ['10000ms'],
  );
}

async function rollback(client: PostgresClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the primary transaction failure.
  }
}

interface TerminalMapping {
  readonly status: 'cancelled' | 'timed_out';
  readonly errorCode: 'EXECUTION_CANCELLED' | 'EXECUTION_TIMED_OUT';
  readonly errorSummary: string;
}

function mapping(reason: string): Readonly<TerminalMapping> {
  if (!CANCEL_REASONS.has(reason)) {
    throw new TypeError('PostgreSQL cancellation convergence reason is invalid');
  }
  return reason === 'timeout'
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

function eventIdentity(
  kind: 'attempt' | 'run',
  runId: string,
  attemptId: string | undefined,
  cancelRequestedAtMs: number,
): string {
  const digest = createHash('sha256');
  for (const value of [
    'qinglong/cluster-run-cancellation-convergence-event@v1',
    kind,
    runId,
    attemptId ?? '',
    String(cancelRequestedAtMs),
  ]) {
    digest.update(String(Buffer.byteLength(value)));
    digest.update(':');
    digest.update(value);
  }
  return `${kind === 'attempt' ? 'qca' : 'qcr'}-${digest.digest('hex').slice(0, 32)}`;
}

async function tryLockAttemptAuthority(
  client: PostgresClient,
  attemptId: string,
): Promise<boolean> {
  const result = await client.query<Row>(
    `SELECT pg_try_advisory_xact_lock(
       hashtextextended($1, 0)
     ) AS "locked"`,
    [`ql3-attempt-authority:${attemptId}`],
  );
  return result.rows.length === 1 && boolean(result.rows[0]!, 'locked');
}

async function updateWorkflowStepRun(
  client: PostgresClient,
  mutation: Readonly<StepRunMutation>,
): Promise<void> {
  const stepRun = mutation.stepRun;
  const result = await client.query(
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
  if ((result.rowCount ?? result.rows.length) !== 1) {
    throw new TypeError('PostgreSQL cancellation convergence StepRun fence changed');
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

async function appendWorkflowEvent(
  runs: PostgresRunTransaction,
  event: Readonly<RunEventRecord>,
): Promise<void> {
  await runs.appendEvent(event);
}

async function compareAndSetWorkflowRun(
  client: PostgresClient,
  current: Readonly<RunRecord>,
  resolution: Readonly<PluginPackageWorkflowCancellationResolution>,
): Promise<void> {
  const next = resolution.run;
  const result = await client.query(
    `UPDATE "ql3"."runs"
     SET status = $2, finished_at_ms = $3,
         error_code = $4, error_summary = $5,
         version = $6, event_sequence = $7
     WHERE id = $1 AND status = 'running'
       AND execution_owner = 'runtime'
       AND trigger_type = 'plugin_package_workflow'
       AND cancel_requested_at_ms = $8 AND cancel_reason = $9
       AND version = $10 AND event_sequence = $11`,
    [
      current.id,
      next.status,
      next.finishedAtMs ?? null,
      next.errorCode ?? null,
      next.errorSummary ?? null,
      next.version,
      next.eventSequence,
      current.cancelRequestedAtMs,
      current.cancelReason,
      current.version,
      current.eventSequence,
    ],
  );
  if ((result.rowCount ?? result.rows.length) !== 1) {
    throw new TypeError('PostgreSQL cancellation convergence Workflow fence changed');
  }
}

export class PostgresClusterRunCancellationConvergenceRepository
  implements ClusterRunCancellationConvergenceRepository
{
  constructor(private readonly pool: PostgresPool) {
    if (!pool || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL cancellation convergence pool is invalid');
    }
  }

  private async convergeWorkflow(
    client: PostgresClient,
    runId: string,
  ): Promise<Readonly<{
    settledRuns: number;
    settledAttempts: number;
    blocked: number;
  }>> {
    const authority = await client.query<Row>(
      `SELECT attempt.id AS "attemptId"
       FROM "ql3"."run_attempts" AS attempt
       JOIN "ql3"."plugin_package_workflow_task_attempt_admissions"
         AS admission ON admission.attempt_id = attempt.id
       WHERE attempt.run_id = $1
         AND attempt.status = ANY($2::text[])
       ORDER BY attempt.id`,
      [runId, ['claimed', 'starting', 'running']],
    );
    const authorityIds = authority.rows.map((row) => text(row, 'attemptId'));
    for (const attemptId of authorityIds) {
      if (!(await tryLockAttemptAuthority(client, attemptId))) {
        return Object.freeze({
          settledRuns: 0,
          settledAttempts: 0,
          blocked: 1,
        });
      }
    }

    const locked = await client.query<Row>(
      `SELECT id AS "runId"
       FROM "ql3"."runs"
       WHERE id = $1
         AND execution_owner = 'runtime'
         AND trigger_type = 'plugin_package_workflow'
         AND status = 'running'
         AND cancel_requested_at_ms IS NOT NULL
       FOR UPDATE`,
      [runId],
    );
    if (locked.rows.length === 0) {
      return Object.freeze({
        settledRuns: 0,
        settledAttempts: 0,
        blocked: 0,
      });
    }
    if (locked.rows.length !== 1) {
      throw new TypeError('PostgreSQL cancellation convergence Workflow duplicated');
    }

    const runs = new PostgresRunTransaction(client);
    const run = await runs.findRunById(runId);
    if (!run) {
      throw new TypeError('PostgreSQL cancellation convergence Workflow disappeared');
    }
    const stepResult = await client.query<Row>(
      `SELECT step_run_json AS "stepRunJson"
       FROM "ql3"."step_runs"
       WHERE run_id = $1
       ORDER BY step_key, id
       FOR UPDATE`,
      [runId],
    );
    const stepRuns = stepResult.rows.map((row) =>
      object(row, 'stepRunJson') as unknown as Readonly<StepRunRecord>);
    const activeResult = await client.query<Row>(
      `SELECT admission.receipt_json AS "admissionJson",
              attempt.id AS "attemptId",
              lease.status AS "leaseStatus"
       FROM "ql3"."plugin_package_workflow_task_attempt_admissions"
         AS admission
       JOIN "ql3"."run_attempts" AS attempt
         ON attempt.id = admission.attempt_id
        AND attempt.run_id = admission.run_id
       LEFT JOIN "ql3"."run_dispatch_leases" AS lease
         ON lease.attempt_id = attempt.id
       WHERE admission.run_id = $1
         AND attempt.status = ANY($2::text[])
       ORDER BY attempt.id
       FOR UPDATE OF attempt`,
      [runId, ['claimed', 'starting', 'running']],
    );
    const activeIds = activeResult.rows.map((row) => text(row, 'attemptId'));
    if (activeIds.some((attemptId) => !authorityIds.includes(attemptId))) {
      throw new TypeError(
        'PostgreSQL cancellation convergence acquired incomplete Attempt authority',
      );
    }
    if (activeIds.length > 0) {
      await client.query(
        `SELECT attempt_id
         FROM "ql3"."run_dispatch_leases"
         WHERE attempt_id = ANY($1::text[])
         ORDER BY attempt_id
         FOR UPDATE`,
        [activeIds],
      );
    }
    const activeTaskAttempts:
      PluginPackageWorkflowCancellationActiveAttempt[] = [];
    for (const row of activeResult.rows) {
      const attemptId = text(row, 'attemptId');
      const attempt = await runs.findAttemptById(attemptId);
      if (!attempt) {
        throw new TypeError(
          'PostgreSQL cancellation convergence Attempt disappeared',
        );
      }
      activeTaskAttempts.push(Object.freeze({
        admission:
          object(row, 'admissionJson') as unknown as
            Readonly<PluginPackageWorkflowTaskAttemptAdmissionReceipt>,
        attempt,
        leaseStatus:
          (optionalText(row, 'leaseStatus') ?? null) as
            PluginPackageWorkflowCancellationActiveAttempt['leaseStatus'],
      }));
    }
    const observation = await client.query<Row>(
      `SELECT floor(
         extract(epoch FROM statement_timestamp()) * 1000
       )::bigint AS "observedAtMs"`,
    );
    if (observation.rows.length !== 1) {
      throw new TypeError(
        'PostgreSQL cancellation convergence Workflow observation is invalid',
      );
    }
    const resolution = resolvePluginPackageWorkflowCancellation({
      run,
      stepRuns,
      activeTaskAttempts,
      observedAtMs: integer(observation.rows[0]!, 'observedAtMs'),
    });

    for (const transition of resolution.attemptTransitions) {
      if (
        !(await runs.compareAndSetAttempt(transition.attempt, {
          status: transition.previousStatus,
          callbackSequence: transition.attempt.callbackSequence,
        }))
      ) {
        throw new TypeError(
          'PostgreSQL cancellation convergence Attempt fence changed',
        );
      }
      await appendWorkflowEvent(runs, transition.event);
    }
    for (const mutation of resolution.stepMutations) {
      await updateWorkflowStepRun(client, mutation);
      await appendWorkflowStepMutation(
        client,
        mutation,
        resolution.observedAtMs,
      );
    }
    if (resolution.terminalTransition) {
      await appendWorkflowEvent(
        runs,
        resolution.terminalTransition.event,
      );
    }
    if (
      resolution.run.version !== run.version ||
      resolution.run.eventSequence !== run.eventSequence ||
      resolution.run.status !== run.status
    ) {
      await compareAndSetWorkflowRun(client, run, resolution);
    }
    return Object.freeze({
      settledRuns: resolution.terminalTransition === null ? 0 : 1,
      settledAttempts: resolution.attemptTransitions.length,
      blocked: resolution.blockedStepRunIds.length === 0 ? 0 : 1,
    });
  }

  async convergePage(
    value: Readonly<ClusterRunCancellationConvergencePageCommand>,
  ): Promise<Readonly<ClusterRunCancellationConvergencePageResult>> {
    const command = normalizeClusterRunCancellationConvergencePageCommand(value);
    let client: PostgresClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new ClusterRunCancellationConvergenceUnavailableError({ cause: error });
    }
    try {
      await begin(client);
      const candidates = await client.query<Row>(
        `WITH observation AS MATERIALIZED (
           SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
             AS observed_at_ms
         ), candidates AS MATERIALIZED (
           SELECT run.id
           FROM "ql3"."runs" AS run
           WHERE run.execution_owner = 'runtime'
             AND run.cancel_requested_at_ms IS NOT NULL
             AND run.trigger_type <> 'plugin_package_workflow'
             AND run.status = ANY($1::text[])
           ORDER BY run.cancel_requested_at_ms, run.id
           FOR UPDATE OF run SKIP LOCKED
           LIMIT $2
         )
         SELECT observation.observed_at_ms AS "observedAtMs",
                run.id AS "runId", run.status AS "runStatus",
                run.version AS "runVersion",
                run.event_sequence AS "eventSequence",
                run.created_at_ms AS "runCreatedAtMs",
                run.queued_at_ms AS "runQueuedAtMs",
                run.started_at_ms AS "runStartedAtMs",
                run.cancel_requested_at_ms AS "cancelRequestedAtMs",
                run.cancel_reason AS "cancelReason",
                attempt.id AS "attemptId", attempt.status AS "attemptStatus",
                attempt.step_run_id AS "stepRunId",
                attempt.attempt AS "attemptNumber",
                attempt.created_at_ms AS "attemptCreatedAtMs",
                attempt.started_at_ms AS "attemptStartedAtMs",
                attempt.finished_at_ms AS "attemptFinishedAtMs",
                lease.status AS "leaseStatus"
         FROM observation
         JOIN candidates ON true
         JOIN "ql3"."runs" AS run ON run.id = candidates.id
         LEFT JOIN LATERAL (
           SELECT candidate_attempt.*
           FROM "ql3"."run_attempts" AS candidate_attempt
           WHERE candidate_attempt.run_id = run.id
           ORDER BY candidate_attempt.attempt DESC, candidate_attempt.id DESC
           LIMIT 1
         ) AS attempt ON true
         LEFT JOIN "ql3"."run_dispatch_leases" AS lease
           ON lease.attempt_id = attempt.id
         ORDER BY run.cancel_requested_at_ms, run.id`,
        [NON_EXECUTING_RUN_STATUSES, command.limit],
      );

      let settledRuns = 0;
      let settledAttempts = 0;
      let blocked = 0;
      let scanned = candidates.rows.length;
      for (const row of candidates.rows) {
        const attemptStatus = optionalText(row, 'attemptStatus');
        const leaseStatus = optionalText(row, 'leaseStatus');
        if (
          attemptStatus === 'starting' ||
          attemptStatus === 'running' ||
          (attemptStatus === 'claimed' && leaseStatus === 'leased')
        ) {
          blocked += 1;
          continue;
        }
        if (
          attemptStatus !== undefined &&
          attemptStatus !== 'claimed' &&
          !TERMINAL_ATTEMPT_STATUSES.has(attemptStatus)
        ) {
          throw new TypeError('PostgreSQL cancellation convergence Attempt is invalid');
        }
        const runStatus = text(row, 'runStatus');
        if (!NON_EXECUTING_RUN_STATUSES.includes(runStatus)) {
          throw new TypeError('PostgreSQL cancellation convergence Run is invalid');
        }
        const cancelRequestedAtMs = integer(row, 'cancelRequestedAtMs');
        const cancelReason = text(row, 'cancelReason');
        const terminal = mapping(cancelReason);
        const observedAtMs = integer(row, 'observedAtMs');
        const finishedAtMs = Math.max(
          observedAtMs,
          cancelRequestedAtMs,
          integer(row, 'runCreatedAtMs'),
          optionalInteger(row, 'runQueuedAtMs') ?? 0,
          optionalInteger(row, 'runStartedAtMs') ?? 0,
          optionalInteger(row, 'attemptCreatedAtMs') ?? 0,
          optionalInteger(row, 'attemptStartedAtMs') ?? 0,
          optionalInteger(row, 'attemptFinishedAtMs') ?? 0,
        );
        const runVersion = integer(row, 'runVersion');
        const eventSequence = integer(row, 'eventSequence');
        const settlesAttempt = attemptStatus === 'claimed';
        const eventCount = settlesAttempt ? 2 : 1;
        if (
          runVersion > 2_147_483_647 - eventCount ||
          eventSequence > 2_147_483_647 - eventCount
        ) {
          throw new RangeError('PostgreSQL cancellation convergence counter overflowed');
        }
        const attemptId = optionalText(row, 'attemptId');
        const attemptEventId = eventIdentity(
          'attempt',
          text(row, 'runId'),
          attemptId,
          cancelRequestedAtMs,
        );
        const runEventId = eventIdentity(
          'run',
          text(row, 'runId'),
          attemptId,
          cancelRequestedAtMs,
        );
        let nextSequence = eventSequence;
        if (settlesAttempt) {
          if (!attemptId) {
            throw new TypeError('PostgreSQL cancellation convergence Attempt identity is missing');
          }
          const attempt = await client.query(
            `UPDATE "ql3"."run_attempts"
             SET status = $2, finished_at_ms = $3,
                 error_code = $4, error_summary = $5
             WHERE id = $1 AND run_id = $6 AND status = 'claimed'`,
            [
              attemptId,
              terminal.status,
              finishedAtMs,
              terminal.errorCode,
              terminal.errorSummary,
              text(row, 'runId'),
            ],
          );
          if (attempt.rowCount !== 1) {
            throw new TypeError('PostgreSQL cancellation convergence Attempt fence changed');
          }
          nextSequence += 1;
          await client.query(
            `INSERT INTO "ql3"."run_events" (
               id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
               attempt_id, step_run_id, payload, created_at_ms
             ) VALUES ($1, $2, $3, $4, $5, 'reconciler',
               'runtime:cancellation', $6, $7, $8::jsonb, $9)`,
            [
              attemptEventId,
              text(row, 'runId'),
              nextSequence,
              `attempt.${terminal.status}`,
              `cancel-convergence:attempt:${attemptId}:${cancelRequestedAtMs}`,
              attemptId,
              optionalText(row, 'stepRunId') ?? null,
              JSON.stringify({
                attempt_id: attemptId,
                attempt: integer(row, 'attemptNumber'),
                from_status: 'claimed',
                to_status: terminal.status,
                cancel_reason: cancelReason,
                cancel_requested_at_ms: cancelRequestedAtMs,
                error_code: terminal.errorCode,
              }),
              finishedAtMs,
            ],
          );
          settledAttempts += 1;
        }
        nextSequence += 1;
        const nextVersion = runVersion + eventCount;
        const run = await client.query(
          `UPDATE "ql3"."runs"
           SET status = $2, finished_at_ms = $3,
               error_code = $4, error_summary = $5,
               version = $6, event_sequence = $7
           WHERE id = $1 AND version = $8 AND status = $9
             AND cancel_requested_at_ms = $10 AND cancel_reason = $11
             AND execution_owner = 'runtime'`,
          [
            text(row, 'runId'),
            terminal.status,
            finishedAtMs,
            terminal.errorCode,
            terminal.errorSummary,
            nextVersion,
            nextSequence,
            runVersion,
            runStatus,
            cancelRequestedAtMs,
            cancelReason,
          ],
        );
        if (run.rowCount !== 1) {
          throw new TypeError('PostgreSQL cancellation convergence Run fence changed');
        }
        await client.query(
          `INSERT INTO "ql3"."run_events" (
             id, run_id, sequence, type, dedupe_key, actor_type, actor_id,
             attempt_id, step_run_id, payload, created_at_ms
           ) VALUES ($1, $2, $3, $4, $5, 'reconciler',
             'runtime:cancellation', $6, NULL, $7::jsonb, $8)`,
          [
            runEventId,
            text(row, 'runId'),
            nextSequence,
            `run.${terminal.status}`,
            `cancel-convergence:run:${text(row, 'runId')}:${cancelRequestedAtMs}`,
            attemptId ?? null,
            JSON.stringify({
              ...(attemptId === undefined ? {} : { attempt_id: attemptId }),
              from_status: runStatus,
              to_status: terminal.status,
              version: nextVersion,
              cancel_reason: cancelReason,
              cancel_requested_at_ms: cancelRequestedAtMs,
              error_code: terminal.errorCode,
            }),
            finishedAtMs,
          ],
        );
        settledRuns += 1;
      }

      const remaining = command.limit - candidates.rows.length;
      if (remaining > 0) {
        const workflowCandidates = await client.query<Row>(
          `SELECT id AS "runId"
           FROM "ql3"."runs"
           WHERE execution_owner = 'runtime'
             AND trigger_type = 'plugin_package_workflow'
             AND status = 'running'
             AND cancel_requested_at_ms IS NOT NULL
           ORDER BY cancel_requested_at_ms, id
           LIMIT $1`,
          [remaining],
        );
        for (const row of workflowCandidates.rows) {
          const result = await this.convergeWorkflow(
            client,
            text(row, 'runId'),
          );
          settledRuns += result.settledRuns;
          settledAttempts += result.settledAttempts;
          blocked += result.blocked;
        }
        scanned += workflowCandidates.rows.length;
      }

      const continuation = await client.query<Row>(
        `SELECT EXISTS (
           SELECT 1 FROM "ql3"."runs"
           WHERE execution_owner = 'runtime'
             AND cancel_requested_at_ms IS NOT NULL
             AND (
               (
                 trigger_type <> 'plugin_package_workflow'
                 AND status = ANY($1::text[])
               ) OR (
                 trigger_type = 'plugin_package_workflow'
                 AND status = 'running'
               )
             )
           LIMIT 1
         ) AS "hasMore"`,
        [NON_EXECUTING_RUN_STATUSES],
      );
      if (continuation.rows.length !== 1) {
        throw new TypeError('PostgreSQL cancellation convergence continuation is invalid');
      }
      const result = normalizeClusterRunCancellationConvergencePageResult({
        scanned,
        settledRuns,
        settledAttempts,
        blocked,
        hasMore: boolean(continuation.rows[0]!, 'hasMore'),
      }, command.limit);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollback(client);
      if (error instanceof ClusterRunCancellationConvergenceUnavailableError) {
        throw error;
      }
      throw new ClusterRunCancellationConvergenceUnavailableError({ cause: error });
    } finally {
      client.release();
    }
  }
}
