import { defineLocalSqliteMigration } from './sqlMigration';

export const local0027TaskDefinitionsMigration = defineLocalSqliteMigration({
  id: '0027-task-definitions',
  statements: [
    `
CREATE TABLE "QingLong3TaskDefinitions" (
  "project_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "current_revision" INTEGER NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  "updated_at_ms" INTEGER NOT NULL,
  PRIMARY KEY ("project_id", "task_id"),
  FOREIGN KEY ("project_id")
    REFERENCES "QingLong3Projects" ("id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_task_definitions_id_check CHECK (
    length("project_id") BETWEEN 1 AND 128
    AND length("task_id") BETWEEN 1 AND 128
    AND "project_id" NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*'
    AND "task_id" NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*'
  ),
  CONSTRAINT ql3_task_definitions_revision_check CHECK (
    "current_revision" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_task_definitions_time_check CHECK (
    "created_at_ms" >= 0 AND "updated_at_ms" >= "created_at_ms"
  )
)
    `,
    `
CREATE TABLE "QingLong3TaskDefinitionRevisions" (
  "project_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "mutation_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "kind" TEXT NOT NULL,
  "spec_json" TEXT NOT NULL,
  "labels_json" TEXT NOT NULL,
  "enabled" INTEGER NOT NULL,
  "content_digest" TEXT NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  PRIMARY KEY ("project_id", "task_id", "revision"),
  FOREIGN KEY ("project_id", "task_id")
    REFERENCES "QingLong3TaskDefinitions" ("project_id", "task_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_task_definition_revisions_revision_check CHECK (
    "revision" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_task_definition_revisions_mutation_check CHECK (
    length("mutation_id") = 36
    AND substr("mutation_id", 9, 1) = '-'
    AND substr("mutation_id", 14, 1) = '-'
    AND substr("mutation_id", 19, 1) = '-'
    AND substr("mutation_id", 24, 1) = '-'
    AND replace("mutation_id", '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_task_definition_revisions_name_check CHECK (
    length("name") BETWEEN 1 AND 255
    AND ("description" IS NULL OR length("description") BETWEEN 1 AND 4096)
  ),
  CONSTRAINT ql3_task_definition_revisions_kind_check CHECK (
    "kind" IN ('script','command','workflow','agent','tool')
  ),
  CONSTRAINT ql3_task_definition_revisions_spec_check CHECK (
    json_valid("spec_json")
    AND json_type("spec_json") = 'object'
    AND length("spec_json") BETWEEN 1 AND 65536
  ),
  CONSTRAINT ql3_task_definition_revisions_labels_check CHECK (
    json_valid("labels_json")
    AND json_type("labels_json") = 'object'
    AND length("labels_json") BETWEEN 2 AND 16384
  ),
  CONSTRAINT ql3_task_definition_revisions_enabled_check CHECK (
    "enabled" IN (0, 1)
  ),
  CONSTRAINT ql3_task_definition_revisions_digest_check CHECK (
    length("content_digest") = 64
    AND "content_digest" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_task_definition_revisions_created_check CHECK (
    "created_at_ms" >= 0
  )
)
    `,
    `
CREATE UNIQUE INDEX "ql3_task_definition_revisions_mutation_uidx"
ON "QingLong3TaskDefinitionRevisions" ("mutation_id")
    `,
    `
CREATE INDEX "ql3_task_definition_revisions_project_kind_idx"
ON "QingLong3TaskDefinitionRevisions" (
  "project_id", "kind", "enabled", "task_id", "revision"
)
    `,
  ],
});
