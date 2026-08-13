import { CAPABILITIES_V47 } from './0094-capability-v47';
import { defineLocalSqliteMigration } from './sqlMigration';

export const CAPABILITIES_V48 = CAPABILITIES_V47.replace(
  '"plugin_package_secret_binding":1,',
  '"plugin_package_secret_binding":1,"plugin_package_secret_binding_transition":1,',
);

export const local0096CapabilityV48Migration = defineLocalSqliteMigration({
  id: '0096-capability-v48',
  statements: [
    `UPDATE "QingLong3SchemaCapabilities" SET contract_version = 48, migration_id = '0095-plugin-package-secret-binding-target-guard', capabilities = '${CAPABILITIES_V48}', updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE contract_name = 'local-control-core' AND contract_version = 47 AND migration_id = '0093-plugin-package-secret-materialization-guard' AND capabilities = '${CAPABILITIES_V47}'`,
  ],
});
