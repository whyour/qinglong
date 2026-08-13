import { CAPABILITIES_V60 } from './pg-0061-plugin-package-secret-binding-approval-plans';
import { definePostgresSqlMigration } from './sqlMigration';

export const CAPABILITIES_V61 = CAPABILITIES_V60.replace(
  '"plugin_package_secret_binding":1,',
  '"plugin_package_secret_binding":1,"plugin_package_secret_binding_transition":1,',
);

export const pg0062PluginPackageSecretBindingTargetGuardMigration =
  definePostgresSqlMigration({
    id: 'pg-0062-plugin-package-secret-binding-target-guard',
    statements: [
      `
CREATE FUNCTION "ql3"."enforce_plugin_package_secret_binding_target"()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, ql3
AS $ql3$
BEGIN
  PERFORM 1
    FROM "ql3"."plugin_package_install_heads" AS head
    JOIN "ql3"."plugin_package_installs" AS install
      ON install.installation_id = head.installation_id
     AND install.project_id = head.project_id
     AND install.package_name = head.package_name
   WHERE head.project_id = NEW.project_id
     AND head.package_name = NEW.package_name
     AND install.installation_id = NEW.installation_id
     AND install.lock_digest = NEW.lock_digest
     AND install.target_generation = NEW.generation
     AND install.lock_json ->> 'manifestDigest' = NEW.manifest_digest
     AND (
       (
         install.state = 'active' AND
         install.active_lock_digest = install.lock_digest
       ) OR (
         install.state = 'staged' AND
         install.previous_active_lock_digest IS NOT NULL AND
         install.active_lock_digest = install.previous_active_lock_digest AND
         install.target_generation = (
           SELECT MAX(history.target_generation)
             FROM "ql3"."plugin_package_installs" AS history
            WHERE history.project_id = install.project_id
              AND history.package_name = install.package_name
         ) AND
         EXISTS (
           SELECT 1
             FROM "ql3"."plugin_package_installs" AS previous
            WHERE previous.project_id = install.project_id
              AND previous.package_name = install.package_name
              AND previous.lock_digest = install.previous_active_lock_digest
              AND previous.state = 'active'
              AND previous.active_lock_digest = previous.lock_digest
              AND previous.target_generation < install.target_generation
         )
       )
     )
   FOR SHARE OF head, install;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Plugin Package Secret binding target is not current active or reviewed staged generation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$ql3$
      `.trim(),
      `REVOKE ALL ON FUNCTION "ql3"."enforce_plugin_package_secret_binding_target"() FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress`,
      `CREATE TRIGGER ql3_plugin_package_secret_binding_target_guard BEFORE INSERT ON "ql3"."plugin_package_secret_bindings" FOR EACH ROW EXECUTE FUNCTION "ql3"."enforce_plugin_package_secret_binding_target"()`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 61, migration_id = 'pg-0062-plugin-package-secret-binding-target-guard', capabilities = '${CAPABILITIES_V61}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 60 AND migration_id = 'pg-0061-plugin-package-secret-binding-approval-plans' AND capabilities = '${CAPABILITIES_V60}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 60' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });
