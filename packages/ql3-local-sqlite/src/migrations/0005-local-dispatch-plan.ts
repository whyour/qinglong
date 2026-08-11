import { defineLocalSqliteMigration } from './sqlMigration';

export const local0005LocalDispatchPlanMigration = defineLocalSqliteMigration({
  id: '0005-local-dispatch-plan',
  statements: [
    `
CREATE TABLE "QingLong3LocalExecutionContextRecipes" (
  "context_ref" TEXT PRIMARY KEY NOT NULL,
  "environment_json" TEXT NOT NULL,
  "content_digest" TEXT NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  CONSTRAINT ql3_local_context_ref_check CHECK (
    length("context_ref") = 80
    AND "context_ref" GLOB 'localctx:sha256:[0-9a-f]*'
    AND length(replace("context_ref", 'localctx:sha256:', '')) = 64
  ),
  CONSTRAINT ql3_local_context_environment_check CHECK (
    json_valid("environment_json")
    AND json_type("environment_json") = 'array'
    AND length("environment_json") <= 262144
  ),
  CONSTRAINT ql3_local_context_digest_check CHECK (
    length("content_digest") = 64
    AND "content_digest" NOT GLOB '*[^0-9a-f]*'
    AND "context_ref" = 'localctx:sha256:' || "content_digest"
  ),
  CONSTRAINT ql3_local_context_created_check CHECK ("created_at_ms" >= 0)
)
    `,
    `
CREATE TABLE "QingLong3LocalTaskExecutionRevisions" (
  "project_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "task_revision" TEXT NOT NULL,
  "executor_type" TEXT NOT NULL,
  "command_json" TEXT NOT NULL,
  "working_directory" TEXT,
  "timeout_ms" INTEGER,
  "context_ref" TEXT NOT NULL,
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
  CONSTRAINT ql3_local_revision_created_check CHECK ("created_at_ms" >= 0),
  FOREIGN KEY ("context_ref")
    REFERENCES "QingLong3LocalExecutionContextRecipes" ("context_ref")
    ON DELETE RESTRICT
)
    `,
    `
CREATE INDEX "ql3_local_runs_dispatch_idx"
ON "Runs" (
  "execution_owner", "status", "priority" DESC,
  "queued_at_ms", "id"
)
WHERE "execution_owner" = 'runtime'
  AND "status" = 'queued'
  AND "cancel_requested_at_ms" IS NULL
    `,
  ],
});
