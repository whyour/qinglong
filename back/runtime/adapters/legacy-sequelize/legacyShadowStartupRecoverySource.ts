import { QueryTypes, type Sequelize } from 'sequelize';
import {
  RUN_ATTEMPT_TABLE,
  RUN_TABLE,
} from '../../../migrations/0002-run-schema';
import { RUNNING_INSTANCE_TABLE } from '../../../migrations/0003-running-instance-run-reference';
import type {
  ExecutionOrigin,
  RunAttemptStatus,
  RunStatus,
} from '../../domain/run';
import {
  MAX_LEGACY_SHADOW_STARTUP_BATCH_SIZE,
  MAX_LEGACY_SHADOW_STARTUP_EVIDENCE,
  type LegacyRunningInstanceEvidence,
  type LegacyRunningInstanceEvidencePage,
  type LegacyShadowStartupCandidate,
  type LegacyShadowStartupCursor,
  type LegacyShadowStartupPage,
  type LegacyShadowStartupRecoverySource,
} from '../../ports/legacyShadowStartupRecovery';

interface RunRow {
  runId: string;
  legacyCronId: number | null;
  origin: string;
  runStatus: string;
  createdAtMs: number | string;
}

interface AttemptCountRow {
  runId: string;
  activeAttemptCount: number | string;
}

interface AttemptRow {
  attemptId: string;
  runId: string;
  status: string;
  pid: number | null;
  logArtifactId: string | null;
  createdAtMs: number | string;
  startedAtMs: number | string | null;
}

interface RunningInstanceRow {
  pid: number | null;
  logPath: string | null;
  startedAt: number | string;
  finishedAt: number | string | null;
  status: number | string;
  exitCode: number | null;
}

export type LegacyLogArtifactIdFactory = (logPath: string) => string;

function safeInteger(value: number | string, name: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed;
}

function secondsToMilliseconds(value: number | string, name: string): number {
  const seconds = safeInteger(value, name);
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TypeError(`${name} is invalid`);
  }
  return milliseconds;
}

function optionalPositiveInteger(
  value: number | null,
  name: string,
): number | undefined {
  if (value === null) return undefined;
  const parsed = safeInteger(value, name);
  if (parsed < 1) throw new TypeError(`${name} is invalid`);
  return parsed;
}

function assertLimit(limit: number, maximum: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`limit must be between 1 and ${maximum}`);
  }
}

function outcome(status: number): LegacyRunningInstanceEvidence['outcome'] {
  if (status === 0) return 'running';
  if (status === 1) return 'succeeded';
  if (status === 2) return 'stopped';
  if (status === 3) return 'failed';
  throw new TypeError('RunningInstance status is invalid');
}

