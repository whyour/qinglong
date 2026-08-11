import { CAPABILITIES_V50 } from './pg-0051-automation-management-boundary';
import { definePostgresSqlMigration } from './sqlMigration';

export const CAPABILITIES_V51 = CAPABILITIES_V50.replace(
  '"automation_management_boundary":1,',
  '"automation_management_boundary":1,"automation_management_identity_keyset_ledger":1,',
);

export const pg0052AutomationManagementIdentityKeysetLedgerMigration =
  definePostgresSqlMigration({
    id: 'pg-0052-automation-management-identity-keyset-ledger',
    statements: [
      `ALTER TABLE "ql3"."plugin_package_identity_keyset_ledger" DROP CONSTRAINT ql3_plugin_package_identity_keyset_authority_check`,
      `ALTER TABLE "ql3"."plugin_package_identity_keyset_ledger" ADD CONSTRAINT ql3_plugin_package_identity_keyset_authority_check CHECK (authority IN ('plugin-package-management', 'worker-credential-management', 'automation-management'))`,
      `REVOKE ALL ON "ql3"."plugin_package_identity_keyset_ledger" FROM ql3_automation_manager`,
      `GRANT SELECT, INSERT, UPDATE ON "ql3"."plugin_package_identity_keyset_ledger" TO ql3_automation_manager`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 51,
      migration_id = 'pg-0052-automation-management-identity-keyset-ledger',
      capabilities = '${CAPABILITIES_V51}'::jsonb,
      updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 50
    AND migration_id = 'pg-0051-automation-management-boundary'
    AND capabilities = '${CAPABILITIES_V50}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 50'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
