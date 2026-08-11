import type { DatabaseSync } from 'node:sqlite';

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

import type { LocalModelInvocationOperationAuthority, Row } from './authority';
import {
  TERMINAL_RUN_STATUSES,
  enqueueLocalModelInvocation,
  identifier,
  integer,
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

export function findResolutionOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  invocationIdValue: string,
): Promise<Readonly<ModelInvocationResolutionRecord> | null> {
  const invocationId = identifier(invocationIdValue);
  return enqueueLocalModelInvocation(authority, () => {
    const rows = resolutionRows(client, 'resolution.invocation_id = ?', [
      invocationId,
    ]);
    if (rows.length > 1) throw unavailable();
    return rows[0] ? parseResolution(rows[0]) : null;
  });
}

export function readAuthorityOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  identity: Readonly<{
    projectId: string;
    runId: string;
    stepRunId: string;
  }>,
): Promise<Readonly<ModelInvocationAuthoritySnapshot> | null> {
  const projectId = identifier(identity?.projectId);
  const runId = identifier(identity?.runId);
  const stepRunId = identifier(identity?.stepRunId);
  return enqueueLocalModelInvocation(authority, () => {
    const rows = client
      .prepare(
        `SELECT
             run.project_id AS "projectId", run.id AS "runId",
             run.status AS "runStatus", run.version AS "runVersion",
             run.event_sequence AS "runEventSequence",
             step.id AS "stepRunId", step.status AS "stepStatus",
             step.version AS "stepVersion",
             step.step_run_digest AS "stepDigest",
             step.step_run_json AS "stepRunJson"
           FROM "Runs" AS run
           JOIN "StepRuns" AS step ON step.run_id = run.id
           WHERE run.project_id = ? AND run.id = ? AND step.id = ?
           LIMIT 2`,
      )
      .all(projectId, runId, stepRunId) as Row[];
    if (rows.length > 1) throw unavailable();
    const row = rows[0];
    if (!row || TERMINAL_RUN_STATUSES.has(text(row, 'runStatus'))) {
      return null;
    }
    return parseAuthority(row);
  });
}

export function listIncompleteOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  limitValue: number,
): Promise<Readonly<ModelInvocationRecoveryPage>> {
  const limit = recoveryLimit(limitValue);
  return enqueueLocalModelInvocation(authority, () => {
    const observed = client
      .prepare(
        `SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)
             AS "observedAtMs"`,
      )
      .get() as Row | undefined;
    if (!observed) throw unavailable();
    const observedAtMs = integer(observed, 'observedAtMs');
    const rows = client
      .prepare(
        `SELECT ${START_SELECT}
           FROM "ModelInvocationStarts" AS start
           JOIN "StepRunMutations" AS mutation
             ON mutation.mutation_id = start.mutation_id
           JOIN "RunEvents" AS event ON event.id = start.run_event_id
           LEFT JOIN "ModelInvocationCompletions" AS completion
             ON completion.invocation_id = start.invocation_id
           WHERE completion.invocation_id IS NULL
             AND start.deadline_at_ms <= ?
           ORDER BY start.deadline_at_ms, start.invocation_id
           LIMIT ?`,
      )
      .all(observedAtMs, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    return Object.freeze({
      observedAtMs,
      candidates: Object.freeze(
        rows.slice(0, limit).map((row) => parseStart(row)),
      ),
      hasMore,
    });
  });
}

export function resolveOperation(
  authority: LocalModelInvocationOperationAuthority,
  client: DatabaseSync,
  commandValue: ModelInvocationResolutionCommand,
): Promise<
  Readonly<CommitModelInvocationResult<ModelInvocationResolutionRecord>>
> {
  const command = normalizeModelInvocationResolutionCommand(commandValue);
  const resolution = command.resolution;
  return enqueueLocalModelInvocation(authority, () => {
    let began = false;
    try {
      client.exec('BEGIN IMMEDIATE');
      began = true;
      const existing = resolutionRows(
        client,
        `resolution.invocation_id = ? OR
           resolution.resolution_id = ? OR
           resolution.mutation_id = ? OR resolution.run_event_id = ?`,
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
        client.exec('COMMIT');
        began = false;
        return Object.freeze({ status: 'existing' as const, record: stored });
      }
      const completions = completionRows(
        client,
        'completion.invocation_id = ?',
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
      assertCurrent(client, command.stepRunMutation, resolution.projectId);
      applyMutation(client, command.stepRunMutation);
      insertResolution(client, resolution);
      client.exec('COMMIT');
      began = false;
      return Object.freeze({
        status: 'created' as const,
        record: resolution,
      });
    } catch (error) {
      if (began && client.isTransaction) {
        try {
          client.exec('ROLLBACK');
        } catch {
          // Preserve the original transaction failure.
        }
      }
      throw error;
    }
  });
}
