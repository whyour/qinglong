import { CAPABILITIES_V42 } from './0084-capability-v42';
import { defineLocalSqliteMigration } from './sqlMigration';

export const CAPABILITIES_V43 = CAPABILITIES_V42.replace(
  '"plugin_package_workflow_admission":1,',
  '"plugin_package_workflow_admission":1,"plugin_package_workflow_run_list":1,',
);

export const local0086CapabilityV43Migration = defineLocalSqliteMigration({
  id: '0086-capability-v43',
  statements: [
    `
UPDATE "QingLong3SchemaCapabilities"
SET contract_version = 43,
    migration_id = '0085-plugin-package-workflow-run-list-index',
    capabilities = '${CAPABILITIES_V43}',
    updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE contract_name = 'local-control-core'
  AND contract_version = 42
  AND migration_id = '0083-plugin-package-workflow-task-attempt-admissions'
  AND capabilities = '${CAPABILITIES_V42}'
    `,
  ],
});
