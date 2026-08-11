import { defineLocalSqliteMigration } from './sqlMigration';

export const local0013LocalOwnerBootstrapMigration =
  defineLocalSqliteMigration({
    id: '0013-local-owner-bootstrap',
    statements: [
      `
CREATE TABLE "QingLong3LocalIdentityProvisionings" (
  "slot" INTEGER PRIMARY KEY NOT NULL,
  "mutation_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "subject_type" TEXT NOT NULL,
  "subject_id" TEXT NOT NULL,
  "credential_id" TEXT NOT NULL,
  "credential_version" INTEGER NOT NULL,
  "issuer_authentication_id" TEXT NOT NULL,
  "issuer_authenticated_at_ms" INTEGER NOT NULL,
  "issuer_expires_at_ms" INTEGER NOT NULL,
  "audit_event_id" TEXT NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  FOREIGN KEY ("subject_type", "subject_id")
    REFERENCES "QingLong3IdentitySubjects" ("subject_type", "subject_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("credential_id", "credential_version")
    REFERENCES "QingLong3ApiCredentials" ("credential_id", "version")
    ON DELETE RESTRICT,
  FOREIGN KEY ("audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_local_provisioning_singleton_check CHECK ("slot" = 1),
  CONSTRAINT ql3_local_provisioning_mutation_check CHECK (
    length("mutation_id") = 36
  ),
  CONSTRAINT ql3_local_provisioning_request_check CHECK (
    length("request_id") BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_local_provisioning_subject_check CHECK (
    "subject_type" = 'user' AND length("subject_id") BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_local_provisioning_credential_check CHECK (
    length("credential_id") BETWEEN 1 AND 64 AND "credential_version" = 1
  ),
  CONSTRAINT ql3_local_provisioning_issuer_check CHECK (
    length("issuer_authentication_id") BETWEEN 1 AND 128
    AND "issuer_authenticated_at_ms" <= "created_at_ms"
    AND "issuer_expires_at_ms" > "created_at_ms"
  ),
  CONSTRAINT ql3_local_provisioning_audit_check CHECK (
    "audit_event_id" = "mutation_id"
  ),
  CONSTRAINT ql3_local_provisioning_time_check CHECK ("created_at_ms" >= 0)
)
      `,
      `
CREATE UNIQUE INDEX "ql3_local_provisioning_mutation_uidx"
ON "QingLong3LocalIdentityProvisionings" ("mutation_id")
      `,
      `
CREATE UNIQUE INDEX "ql3_local_provisioning_subject_uidx"
ON "QingLong3LocalIdentityProvisionings" ("subject_type", "subject_id")
      `,
      `
CREATE UNIQUE INDEX "ql3_local_provisioning_credential_uidx"
ON "QingLong3LocalIdentityProvisionings" (
  "credential_id", "credential_version"
)
      `,
      `
CREATE TABLE "QingLong3LocalOwnerBootstrapChallenges" (
  "project_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "issue_mutation_id" TEXT NOT NULL,
  "issue_request_id" TEXT NOT NULL,
  "challenge_id" TEXT NOT NULL,
  "token_digest" TEXT NOT NULL,
  "issuer_authentication_id" TEXT NOT NULL,
  "issuer_authenticated_at_ms" INTEGER NOT NULL,
  "issuer_expires_at_ms" INTEGER NOT NULL,
  "issued_at_ms" INTEGER NOT NULL,
  "expires_at_ms" INTEGER NOT NULL,
  "issue_audit_event_id" TEXT NOT NULL,
  "consumed_at_ms" INTEGER,
  "claim_mutation_id" TEXT,
  "claim_request_id" TEXT,
  "claimed_subject_type" TEXT,
  "claimed_subject_id" TEXT,
  "credential_id" TEXT,
  "credential_version" INTEGER,
  "claim_authentication_id" TEXT,
  "claim_authenticated_at_ms" INTEGER,
  "claim_expires_at_ms" INTEGER,
  "claim_assurance" TEXT,
  "claim_audit_event_id" TEXT,
  PRIMARY KEY ("project_id", "version"),
  FOREIGN KEY ("project_id")
    REFERENCES "QingLong3Projects" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("issue_audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id") ON DELETE RESTRICT,
  FOREIGN KEY ("claimed_subject_type", "claimed_subject_id")
    REFERENCES "QingLong3IdentitySubjects" ("subject_type", "subject_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("credential_id", "credential_version")
    REFERENCES "QingLong3ApiCredentials" ("credential_id", "version")
    ON DELETE RESTRICT,
  FOREIGN KEY ("claim_audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id") ON DELETE RESTRICT,
  CONSTRAINT ql3_local_owner_challenge_version_check CHECK (
    "version" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_local_owner_challenge_issue_identity_check CHECK (
    length("issue_mutation_id") = 36
    AND length("issue_request_id") BETWEEN 1 AND 128
    AND "issue_audit_event_id" = "issue_mutation_id"
  ),
  CONSTRAINT ql3_local_owner_challenge_id_check CHECK (
    length("challenge_id") = 22
    AND "challenge_id" NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  CONSTRAINT ql3_local_owner_challenge_digest_check CHECK (
    length("token_digest") = 64
    AND "token_digest" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_local_owner_challenge_issuer_check CHECK (
    length("issuer_authentication_id") BETWEEN 1 AND 128
    AND "issuer_authenticated_at_ms" <= "issued_at_ms"
    AND "issuer_expires_at_ms" > "issued_at_ms"
  ),
  CONSTRAINT ql3_local_owner_challenge_lifetime_check CHECK (
    "issued_at_ms" >= 0
    AND "expires_at_ms" > "issued_at_ms"
    AND "expires_at_ms" - "issued_at_ms" BETWEEN 60000 AND 1800000
  ),
  CONSTRAINT ql3_local_owner_challenge_claim_shape_check CHECK (
    (
      "consumed_at_ms" IS NULL
      AND "claim_mutation_id" IS NULL
      AND "claim_request_id" IS NULL
      AND "claimed_subject_type" IS NULL
      AND "claimed_subject_id" IS NULL
      AND "credential_id" IS NULL
      AND "credential_version" IS NULL
      AND "claim_authentication_id" IS NULL
      AND "claim_authenticated_at_ms" IS NULL
      AND "claim_expires_at_ms" IS NULL
      AND "claim_assurance" IS NULL
      AND "claim_audit_event_id" IS NULL
    )
    OR (
      "consumed_at_ms" >= "issued_at_ms"
      AND "consumed_at_ms" < "expires_at_ms"
      AND length("claim_mutation_id") = 36
      AND length("claim_request_id") BETWEEN 1 AND 128
      AND "claimed_subject_type" = 'user'
      AND length("claimed_subject_id") BETWEEN 1 AND 255
      AND length("credential_id") BETWEEN 1 AND 64
      AND "credential_version" BETWEEN 1 AND 2147483647
      AND length("claim_authentication_id") BETWEEN 1 AND 128
      AND "claim_authenticated_at_ms" <= "consumed_at_ms"
      AND "claim_expires_at_ms" > "consumed_at_ms"
      AND "claim_assurance" = 'single_factor'
      AND "claim_audit_event_id" = "claim_mutation_id"
    )
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_local_owner_challenge_issue_mutation_uidx"
ON "QingLong3LocalOwnerBootstrapChallenges" ("issue_mutation_id")
      `,
      `
CREATE UNIQUE INDEX "ql3_local_owner_challenge_id_uidx"
ON "QingLong3LocalOwnerBootstrapChallenges" ("challenge_id")
      `,
      `
CREATE UNIQUE INDEX "ql3_local_owner_challenge_claim_mutation_uidx"
ON "QingLong3LocalOwnerBootstrapChallenges" ("claim_mutation_id")
WHERE "claim_mutation_id" IS NOT NULL
      `,
      `
CREATE INDEX "ql3_local_owner_challenge_current_idx"
ON "QingLong3LocalOwnerBootstrapChallenges" (
  "project_id", "version" DESC
)
      `,
      `
CREATE INDEX "ql3_local_owner_challenge_expiry_idx"
ON "QingLong3LocalOwnerBootstrapChallenges" (
  "project_id", "expires_at_ms", "version" DESC
)
WHERE "consumed_at_ms" IS NULL
      `,
    ],
  });
