// PostgreSQL authority for bounded Cluster schedule claim and commit.
import {
  InvalidClusterScheduleError,
  normalizeClaimClusterScheduleCommand,
  normalizeClusterScheduleClaim,
  normalizeCommitClusterScheduleDecisionCommand,
  type ClaimClusterScheduleCommand,
  type ClusterScheduleClaim,
  type ClusterScheduleStore,
  type CommitClusterScheduleDecisionCommand,
  type CommitClusterScheduleDecisionResult,
} from '@qinglong/runtime-core/cluster-scheduler';
import {
  BUILT_IN_CRON_TRIGGER_SPEC_SCHEMA,
  createBuiltInTriggerSpecSemanticRegistry,
  type TriggerSpec,
} from '@qinglong/runtime-core/trigger';
import type {
  PostgresClient,
  PostgresPool,
} from '@qinglong/runtime-core';
import {
  POSTGRES_DEFINITION_RETRYABLE_SQL_STATES,
  POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS,
  configurePostgresDefinitionTransaction,
  postgresRequiredInteger,
  postgresRequiredJsonObject,
  postgresRequiredString,
  postgresSqlState,
  rollbackPostgresDefinitionTransaction,
} from '../repository/definitionRepositorySupport';
import { findExecutionRevision } from '../automation/taskDefinitionRepository';

type Row = Record<string, unknown>;

const triggerSemantics = createBuiltInTriggerSpecSemanticRegistry();

const CLAIM_SELECT = `
  schedule.project_id AS "projectId",
  schedule.trigger_id AS "triggerId",
  schedule.trigger_revision AS "triggerRevision",
  revision.content_digest AS "triggerContentDigest",
  revision.created_at_ms AS "triggerUpdatedAtMs",
  revision.task_id AS "taskId",
  revision.task_revision AS "taskRevision",
  revision.task_content_digest AS "taskContentDigest",
  revision.spec_json AS "specJson",
  task.name AS "taskName",
  schedule.state_version AS "stateVersion",
  schedule.next_fire_at_ms AS "nextFireAtMs",
  schedule.claim_owner AS "claimOwner",
  schedule.claim_token::text AS "claimToken",
  schedule.claim_version AS "claimVersion",
  schedule.claim_expires_at_ms AS "claimExpiresAtMs",
  schedule.updated_at_ms AS "claimAcquiredAtMs"`;

export class PostgresClusterScheduleUnavailableError extends Error {
  readonly code = 'CLUSTER_SCHEDULE_UNAVAILABLE';

  constructor(message = 'PostgreSQL cluster schedule storage is unavailable') {
    super(message);
    this.name = 'PostgresClusterScheduleUnavailableError';
  }
}

function unavailable(message?: string): PostgresClusterScheduleUnavailableError {
  return new PostgresClusterScheduleUnavailableError(message);
}

function nullableInteger(row: Row, key: string): number | null {
  return row[key] === null
    ? null
    : postgresRequiredInteger(row[key], unavailable);
}

function parseClaim(row: Row): ClusterScheduleClaim {
  try {
    const projectId = postgresRequiredString(row.projectId, unavailable);
    const triggerId = postgresRequiredString(row.triggerId, unavailable);
    const taskId = postgresRequiredString(row.taskId, unavailable);
    const taskRevision = postgresRequiredInteger(row.taskRevision, unavailable);
    const spec = triggerSemantics.normalize({
      projectId,
      triggerId,
      taskId,
      taskRevision,
      spec: postgresRequiredJsonObject(
        row.specJson,
        unavailable,
      ) as unknown as TriggerSpec,
    });
    if (spec.schema !== BUILT_IN_CRON_TRIGGER_SPEC_SCHEMA) {
      throw unavailable();
    }
    const config = spec.config as Readonly<Record<string, unknown>>;
    return normalizeClusterScheduleClaim({
      projectId,
      triggerId,
      triggerRevision: postgresRequiredInteger(
        row.triggerRevision,
        unavailable,
      ),
      triggerContentDigest: postgresRequiredString(
        row.triggerContentDigest,
        unavailable,
      ),
      triggerUpdatedAtMs: postgresRequiredInteger(
        row.triggerUpdatedAtMs,
        unavailable,
      ),
      taskId,
      taskRevision,
      taskContentDigest: postgresRequiredString(
        row.taskContentDigest,
        unavailable,
      ),
      expression: config.expression as string,
      timezone: config.timezone as string,
      misfirePolicy: config.misfirePolicy as 'skip' | 'fire_once',
      stateVersion: postgresRequiredInteger(row.stateVersion, unavailable),
      nextFireAtMs: nullableInteger(row, 'nextFireAtMs'),
      claimOwner: postgresRequiredString(row.claimOwner, unavailable),
      claimToken: postgresRequiredString(row.claimToken, unavailable),
      claimVersion: postgresRequiredInteger(row.claimVersion, unavailable),
      claimAcquiredAtMs: postgresRequiredInteger(
        row.claimAcquiredAtMs,
        unavailable,
      ),
      claimExpiresAtMs: postgresRequiredInteger(
        row.claimExpiresAtMs,
        unavailable,
      ),
    });
  } catch (error) {
    if (error instanceof PostgresClusterScheduleUnavailableError) throw error;
    throw unavailable();
  }
}

