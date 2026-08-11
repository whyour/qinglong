import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V34 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V35 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0036ToolResultRekeyOverlaysMigration =
  definePostgresSqlMigration({
    id: 'pg-0036-tool-result-rekey-overlays',
    statements: [
      `
CREATE TABLE "ql3"."tool_execution_result_rekey_overlays" (
  overlay_id varchar(128) PRIMARY KEY,
  artifact_id varchar(128) NOT NULL,
  source_binding_digest char(64) NOT NULL,
  revision integer NOT NULL,
  previous_overlay_digest char(64),
  from_key_id varchar(128) NOT NULL,
  target_catalog_authority varchar(64) NOT NULL,
  target_catalog_generation integer NOT NULL,
  target_catalog_digest char(64) NOT NULL,
  target_key_id varchar(128) NOT NULL,
  target_material_proof char(64) NOT NULL,
  mutation_id varchar(128) NOT NULL,
  command_digest char(64) NOT NULL,
  overlay_digest char(64) NOT NULL,
  rekeyed_at_ms bigint NOT NULL,
  overlay_json jsonb NOT NULL,
  CONSTRAINT ql3_result_rekey_digest_key UNIQUE (overlay_digest),
  CONSTRAINT ql3_result_rekey_artifact_fk FOREIGN KEY (artifact_id)
    REFERENCES "ql3"."tool_execution_result_key_bindings" (artifact_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_result_rekey_binding_fk FOREIGN KEY (source_binding_digest)
    REFERENCES "ql3"."tool_execution_result_key_bindings" (binding_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_result_rekey_previous_fk FOREIGN KEY (previous_overlay_digest)
    REFERENCES "ql3"."tool_execution_result_rekey_overlays" (overlay_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_result_rekey_catalog_fk FOREIGN KEY (
    target_catalog_authority, target_catalog_generation,
    target_catalog_digest
  ) REFERENCES "ql3"."tool_result_key_catalog_generations" (
    authority, generation, catalog_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_result_rekey_revision_check CHECK (
    revision BETWEEN 1 AND 2147483647 AND
    ((revision = 1 AND previous_overlay_digest IS NULL) OR
     (revision > 1 AND previous_overlay_digest IS NOT NULL))
  ),
  CONSTRAINT ql3_result_rekey_authority_check CHECK (
    target_catalog_authority = 'trusted-tool-results'
  ),
  CONSTRAINT ql3_result_rekey_identity_check CHECK (
    overlay_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    from_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND
    target_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND
    from_key_id <> target_key_id AND
    target_catalog_generation BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_result_rekey_digest_check CHECK (
    (previous_overlay_digest IS NULL OR
      previous_overlay_digest ~ '^[0-9a-f]{64}$') AND
    source_binding_digest ~ '^[0-9a-f]{64}$' AND
    target_catalog_digest ~ '^[0-9a-f]{64}$' AND
    target_material_proof ~ '^[0-9a-f]{64}$' AND
    command_digest ~ '^[0-9a-f]{64}$' AND
    overlay_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_result_rekey_budget_check CHECK (
    rekeyed_at_ms >= 0 AND
    octet_length(overlay_json::text) BETWEEN 2 AND 393216
  ),
  CONSTRAINT ql3_result_rekey_json_check CHECK (
    jsonb_typeof(overlay_json) = 'object' AND
    overlay_json @> jsonb_build_object(
      'schema', 'qinglong/tool-execution-result-rekey-overlay@v1',
      'overlayId', overlay_id,
      'sourceBindingDigest', source_binding_digest,
      'revision', revision,
      'previousOverlayDigest', previous_overlay_digest,
      'fromKeyId', from_key_id,
      'rekeyedAtMs', rekeyed_at_ms,
      'overlayDigest', overlay_digest
    ) AND
    overlay_json -> 'sourceArtifact' ->> 'artifactId' = artifact_id AND
    overlay_json -> 'targetCatalogFence' @> jsonb_build_object(
      'generation', target_catalog_generation,
      'catalogDigest', target_catalog_digest,
      'keyId', target_key_id,
      'materialProof', target_material_proof
    )
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_result_rekey_mutation_key ON "ql3"."tool_execution_result_rekey_overlays" (mutation_id)`,
      `CREATE UNIQUE INDEX ql3_result_rekey_artifact_revision_key ON "ql3"."tool_execution_result_rekey_overlays" (artifact_id, revision)`,
      `CREATE UNIQUE INDEX ql3_result_rekey_artifact_revision_digest_key ON "ql3"."tool_execution_result_rekey_overlays" (artifact_id, revision, overlay_digest)`,
      `CREATE INDEX ql3_result_rekey_artifact_idx ON "ql3"."tool_execution_result_rekey_overlays" (artifact_id, revision DESC)`,
      `CREATE INDEX ql3_result_rekey_target_idx ON "ql3"."tool_execution_result_rekey_overlays" (target_key_id, artifact_id, revision DESC)`,
      `
CREATE TABLE "ql3"."tool_execution_result_rekey_heads" (
  artifact_id varchar(128) PRIMARY KEY,
  revision integer NOT NULL,
  overlay_id varchar(128) NOT NULL,
  overlay_digest char(64) NOT NULL,
  target_catalog_generation integer NOT NULL,
  target_catalog_digest char(64) NOT NULL,
  target_key_id varchar(128) NOT NULL,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT ql3_result_rekey_head_overlay_fk FOREIGN KEY (
    artifact_id, revision, overlay_digest
  ) REFERENCES "ql3"."tool_execution_result_rekey_overlays" (
    artifact_id, revision, overlay_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_result_rekey_head_identity_check CHECK (
    revision BETWEEN 1 AND 2147483647 AND
    artifact_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    overlay_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    target_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND
    target_catalog_generation BETWEEN 1 AND 2147483647 AND
    updated_at_ms >= 0
  ),
  CONSTRAINT ql3_result_rekey_head_digest_check CHECK (
    overlay_digest ~ '^[0-9a-f]{64}$' AND
    target_catalog_digest ~ '^[0-9a-f]{64}$'
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_result_rekey_head_overlay_key ON "ql3"."tool_execution_result_rekey_heads" (overlay_id)`,
      `CREATE UNIQUE INDEX ql3_result_rekey_head_digest_key ON "ql3"."tool_execution_result_rekey_heads" (overlay_digest)`,
      `CREATE INDEX ql3_result_rekey_head_target_idx ON "ql3"."tool_execution_result_rekey_heads" (target_key_id, artifact_id)`,
      `
CREATE TABLE "ql3"."tool_result_key_retirement_receipts" (
  receipt_digest char(64) PRIMARY KEY,
  catalog_authority varchar(64) NOT NULL,
  catalog_generation integer NOT NULL,
  catalog_digest char(64) NOT NULL,
  key_id varchar(128) NOT NULL,
  material_proof char(64) NOT NULL,
  mutation_id varchar(128) NOT NULL,
  command_digest char(64) NOT NULL,
  binding_count integer NOT NULL,
  overlay_head_count integer NOT NULL,
  uncovered_binding_count integer NOT NULL,
  uncovered_overlay_head_count integer NOT NULL,
  coverage_digest char(64) NOT NULL,
  created_at_ms bigint NOT NULL,
  receipt_json jsonb NOT NULL,
  CONSTRAINT ql3_result_retirement_catalog_fk FOREIGN KEY (
    catalog_authority, catalog_generation, catalog_digest
  ) REFERENCES "ql3"."tool_result_key_catalog_generations" (
    authority, generation, catalog_digest
  ) ON DELETE RESTRICT,
  CONSTRAINT ql3_result_retirement_authority_check CHECK (
    catalog_authority = 'trusted-tool-results'
  ),
  CONSTRAINT ql3_result_retirement_identity_check CHECK (
    catalog_generation BETWEEN 1 AND 2147483647 AND
    key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_result_retirement_count_check CHECK (
    binding_count BETWEEN 0 AND 2147483647 AND
    overlay_head_count BETWEEN 0 AND 2147483647 AND
    uncovered_binding_count = 0 AND
    uncovered_overlay_head_count = 0 AND created_at_ms >= 0
  ),
  CONSTRAINT ql3_result_retirement_digest_check CHECK (
    receipt_digest ~ '^[0-9a-f]{64}$' AND
    catalog_digest ~ '^[0-9a-f]{64}$' AND
    material_proof ~ '^[0-9a-f]{64}$' AND
    command_digest ~ '^[0-9a-f]{64}$' AND
    coverage_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_result_retirement_json_check CHECK (
    jsonb_typeof(receipt_json) = 'object' AND
    receipt_json @> jsonb_build_object(
      'schema', 'qinglong/tool-result-key-retirement-receipt@v1',
      'catalogGeneration', catalog_generation,
      'catalogDigest', catalog_digest,
      'keyId', key_id,
      'materialProof', material_proof,
      'mutationId', mutation_id,
      'bindingCount', binding_count,
      'overlayHeadCount', overlay_head_count,
      'uncoveredBindingCount', 0,
      'uncoveredOverlayHeadCount', 0,
      'coverageDigest', coverage_digest,
      'createdAtMs', created_at_ms,
      'receiptDigest', receipt_digest
    )
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_result_retirement_mutation_key ON "ql3"."tool_result_key_retirement_receipts" (mutation_id)`,
      `CREATE INDEX ql3_result_retirement_catalog_idx ON "ql3"."tool_result_key_retirement_receipts" (catalog_generation, key_id)`,
      `
REVOKE ALL ON
  "ql3"."tool_execution_result_rekey_overlays",
  "ql3"."tool_execution_result_rekey_heads",
  "ql3"."tool_result_key_retirement_receipts"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `GRANT SELECT ON "ql3"."tool_execution_result_rekey_overlays", "ql3"."tool_execution_result_rekey_heads" TO ql3_runtime`,
      `GRANT SELECT, INSERT ON "ql3"."tool_execution_result_rekey_overlays", "ql3"."tool_result_key_retirement_receipts" TO ql3_admin`,
      `GRANT SELECT, INSERT, UPDATE ON "ql3"."tool_execution_result_rekey_heads" TO ql3_admin`,
      `GRANT SELECT ON "ql3"."tool_execution_completions", "ql3"."tool_execution_result_key_bindings" TO ql3_admin`,
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 35,
      migration_id = 'pg-0036-tool-result-rekey-overlays',
      capabilities = '${CAPABILITIES_V35}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 34
    AND migration_id = 'pg-0035-tool-result-key-catalog'
    AND capabilities = '${CAPABILITIES_V34}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 34'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
