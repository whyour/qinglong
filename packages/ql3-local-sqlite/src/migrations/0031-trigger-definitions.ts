import { defineLocalSqliteMigration } from './sqlMigration';

export const local0031TriggerDefinitionsMigration = defineLocalSqliteMigration({
  id: '0031-trigger-definitions',
  statements: [
    `
CREATE TABLE "QingLong3Triggers" (
  "project_id" TEXT NOT NULL,
  "trigger_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "current_revision" INTEGER NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  "updated_at_ms" INTEGER NOT NULL,
  PRIMARY KEY ("project_id", "trigger_id"),
  FOREIGN KEY ("project_id")
    REFERENCES "QingLong3Projects" ("id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("project_id", "task_id")
    REFERENCES "QingLong3TaskDefinitions" ("project_id", "task_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_triggers_id_check CHECK (
    length("project_id") BETWEEN 1 AND 128
    AND length("trigger_id") BETWEEN 1 AND 128
    AND length("task_id") BETWEEN 1 AND 128
    AND "project_id" NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*'
    AND "trigger_id" NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*'
    AND "task_id" NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*'
  ),
  CONSTRAINT ql3_triggers_revision_check CHECK (
    "current_revision" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_triggers_time_check CHECK (
    "created_at_ms" >= 0 AND "updated_at_ms" >= "created_at_ms"
  )
)
    `,
    `
CREATE UNIQUE INDEX "ql3_triggers_task_uidx"
ON "QingLong3Triggers" ("project_id", "trigger_id", "task_id")
    `,
    `
CREATE TABLE "QingLong3TriggerRevisions" (
  "project_id" TEXT NOT NULL,
  "trigger_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "mutation_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "task_revision" INTEGER NOT NULL,
  "task_content_digest" TEXT NOT NULL,
  "spec_json" TEXT NOT NULL,
  "enabled" INTEGER NOT NULL,
  "content_digest" TEXT NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  PRIMARY KEY ("project_id", "trigger_id", "revision"),
  FOREIGN KEY ("project_id", "trigger_id", "task_id")
    REFERENCES "QingLong3Triggers" ("project_id", "trigger_id", "task_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("project_id", "task_id", "task_revision")
    REFERENCES "QingLong3TaskDefinitionRevisions" ("project_id", "task_id", "revision")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_trigger_revisions_revision_check CHECK (
    "revision" BETWEEN 1 AND 2147483647
    AND "task_revision" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_trigger_revisions_mutation_check CHECK (
    length("mutation_id") = 36
    AND substr("mutation_id", 9, 1) = '-'
    AND substr("mutation_id", 14, 1) = '-'
    AND substr("mutation_id", 19, 1) = '-'
    AND substr("mutation_id", 24, 1) = '-'
    AND replace("mutation_id", '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_trigger_revisions_task_digest_check CHECK (
    length("task_content_digest") = 64
    AND "task_content_digest" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_trigger_revisions_spec_check CHECK (
    json_valid("spec_json")
    AND json_type("spec_json") = 'object'
    AND length("spec_json") BETWEEN 1 AND 16384
  ),
  CONSTRAINT ql3_trigger_revisions_enabled_check CHECK (
    "enabled" IN (0, 1)
  ),
  CONSTRAINT ql3_trigger_revisions_digest_check CHECK (
    length("content_digest") = 64
    AND "content_digest" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_trigger_revisions_created_check CHECK (
    "created_at_ms" >= 0
  )
)
    `,
    `
CREATE UNIQUE INDEX "ql3_trigger_revisions_mutation_uidx"
ON "QingLong3TriggerRevisions" ("mutation_id")
    `,
    `
CREATE INDEX "ql3_trigger_revisions_project_enabled_idx"
ON "QingLong3TriggerRevisions" (
  "project_id", "enabled", "trigger_id", "revision"
)
    `,
    `
CREATE INDEX "ql3_trigger_revisions_task_idx"
ON "QingLong3TriggerRevisions" (
  "project_id", "task_id", "task_revision", "trigger_id", "revision"
)
    `,
  ],
});
