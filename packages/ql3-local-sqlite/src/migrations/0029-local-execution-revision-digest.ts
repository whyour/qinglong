import {
  createLocalTaskExecutionRevision,
  type LocalDispatchCommand,
} from '@qinglong/runtime-core/local-dispatch';
import {
  normalizeTaskDefinitionRecord,
  type TaskDefinitionRecord,
} from '@qinglong/runtime-core/task-definition';
import { compileLocalCommandTaskDefinition } from '@qinglong/runtime-core/task-definition-execution-compiler';
import {
  BUILT_IN_COMMAND_TASK_SPEC_SCHEMA,
  createBuiltInTaskSpecSemanticRegistry,
} from '@qinglong/runtime-core/task-spec-semantic';
import { LocalSqliteDispatchDefinitionStore } from '../task-definition/dispatchDefinitionStore';
import { defineLocalSqliteProgrammaticMigration } from './sqlMigration';

const REPLACEMENT_TABLE = `
CREATE TABLE "QingLong3LocalTaskExecutionRevisions_v15" (
  "project_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "task_revision" TEXT NOT NULL,
  "executor_type" TEXT NOT NULL,
  "command_json" TEXT NOT NULL,
  "working_directory" TEXT,
  "timeout_ms" INTEGER,
  "context_ref" TEXT NOT NULL,
  "content_digest" TEXT NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  PRIMARY KEY ("project_id", "task_id", "task_revision"),
  CONSTRAINT ql3_local_revision_executor_check CHECK (
    "executor_type" = 'local_process'
  ),
  CONSTRAINT ql3_local_revision_command_check CHECK (
    json_valid("command_json")
    AND json_type("command_json") = 'object'
    AND length("command_json") BETWEEN 1 AND 131072
  ),
  CONSTRAINT ql3_local_revision_working_directory_check CHECK (
    "working_directory" IS NULL
    OR (length("working_directory") BETWEEN 1 AND 4096
        AND substr("working_directory", 1, 1) = '/')
  ),
  CONSTRAINT ql3_local_revision_timeout_check CHECK (
    "timeout_ms" IS NULL OR "timeout_ms" BETWEEN 1 AND 31536000000
  ),
  CONSTRAINT ql3_local_revision_digest_check CHECK (
    length("content_digest") = 64
    AND "content_digest" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_local_revision_created_check CHECK ("created_at_ms" >= 0),
  FOREIGN KEY ("context_ref")
    REFERENCES "QingLong3LocalExecutionContextRecipes" ("context_ref")
    ON DELETE RESTRICT
)
`;

type RevisionRow = Record<string, unknown>;

function requiredText(row: RevisionRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new TypeError(`Local execution revision ${key} is invalid`);
  }
  return value;
}

function optionalText(row: RevisionRow, key: string): string | undefined {
  const value = row[key];
  if (value === null) return undefined;
  return requiredText(row, key);
}

function requiredInteger(row: RevisionRow, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`Local execution revision ${key} is invalid`);
  }
  return value as number;
}

function optionalInteger(row: RevisionRow, key: string): number | undefined {
  const value = row[key];
  if (value === null) return undefined;
  return requiredInteger(row, key);
}

function command(row: RevisionRow): LocalDispatchCommand {
  try {
    return JSON.parse(requiredText(row, 'commandJson')) as LocalDispatchCommand;
  } catch {
    throw new TypeError('Local execution revision commandJson is invalid');
  }
}

function requiredJson(row: RevisionRow, key: string): unknown {
  try {
    return JSON.parse(requiredText(row, key)) as unknown;
  } catch {
    throw new TypeError(`TaskDefinition ${key} is invalid`);
  }
}

function taskDefinition(row: RevisionRow): TaskDefinitionRecord {
  const description = optionalText(row, 'description');
  const enabled = requiredInteger(row, 'enabled');
  if (enabled !== 0 && enabled !== 1) {
    throw new TypeError('TaskDefinition enabled is invalid');
  }
  return normalizeTaskDefinitionRecord({
    projectId: requiredText(row, 'projectId'),
    taskId: requiredText(row, 'taskId'),
    revision: requiredInteger(row, 'revision'),
    mutationId: requiredText(row, 'mutationId'),
    name: requiredText(row, 'name'),
    ...(description === undefined ? {} : { description }),
    kind: requiredText(row, 'kind') as TaskDefinitionRecord['kind'],
    spec: requiredJson(row, 'specJson') as TaskDefinitionRecord['spec'],
    labels: requiredJson(row, 'labelsJson') as TaskDefinitionRecord['labels'],
    enabled: enabled === 1,
    contentDigest: requiredText(row, 'taskContentDigest'),
    createdAtMs: requiredInteger(row, 'taskCreatedAtMs'),
    updatedAtMs: requiredInteger(row, 'taskUpdatedAtMs'),
  });
}

