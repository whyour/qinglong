import { definePostgresSqlMigration } from './sqlMigration';

export const pg0016WorkerCredentialStageDiscardLedgerMigration =
  definePostgresSqlMigration({
    id: 'pg-0016-worker-credential-stage-discard-ledger',
    statements: [
      `
CREATE TABLE "ql3"."worker_credential_stage_discards" (
  delivery_id varchar(36) NOT NULL,
  version integer NOT NULL,
  state varchar(32) NOT NULL,
  worker_id varchar(128) NOT NULL,
  credential_id varchar(64) NOT NULL,
  credential_version integer NOT NULL,
  previous_credential_id varchar(64),
  secret_digest char(64) NOT NULL,
  token_digest char(64) NOT NULL,
  deployment_target_digest char(64) NOT NULL,
  deployment_generation varchar(128) NOT NULL,
  staged_at_ms bigint NOT NULL,
  authorized_at_ms bigint NOT NULL,
  discarded_at_ms bigint,
  CONSTRAINT worker_credential_stage_discards_pkey
    PRIMARY KEY (delivery_id, version),
  CONSTRAINT ql3_worker_credential_stage_discards_version_check CHECK (
    version BETWEEN 1 AND 2
    AND credential_version = 1
  ),
  CONSTRAINT ql3_worker_credential_stage_discards_id_check CHECK (
    delivery_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT ql3_worker_credential_stage_discards_state_check CHECK (
    state IN ('discard_authorized', 'discarded')
  ),
  CONSTRAINT ql3_worker_credential_stage_discards_worker_check CHECK (
    char_length(worker_id) BETWEEN 1 AND 128
    AND worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_worker_credential_stage_discards_credential_check CHECK (
    char_length(credential_id) BETWEEN 1 AND 64
    AND credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    AND (
      previous_credential_id IS NULL
      OR (
        char_length(previous_credential_id) BETWEEN 1 AND 64
        AND previous_credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
        AND previous_credential_id <> credential_id
      )
    )
  ),
  CONSTRAINT ql3_worker_credential_stage_discards_digest_check CHECK (
    secret_digest ~ '^[0-9a-f]{64}$'
    AND token_digest ~ '^[0-9a-f]{64}$'
    AND deployment_target_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_worker_credential_stage_discards_generation_check CHECK (
    char_length(deployment_generation) BETWEEN 1 AND 128
    AND deployment_generation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_worker_credential_stage_discards_time_check CHECK (
    staged_at_ms >= 0
    AND authorized_at_ms >= 0
    AND (discarded_at_ms IS NULL OR discarded_at_ms >= authorized_at_ms)
  ),
  CONSTRAINT ql3_worker_credential_stage_discards_state_shape_check CHECK (
    (
      version = 1
      AND state = 'discard_authorized'
      AND discarded_at_ms IS NULL
    )
    OR (
      version = 2
      AND state = 'discarded'
      AND discarded_at_ms IS NOT NULL
    )
  )
)
      `.trim(),
      `
CREATE INDEX ql3_worker_credential_stage_discards_recovery_idx
ON "ql3"."worker_credential_stage_discards"
  (state, delivery_id, version DESC)
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 15,
      migration_id = 'pg-0016-worker-credential-stage-discard-ledger',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 14
    AND migration_id = 'pg-0015-worker-credential-delivery-ledger'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_session":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 14'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
