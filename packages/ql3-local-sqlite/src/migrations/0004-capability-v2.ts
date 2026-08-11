import { defineLocalSqliteMigration } from './sqlMigration';

export const local0004CapabilityV2Migration = defineLocalSqliteMigration({
  id: '0004-capability-v2',
  statements: [
    `
UPDATE "QingLong3SchemaCapabilities"
SET contract_version = 2,
    migration_id = '0003-completion-receipt-journal',
    capabilities = '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1}',
    updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE contract_name = 'local-control-core'
  AND contract_version = 1
  AND migration_id = '0001-run-core'
  AND capabilities = '{"run_core":1,"run_retry_policy":1}'
    `,
  ],
});
