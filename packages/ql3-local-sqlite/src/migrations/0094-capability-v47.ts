import { CAPABILITIES_V46 } from './0092-capability-v46';
import { defineLocalSqliteMigration } from './sqlMigration';

export const CAPABILITIES_V47 = CAPABILITIES_V46.replace(
  '"plugin_package_secret_binding":1,',
  '"plugin_package_secret_binding":1,"plugin_package_secret_materialization":1,',
);

export const local0094CapabilityV47Migration = defineLocalSqliteMigration({
  id: '0094-capability-v47',
  statements: [
    `UPDATE "QingLong3SchemaCapabilities" SET contract_version = 47, migration_id = '0093-plugin-package-secret-materialization-guard', capabilities = '${CAPABILITIES_V47}', updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE contract_name = 'local-control-core' AND contract_version = 46 AND migration_id = '0091-plugin-package-secret-bindings' AND capabilities = '${CAPABILITIES_V46}'`,
  ],
});
