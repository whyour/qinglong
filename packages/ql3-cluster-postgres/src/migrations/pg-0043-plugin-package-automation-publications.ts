import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V41 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V42 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_automation_publication":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_lifecycle":1,"plugin_package_lifecycle_plan":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0043PluginPackageAutomationPublicationsMigration =
  definePostgresSqlMigration({
    id: 'pg-0043-plugin-package-automation-publications',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_automation_publications" (
  publication_digest char(64) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  lock_digest char(64) NOT NULL,
  generation integer NOT NULL,
  generation_digest char(64) NOT NULL,
  materialized_revision_digest char(64) NOT NULL,
  state varchar(16) NOT NULL,
  version integer NOT NULL,
  previous_publication_digest char(64),
  lifecycle_event_digest char(64),
  published_at_ms bigint NOT NULL,
  publication_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_automation_publication_revision_fk
    FOREIGN KEY (generation_digest)
    REFERENCES "ql3"."plugin_package_materialized_revisions" (
      generation_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_automation_publication_previous_fk
    FOREIGN KEY (previous_publication_digest)
    REFERENCES "ql3"."plugin_package_automation_publications" (
      publication_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_automation_publication_lifecycle_fk
    FOREIGN KEY (lifecycle_event_digest)
    REFERENCES "ql3"."plugin_package_lifecycle_events" (event_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_automation_publication_identity_check CHECK (
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    generation BETWEEN 1 AND 2147483647 AND
    state IN ('active', 'withdrawn', 'absent') AND
    version BETWEEN 1 AND 2147483647 AND
    published_at_ms >= 0 AND
    (
      version = 1 AND state IN ('active', 'absent') AND
      previous_publication_digest IS NULL AND
      lifecycle_event_digest IS NULL
      OR
      version > 1 AND previous_publication_digest IS NOT NULL
    ) AND
    (state <> 'withdrawn' OR lifecycle_event_digest IS NOT NULL)
  ),
  CONSTRAINT ql3_plugin_package_automation_publication_digest_check CHECK (
    publication_digest ~ '^[0-9a-f]{64}$' AND
    lock_digest ~ '^[0-9a-f]{64}$' AND
    generation_digest ~ '^[0-9a-f]{64}$' AND
    materialized_revision_digest ~ '^[0-9a-f]{64}$' AND
    (
      previous_publication_digest IS NULL OR
      previous_publication_digest ~ '^[0-9a-f]{64}$'
    ) AND
    (
      lifecycle_event_digest IS NULL OR
      lifecycle_event_digest ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT ql3_plugin_package_automation_publication_json_check CHECK (
    jsonb_typeof(publication_json) = 'object' AND
    octet_length(publication_json::text) BETWEEN 2 AND 12582912 AND
    publication_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-automation-publication@v1',
      'state', state,
      'version', version,
      'previousPublicationDigest', previous_publication_digest,
      'lifecycleEventDigest', lifecycle_event_digest,
      'publishedAtMs', published_at_ms,
      'publicationDigest', publication_digest,
      'target', jsonb_build_object(
        'projectId', project_id,
        'packageName', package_name,
        'installationId', installation_id,
        'lockDigest', lock_digest,
        'generation', generation,
        'generationDigest', generation_digest,
        'materializedRevisionDigest', materialized_revision_digest
      )
    ) AND
    jsonb_typeof(publication_json -> 'definitions' -> 'workflows') =
      'array' AND
    jsonb_typeof(publication_json -> 'definitions' -> 'prompts') =
      'array' AND
    (
      state = 'absent' AND
      jsonb_array_length(publication_json -> 'definitions' -> 'workflows') +
        jsonb_array_length(publication_json -> 'definitions' -> 'prompts') = 0
      OR
      state <> 'absent' AND
      jsonb_array_length(publication_json -> 'definitions' -> 'workflows') +
        jsonb_array_length(publication_json -> 'definitions' -> 'prompts') > 0
    )
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_automation_publication_version_key ON "ql3"."plugin_package_automation_publications" (project_id, package_name, version)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_automation_publication_previous_key ON "ql3"."plugin_package_automation_publications" (previous_publication_digest) WHERE previous_publication_digest IS NOT NULL`,
      `CREATE INDEX ql3_plugin_package_automation_publication_generation_idx ON "ql3"."plugin_package_automation_publications" (generation_digest, publication_digest)`,
      `
CREATE TABLE "ql3"."plugin_package_automation_publication_heads" (
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  publication_digest char(64) NOT NULL,
  generation_digest char(64) NOT NULL,
  state varchar(16) NOT NULL,
  version integer NOT NULL,
  updated_at_ms bigint NOT NULL,
  PRIMARY KEY (project_id, package_name),
  CONSTRAINT ql3_plugin_package_automation_publication_head_publication_fk
    FOREIGN KEY (publication_digest)
    REFERENCES "ql3"."plugin_package_automation_publications" (
      publication_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_automation_publication_head_state_check CHECK (
    publication_digest ~ '^[0-9a-f]{64}$' AND
    generation_digest ~ '^[0-9a-f]{64}$' AND
    state IN ('active', 'withdrawn', 'absent') AND
    version BETWEEN 1 AND 2147483647 AND
    updated_at_ms >= 0
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_automation_publication_head_digest_key ON "ql3"."plugin_package_automation_publication_heads" (publication_digest)`,
      `
REVOKE ALL
ON "ql3"."plugin_package_automation_publications",
   "ql3"."plugin_package_automation_publication_heads"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT
ON "ql3"."plugin_package_automation_publications",
   "ql3"."plugin_package_automation_publication_heads"
TO ql3_runtime, ql3_package_manager, ql3_package_executor
      `.trim(),
      `
GRANT INSERT
ON "ql3"."plugin_package_automation_publications"
TO ql3_package_executor
      `.trim(),
      `
GRANT INSERT, UPDATE
ON "ql3"."plugin_package_automation_publication_heads"
TO ql3_package_executor
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 42,
      migration_id = 'pg-0043-plugin-package-automation-publications',
      capabilities = '${CAPABILITIES_V42}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 41
    AND migration_id = 'pg-0042-plugin-package-lifecycle-plans'
    AND capabilities = '${CAPABILITIES_V41}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 41'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
