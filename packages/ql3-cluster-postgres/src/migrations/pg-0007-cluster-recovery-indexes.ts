import { definePostgresSqlMigration } from './sqlMigration';

export const pg0007ClusterRecoveryIndexesMigration = definePostgresSqlMigration(
  {
    id: 'pg-0007-cluster-recovery-indexes',
    statements: [
      `
CREATE INDEX ql3_runs_runtime_recovery_idx
ON "ql3"."runs" (created_at_ms, id)
WHERE execution_owner = 'runtime'
  AND status IN ('created', 'dispatching', 'running')
      `.trim(),
      `
CREATE INDEX ql3_run_attempts_recovery_idx
ON "ql3"."run_attempts" (lease_expires_at_ms, created_at_ms, id)
WHERE status IN ('claimed', 'starting', 'running')
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 6,
      migration_id = 'pg-0007-cluster-recovery-indexes',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"cluster_recovery":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 5
    AND migration_id = 'pg-0006-identity-credential-administration'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 5'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  },
);
