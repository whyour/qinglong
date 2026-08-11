import { definePostgresSqlMigration } from './sqlMigration';

export const pg0009WorkerSessionRunLeaseMigration = definePostgresSqlMigration({
  id: 'pg-0009-worker-session-run-lease',
  statements: [
    `
CREATE TABLE "ql3"."worker_sessions" (
  worker_id varchar(128) PRIMARY KEY,
  session_id varchar(36) NOT NULL,
  generation integer NOT NULL,
  status varchar(16) NOT NULL,
  version integer NOT NULL,
  capabilities_json varchar(16384) NOT NULL,
  capabilities_hash char(64) NOT NULL,
  max_concurrent_runs integer NOT NULL,
  available_slots integer NOT NULL,
  registered_at_ms bigint NOT NULL,
  last_heartbeat_at_ms bigint NOT NULL,
  lease_expires_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT ql3_worker_sessions_worker_id_check
    CHECK (worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT ql3_worker_sessions_session_id_check
    CHECK (session_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT ql3_worker_sessions_generation_check
    CHECK (generation BETWEEN 1 AND 2147483647),
  CONSTRAINT ql3_worker_sessions_status_check
    CHECK (status IN ('online', 'draining', 'offline')),
  CONSTRAINT ql3_worker_sessions_version_check
    CHECK (version BETWEEN 0 AND 2147483647),
  CONSTRAINT ql3_worker_sessions_capabilities_check
    CHECK (octet_length(capabilities_json) BETWEEN 2 AND 16384),
  CONSTRAINT ql3_worker_sessions_capabilities_hash_check
    CHECK (capabilities_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ql3_worker_sessions_concurrency_check
    CHECK (
      max_concurrent_runs BETWEEN 1 AND 1024
      AND available_slots BETWEEN 0 AND max_concurrent_runs
    ),
  CONSTRAINT ql3_worker_sessions_timestamps_check
    CHECK (
      registered_at_ms >= 0
      AND last_heartbeat_at_ms >= registered_at_ms
      AND updated_at_ms >= last_heartbeat_at_ms
      AND (
        (status = 'offline' AND lease_expires_at_ms >= last_heartbeat_at_ms)
        OR (status <> 'offline' AND lease_expires_at_ms > last_heartbeat_at_ms)
      )
    ),
  CONSTRAINT ql3_worker_sessions_status_capacity_check
    CHECK (status = 'online' OR available_slots = 0)
)
    `.trim(),
    `
CREATE INDEX ql3_worker_sessions_available_idx
ON "ql3"."worker_sessions" (worker_id)
WHERE status = 'online' AND available_slots > 0
    `.trim(),
    `
ALTER TABLE "ql3"."run_attempts"
  ADD COLUMN worker_session_id varchar(36),
  ADD COLUMN worker_generation integer,
  ADD COLUMN lease_generation integer,
  ADD COLUMN lease_version integer,
  ADD COLUMN lease_token_digest char(64),
  ADD COLUMN offer_id varchar(128),
  ADD CONSTRAINT ql3_run_attempts_worker_session_id_check
    CHECK (
      worker_session_id IS NULL
      OR worker_session_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  ADD CONSTRAINT ql3_run_attempts_worker_generation_check
    CHECK (worker_generation IS NULL OR worker_generation BETWEEN 1 AND 2147483647),
  ADD CONSTRAINT ql3_run_attempts_lease_generation_check
    CHECK (lease_generation IS NULL OR lease_generation BETWEEN 1 AND 2147483647),
  ADD CONSTRAINT ql3_run_attempts_lease_version_check
    CHECK (lease_version IS NULL OR lease_version BETWEEN 0 AND 2147483647),
  ADD CONSTRAINT ql3_run_attempts_lease_token_digest_check
    CHECK (lease_token_digest IS NULL OR lease_token_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT ql3_run_attempts_offer_id_check
    CHECK (offer_id IS NULL OR char_length(offer_id) BETWEEN 1 AND 128),
  ADD CONSTRAINT ql3_run_attempts_remote_fence_shape_check
    CHECK (
      (
        worker_session_id IS NULL
        AND worker_generation IS NULL
        AND lease_generation IS NULL
        AND lease_version IS NULL
        AND lease_token_digest IS NULL
        AND offer_id IS NULL
      )
      OR (
        worker_id IS NOT NULL
        AND worker_session_id IS NOT NULL
        AND worker_generation IS NOT NULL
        AND lease_generation IS NOT NULL
        AND lease_version IS NOT NULL
        AND lease_token_digest IS NOT NULL
        AND offer_id IS NOT NULL
      )
    )
    `.trim(),
    `
CREATE TABLE "ql3"."run_dispatch_leases" (
  attempt_id varchar(36) PRIMARY KEY,
  run_id varchar(36) NOT NULL,
  status varchar(16) NOT NULL,
  version integer NOT NULL,
  lease_generation integer NOT NULL,
  worker_id varchar(128) NOT NULL,
  worker_session_id varchar(36) NOT NULL,
  worker_generation integer NOT NULL,
  lease_token_digest char(64) NOT NULL,
  offer_id varchar(128) NOT NULL,
  acquired_at_ms bigint NOT NULL,
  renewed_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  released_at_ms bigint,
  release_reason varchar(32),
  completed_at_ms bigint,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT ql3_run_dispatch_leases_status_check
    CHECK (status IN ('leased', 'released', 'completed')),
  CONSTRAINT ql3_run_dispatch_leases_version_check
    CHECK (version BETWEEN 0 AND 2147483647),
  CONSTRAINT ql3_run_dispatch_leases_generation_check
    CHECK (lease_generation BETWEEN 1 AND 2147483647),
  CONSTRAINT ql3_run_dispatch_leases_worker_generation_check
    CHECK (worker_generation BETWEEN 1 AND 2147483647),
  CONSTRAINT ql3_run_dispatch_leases_token_digest_check
    CHECK (lease_token_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ql3_run_dispatch_leases_offer_id_check
    CHECK (char_length(offer_id) BETWEEN 1 AND 128),
  CONSTRAINT ql3_run_dispatch_leases_timestamps_check
    CHECK (
      acquired_at_ms >= 0
      AND renewed_at_ms >= acquired_at_ms
      AND expires_at_ms > renewed_at_ms
      AND updated_at_ms >= acquired_at_ms
    ),
  CONSTRAINT ql3_run_dispatch_leases_state_shape_check
    CHECK (
      (
        status = 'leased'
        AND released_at_ms IS NULL
        AND release_reason IS NULL
        AND completed_at_ms IS NULL
      )
      OR (
        status = 'released'
        AND released_at_ms IS NOT NULL
        AND release_reason IN (
          'declined', 'shutdown', 'start_failed', 'capacity_changed', 'lease_expired'
        )
        AND completed_at_ms IS NULL
      )
      OR (
        status = 'completed'
        AND released_at_ms IS NULL
        AND release_reason IS NULL
        AND completed_at_ms IS NOT NULL
      )
    ),
  CONSTRAINT ql3_run_dispatch_leases_attempt_fk
    FOREIGN KEY (attempt_id) REFERENCES "ql3"."run_attempts" (id) ON DELETE CASCADE,
  CONSTRAINT ql3_run_dispatch_leases_run_fk
    FOREIGN KEY (run_id) REFERENCES "ql3"."runs" (id) ON DELETE CASCADE,
  CONSTRAINT ql3_run_dispatch_leases_worker_fk
    FOREIGN KEY (worker_id) REFERENCES "ql3"."worker_sessions" (worker_id)
)
    `.trim(),
    `
CREATE UNIQUE INDEX ql3_run_dispatch_leases_offer_uidx
ON "ql3"."run_dispatch_leases" (offer_id)
    `.trim(),
    `
CREATE INDEX ql3_run_dispatch_leases_worker_active_idx
ON "ql3"."run_dispatch_leases"
  (worker_id, worker_session_id, worker_generation, expires_at_ms, attempt_id)
WHERE status = 'leased'
    `.trim(),
    `
CREATE INDEX ql3_run_dispatch_leases_expiry_idx
ON "ql3"."run_dispatch_leases" (expires_at_ms, attempt_id)
WHERE status = 'leased'
    `.trim(),
    `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 8,
      migration_id = 'pg-0009-worker-session-run-lease',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"cluster_recovery":1,"cluster_recovery_claim":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"worker_session":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 7
    AND migration_id = 'pg-0008-run-recovery-claims'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"cluster_recovery":1,"cluster_recovery_claim":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 7'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
    `.trim(),
  ],
});