export class LegacySequelizeShadowStartupRecoverySource
  implements LegacyShadowStartupRecoverySource
{
  constructor(
    private readonly database: Sequelize,
    private readonly createLogArtifactId: LegacyLogArtifactIdFactory,
  ) {}

  async listCandidates({
    origins,
    cursor,
    limit = MAX_LEGACY_SHADOW_STARTUP_BATCH_SIZE,
  }: {
    origins: readonly ExecutionOrigin[];
    cursor?: LegacyShadowStartupCursor;
    limit?: number;
  }): Promise<LegacyShadowStartupPage> {
    assertLimit(limit, MAX_LEGACY_SHADOW_STARTUP_BATCH_SIZE);
    const enabledOrigins = [...new Set(origins)];
    if (enabledOrigins.length === 0) {
      return { candidates: [], truncated: false };
    }
    if (
      cursor !== undefined &&
      (!Number.isSafeInteger(cursor.createdAtMs) ||
        cursor.createdAtMs < 0 ||
        cursor.runId.length === 0)
    ) {
      throw new TypeError('Legacy Shadow startup cursor is invalid');
    }

    const runRows = await this.database.query<RunRow>(
      `SELECT
         id AS "runId",
         legacy_cron_id AS "legacyCronId",
         execution_origin AS origin,
         status AS "runStatus",
         created_at_ms AS "createdAtMs"
       FROM ${RUN_TABLE}
       WHERE execution_owner = 'legacy'
         AND execution_origin IN (:origins)
         AND status IN ('queued', 'dispatching', 'running')
         ${
           cursor === undefined
             ? ''
             : `AND (
                  created_at_ms > :cursorCreatedAtMs OR
                  (created_at_ms = :cursorCreatedAtMs AND id > :cursorRunId)
                )`
         }
       ORDER BY created_at_ms ASC, id ASC
       LIMIT :fetchLimit`,
      {
        replacements: {
          origins: enabledOrigins,
          fetchLimit: limit + 1,
          ...(cursor === undefined
            ? {}
            : {
                cursorCreatedAtMs: cursor.createdAtMs,
                cursorRunId: cursor.runId,
              }),
        },
        type: QueryTypes.SELECT,
      },
    );
    const truncated = runRows.length > limit;
    const boundedRuns = runRows.slice(0, limit);
    if (boundedRuns.length === 0) {
      return { candidates: [], truncated };
    }

    const runIds = boundedRuns.map((run) => run.runId);
    const countRows = await this.database.query<AttemptCountRow>(
      `SELECT run_id AS "runId", COUNT(*) AS "activeAttemptCount"
       FROM ${RUN_ATTEMPT_TABLE}
       WHERE run_id IN (:runIds)
         AND status IN ('claimed', 'starting', 'running')
       GROUP BY run_id`,
      {
        replacements: { runIds },
        type: QueryTypes.SELECT,
      },
    );
    const counts = new Map(
      countRows.map((row) => [
        row.runId,
        safeInteger(row.activeAttemptCount, 'activeAttemptCount'),
      ]),
    );
    const singleAttemptRunIds = runIds.filter(
      (runId) => counts.get(runId) === 1,
    );
    const attemptRows =
      singleAttemptRunIds.length === 0
        ? []
        : await this.database.query<AttemptRow>(
            `SELECT
               id AS "attemptId",
               run_id AS "runId",
               status,
               pid,
               log_artifact_id AS "logArtifactId",
               created_at_ms AS "createdAtMs",
               started_at_ms AS "startedAtMs"
             FROM ${RUN_ATTEMPT_TABLE}
             WHERE run_id IN (:runIds)
               AND status IN ('claimed', 'starting', 'running')`,
            {
              replacements: { runIds: singleAttemptRunIds },
              type: QueryTypes.SELECT,
            },
          );
    const attempts = new Map(attemptRows.map((row) => [row.runId, row]));
    const candidates: LegacyShadowStartupCandidate[] = boundedRuns.map(
      (run) => {
        const activeAttemptCount = counts.get(run.runId) ?? 0;
        const attempt = attempts.get(run.runId);
        return {
          runId: run.runId,
          ...(run.legacyCronId === null
            ? {}
            : {
                legacyCronId: optionalPositiveInteger(
                  run.legacyCronId,
                  'legacyCronId',
                ),
              }),
          origin: run.origin as ExecutionOrigin,
          runStatus: run.runStatus as RunStatus,
          createdAtMs: safeInteger(run.createdAtMs, 'createdAtMs'),
          activeAttemptCount,
          ...(attempt === undefined
            ? {}
            : {
                attempt: {
                  attemptId: attempt.attemptId,
                  status: attempt.status as RunAttemptStatus,
                  ...(attempt.pid === null ? {} : { pid: attempt.pid }),
                  ...(attempt.logArtifactId === null
                    ? {}
                    : { logArtifactId: attempt.logArtifactId }),
                  createdAtMs: safeInteger(
                    attempt.createdAtMs,
                    'attempt.createdAtMs',
                  ),
                  ...(attempt.startedAtMs === null
                    ? {}
                    : {
                        startedAtMs: safeInteger(
                          attempt.startedAtMs,
                          'attempt.startedAtMs',
                        ),
                      }),
                },
              }),
        };
      },
    );
    const last = candidates.at(-1);
    return {
      candidates,
      truncated,
      ...(truncated && last
        ? {
            nextCursor: {
              createdAtMs: last.createdAtMs,
              runId: last.runId,
            },
          }
        : {}),
    };
  }

  async listRunningInstanceEvidence({
    legacyCronId,
    limit = MAX_LEGACY_SHADOW_STARTUP_EVIDENCE,
  }: {
    legacyCronId: number;
    limit?: number;
  }): Promise<LegacyRunningInstanceEvidencePage> {
    if (!Number.isSafeInteger(legacyCronId) || legacyCronId < 1) {
      throw new RangeError('legacyCronId must be a positive safe integer');
    }
    assertLimit(limit, MAX_LEGACY_SHADOW_STARTUP_EVIDENCE);
    const rows = await this.database.query<RunningInstanceRow>(
      `SELECT
         pid,
         log_path AS "logPath",
         started_at AS "startedAt",
         finished_at AS "finishedAt",
         status,
         exit_code AS "exitCode"
       FROM ${RUNNING_INSTANCE_TABLE}
       WHERE cron_id = :legacyCronId
       ORDER BY started_at DESC, id DESC
       LIMIT :fetchLimit`,
      {
        replacements: { legacyCronId, fetchLimit: limit + 1 },
        type: QueryTypes.SELECT,
      },
    );
    const truncated = rows.length > limit;
    return {
      evidence: rows.slice(0, limit).map((row) => ({
        ...(row.pid === null ? {} : { pid: row.pid }),
        ...(row.logPath === null
          ? {}
          : { logArtifactId: this.createLogArtifactId(row.logPath) }),
        startedAtMs: secondsToMilliseconds(row.startedAt, 'startedAt'),
        ...(row.finishedAt === null
          ? {}
          : {
              finishedAtMs: secondsToMilliseconds(row.finishedAt, 'finishedAt'),
            }),
        outcome: outcome(safeInteger(row.status, 'status')),
        ...(row.exitCode === null ? {} : { exitCode: row.exitCode }),
      })),
      truncated,
    };
  }
}
