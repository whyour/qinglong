export const LOCAL_DATA_DIRECTORY_ADOPTION_SECRET_GUARD_TRIGGER_SQL = `
CREATE TRIGGER "ql3_legacy_data_directory_adoption_secret_guard"
BEFORE INSERT ON "QingLong3LegacyDataDirectoryAdoptionSecrets"
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM "QingLong3LegacyDataDirectoryAdoptions" AS adoption
      JOIN "QingLong3LocalSecretEnvelopes" AS secret
        ON secret."project_id" = NEW."project_id"
       AND secret."secret_name" = NEW."secret_name"
       AND secret."version" = NEW."secret_version"
     WHERE adoption."mutation_id" = NEW."adoption_mutation_id"
       AND adoption."project_id" = NEW."project_id"
       AND secret."mutation_id" = NEW."secret_mutation_id"
  ) THEN RAISE(ABORT, 'legacy data directory adoption Secret authority mismatch') END;
END
`.trim();
