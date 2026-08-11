import { CAPABILITIES_V43 } from './0086-capability-v43';
import { defineLocalSqliteMigration } from './sqlMigration';

export const CAPABILITIES_V44 = CAPABILITIES_V43.replace(
  '"plugin_package_workflow_run_list":1,',
  '"plugin_package_workflow_run_list":1,"run_attempt_log_retention":1,',
);

export const local0088CapabilityV44Migration = defineLocalSqliteMigration({
  id: '0088-capability-v44',
  statements: [
    `
UPDATE "QingLong3SchemaCapabilities"
SET contract_version = 44,
    migration_id = '0087-run-attempt-log-retention',
    capabilities = '${CAPABILITIES_V44}',
    updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE contract_name = 'local-control-core'
  AND contract_version = 43
  AND migration_id = '0085-plugin-package-workflow-run-list-index'
  AND capabilities = '${CAPABILITIES_V43}'
    `,
  ],
});
