import { CAPABILITIES_V55 } from './pg-0056-run-management-boundary';
import { definePostgresSqlMigration } from '../migrations/sqlMigration';

export const CAPABILITIES_V56 = CAPABILITIES_V55.replace(
  '"run_management_boundary":1,',
  '"run_management_boundary":1,"run_management_stop":1,',
);

export const pg0057RunManagementStopBoundaryMigration =
  definePostgresSqlMigration({
    id: 'pg-0057-run-management-stop-boundary',
    statements: [
      `REVOKE UPDATE ON "ql3"."runs" FROM ql3_run_manager`,
      `GRANT UPDATE (cancel_requested_at_ms, cancel_reason, version, event_sequence) ON "ql3"."runs" TO ql3_run_manager`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 56,
      migration_id = 'pg-0057-run-management-stop-boundary',
      capabilities = '${CAPABILITIES_V56}'::jsonb,
      updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 55
    AND migration_id = 'pg-0056-run-management-boundary'
    AND capabilities = '${CAPABILITIES_V55}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 55'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
