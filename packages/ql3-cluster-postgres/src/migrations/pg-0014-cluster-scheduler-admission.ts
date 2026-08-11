import { definePostgresSqlMigration } from './sqlMigration';

export const pg0014ClusterSchedulerAdmissionMigration =
  definePostgresSqlMigration({
    id: 'pg-0014-cluster-scheduler-admission',
    statements: [
      `
ALTER TABLE "ql3"."runs"
  ALTER COLUMN trigger_id TYPE varchar(128)
      `.trim(),
      `
CREATE TABLE "ql3"."trigger_schedules" (
  project_id varchar(128) NOT NULL,
  trigger_id varchar(128) NOT NULL,
  trigger_revision integer NOT NULL,
  next_fire_at_ms bigint,
  last_scheduled_at_ms bigint,
  state_version integer NOT NULL,
  claim_owner varchar(128),
  claim_token uuid,
  claim_version integer NOT NULL,
  claim_expires_at_ms bigint,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT trigger_schedules_pkey PRIMARY KEY (project_id, trigger_id),
  CONSTRAINT ql3_trigger_schedules_revision_fk
    FOREIGN KEY (project_id, trigger_id, trigger_revision)
    REFERENCES "ql3"."trigger_revisions" (project_id, trigger_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_trigger_schedules_revision_check
    CHECK (trigger_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT ql3_trigger_schedules_cursor_check CHECK (
    next_fire_at_ms IS NULL OR next_fire_at_ms >= 0
  ),
  CONSTRAINT ql3_trigger_schedules_last_check CHECK (
    last_scheduled_at_ms IS NULL OR last_scheduled_at_ms >= 0
  ),
  CONSTRAINT ql3_trigger_schedules_version_check CHECK (
    state_version BETWEEN 0 AND 2147483647
    AND claim_version BETWEEN 0 AND 2147483647
  ),
  CONSTRAINT ql3_trigger_schedules_claim_owner_check CHECK (
    claim_owner IS NULL
    OR (
      char_length(claim_owner) BETWEEN 1 AND 128
      AND claim_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    )
  ),
  CONSTRAINT ql3_trigger_schedules_claim_shape_check CHECK (
    (
      claim_owner IS NULL
      AND claim_token IS NULL
      AND claim_expires_at_ms IS NULL
    )
    OR (
      claim_owner IS NOT NULL
      AND claim_token IS NOT NULL
      AND claim_version >= 1
      AND claim_expires_at_ms IS NOT NULL
      AND claim_expires_at_ms > updated_at_ms
    )
  ),
  CONSTRAINT ql3_trigger_schedules_updated_check CHECK (updated_at_ms >= 0)
)
      `.trim(),
      `
INSERT INTO "ql3"."trigger_schedules" (
  project_id, trigger_id, trigger_revision, next_fire_at_ms,
  last_scheduled_at_ms, state_version, claim_owner, claim_token,
  claim_version, claim_expires_at_ms, updated_at_ms
)
SELECT
  project_id, trigger_id, current_revision, NULL, NULL, 0,
  NULL, NULL, 0, NULL, updated_at_ms
FROM "ql3"."triggers"
      `.trim(),
      `
CREATE INDEX ql3_trigger_schedules_due_idx
ON "ql3"."trigger_schedules"
  (next_fire_at_ms NULLS FIRST, claim_expires_at_ms, project_id, trigger_id)
      `.trim(),
      `
CREATE INDEX ql3_trigger_schedules_claim_expiry_idx
ON "ql3"."trigger_schedules"
  (claim_expires_at_ms, project_id, trigger_id)
WHERE claim_token IS NOT NULL
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 13,
      migration_id = 'pg-0014-cluster-scheduler-admission',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_session":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 12
    AND migration_id = 'pg-0013-task-execution-revisions'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_session":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 12'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
