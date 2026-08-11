import { defineLocalSqliteMigration } from './sqlMigration';

export const local0014CapabilityV7Migration = defineLocalSqliteMigration({
  id: '0014-capability-v7',
  statements: [
    `
UPDATE "QingLong3SchemaCapabilities"
SET contract_version = 7,
    migration_id = '0013-local-owner-bootstrap',
    capabilities = '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1,"local_secret_envelope":1,"local_project_policy":1,"local_security_audit":1,"local_secret_authorized_mutation":1,"local_identity":1,"local_api_credential":1,"local_identity_provisioning":1,"local_owner_bootstrap":1}',
    updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE contract_name = 'local-control-core'
  AND contract_version = 6
  AND migration_id = '0011-local-identity-credential'
  AND capabilities = '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1,"local_secret_envelope":1,"local_project_policy":1,"local_security_audit":1,"local_secret_authorized_mutation":1,"local_identity":1,"local_api_credential":1}'
    `,
  ],
});
