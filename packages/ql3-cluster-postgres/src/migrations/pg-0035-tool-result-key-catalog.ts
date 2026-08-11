import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V33 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V34 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0035ToolResultKeyCatalogMigration = definePostgresSqlMigration({
  id: 'pg-0035-tool-result-key-catalog',
  statements: [
    `
CREATE TABLE "ql3"."tool_result_key_catalog_generations" (
  authority varchar(64) NOT NULL,
  generation integer NOT NULL,
  previous_generation integer,
  previous_catalog_digest char(64),
  active_key_id varchar(128),
  mutation_kind varchar(16) NOT NULL,
  mutation_id varchar(128) NOT NULL,
  catalog_digest char(64) NOT NULL,
  command_digest char(64) NOT NULL,
  committed_at_ms bigint NOT NULL,
  catalog_json jsonb NOT NULL,
  PRIMARY KEY (authority, generation),
  CONSTRAINT ql3_tool_result_key_catalog_generation_digest_key
    UNIQUE (authority, generation, catalog_digest),
  CONSTRAINT ql3_tool_result_key_catalog_mutation_key
    UNIQUE (mutation_id),
  CONSTRAINT ql3_tool_result_key_catalog_digest_key
    UNIQUE (catalog_digest),
  CONSTRAINT ql3_tool_result_key_catalog_previous_fk
    FOREIGN KEY (
      authority, previous_generation, previous_catalog_digest
    )
    REFERENCES "ql3"."tool_result_key_catalog_generations" (
      authority, generation, catalog_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_key_catalog_authority_check CHECK (
    authority = 'trusted-tool-results'
  ),
  CONSTRAINT ql3_tool_result_key_catalog_generation_check CHECK (
    generation BETWEEN 1 AND 2147483647 AND
    (
      (
        generation = 1 AND
        previous_generation IS NULL AND
        previous_catalog_digest IS NULL AND
        mutation_kind = 'bootstrap'
      ) OR (
        generation > 1 AND
        previous_generation = generation - 1 AND
        previous_catalog_digest IS NOT NULL AND
        mutation_kind IN (
          'rotate', 'retire', 'mark_lost', 'restore'
        )
      )
    )
  ),
  CONSTRAINT ql3_tool_result_key_catalog_identity_check CHECK (
    active_key_id IS NULL OR
    active_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  ),
  CONSTRAINT ql3_tool_result_key_catalog_digest_check CHECK (
    (
      previous_catalog_digest IS NULL OR
      previous_catalog_digest ~ '^[0-9a-f]{64}$'
    ) AND
    catalog_digest ~ '^[0-9a-f]{64}$' AND
    command_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_tool_result_key_catalog_budget_check CHECK (
    committed_at_ms >= 0 AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    octet_length(catalog_json::text) BETWEEN 2 AND 65536
  ),
  CONSTRAINT ql3_tool_result_key_catalog_json_check CHECK (
    jsonb_typeof(catalog_json) = 'object' AND
    catalog_json @> jsonb_build_object(
      'schema', 'qinglong/tool-result-key-catalog@v1',
      'generation', generation,
      'previousCatalogDigest', previous_catalog_digest,
      'activeKeyId', active_key_id,
      'mutationKind', mutation_kind,
      'mutationId', mutation_id,
      'catalogDigest', catalog_digest,
      'committedAtMs', committed_at_ms
    ) AND
    jsonb_typeof(catalog_json -> 'keys') = 'array' AND
    jsonb_array_length(catalog_json -> 'keys') BETWEEN 1 AND 64
  )
)
      `.trim(),
    `
CREATE INDEX ql3_tool_result_key_catalog_current_idx
ON "ql3"."tool_result_key_catalog_generations"
  (authority, generation DESC)
      `.trim(),
    `
CREATE TABLE "ql3"."tool_execution_result_key_bindings" (
  start_id varchar(128) PRIMARY KEY,
  artifact_id varchar(128) NOT NULL,
  artifact_digest char(64) NOT NULL,
  catalog_authority varchar(64) NOT NULL,
  catalog_generation integer NOT NULL,
  catalog_digest char(64) NOT NULL,
  key_id varchar(128) NOT NULL,
  material_proof char(64) NOT NULL,
  binding_digest char(64) NOT NULL,
  CONSTRAINT ql3_tool_result_key_binding_artifact_key
    UNIQUE (artifact_id),
  CONSTRAINT ql3_tool_result_key_binding_digest_key
    UNIQUE (binding_digest),
  CONSTRAINT ql3_tool_result_key_binding_completion_fk
    FOREIGN KEY (start_id)
    REFERENCES "ql3"."tool_execution_completions" (start_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_key_binding_artifact_fk
    FOREIGN KEY (artifact_id)
    REFERENCES "ql3"."tool_execution_completions" (artifact_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_key_binding_catalog_fk
    FOREIGN KEY (
      catalog_authority, catalog_generation, catalog_digest
    )
    REFERENCES "ql3"."tool_result_key_catalog_generations" (
      authority, generation, catalog_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT ql3_tool_result_key_binding_authority_check CHECK (
    catalog_authority = 'trusted-tool-results'
  ),
  CONSTRAINT ql3_tool_result_key_binding_identity_check CHECK (
    start_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND
    catalog_generation BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_tool_result_key_binding_digest_check CHECK (
    artifact_digest ~ '^[0-9a-f]{64}$' AND
    catalog_digest ~ '^[0-9a-f]{64}$' AND
    material_proof ~ '^[0-9a-f]{64}$' AND
    binding_digest ~ '^[0-9a-f]{64}$'
  )
)
      `.trim(),
    `
CREATE INDEX ql3_tool_result_key_binding_catalog_idx
ON "ql3"."tool_execution_result_key_bindings"
  (catalog_generation, key_id, start_id)
      `.trim(),
    `
REVOKE ALL
ON "ql3"."tool_result_key_catalog_generations",
   "ql3"."tool_execution_result_key_bindings"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
    `
GRANT SELECT
ON "ql3"."tool_result_key_catalog_generations"
TO ql3_runtime
      `.trim(),
    `
GRANT SELECT, INSERT
ON "ql3"."tool_result_key_catalog_generations"
TO ql3_admin
      `.trim(),
    `
GRANT SELECT, INSERT
ON "ql3"."tool_execution_result_key_bindings"
TO ql3_runtime
      `.trim(),
    `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 34,
      migration_id = 'pg-0035-tool-result-key-catalog',
      capabilities = '${CAPABILITIES_V34}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 33
    AND migration_id = 'pg-0034-tool-execution-failure-completions'
    AND capabilities = '${CAPABILITIES_V33}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 33'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
  ],
});
