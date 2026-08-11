import { defineLocalSqliteMigration } from './sqlMigration';

export const local0023LocalOwnerPepperMaterialGcMigration =
  defineLocalSqliteMigration({
    id: '0023-local-owner-pepper-material-gc',
    statements: [
      `
CREATE TABLE "QingLong3LocalOwnerPepperMaterialGc" (
  "prepare_mutation_id" TEXT PRIMARY KEY NOT NULL,
  "prepare_request_id" TEXT NOT NULL,
  "pepper_key_id" TEXT NOT NULL,
  "material_digest" TEXT NOT NULL,
  "backup_material_digest" TEXT NOT NULL,
  "active_pepper_key_id" TEXT NOT NULL,
  "active_generation" INTEGER NOT NULL,
  "active_material_digest" TEXT NOT NULL,
  "retention_policy_version" INTEGER NOT NULL,
  "acknowledgement_retention_ms" INTEGER NOT NULL,
  "audit_retention_ms" INTEGER NOT NULL,
  "backup_retention_ms" INTEGER NOT NULL,
  "retention_policy_digest" TEXT NOT NULL,
  "references_inspected_at_ms" INTEGER NOT NULL,
  "retention_eligible_at_ms" INTEGER NOT NULL,
  "prepared_at_ms" INTEGER NOT NULL,
  "prepare_audit_event_id" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "complete_mutation_id" TEXT,
  "complete_request_id" TEXT,
  "destruction_proof_digest" TEXT,
  "completed_at_ms" INTEGER,
  "complete_audit_event_id" TEXT,
  FOREIGN KEY ("pepper_key_id")
    REFERENCES "QingLong3LocalOwnerPepperKeys" ("pepper_key_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("active_pepper_key_id")
    REFERENCES "QingLong3LocalOwnerPepperKeys" ("pepper_key_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("active_generation")
    REFERENCES "QingLong3LocalOwnerPepperActivations" ("generation")
    ON DELETE RESTRICT,
  FOREIGN KEY ("prepare_audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("complete_audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_local_owner_pepper_gc_mutation_check CHECK (
    length("prepare_mutation_id") = 36
    AND "prepare_audit_event_id" = "prepare_mutation_id"
    AND ("complete_mutation_id" IS NULL OR (
      length("complete_mutation_id") = 36
      AND "complete_mutation_id" <> "prepare_mutation_id"
      AND "complete_audit_event_id" = "complete_mutation_id"
    ))
  ),
  CONSTRAINT ql3_local_owner_pepper_gc_request_check CHECK (
    length("prepare_request_id") BETWEEN 1 AND 128
    AND ("complete_request_id" IS NULL
      OR length("complete_request_id") BETWEEN 1 AND 128)
  ),
  CONSTRAINT ql3_local_owner_pepper_gc_key_check CHECK (
    length("pepper_key_id") BETWEEN 1 AND 64
    AND "pepper_key_id" NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length("active_pepper_key_id") BETWEEN 1 AND 64
    AND "active_pepper_key_id" NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND "pepper_key_id" <> "active_pepper_key_id"
    AND "active_generation" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_local_owner_pepper_gc_digest_check CHECK (
    length("material_digest") = 64
    AND "material_digest" NOT GLOB '*[^0-9a-f]*'
    AND length("backup_material_digest") = 64
    AND "backup_material_digest" NOT GLOB '*[^0-9a-f]*'
    AND length("active_material_digest") = 64
    AND "active_material_digest" NOT GLOB '*[^0-9a-f]*'
    AND length("retention_policy_digest") = 64
    AND "retention_policy_digest" NOT GLOB '*[^0-9a-f]*'
    AND ("destruction_proof_digest" IS NULL OR (
      length("destruction_proof_digest") = 64
      AND "destruction_proof_digest" NOT GLOB '*[^0-9a-f]*'
    ))
  ),
  CONSTRAINT ql3_local_owner_pepper_gc_retention_check CHECK (
    "retention_policy_version" = 1
    AND "acknowledgement_retention_ms" BETWEEN 604800000 AND 315360000000
    AND "audit_retention_ms" BETWEEN 2592000000 AND 315360000000
    AND "backup_retention_ms" BETWEEN 2592000000 AND 315360000000
  ),
  CONSTRAINT ql3_local_owner_pepper_gc_time_check CHECK (
    "references_inspected_at_ms" = "prepared_at_ms"
    AND "retention_eligible_at_ms" <= "prepared_at_ms"
    AND "prepared_at_ms" >= 0
    AND ("completed_at_ms" IS NULL
      OR "completed_at_ms" >= "prepared_at_ms")
  ),
  CONSTRAINT ql3_local_owner_pepper_gc_shape_check CHECK (
    ("state" = 'prepared'
      AND "complete_mutation_id" IS NULL
      AND "complete_request_id" IS NULL
      AND "destruction_proof_digest" IS NULL
      AND "completed_at_ms" IS NULL
      AND "complete_audit_event_id" IS NULL)
    OR ("state" = 'completed'
      AND "complete_mutation_id" IS NOT NULL
      AND "complete_request_id" IS NOT NULL
      AND "destruction_proof_digest" IS NOT NULL
      AND "completed_at_ms" IS NOT NULL
      AND "complete_audit_event_id" IS NOT NULL)
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_local_owner_pepper_gc_key_uidx"
ON "QingLong3LocalOwnerPepperMaterialGc" ("pepper_key_id")
      `,
      `
CREATE UNIQUE INDEX "ql3_local_owner_pepper_gc_open_uidx"
ON "QingLong3LocalOwnerPepperMaterialGc" ("state")
WHERE "state" = 'prepared'
      `,
      `
CREATE UNIQUE INDEX "ql3_local_owner_pepper_gc_complete_mutation_uidx"
ON "QingLong3LocalOwnerPepperMaterialGc" ("complete_mutation_id")
WHERE "complete_mutation_id" IS NOT NULL
      `,
      `
CREATE INDEX "ql3_local_owner_pepper_gc_state_idx"
ON "QingLong3LocalOwnerPepperMaterialGc" (
  "state", "retention_eligible_at_ms", "pepper_key_id"
)
      `,
    ],
  });
