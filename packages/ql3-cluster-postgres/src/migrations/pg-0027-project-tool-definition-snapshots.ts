import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V25 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V26 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0027ProjectToolDefinitionSnapshotsMigration =
  definePostgresSqlMigration({
    id: 'pg-0027-project-tool-definition-snapshots',
    statements: [
      `
CREATE UNIQUE INDEX ql3_plugin_package_installs_snapshot_source_uidx
ON "ql3"."plugin_package_installs"
  (project_id, package_name, installation_id, target_generation, lock_digest)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_plugin_package_materialized_revision_snapshot_source_uidx
ON "ql3"."plugin_package_materialized_revisions"
  (project_id, package_name, generation, generation_digest,
   lock_digest, revision_digest)
      `.trim(),
      `
CREATE TABLE "ql3"."project_tool_definition_snapshots" (
  project_id varchar(128) NOT NULL,
  active_vector_digest char(64) NOT NULL,
  definitions_digest char(64) NOT NULL,
  snapshot_digest char(64) NOT NULL,
  snapshot_json jsonb NOT NULL,
  committed_at_ms bigint NOT NULL,
  CONSTRAINT project_tool_definition_snapshots_pkey
    PRIMARY KEY (project_id, active_vector_digest),
  CONSTRAINT ql3_project_tool_definition_snapshot_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_project_tool_definition_snapshot_identity_check CHECK (
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_project_tool_definition_snapshot_digest_check CHECK (
    active_vector_digest ~ '^[0-9a-f]{64}$' AND
    definitions_digest ~ '^[0-9a-f]{64}$' AND
    snapshot_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_project_tool_definition_snapshot_json_check CHECK (
    jsonb_typeof(snapshot_json) = 'object' AND
    octet_length(snapshot_json::text) BETWEEN 2 AND 8388608 AND
    snapshot_json @> jsonb_build_object(
      'schema', 'qinglong/project-tool-definition-snapshot@v1',
      'projectId', project_id,
      'activeVectorDigest', active_vector_digest,
      'definitionsDigest', definitions_digest,
      'snapshotDigest', snapshot_digest
    )
  ),
  CONSTRAINT ql3_project_tool_definition_snapshot_time_check CHECK (
    committed_at_ms >= 0
  )
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_project_tool_definition_snapshot_digest_uidx
ON "ql3"."project_tool_definition_snapshots" (snapshot_digest)
      `.trim(),
      `
CREATE INDEX ql3_project_tool_definition_snapshot_current_idx
ON "ql3"."project_tool_definition_snapshots"
  (project_id, committed_at_ms DESC, active_vector_digest)
      `.trim(),
      `
CREATE TABLE "ql3"."project_tool_definition_snapshot_sources" (
  project_id varchar(128) NOT NULL,
  active_vector_digest char(64) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  generation integer NOT NULL,
  generation_digest char(64) NOT NULL,
  lock_digest char(64) NOT NULL,
  revision_digest char(64) NOT NULL,
  CONSTRAINT project_tool_definition_snapshot_sources_pkey
    PRIMARY KEY (project_id, active_vector_digest, package_name),
  CONSTRAINT ql3_project_tool_definition_snapshot_source_snapshot_fk
    FOREIGN KEY (project_id, active_vector_digest)
    REFERENCES "ql3"."project_tool_definition_snapshots"
      (project_id, active_vector_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_project_tool_definition_snapshot_source_install_fk
    FOREIGN KEY (
      project_id, package_name, installation_id, generation, lock_digest
    )
    REFERENCES "ql3"."plugin_package_installs" (
      project_id, package_name, installation_id, target_generation, lock_digest
    )
    ON DELETE RESTRICT,
  CONSTRAINT ql3_project_tool_definition_snapshot_source_revision_fk
    FOREIGN KEY (
      project_id, package_name, generation, generation_digest,
      lock_digest, revision_digest
    )
    REFERENCES "ql3"."plugin_package_materialized_revisions" (
      project_id, package_name, generation, generation_digest,
      lock_digest, revision_digest
    )
    ON DELETE RESTRICT,
  CONSTRAINT ql3_project_tool_definition_snapshot_source_identity_check CHECK (
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    generation BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_project_tool_definition_snapshot_source_digest_check CHECK (
    active_vector_digest ~ '^[0-9a-f]{64}$' AND
    generation_digest ~ '^[0-9a-f]{64}$' AND
    lock_digest ~ '^[0-9a-f]{64}$' AND
    revision_digest ~ '^[0-9a-f]{64}$'
  )
)
      `.trim(),
      `
CREATE INDEX ql3_project_tool_definition_snapshot_source_generation_idx
ON "ql3"."project_tool_definition_snapshot_sources"
  (generation_digest, project_id, package_name)
      `.trim(),
      `
CREATE INDEX ql3_project_tool_definition_snapshot_source_install_idx
ON "ql3"."project_tool_definition_snapshot_sources"
  (installation_id, active_vector_digest)
      `.trim(),
      `
REVOKE ALL
ON "ql3"."project_tool_definition_snapshots",
   "ql3"."project_tool_definition_snapshot_sources"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."project_tool_definition_snapshots",
   "ql3"."project_tool_definition_snapshot_sources"
TO ql3_package_executor
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 26,
      migration_id = 'pg-0027-project-tool-definition-snapshots',
      capabilities = '${CAPABILITIES_V26}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 25
    AND migration_id = 'pg-0026-plugin-package-task-reconciliations'
    AND capabilities = '${CAPABILITIES_V25}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 25'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
