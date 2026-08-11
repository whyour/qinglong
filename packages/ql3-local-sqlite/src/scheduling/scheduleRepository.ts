import {
  assertLocalSchedulePageSize,
  normalizeLocalScheduleCandidate,
  type CommitLocalScheduleDecisionCommand,
  type CommitLocalScheduleDecisionResult,
  type LocalScheduleCandidate,
  type LocalScheduleCandidatePage,
  type LocalScheduleStore,
} from '@qinglong/runtime-core/local-scheduler';
import type { DatabaseSync } from 'node:sqlite';
import { LocalSqliteOperationAuthority } from '../authority/operationAuthority';

type Row = Record<string, unknown>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class LocalSqliteScheduleUnavailableError extends Error {
  readonly code = 'LOCAL_SCHEDULE_UNAVAILABLE';

  constructor(message = 'Local SQLite schedule storage is unavailable') {
    super(message);
    this.name = 'LocalSqliteScheduleUnavailableError';
  }
}

function string(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new LocalSqliteScheduleUnavailableError();
  }
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) {
    throw new LocalSqliteScheduleUnavailableError();
  }
  return value as number;
}

function nullableInteger(row: Row, key: string): number | null {
  return row[key] === null ? null : integer(row, key);
}

function candidate(row: Row): LocalScheduleCandidate {
  let spec: unknown;
  try {
    spec = JSON.parse(string(row, 'specJson'));
  } catch {
    throw new LocalSqliteScheduleUnavailableError();
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new LocalSqliteScheduleUnavailableError();
  }
  const config = (spec as { config?: unknown }).config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new LocalSqliteScheduleUnavailableError();
  }
  const values = config as Record<string, unknown>;
  return normalizeLocalScheduleCandidate({
    projectId: string(row, 'projectId'),
    triggerId: string(row, 'triggerId'),
    triggerRevision: integer(row, 'triggerRevision'),
    triggerContentDigest: string(row, 'triggerContentDigest'),
    triggerUpdatedAtMs: integer(row, 'triggerUpdatedAtMs'),
    taskId: string(row, 'taskId'),
    taskRevision: integer(row, 'taskRevision'),
    taskContentDigest: string(row, 'taskContentDigest'),
    expression: values.expression as string,
    timezone: values.timezone as string,
    misfirePolicy: values.misfirePolicy as 'skip' | 'fire_once',
    stateVersion: integer(row, 'stateVersion'),
    nextFireAtMs: nullableInteger(row, 'nextFireAtMs'),
  });
}

const CANDIDATE_SELECT = `
  head."project_id" AS "projectId",
  head."trigger_id" AS "triggerId",
  head."current_revision" AS "triggerRevision",
  head."updated_at_ms" AS "triggerUpdatedAtMs",
  revision."content_digest" AS "triggerContentDigest",
  revision."task_id" AS "taskId",
  revision."task_revision" AS "taskRevision",
  revision."task_content_digest" AS "taskContentDigest",
  revision."spec_json" AS "specJson",
  schedule."state_version" AS "stateVersion",
  schedule."next_fire_at_ms" AS "nextFireAtMs"
`;

function sameCandidate(
  left: LocalScheduleCandidate,
  right: LocalScheduleCandidate,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertCommitShape(command: CommitLocalScheduleDecisionCommand): void {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('Local schedule commit command is invalid');
  }
  const allowed = new Set([
    'attemptId',
    'createdEventId',
    'decision',
    'queuedEventId',
    'runId',
  ]);
  if (
    !Object.keys(command).includes('decision') ||
    Object.keys(command).some((key) => !allowed.has(key))
  ) {
    throw new TypeError('Local schedule commit command shape is invalid');
  }
}

export class LocalSqliteScheduleRepository implements LocalScheduleStore {
  private readonly authority: LocalSqliteOperationAuthority;
  private readonly client: DatabaseSync;

  constructor(client: DatabaseSync | LocalSqliteOperationAuthority) {
    this.authority =
      client instanceof LocalSqliteOperationAuthority
        ? client
        : new LocalSqliteOperationAuthority(client);
    this.client = this.authority.client;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    return this.authority.enqueue(
      work,
      () => new LocalSqliteScheduleUnavailableError(),
    );
  }

