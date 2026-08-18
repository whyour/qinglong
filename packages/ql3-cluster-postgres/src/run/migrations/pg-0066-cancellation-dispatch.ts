import { CAPABILITIES_V64 } from '../../approved-action/pg-0065-approved-action-manual-recovery';
import { definePostgresSqlMigration } from '../../migrations/sqlMigration';

export const POSTGRESQL_CANCELLATION_DISPATCH_TABLE =
  'run_cancellation_dispatches';

export const CAPABILITIES_V65 = CAPABILITIES_V64.replace(
  '"run_core":1,',
  '"run_cancellation_dispatch":1,"run_core":1,',
);

export const pg0066CancellationDispatchMigration =
  definePostgresSqlMigration({
    id: 'pg-0066-cancellation-dispatch',
    statements: [
      `CREATE UNIQUE INDEX ql3_run_attempts_run_id_uidx ON "ql3"."run_attempts" (run_id, id)`,
      `
CREATE TABLE "ql3"."${POSTGRESQL_CANCELLATION_DISPATCH_TABLE}" (
  run_id varchar(36) PRIMARY KEY,
  attempt_id varchar(36) NOT NULL,
  status varchar(32) NOT NULL,
  version integer NOT NULL,
  dispatch_count integer NOT NULL,
  next_attempt_at_ms bigint,
  lease_owner varchar(128),
  lease_token_digest char(64),
  lease_expires_at_ms bigint,
  last_result varchar(32),
  last_dispatched_at_ms bigint,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT ql3_run_cancellation_dispatch_run_fk
    FOREIGN KEY (run_id) REFERENCES "ql3"."runs" (id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT ql3_run_cancellation_dispatch_attempt_fk
    FOREIGN KEY (run_id, attempt_id)
    REFERENCES "ql3"."run_attempts" (run_id, id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT ql3_run_cancellation_dispatch_status_check CHECK (
    status IN ('pending', 'leased', 'retry_wait', 'dispatched', 'blocked')
  ),
  CONSTRAINT ql3_run_cancellation_dispatch_result_check CHECK (
    last_result IS NULL OR last_result IN (
      'termination_requested', 'already_exited', 'identity_mismatch',
      'pid_mismatch', 'unsupported', 'invalid', 'controller_missing',
      'handle_missing', 'dispatch_error'
    )
  ),
  CONSTRAINT ql3_run_cancellation_dispatch_counter_check CHECK (
    version BETWEEN 0 AND 2147483647 AND
    dispatch_count BETWEEN 0 AND 2147483647 AND
    version >= dispatch_count AND
    ((status = 'pending' AND version = 0 AND dispatch_count = 0) OR
     (status <> 'pending' AND dispatch_count >= 1))
  ),
  CONSTRAINT ql3_run_cancellation_dispatch_time_check CHECK (
    (next_attempt_at_ms IS NULL OR next_attempt_at_ms >= 0) AND
    (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0) AND
    (last_dispatched_at_ms IS NULL OR last_dispatched_at_ms >= 0) AND
    created_at_ms >= 0 AND updated_at_ms >= created_at_ms
  ),
  CONSTRAINT ql3_run_cancellation_dispatch_lease_digest_check CHECK (
    lease_token_digest IS NULL OR lease_token_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_run_cancellation_dispatch_shape_check CHECK (
    (status = 'leased' AND next_attempt_at_ms IS NULL AND
      lease_owner IS NOT NULL AND
      octet_length(lease_owner) BETWEEN 1 AND 128 AND
      lease_owner !~ '[[:cntrl:]]' AND
      lease_token_digest IS NOT NULL AND lease_expires_at_ms IS NOT NULL) OR
    (status IN ('pending', 'retry_wait') AND next_attempt_at_ms IS NOT NULL AND
      lease_owner IS NULL AND lease_token_digest IS NULL AND
      lease_expires_at_ms IS NULL) OR
    (status IN ('dispatched', 'blocked') AND next_attempt_at_ms IS NULL AND
      lease_owner IS NULL AND lease_token_digest IS NULL AND
      lease_expires_at_ms IS NULL AND last_result IS NOT NULL)
  ),
  CONSTRAINT ql3_run_cancellation_dispatch_result_state_check CHECK (
    (status = 'pending' AND last_result IS NULL) OR
    (status IN ('leased', 'retry_wait') AND
      (last_result IS NULL OR last_result IN (
        'controller_missing', 'handle_missing', 'dispatch_error'
      ))) OR
    (status = 'dispatched' AND last_result IN (
      'termination_requested', 'already_exited'
    )) OR
    (status = 'blocked' AND last_result IN (
      'identity_mismatch', 'pid_mismatch', 'unsupported', 'invalid'
    ))
  )
)
      `.trim(),
      `CREATE INDEX ql3_run_cancellation_dispatch_due_idx ON "ql3"."${POSTGRESQL_CANCELLATION_DISPATCH_TABLE}" (next_attempt_at_ms, run_id) WHERE status IN ('pending', 'retry_wait')`,
      `CREATE INDEX ql3_run_cancellation_dispatch_lease_expiry_idx ON "ql3"."${POSTGRESQL_CANCELLATION_DISPATCH_TABLE}" (lease_expires_at_ms, run_id) WHERE status = 'leased'`,
      `REVOKE ALL ON "ql3"."${POSTGRESQL_CANCELLATION_DISPATCH_TABLE}" FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress, ql3_worker_credential_manager, ql3_worker_credential_executor, ql3_automation_manager, ql3_approval_manager, ql3_run_manager`,
      `GRANT SELECT, INSERT, UPDATE ON "ql3"."${POSTGRESQL_CANCELLATION_DISPATCH_TABLE}" TO ql3_runtime`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 65, migration_id = 'pg-0066-cancellation-dispatch', capabilities = '${CAPABILITIES_V65}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 64 AND migration_id = 'pg-0065-approved-action-manual-recovery' AND capabilities = '${CAPABILITIES_V64}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 64' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });
