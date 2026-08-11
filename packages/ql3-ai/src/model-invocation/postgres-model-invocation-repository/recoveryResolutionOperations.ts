import type { PostgresPool } from '@qinglong/runtime-core';

import { POSTGRES_MODEL_INVOCATION_SCHEMA } from '../../migration/modelInvocationMigration';
import {
  ModelInvocationConflictError,
  type CommitModelInvocationResult,
  type ModelInvocationAuthoritySnapshot,
  type ModelInvocationRecoveryPage,
} from '../modelInvocation';
import {
  normalizeModelInvocationResolutionCommand,
  type ModelInvocationResolutionCommand,
  type ModelInvocationResolutionRecord,
} from '../modelInvocationResolution';

import type { Row } from './authority';
import {
  TERMINAL_RUN_STATUSES,
  identifier,
  integer,
  mapStorageError,
  recoveryLimit,
  text,
  unavailable,
} from './authority';
import {
  START_SELECT,
  parseAuthority,
  parseCompletion,
  parseResolution,
  parseStart,
} from './codec';
import { applyMutation, assertCurrent, insertResolution } from './mutations';
import { completionRows, resolutionRows } from './queries';
import { runPostgresModelInvocationTransaction } from './transaction';

export async function findResolutionOperation(
  pool: PostgresPool,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationResolutionRecord> | null> {
  const invocationId = identifier(invocationIdValue);
  try {
    const rows = await resolutionRows(pool, 'resolution.invocation_id = $1', [
      invocationId,
    ]);
    if (rows.length > 1) throw unavailable();
    return rows[0] ? parseResolution(rows[0]) : null;
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function readAuthorityOperation(
  pool: PostgresPool,
  identity: Readonly<{
    projectId: string;
    runId: string;
    stepRunId: string;
  }>,
): Promise<Readonly<ModelInvocationAuthoritySnapshot> | null> {
  const projectId = identifier(identity?.projectId);
  const runId = identifier(identity?.runId);
  const stepRunId = identifier(identity?.stepRunId);
  try {
    const result = await pool.query<Row>(
      `SELECT
           run.project_id AS "projectId", run.id AS "runId",
           run.status AS "runStatus", run.version AS "runVersion",
           run.event_sequence AS "runEventSequence",
           step.id AS "stepRunId", step.status AS "stepStatus",
           step.version AS "stepVersion",
           step.step_run_digest AS "stepDigest",
           step.step_run_json AS "stepRunJson"
         FROM "ql3"."runs" AS run
         JOIN "ql3"."step_runs" AS step ON step.run_id = run.id
         WHERE run.project_id = $1 AND run.id = $2 AND step.id = $3
         LIMIT 2`,
      [projectId, runId, stepRunId],
    );
    if (result.rows.length > 1) throw unavailable();
    const row = result.rows[0];
    if (!row || TERMINAL_RUN_STATUSES.has(text(row, 'runStatus'))) {
      return null;
    }
    return parseAuthority(row);
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function listIncompleteOperation(
  pool: PostgresPool,
  limitValue: number,
): Promise<Readonly<ModelInvocationRecoveryPage>> {
  const limit = recoveryLimit(limitValue);
  try {
    const observation = await pool.query<Row>(
      `SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint
           AS "observedAtMs"`,
    );
    const observedRow = observation.rows[0];
    if (observation.rows.length !== 1 || !observedRow) {
      throw unavailable();
    }
    const observedAtMs = integer(observedRow, 'observedAtMs');
    const result = await pool.query<Row>(
      `SELECT ${START_SELECT}
         FROM "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_starts" AS start
         JOIN "ql3"."step_run_mutations" AS mutation
           ON mutation.mutation_id = start.mutation_id
         JOIN "ql3"."run_events" AS event ON event.id = start.run_event_id
         LEFT JOIN "${POSTGRES_MODEL_INVOCATION_SCHEMA}"."model_invocation_completions" AS completion
           ON completion.invocation_id = start.invocation_id
         WHERE completion.invocation_id IS NULL
           AND start.deadline_at_ms <= $1
         ORDER BY start.deadline_at_ms, start.invocation_id
         LIMIT $2`,
      [observedAtMs, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    return Object.freeze({
      observedAtMs,
      candidates: Object.freeze(
        result.rows.slice(0, limit).map((row) => parseStart(row)),
      ),
      hasMore,
    });
  } catch (error) {
    throw mapStorageError(error);
  }
}

export async function resolveOperation(
  pool: PostgresPool,
  commandValue: ModelInvocationResolutionCommand,
): Promise<
  Readonly<CommitModelInvocationResult<ModelInvocationResolutionRecord>>
> {
  const command = normalizeModelInvocationResolutionCommand(commandValue);
  const resolution = command.resolution;
  return runPostgresModelInvocationTransaction(pool, async (client) => {
    const existing = await resolutionRows(
      client,
      `resolution.invocation_id = $1 OR
         resolution.resolution_id = $2 OR
         resolution.mutation_id = $3 OR resolution.run_event_id = $4`,
      [
        resolution.invocationId,
        resolution.resolutionId,
        resolution.stepRunMutationId,
        resolution.runEventId,
      ],
    );
    if (existing.length > 1) throw new ModelInvocationConflictError();
    if (existing[0]) {
      const stored = parseResolution(existing[0]);
      if (JSON.stringify(stored) !== JSON.stringify(resolution)) {
        throw new ModelInvocationConflictError();
      }
      return Object.freeze({ status: 'existing' as const, record: stored });
    }
    const completions = await completionRows(
      client,
      'completion.invocation_id = $1',
      [resolution.invocationId],
    );
    if (
      completions.length !== 1 ||
      JSON.stringify(parseCompletion(completions[0]!)) !==
        JSON.stringify(command.completion) ||
      command.completion.outcome !== 'outcome_unknown'
    ) {
      throw new ModelInvocationConflictError();
    }
    await assertCurrent(client, command.stepRunMutation, resolution.projectId);
    await applyMutation(client, command.stepRunMutation);
    await insertResolution(client, resolution);
    return Object.freeze({
      status: 'created' as const,
      record: resolution,
    });
  });
}