function sameClaim(left: ClusterScheduleClaim, right: ClusterScheduleClaim): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function taskName(row: Row): string {
  const value = postgresRequiredString(row.taskName, unavailable);
  if (value.length < 1 || Buffer.byteLength(value, 'utf8') > 255) {
    throw unavailable();
  }
  return value;
}

function idempotencyKey(claim: ClusterScheduleClaim, scheduledForMs: number): string {
  return `ql3:cron:v1:${claim.triggerId}:${claim.triggerRevision}:${scheduledForMs}`;
}

async function finishRace(
  client: PostgresClient,
): Promise<CommitClusterScheduleDecisionResult> {
  await client.query('ROLLBACK');
  return Object.freeze({ status: 'raced' as const });
}

/** Runtime-only row-lease scheduler store; it is never loaded by edge profiles. */
export class PostgresClusterScheduleRepository implements ClusterScheduleStore {
  constructor(private readonly pool: PostgresPool) {
    if (
      !pool ||
      typeof pool.query !== 'function' ||
      typeof pool.connect !== 'function'
    ) {
      throw new TypeError('PostgreSQL cluster schedule pool is invalid');
    }
  }

  async claimNextClusterSchedule(
    input: ClaimClusterScheduleCommand,
  ): Promise<ClusterScheduleClaim | null> {
    const command = normalizeClaimClusterScheduleCommand(input);
    try {
      const result = await this.pool.query<Row>(
        `WITH observation AS MATERIALIZED (
           SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                    AS observed_at_ms
         ), candidate AS (
           SELECT schedule.project_id, schedule.trigger_id,
                  observation.observed_at_ms
           FROM "ql3"."trigger_schedules" AS schedule
           JOIN "ql3"."triggers" AS head
             ON head.project_id = schedule.project_id
            AND head.trigger_id = schedule.trigger_id
            AND head.current_revision = schedule.trigger_revision
           JOIN "ql3"."trigger_revisions" AS revision
             ON revision.project_id = schedule.project_id
            AND revision.trigger_id = schedule.trigger_id
            AND revision.revision = schedule.trigger_revision
           JOIN "ql3"."task_definition_revisions" AS task
             ON task.project_id = revision.project_id
            AND task.task_id = revision.task_id
            AND task.revision = revision.task_revision
            AND task.content_digest = revision.task_content_digest
           JOIN "ql3"."task_definitions" AS task_head
             ON task_head.project_id = task.project_id
            AND task_head.task_id = task.task_id
            AND task_head.current_revision = task.revision
           JOIN "ql3"."projects" AS project
             ON project.id = schedule.project_id
           CROSS JOIN observation
           WHERE project.status = 'active'
             AND revision.enabled = true
             AND revision.spec_json->>'schema' = 'qinglong/cron@v1'
             AND (schedule.next_fire_at_ms IS NULL
                  OR schedule.next_fire_at_ms <= observation.observed_at_ms)
             AND (schedule.claim_token IS NULL
                  OR schedule.claim_expires_at_ms <= observation.observed_at_ms)
             AND schedule.updated_at_ms <= observation.observed_at_ms
             AND schedule.state_version < 2147483647
             AND schedule.claim_version < 2147483647
           ORDER BY schedule.next_fire_at_ms NULLS FIRST,
                    schedule.project_id, schedule.trigger_id
           FOR UPDATE OF schedule SKIP LOCKED
           LIMIT 1
         ), claimed AS (
           UPDATE "ql3"."trigger_schedules" AS schedule
           SET claim_owner = $1,
               claim_token = $2::uuid,
               claim_version = schedule.claim_version + 1,
               claim_expires_at_ms = candidate.observed_at_ms + $3::bigint,
               state_version = schedule.state_version + 1,
               updated_at_ms = candidate.observed_at_ms
           FROM candidate
           WHERE schedule.project_id = candidate.project_id
             AND schedule.trigger_id = candidate.trigger_id
           RETURNING schedule.*
         )
         SELECT ${CLAIM_SELECT}
         FROM claimed AS schedule
         JOIN "ql3"."trigger_revisions" AS revision
           ON revision.project_id = schedule.project_id
          AND revision.trigger_id = schedule.trigger_id
          AND revision.revision = schedule.trigger_revision
         JOIN "ql3"."task_definition_revisions" AS task
           ON task.project_id = revision.project_id
          AND task.task_id = revision.task_id
          AND task.revision = revision.task_revision
          AND task.content_digest = revision.task_content_digest
         JOIN "ql3"."task_definitions" AS task_head
           ON task_head.project_id = task.project_id
          AND task_head.task_id = task.task_id
          AND task_head.current_revision = task.revision`,
        [command.ownerId, command.claimToken, command.leaseMs],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw unavailable();
      return parseClaim(result.rows[0]!);
    } catch (error) {
      if (error instanceof InvalidClusterScheduleError) throw error;
      if (error instanceof PostgresClusterScheduleUnavailableError) throw error;
      throw unavailable();
    }
  }

  async commitClusterScheduleDecision(
    input: CommitClusterScheduleDecisionCommand,
  ): Promise<CommitClusterScheduleDecisionResult> {
    const command = normalizeCommitClusterScheduleDecisionCommand(input);
    for (
      let transactionAttempt = 0;
      transactionAttempt < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS;
      transactionAttempt += 1
    ) {
      let client: PostgresClient;
      try {
        client = await this.pool.connect();
      } catch {
        throw unavailable();
      }
      let began = false;
      let commitAttempted = false;
      try {
        await configurePostgresDefinitionTransaction(client);
        began = true;
        const locked = await client.query<Row>(
          `WITH observation AS MATERIALIZED (
             SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                      AS observed_at_ms
           )
           SELECT ${CLAIM_SELECT},
                  observation.observed_at_ms AS "commitObservedAtMs"
           FROM "ql3"."trigger_schedules" AS schedule
           JOIN "ql3"."triggers" AS head
             ON head.project_id = schedule.project_id
            AND head.trigger_id = schedule.trigger_id
            AND head.current_revision = schedule.trigger_revision
           JOIN "ql3"."trigger_revisions" AS revision
             ON revision.project_id = schedule.project_id
            AND revision.trigger_id = schedule.trigger_id
            AND revision.revision = schedule.trigger_revision
           JOIN "ql3"."task_definition_revisions" AS task
             ON task.project_id = revision.project_id
            AND task.task_id = revision.task_id
            AND task.revision = revision.task_revision
            AND task.content_digest = revision.task_content_digest
           JOIN "ql3"."task_definitions" AS task_head
             ON task_head.project_id = task.project_id
            AND task_head.task_id = task.task_id
            AND task_head.current_revision = task.revision
           JOIN "ql3"."projects" AS project
             ON project.id = schedule.project_id
           CROSS JOIN observation
           WHERE schedule.project_id = $1 AND schedule.trigger_id = $2
             AND project.status = 'active' AND revision.enabled = true
             AND revision.spec_json->>'schema' = 'qinglong/cron@v1'
           FOR UPDATE OF schedule`,
          [command.claim.projectId, command.claim.triggerId],
        );
        if (locked.rows.length !== 1) {
          const result = await finishRace(client);
          began = false;
          return result;
        }
        const currentClaim = parseClaim(locked.rows[0]!);
        const commitObservedAtMs = postgresRequiredInteger(
          locked.rows[0]!.commitObservedAtMs,
          unavailable,
        );
        if (
          !sameClaim(currentClaim, command.claim) ||
          commitObservedAtMs >= currentClaim.claimExpiresAtMs
        ) {
          const result = await finishRace(client);
          began = false;
          return result;
        }
        if (commitObservedAtMs < currentClaim.claimAcquiredAtMs) {
          throw unavailable('Cluster schedule clock moved backwards');
        }

        if (command.decision.disposition === 'admit') {
          const scheduledForMs = command.decision.scheduledForMs!;
          const execution = await findExecutionRevision(
            client,
            currentClaim.projectId,
            currentClaim.taskId,
            currentClaim.taskRevision,
          );
          if (
            !execution ||
            execution.sourceContentDigest !== currentClaim.taskContentDigest
          ) {
            throw unavailable('Pinned remote Worker execution revision is unavailable');
          }
          const key = idempotencyKey(
            currentClaim,
            scheduledForMs,
          );
          await client.query(
            `INSERT INTO "ql3"."runs" (
               id, project_id, task_id, task_revision, task_name,
               task_snapshot_ref, trigger_id, trigger_type, execution_origin,
               execution_owner, triggered_by, scheduled_for_ms, status,
               version, event_sequence, priority, idempotency_key,
               created_at_ms, queued_at_ms
             ) VALUES (
               $1, $2, $3, $4, $5, $4, $6, 'cron', 'scheduled_system',
               'runtime', $6, $7, 'queued', 2, 2, 0, $8, $9, $9
             )`,
            [
              command.runId!,
              currentClaim.projectId,
              currentClaim.taskId,
              execution.taskRevision,
              taskName(locked.rows[0]!),
              currentClaim.triggerId,
              scheduledForMs,
              key,
              commitObservedAtMs,
            ],
          );
          await client.query(
            `INSERT INTO "ql3"."run_attempts" (
               id, run_id, attempt, status, executor_type,
               callback_sequence, created_at_ms
             ) VALUES ($1, $2, 1, 'claimed', 'remote_worker', 0, $3)`,
            [
              command.attemptId!,
              command.runId!,
              commitObservedAtMs,
            ],
          );
          await client.query(
            `INSERT INTO "ql3"."run_events" (
               id, run_id, sequence, type, dedupe_key, actor_type,
               actor_id, payload, created_at_ms
             ) VALUES ($1, $2, 1, 'run.created', $3, 'scheduler',
               'cluster', $4::jsonb, $5)`,
            [
              command.createdEventId!,
              command.runId!,
              `cluster-schedule-created:${key}`,
              JSON.stringify({
                status: 'created',
                version: 1,
                execution_owner: 'runtime',
                executor_type: execution.executorType,
                execution_revision_digest: execution.contentDigest,
                trigger_revision: currentClaim.triggerRevision,
                trigger_content_digest: currentClaim.triggerContentDigest,
                scheduled_for_ms: scheduledForMs,
              }),
              commitObservedAtMs,
            ],
          );
          await client.query(
            `INSERT INTO "ql3"."run_events" (
               id, run_id, sequence, type, dedupe_key, actor_type,
               actor_id, attempt_id, payload, created_at_ms
             ) VALUES ($1, $2, 2, 'run.queued', $3, 'scheduler',
               'cluster', $4, $5::jsonb, $6)`,
            [
              command.queuedEventId!,
              command.runId!,
              `cluster-schedule-queued:${key}`,
              command.attemptId!,
              JSON.stringify({
                from_status: 'created',
                to_status: 'queued',
                version: 2,
              }),
              commitObservedAtMs,
            ],
          );
        }

        const advanced = await client.query(
          `UPDATE "ql3"."trigger_schedules"
           SET next_fire_at_ms = $1,
               last_scheduled_at_ms = $2,
               state_version = state_version + 1,
               claim_owner = NULL,
               claim_token = NULL,
               claim_expires_at_ms = NULL,
               updated_at_ms = $3
           WHERE project_id = $4 AND trigger_id = $5
             AND trigger_revision = $6 AND state_version = $7
             AND next_fire_at_ms IS NOT DISTINCT FROM $8
             AND claim_owner = $9 AND claim_token = $10::uuid
             AND claim_version = $11 AND claim_expires_at_ms = $12`,
          [
            command.decision.nextFireAtMs,
            command.decision.disposition === 'admit'
              ? command.decision.scheduledForMs
              : null,
            commitObservedAtMs,
            currentClaim.projectId,
            currentClaim.triggerId,
            currentClaim.triggerRevision,
            currentClaim.stateVersion,
            currentClaim.nextFireAtMs,
            currentClaim.claimOwner,
            currentClaim.claimToken,
            currentClaim.claimVersion,
            currentClaim.claimExpiresAtMs,
          ],
        );
        if (advanced.rowCount !== 1) {
          await client.query('ROLLBACK');
          began = false;
          return Object.freeze({ status: 'raced' as const });
        }
        commitAttempted = true;
        await client.query('COMMIT');
        began = false;
        return command.decision.disposition === 'admit'
          ? Object.freeze({
              status: 'admitted' as const,
              disposition: 'admit' as const,
              runId: command.runId!,
              attemptId: command.attemptId!,
            })
          : Object.freeze({
              status: 'advanced' as const,
              disposition: command.decision.disposition,
            });
      } catch (error) {
        if (began && !commitAttempted) {
          await rollbackPostgresDefinitionTransaction(client);
        }
        if (commitAttempted) throw unavailable();
        const state = postgresSqlState(error);
        if (
          state &&
          POSTGRES_DEFINITION_RETRYABLE_SQL_STATES.has(state) &&
          transactionAttempt + 1 < POSTGRES_DEFINITION_TRANSACTION_ATTEMPTS
        ) {
          continue;
        }
        if (error instanceof InvalidClusterScheduleError) throw error;
        if (error instanceof PostgresClusterScheduleUnavailableError) {
          throw error;
        }
        throw unavailable();
      } finally {
        client.release();
      }
    }
    throw unavailable();
  }
}
