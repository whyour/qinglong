import { defineLocalSqliteMigration } from './sqlMigration';

export const local0028CapabilityV14Migration = defineLocalSqliteMigration({
  id: '0028-capability-v14',
  statements: [
    `
UPDATE "QingLong3SchemaCapabilities"
SET contract_version = 14,
    migration_id = '0027-task-definitions',
    capabilities = '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1,"local_secret_envelope":1,"local_project_policy":1,"local_security_audit":1,"local_secret_authorized_mutation":1,"local_identity":1,"local_api_credential":1,"local_identity_provisioning":1,"local_owner_bootstrap":1,"local_owner_delivery_acknowledgement":1,"api_credential_pepper_binding":1,"local_owner_pepper_catalog":1,"local_owner_credential_recovery":1,"local_owner_pepper_reference_inspection":1,"local_owner_pepper_material_gc":1,"local_owner_delivery_acknowledgement_gc":1,"task_definition":1}',
    updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE contract_name = 'local-control-core'
  AND contract_version = 13
  AND migration_id = '0025-local-owner-delivery-acknowledgement-gc'
  AND capabilities = '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1,"local_secret_envelope":1,"local_project_policy":1,"local_security_audit":1,"local_secret_authorized_mutation":1,"local_identity":1,"local_api_credential":1,"local_identity_provisioning":1,"local_owner_bootstrap":1,"local_owner_delivery_acknowledgement":1,"api_credential_pepper_binding":1,"local_owner_pepper_catalog":1,"local_owner_credential_recovery":1,"local_owner_pepper_reference_inspection":1,"local_owner_pepper_material_gc":1,"local_owner_delivery_acknowledgement_gc":1}'
    `,
  ],
});
