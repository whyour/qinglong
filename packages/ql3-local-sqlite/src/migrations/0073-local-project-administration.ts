import { defineLocalSqliteMigration } from './sqlMigration';

export const local0073LocalProjectAdministrationMigration =
  defineLocalSqliteMigration({
    id: '0073-local-project-administration',
    statements: [
      `
CREATE TABLE "QingLong3ProjectAdministrationMutations" (
  "mutation_id" TEXT PRIMARY KEY NOT NULL,
  "operation" TEXT NOT NULL,
  "authority_project_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "project_name" TEXT NOT NULL,
  "project_slug" TEXT NOT NULL,
  "project_status" TEXT NOT NULL,
  "project_version" INTEGER NOT NULL,
  "expected_previous_version" INTEGER NOT NULL,
  "changed_by_type" TEXT NOT NULL,
  "changed_by_id" TEXT NOT NULL,
  "initial_owner_binding_version" INTEGER,
  "audit_event_id" TEXT NOT NULL UNIQUE,
  "project_created_at_ms" INTEGER NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  FOREIGN KEY ("authority_project_id")
    REFERENCES "QingLong3Projects" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("project_id")
    REFERENCES "QingLong3Projects" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_project_admin_mutation_id_check CHECK (
    length("mutation_id") = 36
    AND substr("mutation_id", 9, 1) = '-'
    AND substr("mutation_id", 14, 1) = '-'
    AND substr("mutation_id", 19, 1) = '-'
    AND substr("mutation_id", 24, 1) = '-'
    AND replace("mutation_id", '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_project_admin_operation_check CHECK (
    "operation" IN ('create','archive','restore')
  ),
  CONSTRAINT ql3_project_admin_identity_check CHECK (
    length("authority_project_id") BETWEEN 1 AND 128
    AND length("project_id") BETWEEN 1 AND 128
    AND length("project_name") BETWEEN 1 AND 255
    AND length("project_slug") BETWEEN 1 AND 128
    AND "project_slug" = lower("project_slug")
    AND "project_slug" NOT GLOB '*[^a-z0-9-]*'
    AND substr("project_slug", 1, 1) NOT GLOB '[^a-z0-9]'
    AND substr("project_slug", -1, 1) NOT GLOB '[^a-z0-9]'
  ),
  CONSTRAINT ql3_project_admin_transition_check CHECK (
    "project_version" = "expected_previous_version" + 1
    AND "project_version" BETWEEN 1 AND 2147483647
    AND "expected_previous_version" BETWEEN 0 AND 2147483646
    AND (
      ("operation" = 'create'
        AND "expected_previous_version" = 0
        AND "project_status" = 'active'
        AND "initial_owner_binding_version" = 1)
      OR ("operation" = 'archive'
        AND "expected_previous_version" > 0
        AND "project_status" = 'archived'
        AND "initial_owner_binding_version" IS NULL)
      OR ("operation" = 'restore'
        AND "expected_previous_version" > 0
        AND "project_status" = 'active'
        AND "initial_owner_binding_version" IS NULL)
    )
  ),
  CONSTRAINT ql3_project_admin_actor_check CHECK (
    "changed_by_type" = 'user'
    AND length("changed_by_id") BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_project_admin_audit_check CHECK (
    "audit_event_id" = "mutation_id"
  ),
  CONSTRAINT ql3_project_admin_time_check CHECK (
    "project_created_at_ms" >= 0
    AND "created_at_ms" >= "project_created_at_ms"
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_project_admin_project_version_uidx"
ON "QingLong3ProjectAdministrationMutations" (
  "project_id", "project_version"
)
      `,
      `
CREATE INDEX "ql3_project_admin_authority_time_idx"
ON "QingLong3ProjectAdministrationMutations" (
  "authority_project_id", "created_at_ms" DESC, "mutation_id" DESC
)
      `,
    ],
  });
