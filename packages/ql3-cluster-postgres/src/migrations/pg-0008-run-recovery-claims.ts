import { definePostgresSqlMigration } from './sqlMigration';

export const pg0008RunRecoveryClaimsMigration = definePostgresSqlMigration({
  id: 'pg-0008-run-recovery-claims',
  statements: [
    `
CREATE TABLE "ql3"."run_recovery_controls" (
  target_kind varchar(16) NOT NULL,
  target_id varchar(36) NOT NULL,
  run_id varchar(36) NOT NULL,
  attempt_id varchar(36),
  target_status varchar(32) NOT NULL,
  target_created_at_ms bigint NOT NULL,
  observed_at_ms bigint NOT NULL,
  state varchar(16) NOT NULL,
  claim_owner varchar(128),
  claim_token varchar(64),
  claim_version integer NOT NULL DEFAULT 0,
  claim_expires_at_ms bigint,
  next_claim_at_ms bigint,
  failure_count integer NOT NULL DEFAULT 0,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT run_recovery_controls_pkey
    PRIMARY KEY (target_kind, target_id),
  CONSTRAINT ql3_run_recovery_controls_target_kind_check
    CHECK (target_kind IN ('run', 'attempt')),
  CONSTRAINT ql3_run_recovery_controls_target_id_check
    CHECK (char_length(target_id) >= 1),
  CONSTRAINT ql3_run_recovery_controls_target_shape_check
    CHECK (
      (
        target_kind = 'run'
        AND target_id = run_id
        AND attempt_id IS NULL
        AND target_status IN ('created', 'dispatching', 'running')
      )
      OR (
        target_kind = 'attempt'
        AND target_id = attempt_id
        AND attempt_id IS NOT NULL
        AND target_status IN ('claimed', 'starting', 'running')
      )
    ),
  CONSTRAINT ql3_run_recovery_controls_target_created_at_check
    CHECK (target_created_at_ms >= 0),
  CONSTRAINT ql3_run_recovery_controls_observed_at_check
    CHECK (observed_at_ms >= 0),
  CONSTRAINT ql3_run_recovery_controls_state_check
    CHECK (state IN ('available', 'claimed', 'retry', 'manual', 'resolved')),
  CONSTRAINT ql3_run_recovery_controls_claim_owner_check
    CHECK (
      claim_owner IS NULL
      OR claim_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
  CONSTRAINT ql3_run_recovery_controls_claim_token_check
    CHECK (
      claim_token IS NULL
      OR claim_token ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,63}$'
    ),
  CONSTRAINT ql3_run_recovery_controls_claim_version_check
    CHECK (claim_version BETWEEN 0 AND 2147483647),
  CONSTRAINT ql3_run_recovery_controls_claim_expires_at_check
    CHECK (claim_expires_at_ms IS NULL OR claim_expires_at_ms >= 0),
  CONSTRAINT ql3_run_recovery_controls_next_claim_at_check
    CHECK (next_claim_at_ms IS NULL OR next_claim_at_ms >= 0),
  CONSTRAINT ql3_run_recovery_controls_failure_count_check
    CHECK (failure_count BETWEEN 0 AND 2147483647),
  CONSTRAINT ql3_run_recovery_controls_created_at_check
    CHECK (created_at_ms >= 0),
  CONSTRAINT ql3_run_recovery_controls_updated_at_check
    CHECK (updated_at_ms >= created_at_ms),
  CONSTRAINT ql3_run_recovery_controls_state_shape_check
    CHECK (
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
      )
      OR (
        state IN ('available', 'manual', 'resolved')
        AND claim_owner IS NULL
        AND claim_token IS NULL
        AND claim_expires_at_ms IS NULL
        AND next_claim_at_ms IS NULL
      )
    ),
  CONSTRAINT ql3_run_recovery_controls_run_fk
    FOREIGN KEY (run_id)
    REFERENCES "ql3"."runs" (id)
    ON DELETE CASCADE,
  CONSTRAINT ql3_run_recovery_controls_attempt_fk
    FOREIGN KEY (attempt_id)
    REFERENCES "ql3"."run_attempts" (id)
    ON DELETE CASCADE
)
    `.trim(),
    `
CREATE INDEX ql3_run_recovery_controls_available_idx
ON "ql3"."run_recovery_controls"
  (target_created_at_ms, target_kind, target_id)
WHERE state IN ('available', 'resolved')
    `.trim(),
    `
CREATE INDEX ql3_run_recovery_controls_retry_idx
ON "ql3"."run_recovery_controls"
  (next_claim_at_ms, target_created_at_ms, target_kind, target_id)
WHERE state = 'retry'
    `.trim(),
    `
CREATE INDEX ql3_run_recovery_controls_claim_expiry_idx
ON "ql3"."run_recovery_controls"
  (claim_expires_at_ms, target_created_at_ms, target_kind, target_id)
WHERE state = 'claimed'
    `.trim(),
    `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 7,
      migration_id = 'pg-0008-run-recovery-claims',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"cluster_recovery":1,"cluster_recovery_claim":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 6
    AND migration_id = 'pg-0007-cluster-recovery-indexes'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"cluster_recovery":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 6'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
    `.trim(),
  ],
});
