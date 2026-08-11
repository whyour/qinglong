import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V39 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V40 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0041PluginPackageLifecycleMigration =
  definePostgresSqlMigration({
    id: 'pg-0041-plugin-package-lifecycle',
    statements: [
      `
ALTER TABLE "ql3"."approved_action_dispatches"
ADD CONSTRAINT ql3_approved_action_dispatch_lifecycle_key
UNIQUE (
  dispatch_id, project_id, action_type, action_digest, preview_digest
)
      `.trim(),
      `
CREATE TABLE "ql3"."plugin_package_lifecycle_events" (
  event_digest char(64) PRIMARY KEY,
  mutation_id varchar(128) NOT NULL,
  dispatch_id varchar(128) NOT NULL,
  approved_action_type varchar(128) NOT NULL,
  action varchar(16) NOT NULL,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  lock_digest char(64) NOT NULL,
  install_version integer NOT NULL,
  install_record_digest char(64) NOT NULL,
  expected_version integer NOT NULL,
  expected_disposition varchar(16) NOT NULL,
  expected_event_digest char(64),
  generation_digest char(64) NOT NULL,
  materialized_revision_digest char(64) NOT NULL,
  current_tool_snapshot_digest char(64) NOT NULL,
  reference_graph_digest char(64) NOT NULL,
  impact_digest char(64) NOT NULL,
  action_digest char(64) NOT NULL,
  requested_by_type varchar(16) NOT NULL,
  requested_by_id varchar(255) NOT NULL,
  approved_by_type varchar(16) NOT NULL,
  approved_by_id varchar(255) NOT NULL,
  authorization_mode varchar(32) NOT NULL,
  occurred_at_ms bigint NOT NULL,
  event_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_lifecycle_install_fk FOREIGN KEY (
    project_id, package_name, installation_id, lock_digest,
    install_record_digest
  ) REFERENCES "ql3"."plugin_package_installs" (
    project_id, package_name, installation_id, lock_digest, record_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_dispatch_fk FOREIGN KEY (
    dispatch_id, project_id, approved_action_type, action_digest,
    impact_digest
  ) REFERENCES "ql3"."approved_action_dispatches" (
    dispatch_id, project_id, action_type, action_digest, preview_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_previous_event_fk FOREIGN KEY (
    expected_event_digest
  ) REFERENCES "ql3"."plugin_package_lifecycle_events" (event_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_identity_check CHECK (
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    dispatch_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    install_version BETWEEN 1 AND 2147483647 AND
    action IN ('disable', 'enable', 'uninstall') AND
    approved_action_type = 'plugin_package.lifecycle.' || action
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_expectation_check CHECK (
    (action = 'disable' AND expected_disposition = 'active') OR
    (action IN ('enable', 'uninstall') AND
      expected_disposition = 'disabled')
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_origin_check CHECK (
    (expected_version = 0 AND expected_disposition = 'active' AND
      expected_event_digest IS NULL) OR
    (expected_version BETWEEN 1 AND 2147483646 AND
      expected_event_digest IS NOT NULL)
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_subject_check CHECK (
    requested_by_type = 'user' AND approved_by_type = 'user' AND
    octet_length(requested_by_id) BETWEEN 1 AND 255 AND
    octet_length(approved_by_id) BETWEEN 1 AND 255 AND
    authorization_mode IN (
      'human_confirmation', 'separation_of_duty'
    ) AND (
      (authorization_mode = 'human_confirmation' AND
        requested_by_id = approved_by_id) OR
      (authorization_mode = 'separation_of_duty' AND
        requested_by_id <> approved_by_id)
    )
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_digest_check CHECK (
    event_digest ~ '^[0-9a-f]{64}$' AND
    lock_digest ~ '^[0-9a-f]{64}$' AND
    install_record_digest ~ '^[0-9a-f]{64}$' AND
    generation_digest ~ '^[0-9a-f]{64}$' AND
    materialized_revision_digest ~ '^[0-9a-f]{64}$' AND
    current_tool_snapshot_digest ~ '^[0-9a-f]{64}$' AND
    reference_graph_digest ~ '^[0-9a-f]{64}$' AND
    impact_digest ~ '^[0-9a-f]{64}$' AND
    action_digest ~ '^[0-9a-f]{64}$' AND
    (expected_event_digest IS NULL OR
      expected_event_digest ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_json_check CHECK (
    jsonb_typeof(event_json) = 'object' AND
    octet_length(event_json::text) BETWEEN 2 AND 524288 AND
    event_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-lifecycle-event@v1',
      'mutationId', mutation_id,
      'dispatchId', dispatch_id,
      'actionDigest', action_digest,
      'authorizationMode', authorization_mode,
      'occurredAtMs', occurred_at_ms,
      'eventDigest', event_digest
    ) AND
    event_json -> 'impact' @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-lifecycle-impact@v1',
      'action', action,
      'generationDigest', generation_digest,
      'materializedRevisionDigest', materialized_revision_digest,
      'currentToolSnapshotDigest', current_tool_snapshot_digest,
      'referenceGraphDigest', reference_graph_digest,
      'impactDigest', impact_digest
    ) AND
    event_json -> 'impact' -> 'target' @> jsonb_build_object(
      'projectId', project_id,
      'packageName', package_name,
      'installationId', installation_id,
      'lockDigest', lock_digest,
      'installVersion', install_version,
      'installRecordDigest', install_record_digest
    ) AND
    event_json -> 'impact' -> 'expected' @> jsonb_build_object(
      'version', expected_version,
      'disposition', expected_disposition,
      'eventDigest', expected_event_digest
    ) AND
    event_json -> 'requestedBy' @> jsonb_build_object(
      'type', requested_by_type, 'id', requested_by_id
    ) AND
    event_json -> 'approvedBy' @> jsonb_build_object(
      'type', approved_by_type, 'id', approved_by_id
    )
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_time_check CHECK (
    occurred_at_ms >= 0
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_lifecycle_mutation_key ON "ql3"."plugin_package_lifecycle_events" (mutation_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_lifecycle_dispatch_key ON "ql3"."plugin_package_lifecycle_events" (dispatch_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_lifecycle_target_version_key ON "ql3"."plugin_package_lifecycle_events" (project_id, package_name, installation_id, lock_digest, expected_version)`,
      `CREATE INDEX ql3_plugin_package_lifecycle_project_idx ON "ql3"."plugin_package_lifecycle_events" (project_id, package_name, occurred_at_ms, event_digest)`,
      `
CREATE TABLE "ql3"."plugin_package_lifecycle_heads" (
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  lock_digest char(64) NOT NULL,
  install_record_digest char(64) NOT NULL,
  version integer NOT NULL,
  disposition varchar(16) NOT NULL,
  event_digest char(64) NOT NULL,
  updated_at_ms bigint NOT NULL,
  PRIMARY KEY (project_id, package_name),
  CONSTRAINT ql3_plugin_package_lifecycle_head_install_fk FOREIGN KEY (
    project_id, package_name, installation_id, lock_digest,
    install_record_digest
  ) REFERENCES "ql3"."plugin_package_installs" (
    project_id, package_name, installation_id, lock_digest, record_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_head_event_fk FOREIGN KEY (
    event_digest
  ) REFERENCES "ql3"."plugin_package_lifecycle_events" (event_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_head_state_check CHECK (
    version BETWEEN 1 AND 2147483647 AND
    disposition IN ('active', 'disabled', 'uninstalled') AND
    updated_at_ms >= 0
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_head_digest_check CHECK (
    lock_digest ~ '^[0-9a-f]{64}$' AND
    install_record_digest ~ '^[0-9a-f]{64}$' AND
    event_digest ~ '^[0-9a-f]{64}$'
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_lifecycle_head_event_key ON "ql3"."plugin_package_lifecycle_heads" (event_digest)`,
      `
CREATE TABLE "ql3"."plugin_package_lifecycle_receipts" (
  event_digest char(64) PRIMARY KEY,
  receipt_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  action varchar(16) NOT NULL,
  capability_status varchar(16) NOT NULL,
  task_count integer NOT NULL,
  previous_active_vector_digest char(64) NOT NULL,
  current_active_vector_digest char(64) NOT NULL,
  current_tool_snapshot_digest char(64) NOT NULL,
  retained_source_count integer NOT NULL,
  committed_at_ms bigint NOT NULL,
  receipt_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_lifecycle_receipt_event_fk FOREIGN KEY (
    event_digest
  ) REFERENCES "ql3"."plugin_package_lifecycle_events" (event_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_receipt_snapshot_fk FOREIGN KEY (
    project_id, current_active_vector_digest, current_tool_snapshot_digest
  ) REFERENCES "ql3"."project_tool_definition_snapshots" (
    project_id, active_vector_digest, snapshot_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_receipt_state_check CHECK (
    (action = 'disable' AND capability_status = 'withdrawn' AND
      previous_active_vector_digest <> current_active_vector_digest) OR
    (action = 'enable' AND capability_status = 'restored' AND
      previous_active_vector_digest <> current_active_vector_digest) OR
    (action = 'uninstall' AND capability_status = 'retired' AND
      task_count = 0 AND
      previous_active_vector_digest = current_active_vector_digest)
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_receipt_bounds_check CHECK (
    task_count BETWEEN 0 AND 128 AND
    retained_source_count BETWEEN 0 AND 128 AND committed_at_ms >= 0
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_receipt_digest_check CHECK (
    event_digest ~ '^[0-9a-f]{64}$' AND
    receipt_digest ~ '^[0-9a-f]{64}$' AND
    previous_active_vector_digest ~ '^[0-9a-f]{64}$' AND
    current_active_vector_digest ~ '^[0-9a-f]{64}$' AND
    current_tool_snapshot_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_receipt_json_check CHECK (
    jsonb_typeof(receipt_json) = 'object' AND
    octet_length(receipt_json::text) BETWEEN 2 AND 524288 AND
    receipt_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-lifecycle-receipt@v1',
      'eventDigest', event_digest,
      'action', action,
      'committedAtMs', committed_at_ms,
      'receiptDigest', receipt_digest
    ) AND
    receipt_json -> 'target' ->> 'projectId' = project_id AND
    receipt_json -> 'capability' @> jsonb_build_object(
      'status', capability_status,
      'previousActiveVectorDigest', previous_active_vector_digest,
      'currentActiveVectorDigest', current_active_vector_digest,
      'currentToolSnapshotDigest', current_tool_snapshot_digest,
      'retainedSourceCount', retained_source_count
    ) AND
    jsonb_array_length(
      receipt_json -> 'capability' -> 'taskTransitions'
    ) = task_count
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_lifecycle_receipt_key ON "ql3"."plugin_package_lifecycle_receipts" (receipt_digest)`,
      `CREATE INDEX ql3_plugin_package_lifecycle_receipt_snapshot_idx ON "ql3"."plugin_package_lifecycle_receipts" (project_id, current_active_vector_digest, event_digest)`,
      `
CREATE TABLE "ql3"."plugin_package_lifecycle_tasks" (
  event_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  task_id varchar(128) NOT NULL,
  previous_revision integer NOT NULL,
  current_revision integer NOT NULL,
  previous_content_digest char(64) NOT NULL,
  current_content_digest char(64) NOT NULL,
  previous_enabled boolean NOT NULL,
  current_enabled boolean NOT NULL,
  PRIMARY KEY (event_digest, task_id),
  CONSTRAINT ql3_plugin_package_lifecycle_task_receipt_fk FOREIGN KEY (
    event_digest
  ) REFERENCES "ql3"."plugin_package_lifecycle_receipts" (event_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_task_previous_fk FOREIGN KEY (
    project_id, task_id, previous_revision
  ) REFERENCES "ql3"."task_definition_revisions" (
    project_id, task_id, revision
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_task_current_fk FOREIGN KEY (
    project_id, task_id, current_revision
  ) REFERENCES "ql3"."task_definition_revisions" (
    project_id, task_id, revision
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_lifecycle_task_transition_check CHECK (
    task_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    current_revision = previous_revision + 1 AND
    previous_enabled <> current_enabled
  ),
  CONSTRAINT ql3_plugin_package_lifecycle_task_digest_check CHECK (
    event_digest ~ '^[0-9a-f]{64}$' AND
    previous_content_digest ~ '^[0-9a-f]{64}$' AND
    current_content_digest ~ '^[0-9a-f]{64}$'
  )
)
      `.trim(),
      `CREATE INDEX ql3_plugin_package_lifecycle_task_idx ON "ql3"."plugin_package_lifecycle_tasks" (project_id, task_id, event_digest)`,
      `
CREATE OR REPLACE FUNCTION "ql3"."plugin_package_run_start_allowed"(
  p_project_id varchar,
  p_task_id varchar,
  p_task_revision varchar
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
DECLARE
  project_exists boolean;
BEGIN
  IF NOT pg_has_role(session_user, 'ql3_runtime', 'member') THEN
    RAISE EXCEPTION 'Runtime authority is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT true INTO project_exists
  FROM "ql3"."projects"
  WHERE id = p_project_id
  FOR SHARE;
  IF NOT COALESCE(project_exists, false) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1
    FROM "ql3"."plugin_package_quarantine_events" AS quarantine
    JOIN "ql3"."plugin_package_task_reconciliations" AS reconciliation
      ON reconciliation.project_id = quarantine.project_id
     AND reconciliation.package_name = quarantine.package_name
     AND reconciliation.lock_digest = quarantine.lock_digest
    JOIN "ql3"."plugin_package_task_reconciliation_items" AS item
      ON item.generation_digest = reconciliation.generation_digest
     AND item.task_id = p_task_id
     AND 'qltd:v1:' || item.revision || ':' || item.content_digest =
       p_task_revision
    WHERE quarantine.project_id = p_project_id
  ) AND NOT EXISTS (
    SELECT 1
    FROM "ql3"."plugin_package_lifecycle_heads" AS lifecycle
    JOIN "ql3"."plugin_package_task_reconciliations" AS reconciliation
      ON reconciliation.project_id = lifecycle.project_id
     AND reconciliation.package_name = lifecycle.package_name
     AND reconciliation.lock_digest = lifecycle.lock_digest
    JOIN "ql3"."plugin_package_task_reconciliation_items" AS item
      ON item.generation_digest = reconciliation.generation_digest
     AND item.task_id = p_task_id
     AND 'qltd:v1:' || item.revision || ':' || item.content_digest =
       p_task_revision
    WHERE lifecycle.project_id = p_project_id
      AND lifecycle.disposition <> 'active'
  );
END
$ql3$
      `.trim(),
      `
CREATE OR REPLACE FUNCTION "ql3"."plugin_package_tool_start_allowed"(
  p_project_id varchar,
  p_definition_ref varchar,
  p_definition_digest char(64)
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
DECLARE
  project_exists boolean;
BEGIN
  IF NOT pg_has_role(session_user, 'ql3_runtime', 'member') THEN
    RAISE EXCEPTION 'Runtime authority is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT true INTO project_exists
  FROM "ql3"."projects"
  WHERE id = p_project_id
  FOR SHARE;
  IF NOT COALESCE(project_exists, false) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (
    SELECT 1
    FROM "ql3"."plugin_package_quarantine_events" AS quarantine
    JOIN "ql3"."project_tool_definition_snapshot_sources" AS source
      ON source.project_id = quarantine.project_id
     AND source.package_name = quarantine.package_name
     AND source.installation_id = quarantine.installation_id
     AND source.lock_digest = quarantine.lock_digest
    JOIN "ql3"."project_tool_definition_snapshots" AS snapshot
      ON snapshot.project_id = source.project_id
     AND snapshot.active_vector_digest = source.active_vector_digest
    CROSS JOIN LATERAL jsonb_array_elements(
      snapshot.snapshot_json -> 'definitions'
    ) AS definition(item)
    WHERE quarantine.project_id = p_project_id
      AND definition.item ->> 'packageName' = quarantine.package_name
      AND 'tool:' || (definition.item -> 'definition' ->> 'name') || '@' ||
        (definition.item -> 'definition' ->> 'version') = p_definition_ref
      AND definition.item ->> 'definitionDigest' = p_definition_digest
  ) AND NOT EXISTS (
    SELECT 1
    FROM "ql3"."plugin_package_lifecycle_heads" AS lifecycle
    JOIN "ql3"."project_tool_definition_snapshot_sources" AS source
      ON source.project_id = lifecycle.project_id
     AND source.package_name = lifecycle.package_name
     AND source.installation_id = lifecycle.installation_id
     AND source.lock_digest = lifecycle.lock_digest
    JOIN "ql3"."project_tool_definition_snapshots" AS snapshot
      ON snapshot.project_id = source.project_id
     AND snapshot.active_vector_digest = source.active_vector_digest
    CROSS JOIN LATERAL jsonb_array_elements(
      snapshot.snapshot_json -> 'definitions'
    ) AS definition(item)
    WHERE lifecycle.project_id = p_project_id
      AND lifecycle.disposition <> 'active'
      AND definition.item ->> 'packageName' = lifecycle.package_name
      AND 'tool:' || (definition.item -> 'definition' ->> 'name') || '@' ||
        (definition.item -> 'definition' ->> 'version') = p_definition_ref
      AND definition.item ->> 'definitionDigest' = p_definition_digest
  );
END
$ql3$
      `.trim(),
      `
CREATE FUNCTION "ql3"."plugin_package_lifecycle_blocking_runs"(
  p_project_id varchar,
  p_package_name varchar,
  p_limit integer
)
RETURNS TABLE (
  run_id varchar(36),
  status varchar(32),
  version integer,
  event_sequence integer,
  task_id varchar(255),
  task_revision varchar(128)
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
BEGIN
  IF NOT pg_has_role(session_user, 'ql3_package_executor', 'member') THEN
    RAISE EXCEPTION 'Package executor authority is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_project_id IS NULL
     OR octet_length(p_project_id) NOT BETWEEN 1 AND 128
     OR p_package_name IS NULL
     OR p_package_name !~
       '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
     OR p_limit NOT BETWEEN 1 AND 129 THEN
    RAISE EXCEPTION 'invalid Package lifecycle blocking Run query'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN QUERY
  SELECT
    run.id,
    run.status,
    run.version,
    run.event_sequence,
    run.task_id,
    run.task_revision
  FROM "ql3"."runs" AS run
  JOIN "ql3"."plugin_package_task_ownerships" AS ownership
    ON ownership.project_id = run.project_id
   AND ownership.task_id = run.task_id
  WHERE ownership.project_id = p_project_id
    AND ownership.package_name = p_package_name
    AND run.status NOT IN (
      'succeeded', 'failed', 'cancelled', 'timed_out'
    )
  ORDER BY run.id
  LIMIT p_limit;
END
$ql3$
      `.trim(),
      `
CREATE FUNCTION "ql3"."commit_plugin_package_lifecycle"(
  p_event jsonb,
  p_receipt jsonb,
  p_task_writes jsonb,
  p_snapshot jsonb
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
DECLARE
  event_digest_value char(64);
  action_value varchar(16);
  project_id_value varchar(128);
  package_name_value varchar(63);
  installation_id_value varchar(128);
  lock_digest_value char(64);
  expected_version_value integer;
  expected_event_digest_value char(64);
  committed_at_value bigint;
  install_record "ql3"."plugin_package_installs"%ROWTYPE;
  lifecycle_head "ql3"."plugin_package_lifecycle_heads"%ROWTYPE;
  dispatch_record "ql3"."approved_action_dispatches"%ROWTYPE;
  existing_event jsonb;
  existing_receipt jsonb;
  materialized_record "ql3"."plugin_package_materialized_revisions"%ROWTYPE;
  task_write jsonb;
  next_task jsonb;
  transition jsonb;
  previous_task "ql3"."task_definition_revisions"%ROWTYPE;
  current_source_count integer;
  expected_source_count integer;
  expected_task_count integer;
  inserted_snapshot integer;
  updated_head integer;
BEGIN
  IF NOT pg_has_role(session_user, 'ql3_package_executor', 'member') THEN
    RAISE EXCEPTION 'Package executor authority is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF jsonb_typeof(p_event) <> 'object'
     OR jsonb_typeof(p_receipt) <> 'object'
     OR jsonb_typeof(p_task_writes) <> 'array'
     OR jsonb_array_length(p_task_writes) > 128
     OR (p_snapshot <> 'null'::jsonb AND
       jsonb_typeof(p_snapshot) <> 'object') THEN
    RAISE EXCEPTION 'invalid Package lifecycle input'
      USING ERRCODE = 'check_violation';
  END IF;

  event_digest_value := p_event ->> 'eventDigest';
  action_value := p_event -> 'impact' ->> 'action';
  project_id_value := p_event -> 'impact' -> 'target' ->> 'projectId';
  package_name_value :=
    p_event -> 'impact' -> 'target' ->> 'packageName';
  installation_id_value :=
    p_event -> 'impact' -> 'target' ->> 'installationId';
  lock_digest_value :=
    p_event -> 'impact' -> 'target' ->> 'lockDigest';
  expected_version_value :=
    (p_event -> 'impact' -> 'expected' ->> 'version')::integer;
  expected_event_digest_value :=
    p_event -> 'impact' -> 'expected' ->> 'eventDigest';
  committed_at_value := (p_receipt ->> 'committedAtMs')::bigint;

  IF action_value NOT IN ('disable', 'enable', 'uninstall')
     OR p_receipt ->> 'eventDigest' IS DISTINCT FROM event_digest_value
     OR p_receipt ->> 'action' IS DISTINCT FROM action_value
     OR p_receipt -> 'target' IS DISTINCT FROM
       p_event -> 'impact' -> 'target'
     OR p_receipt -> 'lifecycle' ->> 'eventDigest' IS DISTINCT FROM
       event_digest_value
     OR (p_receipt -> 'lifecycle' ->> 'version')::integer IS DISTINCT FROM
       expected_version_value + 1
     OR committed_at_value <
       (p_event ->> 'occurredAtMs')::bigint THEN
    RAISE EXCEPTION 'Package lifecycle receipt does not bind the event'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1 FROM "ql3"."projects"
  WHERE id = project_id_value
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Package lifecycle Project is absent'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO dispatch_record
  FROM "ql3"."approved_action_dispatches"
  WHERE dispatch_id = p_event ->> 'dispatchId'
  FOR SHARE;
  IF NOT FOUND
     OR dispatch_record.project_id <> project_id_value
     OR dispatch_record.action_type <>
       'plugin_package.lifecycle.' || action_value
     OR dispatch_record.action_digest <> p_event ->> 'actionDigest'
     OR dispatch_record.preview_digest <>
       p_event -> 'impact' ->> 'impactDigest'
     OR dispatch_record.dispatch_json -> 'action' ->> 'permission' <>
       'package.manage'
     OR dispatch_record.dispatch_json -> 'requestedBy' IS DISTINCT FROM
       p_event -> 'requestedBy'
     OR dispatch_record.dispatch_json -> 'approvedBy' IS DISTINCT FROM
       p_event -> 'approvedBy'
     OR (p_event ->> 'occurredAtMs')::bigint <
       (dispatch_record.dispatch_json ->> 'approvedAtMs')::bigint
     OR (p_event ->> 'occurredAtMs')::bigint >
       (dispatch_record.dispatch_json ->> 'expiresAtMs')::bigint THEN
    RAISE EXCEPTION 'Package lifecycle dispatch is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT event_json INTO existing_event
  FROM "ql3"."plugin_package_lifecycle_events"
  WHERE event_digest = event_digest_value;
  IF FOUND THEN
    SELECT receipt_json INTO existing_receipt
    FROM "ql3"."plugin_package_lifecycle_receipts"
    WHERE event_digest = event_digest_value;
    IF NOT FOUND OR existing_event IS DISTINCT FROM p_event
       OR existing_receipt IS DISTINCT FROM p_receipt THEN
      RAISE EXCEPTION 'Package lifecycle replay conflicts'
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN false;
  END IF;

  SELECT * INTO install_record
  FROM "ql3"."plugin_package_installs"
  WHERE installation_id = installation_id_value
  FOR UPDATE;
  IF NOT FOUND
     OR install_record.project_id <> project_id_value
     OR install_record.package_name <> package_name_value
     OR install_record.lock_digest <> lock_digest_value
     OR install_record.state <> 'active'
     OR install_record.active_lock_digest <> lock_digest_value
     OR install_record.version <>
       (p_event -> 'impact' -> 'target' ->> 'installVersion')::integer
     OR install_record.record_digest <>
       p_event -> 'impact' -> 'target' ->> 'installRecordDigest' THEN
    RAISE EXCEPTION 'Package lifecycle target drifted'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO materialized_record
  FROM "ql3"."plugin_package_materialized_revisions"
  WHERE project_id = project_id_value
    AND package_name = package_name_value
    AND generation = install_record.target_generation
    AND lock_digest = lock_digest_value
  FOR SHARE;
  IF NOT FOUND
     OR materialized_record.generation_digest <>
       p_event -> 'impact' ->> 'generationDigest'
     OR materialized_record.revision_digest <>
       p_event -> 'impact' ->> 'materializedRevisionDigest' THEN
    RAISE EXCEPTION 'Package lifecycle materialization drifted'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO lifecycle_head
  FROM "ql3"."plugin_package_lifecycle_heads"
  WHERE project_id = project_id_value AND package_name = package_name_value
  FOR UPDATE;
  IF FOUND AND lifecycle_head.installation_id = installation_id_value
     AND lifecycle_head.lock_digest = lock_digest_value
     AND lifecycle_head.install_record_digest = install_record.record_digest
  THEN
    IF lifecycle_head.version <> expected_version_value
       OR lifecycle_head.disposition <>
         p_event -> 'impact' -> 'expected' ->> 'disposition'
       OR lifecycle_head.event_digest IS DISTINCT FROM
         expected_event_digest_value THEN
      RAISE EXCEPTION 'Package lifecycle head drifted'
        USING ERRCODE = 'serialization_failure';
    END IF;
  ELSIF expected_version_value <> 0
     OR p_event -> 'impact' -> 'expected' ->> 'disposition' <> 'active'
     OR expected_event_digest_value IS NOT NULL THEN
    RAISE EXCEPTION 'Package lifecycle origin drifted'
      USING ERRCODE = 'serialization_failure';
  END IF;

  IF (action_value = 'disable' AND
        p_event -> 'impact' -> 'expected' ->> 'disposition' <> 'active')
     OR (action_value IN ('enable', 'uninstall') AND
        p_event -> 'impact' -> 'expected' ->> 'disposition' <> 'disabled')
  THEN
    RAISE EXCEPTION 'Package lifecycle transition is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "ql3"."project_tool_definition_snapshots"
    WHERE project_id = project_id_value
      AND snapshot_digest =
        p_event -> 'impact' ->> 'currentToolSnapshotDigest'
  ) THEN
    RAISE EXCEPTION 'Package lifecycle prior Tool snapshot is absent'
      USING ERRCODE = 'check_violation';
  END IF;

  IF action_value = 'enable' AND EXISTS (
    SELECT 1 FROM "ql3"."plugin_package_quarantine_events"
    WHERE project_id = project_id_value
      AND package_name = package_name_value
      AND installation_id = installation_id_value
      AND lock_digest = lock_digest_value
  ) THEN
    RAISE EXCEPTION 'quarantined Package cannot be enabled'
      USING ERRCODE = 'check_violation';
  END IF;

  IF action_value = 'uninstall' AND (
    jsonb_array_length(
      p_event -> 'impact' -> 'blockingReferences'
    ) <> 0 OR EXISTS (
      SELECT 1
      FROM "ql3"."runs" AS run
      JOIN "ql3"."plugin_package_task_ownerships" AS ownership
        ON ownership.project_id = run.project_id
       AND ownership.task_id = run.task_id
      WHERE ownership.project_id = project_id_value
        AND ownership.package_name = package_name_value
        AND run.status NOT IN (
          'succeeded', 'failed', 'cancelled', 'timed_out'
        )
    )
  ) THEN
    RAISE EXCEPTION 'Package lifecycle uninstall has live references'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::integer INTO current_source_count
  FROM "ql3"."plugin_package_install_heads" AS head
  JOIN "ql3"."plugin_package_installs" AS head_install
    ON head_install.installation_id = head.installation_id
  JOIN "ql3"."plugin_package_installs" AS active_install
    ON active_install.project_id = head.project_id
   AND active_install.package_name = head.package_name
   AND active_install.lock_digest = head_install.active_lock_digest
  JOIN "ql3"."plugin_package_materialized_revisions" AS revision
    ON revision.project_id = active_install.project_id
   AND revision.package_name = active_install.package_name
   AND revision.generation = active_install.target_generation
   AND revision.lock_digest = active_install.lock_digest
  LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
    ON quarantine.project_id = active_install.project_id
   AND quarantine.package_name = active_install.package_name
   AND quarantine.installation_id = active_install.installation_id
   AND quarantine.lock_digest = active_install.lock_digest
  LEFT JOIN "ql3"."plugin_package_lifecycle_heads" AS lifecycle
    ON lifecycle.project_id = active_install.project_id
   AND lifecycle.package_name = active_install.package_name
   AND lifecycle.installation_id = active_install.installation_id
   AND lifecycle.lock_digest = active_install.lock_digest
   AND lifecycle.install_record_digest = active_install.record_digest
  WHERE head.project_id = project_id_value
    AND head_install.active_lock_digest IS NOT NULL
    AND active_install.state = 'active'
    AND quarantine.event_digest IS NULL
    AND (lifecycle.event_digest IS NULL OR lifecycle.disposition = 'active')
    AND NOT EXISTS (
      SELECT 1
      FROM "ql3"."plugin_package_publisher_provenance" AS provenance
      JOIN "ql3"."plugin_package_publisher_revocation_receipts" AS revoked
        ON revoked.publisher = provenance.publisher
       AND revoked.key_id = provenance.key_id
      WHERE provenance.installation_id = active_install.installation_id
        AND provenance.lock_digest = active_install.lock_digest
    );

  IF current_source_count <> (
      SELECT count(*)::integer
      FROM "ql3"."project_tool_definition_snapshot_sources" AS source
      JOIN "ql3"."project_tool_definition_snapshots" AS snapshot
        ON snapshot.project_id = source.project_id
       AND snapshot.active_vector_digest = source.active_vector_digest
      WHERE snapshot.project_id = project_id_value
        AND snapshot.snapshot_digest =
          p_event -> 'impact' ->> 'currentToolSnapshotDigest'
    ) OR EXISTS (
      SELECT 1
      FROM "ql3"."plugin_package_install_heads" AS head
      JOIN "ql3"."plugin_package_installs" AS head_install
        ON head_install.installation_id = head.installation_id
      JOIN "ql3"."plugin_package_installs" AS active_install
        ON active_install.project_id = head.project_id
       AND active_install.package_name = head.package_name
       AND active_install.lock_digest = head_install.active_lock_digest
      JOIN "ql3"."plugin_package_materialized_revisions" AS revision
        ON revision.project_id = active_install.project_id
       AND revision.package_name = active_install.package_name
       AND revision.generation = active_install.target_generation
       AND revision.lock_digest = active_install.lock_digest
      LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
        ON quarantine.project_id = active_install.project_id
       AND quarantine.package_name = active_install.package_name
       AND quarantine.installation_id = active_install.installation_id
       AND quarantine.lock_digest = active_install.lock_digest
      LEFT JOIN "ql3"."plugin_package_lifecycle_heads" AS lifecycle
        ON lifecycle.project_id = active_install.project_id
       AND lifecycle.package_name = active_install.package_name
       AND lifecycle.installation_id = active_install.installation_id
       AND lifecycle.lock_digest = active_install.lock_digest
       AND lifecycle.install_record_digest = active_install.record_digest
      WHERE head.project_id = project_id_value
        AND head_install.active_lock_digest IS NOT NULL
        AND active_install.state = 'active'
        AND quarantine.event_digest IS NULL
        AND (
          lifecycle.event_digest IS NULL OR lifecycle.disposition = 'active'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "ql3"."plugin_package_publisher_provenance" AS provenance
          JOIN "ql3"."plugin_package_publisher_revocation_receipts" AS revoked
            ON revoked.publisher = provenance.publisher
           AND revoked.key_id = provenance.key_id
          WHERE provenance.installation_id = active_install.installation_id
            AND provenance.lock_digest = active_install.lock_digest
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "ql3"."project_tool_definition_snapshot_sources" AS source
          JOIN "ql3"."project_tool_definition_snapshots" AS snapshot
            ON snapshot.project_id = source.project_id
           AND snapshot.active_vector_digest = source.active_vector_digest
          WHERE snapshot.project_id = project_id_value
            AND snapshot.snapshot_digest =
              p_event -> 'impact' ->> 'currentToolSnapshotDigest'
            AND source.package_name = active_install.package_name
            AND source.installation_id = active_install.installation_id
            AND source.generation = active_install.target_generation
            AND source.generation_digest = revision.generation_digest
            AND source.lock_digest = active_install.lock_digest
            AND source.revision_digest = revision.revision_digest
        )
    ) THEN
    RAISE EXCEPTION 'Package lifecycle prior Tool vector drifted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF (action_value = 'disable' AND NOT EXISTS (
      SELECT 1
      FROM "ql3"."project_tool_definition_snapshot_sources"
      WHERE project_id = project_id_value
        AND active_vector_digest = (
          SELECT active_vector_digest
          FROM "ql3"."project_tool_definition_snapshots"
          WHERE project_id = project_id_value
            AND snapshot_digest =
              p_event -> 'impact' ->> 'currentToolSnapshotDigest'
        )
        AND package_name = package_name_value
        AND installation_id = installation_id_value
        AND lock_digest = lock_digest_value
    )) OR (action_value IN ('enable', 'uninstall') AND EXISTS (
      SELECT 1
      FROM "ql3"."project_tool_definition_snapshot_sources"
      WHERE project_id = project_id_value
        AND active_vector_digest = (
          SELECT active_vector_digest
          FROM "ql3"."project_tool_definition_snapshots"
          WHERE project_id = project_id_value
            AND snapshot_digest =
              p_event -> 'impact' ->> 'currentToolSnapshotDigest'
        )
        AND package_name = package_name_value
        AND installation_id = installation_id_value
        AND lock_digest = lock_digest_value
    )) THEN
    RAISE EXCEPTION 'Package lifecycle prior Tool source drifted'
      USING ERRCODE = 'check_violation';
  END IF;

  expected_task_count :=
    jsonb_array_length(p_event -> 'impact' -> 'taskIds');
  IF expected_task_count <> jsonb_array_length(p_task_writes)
     OR expected_task_count <>
       jsonb_array_length(
         p_receipt -> 'capability' -> 'taskTransitions'
       )
     OR (
       action_value = 'disable' AND expected_task_count <> (
         SELECT count(*)::integer
         FROM "ql3"."plugin_package_task_ownerships" AS ownership
         JOIN "ql3"."task_definitions" AS head
           ON head.project_id = ownership.project_id
          AND head.task_id = ownership.task_id
         JOIN "ql3"."task_definition_revisions" AS revision
           ON revision.project_id = head.project_id
          AND revision.task_id = head.task_id
          AND revision.revision = head.current_revision
         WHERE ownership.project_id = project_id_value
           AND ownership.package_name = package_name_value
           AND revision.enabled = true
       )
     )
     OR (
       action_value = 'enable' AND (
         NOT EXISTS (
           SELECT 1
           FROM "ql3"."plugin_package_lifecycle_receipts" AS previous
           WHERE previous.event_digest = expected_event_digest_value
             AND previous.action = 'disable'
             AND jsonb_array_length(
               previous.receipt_json -> 'capability' -> 'taskTransitions'
             ) = expected_task_count
         ) OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(
             p_event -> 'impact' -> 'taskIds'
           ) AS task_id(value)
           WHERE NOT EXISTS (
             SELECT 1
             FROM "ql3"."plugin_package_lifecycle_tasks"
               AS prior_lifecycle_task
             WHERE prior_lifecycle_task.event_digest =
               expected_event_digest_value
               AND prior_lifecycle_task.task_id = task_id.value
           )
         )
       )
     )
     OR (action_value = 'uninstall' AND expected_task_count <> 0)
  THEN
    RAISE EXCEPTION 'Package lifecycle Task set drifted'
      USING ERRCODE = 'check_violation';
  END IF;

  FOR task_write IN SELECT value FROM jsonb_array_elements(p_task_writes)
  LOOP
    next_task := task_write -> 'next';
    transition := task_write -> 'transition';
    SELECT revision.* INTO previous_task
    FROM "ql3"."plugin_package_task_ownerships" AS ownership
    JOIN "ql3"."task_definitions" AS head
      ON head.project_id = ownership.project_id
     AND head.task_id = ownership.task_id
    JOIN "ql3"."task_definition_revisions" AS revision
      ON revision.project_id = head.project_id
     AND revision.task_id = head.task_id
     AND revision.revision = head.current_revision
    WHERE ownership.project_id = project_id_value
      AND ownership.package_name = package_name_value
      AND ownership.task_id = transition ->> 'taskId'
    FOR UPDATE OF head;
    IF NOT FOUND
       OR NOT (p_event -> 'impact' -> 'taskIds' ? (transition ->> 'taskId'))
       OR previous_task.revision <>
         (transition ->> 'previousRevision')::integer
       OR previous_task.content_digest <>
         transition ->> 'previousContentDigest'
       OR previous_task.enabled <>
         (transition ->> 'previousEnabled')::boolean
       OR next_task ->> 'projectId' <> project_id_value
       OR next_task ->> 'taskId' <> transition ->> 'taskId'
       OR (next_task ->> 'revision')::integer <>
         previous_task.revision + 1
       OR next_task ->> 'contentDigest' <>
         transition ->> 'currentContentDigest'
       OR (next_task ->> 'enabled')::boolean <>
         (transition ->> 'currentEnabled')::boolean
       OR (action_value = 'disable' AND (
         previous_task.enabled <> true OR
         (next_task ->> 'enabled')::boolean <> false
       ))
       OR (action_value = 'enable' AND (
         previous_task.enabled <> false OR
         (next_task ->> 'enabled')::boolean <> true
       )) THEN
      RAISE EXCEPTION 'Package lifecycle Task write drifted'
        USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO "ql3"."task_definition_revisions" (
      project_id, task_id, revision, mutation_id, name, description,
      kind, spec_json, labels_json, enabled, content_digest, created_at_ms
    ) VALUES (
      project_id_value,
      next_task ->> 'taskId',
      (next_task ->> 'revision')::integer,
      (next_task ->> 'mutationId')::uuid,
      next_task ->> 'name',
      next_task ->> 'description',
      next_task ->> 'kind',
      next_task -> 'spec',
      next_task -> 'labels',
      (next_task ->> 'enabled')::boolean,
      next_task ->> 'contentDigest',
      (next_task ->> 'updatedAtMs')::bigint
    );
    UPDATE "ql3"."task_definitions"
    SET current_revision = (next_task ->> 'revision')::integer,
        updated_at_ms = (next_task ->> 'updatedAtMs')::bigint
    WHERE project_id = project_id_value
      AND task_id = next_task ->> 'taskId'
      AND current_revision = previous_task.revision;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Package lifecycle Task head drifted'
        USING ERRCODE = 'serialization_failure';
    END IF;
  END LOOP;

  IF action_value = 'uninstall' THEN
    IF p_snapshot <> 'null'::jsonb
       OR p_receipt -> 'capability' ->> 'previousActiveVectorDigest' <>
         p_receipt -> 'capability' ->> 'currentActiveVectorDigest' THEN
      RAISE EXCEPTION 'Package lifecycle uninstall snapshot is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF p_snapshot = 'null'::jsonb THEN
      RAISE EXCEPTION 'Package lifecycle snapshot is absent'
        USING ERRCODE = 'check_violation';
    END IF;
    expected_source_count := current_source_count +
      CASE action_value WHEN 'enable' THEN 1 ELSE -1 END;
    IF expected_source_count < 0 OR expected_source_count > 128
       OR jsonb_array_length(p_snapshot -> 'sources') <>
         expected_source_count
       OR (p_receipt -> 'capability' ->> 'retainedSourceCount')::integer <>
         expected_source_count
       OR EXISTS (
         SELECT 1
         FROM "ql3"."plugin_package_install_heads" AS head
         JOIN "ql3"."plugin_package_installs" AS head_install
           ON head_install.installation_id = head.installation_id
         JOIN "ql3"."plugin_package_installs" AS active_install
           ON active_install.project_id = head.project_id
          AND active_install.package_name = head.package_name
          AND active_install.lock_digest = head_install.active_lock_digest
         JOIN "ql3"."plugin_package_materialized_revisions" AS revision
           ON revision.project_id = active_install.project_id
          AND revision.package_name = active_install.package_name
          AND revision.generation = active_install.target_generation
          AND revision.lock_digest = active_install.lock_digest
         LEFT JOIN "ql3"."plugin_package_quarantine_events" AS quarantine
           ON quarantine.project_id = active_install.project_id
          AND quarantine.package_name = active_install.package_name
          AND quarantine.installation_id = active_install.installation_id
          AND quarantine.lock_digest = active_install.lock_digest
         LEFT JOIN "ql3"."plugin_package_lifecycle_heads" AS lifecycle
           ON lifecycle.project_id = active_install.project_id
          AND lifecycle.package_name = active_install.package_name
          AND lifecycle.installation_id = active_install.installation_id
          AND lifecycle.lock_digest = active_install.lock_digest
          AND lifecycle.install_record_digest = active_install.record_digest
         WHERE head.project_id = project_id_value
           AND head_install.active_lock_digest IS NOT NULL
           AND active_install.state = 'active'
           AND quarantine.event_digest IS NULL
           AND (
             lifecycle.event_digest IS NULL OR
             lifecycle.disposition = 'active'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM "ql3"."plugin_package_publisher_provenance" AS provenance
             JOIN "ql3"."plugin_package_publisher_revocation_receipts"
               AS revoked
               ON revoked.publisher = provenance.publisher
              AND revoked.key_id = provenance.key_id
             WHERE provenance.installation_id =
               active_install.installation_id
               AND provenance.lock_digest = active_install.lock_digest
           )
           AND NOT (
             action_value = 'disable'
             AND active_install.installation_id = installation_id_value
             AND active_install.lock_digest = lock_digest_value
           )
           AND NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements(p_snapshot -> 'sources') AS source
             WHERE source ->> 'packageName' = active_install.package_name
               AND source ->> 'installationId' =
                 active_install.installation_id
               AND (source ->> 'generation')::integer =
                 active_install.target_generation
               AND source ->> 'generationDigest' =
                 revision.generation_digest
               AND source ->> 'lockDigest' = active_install.lock_digest
               AND source ->> 'revisionDigest' =
                 revision.revision_digest
           )
       ) THEN
      RAISE EXCEPTION 'Package lifecycle Tool source count drifted'
        USING ERRCODE = 'check_violation';
    END IF;
    IF action_value = 'disable' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_snapshot -> 'sources') AS source
      WHERE source ->> 'packageName' = package_name_value
        AND source ->> 'installationId' = installation_id_value
        AND source ->> 'lockDigest' = lock_digest_value
    ) THEN
      RAISE EXCEPTION 'disabled Package remains in Tool snapshot'
        USING ERRCODE = 'check_violation';
    END IF;
    IF action_value = 'enable' AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_snapshot -> 'sources') AS source
      WHERE source ->> 'packageName' = package_name_value
        AND source ->> 'installationId' = installation_id_value
        AND source ->> 'generationDigest' =
          materialized_record.generation_digest
        AND source ->> 'lockDigest' = lock_digest_value
        AND source ->> 'revisionDigest' =
          materialized_record.revision_digest
    ) THEN
      RAISE EXCEPTION 'enabled Package is absent from Tool snapshot'
        USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO "ql3"."project_tool_definition_snapshots" (
      project_id, active_vector_digest, definitions_digest,
      snapshot_digest, snapshot_json, committed_at_ms
    ) VALUES (
      project_id_value,
      p_snapshot ->> 'activeVectorDigest',
      p_snapshot ->> 'definitionsDigest',
      p_snapshot ->> 'snapshotDigest',
      p_snapshot,
      committed_at_value
    )
    ON CONFLICT (project_id, active_vector_digest) DO NOTHING;
    GET DIAGNOSTICS inserted_snapshot = ROW_COUNT;
    IF inserted_snapshot = 1 THEN
      INSERT INTO "ql3"."project_tool_definition_snapshot_sources" (
        project_id, active_vector_digest, package_name, installation_id,
        generation, generation_digest, lock_digest, revision_digest
      )
      SELECT
        project_id_value,
        p_snapshot ->> 'activeVectorDigest',
        source ->> 'packageName',
        source ->> 'installationId',
        (source ->> 'generation')::integer,
        source ->> 'generationDigest',
        source ->> 'lockDigest',
        source ->> 'revisionDigest'
      FROM jsonb_array_elements(p_snapshot -> 'sources') AS source;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "ql3"."project_tool_definition_snapshots"
      WHERE project_id = project_id_value
        AND active_vector_digest = p_snapshot ->> 'activeVectorDigest'
        AND snapshot_json = p_snapshot
    ) THEN
      RAISE EXCEPTION 'Package lifecycle snapshot conflicts'
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  INSERT INTO "ql3"."plugin_package_lifecycle_events" (
    event_digest, mutation_id, dispatch_id, approved_action_type, action,
    project_id, package_name, installation_id, lock_digest,
    install_version, install_record_digest, expected_version,
    expected_disposition, expected_event_digest, generation_digest,
    materialized_revision_digest, current_tool_snapshot_digest,
    reference_graph_digest, impact_digest, action_digest,
    requested_by_type, requested_by_id, approved_by_type, approved_by_id,
    authorization_mode, occurred_at_ms, event_json
  ) VALUES (
    event_digest_value,
    p_event ->> 'mutationId',
    p_event ->> 'dispatchId',
    'plugin_package.lifecycle.' || action_value,
    action_value,
    project_id_value,
    package_name_value,
    installation_id_value,
    lock_digest_value,
    (p_event -> 'impact' -> 'target' ->> 'installVersion')::integer,
    p_event -> 'impact' -> 'target' ->> 'installRecordDigest',
    expected_version_value,
    p_event -> 'impact' -> 'expected' ->> 'disposition',
    expected_event_digest_value,
    p_event -> 'impact' ->> 'generationDigest',
    p_event -> 'impact' ->> 'materializedRevisionDigest',
    p_event -> 'impact' ->> 'currentToolSnapshotDigest',
    p_event -> 'impact' ->> 'referenceGraphDigest',
    p_event -> 'impact' ->> 'impactDigest',
    p_event ->> 'actionDigest',
    p_event -> 'requestedBy' ->> 'type',
    p_event -> 'requestedBy' ->> 'id',
    p_event -> 'approvedBy' ->> 'type',
    p_event -> 'approvedBy' ->> 'id',
    p_event ->> 'authorizationMode',
    (p_event ->> 'occurredAtMs')::bigint,
    p_event
  );

  INSERT INTO "ql3"."plugin_package_lifecycle_receipts" (
    event_digest, receipt_digest, project_id, action, capability_status,
    task_count, previous_active_vector_digest,
    current_active_vector_digest, current_tool_snapshot_digest,
    retained_source_count, committed_at_ms, receipt_json
  ) VALUES (
    event_digest_value,
    p_receipt ->> 'receiptDigest',
    project_id_value,
    action_value,
    p_receipt -> 'capability' ->> 'status',
    expected_task_count,
    p_receipt -> 'capability' ->> 'previousActiveVectorDigest',
    p_receipt -> 'capability' ->> 'currentActiveVectorDigest',
    p_receipt -> 'capability' ->> 'currentToolSnapshotDigest',
    (p_receipt -> 'capability' ->> 'retainedSourceCount')::integer,
    committed_at_value,
    p_receipt
  );

  INSERT INTO "ql3"."plugin_package_lifecycle_tasks" (
    event_digest, project_id, task_id, previous_revision,
    current_revision, previous_content_digest, current_content_digest,
    previous_enabled, current_enabled
  )
  SELECT
    event_digest_value,
    project_id_value,
    item ->> 'taskId',
    (item ->> 'previousRevision')::integer,
    (item ->> 'currentRevision')::integer,
    item ->> 'previousContentDigest',
    item ->> 'currentContentDigest',
    (item ->> 'previousEnabled')::boolean,
    (item ->> 'currentEnabled')::boolean
  FROM jsonb_array_elements(
    p_receipt -> 'capability' -> 'taskTransitions'
  ) AS item;

  INSERT INTO "ql3"."plugin_package_lifecycle_heads" (
    project_id, package_name, installation_id, lock_digest,
    install_record_digest, version, disposition, event_digest,
    updated_at_ms
  ) VALUES (
    project_id_value,
    package_name_value,
    installation_id_value,
    lock_digest_value,
    install_record.record_digest,
    expected_version_value + 1,
    CASE action_value
      WHEN 'enable' THEN 'active'
      WHEN 'disable' THEN 'disabled'
      ELSE 'uninstalled'
    END,
    event_digest_value,
    committed_at_value
  )
  ON CONFLICT (project_id, package_name) DO UPDATE SET
    installation_id = EXCLUDED.installation_id,
    lock_digest = EXCLUDED.lock_digest,
    install_record_digest = EXCLUDED.install_record_digest,
    version = EXCLUDED.version,
    disposition = EXCLUDED.disposition,
    event_digest = EXCLUDED.event_digest,
    updated_at_ms = EXCLUDED.updated_at_ms
  WHERE (
    plugin_package_lifecycle_heads.installation_id =
      EXCLUDED.installation_id
    AND plugin_package_lifecycle_heads.lock_digest = EXCLUDED.lock_digest
    AND plugin_package_lifecycle_heads.version = EXCLUDED.version - 1
    AND plugin_package_lifecycle_heads.event_digest IS NOT DISTINCT FROM
      expected_event_digest_value
  ) OR (
    EXCLUDED.version = 1 AND (
      plugin_package_lifecycle_heads.installation_id <>
        EXCLUDED.installation_id OR
      plugin_package_lifecycle_heads.lock_digest <> EXCLUDED.lock_digest
    )
  );
  GET DIAGNOSTICS updated_head = ROW_COUNT;
  IF updated_head <> 1 THEN
    RAISE EXCEPTION 'Package lifecycle head update lost its fence'
      USING ERRCODE = 'serialization_failure';
  END IF;

  RETURN true;
END
$ql3$
      `.trim(),
      `
REVOKE ALL ON
  "ql3"."plugin_package_lifecycle_events",
  "ql3"."plugin_package_lifecycle_heads",
  "ql3"."plugin_package_lifecycle_receipts",
  "ql3"."plugin_package_lifecycle_tasks"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
REVOKE ALL ON FUNCTION
  "ql3"."plugin_package_lifecycle_blocking_runs"(varchar, varchar, integer)
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
REVOKE ALL ON FUNCTION
  "ql3"."commit_plugin_package_lifecycle"(jsonb, jsonb, jsonb, jsonb)
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `GRANT SELECT ON "ql3"."plugin_package_lifecycle_events", "ql3"."plugin_package_lifecycle_heads", "ql3"."plugin_package_lifecycle_receipts", "ql3"."plugin_package_lifecycle_tasks" TO ql3_package_executor`,
      `GRANT EXECUTE ON FUNCTION "ql3"."plugin_package_lifecycle_blocking_runs"(varchar, varchar, integer) TO ql3_package_executor`,
      `GRANT EXECUTE ON FUNCTION "ql3"."commit_plugin_package_lifecycle"(jsonb, jsonb, jsonb, jsonb) TO ql3_package_executor`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 40,
      migration_id = 'pg-0041-plugin-package-lifecycle',
      capabilities = '${CAPABILITIES_V40}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 39
    AND migration_id =
      'pg-0040-plugin-package-publisher-trust-transitions'
    AND capabilities = '${CAPABILITIES_V39}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 39'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
