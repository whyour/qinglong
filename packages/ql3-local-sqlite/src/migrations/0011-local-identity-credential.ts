import { defineLocalSqliteMigration } from './sqlMigration';

export const local0011LocalIdentityCredentialMigration =
  defineLocalSqliteMigration({
    id: '0011-local-identity-credential',
    statements: [
      `
CREATE TABLE "QingLong3IdentitySubjects" (
  "subject_type" TEXT NOT NULL,
  "subject_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  "updated_at_ms" INTEGER NOT NULL,
  PRIMARY KEY ("subject_type", "subject_id"),
  CONSTRAINT ql3_local_identity_type_check CHECK (
    "subject_type" IN ('user','api_app','mcp_client','agent','system','worker')
  ),
  CONSTRAINT ql3_local_identity_id_check CHECK (
    length("subject_id") BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_local_identity_status_check CHECK (
    "status" IN ('active','disabled')
  ),
  CONSTRAINT ql3_local_identity_version_check CHECK (
    "version" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_local_identity_time_check CHECK (
    "created_at_ms" >= 0 AND "updated_at_ms" >= "created_at_ms"
  )
)
      `,
      `
CREATE INDEX "ql3_local_identity_status_idx"
ON "QingLong3IdentitySubjects" (
  "status", "subject_type", "subject_id"
)
      `,
      `
CREATE TABLE "QingLong3ApiCredentials" (
  "credential_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "subject_type" TEXT NOT NULL,
  "subject_id" TEXT NOT NULL,
  "secret_digest" TEXT NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  "not_before_at_ms" INTEGER NOT NULL,
  "expires_at_ms" INTEGER NOT NULL,
  PRIMARY KEY ("credential_id", "version"),
  FOREIGN KEY ("subject_type", "subject_id")
    REFERENCES "QingLong3IdentitySubjects" ("subject_type", "subject_id")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_local_credentials_id_check CHECK (
    length("credential_id") BETWEEN 1 AND 64
    AND "credential_id" NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CONSTRAINT ql3_local_credentials_version_check CHECK (
    "version" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_local_credentials_state_check CHECK (
    "state" IN ('active','revoked')
  ),
  CONSTRAINT ql3_local_credentials_subject_type_check CHECK (
    "subject_type" IN ('user','api_app','mcp_client','agent')
  ),
  CONSTRAINT ql3_local_credentials_subject_id_check CHECK (
    length("subject_id") BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_local_credentials_digest_check CHECK (
    length("secret_digest") = 64
    AND "secret_digest" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_local_credentials_lifetime_check CHECK (
    "created_at_ms" >= 0
    AND "not_before_at_ms" >= "created_at_ms"
    AND "expires_at_ms" > "not_before_at_ms"
  )
)
      `,
      `
CREATE INDEX "ql3_local_credentials_current_idx"
ON "QingLong3ApiCredentials" ("credential_id", "version" DESC)
      `,
      `
CREATE INDEX "ql3_local_credentials_subject_idx"
ON "QingLong3ApiCredentials" (
  "subject_type", "subject_id", "credential_id", "version" DESC
)
      `,
    ],
  });
