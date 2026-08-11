import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V37 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V38 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0039PluginPackagePublisherTrustAuthorityMigration =
  definePostgresSqlMigration({
    id: 'pg-0039-plugin-package-publisher-trust-authority',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_publisher_trust_snapshots" (
  snapshot_digest char(64) PRIMARY KEY,
  key_count integer NOT NULL,
  observed_by varchar(128) NOT NULL,
  observed_at_ms bigint NOT NULL,
  snapshot_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_publisher_trust_snapshot_identity_check CHECK (
    observed_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_plugin_package_publisher_trust_snapshot_digest_check CHECK (
    snapshot_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_publisher_trust_snapshot_count_check CHECK (
    key_count BETWEEN 0 AND 32 AND observed_at_ms >= 0
  ),
  CONSTRAINT ql3_plugin_package_publisher_trust_snapshot_json_check CHECK (
    jsonb_typeof(snapshot_json) = 'object' AND
    octet_length(snapshot_json::text) BETWEEN 2 AND 262144 AND
    snapshot_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-publisher-trust-snapshot@v1',
      'snapshotDigest', snapshot_digest
    ) AND
    jsonb_array_length(snapshot_json -> 'keys') = key_count
  )
)
      `.trim(),
      `
CREATE TABLE "ql3"."plugin_package_publisher_trust_heads" (
  authority_id varchar(128) PRIMARY KEY,
  generation integer NOT NULL,
  base_snapshot_digest char(64) NOT NULL,
  effective_trust_digest char(64) NOT NULL,
  updated_at_ms bigint NOT NULL,
  head_digest char(64) NOT NULL,
  head_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_publisher_trust_head_snapshot_fk
    FOREIGN KEY (base_snapshot_digest)
    REFERENCES "ql3"."plugin_package_publisher_trust_snapshots"
      (snapshot_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_publisher_trust_head_effective_snapshot_fk
    FOREIGN KEY (effective_trust_digest)
    REFERENCES "ql3"."plugin_package_publisher_trust_snapshots"
      (snapshot_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_publisher_trust_head_identity_check CHECK (
    authority_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    generation BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_plugin_package_publisher_trust_head_digest_check CHECK (
    base_snapshot_digest ~ '^[0-9a-f]{64}$' AND
    effective_trust_digest ~ '^[0-9a-f]{64}$' AND
    head_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_publisher_trust_head_time_check CHECK (
    updated_at_ms >= 0
  ),
  CONSTRAINT ql3_plugin_package_publisher_trust_head_json_check CHECK (
    jsonb_typeof(head_json) = 'object' AND
    octet_length(head_json::text) BETWEEN 2 AND 65536 AND
    head_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-publisher-trust-head@v1',
      'authorityId', authority_id,
      'generation', generation,
      'baseSnapshotDigest', base_snapshot_digest,
      'effectiveTrustDigest', effective_trust_digest,
      'updatedAtMs', updated_at_ms,
      'headDigest', head_digest
    )
  )
)
      `.trim(),
      `
CREATE TABLE "ql3"."plugin_package_publisher_revocation_proposals" (
  action_ref varchar(255) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  authority_id varchar(128) NOT NULL,
  trust_generation integer NOT NULL,
  publisher varchar(253) NOT NULL,
  key_id varchar(128) NOT NULL,
  previous_trust_digest char(64) NOT NULL,
  current_trust_digest char(64) NOT NULL,
  action_type varchar(128) NOT NULL,
  permission varchar(128) NOT NULL,
  action_digest char(64) NOT NULL,
  preview_digest char(64) NOT NULL,
  authorization_mode varchar(16) NOT NULL,
  reason_code varchar(32) NOT NULL,
  proposed_by_type varchar(32) NOT NULL,
  proposed_by_id varchar(255) NOT NULL,
  proposer_assurance varchar(32) NOT NULL,
  fence_project_version integer NOT NULL,
  fence_binding_version integer,
  created_at_ms bigint NOT NULL,
  proposal_json jsonb NOT NULL,
  proposal_digest char(64) NOT NULL,
  CONSTRAINT ql3_plugin_package_publisher_revocation_proposal_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_publisher_revocation_proposal_head_fk
    FOREIGN KEY (authority_id)
    REFERENCES "ql3"."plugin_package_publisher_trust_heads" (authority_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_publisher_revocation_proposal_identity_check
    CHECK (
      action_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' AND
      authority_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
      publisher ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$' AND
      key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
      action_type = 'plugin_package.publisher_key.revoke' AND
      permission = 'package.manage' AND
      authorization_mode IN ('dual_control', 'break_glass') AND
      reason_code IN (
        'suspected_key_compromise', 'confirmed_key_compromise'
      ) AND
      proposed_by_type IN (
        'user', 'api_app', 'mcp_client', 'agent', 'system', 'worker'
      ) AND
      octet_length(proposed_by_id) BETWEEN 1 AND 255 AND
      proposer_assurance IN (
        'single_factor', 'multi_factor', 'service', 'hardware',
        'local_console'
      ) AND
      (authorization_mode <> 'break_glass' OR
        proposer_assurance = 'hardware')
    ),
  CONSTRAINT ql3_plugin_package_publisher_revocation_proposal_digest_check
    CHECK (
      previous_trust_digest ~ '^[0-9a-f]{64}$' AND
      current_trust_digest ~ '^[0-9a-f]{64}$' AND
      previous_trust_digest <> current_trust_digest AND
      action_digest ~ '^[0-9a-f]{64}$' AND
      preview_digest ~ '^[0-9a-f]{64}$' AND
      proposal_digest ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT ql3_plugin_package_publisher_revocation_proposal_time_check
    CHECK (
      trust_generation BETWEEN 1 AND 2147483647 AND
      fence_project_version BETWEEN 1 AND 2147483647 AND
      (fence_binding_version IS NULL OR
        fence_binding_version BETWEEN 1 AND 2147483647) AND
      created_at_ms >= 0
    ),
  CONSTRAINT ql3_plugin_package_publisher_revocation_proposal_json_check
    CHECK (
      jsonb_typeof(proposal_json) = 'object' AND
      octet_length(proposal_json::text) BETWEEN 2 AND 262144 AND
      proposal_json @> jsonb_build_object(
        'schema',
          'qinglong/plugin-package-publisher-key-revocation-proposal@v1',
        'actionRef', action_ref,
        'projectId', project_id,
        'actionType', action_type,
        'permission', permission,
        'actionDigest', action_digest,
        'previewDigest', preview_digest,
        'proposerAssurance', proposer_assurance,
        'createdAtMs', created_at_ms,
        'proposalDigest', proposal_digest
      ) AND
      proposal_json -> 'actionInput' @> jsonb_build_object(
        'authorityProjectId', project_id,
        'trustAuthorityId', authority_id,
        'trustGeneration', trust_generation,
        'publisher', publisher,
        'keyId', key_id,
        'previousTrustDigest', previous_trust_digest,
        'currentTrustDigest', current_trust_digest,
        'authorizationMode', authorization_mode,
        'reasonCode', reason_code
      ) AND
      proposal_json -> 'proposedBy' @> jsonb_build_object(
        'type', proposed_by_type, 'id', proposed_by_id
      ) AND
      proposal_json -> 'proposalFence' @> jsonb_build_object(
        'projectVersion', fence_project_version,
        'bindingVersion', fence_binding_version
      )
    )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_publisher_revocation_proposal_digest_key ON "ql3"."plugin_package_publisher_revocation_proposals" (proposal_digest)`,
      `CREATE INDEX ql3_plugin_package_publisher_revocation_proposal_project_idx ON "ql3"."plugin_package_publisher_revocation_proposals" (project_id, created_at_ms, action_ref)`,
      `CREATE INDEX ql3_plugin_package_publisher_revocation_proposal_signer_idx ON "ql3"."plugin_package_publisher_revocation_proposals" (publisher, key_id, trust_generation)`,
      `
REVOKE ALL ON
  "ql3"."plugin_package_publisher_trust_snapshots",
  "ql3"."plugin_package_publisher_trust_heads",
  "ql3"."plugin_package_publisher_revocation_proposals"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT, INSERT ON
  "ql3"."plugin_package_publisher_trust_snapshots",
  "ql3"."plugin_package_publisher_trust_heads",
  "ql3"."plugin_package_publisher_revocation_proposals"
TO ql3_package_manager
      `.trim(),
      `
GRANT SELECT, INSERT ON
  "ql3"."plugin_package_publisher_trust_snapshots"
TO ql3_package_executor
      `.trim(),
      `
GRANT SELECT ON
  "ql3"."plugin_package_publisher_revocation_proposals"
TO ql3_package_executor
      `.trim(),
      `
GRANT SELECT, UPDATE ON
  "ql3"."plugin_package_publisher_trust_heads"
TO ql3_package_executor
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 38,
      migration_id =
        'pg-0039-plugin-package-publisher-trust-authority',
      capabilities = '${CAPABILITIES_V38}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 37
    AND migration_id = 'pg-0038-plugin-package-publisher-provenance'
    AND capabilities = '${CAPABILITIES_V37}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 37'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
