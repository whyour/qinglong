import { CAPABILITIES_V48 } from './0096-capability-v48';
import { defineLocalSqliteMigration } from './sqlMigration';

export const CAPABILITIES_V49 = CAPABILITIES_V48.replace(
  '"plugin_package_secret_binding_transition":1,',
  '"plugin_package_secret_binding_transition":1,"plugin_package_secret_binding_transition_receipt":1,',
);

export const local0098CapabilityV49Migration = defineLocalSqliteMigration({
  id: '0098-capability-v49',
  statements: [
    `UPDATE "QingLong3SchemaCapabilities" SET contract_version = 49, migration_id = '0097-plugin-package-secret-binding-transition-receipts', capabilities = '${CAPABILITIES_V49}', updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE contract_name = 'local-control-core' AND contract_version = 48 AND migration_id = '0095-plugin-package-secret-binding-target-guard' AND capabilities = '${CAPABILITIES_V48}'`,
  ],
});