  listLocalScheduleCandidates(options: {
    readonly observedAtMs: number;
    readonly limit: number;
  }): Promise<LocalScheduleCandidatePage> {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).sort().join(',') !== 'limit,observedAtMs' ||
      !Number.isSafeInteger(options.observedAtMs) ||
      options.observedAtMs < 0
    ) {
      throw new TypeError('Local schedule list options are invalid');
    }
    assertLocalSchedulePageSize(options.limit);
    return this.enqueue(async () => {
      const rows = this.client
        .prepare(
          `SELECT ${CANDIDATE_SELECT}
           FROM "QingLong3LocalTriggerSchedules" AS schedule
           JOIN "QingLong3Triggers" AS head
             ON head."project_id" = schedule."project_id"
            AND head."trigger_id" = schedule."trigger_id"
            AND head."current_revision" = schedule."trigger_revision"
           JOIN "QingLong3TriggerRevisions" AS revision
             ON revision."project_id" = head."project_id"
            AND revision."trigger_id" = head."trigger_id"
            AND revision."revision" = head."current_revision"
           JOIN "QingLong3Projects" AS project
             ON project."id" = head."project_id"
           JOIN "QingLong3TaskDefinitions" AS task_head
             ON task_head."project_id" = revision."project_id"
            AND task_head."task_id" = revision."task_id"
            AND task_head."current_revision" = revision."task_revision"
           JOIN "QingLong3TaskDefinitionRevisions" AS task_revision
             ON task_revision."project_id" = task_head."project_id"
            AND task_revision."task_id" = task_head."task_id"
            AND task_revision."revision" = task_head."current_revision"
            AND task_revision."content_digest" = revision."task_content_digest"
           WHERE project."status" = 'active'
             AND revision."enabled" = 1
             AND task_revision."enabled" = 1
             AND json_extract(revision."spec_json", '$.schema') = 'qinglong/cron@v1'
             AND (schedule."next_fire_at_ms" IS NULL
                  OR schedule."next_fire_at_ms" <= ?)
           ORDER BY schedule."next_fire_at_ms" IS NOT NULL,
                    schedule."next_fire_at_ms",
                    head."project_id", head."trigger_id"
           LIMIT ?`,
        )
        .all(options.observedAtMs, options.limit + 1) as Row[];
      const truncated = rows.length > options.limit;
      return Object.freeze({
        candidates: Object.freeze(rows.slice(0, options.limit).map(candidate)),
        truncated,
      });
    });
  }

  commitLocalScheduleDecision(
    command: CommitLocalScheduleDecisionCommand,
  ): Promise<CommitLocalScheduleDecisionResult> {
    assertCommitShape(command);
    const decision = command.decision;
    if (
      !decision ||
      typeof decision !== 'object' ||
      Array.isArray(decision) ||
      !['initialize', 'skip', 'admit'].includes(decision.disposition) ||
      !Number.isSafeInteger(decision.observedAtMs) ||
      decision.observedAtMs < 0 ||
      !Number.isSafeInteger(decision.nextFireAtMs) ||
      decision.nextFireAtMs <= decision.observedAtMs
    ) {
      throw new TypeError('Local schedule decision is invalid');
    }
    const expected = normalizeLocalScheduleCandidate(decision.candidate);
    const admitted = decision.disposition === 'admit';
    const ids = [
      command.runId,
      command.attemptId,
      command.createdEventId,
      command.queuedEventId,
    ];
    if (
      (admitted &&
        (!Number.isSafeInteger(decision.scheduledForMs) ||
          decision.scheduledForMs! > decision.observedAtMs ||
          ids.some(
            (value) => typeof value !== 'string' || !UUID_PATTERN.test(value),
          ))) ||
      (!admitted &&
        (decision.scheduledForMs !== undefined ||
          ids.some((value) => value !== undefined)))
    ) {
      throw new TypeError('Local schedule admission identity is invalid');
    }

    return this.enqueue(async () => {
      this.client.exec('BEGIN IMMEDIATE');
      try {
        const row = this.client
          .prepare(
            `SELECT ${CANDIDATE_SELECT}
             FROM "QingLong3LocalTriggerSchedules" AS schedule
             JOIN "QingLong3Triggers" AS head
               ON head."project_id" = schedule."project_id"
              AND head."trigger_id" = schedule."trigger_id"
              AND head."current_revision" = schedule."trigger_revision"
             JOIN "QingLong3TriggerRevisions" AS revision
               ON revision."project_id" = head."project_id"
              AND revision."trigger_id" = head."trigger_id"
              AND revision."revision" = head."current_revision"
             JOIN "QingLong3Projects" AS project
               ON project."id" = head."project_id"
             JOIN "QingLong3TaskDefinitions" AS task_head
               ON task_head."project_id" = revision."project_id"
              AND task_head."task_id" = revision."task_id"
              AND task_head."current_revision" = revision."task_revision"
             JOIN "QingLong3TaskDefinitionRevisions" AS task_revision
               ON task_revision."project_id" = task_head."project_id"
              AND task_revision."task_id" = task_head."task_id"
              AND task_revision."revision" = task_head."current_revision"
              AND task_revision."content_digest" = revision."task_content_digest"
             WHERE head."project_id" = ? AND head."trigger_id" = ?
               AND project."status" = 'active' AND revision."enabled" = 1
               AND task_revision."enabled" = 1
               AND json_extract(revision."spec_json", '$.schema') = 'qinglong/cron@v1'`,
          )
          .get(expected.projectId, expected.triggerId) as Row | undefined;
        if (!row || !sameCandidate(candidate(row), expected)) {
          this.client.exec('ROLLBACK');
          return Object.freeze({ status: 'raced' as const });
        }

        if (admitted) {
          const taskRevision = `qltd:v1:${expected.taskRevision}:${expected.taskContentDigest}`;
          const execution = this.client
            .prepare(
              `SELECT 1 FROM "QingLong3LocalTaskExecutionRevisions"
               WHERE "project_id" = ? AND "task_id" = ?
                 AND "task_revision" = ? AND "executor_type" = 'local_process'`,
            )
            .get(expected.projectId, expected.taskId, taskRevision);
          if (!execution)
            throw new LocalSqliteScheduleUnavailableError(
              'Pinned local execution revision is unavailable',
            );
          const task = this.client
            .prepare(
              `SELECT "name" FROM "QingLong3TaskDefinitionRevisions"
               WHERE "project_id" = ? AND "task_id" = ? AND "revision" = ?
                 AND "content_digest" = ?`,
            )
            .get(
              expected.projectId,
              expected.taskId,
              expected.taskRevision,
              expected.taskContentDigest,
            ) as { name?: unknown } | undefined;
          if (!task || typeof task.name !== 'string') {
            throw new LocalSqliteScheduleUnavailableError(
              'Pinned TaskDefinition revision is unavailable',
            );
          }
          const idempotencyKey = `ql3:cron:v1:${expected.triggerId}:${expected.triggerRevision}:${decision.scheduledForMs}`;
          this.client
            .prepare(
              `INSERT INTO "Runs" (
                 "id", "project_id", "task_id", "task_revision", "task_name",
                 "task_snapshot_ref", "trigger_id", "trigger_type",
                 "execution_origin", "execution_owner", "triggered_by",
                 "scheduled_for_ms", "status", "version", "event_sequence",
                 "priority", "idempotency_key", "created_at_ms", "queued_at_ms"
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'cron', 'scheduled_system',
                 'runtime', ?, ?, 'queued', 2, 2, 0, ?, ?, ?)`,
            )
            .run(
              command.runId!,
              expected.projectId,
              expected.taskId,
              taskRevision,
              task.name,
              taskRevision,
              expected.triggerId,
              expected.triggerId,
              decision.scheduledForMs!,
              idempotencyKey,
              decision.observedAtMs,
              decision.observedAtMs,
            );
          this.client
            .prepare(
              `INSERT INTO "RunAttempts" (
                 "id", "run_id", "attempt", "status", "executor_type",
                 "callback_sequence", "created_at_ms"
               ) VALUES (?, ?, 1, 'claimed', 'local_process', 0, ?)`,
            )
            .run(command.attemptId!, command.runId!, decision.observedAtMs);
          const payload = JSON.stringify({
            status: 'created',
            version: 1,
            execution_owner: 'runtime',
            trigger_revision: expected.triggerRevision,
            trigger_content_digest: expected.triggerContentDigest,
            scheduled_for_ms: decision.scheduledForMs,
          });
          this.client
            .prepare(
              `INSERT INTO "RunEvents" (
                 "id", "run_id", "sequence", "type", "dedupe_key",
                 "actor_type", "actor_id", "payload", "created_at_ms"
               ) VALUES (?, ?, 1, 'run.created', ?, 'scheduler', 'local', ?, ?)`,
            )
            .run(
              command.createdEventId!,
              command.runId!,
              `local-schedule-created:${idempotencyKey}`,
              payload,
              decision.observedAtMs,
            );
          this.client
            .prepare(
              `INSERT INTO "RunEvents" (
                 "id", "run_id", "sequence", "type", "dedupe_key",
                 "actor_type", "actor_id", "payload", "created_at_ms"
               ) VALUES (?, ?, 2, 'run.queued', ?, 'scheduler', 'local', ?, ?)`,
            )
            .run(
              command.queuedEventId!,
              command.runId!,
              `local-schedule-queued:${idempotencyKey}`,
              JSON.stringify({
                from_status: 'created',
                to_status: 'queued',
                version: 2,
              }),
              decision.observedAtMs,
            );
        }

        const updated = this.client
          .prepare(
            `UPDATE "QingLong3LocalTriggerSchedules"
             SET "next_fire_at_ms" = ?,
                 "last_scheduled_at_ms" = ?,
                 "state_version" = "state_version" + 1,
                 "updated_at_ms" = ?
             WHERE "project_id" = ? AND "trigger_id" = ?
               AND "trigger_revision" = ? AND "state_version" = ?
               AND "next_fire_at_ms" IS ?`,
          )
          .run(
            decision.nextFireAtMs,
            admitted ? decision.scheduledForMs! : null,
            decision.observedAtMs,
            expected.projectId,
            expected.triggerId,
            expected.triggerRevision,
            expected.stateVersion,
            expected.nextFireAtMs,
          );
        if (updated.changes !== 1) {
          this.client.exec('ROLLBACK');
          return Object.freeze({ status: 'raced' as const });
        }
        this.client.exec('COMMIT');
        return admitted
          ? Object.freeze({
              status: 'admitted' as const,
              disposition: 'admit' as const,
              runId: command.runId!,
              attemptId: command.attemptId!,
            })
          : Object.freeze({
              status: 'advanced' as const,
              disposition: decision.disposition,
            });
      } catch (error) {
        if (this.client.isTransaction) this.client.exec('ROLLBACK');
        if (error instanceof LocalSqliteScheduleUnavailableError) throw error;
        throw new LocalSqliteScheduleUnavailableError(
          error instanceof Error ? error.message : undefined,
        );
      }
    });
  }
}
