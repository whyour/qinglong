import { CAPABILITIES_V65 } from '../run/migrations/pg-0066-cancellation-dispatch';
import { definePostgresSqlMigration } from '../migrations/sqlMigration';

export const CAPABILITIES_V66 = CAPABILITIES_V65.replace(
  '"run_cancellation_dispatch":1,',
  '"run_cancellation_dispatch":1,"run_cancellation_dispatch_management":1,',
);

export const pg0067CancellationDispatchManagementMigration =
  definePostgresSqlMigration({
    id: 'pg-0067-cancellation-dispatch-management',
    statements: [
      `ALTER TABLE "ql3"."run_cancellation_dispatches" DROP CONSTRAINT ql3_run_cancellation_dispatch_result_state_check`,
      `
ALTER TABLE "ql3"."run_cancellation_dispatches"
ADD CONSTRAINT ql3_run_cancellation_dispatch_result_state_check CHECK (
  (status = 'pending' AND last_result IS NULL) OR
  (status IN ('leased', 'retry_wait') AND last_result IN (
    'identity_mismatch', 'pid_mismatch', 'unsupported', 'invalid',
    'controller_missing', 'handle_missing', 'dispatch_error'
  )) OR
  (status = 'leased' AND last_result IS NULL) OR
  (status = 'dispatched' AND last_result IN (
    'termination_requested', 'already_exited'
  )) OR
  (status = 'blocked' AND last_result IN (
    'identity_mismatch', 'pid_mismatch', 'unsupported', 'invalid'
  ))
)
      `.trim(),
      `GRANT SELECT ON "ql3"."run_cancellation_dispatches" TO ql3_run_manager`,
      `GRANT UPDATE (status, version, next_attempt_at_ms, updated_at_ms) ON "ql3"."run_cancellation_dispatches" TO ql3_run_manager`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 66, migration_id = 'pg-0067-cancellation-dispatch-management', capabilities = '${CAPABILITIES_V66}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 65 AND migration_id = 'pg-0066-cancellation-dispatch' AND capabilities = '${CAPABILITIES_V65}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 65' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });
