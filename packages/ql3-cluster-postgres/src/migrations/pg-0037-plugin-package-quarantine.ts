import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V35 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V36 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0037PluginPackageQuarantineMigration =
  definePostgresSqlMigration({
    id: 'pg-0037-plugin-package-quarantine',
    statements: [
      `
ALTER TABLE "ql3"."plugin_package_installs"
ADD CONSTRAINT ql3_plugin_package_installs_quarantine_target_key
UNIQUE (
  project_id, package_name, installation_id, lock_digest, record_digest
)
      `.trim(),
      `
ALTER TABLE "ql3"."project_tool_definition_snapshots"
ADD CONSTRAINT ql3_project_tool_snapshot_withdrawal_key
UNIQUE (project_id, active_vector_digest, snapshot_digest)
      `.trim(),
      `
CREATE TABLE "ql3"."plugin_package_quarantine_events" (
  event_digest char(64) PRIMARY KEY,
  mutation_id varchar(128) NOT NULL,
  revocation_receipt_digest char(64) NOT NULL,
  impact_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  lock_digest char(64) NOT NULL,
  install_state varchar(16) NOT NULL,
  install_version integer NOT NULL,
  install_record_digest char(64) NOT NULL,
  active_lock_digest char(64),
  proposer_type varchar(16) NOT NULL,
  proposer_id varchar(255) NOT NULL,
  confirmer_type varchar(16) NOT NULL,
  confirmer_id varchar(255) NOT NULL,
  authorization_mode varchar(16) NOT NULL,
  reason_code varchar(32) NOT NULL,
  occurred_at_ms bigint NOT NULL,
  event_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_quarantine_install_fk FOREIGN KEY (
    project_id, package_name, installation_id, lock_digest,
    install_record_digest
  ) REFERENCES "ql3"."plugin_package_installs" (
    project_id, package_name, installation_id, lock_digest, record_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_quarantine_identity_check CHECK (
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    install_state IN ('queued', 'staged', 'activating', 'active') AND
    install_version BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_plugin_package_quarantine_state_check CHECK (
    (install_state = 'active' AND active_lock_digest = lock_digest) OR
    (install_state <> 'active' AND
      (active_lock_digest IS NULL OR active_lock_digest <> lock_digest))
  ),
  CONSTRAINT ql3_plugin_package_quarantine_subject_check CHECK (
    proposer_type IN (
      'user', 'api_app', 'mcp_client', 'agent', 'system', 'worker'
    ) AND
    confirmer_type IN (
      'user', 'api_app', 'mcp_client', 'agent', 'system', 'worker'
    ) AND
    octet_length(proposer_id) BETWEEN 1 AND 255 AND
    octet_length(confirmer_id) BETWEEN 1 AND 255 AND
    authorization_mode IN ('dual_control', 'break_glass') AND
    (authorization_mode = 'break_glass' OR
      proposer_type <> confirmer_type OR proposer_id <> confirmer_id) AND
    reason_code IN (
      'suspected_key_compromise', 'confirmed_key_compromise'
    )
  ),
  CONSTRAINT ql3_plugin_package_quarantine_digest_check CHECK (
    event_digest ~ '^[0-9a-f]{64}$' AND
    revocation_receipt_digest ~ '^[0-9a-f]{64}$' AND
    impact_digest ~ '^[0-9a-f]{64}$' AND
    lock_digest ~ '^[0-9a-f]{64}$' AND
    install_record_digest ~ '^[0-9a-f]{64}$' AND
    (active_lock_digest IS NULL OR
      active_lock_digest ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT ql3_plugin_package_quarantine_json_check CHECK (
    jsonb_typeof(event_json) = 'object' AND
    octet_length(event_json::text) BETWEEN 2 AND 262144 AND
    event_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-quarantine-event@v1',
      'mutationId', mutation_id,
      'revocationReceiptDigest', revocation_receipt_digest,
      'impactDigest', impact_digest,
      'authorizationMode', authorization_mode,
      'reasonCode', reason_code,
      'occurredAtMs', occurred_at_ms,
      'eventDigest', event_digest
    ) AND
    event_json -> 'target' @> jsonb_build_object(
      'projectId', project_id,
      'packageName', package_name,
      'installationId', installation_id,
      'lockDigest', lock_digest,
      'installState', install_state,
      'installVersion', install_version,
      'installRecordDigest', install_record_digest,
      'activeLockDigest', active_lock_digest
    ) AND
    event_json -> 'proposer' @> jsonb_build_object(
      'type', proposer_type, 'id', proposer_id
    ) AND
    event_json -> 'confirmer' @> jsonb_build_object(
      'type', confirmer_type, 'id', confirmer_id
    )
  ),
  CONSTRAINT ql3_plugin_package_quarantine_time_check CHECK (
    occurred_at_ms >= 0
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_quarantine_mutation_key ON "ql3"."plugin_package_quarantine_events" (mutation_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_quarantine_target_key ON "ql3"."plugin_package_quarantine_events" (project_id, package_name, installation_id, lock_digest)`,
      `CREATE INDEX ql3_plugin_package_quarantine_lock_idx ON "ql3"."plugin_package_quarantine_events" (lock_digest, project_id, package_name)`,
      `CREATE INDEX ql3_plugin_package_quarantine_project_idx ON "ql3"."plugin_package_quarantine_events" (project_id, package_name, occurred_at_ms, event_digest)`,
      `
CREATE TABLE "ql3"."plugin_package_withdrawal_receipts" (
  event_digest char(64) PRIMARY KEY,
  receipt_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  capability_status varchar(16) NOT NULL,
  task_count integer NOT NULL,
  previous_active_vector_digest char(64),
  current_active_vector_digest char(64),
  current_tool_snapshot_digest char(64),
  retained_source_count integer NOT NULL,
  committed_at_ms bigint NOT NULL,
  receipt_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_withdrawal_event_fk FOREIGN KEY (
    event_digest
  ) REFERENCES "ql3"."plugin_package_quarantine_events" (event_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_withdrawal_snapshot_fk FOREIGN KEY (
    project_id, current_active_vector_digest, current_tool_snapshot_digest
  ) REFERENCES "ql3"."project_tool_definition_snapshots" (
    project_id, active_vector_digest, snapshot_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_withdrawal_disposition_check CHECK (
    (
      capability_status = 'not_active' AND task_count = 0 AND
      previous_active_vector_digest IS NULL AND
      current_active_vector_digest IS NULL AND
      current_tool_snapshot_digest IS NULL AND retained_source_count = 0
    ) OR (
      capability_status = 'withdrawn' AND task_count BETWEEN 0 AND 128 AND
      previous_active_vector_digest IS NOT NULL AND
      current_active_vector_digest IS NOT NULL AND
      previous_active_vector_digest <> current_active_vector_digest AND
      current_tool_snapshot_digest IS NOT NULL AND
      retained_source_count BETWEEN 0 AND 128
    )
  ),
  CONSTRAINT ql3_plugin_package_withdrawal_digest_check CHECK (
    event_digest ~ '^[0-9a-f]{64}$' AND
    receipt_digest ~ '^[0-9a-f]{64}$' AND
    (previous_active_vector_digest IS NULL OR
      previous_active_vector_digest ~ '^[0-9a-f]{64}$') AND
    (current_active_vector_digest IS NULL OR
      current_active_vector_digest ~ '^[0-9a-f]{64}$') AND
    (current_tool_snapshot_digest IS NULL OR
      current_tool_snapshot_digest ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT ql3_plugin_package_withdrawal_json_check CHECK (
    jsonb_typeof(receipt_json) = 'object' AND
    octet_length(receipt_json::text) BETWEEN 2 AND 8388608 AND
    receipt_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-withdrawal-receipt@v1',
      'eventDigest', event_digest,
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
      receipt_json -> 'capability' -> 'taskWithdrawals'
    ) = task_count
  ),
  CONSTRAINT ql3_plugin_package_withdrawal_time_check CHECK (
    committed_at_ms >= 0
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_withdrawal_receipt_key ON "ql3"."plugin_package_withdrawal_receipts" (receipt_digest)`,
      `CREATE INDEX ql3_plugin_package_withdrawal_snapshot_idx ON "ql3"."plugin_package_withdrawal_receipts" (current_tool_snapshot_digest, event_digest)`,
      `
CREATE TABLE "ql3"."plugin_package_withdrawal_tasks" (
  event_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  task_id varchar(128) NOT NULL,
  previous_revision integer NOT NULL,
  disabled_revision integer NOT NULL,
  previous_content_digest char(64) NOT NULL,
  disabled_content_digest char(64) NOT NULL,
  PRIMARY KEY (event_digest, task_id),
  CONSTRAINT ql3_plugin_package_withdrawal_task_receipt_fk FOREIGN KEY (
    event_digest
  ) REFERENCES "ql3"."plugin_package_withdrawal_receipts" (event_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_withdrawal_task_previous_fk FOREIGN KEY (
    project_id, task_id, previous_revision
  ) REFERENCES "ql3"."task_definition_revisions" (
    project_id, task_id, revision
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_withdrawal_task_disabled_fk FOREIGN KEY (
    project_id, task_id, disabled_revision
  ) REFERENCES "ql3"."task_definition_revisions" (
    project_id, task_id, revision
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_withdrawal_task_identity_check CHECK (
    task_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    previous_revision BETWEEN 1 AND 2147483646 AND
    disabled_revision = previous_revision + 1
  ),
  CONSTRAINT ql3_plugin_package_withdrawal_task_digest_check CHECK (
    event_digest ~ '^[0-9a-f]{64}$' AND
    previous_content_digest ~ '^[0-9a-f]{64}$' AND
    disabled_content_digest ~ '^[0-9a-f]{64}$'
  )
)
      `.trim(),
      `CREATE INDEX ql3_plugin_package_withdrawal_task_idx ON "ql3"."plugin_package_withdrawal_tasks" (project_id, task_id, event_digest)`,
      `
CREATE FUNCTION "ql3"."plugin_package_run_start_allowed"(
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
  );
END
$ql3$
      `.trim(),
      `
CREATE FUNCTION "ql3"."plugin_package_tool_start_allowed"(
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
      AND 'tool:' ||
        (definition.item -> 'definition' ->> 'name') || '@' ||
        (definition.item -> 'definition' ->> 'version') = p_definition_ref
      AND definition.item ->> 'definitionDigest' = p_definition_digest
  );
END
$ql3$
      `.trim(),
      `
CREATE FUNCTION "ql3"."commit_plugin_package_quarantine"(
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
  project_id_value varchar(128);
  package_name_value varchar(63);
  installation_id_value varchar(128);
  lock_digest_value char(64);
  install_record "ql3"."plugin_package_installs"%ROWTYPE;
  existing_event jsonb;
  existing_receipt jsonb;
  task_write jsonb;
  previous_task "ql3"."task_definition_revisions"%ROWTYPE;
  disabled_task jsonb;
  withdrawal jsonb;
  enabled_task_count integer;
  source_count integer;
  inserted_snapshot integer;
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
    RAISE EXCEPTION 'invalid Package quarantine input'
      USING ERRCODE = 'check_violation';
  END IF;

  event_digest_value := p_event ->> 'eventDigest';
  project_id_value := p_event -> 'target' ->> 'projectId';
  package_name_value := p_event -> 'target' ->> 'packageName';
  installation_id_value := p_event -> 'target' ->> 'installationId';
  lock_digest_value := p_event -> 'target' ->> 'lockDigest';

  IF p_receipt ->> 'eventDigest' IS DISTINCT FROM event_digest_value
     OR p_receipt -> 'target' IS DISTINCT FROM p_event -> 'target'
     OR (p_receipt ->> 'committedAtMs')::bigint <
       (p_event ->> 'occurredAtMs')::bigint THEN
    RAISE EXCEPTION 'Package quarantine receipt does not bind the event'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1 FROM "ql3"."projects"
  WHERE id = project_id_value
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Package quarantine Project is absent'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT event_json INTO existing_event
  FROM "ql3"."plugin_package_quarantine_events"
  WHERE event_digest = event_digest_value;
  IF FOUND THEN
    SELECT receipt_json INTO existing_receipt
    FROM "ql3"."plugin_package_withdrawal_receipts"
    WHERE event_digest = event_digest_value;
    IF NOT FOUND
       OR existing_event IS DISTINCT FROM p_event
       OR existing_receipt IS DISTINCT FROM p_receipt THEN
      RAISE EXCEPTION 'Package quarantine replay conflicts'
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
     OR install_record.state <> p_event -> 'target' ->> 'installState'
     OR install_record.version <>
       (p_event -> 'target' ->> 'installVersion')::integer
     OR install_record.record_digest <>
       p_event -> 'target' ->> 'installRecordDigest'
     OR install_record.active_lock_digest IS DISTINCT FROM
       p_event -> 'target' ->> 'activeLockDigest' THEN
    RAISE EXCEPTION 'Package quarantine target drifted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF install_record.state = 'active' AND NOT EXISTS (
    SELECT 1
    FROM "ql3"."plugin_package_install_heads" AS head
    JOIN "ql3"."plugin_package_installs" AS head_install
      ON head_install.installation_id = head.installation_id
    JOIN "ql3"."plugin_package_materialized_revisions" AS revision
      ON revision.project_id = install_record.project_id
     AND revision.package_name = install_record.package_name
     AND revision.generation = install_record.target_generation
     AND revision.lock_digest = install_record.lock_digest
    WHERE head.project_id = install_record.project_id
      AND head.package_name = install_record.package_name
      AND head.installation_id = install_record.installation_id
      AND head_install.active_lock_digest = install_record.lock_digest
  ) THEN
    RAISE EXCEPTION 'active Package quarantine target is not materialized'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO "ql3"."plugin_package_quarantine_events" (
    event_digest, mutation_id, revocation_receipt_digest, impact_digest,
    project_id, package_name, installation_id, lock_digest,
    install_state, install_version, install_record_digest,
    active_lock_digest, proposer_type, proposer_id, confirmer_type,
    confirmer_id, authorization_mode, reason_code, occurred_at_ms, event_json
  ) VALUES (
    event_digest_value,
    p_event ->> 'mutationId',
    p_event ->> 'revocationReceiptDigest',
    p_event ->> 'impactDigest',
    project_id_value,
    package_name_value,
    installation_id_value,
    lock_digest_value,
    p_event -> 'target' ->> 'installState',
    (p_event -> 'target' ->> 'installVersion')::integer,
    p_event -> 'target' ->> 'installRecordDigest',
    p_event -> 'target' ->> 'activeLockDigest',
    p_event -> 'proposer' ->> 'type',
    p_event -> 'proposer' ->> 'id',
    p_event -> 'confirmer' ->> 'type',
    p_event -> 'confirmer' ->> 'id',
    p_event ->> 'authorizationMode',
    p_event ->> 'reasonCode',
    (p_event ->> 'occurredAtMs')::bigint,
    p_event
  );

  IF install_record.state <> 'active' THEN
    IF p_snapshot <> 'null'::jsonb OR jsonb_array_length(p_task_writes) <> 0
       OR p_receipt -> 'capability' ->> 'status' <> 'not_active' THEN
      RAISE EXCEPTION 'inactive Package quarantine disposition is invalid'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF p_snapshot = 'null'::jsonb
       OR p_receipt -> 'capability' ->> 'status' <> 'withdrawn' THEN
      RAISE EXCEPTION 'active Package quarantine disposition is invalid'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(*)::integer INTO source_count
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
    WHERE head.project_id = project_id_value
      AND head_install.active_lock_digest IS NOT NULL
      AND active_install.state = 'active'
      AND quarantine.event_digest IS NULL;
    IF source_count > 128
       OR source_count <>
         jsonb_array_length(p_snapshot -> 'sources')
       OR source_count <>
         (p_receipt -> 'capability' ->> 'retainedSourceCount')::integer
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
         WHERE head.project_id = project_id_value
           AND head_install.active_lock_digest IS NOT NULL
           AND active_install.state = 'active'
           AND quarantine.event_digest IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(
               p_snapshot -> 'sources'
             ) AS source
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
      RAISE EXCEPTION 'Package quarantine Tool source vector drifted'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(*)::integer INTO enabled_task_count
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
      AND revision.enabled = true;
    IF enabled_task_count > 128
       OR enabled_task_count <> jsonb_array_length(p_task_writes)
       OR enabled_task_count <>
         jsonb_array_length(
           p_receipt -> 'capability' -> 'taskWithdrawals'
         ) THEN
      RAISE EXCEPTION 'Package quarantine Task set drifted'
        USING ERRCODE = 'check_violation';
    END IF;

    FOR task_write IN SELECT value FROM jsonb_array_elements(p_task_writes)
    LOOP
      disabled_task := task_write -> 'disabled';
      withdrawal := task_write -> 'withdrawal';
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
        AND ownership.task_id = withdrawal ->> 'taskId'
        AND revision.enabled = true
      FOR UPDATE OF head;
      IF NOT FOUND
         OR previous_task.revision <>
           (withdrawal ->> 'previousRevision')::integer
         OR previous_task.content_digest <>
           withdrawal ->> 'previousContentDigest'
         OR disabled_task ->> 'projectId' <> project_id_value
         OR disabled_task ->> 'taskId' <> withdrawal ->> 'taskId'
         OR (disabled_task ->> 'revision')::integer <>
           previous_task.revision + 1
         OR (disabled_task ->> 'enabled')::boolean <> false
         OR disabled_task ->> 'contentDigest' <>
           withdrawal ->> 'disabledContentDigest' THEN
        RAISE EXCEPTION 'Package quarantine Task write drifted'
          USING ERRCODE = 'check_violation';
      END IF;

      INSERT INTO "ql3"."task_definition_revisions" (
        project_id, task_id, revision, mutation_id, name, description,
        kind, spec_json, labels_json, enabled, content_digest, created_at_ms
      ) VALUES (
        project_id_value,
        disabled_task ->> 'taskId',
        (disabled_task ->> 'revision')::integer,
        (disabled_task ->> 'mutationId')::uuid,
        disabled_task ->> 'name',
        disabled_task ->> 'description',
        disabled_task ->> 'kind',
        disabled_task -> 'spec',
        disabled_task -> 'labels',
        false,
        disabled_task ->> 'contentDigest',
        (disabled_task ->> 'updatedAtMs')::bigint
      );
      UPDATE "ql3"."task_definitions"
      SET current_revision = (disabled_task ->> 'revision')::integer,
          updated_at_ms = (disabled_task ->> 'updatedAtMs')::bigint
      WHERE project_id = project_id_value
        AND task_id = disabled_task ->> 'taskId'
        AND current_revision = previous_task.revision;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Package quarantine Task head drifted'
          USING ERRCODE = 'serialization_failure';
      END IF;
    END LOOP;

    INSERT INTO "ql3"."project_tool_definition_snapshots" (
      project_id, active_vector_digest, definitions_digest,
      snapshot_digest, snapshot_json, committed_at_ms
    ) VALUES (
      project_id_value,
      p_snapshot ->> 'activeVectorDigest',
      p_snapshot ->> 'definitionsDigest',
      p_snapshot ->> 'snapshotDigest',
      p_snapshot,
      (p_receipt ->> 'committedAtMs')::bigint
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
      SELECT 1
      FROM "ql3"."project_tool_definition_snapshots"
      WHERE project_id = project_id_value
        AND active_vector_digest = p_snapshot ->> 'activeVectorDigest'
        AND snapshot_json = p_snapshot
    ) THEN
      RAISE EXCEPTION 'Package quarantine snapshot conflicts'
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  INSERT INTO "ql3"."plugin_package_withdrawal_receipts" (
    event_digest, receipt_digest, project_id, capability_status,
    task_count, previous_active_vector_digest,
    current_active_vector_digest, current_tool_snapshot_digest,
    retained_source_count, committed_at_ms, receipt_json
  ) VALUES (
    event_digest_value,
    p_receipt ->> 'receiptDigest',
    project_id_value,
    p_receipt -> 'capability' ->> 'status',
    jsonb_array_length(
      p_receipt -> 'capability' -> 'taskWithdrawals'
    ),
    p_receipt -> 'capability' ->> 'previousActiveVectorDigest',
    p_receipt -> 'capability' ->> 'currentActiveVectorDigest',
    p_receipt -> 'capability' ->> 'currentToolSnapshotDigest',
    (p_receipt -> 'capability' ->> 'retainedSourceCount')::integer,
    (p_receipt ->> 'committedAtMs')::bigint,
    p_receipt
  );

  INSERT INTO "ql3"."plugin_package_withdrawal_tasks" (
    event_digest, project_id, task_id, previous_revision,
    disabled_revision, previous_content_digest, disabled_content_digest
  )
  SELECT
    event_digest_value,
    project_id_value,
    receipt_withdrawal ->> 'taskId',
    (receipt_withdrawal ->> 'previousRevision')::integer,
    (receipt_withdrawal ->> 'disabledRevision')::integer,
    receipt_withdrawal ->> 'previousContentDigest',
    receipt_withdrawal ->> 'disabledContentDigest'
  FROM jsonb_array_elements(
    p_receipt -> 'capability' -> 'taskWithdrawals'
  ) AS receipt_withdrawal;

  RETURN true;
END
$ql3$
      `.trim(),
      `
REVOKE ALL ON
  "ql3"."plugin_package_quarantine_events",
  "ql3"."plugin_package_withdrawal_receipts",
  "ql3"."plugin_package_withdrawal_tasks"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
REVOKE ALL ON FUNCTION
  "ql3"."plugin_package_run_start_allowed"(varchar, varchar, varchar),
  "ql3"."plugin_package_tool_start_allowed"(varchar, varchar, char(64)),
  "ql3"."commit_plugin_package_quarantine"(jsonb, jsonb, jsonb, jsonb)
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `GRANT SELECT ON "ql3"."plugin_package_quarantine_events", "ql3"."plugin_package_withdrawal_receipts", "ql3"."plugin_package_withdrawal_tasks" TO ql3_package_executor`,
      `GRANT EXECUTE ON FUNCTION "ql3"."plugin_package_run_start_allowed"(varchar, varchar, varchar), "ql3"."plugin_package_tool_start_allowed"(varchar, varchar, char(64)) TO ql3_runtime`,
      `GRANT EXECUTE ON FUNCTION "ql3"."commit_plugin_package_quarantine"(jsonb, jsonb, jsonb, jsonb) TO ql3_package_executor`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 36,
      migration_id = 'pg-0037-plugin-package-quarantine',
      capabilities = '${CAPABILITIES_V36}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 35
    AND migration_id = 'pg-0036-tool-result-rekey-overlays'
    AND capabilities = '${CAPABILITIES_V35}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 35'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
