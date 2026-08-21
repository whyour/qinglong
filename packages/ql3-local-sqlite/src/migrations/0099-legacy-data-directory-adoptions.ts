import { defineLocalSqliteMigration } from './sqlMigration';
import { LOCAL_DATA_DIRECTORY_ADOPTION_SECRET_GUARD_TRIGGER_SQL } from '../adoption/data-directory/dataDirectoryAdoptionSchemaContract';

export const local0099LegacyDataDirectoryAdoptionsMigration =
  defineLocalSqliteMigration({
    id: '0099-legacy-data-directory-adoptions',
    statements: [
      `
CREATE TABLE "QingLong3LegacyDataDirectoryAdoptions" (
  "mutation_id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL,
  "profile" TEXT NOT NULL,
  "source_stage_manifest_digest" TEXT NOT NULL,
  "transformation_digest" TEXT NOT NULL,
  "model_digest" TEXT NOT NULL,
  "secret_count" INTEGER NOT NULL,
  "environment_secret_count" INTEGER NOT NULL,
  "ssh_secret_count" INTEGER NOT NULL,
  "model_json" TEXT NOT NULL,
  "publication_digest" TEXT NOT NULL,
  "audit_event_id" TEXT NOT NULL,
  "committed_at_ms" INTEGER NOT NULL,
  "receipt_digest" TEXT NOT NULL,
  "receipt_json" TEXT NOT NULL,
  CONSTRAINT ql3_legacy_data_directory_adoption_project_fk
    FOREIGN KEY ("project_id")
    REFERENCES "QingLong3Projects" ("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_legacy_data_directory_adoption_audit_fk
    FOREIGN KEY ("audit_event_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_legacy_data_directory_adoption_identity_check CHECK (
    length("mutation_id") = 36 AND
    substr("mutation_id", 15, 1) = '4' AND
    replace("mutation_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND
    "audit_event_id" = "mutation_id" AND
    length("project_id") BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_legacy_data_directory_adoption_profile_check CHECK (
    "profile" IN ('edge', 'standalone')
  ),
  CONSTRAINT ql3_legacy_data_directory_adoption_digest_check CHECK (
    length("source_stage_manifest_digest") = 64 AND
    "source_stage_manifest_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("transformation_digest") = 64 AND
    "transformation_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("model_digest") = 64 AND
    "model_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("publication_digest") = 64 AND
    "publication_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("receipt_digest") = 64 AND
    "receipt_digest" NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_legacy_data_directory_adoption_count_check CHECK (
    "secret_count" BETWEEN 0 AND CASE "profile" WHEN 'edge' THEN 128 ELSE 512 END AND
    "environment_secret_count" BETWEEN 0 AND "secret_count" AND
    "ssh_secret_count" BETWEEN 0 AND "secret_count" AND
    "environment_secret_count" + "ssh_secret_count" = "secret_count"
  ),
  CONSTRAINT ql3_legacy_data_directory_adoption_model_check CHECK (
    length(CAST("model_json" AS BLOB)) BETWEEN 2 AND 1048576 AND
    json_valid("model_json") AND json_type("model_json") = 'object' AND
    json_extract("model_json", '$.schema') = 'qinglong/legacy-data-directory-applied-model@v1' AND
    json_extract("model_json", '$.activation') = 'disabled' AND
    json_extract("model_json", '$.config.schema') = 'qinglong/legacy-config-transformation@v1' AND
    json_extract("model_json", '$.config.activation') = 'disabled' AND
    json_extract("model_json", '$.keyv.schema') = 'qinglong/legacy-keyv-transformation@v1' AND
    json_extract("model_json", '$.keyv.activation') = 'disabled' AND
    json_extract("model_json", '$.ssh.schema') = 'qinglong/legacy-ssh-transformation@v1' AND
    json_extract("model_json", '$.ssh.activation') = 'disabled' AND
    json_extract("model_json", '$.manualReview.schema') = 'qinglong/legacy-data-directory-manual-review@v1' AND
    json_extract("model_json", '$.manualReview.required') = 0 AND
    json_extract("model_json", '$.manualReview.activation') = 'disabled'
  ),
  CONSTRAINT ql3_legacy_data_directory_adoption_receipt_check CHECK (
    length(CAST("receipt_json" AS BLOB)) BETWEEN 2 AND 1048576 AND
    json_valid("receipt_json") AND json_type("receipt_json") = 'object' AND
    json_extract("receipt_json", '$.schema') = 'qinglong/legacy-data-directory-adoption-receipt@v1' AND
    json_extract("receipt_json", '$.mutationId') = "mutation_id" AND
    json_extract("receipt_json", '$.projectId') = "project_id" AND
    json_extract("receipt_json", '$.profile') = "profile" AND
    json_extract("receipt_json", '$.sourceStageManifestDigest') = "source_stage_manifest_digest" AND
    json_extract("receipt_json", '$.transformationDigest') = "transformation_digest" AND
    json_extract("receipt_json", '$.modelDigest') = "model_digest" AND
    json_extract("receipt_json", '$.secretCount') = "secret_count" AND
    json_extract("receipt_json", '$.environmentSecretCount') = "environment_secret_count" AND
    json_extract("receipt_json", '$.sshSecretCount') = "ssh_secret_count" AND
    json_extract("receipt_json", '$.publicationDigest') = "publication_digest" AND
    json_extract("receipt_json", '$.auditEventId') = "audit_event_id" AND
    json_extract("receipt_json", '$.committedAtMs') = "committed_at_ms" AND
    json_extract("receipt_json", '$.receiptDigest') = "receipt_digest"
  ),
  CONSTRAINT ql3_legacy_data_directory_adoption_time_check CHECK (
    "committed_at_ms" >= 0
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_legacy_data_directory_adoption_transformation_uidx"
ON "QingLong3LegacyDataDirectoryAdoptions" ("transformation_digest")
      `,
      `
CREATE UNIQUE INDEX "ql3_legacy_data_directory_adoption_receipt_uidx"
ON "QingLong3LegacyDataDirectoryAdoptions" ("receipt_digest")
      `,
      `
CREATE INDEX "ql3_legacy_data_directory_adoption_project_time_idx"
ON "QingLong3LegacyDataDirectoryAdoptions" (
  "project_id", "committed_at_ms" DESC, "mutation_id" DESC
)
      `,
      `
CREATE TABLE "QingLong3LegacyDataDirectoryAdoptionSecrets" (
  "adoption_mutation_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "project_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "source_name_digest" TEXT NOT NULL,
  "secret_name" TEXT NOT NULL,
  "secret_version" INTEGER NOT NULL,
  "secret_mutation_id" TEXT NOT NULL,
  "value_file" TEXT NOT NULL,
  "value_digest" TEXT NOT NULL,
  "secret_ref" TEXT NOT NULL,
  "item_digest" TEXT NOT NULL,
  PRIMARY KEY ("adoption_mutation_id", "ordinal"),
  CONSTRAINT ql3_legacy_data_directory_adoption_secret_parent_fk
    FOREIGN KEY ("adoption_mutation_id")
    REFERENCES "QingLong3LegacyDataDirectoryAdoptions" ("mutation_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_legacy_data_directory_adoption_secret_envelope_fk
    FOREIGN KEY ("project_id", "secret_name", "secret_version")
    REFERENCES "QingLong3LocalSecretEnvelopes" ("project_id", "secret_name", "version")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_legacy_data_directory_adoption_secret_audit_fk
    FOREIGN KEY ("secret_mutation_id")
    REFERENCES "QingLong3SecurityAuditEvents" ("event_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_legacy_data_directory_adoption_secret_identity_check CHECK (
    "ordinal" BETWEEN 1 AND 512 AND
    length("project_id") BETWEEN 1 AND 128 AND
    "kind" IN ('environment', 'ssh_private_key') AND
    length("secret_name") BETWEEN 1 AND 128 AND
    "secret_version" = 1 AND
    length("secret_mutation_id") = 36 AND
    substr("secret_mutation_id", 15, 1) = '4' AND
    replace("secret_mutation_id", '-', '') NOT GLOB '*[^0-9a-f]*' AND
    length("value_file") = 83 AND
    "value_file" GLOB 'secret-values/[0-9a-f]*.json' AND
    length("secret_ref") BETWEEN 1 AND 512
  ),
  CONSTRAINT ql3_legacy_data_directory_adoption_secret_digest_check CHECK (
    length("source_name_digest") = 64 AND
    "source_name_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("value_digest") = 64 AND
    "value_digest" NOT GLOB '*[^0-9a-f]*' AND
    length("item_digest") = 64 AND
    "item_digest" NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `
CREATE UNIQUE INDEX "ql3_legacy_data_directory_adoption_secret_name_uidx"
ON "QingLong3LegacyDataDirectoryAdoptionSecrets" (
  "adoption_mutation_id", "secret_name"
)
      `,
      `
CREATE UNIQUE INDEX "ql3_legacy_data_directory_adoption_secret_mutation_uidx"
ON "QingLong3LegacyDataDirectoryAdoptionSecrets" ("secret_mutation_id")
      `,
      `
CREATE UNIQUE INDEX "ql3_legacy_data_directory_adoption_secret_item_uidx"
ON "QingLong3LegacyDataDirectoryAdoptionSecrets" ("item_digest")
      `,
      LOCAL_DATA_DIRECTORY_ADOPTION_SECRET_GUARD_TRIGGER_SQL,
    ],
  });
