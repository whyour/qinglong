import { defineLocalSqliteMigration } from './sqlMigration';

export const local0021LocalOwnerCredentialRecoveryMigration =
  defineLocalSqliteMigration({
    id: '0021-local-owner-credential-recovery',
    statements: [
      `
CREATE TABLE "QingLong3LocalOwnerCredentialRecoveries" (
  "issue_mutation_id" TEXT PRIMARY KEY NOT NULL,
  "issue_request_id" TEXT NOT NULL,
  "subject_type" TEXT NOT NULL,
  "subject_id" TEXT NOT NULL,
  "previous_credential_id" TEXT NOT NULL,
  "previous_credential_version" INTEGER NOT NULL,
  "replacement_credential_id" TEXT NOT NULL,
  "replacement_credential_version" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "issued_at_ms" INTEGER NOT NULL,
  "issue_audit_event_id" TEXT NOT NULL,
  "delivery_digest" TEXT,
  "acknowledged_at_ms" INTEGER,
  "complete_mutation_id" TEXT,
  "complete_request_id" TEXT,
  "revoked_credential_version" INTEGER,
  "completed_at_ms" INTEGER,
  "complete_audit_event_id" TEXT,
  FOREIGN KEY ("subject_type", "subject_id")
    REFERENCES "QingLong3IdentitySubjects" ("subject_type", "subject_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("previous_credential_id", "previous_credential_version")
    REFERENCES "QingLong3ApiCredentials" ("credential_id", "version")
    ON DELETE RESTRICT,
  FOREIGN KEY ("replacement_credential_id", "replacement_credential_version")
    REFERENCES "QingLong3ApiCredentials" ("credential_id", "version")
    ON DELETE RESTRICT,
  FOREIGN KEY ("previous_credential_id", "revoked_credential_version")
    REFERENCES "QingLong3ApiCredentials" ("credential_id", "version")
    ON DELETE RESTRICT,
  FOREIGN KEY ("issue_audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("complete_audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_local_owner_recovery_mutation_check CHECK (
    length("issue_mutation_id") = 36
    AND "issue_audit_event_id" = "issue_mutation_id"
    AND ("complete_mutation_id" IS NULL OR (
      length("complete_mutation_id") = 36
      AND "complete_audit_event_id" = "complete_mutation_id"
      AND "complete_mutation_id" <> "issue_mutation_id"
    ))
  ),
  CONSTRAINT ql3_local_owner_recovery_request_check CHECK (
    length("issue_request_id") BETWEEN 1 AND 128
    AND ("complete_request_id" IS NULL
      OR length("complete_request_id") BETWEEN 1 AND 128)
  ),
  CONSTRAINT ql3_local_owner_recovery_identity_check CHECK (
    "subject_type" = 'user'
    AND length("subject_id") = 26
    AND "subject_id" GLOB 'usr_*'
    AND "subject_id" NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  CONSTRAINT ql3_local_owner_recovery_credential_check CHECK (
    length("previous_credential_id") BETWEEN 1 AND 64
    AND "previous_credential_id" NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND "previous_credential_version" BETWEEN 1 AND 2147483646
    AND length("replacement_credential_id") BETWEEN 1 AND 64
    AND "replacement_credential_id" NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND "replacement_credential_id" <> "previous_credential_id"
    AND "replacement_credential_version" = 1
    AND ("revoked_credential_version" IS NULL
      OR "revoked_credential_version" = "previous_credential_version" + 1)
  ),
  CONSTRAINT ql3_local_owner_recovery_digest_check CHECK (
    "delivery_digest" IS NULL OR (
      length("delivery_digest") = 64
      AND "delivery_digest" NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CONSTRAINT ql3_local_owner_recovery_time_check CHECK (
    "issued_at_ms" >= 0
    AND ("acknowledged_at_ms" IS NULL
      OR "acknowledged_at_ms" >= "issued_at_ms")
    AND ("completed_at_ms" IS NULL
      OR "completed_at_ms" >= "acknowledged_at_ms")
  ),
  CONSTRAINT ql3_local_owner_recovery_shape_check CHECK (
    ("state" = 'issued'
      AND "delivery_digest" IS NULL
      AND "acknowledged_at_ms" IS NULL
      AND "complete_mutation_id" IS NULL
      AND "complete_request_id" IS NULL
      AND "revoked_credential_version" IS NULL
      AND "completed_at_ms" IS NULL
      AND "complete_audit_event_id" IS NULL)
    OR ("state" = 'acknowledged'
      AND "delivery_digest" IS NOT NULL
      AND "acknowledged_at_ms" IS NOT NULL
      AND "complete_mutation_id" IS NULL
      AND "complete_request_id" IS NULL
      AND "revoked_credential_version" IS NULL
      AND "completed_at_ms" IS NULL
      AND "complete_audit_event_id" IS NULL)
    OR ("state" = 'completed'
      AND "delivery_digest" IS NOT NULL
      AND "acknowledged_at_ms" IS NOT NULL
      AND "complete_mutation_id" IS NOT NULL
      AND "complete_request_id" IS NOT NULL
      AND "revoked_credential_version" IS NOT NULL
      AND "completed_at_ms" IS NOT NULL
      AND "complete_audit_event_id" IS NOT NULL)
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_local_owner_recovery_open_subject_uidx"
ON "QingLong3LocalOwnerCredentialRecoveries" ("subject_id")
WHERE "state" <> 'completed'
      `,
      `
CREATE UNIQUE INDEX "ql3_local_owner_recovery_replacement_uidx"
ON "QingLong3LocalOwnerCredentialRecoveries" (
  "replacement_credential_id", "replacement_credential_version"
)
      `,
      `
CREATE UNIQUE INDEX "ql3_local_owner_recovery_complete_mutation_uidx"
ON "QingLong3LocalOwnerCredentialRecoveries" ("complete_mutation_id")
WHERE "complete_mutation_id" IS NOT NULL
      `,
      `
CREATE INDEX "ql3_local_owner_recovery_previous_idx"
ON "QingLong3LocalOwnerCredentialRecoveries" (
  "previous_credential_id", "previous_credential_version", "state"
)
      `,
    ],
  });
