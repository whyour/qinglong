import { definePostgresSqlMigration } from './sqlMigration';

export const pg0013TaskExecutionRevisionsMigration =
  definePostgresSqlMigration({
    id: 'pg-0013-task-execution-revisions',
    statements: [
      `
CREATE TABLE "ql3"."task_execution_revisions" (
  project_id varchar(128) NOT NULL,
  task_id varchar(128) NOT NULL,
  source_revision integer NOT NULL,
  task_revision varchar(96) NOT NULL,
  source_content_digest char(64) NOT NULL,
  executor_type varchar(32) NOT NULL,
  plan_schema varchar(64) NOT NULL,
  plan_json jsonb NOT NULL,
  content_digest char(64) NOT NULL,
  created_at_ms bigint NOT NULL,
  CONSTRAINT task_execution_revisions_pkey
    PRIMARY KEY (project_id, task_id, source_revision, executor_type),
  CONSTRAINT ql3_task_execution_revisions_source_fk
    FOREIGN KEY (project_id, task_id, source_revision)
    REFERENCES "ql3"."task_definition_revisions"
      (project_id, task_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_task_execution_revisions_identity_check CHECK (
    task_revision = concat(
      'qltd:v1:', source_revision::text, ':', source_content_digest
    )
    AND source_content_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_task_execution_revisions_executor_check
    CHECK (executor_type = 'remote_worker'),
  CONSTRAINT ql3_task_execution_revisions_plan_check CHECK (
    plan_schema = 'qinglong/command-execution@v1'
    AND jsonb_typeof(plan_json) = 'object'
    AND octet_length(plan_json::text) BETWEEN 2 AND 98304
  ),
  CONSTRAINT ql3_task_execution_revisions_digest_check
    CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ql3_task_execution_revisions_created_check
    CHECK (created_at_ms >= 0)
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_task_execution_revisions_ref_uidx
ON "ql3"."task_execution_revisions"
  (project_id, task_id, task_revision, executor_type)
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 12,
      migration_id = 'pg-0013-task-execution-revisions',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_session":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 11
    AND migration_id = 'pg-0012-task-trigger-definitions'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_recovery":1,"cluster_recovery_claim":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_session":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 11'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