export const local0029LocalExecutionRevisionDigestMigration =
  defineLocalSqliteProgrammaticMigration({
    id: '0029-local-execution-revision-digest',
    program: [
      REPLACEMENT_TABLE,
      `Read every legacy revision in primary-key order without buffering.
       Parse and normalize command_json through
       createLocalTaskExecutionRevision using digest domain
       qinglong.local-task-execution-revision.v1 NUL. The digest covers
       project, task, revision, executor, canonical command, optional working
       directory, optional timeout and context ref; created_at_ms is excluded
       so an exact semantic replay preserves the first observed timestamp.`,
      `Insert every normalized row and computed lowercase SHA-256 digest into
       QingLong3LocalTaskExecutionRevisions_v15. Reject malformed legacy rows,
       count drift, constraint failures or digest failures so the enclosing
       BEGIN IMMEDIATE transaction rolls the entire migration back.`,
      `After the digest table replacement, read every historical enabled
       qinglong/command@v1 TaskDefinition revision in primary-key order,
       revalidate its stored TaskDefinition content digest and built-in
       semantics, compile the deterministic local plan, and append its context
       recipe and execution revision through exact-content replay. Skip
       disabled and non-built-in revisions; reject missing Projects, corrupt
       built-in records or pre-existing derived identity conflicts.`,
      'DROP TABLE "QingLong3LocalTaskExecutionRevisions"',
      `ALTER TABLE "QingLong3LocalTaskExecutionRevisions_v15"
       RENAME TO "QingLong3LocalTaskExecutionRevisions"`,
    ],
    up({ client }) {
      client.exec(REPLACEMENT_TABLE);
      const rows = client.prepare(
        `SELECT "project_id" AS "projectId", "task_id" AS "taskId",
                "task_revision" AS "taskRevision",
                "executor_type" AS "executorType",
                "command_json" AS "commandJson",
                "working_directory" AS "workingDirectory",
                "timeout_ms" AS "timeoutMs", "context_ref" AS "contextRef",
                "created_at_ms" AS "createdAtMs"
         FROM "QingLong3LocalTaskExecutionRevisions"
         ORDER BY "project_id", "task_id", "task_revision"`,
      );
      const insert = client.prepare(
        `INSERT INTO "QingLong3LocalTaskExecutionRevisions_v15" (
           "project_id", "task_id", "task_revision", "executor_type",
           "command_json", "working_directory", "timeout_ms", "context_ref",
           "content_digest", "created_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let backfilled = 0;
      for (const value of rows.iterate() as Iterable<RevisionRow>) {
        const executorType = requiredText(value, 'executorType');
        if (executorType !== 'local_process') {
          throw new TypeError('Local execution revision executorType is invalid');
        }
        const workingDirectory = optionalText(value, 'workingDirectory');
        const timeoutMs = optionalInteger(value, 'timeoutMs');
        const revision = createLocalTaskExecutionRevision({
          projectId: requiredText(value, 'projectId'),
          taskId: requiredText(value, 'taskId'),
          taskRevision: requiredText(value, 'taskRevision'),
          executorType,
          command: command(value),
          ...(workingDirectory === undefined ? {} : { workingDirectory }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          contextRef: requiredText(value, 'contextRef'),
          createdAtMs: requiredInteger(value, 'createdAtMs'),
        });
        insert.run(
          revision.projectId,
          revision.taskId,
          revision.taskRevision,
          revision.executorType,
          JSON.stringify(revision.command),
          revision.workingDirectory ?? null,
          revision.timeoutMs ?? null,
          revision.contextRef,
          revision.contentDigest,
          revision.createdAtMs,
        );
        backfilled += 1;
      }
      const sourceCount = client
        .prepare(
          'SELECT COUNT(*) AS "count" FROM "QingLong3LocalTaskExecutionRevisions"',
        )
        .get() as { count?: unknown } | undefined;
      if (
        !sourceCount ||
        !Number.isSafeInteger(sourceCount.count) ||
        sourceCount.count !== backfilled
      ) {
        throw new TypeError('Local execution revision backfill count drifted');
      }
      client.exec('DROP TABLE "QingLong3LocalTaskExecutionRevisions"');
      client.exec(
        `ALTER TABLE "QingLong3LocalTaskExecutionRevisions_v15"
         RENAME TO "QingLong3LocalTaskExecutionRevisions"`,
      );

      const semanticRegistry = createBuiltInTaskSpecSemanticRegistry();
      const definitions = client.prepare(
        `SELECT revision."project_id" AS "projectId",
                revision."task_id" AS "taskId",
                revision."revision" AS "revision",
                revision."mutation_id" AS "mutationId",
                revision."name" AS "name",
                revision."description" AS "description",
                revision."kind" AS "kind",
                revision."spec_json" AS "specJson",
                revision."labels_json" AS "labelsJson",
                revision."enabled" AS "enabled",
                revision."content_digest" AS "taskContentDigest",
                head."created_at_ms" AS "taskCreatedAtMs",
                revision."created_at_ms" AS "taskUpdatedAtMs"
         FROM "QingLong3TaskDefinitionRevisions" AS revision
         JOIN "QingLong3TaskDefinitions" AS head
           ON head."project_id" = revision."project_id"
          AND head."task_id" = revision."task_id"
         ORDER BY revision."project_id", revision."task_id",
                  revision."revision"`,
      );
      const dispatchDefinitions = new LocalSqliteDispatchDefinitionStore(client);
      for (const value of definitions.iterate() as Iterable<RevisionRow>) {
        const definition = taskDefinition(value);
        if (
          !definition.enabled ||
          definition.kind !== 'command' ||
          definition.spec.schema !== BUILT_IN_COMMAND_TASK_SPEC_SCHEMA
        ) {
          continue;
        }
        dispatchDefinitions.appendPlan(
          compileLocalCommandTaskDefinition(definition, semanticRegistry),
        );
      }
    },
  });
