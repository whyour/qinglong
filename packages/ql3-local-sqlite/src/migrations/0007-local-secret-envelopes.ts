import { defineLocalSqliteMigration } from './sqlMigration';

export const local0007LocalSecretEnvelopesMigration =
  defineLocalSqliteMigration({
    id: '0007-local-secret-envelopes',
    statements: [
      `
CREATE TABLE "QingLong3LocalSecretEnvelopes" (
  "project_id" TEXT NOT NULL,
  "secret_name" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "mutation_id" TEXT NOT NULL,
  "key_id" TEXT NOT NULL,
  "algorithm" TEXT NOT NULL,
  "nonce" BLOB NOT NULL,
  "ciphertext" BLOB NOT NULL,
  "auth_tag" BLOB NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  PRIMARY KEY ("project_id", "secret_name", "version"),
  CONSTRAINT ql3_local_secret_project_check CHECK (
    length("project_id") BETWEEN 1 AND 128
    AND "project_id" NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*'
  ),
  CONSTRAINT ql3_local_secret_name_check CHECK (
    length("secret_name") BETWEEN 1 AND 128
    AND "secret_name" NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*'
  ),
  CONSTRAINT ql3_local_secret_version_check CHECK (
    "version" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_local_secret_mutation_check CHECK (
    length("mutation_id") BETWEEN 1 AND 64
  ),
  CONSTRAINT ql3_local_secret_key_check CHECK (
    length("key_id") BETWEEN 1 AND 128
    AND "key_id" NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  CONSTRAINT ql3_local_secret_algorithm_check CHECK (
    "algorithm" = 'aes-256-gcm'
  ),
  CONSTRAINT ql3_local_secret_crypto_shape_check CHECK (
    length("nonce") = 12
    AND length("ciphertext") <= 16384
    AND length("auth_tag") = 16
  ),
  CONSTRAINT ql3_local_secret_created_check CHECK ("created_at_ms" >= 0)
)
      `,
      `
CREATE UNIQUE INDEX "ql3_local_secret_mutation_uidx"
ON "QingLong3LocalSecretEnvelopes" (
  "project_id", "secret_name", "mutation_id"
)
      `,
      `
CREATE INDEX "ql3_local_secret_current_idx"
ON "QingLong3LocalSecretEnvelopes" (
  "project_id", "secret_name", "version" DESC
)
      `,
      `
CREATE INDEX "ql3_local_secret_key_usage_idx"
ON "QingLong3LocalSecretEnvelopes" (
  "key_id", "project_id", "secret_name", "version"
)
      `,
    ],
  });
