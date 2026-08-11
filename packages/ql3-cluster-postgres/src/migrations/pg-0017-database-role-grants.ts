import { definePostgresSqlMigration } from './sqlMigration';

export const pg0017DatabaseRoleGrantsMigration = definePostgresSqlMigration({
  id: 'pg-0017-database-role-grants',
  statements: [
    `
DO $ql3$
DECLARE
  invalid_roles text[];
BEGIN
  SELECT array_agg(expected.role_name ORDER BY expected.role_name)
  INTO invalid_roles
  FROM (
    VALUES
      ('ql3_migration'),
      ('ql3_runtime'),
      ('ql3_admin'),
      ('ql3_worker_ingress')
  ) AS expected(role_name)
  LEFT JOIN pg_catalog.pg_roles roles
    ON roles.rolname = expected.role_name
  WHERE roles.rolname IS NULL
     OR roles.rolcanlogin IS NOT TRUE
     OR roles.rolsuper IS NOT FALSE
     OR roles.rolcreatedb IS NOT FALSE
     OR roles.rolcreaterole IS NOT FALSE
     OR roles.rolreplication IS NOT FALSE
     OR roles.rolbypassrls IS NOT FALSE;

  IF invalid_roles IS NOT NULL THEN
    RAISE EXCEPTION 'required QingLong database roles are missing or privileged: %',
      invalid_roles
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$ql3$
    `.trim(),
    'REVOKE ALL ON SCHEMA "ql3" FROM PUBLIC',
    'REVOKE ALL ON ALL TABLES IN SCHEMA "ql3" FROM PUBLIC',
    `
DO $ql3$
BEGIN
  EXECUTE format(
    'REVOKE CONNECT ON DATABASE %I FROM PUBLIC',
    current_database()
  );
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO ql3_migration, ql3_runtime, ql3_admin, ql3_worker_ingress',
    current_database()
  );
END
$ql3$
    `.trim(),
    'GRANT USAGE ON SCHEMA "ql3" TO ql3_runtime',
    'GRANT SELECT ON "ql3"."schema_migrations", "ql3"."schema_capabilities" TO ql3_runtime',
    'GRANT SELECT, INSERT, UPDATE ON "ql3"."runs", "ql3"."run_attempts", "ql3"."worker_sessions", "ql3"."run_dispatch_leases", "ql3"."run_recovery_controls", "ql3"."run_retry_policies" TO ql3_runtime',
    'GRANT SELECT, INSERT ON "ql3"."run_events" TO ql3_runtime',
    'GRANT SELECT, INSERT, UPDATE ON "ql3"."projects" TO ql3_runtime',
    'GRANT SELECT, INSERT ON "ql3"."project_role_bindings" TO ql3_runtime',
    'GRANT SELECT ON "ql3"."identity_subjects", "ql3"."api_credentials", "ql3"."worker_execution_attestations", "ql3"."task_definitions", "ql3"."task_definition_revisions", "ql3"."task_execution_revisions", "ql3"."triggers", "ql3"."trigger_revisions" TO ql3_runtime',
    'GRANT SELECT, UPDATE ON "ql3"."trigger_schedules" TO ql3_runtime',
    'GRANT INSERT ON "ql3"."security_audit_events" TO ql3_runtime',
    'GRANT USAGE ON SCHEMA "ql3" TO ql3_admin',
    'GRANT SELECT ON "ql3"."schema_migrations", "ql3"."schema_capabilities" TO ql3_admin',
    'GRANT SELECT ON "ql3"."projects" TO ql3_admin',
    'GRANT SELECT, INSERT, UPDATE ON "ql3"."identity_subjects" TO ql3_admin',
    'GRANT SELECT, INSERT ON "ql3"."api_credentials", "ql3"."security_audit_events", "ql3"."identity_subject_mutations", "ql3"."api_credential_mutations" TO ql3_admin',
    'GRANT SELECT, INSERT, UPDATE ON "ql3"."worker_credentials" TO ql3_admin',
    'GRANT SELECT, INSERT ON "ql3"."worker_credential_mutations" TO ql3_admin',
    'GRANT SELECT, INSERT ON "ql3"."worker_credential_deliveries", "ql3"."worker_credential_stage_discards" TO ql3_admin',
    'GRANT SELECT, INSERT, UPDATE ON "ql3"."task_definitions", "ql3"."triggers", "ql3"."trigger_schedules" TO ql3_admin',
    'GRANT SELECT, INSERT ON "ql3"."task_definition_revisions", "ql3"."task_execution_revisions", "ql3"."trigger_revisions" TO ql3_admin',
    'GRANT USAGE ON SCHEMA "ql3" TO ql3_worker_ingress',
    'GRANT SELECT ON "ql3"."schema_migrations", "ql3"."schema_capabilities", "ql3"."run_attempts", "ql3"."run_dispatch_leases", "ql3"."worker_credentials" TO ql3_worker_ingress',
    'GRANT SELECT, INSERT, UPDATE ON "ql3"."worker_sessions" TO ql3_worker_ingress',
    'GRANT SELECT, INSERT ON "ql3"."worker_credential_deliveries" TO ql3_worker_ingress',
    'GRANT SELECT, INSERT ON "ql3"."worker_execution_attestations" TO ql3_worker_ingress',
    'GRANT INSERT ON "ql3"."security_audit_events" TO ql3_worker_ingress',
    `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 16,
      migration_id = 'pg-0017-database-role-grants',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 15
    AND migration_id = 'pg-0016-worker-credential-stage-discard-ledger'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 15'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
    `.trim(),
  ],
});
