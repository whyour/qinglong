import { defineLocalSqliteMigration } from './sqlMigration';

export const local0009LocalProjectPolicyAuditMigration =
  defineLocalSqliteMigration({
    id: '0009-local-project-policy-audit',
    statements: [
      `
CREATE TABLE "QingLong3Projects" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  "updated_at_ms" INTEGER NOT NULL,
  CONSTRAINT ql3_local_projects_id_check CHECK (
    length("id") BETWEEN 1 AND 128
    AND "id" NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*'
  ),
  CONSTRAINT ql3_local_projects_name_check CHECK (
    length("name") BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_local_projects_slug_check CHECK (
    length("slug") BETWEEN 1 AND 128
    AND "slug" = lower("slug")
    AND "slug" NOT GLOB '*[^a-z0-9-]*'
    AND substr("slug", 1, 1) NOT GLOB '[^a-z0-9]'
    AND substr("slug", -1, 1) NOT GLOB '[^a-z0-9]'
  ),
  CONSTRAINT ql3_local_projects_status_check CHECK (
    "status" IN ('active', 'archived')
  ),
  CONSTRAINT ql3_local_projects_version_check CHECK (
    "version" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_local_projects_time_check CHECK (
    "created_at_ms" >= 0 AND "updated_at_ms" >= "created_at_ms"
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_local_projects_slug_uidx"
ON "QingLong3Projects" ("slug")
      `,
      `
INSERT INTO "QingLong3Projects" (
  "id", "name", "slug", "status", "version", "created_at_ms", "updated_at_ms"
) VALUES ('default', 'Default', 'default', 'active', 1, 0, 0)
      `,
      `
CREATE TABLE "QingLong3ProjectRoleBindings" (
  "project_id" TEXT NOT NULL,
  "subject_type" TEXT NOT NULL,
  "subject_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "role" TEXT,
  "mutation_id" TEXT NOT NULL,
  "changed_by_type" TEXT NOT NULL,
  "changed_by_id" TEXT NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  PRIMARY KEY ("project_id", "subject_type", "subject_id", "version"),
  FOREIGN KEY ("project_id") REFERENCES "QingLong3Projects" ("id") ON DELETE RESTRICT,
  CONSTRAINT ql3_local_bindings_subject_type_check CHECK (
    "subject_type" IN ('user','api_app','mcp_client','agent','system','worker')
  ),
  CONSTRAINT ql3_local_bindings_subject_id_check CHECK (
    length("subject_id") BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_local_bindings_version_check CHECK (
    "version" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_local_bindings_state_role_check CHECK (
    ("state" = 'active' AND "role" IN ('owner','admin','operator','viewer'))
    OR ("state" = 'revoked' AND "role" IS NULL)
  ),
  CONSTRAINT ql3_local_bindings_mutation_check CHECK (
    length("mutation_id") BETWEEN 1 AND 64
  ),
  CONSTRAINT ql3_local_bindings_changed_by_type_check CHECK (
    "changed_by_type" IN ('user','api_app','mcp_client','agent','system','worker')
  ),
  CONSTRAINT ql3_local_bindings_changed_by_id_check CHECK (
    length("changed_by_id") BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_local_bindings_created_check CHECK ("created_at_ms" >= 0)
)
      `,
      `
CREATE UNIQUE INDEX "ql3_local_bindings_mutation_uidx"
ON "QingLong3ProjectRoleBindings" (
  "project_id", "subject_type", "subject_id", "mutation_id"
)
      `,
      `
CREATE INDEX "ql3_local_bindings_current_idx"
ON "QingLong3ProjectRoleBindings" (
  "project_id", "subject_type", "subject_id", "version" DESC
)
      `,
      `
CREATE INDEX "ql3_local_bindings_project_idx"
ON "QingLong3ProjectRoleBindings" ("project_id", "version" DESC)
      `,
      `
CREATE TABLE "QingLong3SecurityAuditEvents" (
  "event_id" TEXT PRIMARY KEY NOT NULL,
  "request_id" TEXT NOT NULL,
  "operation_id" TEXT NOT NULL,
  "project_id" TEXT,
  "subject_type" TEXT,
  "subject_id" TEXT,
  "authentication_id" TEXT,
  "outcome" TEXT NOT NULL,
  "reasons_json" TEXT NOT NULL,
  "fence_project_version" INTEGER,
  "fence_binding_version" INTEGER,
  "occurred_at_ms" INTEGER NOT NULL,
  FOREIGN KEY ("project_id") REFERENCES "QingLong3Projects" ("id") ON DELETE RESTRICT,
  CONSTRAINT ql3_local_audit_event_check CHECK (length("event_id") = 36),
  CONSTRAINT ql3_local_audit_request_check CHECK (length("request_id") BETWEEN 1 AND 128),
  CONSTRAINT ql3_local_audit_operation_check CHECK (length("operation_id") BETWEEN 1 AND 128),
  CONSTRAINT ql3_local_audit_subject_check CHECK (
    ("subject_type" IS NULL AND "subject_id" IS NULL AND "authentication_id" IS NULL)
    OR (
      "subject_type" IN ('user','api_app','mcp_client','agent','system','worker')
      AND length("subject_id") BETWEEN 1 AND 255
      AND length("authentication_id") BETWEEN 1 AND 128
    )
  ),
  CONSTRAINT ql3_local_audit_outcome_check CHECK (
    "outcome" IN (
      'authentication_rejected','authentication_unavailable',
      'authorization_unavailable','denied','approval_required','allowed'
    )
  ),
  CONSTRAINT ql3_local_audit_reasons_check CHECK (
    json_valid("reasons_json")
    AND json_type("reasons_json") = 'array'
    AND json_array_length("reasons_json") BETWEEN 1 AND 8
    AND length("reasons_json") <= 2048
  ),
  CONSTRAINT ql3_local_audit_fence_check CHECK (
    ("fence_project_version" IS NULL AND "fence_binding_version" IS NULL)
    OR (
      "fence_project_version" BETWEEN 1 AND 2147483647
      AND ("fence_binding_version" IS NULL OR "fence_binding_version" BETWEEN 1 AND 2147483647)
    )
  ),
  CONSTRAINT ql3_local_audit_time_check CHECK ("occurred_at_ms" >= 0)
)
      `,
      `
CREATE INDEX "ql3_local_audit_project_time_idx"
ON "QingLong3SecurityAuditEvents" (
  "project_id", "occurred_at_ms" DESC, "event_id" DESC
)
      `,
      `
CREATE INDEX "ql3_local_audit_subject_time_idx"
ON "QingLong3SecurityAuditEvents" (
  "subject_type", "subject_id", "occurred_at_ms" DESC, "event_id" DESC
)
      `,
    ],
  });
