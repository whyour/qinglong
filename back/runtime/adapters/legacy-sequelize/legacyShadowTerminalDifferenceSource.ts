import { QueryTypes, type Sequelize } from 'sequelize';
import {
  RUN_ATTEMPT_TABLE,
  RUN_TABLE,
} from '../../../migrations/0002-run-schema';
import { RUNNING_INSTANCE_TABLE } from '../../../migrations/0003-running-instance-run-reference';
import {
  EXECUTION_ORIGINS,
  RUN_ATTEMPT_STATUSES,
  RUN_STATUSES,
  type ExecutionOrigin,
  type RunAttemptStatus,
  type RunStatus,
} from '../../domain/run';
import {
  MAX_LEGACY_SHADOW_TERMINAL_EVIDENCE_PER_PAGE,
  MAX_LEGACY_SHADOW_TERMINAL_PAGE_SIZE,
  type LegacyShadowTerminalCandidate,
  type LegacyShadowTerminalCursor,
  type LegacyShadowTerminalDifferenceSource,
  type LegacyShadowTerminalPage,
  type LegacyTerminalEvidence,
  type LegacyTerminalOutcome,
} from '../../ports/legacyShadowTerminalDifference';

interface CandidateRow {
  runId: string;
  legacyCronId: number | null;
  origin: string;
  runStatus: string;
  createdAtMs: number | string;
  startedAtMs: number | string | null;
  finishedAtMs: number | string | null;
  attemptCount: number | string;
  attemptId: string | null;
  attemptStatus: string | null;
  attemptPid: number | null;
  attemptLogArtifactId: string | null;
  attemptCreatedAtMs: number | string | null;
  attemptStartedAtMs: number | string | null;
  attemptFinishedAtMs: number | string | null;
  attemptExitCode: number | null;
}

interface EvidenceRow {
  instanceId: number | string;
  legacyCronId: number | string;
  runId: string | null;
  attemptId: string | null;
  pid: number | null;
  logPath: string | null;
  startedAt: number | string;
  finishedAt: number | string;
  status: number | string;
  exitCode: number | null;
}

export type LegacyTerminalLogArtifactIdFactory = (logPath: string) => string;

const ORIGINS = new Set<string>(EXECUTION_ORIGINS);
const RUN_STATUS_SET = new Set<string>(RUN_STATUSES);
const ATTEMPT_STATUS_SET = new Set<string>(RUN_ATTEMPT_STATUSES);

function safeInteger(value: number | string, name: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed;
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

function secondsToMilliseconds(value: number | string, name: string): number {
  const milliseconds = safeInteger(value, name) * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TypeError(`${name} is invalid`);
  }
  return milliseconds;
}

function assertLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LEGACY_SHADOW_TERMINAL_PAGE_SIZE
  ) {
    throw new RangeError(
      `limit must be between 1 and ${MAX_LEGACY_SHADOW_TERMINAL_PAGE_SIZE}`,
    );
  }
}

function runStatus(value: string): RunStatus {
  if (!RUN_STATUS_SET.has(value)) {
    throw new TypeError('Run status is invalid');
  }
  return value as RunStatus;
}

function attemptStatus(value: string): RunAttemptStatus {
  if (!ATTEMPT_STATUS_SET.has(value)) {
    throw new TypeError('Run Attempt status is invalid');
  }
  return value as RunAttemptStatus;
}

function origin(value: string): ExecutionOrigin {
  if (!ORIGINS.has(value)) {
    throw new TypeError('Run execution origin is invalid');
  }
  return value as ExecutionOrigin;
}

function terminalOutcome(value: number): LegacyTerminalOutcome {
  if (value === 1) return 'succeeded';
  if (value === 2) return 'stopped';
  if (value === 3) return 'failed';
  throw new TypeError('RunningInstance terminal status is invalid');
}

