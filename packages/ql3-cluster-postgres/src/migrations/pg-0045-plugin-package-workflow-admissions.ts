import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V43 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_automation_publication":1,"plugin_package_automation_start_guard":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V44 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_automation_publication":1,"plugin_package_automation_start_guard":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"plugin_package_workflow_admission":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0045PluginPackageWorkflowAdmissionsMigration =
  definePostgresSqlMigration({
    id: 'pg-0045-plugin-package-workflow-admissions',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_workflow_admissions" (
  plan_digest char(64) PRIMARY KEY,
  plan_id varchar(128) NOT NULL,
  run_id varchar(36) NOT NULL,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  lock_digest char(64) NOT NULL,
  generation integer NOT NULL,
  generation_digest char(64) NOT NULL,
  materialized_revision_digest char(64) NOT NULL,
  publication_digest char(64) NOT NULL,
  workflow_id varchar(63) NOT NULL,
  workflow_definition_digest char(64) NOT NULL,
  step_count integer NOT NULL,
  admitted_at_ms bigint NOT NULL,
  final_run_version integer NOT NULL,
  final_run_event_sequence integer NOT NULL,
  receipt_digest char(64) NOT NULL,
  plan_json jsonb NOT NULL,
  receipt_json jsonb NOT NULL,
  CONSTRAINT plugin_package_workflow_admissions_plan_id_key
    UNIQUE (plan_id),
  CONSTRAINT plugin_package_workflow_admissions_run_id_key
    UNIQUE (run_id),
  CONSTRAINT plugin_package_workflow_admissions_receipt_digest_key
    UNIQUE (receipt_digest),
  CONSTRAINT ql3_plugin_package_workflow_admission_run_fk
    FOREIGN KEY (run_id) REFERENCES "ql3"."runs" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_admission_publication_fk
    FOREIGN KEY (publication_digest)
    REFERENCES "ql3"."plugin_package_automation_publications" (
      publication_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_admission_identity_check CHECK (
    plan_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' AND
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    workflow_id ~ '^[a-z][a-z0-9-]{0,62}$' AND
    generation BETWEEN 1 AND 2147483647 AND
    step_count BETWEEN 1 AND 128 AND
    admitted_at_ms >= 0 AND
    final_run_version = step_count + 1 AND
    final_run_event_sequence = step_count + 1
  ),
  CONSTRAINT ql3_plugin_package_workflow_admission_digest_check CHECK (
    plan_digest ~ '^[0-9a-f]{64}$' AND
    lock_digest ~ '^[0-9a-f]{64}$' AND
    generation_digest ~ '^[0-9a-f]{64}$' AND
    materialized_revision_digest ~ '^[0-9a-f]{64}$' AND
    publication_digest ~ '^[0-9a-f]{64}$' AND
    workflow_definition_digest ~ '^[0-9a-f]{64}$' AND
    receipt_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_workflow_admission_json_check CHECK (
    jsonb_typeof(plan_json) = 'object' AND
    octet_length(plan_json::text) BETWEEN 2 AND 262144 AND
    plan_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-workflow-execution-plan@v1',
      'planId', plan_id, 'planDigest', plan_digest, 'runId', run_id,
      'plannedAtMs', admitted_at_ms
    ) AND
    plan_json -> 'target' @> jsonb_build_object(
      'projectId', project_id, 'packageName', package_name,
      'installationId', installation_id, 'lockDigest', lock_digest,
      'generation', generation, 'generationDigest', generation_digest,
      'materializedRevisionDigest', materialized_revision_digest,
      'publicationDigest', publication_digest, 'workflowId', workflow_id,
      'workflowDefinitionDigest', workflow_definition_digest
    ) AND
    jsonb_typeof(plan_json -> 'steps') = 'array' AND
    jsonb_array_length(plan_json -> 'steps') = step_count AND
    jsonb_typeof(receipt_json) = 'object' AND
    octet_length(receipt_json::text) BETWEEN 2 AND 262144 AND
    receipt_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-workflow-admission-receipt@v1',
      'planId', plan_id, 'planDigest', plan_digest, 'runId', run_id,
      'publicationDigest', publication_digest, 'workflowId', workflow_id,
      'finalRunVersion', final_run_version,
      'finalRunEventSequence', final_run_event_sequence,
      'admittedAtMs', admitted_at_ms, 'receiptDigest', receipt_digest
    ) AND
    jsonb_typeof(receipt_json -> 'steps') = 'array' AND
    jsonb_array_length(receipt_json -> 'steps') = step_count
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_workflow_admission_plan_run_key ON "ql3"."plugin_package_workflow_admissions" (plan_digest, run_id)`,
      `CREATE INDEX ql3_plugin_package_workflow_admission_target_idx ON "ql3"."plugin_package_workflow_admissions" (project_id, package_name, admitted_at_ms, plan_digest)`,
      `
CREATE TABLE "ql3"."plugin_package_workflow_admission_steps" (
  plan_digest char(64) NOT NULL,
  run_id varchar(36) NOT NULL,
  step_key varchar(63) NOT NULL,
  step_run_id varchar(128) NOT NULL,
  task_id varchar(63) NOT NULL,
  task_definition_ref varchar(512) NOT NULL,
  task_definition_digest char(64) NOT NULL,
  needs_json jsonb NOT NULL,
  initial_status varchar(16) NOT NULL,
  mutation_id varchar(128) NOT NULL,
  event_id varchar(36) NOT NULL,
  PRIMARY KEY (plan_digest, step_key),
  CONSTRAINT plugin_package_workflow_admission_steps_step_run_id_key
    UNIQUE (step_run_id),
  CONSTRAINT plugin_package_workflow_admission_steps_mutation_id_key
    UNIQUE (mutation_id),
  CONSTRAINT plugin_package_workflow_admission_steps_event_id_key
    UNIQUE (event_id),
  CONSTRAINT ql3_plugin_package_workflow_admission_step_admission_fk
    FOREIGN KEY (plan_digest, run_id)
    REFERENCES "ql3"."plugin_package_workflow_admissions" (
      plan_digest, run_id
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_admission_step_run_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_admission_step_mutation_fk
    FOREIGN KEY (mutation_id)
    REFERENCES "ql3"."step_run_mutations" (mutation_id) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_admission_step_event_fk
    FOREIGN KEY (event_id)
    REFERENCES "ql3"."run_events" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_workflow_admission_step_identity_check CHECK (
    step_key ~ '^[a-z][a-z0-9-]{0,62}$' AND
    task_id ~ '^[a-z][a-z0-9-]{0,62}$' AND
    initial_status IN ('pending', 'ready') AND
    task_definition_digest ~ '^[0-9a-f]{64}$' AND
    jsonb_typeof(needs_json) = 'array' AND
    jsonb_array_length(needs_json) BETWEEN 0 AND 127
  )
)
      `.trim(),
      `CREATE INDEX ql3_plugin_package_workflow_admission_step_task_idx ON "ql3"."plugin_package_workflow_admission_steps" (task_id, task_definition_digest, plan_digest)`,
      `
CREATE FUNCTION "ql3"."plugin_package_workflow_admission_snapshot"(
  p_project_id varchar,
  p_package_name varchar,
  p_publication_digest char(64)
)
RETURNS TABLE(publication_json jsonb, revision_json jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
BEGIN
  IF NOT pg_has_role(session_user, 'ql3_runtime', 'member') THEN
    RAISE EXCEPTION 'Runtime authority is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT "ql3"."plugin_package_automation_start_allowed"(
    p_project_id, p_package_name, p_publication_digest
  ) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT publication.publication_json, revision.revision_json
  FROM "ql3"."plugin_package_automation_publications" AS publication
  JOIN "ql3"."plugin_package_materialized_revisions" AS revision
    ON revision.generation_digest = publication.generation_digest
   AND revision.revision_digest =
     publication.materialized_revision_digest
  WHERE publication.project_id = p_project_id
    AND publication.package_name = p_package_name
    AND publication.publication_digest = p_publication_digest
    AND publication.state = 'active'
  FOR SHARE OF publication, revision;
END
$ql3$
      `.trim(),
      `
REVOKE ALL
ON "ql3"."plugin_package_workflow_admissions",
   "ql3"."plugin_package_workflow_admission_steps"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."plugin_package_workflow_admissions",
   "ql3"."plugin_package_workflow_admission_steps"
TO ql3_runtime
      `.trim(),
      `
REVOKE ALL ON FUNCTION
  "ql3"."plugin_package_workflow_admission_snapshot"(
    varchar, varchar, char(64)
  )
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT EXECUTE ON FUNCTION
  "ql3"."plugin_package_workflow_admission_snapshot"(
    varchar, varchar, char(64)
  )
TO ql3_runtime
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 44,
      migration_id = 'pg-0045-plugin-package-workflow-admissions',
      capabilities = '${CAPABILITIES_V44}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 43
    AND migration_id = 'pg-0044-plugin-package-automation-start-guard'
    AND capabilities = '${CAPABILITIES_V43}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 43'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
