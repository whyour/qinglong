import { defineLocalSqliteMigration } from './sqlMigration';

export const local0075SecurityAuditCompactionsMigration =
  defineLocalSqliteMigration({
    id: '0075-security-audit-compactions',
    statements: [
      `
CREATE TABLE "QingLong3SecurityAuditCompactions" (
  "mutation_id" TEXT PRIMARY KEY NOT NULL,
  "request_id" TEXT NOT NULL,
  "authority_project_id" TEXT NOT NULL,
  "retention_ms" INTEGER NOT NULL,
  "eligible_before_ms" INTEGER NOT NULL,
  "batch_limit" INTEGER NOT NULL,
  "deleted_count" INTEGER NOT NULL,
  "deleted_payload_bytes" INTEGER NOT NULL,
  "first_occurred_at_ms" INTEGER,
  "first_event_id" TEXT,
  "last_occurred_at_ms" INTEGER,
  "last_event_id" TEXT,
  "records_digest" TEXT NOT NULL,
  "audit_event_id" TEXT NOT NULL UNIQUE,
  "created_at_ms" INTEGER NOT NULL,
  FOREIGN KEY ("authority_project_id")
    REFERENCES "QingLong3Projects" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_audit_compaction_mutation_check CHECK (
    length("mutation_id") = 36
    AND substr("mutation_id", 9, 1) = '-'
    AND substr("mutation_id", 14, 1) = '-'
    AND substr("mutation_id", 19, 1) = '-'
    AND substr("mutation_id", 24, 1) = '-'
    AND replace("mutation_id", '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_audit_compaction_request_check CHECK (
    length("request_id") BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_audit_compaction_authority_check CHECK (
    length("authority_project_id") BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_audit_compaction_policy_check CHECK (
    "retention_ms" BETWEEN 2592000000 AND 315360000000
    AND "eligible_before_ms" >= 0
    AND "eligible_before_ms" + "retention_ms" <= "created_at_ms"
    AND "batch_limit" BETWEEN 1 AND 512
  ),
  CONSTRAINT ql3_audit_compaction_result_check CHECK (
    "deleted_count" BETWEEN 0 AND "batch_limit"
    AND "deleted_payload_bytes" BETWEEN 0 AND 16777216
    AND length("records_digest") = 64
    AND "records_digest" NOT GLOB '*[^0-9a-f]*'
    AND (
      ("deleted_count" = 0
        AND "deleted_payload_bytes" = 0
        AND "first_occurred_at_ms" IS NULL
        AND "first_event_id" IS NULL
        AND "last_occurred_at_ms" IS NULL
        AND "last_event_id" IS NULL)
      OR ("deleted_count" > 0
        AND "deleted_payload_bytes" > 0
        AND "first_occurred_at_ms" >= 0
        AND "last_occurred_at_ms" >= "first_occurred_at_ms"
        AND length("first_event_id") = 36
        AND length("last_event_id") = 36)
    )
  ),
  CONSTRAINT ql3_audit_compaction_audit_check CHECK (
    "audit_event_id" = "mutation_id"
  ),
  CONSTRAINT ql3_audit_compaction_time_check CHECK (
    "created_at_ms" >= 2592000000
  )
)
      `,
      `
CREATE INDEX "ql3_audit_compaction_authority_time_idx"
ON "QingLong3SecurityAuditCompactions" (
  "authority_project_id", "created_at_ms" DESC, "mutation_id" DESC
)
      `,
    ],
  });