function candidateFromRow(row: CandidateRow): LegacyShadowTerminalCandidate {
  const attemptCount = safeInteger(row.attemptCount, 'attemptCount');
  if (
    (attemptCount === 0 && row.attemptId !== null) ||
    (attemptCount > 0 &&
      (row.attemptId === null ||
        row.attemptStatus === null ||
        row.attemptCreatedAtMs === null))
  ) {
    throw new TypeError('Run Attempt projection is invalid');
  }
  return {
    runId: row.runId,
    ...(row.legacyCronId === null
      ? {}
      : {
          legacyCronId: optionalPositiveInteger(
            row.legacyCronId,
            'legacyCronId',
          ),
        }),
    origin: origin(row.origin),
    runStatus: runStatus(row.runStatus),
    createdAtMs: safeInteger(row.createdAtMs, 'createdAtMs'),
    ...(row.startedAtMs === null
      ? {}
      : { startedAtMs: safeInteger(row.startedAtMs, 'startedAtMs') }),
    ...(row.finishedAtMs === null
      ? {}
      : { finishedAtMs: safeInteger(row.finishedAtMs, 'finishedAtMs') }),
    attemptCount,
    ...(row.attemptId === null
      ? {}
      : {
          attempt: {
            attemptId: row.attemptId,
            status: attemptStatus(row.attemptStatus!),
            ...(row.attemptPid === null
              ? {}
              : { pid: optionalPositiveInteger(row.attemptPid, 'attemptPid') }),
            ...(row.attemptLogArtifactId === null
              ? {}
              : { logArtifactId: row.attemptLogArtifactId }),
            createdAtMs: safeInteger(
              row.attemptCreatedAtMs!,
              'attemptCreatedAtMs',
            ),
            ...(row.attemptStartedAtMs === null
              ? {}
              : {
                  startedAtMs: safeInteger(
                    row.attemptStartedAtMs,
                    'attemptStartedAtMs',
                  ),
                }),
            ...(row.attemptFinishedAtMs === null
              ? {}
              : {
                  finishedAtMs: safeInteger(
                    row.attemptFinishedAtMs,
                    'attemptFinishedAtMs',
                  ),
                }),
            ...(row.attemptExitCode === null
              ? {}
              : {
                  exitCode: safeInteger(row.attemptExitCode, 'attemptExitCode'),
                }),
          },
        }),
  };
}

