import { defineLocalSqliteMigration } from './sqlMigration';

export const local0017ApiCredentialPepperBindingsMigration =
  defineLocalSqliteMigration({
    id: '0017-api-credential-pepper-bindings',
    statements: [
      `
CREATE TABLE "QingLong3ApiCredentialPepperBindings" (
  "credential_id" TEXT NOT NULL,
  "credential_version" INTEGER NOT NULL,
  "pepper_key_id" TEXT NOT NULL,
  PRIMARY KEY ("credential_id", "credential_version"),
  FOREIGN KEY ("credential_id", "credential_version")
    REFERENCES "QingLong3ApiCredentials" ("credential_id", "version")
    ON DELETE RESTRICT,
  CONSTRAINT ql3_local_credential_pepper_key_id_check CHECK (
    length("pepper_key_id") BETWEEN 1 AND 64
    AND "pepper_key_id" NOT GLOB '*[^A-Za-z0-9._:-]*'
  )
)
      `,
      `
INSERT INTO "QingLong3ApiCredentialPepperBindings" (
  "credential_id", "credential_version", "pepper_key_id"
)
SELECT "credential_id", "version", 'legacy-v1'
FROM "QingLong3ApiCredentials"
      `,
      `
CREATE INDEX "ql3_local_credential_pepper_key_idx"
ON "QingLong3ApiCredentialPepperBindings" (
  "pepper_key_id", "credential_id", "credential_version"
)
      `,
    ],
  });
