import { CAPABILITIES_V51 } from './pg-0052-automation-management-identity-keyset-ledger';
import { definePostgresSqlMigration } from './sqlMigration';

export const CAPABILITIES_V52 = CAPABILITIES_V51.replace(
  '"plugin_package_workflow_admission":1,',
  '"plugin_package_workflow_admission":1,"plugin_package_workflow_run_list":1,',
);

export const pg0053PluginPackageWorkflowRunListIndexMigration =
  definePostgresSqlMigration({
    id: 'pg-0053-plugin-package-workflow-run-list-index',
    statements: [
      `CREATE INDEX ql3_plugin_package_workflow_admission_workflow_history_idx ON "ql3"."plugin_package_workflow_admissions" (project_id, package_name, workflow_id, admitted_at_ms, run_id)`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 52,
      migration_id = 'pg-0053-plugin-package-workflow-run-list-index',
      capabilities = '${CAPABILITIES_V52}'::jsonb,
      updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 51
    AND migration_id = 'pg-0052-automation-management-identity-keyset-ledger'
    AND capabilities = '${CAPABILITIES_V51}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 51'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