/** SQLite/Sequelize adapter for the explicit, read-only local audit. */
export class LegacySequelizeShadowTerminalDifferenceSource
  implements LegacyShadowTerminalDifferenceSource
{
  constructor(
    private readonly database: Sequelize,
    private readonly createLogArtifactId: LegacyTerminalLogArtifactIdFactory,
  ) {}

  async listCandidates({
    projectId,
    origins,
    windowStartMs,
    windowEndMs,
    observedAtMs,
    correlationToleranceMs,
    cursor,
    limit,
  }: {
    projectId: string;
    origins: readonly ExecutionOrigin[];
    windowStartMs: number;
    windowEndMs: number;
    observedAtMs: number;
    correlationToleranceMs: number;
    cursor?: LegacyShadowTerminalCursor;
    limit: number;
  }): Promise<LegacyShadowTerminalPage> {
    assertLimit(limit);
    if (origins.length === 0) {
      return {
        candidates: [],
        evidence: [],
        evidenceTruncated: false,
        truncated: false,
      };
    }
    const rows = await this.database.query<CandidateRow>(
      `SELECT
         r.id AS "runId",
         r.legacy_cron_id AS "legacyCronId",
         r.execution_origin AS origin,
         r.status AS "runStatus",
         r.created_at_ms AS "createdAtMs",
         r.started_at_ms AS "startedAtMs",
         r.finished_at_ms AS "finishedAtMs",
         (SELECT COUNT(*)
            FROM ${RUN_ATTEMPT_TABLE} counted
           WHERE counted.run_id = r.id) AS "attemptCount",
         attempt.id AS "attemptId",
         attempt.status AS "attemptStatus",
         attempt.pid AS "attemptPid",
         attempt.log_artifact_id AS "attemptLogArtifactId",
         attempt.created_at_ms AS "attemptCreatedAtMs",
         attempt.started_at_ms AS "attemptStartedAtMs",
         attempt.finished_at_ms AS "attemptFinishedAtMs",
         attempt.exit_code AS "attemptExitCode"
       FROM ${RUN_TABLE} r
       LEFT JOIN ${RUN_ATTEMPT_TABLE} attempt
         ON attempt.id = (
           SELECT latest.id
             FROM ${RUN_ATTEMPT_TABLE} latest
            WHERE latest.run_id = r.id
            ORDER BY latest.attempt DESC, latest.id DESC
            LIMIT 1
         )
       WHERE r.project_id = :projectId
         AND r.execution_owner = 'legacy'
         AND r.execution_origin IN (:origins)
         AND r.created_at_ms >= :windowStartMs
         AND r.created_at_ms < :windowEndMs
         ${
           cursor === undefined
             ? ''
             : `AND (
                  r.created_at_ms > :cursorCreatedAtMs OR
                  (r.created_at_ms = :cursorCreatedAtMs AND r.id > :cursorRunId)
                )`
         }
       ORDER BY r.created_at_ms ASC, r.id ASC
       LIMIT :fetchLimit`,
      {
        replacements: {
          projectId,
          origins: [...new Set(origins)],
          windowStartMs,
          windowEndMs,
          ...(cursor === undefined
            ? {}
            : {
                cursorCreatedAtMs: cursor.createdAtMs,
                cursorRunId: cursor.runId,
              }),
          fetchLimit: limit + 1,
        },
        type: QueryTypes.SELECT,
      },
    );
    const truncated = rows.length > limit;
    const candidates = rows.slice(0, limit).map(candidateFromRow);
    if (candidates.length === 0) {
      return {
        candidates,
        evidence: [],
        evidenceTruncated: false,
        truncated: false,
      };
    }

    const evidence = await this.listEvidence({
      candidates,
      windowStartMs,
      observedAtMs,
      correlationToleranceMs,
    });
    const last = candidates[candidates.length - 1];
    return {
      candidates,
      ...evidence,
      truncated,
      ...(truncated
        ? {
            nextCursor: {
              createdAtMs: last.createdAtMs,
              runId: last.runId,
            },
          }
        : {}),
    };
  }

  private async listEvidence({
    candidates,
    windowStartMs,
    observedAtMs,
    correlationToleranceMs,
  }: {
    candidates: readonly LegacyShadowTerminalCandidate[];
    windowStartMs: number;
    observedAtMs: number;
    correlationToleranceMs: number;
  }): Promise<{
    evidence: readonly LegacyTerminalEvidence[];
    evidenceTruncated: boolean;
  }> {
    const runIds = candidates.map((candidate) => candidate.runId);
    const attemptIds = candidates.flatMap((candidate) =>
      candidate.attempt ? [candidate.attempt.attemptId] : [],
    );
    const legacyCronIds = [
      ...new Set(
        candidates.flatMap((candidate) =>
          candidate.legacyCronId === undefined ? [] : [candidate.legacyCronId],
        ),
      ),
    ];
    const clauses = ['run_id IN (:runIds)'];
    if (attemptIds.length > 0) clauses.push('attempt_id IN (:attemptIds)');
    if (legacyCronIds.length > 0) {
      clauses.push(`(
        cron_id IN (:legacyCronIds)
        AND started_at >= :startedAfterSeconds
        AND started_at <= :startedBeforeSeconds
      )`);
    }
    const evidenceLimit = Math.min(
      MAX_LEGACY_SHADOW_TERMINAL_EVIDENCE_PER_PAGE,
      candidates.length * 8,
    );
    const rows = await this.database.query<EvidenceRow>(
      `SELECT
         id AS "instanceId",
         cron_id AS "legacyCronId",
         run_id AS "runId",
         attempt_id AS "attemptId",
         pid,
         log_path AS "logPath",
         started_at AS "startedAt",
         finished_at AS "finishedAt",
         status,
         exit_code AS "exitCode"
       FROM ${RUNNING_INSTANCE_TABLE}
       WHERE status IN (1, 2, 3)
         AND finished_at IS NOT NULL
         AND (${clauses.join(' OR ')})
       ORDER BY started_at ASC, id ASC
       LIMIT :fetchLimit`,
      {
        replacements: {
          runIds,
          ...(attemptIds.length === 0 ? {} : { attemptIds }),
          ...(legacyCronIds.length === 0
            ? {}
            : {
                legacyCronIds,
                startedAfterSeconds: Math.floor(
                  Math.max(0, windowStartMs - correlationToleranceMs) / 1_000,
                ),
                startedBeforeSeconds: Math.ceil(observedAtMs / 1_000),
              }),
          fetchLimit: evidenceLimit + 1,
        },
        type: QueryTypes.SELECT,
      },
    );
    const evidenceTruncated = rows.length > evidenceLimit;
    return {
      evidence: rows.slice(0, evidenceLimit).map((row) => ({
        instanceId: safeInteger(row.instanceId, 'instanceId'),
        legacyCronId: safeInteger(row.legacyCronId, 'legacyCronId'),
        ...(row.runId === null ? {} : { runId: row.runId }),
        ...(row.attemptId === null ? {} : { attemptId: row.attemptId }),
        ...(row.pid === null
          ? {}
          : { pid: optionalPositiveInteger(row.pid, 'pid') }),
        ...(row.logPath === null
          ? {}
          : { logArtifactId: this.createLogArtifactId(row.logPath) }),
        startedAtMs: secondsToMilliseconds(row.startedAt, 'startedAt'),
        finishedAtMs: secondsToMilliseconds(row.finishedAt, 'finishedAt'),
        outcome: terminalOutcome(safeInteger(row.status, 'status')),
        ...(row.exitCode === null
          ? {}
          : { exitCode: safeInteger(row.exitCode, 'exitCode') }),
      })),
      evidenceTruncated,
    };
  }
}
