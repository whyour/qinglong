import { defineLocalSqliteMigration } from './sqlMigration';

export const local0010CapabilityV5Migration = defineLocalSqliteMigration({
  id: '0010-capability-v5',
  statements: [
    `
UPDATE "QingLong3SchemaCapabilities"
SET contract_version = 5,
    migration_id = '0009-local-project-policy-audit',
    capabilities = '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1,"local_secret_envelope":1,"local_project_policy":1,"local_security_audit":1,"local_secret_authorized_mutation":1}',
    updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE contract_name = 'local-control-core'
  AND contract_version = 4
  AND migration_id = '0007-local-secret-envelopes'
  AND capabilities = '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1,"local_secret_envelope":1}'
    `,
  ],
});
