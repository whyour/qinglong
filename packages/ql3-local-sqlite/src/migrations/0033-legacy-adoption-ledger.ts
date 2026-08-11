import { defineLocalSqliteMigration } from './sqlMigration';

export const local0033LegacyAdoptionLedgerMigration =
  defineLocalSqliteMigration({
    id: '0033-legacy-adoption-ledger',
    statements: [
      `
CREATE TABLE "QingLong3LegacyAdoptions" (
  "mutation_id" TEXT PRIMARY KEY,
  "decision_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "profile" TEXT NOT NULL,
  "plan_digest" TEXT NOT NULL,
  "inventory_digest" TEXT NOT NULL,
  "decision_digest" TEXT NOT NULL,
  "receipt_digest" TEXT NOT NULL,
  "authorization_file_digest" TEXT NOT NULL,
  "publication_digest" TEXT NOT NULL,
  "row_count" INTEGER NOT NULL,
  "adopted_task_count" INTEGER NOT NULL,
  "adopted_trigger_count" INTEGER NOT NULL,
  "skipped_count" INTEGER NOT NULL,
  "audit_event_id" TEXT NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  FOREIGN KEY ("project_id")
    REFERENCES "QingLong3Projects" ("id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_legacy_adoptions_mutation_check CHECK (
    length("mutation_id") = 36
    AND "audit_event_id" = "mutation_id"
  ),
  CONSTRAINT ql3_legacy_adoptions_decision_check CHECK (
    length("decision_id") = 36
    AND substr("decision_id", 15, 1) = '7'
    AND replace("decision_id", '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_legacy_adoptions_profile_check CHECK (
    "profile" IN ('edge', 'standalone')
  ),
  CONSTRAINT ql3_legacy_adoptions_digest_check CHECK (
    length("plan_digest") = 64
    AND "plan_digest" NOT GLOB '*[^0-9a-f]*'
    AND length("inventory_digest") = 64
    AND "inventory_digest" NOT GLOB '*[^0-9a-f]*'
    AND length("decision_digest") = 64
    AND "decision_digest" NOT GLOB '*[^0-9a-f]*'
    AND length("receipt_digest") = 64
    AND "receipt_digest" NOT GLOB '*[^0-9a-f]*'
    AND length("authorization_file_digest") = 64
    AND "authorization_file_digest" NOT GLOB '*[^0-9a-f]*'
    AND length("publication_digest") = 64
    AND "publication_digest" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_legacy_adoptions_count_check CHECK (
    "row_count" BETWEEN 0 AND 100000
    AND "adopted_task_count" BETWEEN 0 AND "row_count"
    AND "skipped_count" BETWEEN 0 AND "row_count"
    AND "adopted_task_count" + "skipped_count" = "row_count"
    AND "adopted_trigger_count" BETWEEN 0 AND 500000
  ),
  CONSTRAINT ql3_legacy_adoptions_created_check CHECK (
    "created_at_ms" >= 0
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_legacy_adoptions_decision_uidx"
ON "QingLong3LegacyAdoptions" ("decision_id")
      `,
      `
CREATE INDEX "ql3_legacy_adoptions_project_time_idx"
ON "QingLong3LegacyAdoptions" (
  "project_id", "created_at_ms" DESC, "mutation_id" DESC
)
      `,
    ],
  });
