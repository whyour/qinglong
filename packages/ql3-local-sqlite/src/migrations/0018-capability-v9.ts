import { defineLocalSqliteMigration } from './sqlMigration';

export const local0018CapabilityV9Migration = defineLocalSqliteMigration({
  id: '0018-capability-v9',
  statements: [
    `
UPDATE "QingLong3SchemaCapabilities"
SET contract_version = 9,
    migration_id = '0017-api-credential-pepper-bindings',
    capabilities = '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1,"local_secret_envelope":1,"local_project_policy":1,"local_security_audit":1,"local_secret_authorized_mutation":1,"local_identity":1,"local_api_credential":1,"local_identity_provisioning":1,"local_owner_bootstrap":1,"local_owner_delivery_acknowledgement":1,"api_credential_pepper_binding":1}',
    updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE contract_name = 'local-control-core'
  AND contract_version = 8
  AND migration_id = '0015-local-owner-delivery-acknowledgements'
  AND capabilities = '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1,"local_secret_envelope":1,"local_project_policy":1,"local_security_audit":1,"local_secret_authorized_mutation":1,"local_identity":1,"local_api_credential":1,"local_identity_provisioning":1,"local_owner_bootstrap":1,"local_owner_delivery_acknowledgement":1}'
    `,
  ],
});
