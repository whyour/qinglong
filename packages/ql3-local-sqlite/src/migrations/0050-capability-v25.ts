import { defineLocalSqliteMigration } from './sqlMigration';

const PREVIOUS_CAPABILITIES =
  '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1,"local_secret_envelope":1,"local_project_policy":1,"local_security_audit":1,"local_secret_authorized_mutation":1,"local_identity":1,"local_api_credential":1,"local_identity_provisioning":1,"local_owner_bootstrap":1,"local_owner_delivery_acknowledgement":1,"api_credential_pepper_binding":1,"local_owner_pepper_catalog":1,"local_owner_credential_recovery":1,"local_owner_pepper_reference_inspection":1,"local_owner_pepper_material_gc":1,"local_owner_delivery_acknowledgement_gc":1,"task_definition":1,"local_execution_revision_digest":1,"trigger_definition":1,"legacy_adoption_ledger":1,"local_scheduler_admission":1,"plugin_package_install":1,"approved_action":1,"plugin_package_admission":1,"approved_action_execution":1,"plugin_package_proposal":1,"plugin_package_materialized_revision":1,"plugin_package_task_reconciliation":1}';
const NEXT_CAPABILITIES =
  '{"run_core":1,"run_retry_policy":1,"completion_receipt_journal":1,"local_dispatch_plan":1,"local_secret_envelope":1,"local_project_policy":1,"local_security_audit":1,"local_secret_authorized_mutation":1,"local_identity":1,"local_api_credential":1,"local_identity_provisioning":1,"local_owner_bootstrap":1,"local_owner_delivery_acknowledgement":1,"api_credential_pepper_binding":1,"local_owner_pepper_catalog":1,"local_owner_credential_recovery":1,"local_owner_pepper_reference_inspection":1,"local_owner_pepper_material_gc":1,"local_owner_delivery_acknowledgement_gc":1,"task_definition":1,"local_execution_revision_digest":1,"trigger_definition":1,"legacy_adoption_ledger":1,"local_scheduler_admission":1,"plugin_package_install":1,"approved_action":1,"plugin_package_admission":1,"approved_action_execution":1,"plugin_package_proposal":1,"plugin_package_materialized_revision":1,"plugin_package_task_reconciliation":1,"project_tool_definition_snapshot":1}';

export const local0050CapabilityV25Migration = defineLocalSqliteMigration({
  id: '0050-capability-v25',
  statements: [
    `
UPDATE "QingLong3SchemaCapabilities"
SET contract_version = 25,
    migration_id = '0049-project-tool-definition-snapshots',
    capabilities = '${NEXT_CAPABILITIES}',
    updated_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE contract_name = 'local-control-core'
  AND contract_version = 24
  AND migration_id = '0047-plugin-package-task-reconciliations'
  AND capabilities = '${PREVIOUS_CAPABILITIES}'
    `,
  ],
});
