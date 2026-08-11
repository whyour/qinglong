import { defineLocalSqliteMigration } from './sqlMigration';

export const local0008CapabilityV4Migration = defineLocalSqliteMigration({
  id: '0008-capability-v4',
  statements: [
    `
UPDATE "QingLong3SchemaCapabilities"
SET contract_version = 4,
    migration_id = '0007-local-secret-envelopes',
    capabilities = '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1,"local_secret_envelope":1}',
    updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE contract_name = 'local-control-core'
  AND contract_version = 3
  AND migration_id = '0005-local-dispatch-plan'
  AND capabilities = '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1}'
    `,
  ],
});
