import { CAPABILITIES_V45 } from './0090-capability-v45';
import { defineLocalSqliteMigration } from './sqlMigration';

export const CAPABILITIES_V46 = CAPABILITIES_V45.replace(
  '"plugin_package_task_reconciliation":1,',
  '"plugin_package_secret_binding":1,"plugin_package_task_reconciliation":1,',
);

export const local0092CapabilityV46Migration = defineLocalSqliteMigration({
  id: '0092-capability-v46',
  statements: [
    `UPDATE "QingLong3SchemaCapabilities" SET contract_version = 46, migration_id = '0091-plugin-package-secret-bindings', capabilities = '${CAPABILITIES_V46}', updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE contract_name = 'local-control-core' AND contract_version = 45 AND migration_id = '0089-plugin-package-automation-disposition-events' AND capabilities = '${CAPABILITIES_V45}'`,
  ],
});
