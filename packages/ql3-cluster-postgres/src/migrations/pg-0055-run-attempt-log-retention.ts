import { CAPABILITIES_V53 } from './pg-0054-approval-management-boundary';
import { definePostgresSqlMigration } from './sqlMigration';

export const CAPABILITIES_V54 = CAPABILITIES_V53.replace(
  '"run_core":1,',
  '"run_attempt_log_retention":1,"run_core":1,',
);

export const pg0055RunAttemptLogRetentionMigration =
  definePostgresSqlMigration({
    id: 'pg-0055-run-attempt-log-retention',
    statements: [
      `
CREATE TABLE "ql3"."run_attempt_log_retention_controls" (
  attempt_id varchar(36) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  run_id varchar(36) NOT NULL,
  log_artifact_id varchar(36) NOT NULL,
  executor_type varchar(32) NOT NULL,
  finished_at_ms bigint NOT NULL,
  eligible_at_ms bigint NOT NULL,
  state varchar(16) NOT NULL,
  claim_owner varchar(128),
  claim_token varchar(64),
  claim_version integer NOT NULL DEFAULT 1,
  claim_expires_at_ms bigint,
  next_claim_at_ms bigint,
  failure_count integer NOT NULL DEFAULT 0,
  last_failure_code varchar(64),
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT ql3_run_log_retention_control_artifact_key
    UNIQUE (log_artifact_id),
  CONSTRAINT ql3_run_log_retention_control_identity_check CHECK (
    char_length(project_id) BETWEEN 1 AND 128
    AND char_length(run_id) BETWEEN 1 AND 36
    AND char_length(attempt_id) BETWEEN 1 AND 36
    AND log_artifact_id ~ '^wlog-[a-f0-9]{30}$'
    AND executor_type = 'remote_worker'
  ),
  CONSTRAINT ql3_run_log_retention_control_time_check CHECK (
    finished_at_ms >= 0
    AND eligible_at_ms >= finished_at_ms
    AND created_at_ms >= 0
    AND updated_at_ms >= created_at_ms
  ),
  CONSTRAINT ql3_run_log_retention_control_state_check
    CHECK (state IN ('claimed', 'retry', 'manual')),
  CONSTRAINT ql3_run_log_retention_control_claim_owner_check CHECK (
    claim_owner IS NULL
    OR claim_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_run_log_retention_control_claim_token_check CHECK (
    claim_token IS NULL
    OR claim_token ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,63}$'
  ),
  CONSTRAINT ql3_run_log_retention_control_claim_version_check
    CHECK (claim_version BETWEEN 1 AND 2147483647),
  CONSTRAINT ql3_run_log_retention_control_claim_expiry_check
    CHECK (claim_expires_at_ms IS NULL OR claim_expires_at_ms >= 0),
  CONSTRAINT ql3_run_log_retention_control_next_claim_check
    CHECK (next_claim_at_ms IS NULL OR next_claim_at_ms >= 0),
  CONSTRAINT ql3_run_log_retention_control_failure_count_check
    CHECK (failure_count BETWEEN 0 AND 2147483647),
  CONSTRAINT ql3_run_log_retention_control_failure_code_check CHECK (
    last_failure_code IS NULL
    OR last_failure_code IN (
      'artifact_unavailable',
      'artifact_integrity_mismatch',
      'retirement_record_unavailable'
    )
  ),
  CONSTRAINT ql3_run_log_retention_control_state_shape_check CHECK (
    (
      state = 'claimed'
      AND claim_owner IS NOT NULL
      AND claim_token IS NOT NULL
      AND claim_expires_at_ms IS NOT NULL
      AND next_claim_at_ms IS NULL
    )
    OR (
      state = 'retry'
      AND claim_owner IS NULL
      AND claim_token IS NULL
      AND claim_expires_at_ms IS NULL
      AND next_claim_at_ms IS NOT NULL
      AND last_failure_code IS NOT NULL
    )
    OR (
      state = 'manual'
      AND claim_owner IS NULL
      AND claim_token IS NULL
      AND claim_expires_at_ms IS NULL
      AND next_claim_at_ms IS NULL
      AND last_failure_code IS NOT NULL
    )
  ),
  CONSTRAINT ql3_run_log_retention_control_attempt_fk
    FOREIGN KEY (attempt_id) REFERENCES "ql3"."run_attempts" (id)
    ON DELETE CASCADE,
  CONSTRAINT ql3_run_log_retention_control_run_fk
    FOREIGN KEY (run_id) REFERENCES "ql3"."runs" (id)
    ON DELETE CASCADE
)
      `.trim(),
      `
CREATE TABLE "ql3"."run_attempt_log_artifact_tombstones" (
  log_artifact_id varchar(36) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  run_id varchar(36) NOT NULL,
  attempt_id varchar(36) NOT NULL,
  executor_type varchar(32) NOT NULL,
  finished_at_ms bigint NOT NULL,
  eligible_at_ms bigint NOT NULL,
  retired_at_ms bigint NOT NULL,
  disposition varchar(16) NOT NULL,
  byte_length bigint NOT NULL,
  truncated varchar(16) NOT NULL,
  maximum_bytes bigint,
  truncation_observed_at_ms bigint,
  record_digest char(64) NOT NULL,
  CONSTRAINT ql3_run_log_tombstone_attempt_key UNIQUE (attempt_id),
  CONSTRAINT ql3_run_log_tombstone_identity_check CHECK (
    char_length(project_id) BETWEEN 1 AND 128
    AND char_length(run_id) BETWEEN 1 AND 36
    AND char_length(attempt_id) BETWEEN 1 AND 36
    AND log_artifact_id ~ '^wlog-[a-f0-9]{30}$'
    AND executor_type = 'remote_worker'
  ),
  CONSTRAINT ql3_run_log_tombstone_time_check CHECK (
    finished_at_ms >= 0
    AND eligible_at_ms >= finished_at_ms
    AND retired_at_ms >= eligible_at_ms
  ),
  CONSTRAINT ql3_run_log_tombstone_disposition_check CHECK (
    disposition IN ('deleted', 'already_absent')
    AND (disposition <> 'already_absent' OR byte_length = 0)
  ),
  CONSTRAINT ql3_run_log_tombstone_size_check
    CHECK (byte_length BETWEEN 0 AND 1073741824),
  CONSTRAINT ql3_run_log_tombstone_truncation_check CHECK (
    (
      truncated = 'unknown'
      AND maximum_bytes IS NULL
      AND truncation_observed_at_ms IS NULL
    )
    OR (
      truncated IN ('true', 'false')
      AND maximum_bytes >= 1
      AND truncation_observed_at_ms >= 0
    )
  ),
  CONSTRAINT ql3_run_log_tombstone_digest_check
    CHECK (record_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ql3_run_log_tombstone_attempt_fk
    FOREIGN KEY (attempt_id) REFERENCES "ql3"."run_attempts" (id)
    ON DELETE CASCADE,
  CONSTRAINT ql3_run_log_tombstone_run_fk
    FOREIGN KEY (run_id) REFERENCES "ql3"."runs" (id)
    ON DELETE CASCADE
)
      `.trim(),
      `CREATE INDEX ql3_run_log_retention_retry_idx ON "ql3"."run_attempt_log_retention_controls" (next_claim_at_ms, finished_at_ms, attempt_id) WHERE state = 'retry'`,
      `CREATE INDEX ql3_run_log_retention_claim_expiry_idx ON "ql3"."run_attempt_log_retention_controls" (claim_expires_at_ms, finished_at_ms, attempt_id) WHERE state = 'claimed'`,
      `CREATE INDEX ql3_run_log_tombstone_retired_idx ON "ql3"."run_attempt_log_artifact_tombstones" (retired_at_ms, attempt_id)`,
      `CREATE INDEX ql3_run_log_retention_candidate_idx ON "ql3"."run_attempts" (finished_at_ms, id) WHERE executor_type = 'remote_worker' AND log_artifact_id IS NOT NULL AND status IN ('succeeded', 'failed', 'cancelled', 'timed_out')`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "ql3"."run_attempt_log_retention_controls" TO ql3_runtime`,
      `GRANT SELECT, INSERT ON "ql3"."run_attempt_log_artifact_tombstones" TO ql3_runtime`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 54,
      migration_id = 'pg-0055-run-attempt-log-retention',
      capabilities = '${CAPABILITIES_V54}'::jsonb,
      updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 53
    AND migration_id = 'pg-0054-approval-management-boundary'
    AND capabilities = '${CAPABILITIES_V53}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 53'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
