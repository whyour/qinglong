import { definePostgresSqlMigration } from './sqlMigration';

export const POSTGRESQL_RUN_RETRY_POLICY_TABLE = 'run_retry_policies';

export const pg0003RunRetryPolicyMigration = definePostgresSqlMigration({
  id: 'pg-0003-run-retry-policy',
  statements: [
    `
ALTER TABLE "ql3"."runs"
ADD COLUMN legacy_cron_id integer
  CONSTRAINT ql3_runs_legacy_cron_id_check
  CHECK (legacy_cron_id IS NULL OR legacy_cron_id >= 1)
    `.trim(),
    `
CREATE TABLE "ql3"."${POSTGRESQL_RUN_RETRY_POLICY_TABLE}" (
  run_id varchar(36) PRIMARY KEY,
  max_attempts integer NOT NULL
    CONSTRAINT ql3_run_retry_policies_max_attempts_check
    CHECK (max_attempts BETWEEN 1 AND 16),
  retry_on_lost boolean NOT NULL,
  safety varchar(16) NOT NULL
    CONSTRAINT ql3_run_retry_policies_safety_check
    CHECK (safety IN ('unknown', 'idempotent', 'deduplicated')),
  backoff_base_ms bigint NOT NULL
    CONSTRAINT ql3_run_retry_policies_backoff_base_check
    CHECK (backoff_base_ms BETWEEN 0 AND 86400000),
  backoff_max_ms bigint NOT NULL
    CONSTRAINT ql3_run_retry_policies_backoff_max_check
    CHECK (backoff_max_ms BETWEEN backoff_base_ms AND 86400000),
  next_attempt_at_ms bigint
    CONSTRAINT ql3_run_retry_policies_next_attempt_check
    CHECK (next_attempt_at_ms IS NULL OR next_attempt_at_ms >= 0),
  version integer NOT NULL DEFAULT 0
    CONSTRAINT ql3_run_retry_policies_version_check
    CHECK (version >= 0),
  created_at_ms bigint NOT NULL
    CONSTRAINT ql3_run_retry_policies_created_at_check
    CHECK (created_at_ms >= 0),
  updated_at_ms bigint NOT NULL
    CONSTRAINT ql3_run_retry_policies_updated_at_check
    CHECK (updated_at_ms >= created_at_ms),
  CONSTRAINT ql3_run_retry_policies_run_fk
    FOREIGN KEY (run_id) REFERENCES "ql3"."runs" (id) ON DELETE CASCADE
)
    `.trim(),
    `
CREATE INDEX ql3_run_retry_policies_due_idx
ON "ql3"."${POSTGRESQL_RUN_RETRY_POLICY_TABLE}" (next_attempt_at_ms, run_id)
WHERE next_attempt_at_ms IS NOT NULL
    `.trim(),
    `
CREATE INDEX ql3_runs_lost_retry_idx
ON "ql3"."runs" (execution_owner, status, id)
    `.trim(),
    `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 2,
      migration_id = 'pg-0003-run-retry-policy',
      capabilities = '{"run_core":1,"run_retry_policy":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 1
    AND migration_id = 'pg-0002-run-core'
    AND capabilities = '{"run_core":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 1'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
    `.trim(),
  ],
});
