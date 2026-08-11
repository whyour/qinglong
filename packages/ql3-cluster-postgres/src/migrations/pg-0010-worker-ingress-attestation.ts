import { definePostgresSqlMigration } from './sqlMigration';

export const pg0010WorkerIngressAttestationMigration =
  definePostgresSqlMigration({
    id: 'pg-0010-worker-ingress-attestation',
    statements: [
      `
CREATE TABLE "ql3"."worker_credentials" (
  credential_id varchar(64) NOT NULL,
  version integer NOT NULL,
  state varchar(16) NOT NULL,
  worker_id varchar(128) NOT NULL,
  secret_digest char(64) NOT NULL,
  created_at_ms bigint NOT NULL,
  not_before_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  PRIMARY KEY (credential_id, version),
  CONSTRAINT ql3_worker_credentials_id_check
    CHECK (credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  CONSTRAINT ql3_worker_credentials_version_check
    CHECK (version BETWEEN 1 AND 2147483647),
  CONSTRAINT ql3_worker_credentials_state_check
    CHECK (state IN ('active', 'revoked')),
  CONSTRAINT ql3_worker_credentials_worker_id_check
    CHECK (worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT ql3_worker_credentials_digest_check
    CHECK (secret_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ql3_worker_credentials_lifetime_check
    CHECK (
      created_at_ms >= 0
      AND not_before_at_ms >= created_at_ms
      AND expires_at_ms > not_before_at_ms
    )
)
      `.trim(),
      `
CREATE INDEX ql3_worker_credentials_latest_idx
ON "ql3"."worker_credentials" (credential_id, version DESC)
      `.trim(),
      `
CREATE TABLE "ql3"."worker_credential_mutations" (
  mutation_id varchar(36) PRIMARY KEY,
  operation varchar(16) NOT NULL,
  credential_id varchar(64) NOT NULL,
  credential_version integer NOT NULL,
  expected_previous_version integer NOT NULL,
  changed_by_type varchar(32) NOT NULL,
  changed_by_id varchar(255) NOT NULL,
  audit_event_id uuid NOT NULL,
  created_at_ms bigint NOT NULL,
  CONSTRAINT ql3_worker_credential_mutations_id_check
    CHECK (mutation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT ql3_worker_credential_mutations_operation_check
    CHECK (operation IN ('issue', 'rotate', 'revoke')),
  CONSTRAINT ql3_worker_credential_mutations_version_check
    CHECK (
      credential_version BETWEEN 1 AND 2147483647
      AND expected_previous_version BETWEEN 0 AND 2147483646
      AND credential_version = expected_previous_version + 1
    ),
  CONSTRAINT ql3_worker_credential_mutations_actor_check
    CHECK (
      changed_by_type IN ('user', 'system')
      AND char_length(changed_by_id) BETWEEN 1 AND 255
    ),
  CONSTRAINT ql3_worker_credential_mutations_created_at_check
    CHECK (created_at_ms >= 0),
  CONSTRAINT ql3_worker_credential_mutations_credential_fk
    FOREIGN KEY (credential_id, credential_version)
    REFERENCES "ql3"."worker_credentials" (credential_id, version),
  CONSTRAINT ql3_worker_credential_mutations_audit_fk
    FOREIGN KEY (audit_event_id)
    REFERENCES "ql3"."security_audit_events" (event_id)
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_worker_credential_mutations_audit_uidx
ON "ql3"."worker_credential_mutations" (audit_event_id)
      `.trim(),
      `
CREATE TABLE "ql3"."worker_execution_attestations" (
  attestation_id varchar(36) PRIMARY KEY,
  run_id varchar(36) NOT NULL,
  attempt_id varchar(36) NOT NULL,
  sequence integer NOT NULL,
  state varchar(16) NOT NULL,
  worker_id varchar(128) NOT NULL,
  worker_session_id varchar(36) NOT NULL,
  worker_generation integer NOT NULL,
  lease_token_digest char(64) NOT NULL,
  lease_generation integer NOT NULL,
  lease_version integer NOT NULL,
  offer_id varchar(128) NOT NULL,
  callback_sequence integer NOT NULL,
  executor_handle varchar(512) NOT NULL,
  journal_revision integer NOT NULL,
  received_at_ms bigint NOT NULL,
  CONSTRAINT ql3_worker_execution_attestations_id_check
    CHECK (attestation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT ql3_worker_execution_attestations_sequence_check
    CHECK (sequence BETWEEN 1 AND 2147483647),
  CONSTRAINT ql3_worker_execution_attestations_state_check
    CHECK (state IN ('running', 'stopped')),
  CONSTRAINT ql3_worker_execution_attestations_worker_id_check
    CHECK (worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT ql3_worker_execution_attestations_session_id_check
    CHECK (worker_session_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT ql3_worker_execution_attestations_generation_check
    CHECK (
      worker_generation BETWEEN 1 AND 2147483647
      AND lease_generation BETWEEN 1 AND 2147483647
      AND lease_version BETWEEN 0 AND 2147483647
    ),
  CONSTRAINT ql3_worker_execution_attestations_digest_check
    CHECK (lease_token_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ql3_worker_execution_attestations_offer_check
    CHECK (char_length(offer_id) BETWEEN 1 AND 128),
  CONSTRAINT ql3_worker_execution_attestations_callback_check
    CHECK (callback_sequence BETWEEN 0 AND 2147483647),
  CONSTRAINT ql3_worker_execution_attestations_handle_check
    CHECK (char_length(executor_handle) BETWEEN 1 AND 512),
  CONSTRAINT ql3_worker_execution_attestations_journal_check
    CHECK (journal_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT ql3_worker_execution_attestations_received_at_check
    CHECK (received_at_ms >= 0),
  CONSTRAINT ql3_worker_execution_attestations_run_fk
    FOREIGN KEY (run_id) REFERENCES "ql3"."runs" (id) ON DELETE CASCADE,
  CONSTRAINT ql3_worker_execution_attestations_attempt_fk
    FOREIGN KEY (attempt_id) REFERENCES "ql3"."run_attempts" (id) ON DELETE CASCADE,
  CONSTRAINT ql3_worker_execution_attestations_worker_fk
    FOREIGN KEY (worker_id) REFERENCES "ql3"."worker_sessions" (worker_id)
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_worker_execution_attestations_sequence_uidx
ON "ql3"."worker_execution_attestations"
  (attempt_id, lease_generation, sequence)
      `.trim(),
      `
CREATE INDEX ql3_worker_execution_attestations_exact_idx
ON "ql3"."worker_execution_attestations"
  (attempt_id, lease_generation, sequence DESC)
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 9,
      migration_id = 'pg-0010-worker-ingress-attestation',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"cluster_recovery":1,"cluster_recovery_claim":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"worker_attestation":1,"worker_credential":1,"worker_session":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 8
    AND migration_id = 'pg-0009-worker-session-run-lease'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"cluster_recovery":1,"cluster_recovery_claim":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"worker_session":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 8'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
