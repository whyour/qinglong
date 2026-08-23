import { defineLocalSqliteMigration } from './sqlMigration';

export const local0103SecretConfigApplicationsMigration =
  defineLocalSqliteMigration({
    id: '0103-secret-config-applications',
    statements: [
      `
CREATE TABLE "QingLong3SecretConfigApplications" (
  "mutation_id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL,
  "profile" TEXT NOT NULL,
  "secret_config_plan_digest" TEXT NOT NULL,
  "decision_digest" TEXT NOT NULL,
  "candidate_set_digest" TEXT NOT NULL,
  "automation_adoption_set_digest" TEXT NOT NULL,
  "active_binding_count" INTEGER NOT NULL,
  "disabled_preservation_count" INTEGER NOT NULL,
  "task_count" INTEGER NOT NULL,
  "trigger_count" INTEGER NOT NULL,
  "publication_digest" TEXT NOT NULL,
  "audit_event_id" TEXT NOT NULL,
  "applied_at_ms" INTEGER NOT NULL,
  "receipt_digest" TEXT NOT NULL,
  "receipt_json" TEXT NOT NULL,
  CONSTRAINT ql3_secret_config_application_project_fk
    FOREIGN KEY ("project_id") REFERENCES "QingLong3Projects" ("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_secret_config_application_audit_fk
    FOREIGN KEY ("audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_secret_config_application_identity_check CHECK (
    length("mutation_id") = 36 AND
    replace("mutation_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND
    length("project_id") BETWEEN 1 AND 128 AND
    "profile" IN ('edge', 'standalone') AND
    "active_binding_count" BETWEEN 0 AND 256 AND
    "disabled_preservation_count" BETWEEN 0 AND 512 AND
    "task_count" BETWEEN 0 AND 100000 AND
    "trigger_count" BETWEEN 0 AND 500000 AND
    "applied_at_ms" >= 0
  ),
  CONSTRAINT ql3_secret_config_application_digest_check CHECK (
    length("secret_config_plan_digest") = 64 AND
    "secret_config_plan_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("decision_digest") = 64 AND
    "decision_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("candidate_set_digest") = 64 AND
    "candidate_set_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("automation_adoption_set_digest") = 64 AND
    "automation_adoption_set_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("publication_digest") = 64 AND
    "publication_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("receipt_digest") = 64 AND
    "receipt_digest" NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_secret_config_applications_plan_uidx"
ON "QingLong3SecretConfigApplications" ("secret_config_plan_digest")
      `,
      `
CREATE UNIQUE INDEX "ql3_secret_config_applications_decision_uidx"
ON "QingLong3SecretConfigApplications" ("decision_digest")
      `,
      `
CREATE UNIQUE INDEX "ql3_secret_config_applications_receipt_uidx"
ON "QingLong3SecretConfigApplications" ("receipt_digest")
      `,
      `
CREATE INDEX "ql3_secret_config_applications_project_time_idx"
ON "QingLong3SecretConfigApplications" ("project_id", "applied_at_ms")
      `,
      `
CREATE TABLE "QingLong3SecretConfigApplicationSecrets" (
  "application_mutation_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "project_id" TEXT NOT NULL,
  "disposition" TEXT NOT NULL,
  "candidate_digest" TEXT NOT NULL,
  "source_set_digest" TEXT NOT NULL,
  "environment_name" TEXT,
  "secret_name" TEXT NOT NULL,
  "secret_version" INTEGER NOT NULL,
  "secret_mutation_id" TEXT NOT NULL,
  "secret_ref" TEXT NOT NULL,
  "item_digest" TEXT NOT NULL,
  PRIMARY KEY ("application_mutation_id", "ordinal"),
  CONSTRAINT ql3_secret_config_secret_parent_fk
    FOREIGN KEY ("application_mutation_id")
    REFERENCES "QingLong3SecretConfigApplications" ("mutation_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ql3_secret_config_secret_envelope_fk
    FOREIGN KEY ("project_id", "secret_name", "secret_version")
    REFERENCES "QingLong3LocalSecretEnvelopes" (
      "project_id", "secret_name", "version"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_secret_config_secret_identity_check CHECK (
    "ordinal" BETWEEN 1 AND 768 AND
    "disposition" IN ('active_binding', 'disabled_preservation') AND
    (("disposition" = 'active_binding' AND "environment_name" IS NOT NULL) OR
     ("disposition" = 'disabled_preservation' AND "environment_name" IS NULL)) AND
    "secret_version" = 1 AND
    length("secret_mutation_id") = 36 AND
    replace("secret_mutation_id", '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_secret_config_secret_digest_check CHECK (
    length("candidate_digest") = 64 AND
    "candidate_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("source_set_digest") = 64 AND
    "source_set_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("item_digest") = 64 AND
    "item_digest" NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_secret_config_secrets_mutation_uidx"
ON "QingLong3SecretConfigApplicationSecrets" ("secret_mutation_id")
      `,
      `
CREATE UNIQUE INDEX "ql3_secret_config_secrets_candidate_uidx"
ON "QingLong3SecretConfigApplicationSecrets" ("candidate_digest")
      `,
      `
CREATE UNIQUE INDEX "ql3_secret_config_secrets_target_uidx"
ON "QingLong3SecretConfigApplicationSecrets" ("project_id", "secret_name")
      `,
      `
CREATE TABLE "QingLong3SecretConfigApplicationTasks" (
  "application_mutation_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "project_id" TEXT NOT NULL,
  "adoption_mutation_id" TEXT NOT NULL,
  "adoption_row_ordinal" INTEGER NOT NULL,
  "task_id" TEXT NOT NULL,
  "previous_revision" INTEGER NOT NULL,
  "previous_content_digest" TEXT NOT NULL,
  "task_revision" INTEGER NOT NULL,
  "task_mutation_id" TEXT NOT NULL,
  "task_content_digest" TEXT NOT NULL,
  "item_digest" TEXT NOT NULL,
  PRIMARY KEY ("application_mutation_id", "ordinal"),
  CONSTRAINT ql3_secret_config_task_parent_fk
    FOREIGN KEY ("application_mutation_id")
    REFERENCES "QingLong3SecretConfigApplications" ("mutation_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ql3_secret_config_task_adoption_fk
    FOREIGN KEY (
      "adoption_mutation_id", "adoption_row_ordinal", "project_id",
      "task_id", "previous_revision"
    ) REFERENCES "QingLong3LegacyAdoptionTasks" (
      "adoption_mutation_id", "row_ordinal", "project_id", "task_id",
      "task_revision"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_secret_config_task_revision_fk
    FOREIGN KEY ("project_id", "task_id", "task_revision")
    REFERENCES "QingLong3TaskDefinitionRevisions" (
      "project_id", "task_id", "revision"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_secret_config_task_identity_check CHECK (
    "ordinal" BETWEEN 1 AND 100000 AND
    "adoption_row_ordinal" BETWEEN 1 AND 100000 AND
    "previous_revision" = 1 AND
    "task_revision" = 2 AND
    length("task_mutation_id") = 36 AND
    replace("task_mutation_id", '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_secret_config_task_digest_check CHECK (
    length("previous_content_digest") = 64 AND
    "previous_content_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("task_content_digest") = 64 AND
    "task_content_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("item_digest") = 64 AND
    "item_digest" NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_secret_config_tasks_identity_uidx"
ON "QingLong3SecretConfigApplicationTasks" ("project_id", "task_id")
      `,
      `
CREATE UNIQUE INDEX "ql3_secret_config_tasks_mutation_uidx"
ON "QingLong3SecretConfigApplicationTasks" ("task_mutation_id")
      `,
      `
CREATE TABLE "QingLong3SecretConfigApplicationTriggers" (
  "application_mutation_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "project_id" TEXT NOT NULL,
  "adoption_mutation_id" TEXT NOT NULL,
  "adoption_row_ordinal" INTEGER NOT NULL,
  "adoption_trigger_ordinal" INTEGER NOT NULL,
  "task_id" TEXT NOT NULL,
  "task_revision" INTEGER NOT NULL,
  "trigger_id" TEXT NOT NULL,
  "previous_revision" INTEGER NOT NULL,
  "previous_content_digest" TEXT NOT NULL,
  "trigger_revision" INTEGER NOT NULL,
  "trigger_mutation_id" TEXT NOT NULL,
  "trigger_content_digest" TEXT NOT NULL,
  "item_digest" TEXT NOT NULL,
  PRIMARY KEY ("application_mutation_id", "ordinal"),
  CONSTRAINT ql3_secret_config_trigger_parent_fk
    FOREIGN KEY ("application_mutation_id")
    REFERENCES "QingLong3SecretConfigApplications" ("mutation_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ql3_secret_config_trigger_adoption_fk
    FOREIGN KEY (
      "adoption_mutation_id", "adoption_row_ordinal",
      "adoption_trigger_ordinal"
    ) REFERENCES "QingLong3LegacyAdoptionTriggers" (
      "adoption_mutation_id", "row_ordinal", "trigger_ordinal"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_secret_config_trigger_revision_fk
    FOREIGN KEY ("project_id", "trigger_id", "trigger_revision")
    REFERENCES "QingLong3TriggerRevisions" (
      "project_id", "trigger_id", "revision"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_secret_config_trigger_identity_check CHECK (
    "ordinal" BETWEEN 1 AND 500000 AND
    "adoption_row_ordinal" BETWEEN 1 AND 100000 AND
    "adoption_trigger_ordinal" BETWEEN 1 AND 500000 AND
    "task_revision" = 2 AND
    "previous_revision" = 1 AND
    "trigger_revision" = 2 AND
    length("trigger_mutation_id") = 36 AND
    replace("trigger_mutation_id", '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_secret_config_trigger_digest_check CHECK (
    length("previous_content_digest") = 64 AND
    "previous_content_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("trigger_content_digest") = 64 AND
    "trigger_content_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("item_digest") = 64 AND
    "item_digest" NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_secret_config_triggers_identity_uidx"
ON "QingLong3SecretConfigApplicationTriggers" ("project_id", "trigger_id")
      `,
      `
CREATE UNIQUE INDEX "ql3_secret_config_triggers_mutation_uidx"
ON "QingLong3SecretConfigApplicationTriggers" ("trigger_mutation_id")
      `,
    ],
  });
