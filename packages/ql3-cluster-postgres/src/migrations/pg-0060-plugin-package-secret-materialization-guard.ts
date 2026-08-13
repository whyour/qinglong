import { CAPABILITIES_V58 } from './pg-0059-plugin-package-secret-bindings';
import { definePostgresSqlMigration } from './sqlMigration';

export const CAPABILITIES_V59 = CAPABILITIES_V58.replace(
  '"plugin_package_secret_binding":1,',
  '"plugin_package_secret_binding":1,"plugin_package_secret_materialization":1,',
);

export const pg0060PluginPackageSecretMaterializationGuardMigration =
  definePostgresSqlMigration({
    id: 'pg-0060-plugin-package-secret-materialization-guard',
    statements: [
      `
CREATE FUNCTION "ql3"."enforce_plugin_package_secret_materialization"()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, ql3
AS $ql3$
DECLARE
  secret_count integer;
  embedded_binding jsonb;
  stored_binding jsonb;
BEGIN
  IF jsonb_typeof(
    NEW.revision_json #> '{manifest,spec,permissions,secrets}'
  ) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Package Secret permission declarations are malformed'
      USING ERRCODE = 'check_violation';
  END IF;

  secret_count := jsonb_array_length(
    NEW.revision_json #> '{manifest,spec,permissions,secrets}'
  );
  embedded_binding := NEW.revision_json -> 'secretBinding';

  IF secret_count = 0 THEN
    IF embedded_binding IS NOT NULL THEN
      RAISE EXCEPTION 'unexpected Package Secret binding'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT binding.binding_json
      INTO stored_binding
      FROM "ql3"."plugin_package_secret_bindings" AS binding
     WHERE binding.generation_digest = NEW.generation_digest;
    IF stored_binding IS NULL OR stored_binding <> embedded_binding THEN
      RAISE EXCEPTION 'Package Secret binding is absent or mismatched'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.revision_json -> 'resources') AS resource
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(
          resource #> '{value,spec,config,environment}',
          '[]'::jsonb
        )
      ) AS environment
     WHERE resource ->> 'kind' = 'task'
       AND environment ->> 'kind' = 'package-secret'
  ) THEN
    RAISE EXCEPTION 'unresolved Package Secret placeholder'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(NEW.revision_json -> 'resources') AS resource
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(
          resource #> '{value,spec,config,environment}',
          '[]'::jsonb
        )
      ) AS environment
     WHERE resource ->> 'kind' = 'task'
       AND environment ->> 'kind' = 'secret'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
             COALESCE(embedded_binding -> 'entries', '[]'::jsonb)
           ) AS binding_entry
          WHERE binding_entry ->> 'secretRef' =
            environment ->> 'secretRef'
       )
  ) THEN
    RAISE EXCEPTION 'Task SecretRef is outside Package binding'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$ql3$
      `.trim(),
      `REVOKE ALL ON FUNCTION "ql3"."enforce_plugin_package_secret_materialization"() FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress`,
      `CREATE TRIGGER ql3_plugin_package_secret_materialization_guard BEFORE INSERT ON "ql3"."plugin_package_materialized_revisions" FOR EACH ROW EXECUTE FUNCTION "ql3"."enforce_plugin_package_secret_materialization"()`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 59, migration_id = 'pg-0060-plugin-package-secret-materialization-guard', capabilities = '${CAPABILITIES_V59}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 58 AND migration_id = 'pg-0059-plugin-package-secret-bindings' AND capabilities = '${CAPABILITIES_V58}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 58' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });
