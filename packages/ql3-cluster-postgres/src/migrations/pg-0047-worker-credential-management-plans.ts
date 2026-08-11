import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V45 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_automation_publication":1,"plugin_package_automation_start_guard":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"plugin_package_workflow_admission":1,"plugin_package_workflow_task_attempt_admission":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V46 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_automation_publication":1,"plugin_package_automation_start_guard":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"plugin_package_workflow_admission":1,"plugin_package_workflow_task_attempt_admission":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_management_plan":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0047WorkerCredentialManagementPlansMigration =
  definePostgresSqlMigration({
    id: 'pg-0047-worker-credential-management-plans',
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
      ('ql3_worker_credential_manager'),
      ('ql3_worker_credential_executor')
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
    RAISE EXCEPTION
      'required QingLong Worker credential roles are missing or privileged: %',
      invalid_roles
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$ql3$
      `.trim(),
      `
DO $ql3$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO ql3_worker_credential_manager, ql3_worker_credential_executor',
    current_database()
  );
END
$ql3$
      `.trim(),
      `GRANT USAGE ON SCHEMA "ql3" TO ql3_worker_credential_manager, ql3_worker_credential_executor`,
      `GRANT SELECT ON "ql3"."schema_migrations", "ql3"."schema_capabilities" TO ql3_worker_credential_manager, ql3_worker_credential_executor`,
      `
CREATE TABLE "ql3"."worker_credential_management_plans" (
  action_ref varchar(255) PRIMARY KEY,
  authority_project_id varchar(128) NOT NULL,
  action varchar(16) NOT NULL,
  delivery_id varchar(36) NOT NULL,
  worker_id varchar(128) NOT NULL,
  credential_id varchar(64) NOT NULL,
  previous_credential_id varchar(64),
  credential_not_before_at_ms bigint NOT NULL,
  credential_expires_at_ms bigint NOT NULL,
  deployment_target_digest char(64) NOT NULL,
  deployment_generation varchar(128) NOT NULL,
  requested_by_type varchar(16) NOT NULL,
  requested_by_id varchar(255) NOT NULL,
  planned_at_ms bigint NOT NULL,
  expires_at_ms bigint NOT NULL,
  plan_digest char(64) NOT NULL,
  preview_digest char(64) NOT NULL,
  plan_json jsonb NOT NULL,
  CONSTRAINT ql3_worker_credential_management_plan_project_fk
    FOREIGN KEY (authority_project_id)
    REFERENCES "ql3"."projects" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_worker_credential_management_plan_identity_check CHECK (
    action_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' AND
    action IN ('issue', 'rotate') AND
    delivery_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
    worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' AND
    (previous_credential_id IS NULL OR
      previous_credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$') AND
    deployment_generation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    requested_by_type = 'user' AND
    char_length(requested_by_id) BETWEEN 1 AND 255 AND
    requested_by_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ql3_worker_credential_management_plan_action_check CHECK (
    (action = 'issue' AND previous_credential_id IS NULL) OR
    (action = 'rotate' AND previous_credential_id IS NOT NULL AND
      previous_credential_id <> credential_id)
  ),
  CONSTRAINT ql3_worker_credential_management_plan_digest_check CHECK (
    deployment_target_digest ~ '^[0-9a-f]{64}$' AND
    plan_digest ~ '^[0-9a-f]{64}$' AND
    preview_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_worker_credential_management_plan_time_check CHECK (
    planned_at_ms >= 0 AND
    expires_at_ms > planned_at_ms AND
    expires_at_ms - planned_at_ms <= 900000 AND
    credential_not_before_at_ms >= planned_at_ms AND
    credential_expires_at_ms > credential_not_before_at_ms AND
    credential_expires_at_ms - credential_not_before_at_ms <= 63072000000
  ),
  CONSTRAINT ql3_worker_credential_management_plan_json_check CHECK (
    jsonb_typeof(plan_json) = 'object' AND
    octet_length(plan_json::text) BETWEEN 2 AND 16384 AND
    plan_json @> jsonb_build_object(
      'schema', 'qinglong/worker-credential-management-plan@v1',
      'actionRef', action_ref,
      'authorityProjectId', authority_project_id,
      'action', action,
      'planDigest', plan_digest,
      'previewDigest', preview_digest,
      'requestedBy', jsonb_build_object(
        'type', requested_by_type,
        'id', requested_by_id
      ),
      'plannedAtMs', planned_at_ms,
      'expiresAtMs', expires_at_ms,
      'target', jsonb_build_object(
        'deliveryId', delivery_id,
        'workerId', worker_id,
        'credentialId', credential_id,
        'previousCredentialId', previous_credential_id,
        'credentialNotBeforeAtMs', credential_not_before_at_ms,
        'credentialExpiresAtMs', credential_expires_at_ms,
        'deploymentTargetDigest', deployment_target_digest,
        'deploymentGeneration', deployment_generation
      )
    )
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_worker_credential_management_plan_digest_key ON "ql3"."worker_credential_management_plans" (plan_digest)`,
      `CREATE UNIQUE INDEX ql3_worker_credential_management_plan_delivery_key ON "ql3"."worker_credential_management_plans" (delivery_id)`,
      `CREATE INDEX ql3_worker_credential_management_plan_expiry_idx ON "ql3"."worker_credential_management_plans" (expires_at_ms, action_ref)`,
      `REVOKE ALL ON "ql3"."worker_credential_management_plans" FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress, ql3_worker_credential_manager, ql3_worker_credential_executor`,
      `GRANT SELECT, INSERT ON "ql3"."worker_credential_management_plans" TO ql3_worker_credential_manager`,
      `GRANT SELECT ON "ql3"."worker_credential_management_plans" TO ql3_worker_credential_executor`,
      `GRANT SELECT ON "ql3"."projects", "ql3"."project_role_bindings" TO ql3_worker_credential_manager, ql3_worker_credential_executor`,
      `GRANT SELECT, INSERT ON "ql3"."security_audit_events" TO ql3_worker_credential_manager, ql3_worker_credential_executor`,
      `GRANT SELECT, INSERT, UPDATE ON "ql3"."approval_requests" TO ql3_worker_credential_manager`,
      `GRANT SELECT, UPDATE ON "ql3"."approval_requests" TO ql3_worker_credential_executor`,
      `GRANT SELECT, INSERT ON "ql3"."approved_action_dispatches" TO ql3_worker_credential_executor`,
      `GRANT SELECT, INSERT ON "ql3"."worker_credentials", "ql3"."worker_credential_mutations", "ql3"."worker_credential_deliveries", "ql3"."worker_credential_stage_discards" TO ql3_worker_credential_executor`,
      `GRANT EXECUTE ON FUNCTION "ql3"."lock_approval_policy_fence"(varchar, varchar, varchar, integer, integer) TO ql3_worker_credential_manager, ql3_worker_credential_executor`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 46,
      migration_id = 'pg-0047-worker-credential-management-plans',
      capabilities = '${CAPABILITIES_V46}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 45
    AND migration_id =
      'pg-0046-plugin-package-workflow-task-attempt-admissions'
    AND capabilities = '${CAPABILITIES_V45}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 45'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
