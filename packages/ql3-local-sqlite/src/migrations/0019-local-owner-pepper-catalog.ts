import { defineLocalSqliteMigration } from './sqlMigration';

export const local0019LocalOwnerPepperCatalogMigration =
  defineLocalSqliteMigration({
    id: '0019-local-owner-pepper-catalog',
    statements: [
      `
CREATE TABLE "QingLong3LocalOwnerPepperKeys" (
  "pepper_key_id" TEXT PRIMARY KEY,
  "material_digest" TEXT,
  "backup_digest" TEXT,
  "state" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "register_mutation_id" TEXT,
  "activate_mutation_id" TEXT,
  "retire_mutation_id" TEXT,
  "registered_at_ms" INTEGER NOT NULL,
  "activated_at_ms" INTEGER,
  "retired_at_ms" INTEGER,
  CONSTRAINT ql3_local_owner_pepper_key_id_check CHECK (
    length("pepper_key_id") BETWEEN 1 AND 64
    AND "pepper_key_id" NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  CONSTRAINT ql3_local_owner_pepper_digest_check CHECK (
    ("material_digest" IS NULL AND "backup_digest" IS NULL)
    OR (
      length("material_digest") = 64
      AND "material_digest" NOT GLOB '*[^0-9a-f]*'
      AND length("backup_digest") = 64
      AND "backup_digest" NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CONSTRAINT ql3_local_owner_pepper_state_check CHECK (
    "state" IN ('recovery_required', 'staged', 'active', 'retired')
  ),
  CONSTRAINT ql3_local_owner_pepper_version_check CHECK (
    "version" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_local_owner_pepper_mutation_check CHECK (
    ("register_mutation_id" IS NULL OR length("register_mutation_id") = 36)
    AND ("activate_mutation_id" IS NULL OR length("activate_mutation_id") = 36)
    AND ("retire_mutation_id" IS NULL OR length("retire_mutation_id") = 36)
  ),
  CONSTRAINT ql3_local_owner_pepper_time_check CHECK (
    "registered_at_ms" >= 0
    AND ("activated_at_ms" IS NULL OR "activated_at_ms" >= "registered_at_ms")
    AND ("retired_at_ms" IS NULL OR "retired_at_ms" >= "activated_at_ms")
  ),
  CONSTRAINT ql3_local_owner_pepper_shape_check CHECK (
    ("state" = 'recovery_required' AND "material_digest" IS NULL
      AND "backup_digest" IS NULL AND "register_mutation_id" IS NULL
      AND "activate_mutation_id" IS NULL AND "retire_mutation_id" IS NULL
      AND "activated_at_ms" IS NULL AND "retired_at_ms" IS NULL)
    OR ("state" = 'staged' AND "material_digest" IS NOT NULL
      AND "backup_digest" IS NOT NULL AND "register_mutation_id" IS NOT NULL
      AND "activate_mutation_id" IS NULL AND "retire_mutation_id" IS NULL
      AND "activated_at_ms" IS NULL AND "retired_at_ms" IS NULL)
    OR ("state" = 'active' AND "material_digest" IS NOT NULL
      AND "backup_digest" IS NOT NULL AND "register_mutation_id" IS NOT NULL
      AND "activate_mutation_id" IS NOT NULL AND "retire_mutation_id" IS NULL
      AND "activated_at_ms" IS NOT NULL AND "retired_at_ms" IS NULL)
    OR ("state" = 'retired' AND "material_digest" IS NOT NULL
      AND "backup_digest" IS NOT NULL AND "register_mutation_id" IS NOT NULL
      AND "activate_mutation_id" IS NOT NULL AND "retire_mutation_id" IS NOT NULL
      AND "activated_at_ms" IS NOT NULL AND "retired_at_ms" IS NOT NULL)
  )
)
      `,
      `
INSERT INTO "QingLong3LocalOwnerPepperKeys" (
  "pepper_key_id", "state", "version", "registered_at_ms"
)
SELECT 'legacy-v1', 'recovery_required', 1, 0
WHERE EXISTS (SELECT 1 FROM "QingLong3ApiCredentialPepperBindings" LIMIT 1)
      `,
      `
ALTER TABLE "QingLong3ApiCredentialPepperBindings"
RENAME TO "QingLong3ApiCredentialPepperBindingsBeforeCatalog"
      `,
      `
CREATE TABLE "QingLong3ApiCredentialPepperBindings" (
  "credential_id" TEXT NOT NULL,
  "credential_version" INTEGER NOT NULL,
  "pepper_key_id" TEXT NOT NULL,
  PRIMARY KEY ("credential_id", "credential_version"),
  FOREIGN KEY ("credential_id", "credential_version")
    REFERENCES "QingLong3ApiCredentials" ("credential_id", "version")
    ON DELETE RESTRICT,
  FOREIGN KEY ("pepper_key_id")
    REFERENCES "QingLong3LocalOwnerPepperKeys" ("pepper_key_id")
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
SELECT "credential_id", "credential_version", "pepper_key_id"
FROM "QingLong3ApiCredentialPepperBindingsBeforeCatalog"
      `,
      `
DROP TABLE "QingLong3ApiCredentialPepperBindingsBeforeCatalog"
      `,
      `
CREATE INDEX "ql3_local_credential_pepper_key_idx"
ON "QingLong3ApiCredentialPepperBindings" (
  "pepper_key_id", "credential_id", "credential_version"
)
      `,
      `
CREATE UNIQUE INDEX "ql3_local_owner_pepper_register_mutation_uidx"
ON "QingLong3LocalOwnerPepperKeys" ("register_mutation_id")
WHERE "register_mutation_id" IS NOT NULL
      `,
      `
CREATE UNIQUE INDEX "ql3_local_owner_pepper_single_active_uidx"
ON "QingLong3LocalOwnerPepperKeys" ("state")
WHERE "state" = 'active'
      `,
      `
CREATE INDEX "ql3_local_owner_pepper_state_idx"
ON "QingLong3LocalOwnerPepperKeys" ("state", "pepper_key_id")
      `,
      `
CREATE TABLE "QingLong3LocalOwnerPepperActivations" (
  "generation" INTEGER PRIMARY KEY,
  "mutation_id" TEXT NOT NULL,
  "expected_generation" INTEGER NOT NULL,
  "previous_pepper_key_id" TEXT,
  "active_pepper_key_id" TEXT NOT NULL,
  "material_digest" TEXT NOT NULL,
  "backup_digest" TEXT NOT NULL,
  "activated_at_ms" INTEGER NOT NULL,
  CONSTRAINT ql3_local_owner_pepper_activation_generation_check CHECK (
    "generation" BETWEEN 1 AND 2147483647
    AND "expected_generation" = "generation" - 1
  ),
  CONSTRAINT ql3_local_owner_pepper_activation_mutation_check CHECK (
    length("mutation_id") = 36
  ),
  CONSTRAINT ql3_local_owner_pepper_activation_key_check CHECK (
    length("active_pepper_key_id") BETWEEN 1 AND 64
    AND "active_pepper_key_id" NOT GLOB '*[^A-Za-z0-9._:-]*'
    AND ("previous_pepper_key_id" IS NULL OR (
      length("previous_pepper_key_id") BETWEEN 1 AND 64
      AND "previous_pepper_key_id" NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND "previous_pepper_key_id" <> "active_pepper_key_id"
    ))
  ),
  CONSTRAINT ql3_local_owner_pepper_activation_digest_check CHECK (
    length("material_digest") = 64
    AND "material_digest" NOT GLOB '*[^0-9a-f]*'
    AND length("backup_digest") = 64
    AND "backup_digest" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_local_owner_pepper_activation_time_check CHECK (
    "activated_at_ms" >= 0
  ),
  FOREIGN KEY ("previous_pepper_key_id")
    REFERENCES "QingLong3LocalOwnerPepperKeys" ("pepper_key_id")
    ON DELETE RESTRICT,
  FOREIGN KEY ("active_pepper_key_id")
    REFERENCES "QingLong3LocalOwnerPepperKeys" ("pepper_key_id")
    ON DELETE RESTRICT
)
      `,
      `
CREATE UNIQUE INDEX "ql3_local_owner_pepper_activation_mutation_uidx"
ON "QingLong3LocalOwnerPepperActivations" ("mutation_id")
      `,
      `
CREATE INDEX "ql3_local_owner_pepper_activation_key_idx"
ON "QingLong3LocalOwnerPepperActivations" (
  "active_pepper_key_id", "generation" DESC
)
      `,
    ],
  });
