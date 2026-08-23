import { defineLocalSqliteMigration } from './sqlMigration';

export const local0101LegacyAdoptionProvenanceMigration =
  defineLocalSqliteMigration({
    id: '0101-legacy-adoption-provenance',
    statements: [
      `
CREATE UNIQUE INDEX "ql3_legacy_adoptions_mutation_project_uidx"
ON "QingLong3LegacyAdoptions" ("mutation_id", "project_id")
      `,
      `
CREATE TABLE "QingLong3LegacyAdoptionTasks" (
  "adoption_mutation_id" TEXT NOT NULL,
  "row_ordinal" INTEGER NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_digest" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "task_revision" INTEGER NOT NULL,
  "task_mutation_id" TEXT NOT NULL,
  "task_content_digest" TEXT NOT NULL,
  "trigger_count" INTEGER NOT NULL,
  "item_digest" TEXT NOT NULL,
  PRIMARY KEY ("adoption_mutation_id", "row_ordinal"),
  CONSTRAINT ql3_legacy_adoption_task_parent_fk
    FOREIGN KEY ("adoption_mutation_id", "project_id")
    REFERENCES "QingLong3LegacyAdoptions" ("mutation_id", "project_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ql3_legacy_adoption_task_revision_fk
    FOREIGN KEY ("project_id", "task_id", "task_revision")
    REFERENCES "QingLong3TaskDefinitionRevisions" (
      "project_id", "task_id", "revision"
    )
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_legacy_adoption_task_mutation_fk
    FOREIGN KEY ("task_mutation_id")
    REFERENCES "QingLong3TaskDefinitionRevisions" ("mutation_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_legacy_adoption_task_identity_check CHECK (
    "row_ordinal" BETWEEN 1 AND 100000 AND
    length("project_id") BETWEEN 1 AND 128 AND
    length("task_id") BETWEEN 1 AND 128 AND
    "task_revision" = 1 AND
    length("task_mutation_id") = 36 AND
    replace("task_mutation_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND
    "trigger_count" BETWEEN 0 AND 500000
  ),
  CONSTRAINT ql3_legacy_adoption_task_digest_check CHECK (
    length("source_digest") = 64 AND
    "source_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("task_content_digest") = 64 AND
    "task_content_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("item_digest") = 64 AND
    "item_digest" NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_legacy_adoption_tasks_project_task_uidx"
ON "QingLong3LegacyAdoptionTasks" ("project_id", "task_id")
      `,
      `
CREATE UNIQUE INDEX "ql3_legacy_adoption_tasks_mutation_uidx"
ON "QingLong3LegacyAdoptionTasks" ("task_mutation_id")
      `,
      `
CREATE UNIQUE INDEX "ql3_legacy_adoption_tasks_item_uidx"
ON "QingLong3LegacyAdoptionTasks" ("item_digest")
      `,
      `
CREATE UNIQUE INDEX "ql3_legacy_adoption_tasks_identity_uidx"
ON "QingLong3LegacyAdoptionTasks" (
  "adoption_mutation_id", "row_ordinal", "project_id", "task_id",
  "task_revision"
)
      `,
      `
CREATE TABLE "QingLong3LegacyAdoptionTriggers" (
  "adoption_mutation_id" TEXT NOT NULL,
  "row_ordinal" INTEGER NOT NULL,
  "trigger_ordinal" INTEGER NOT NULL,
  "project_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "task_revision" INTEGER NOT NULL,
  "trigger_id" TEXT NOT NULL,
  "trigger_revision" INTEGER NOT NULL,
  "trigger_mutation_id" TEXT NOT NULL,
  "trigger_content_digest" TEXT NOT NULL,
  "item_digest" TEXT NOT NULL,
  PRIMARY KEY (
    "adoption_mutation_id", "row_ordinal", "trigger_ordinal"
  ),
  CONSTRAINT ql3_legacy_adoption_trigger_parent_fk
    FOREIGN KEY (
      "adoption_mutation_id", "row_ordinal", "project_id", "task_id",
      "task_revision"
    )
    REFERENCES "QingLong3LegacyAdoptionTasks" (
      "adoption_mutation_id", "row_ordinal", "project_id", "task_id",
      "task_revision"
    )
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_legacy_adoption_trigger_revision_fk
    FOREIGN KEY ("project_id", "trigger_id", "trigger_revision")
    REFERENCES "QingLong3TriggerRevisions" (
      "project_id", "trigger_id", "revision"
    )
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_legacy_adoption_trigger_mutation_fk
    FOREIGN KEY ("trigger_mutation_id")
    REFERENCES "QingLong3TriggerRevisions" ("mutation_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_legacy_adoption_trigger_identity_check CHECK (
    "row_ordinal" BETWEEN 1 AND 100000 AND
    "trigger_ordinal" BETWEEN 1 AND 500000 AND
    length("project_id") BETWEEN 1 AND 128 AND
    length("task_id") BETWEEN 1 AND 128 AND
    "task_revision" = 1 AND
    length("trigger_id") BETWEEN 1 AND 128 AND
    "trigger_revision" = 1 AND
    length("trigger_mutation_id") = 36 AND
    replace("trigger_mutation_id", '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_legacy_adoption_trigger_digest_check CHECK (
    length("trigger_content_digest") = 64 AND
    "trigger_content_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("item_digest") = 64 AND
    "item_digest" NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_legacy_adoption_triggers_project_trigger_uidx"
ON "QingLong3LegacyAdoptionTriggers" ("project_id", "trigger_id")
      `,
      `
CREATE UNIQUE INDEX "ql3_legacy_adoption_triggers_mutation_uidx"
ON "QingLong3LegacyAdoptionTriggers" ("trigger_mutation_id")
      `,
      `
CREATE UNIQUE INDEX "ql3_legacy_adoption_triggers_item_uidx"
ON "QingLong3LegacyAdoptionTriggers" ("item_digest")
      `,
    ],
  });
