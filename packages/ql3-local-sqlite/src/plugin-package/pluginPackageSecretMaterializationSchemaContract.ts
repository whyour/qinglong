/**
 * Immutable DDL contract shared by the migration writer and read-only
 * readiness auditor. Keeping it outside /migrations preserves lazy DDL
 * loading on constrained Local Profiles.
 */
export const LOCAL_PLUGIN_PACKAGE_SECRET_MATERIALIZATION_TRIGGER_SQL = `
CREATE TRIGGER ql3_plugin_package_secret_materialization_guard
BEFORE INSERT ON "QingLong3PluginPackageMaterializedRevisions"
BEGIN
  SELECT CASE
    WHEN json_type(
      NEW.revision_json,
      '$.manifest.spec.permissions.secrets'
    ) IS NOT 'array'
    THEN RAISE(ABORT, 'Package Secret permission declarations are malformed')
    WHEN json_array_length(json_extract(
      NEW.revision_json,
      '$.manifest.spec.permissions.secrets'
    )) = 0 AND json_type(NEW.revision_json, '$.secretBinding') IS NOT NULL
    THEN RAISE(ABORT, 'unexpected Package Secret binding')
    WHEN json_array_length(json_extract(
      NEW.revision_json,
      '$.manifest.spec.permissions.secrets'
    )) > 0 AND NOT EXISTS (
      SELECT 1
      FROM "QingLong3PluginPackageSecretBindings" AS binding
      WHERE binding.generation_digest = NEW.generation_digest
        AND json(binding.binding_json) = json_extract(
          NEW.revision_json,
          '$.secretBinding'
        )
    )
    THEN RAISE(ABORT, 'Package Secret binding is absent or mismatched')
    WHEN EXISTS (
      SELECT 1
      FROM json_each(NEW.revision_json, '$.resources') AS resource
      JOIN json_each(
        resource.value,
        '$.value.spec.config.environment'
      ) AS environment
      WHERE json_extract(resource.value, '$.kind') = 'task'
        AND json_extract(environment.value, '$.kind') = 'package-secret'
    )
    THEN RAISE(ABORT, 'unresolved Package Secret placeholder')
    WHEN EXISTS (
      SELECT 1
      FROM json_each(NEW.revision_json, '$.resources') AS resource
      JOIN json_each(
        resource.value,
        '$.value.spec.config.environment'
      ) AS environment
      WHERE json_extract(resource.value, '$.kind') = 'task'
        AND json_extract(environment.value, '$.kind') = 'secret'
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(
            NEW.revision_json,
            '$.secretBinding.entries'
          ) AS binding_entry
          WHERE json_extract(binding_entry.value, '$.secretRef') =
            json_extract(environment.value, '$.secretRef')
        )
    )
    THEN RAISE(ABORT, 'Task SecretRef is outside Package binding')
  END;
END
`.trim();
