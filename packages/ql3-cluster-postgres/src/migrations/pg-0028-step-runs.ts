import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V26 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V27 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0028StepRunsMigration = definePostgresSqlMigration({
  id: 'pg-0028-step-runs',
  statements: [
    `
DO $ql3$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ql3"."run_attempts" WHERE step_run_id IS NOT NULL
    UNION ALL
    SELECT 1 FROM "ql3"."run_events" WHERE step_run_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'legacy step_run_id cannot be upgraded without StepRun authority'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
    `.trim(),
    `
ALTER TABLE "ql3"."run_attempts"
ALTER COLUMN step_run_id TYPE varchar(128)
    `.trim(),
    `
ALTER TABLE "ql3"."run_events"
ALTER COLUMN step_run_id TYPE varchar(128)
    `.trim(),
    `
CREATE TABLE "ql3"."step_runs" (
  id varchar(128) PRIMARY KEY,
  run_id varchar(36) NOT NULL,
  parent_step_run_id varchar(128),
  step_key varchar(128) NOT NULL,
  kind varchar(32) NOT NULL,
  definition_ref varchar(512) NOT NULL,
  definition_digest char(64) NOT NULL,
  required boolean NOT NULL,
  status varchar(32) NOT NULL,
  version integer NOT NULL,
  attempt_count integer NOT NULL,
  input_ref varchar(512),
  output_ref varchar(512),
  approval_request_id varchar(128),
  ready_at_ms bigint,
  started_at_ms bigint,
  finished_at_ms bigint,
  result_code varchar(64),
  error_summary varchar(2048),
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  last_mutation_id varchar(128) NOT NULL,
  step_run_digest char(64) NOT NULL,
  step_run_json jsonb NOT NULL,
  CONSTRAINT ql3_step_runs_run_fk
    FOREIGN KEY (run_id) REFERENCES "ql3"."runs" (id) ON DELETE CASCADE,
  CONSTRAINT ql3_step_runs_identity_check CHECK (
    id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    (parent_step_run_id IS NULL OR
      (parent_step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
       parent_step_run_id <> id)) AND
    step_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    octet_length(definition_ref) BETWEEN 1 AND 512
  ),
  CONSTRAINT ql3_step_runs_kind_check CHECK (
    kind IN (
      'task', 'tool', 'model', 'agent', 'condition', 'approval',
      'subworkflow'
    )
  ),
  CONSTRAINT ql3_step_runs_status_check CHECK (
    status IN (
      'pending', 'ready', 'waiting_approval', 'running', 'lost',
      'succeeded', 'failed', 'skipped', 'cancelled', 'timed_out'
    )
  ),
  CONSTRAINT ql3_step_runs_digest_check CHECK (
    definition_digest ~ '^[0-9a-f]{64}$' AND
    step_run_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_step_runs_counter_check CHECK (
    version BETWEEN 1 AND 2147483647 AND
    attempt_count BETWEEN 0 AND 64
  ),
  CONSTRAINT ql3_step_runs_reference_check CHECK (
    (input_ref IS NULL OR octet_length(input_ref) BETWEEN 1 AND 512) AND
    (output_ref IS NULL OR octet_length(output_ref) BETWEEN 1 AND 512) AND
    (approval_request_id IS NULL OR
      approval_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  ),
  CONSTRAINT ql3_step_runs_time_check CHECK (
    created_at_ms >= 0 AND updated_at_ms >= created_at_ms AND
    (ready_at_ms IS NULL OR
      ready_at_ms BETWEEN created_at_ms AND updated_at_ms) AND
    (started_at_ms IS NULL OR
      (ready_at_ms IS NOT NULL AND
       started_at_ms BETWEEN ready_at_ms AND updated_at_ms)) AND
    (finished_at_ms IS NULL OR
      (finished_at_ms BETWEEN created_at_ms AND updated_at_ms AND
       (ready_at_ms IS NULL OR finished_at_ms >= ready_at_ms) AND
       (started_at_ms IS NULL OR finished_at_ms >= started_at_ms)))
  ),
  CONSTRAINT ql3_step_runs_state_shape_check CHECK (
    (status = 'pending' AND ready_at_ms IS NULL AND
      started_at_ms IS NULL AND finished_at_ms IS NULL) OR
    (status IN ('ready', 'waiting_approval') AND ready_at_ms IS NOT NULL AND
      started_at_ms IS NULL AND finished_at_ms IS NULL) OR
    (status IN ('running', 'lost') AND ready_at_ms IS NOT NULL AND
      started_at_ms IS NOT NULL AND finished_at_ms IS NULL) OR
    (status IN ('succeeded', 'failed', 'skipped', 'cancelled', 'timed_out')
      AND finished_at_ms IS NOT NULL)
  ),
  CONSTRAINT ql3_step_runs_approval_shape_check CHECK (
    status <> 'waiting_approval' OR approval_request_id IS NOT NULL
  ),
  CONSTRAINT ql3_step_runs_result_shape_check CHECK (
    (output_ref IS NULL OR status = 'succeeded') AND
    ((status = 'succeeded' AND result_code IS NULL AND
       error_summary IS NULL) OR
     (status IN ('failed', 'skipped', 'cancelled', 'timed_out', 'lost')
       AND result_code IS NOT NULL) OR
     (status IN ('pending', 'ready', 'waiting_approval', 'running')
       AND result_code IS NULL AND error_summary IS NULL)) AND
    (result_code IS NULL OR result_code ~ '^[a-z][a-z0-9_]{0,63}$') AND
    (error_summary IS NULL OR octet_length(error_summary) BETWEEN 1 AND 2048)
  ),
  CONSTRAINT ql3_step_runs_mutation_identity_check CHECK (
    last_mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_step_runs_json_check CHECK (
    jsonb_typeof(step_run_json) = 'object' AND
    octet_length(step_run_json::text) BETWEEN 2 AND 16384 AND
    step_run_json @> jsonb_build_object(
      'schema', 'qinglong/step-run@v1',
      'id', id,
      'runId', run_id,
      'parentStepRunId', parent_step_run_id,
      'stepKey', step_key,
      'kind', kind,
      'definitionRef', definition_ref,
      'definitionDigest', definition_digest,
      'required', required,
      'status', status,
      'version', version,
      'attemptCount', attempt_count,
      'inputRef', input_ref,
      'outputRef', output_ref,
      'approvalRequestId', approval_request_id,
      'readyAtMs', ready_at_ms,
      'startedAtMs', started_at_ms,
      'finishedAtMs', finished_at_ms,
      'resultCode', result_code,
      'errorSummary', error_summary,
      'createdAtMs', created_at_ms,
      'updatedAtMs', updated_at_ms,
      'lastMutationId', last_mutation_id,
      'stepRunDigest', step_run_digest
    )
  )
)
    `.trim(),
    `
CREATE UNIQUE INDEX ql3_step_runs_run_id_uidx
ON "ql3"."step_runs" (run_id, id)
    `.trim(),
    `
ALTER TABLE "ql3"."step_runs"
ADD CONSTRAINT ql3_step_runs_parent_fk
FOREIGN KEY (run_id, parent_step_run_id)
REFERENCES "ql3"."step_runs" (run_id, id)
ON DELETE RESTRICT
    `.trim(),
    `
CREATE UNIQUE INDEX ql3_step_runs_run_step_uidx
ON "ql3"."step_runs" (run_id, step_key)
    `.trim(),
    `
CREATE INDEX ql3_step_runs_run_status_idx
ON "ql3"."step_runs" (run_id, status, id)
    `.trim(),
    `
CREATE INDEX ql3_step_runs_recovery_idx
ON "ql3"."step_runs" (status, updated_at_ms, id)
WHERE status IN ('waiting_approval', 'running', 'lost')
    `.trim(),
    `
CREATE TABLE "ql3"."step_run_mutations" (
  mutation_id varchar(128) PRIMARY KEY,
  mutation_digest char(64) NOT NULL,
  run_id varchar(36) NOT NULL,
  step_run_id varchar(128) NOT NULL,
  step_run_digest char(64) NOT NULL,
  event_id varchar(36) NOT NULL,
  event_sequence integer NOT NULL,
  run_version integer NOT NULL,
  step_run_json jsonb NOT NULL,
  committed_at_ms bigint NOT NULL,
  CONSTRAINT ql3_step_run_mutations_step_fk
    FOREIGN KEY (run_id, step_run_id)
    REFERENCES "ql3"."step_runs" (run_id, id) ON DELETE CASCADE,
  CONSTRAINT ql3_step_run_mutations_event_fk
    FOREIGN KEY (event_id) REFERENCES "ql3"."run_events" (id)
    ON DELETE CASCADE,
  CONSTRAINT ql3_step_run_mutations_identity_check CHECK (
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    step_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_step_run_mutations_digest_check CHECK (
    mutation_digest ~ '^[0-9a-f]{64}$' AND
    step_run_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_step_run_mutations_counter_check CHECK (
    event_sequence BETWEEN 1 AND 2147483647 AND
    run_version BETWEEN 1 AND 2147483647 AND
    committed_at_ms >= 0
  ),
  CONSTRAINT ql3_step_run_mutations_json_check CHECK (
    jsonb_typeof(step_run_json) = 'object' AND
    octet_length(step_run_json::text) BETWEEN 2 AND 16384 AND
    step_run_json @> jsonb_build_object(
      'schema', 'qinglong/step-run@v1',
      'id', step_run_id,
      'runId', run_id,
      'lastMutationId', mutation_id,
      'stepRunDigest', step_run_digest
    )
  )
)
    `.trim(),
    `
CREATE UNIQUE INDEX ql3_step_run_mutations_event_uidx
ON "ql3"."step_run_mutations" (event_id)
    `.trim(),
    `
CREATE INDEX ql3_step_run_mutations_step_idx
ON "ql3"."step_run_mutations"
  (run_id, step_run_id, event_sequence, mutation_id)
    `.trim(),
    `
ALTER TABLE "ql3"."run_attempts"
ADD CONSTRAINT ql3_run_attempts_step_run_fk
FOREIGN KEY (run_id, step_run_id)
REFERENCES "ql3"."step_runs" (run_id, id)
ON DELETE RESTRICT
    `.trim(),
    `
ALTER TABLE "ql3"."run_events"
ADD CONSTRAINT ql3_run_events_step_run_fk
FOREIGN KEY (run_id, step_run_id)
REFERENCES "ql3"."step_runs" (run_id, id)
ON DELETE RESTRICT
    `.trim(),
    `
REVOKE ALL
ON "ql3"."step_runs", "ql3"."step_run_mutations"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
    `.trim(),
    `
GRANT SELECT, INSERT, UPDATE
ON "ql3"."step_runs"
TO ql3_runtime
    `.trim(),
    `
GRANT SELECT, INSERT
ON "ql3"."step_run_mutations"
TO ql3_runtime
    `.trim(),
    `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 27,
      migration_id = 'pg-0028-step-runs',
      capabilities = '${CAPABILITIES_V27}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 26
    AND migration_id = 'pg-0027-project-tool-definition-snapshots'
    AND capabilities = '${CAPABILITIES_V26}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 26'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
    `.trim(),
  ],
});
