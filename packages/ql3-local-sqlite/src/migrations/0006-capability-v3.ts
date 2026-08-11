import { defineLocalSqliteMigration } from './sqlMigration';

export const local0006CapabilityV3Migration = defineLocalSqliteMigration({
  id: '0006-capability-v3',
  statements: [
    `
UPDATE "QingLong3SchemaCapabilities"
SET contract_version = 3,
    migration_id = '0005-local-dispatch-plan',
    capabilities = '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1}',
    updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE contract_name = 'local-control-core'
  AND contract_version = 2
  AND migration_id = '0003-completion-receipt-journal'
  AND capabilities = '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1}'
    `,
  ],
});
