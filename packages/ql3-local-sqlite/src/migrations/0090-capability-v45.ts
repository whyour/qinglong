import { CAPABILITIES_V44 } from './0088-capability-v44';
import { defineLocalSqliteMigration } from './sqlMigration';

export const CAPABILITIES_V45 = CAPABILITIES_V44.replace(
  '"plugin_package_automation_publication":1,',
  '"plugin_package_automation_publication":1,"plugin_package_automation_security_withdrawal":1,',
);

export const local0090CapabilityV45Migration = defineLocalSqliteMigration({
  id: '0090-capability-v45',
  statements: [
    `UPDATE "QingLong3SchemaCapabilities" SET contract_version = 45, migration_id = '0089-plugin-package-automation-disposition-events', capabilities = '${CAPABILITIES_V45}', updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE contract_name = 'local-control-core' AND contract_version = 44 AND migration_id = '0087-run-attempt-log-retention' AND capabilities = '${CAPABILITIES_V44}'`,
  ],
});
