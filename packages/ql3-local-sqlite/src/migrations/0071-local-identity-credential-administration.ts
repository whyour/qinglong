import { defineLocalSqliteMigration } from './sqlMigration';

export const local0071LocalIdentityCredentialAdministrationMigration =
  defineLocalSqliteMigration({
    id: '0071-local-identity-credential-administration',
    statements: [
      `
CREATE UNIQUE INDEX "ql3_local_credential_pepper_binding_triple_uidx"
ON "QingLong3ApiCredentialPepperBindings" (
  "credential_id", "credential_version", "pepper_key_id"
)
      `,
      `
CREATE TABLE "QingLong3IdentityAdministrationMutations" (
  "mutation_id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "subject_type" TEXT NOT NULL,
  "subject_id" TEXT NOT NULL,
  "subject_version" INTEGER NOT NULL,
  "expected_previous_version" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "changed_by_type" TEXT NOT NULL,
  "changed_by_id" TEXT NOT NULL,
  "audit_event_id" TEXT NOT NULL UNIQUE,
  "identity_created_at_ms" INTEGER NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  FOREIGN KEY ("project_id")
    REFERENCES "QingLong3Projects" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("subject_type", "subject_id")
    REFERENCES "QingLong3IdentitySubjects" ("subject_type", "subject_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_identity_admin_mutation_id_check CHECK (
    length("mutation_id") = 36
  ),
  CONSTRAINT ql3_identity_admin_operation_check CHECK (
    "operation" IN ('register','enable','disable')
  ),
  CONSTRAINT ql3_identity_admin_subject_check CHECK (
    "subject_type" IN ('user','api_app','mcp_client','agent')
    AND length("subject_id") BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_identity_admin_transition_check CHECK (
    "subject_version" = "expected_previous_version" + 1
    AND "subject_version" BETWEEN 1 AND 2147483647
    AND "expected_previous_version" BETWEEN 0 AND 2147483646
    AND (
      ("operation" = 'register'
        AND "expected_previous_version" = 0 AND "status" = 'active')
      OR ("operation" = 'enable'
        AND "expected_previous_version" > 0 AND "status" = 'active')
      OR ("operation" = 'disable'
        AND "expected_previous_version" > 0 AND "status" = 'disabled')
    )
  ),
  CONSTRAINT ql3_identity_admin_actor_check CHECK (
    "changed_by_type" = 'user'
    AND length("changed_by_id") BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_identity_admin_audit_check CHECK (
    "audit_event_id" = "mutation_id"
  ),
  CONSTRAINT ql3_identity_admin_time_check CHECK (
    "identity_created_at_ms" >= 0
    AND "created_at_ms" >= "identity_created_at_ms"
  )
)
      `,
      `
CREATE INDEX "ql3_identity_admin_subject_idx"
ON "QingLong3IdentityAdministrationMutations" (
  "subject_type", "subject_id", "subject_version" DESC
)
      `,
      `
CREATE TABLE "QingLong3ApiCredentialAdministrationMutations" (
  "mutation_id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "credential_id" TEXT NOT NULL,
  "credential_version" INTEGER NOT NULL,
  "expected_previous_version" INTEGER NOT NULL,
  "subject_type" TEXT NOT NULL,
  "subject_id" TEXT NOT NULL,
  "subject_status" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "pepper_key_id" TEXT NOT NULL,
  "secret_digest" TEXT NOT NULL,
  "not_before_at_ms" INTEGER NOT NULL,
  "expires_at_ms" INTEGER NOT NULL,
  "delivery_digest" TEXT,
  "changed_by_type" TEXT NOT NULL,
  "changed_by_id" TEXT NOT NULL,
  "audit_event_id" TEXT NOT NULL UNIQUE,
  "created_at_ms" INTEGER NOT NULL,
  FOREIGN KEY ("project_id")
    REFERENCES "QingLong3Projects" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("credential_id", "credential_version")
    REFERENCES "QingLong3ApiCredentials" ("credential_id", "version")
    ON DELETE RESTRICT,
  FOREIGN KEY ("credential_id", "credential_version", "pepper_key_id")
    REFERENCES "QingLong3ApiCredentialPepperBindings" (
      "credential_id", "credential_version", "pepper_key_id"
    ) ON DELETE RESTRICT,
  FOREIGN KEY ("audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_credential_admin_mutation_id_check CHECK (
    length("mutation_id") = 36
  ),
  CONSTRAINT ql3_credential_admin_operation_check CHECK (
    "operation" IN ('issue','rotate','revoke')
  ),
  CONSTRAINT ql3_credential_admin_identity_check CHECK (
    length("credential_id") BETWEEN 1 AND 64
    AND "credential_id" NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND "subject_type" IN ('user','api_app','mcp_client','agent')
    AND length("subject_id") BETWEEN 1 AND 255
    AND "subject_status" IN ('active','disabled')
  ),
  CONSTRAINT ql3_credential_admin_transition_check CHECK (
    "credential_version" = "expected_previous_version" + 1
    AND "credential_version" BETWEEN 1 AND 2147483647
    AND "expected_previous_version" BETWEEN 0 AND 2147483646
    AND (
      ("operation" = 'issue'
        AND "expected_previous_version" = 0 AND "state" = 'active')
      OR ("operation" = 'rotate'
        AND "expected_previous_version" > 0 AND "state" = 'active')
      OR ("operation" = 'revoke'
        AND "expected_previous_version" > 0 AND "state" = 'revoked')
    )
  ),
  CONSTRAINT ql3_credential_admin_digest_check CHECK (
    length("pepper_key_id") BETWEEN 1 AND 64
    AND "pepper_key_id" NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND length("secret_digest") = 64
    AND "secret_digest" NOT GLOB '*[^0-9a-f]*'
    AND (
      ("operation" IN ('issue','rotate')
        AND length("delivery_digest") = 64
        AND "delivery_digest" NOT GLOB '*[^0-9a-f]*')
      OR ("operation" = 'revoke' AND "delivery_digest" IS NULL)
    )
  ),
  CONSTRAINT ql3_credential_admin_lifetime_check CHECK (
    "created_at_ms" >= 0
    AND "not_before_at_ms" >= "created_at_ms"
    AND "expires_at_ms" > "not_before_at_ms"
  ),
  CONSTRAINT ql3_credential_admin_actor_check CHECK (
    "changed_by_type" = 'user'
    AND length("changed_by_id") BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_credential_admin_audit_check CHECK (
    "audit_event_id" = "mutation_id"
  )
)
      `,
      `
CREATE INDEX "ql3_credential_admin_credential_idx"
ON "QingLong3ApiCredentialAdministrationMutations" (
  "credential_id", "credential_version" DESC
)
      `,
      `
CREATE INDEX "ql3_credential_admin_subject_idx"
ON "QingLong3ApiCredentialAdministrationMutations" (
  "subject_type", "subject_id", "created_at_ms" DESC
)
      `,
      `
CREATE TABLE "QingLong3ApiCredentialDeliveryAcknowledgements" (
  "credential_mutation_id" TEXT PRIMARY KEY NOT NULL,
  "acknowledgement_mutation_id" TEXT NOT NULL UNIQUE,
  "project_id" TEXT NOT NULL,
  "delivery_digest" TEXT NOT NULL,
  "acknowledged_by_type" TEXT NOT NULL,
  "acknowledged_by_id" TEXT NOT NULL,
  "audit_event_id" TEXT NOT NULL UNIQUE,
  "acknowledged_at_ms" INTEGER NOT NULL,
  FOREIGN KEY ("credential_mutation_id")
    REFERENCES "QingLong3ApiCredentialAdministrationMutations" ("mutation_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("project_id")
    REFERENCES "QingLong3Projects" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_credential_delivery_ack_identity_check CHECK (
    length("credential_mutation_id") = 36
    AND length("acknowledgement_mutation_id") = 36
    AND "credential_mutation_id" <> "acknowledgement_mutation_id"
  ),
  CONSTRAINT ql3_credential_delivery_ack_digest_check CHECK (
    length("delivery_digest") = 64
    AND "delivery_digest" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_credential_delivery_ack_actor_check CHECK (
    "acknowledged_by_type" = 'user'
    AND length("acknowledged_by_id") BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_credential_delivery_ack_audit_check CHECK (
    "audit_event_id" = "acknowledgement_mutation_id"
  ),
  CONSTRAINT ql3_credential_delivery_ack_time_check CHECK (
    "acknowledged_at_ms" >= 0
  )
)
      `,
      `
CREATE INDEX "ql3_credential_delivery_ack_project_idx"
ON "QingLong3ApiCredentialDeliveryAcknowledgements" (
  "project_id", "acknowledged_at_ms" DESC
)
      `,
    ],
  });
