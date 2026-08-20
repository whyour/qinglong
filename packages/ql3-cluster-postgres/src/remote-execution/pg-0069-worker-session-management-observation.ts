import { CAPABILITIES_V67 } from '../run-management/pg-0068-cancellation-dispatch-project-keyset';
import { definePostgresSqlMigration } from '../migrations/sqlMigration';

export const CAPABILITIES_V68 = CAPABILITIES_V67.replace(
  '"worker_session":1}',
  '"worker_session":1,"worker_session_observation":1}',
);

export const pg0069WorkerSessionManagementObservationMigration =
  definePostgresSqlMigration({
    id: 'pg-0069-worker-session-management-observation',
    statements: [
      `REVOKE ALL ON "ql3"."worker_sessions" FROM ql3_worker_credential_manager`,
      `GRANT SELECT ON "ql3"."worker_sessions" TO ql3_worker_credential_manager`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 68, migration_id = 'pg-0069-worker-session-management-observation', capabilities = '${CAPABILITIES_V68}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 67 AND migration_id = 'pg-0068-cancellation-dispatch-project-keyset' AND capabilities = '${CAPABILITIES_V67}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 67' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });
