import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V38 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V39 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_publisher_trust_authority":1,"plugin_package_publisher_trust_transition":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0040PluginPackagePublisherTrustTransitionsMigration =
  definePostgresSqlMigration({
    id: 'pg-0040-plugin-package-publisher-trust-transitions',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_publisher_trust_transition_proposals" (
  action_ref varchar(255) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  authority_id varchar(128) NOT NULL,
  trust_generation integer NOT NULL,
  mode varchar(16) NOT NULL,
  publisher varchar(253) NOT NULL,
  key_id varchar(128) NOT NULL,
  previous_trust_digest char(64) NOT NULL,
  current_trust_digest char(64) NOT NULL,
  action_type varchar(128) NOT NULL,
  permission varchar(128) NOT NULL,
  action_digest char(64) NOT NULL,
  preview_digest char(64) NOT NULL,
  proposed_by_type varchar(32) NOT NULL,
  proposed_by_id varchar(255) NOT NULL,
  proposer_assurance varchar(32) NOT NULL,
  fence_project_version integer NOT NULL,
  fence_binding_version integer,
  created_at_ms bigint NOT NULL,
  proposal_json jsonb NOT NULL,
  proposal_digest char(64) NOT NULL,
  CONSTRAINT ql3_pp_trust_transition_proposal_digest_key
    UNIQUE (proposal_digest),
  CONSTRAINT ql3_pp_trust_transition_proposal_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_pp_trust_transition_proposal_head_fk
    FOREIGN KEY (authority_id)
    REFERENCES "ql3"."plugin_package_publisher_trust_heads" (authority_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_pp_trust_transition_proposal_previous_fk
    FOREIGN KEY (previous_trust_digest)
    REFERENCES "ql3"."plugin_package_publisher_trust_snapshots"
      (snapshot_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_pp_trust_transition_proposal_current_fk
    FOREIGN KEY (current_trust_digest)
    REFERENCES "ql3"."plugin_package_publisher_trust_snapshots"
      (snapshot_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_pp_trust_transition_proposal_identity_check
    CHECK (
      action_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' AND
      authority_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
      publisher ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$' AND
      key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
      mode IN ('overlap_add', 'safe_retire') AND
      action_type = CASE mode
        WHEN 'overlap_add'
          THEN 'plugin_package.publisher_key.overlap_add'
        WHEN 'safe_retire'
          THEN 'plugin_package.publisher_key.safe_retire'
      END AND
      permission = 'package.manage' AND
      proposed_by_type = 'user' AND
      octet_length(proposed_by_id) BETWEEN 1 AND 255 AND
      proposer_assurance IN ('multi_factor', 'hardware')
    ),
  CONSTRAINT ql3_pp_trust_transition_proposal_digest_check
    CHECK (
      previous_trust_digest ~ '^[0-9a-f]{64}$' AND
      current_trust_digest ~ '^[0-9a-f]{64}$' AND
      previous_trust_digest <> current_trust_digest AND
      action_digest ~ '^[0-9a-f]{64}$' AND
      preview_digest ~ '^[0-9a-f]{64}$' AND
      proposal_digest ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT ql3_pp_trust_transition_proposal_time_check
    CHECK (
      trust_generation BETWEEN 1 AND 2147483647 AND
      fence_project_version BETWEEN 1 AND 2147483647 AND
      (fence_binding_version IS NULL OR
        fence_binding_version BETWEEN 1 AND 2147483647) AND
      created_at_ms >= 0
    ),
  CONSTRAINT ql3_pp_trust_transition_proposal_json_check
    CHECK (
      jsonb_typeof(proposal_json) = 'object' AND
      octet_length(proposal_json::text) BETWEEN 2 AND 262144 AND
      proposal_json @> jsonb_build_object(
        'schema',
          'qinglong/plugin-package-publisher-trust-transition-proposal@v1',
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
        'mode', mode,
        'publisher', publisher,
        'keyId', key_id,
        'previousTrustDigest', previous_trust_digest,
        'currentTrustDigest', current_trust_digest
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
      `CREATE INDEX ql3_pp_trust_transition_proposal_project_idx ON "ql3"."plugin_package_publisher_trust_transition_proposals" (project_id, created_at_ms, action_ref)`,
      `CREATE INDEX ql3_pp_trust_transition_proposal_signer_idx ON "ql3"."plugin_package_publisher_trust_transition_proposals" (publisher, key_id, trust_generation)`,
      `
CREATE TABLE "ql3"."plugin_package_publisher_trust_transition_receipts" (
  mutation_id varchar(128) PRIMARY KEY,
  proposal_digest char(64) NOT NULL,
  authority_id varchar(128) NOT NULL,
  previous_generation integer NOT NULL,
  current_generation integer NOT NULL,
  mode varchar(16) NOT NULL,
  publisher varchar(253) NOT NULL,
  key_id varchar(128) NOT NULL,
  previous_trust_digest char(64) NOT NULL,
  current_trust_digest char(64) NOT NULL,
  proposer_type varchar(32) NOT NULL,
  proposer_id varchar(255) NOT NULL,
  confirmer_type varchar(32) NOT NULL,
  confirmer_id varchar(255) NOT NULL,
  retirement_matching_installations integer,
  executed_at_ms bigint NOT NULL,
  receipt_json jsonb NOT NULL,
  receipt_digest char(64) NOT NULL,
  CONSTRAINT ql3_pp_trust_transition_receipt_proposal_key
    UNIQUE (proposal_digest),
  CONSTRAINT ql3_pp_trust_transition_receipt_digest_key
    UNIQUE (receipt_digest),
  CONSTRAINT ql3_pp_trust_transition_receipt_dispatch_fk
    FOREIGN KEY (mutation_id)
    REFERENCES "ql3"."approved_action_dispatches" (dispatch_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_pp_trust_transition_receipt_proposal_fk
    FOREIGN KEY (proposal_digest)
    REFERENCES "ql3"."plugin_package_publisher_trust_transition_proposals"
      (proposal_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_pp_trust_transition_receipt_head_fk
    FOREIGN KEY (authority_id)
    REFERENCES "ql3"."plugin_package_publisher_trust_heads" (authority_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_pp_trust_transition_receipt_previous_fk
    FOREIGN KEY (previous_trust_digest)
    REFERENCES "ql3"."plugin_package_publisher_trust_snapshots"
      (snapshot_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_pp_trust_transition_receipt_current_fk
    FOREIGN KEY (current_trust_digest)
    REFERENCES "ql3"."plugin_package_publisher_trust_snapshots"
      (snapshot_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_pp_trust_transition_receipt_identity_check
    CHECK (
      mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
      proposal_digest ~ '^[0-9a-f]{64}$' AND
      authority_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
      mode IN ('overlap_add', 'safe_retire') AND
      publisher ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$' AND
      key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
      proposer_type = 'user' AND
      confirmer_type = 'user' AND
      octet_length(proposer_id) BETWEEN 1 AND 255 AND
      octet_length(confirmer_id) BETWEEN 1 AND 255 AND
      (proposer_type, proposer_id) <> (confirmer_type, confirmer_id)
    ),
  CONSTRAINT ql3_pp_trust_transition_receipt_transition_check
    CHECK (
      previous_generation BETWEEN 1 AND 2147483646 AND
      current_generation = previous_generation + 1 AND
      previous_trust_digest ~ '^[0-9a-f]{64}$' AND
      current_trust_digest ~ '^[0-9a-f]{64}$' AND
      previous_trust_digest <> current_trust_digest AND
      (
        (mode = 'overlap_add' AND
          retirement_matching_installations IS NULL) OR
        (mode = 'safe_retire' AND
          retirement_matching_installations = 0)
      ) AND
      executed_at_ms >= 0 AND
      receipt_digest ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT ql3_pp_trust_transition_receipt_json_check
    CHECK (
      jsonb_typeof(receipt_json) = 'object' AND
      octet_length(receipt_json::text) BETWEEN 2 AND 262144 AND
      receipt_json @> jsonb_build_object(
        'schema',
          'qinglong/plugin-package-publisher-trust-transition-receipt@v1',
        'mutationId', mutation_id,
        'proposalDigest', proposal_digest,
        'trustAuthorityId', authority_id,
        'previousGeneration', previous_generation,
        'currentGeneration', current_generation,
        'mode', mode,
        'publisher', publisher,
        'keyId', key_id,
        'previousTrustDigest', previous_trust_digest,
        'currentTrustDigest', current_trust_digest,
        'retirementMatchingInstallations',
          retirement_matching_installations,
        'executedAtMs', executed_at_ms,
        'receiptDigest', receipt_digest
      ) AND
      receipt_json -> 'proposer' @> jsonb_build_object(
        'type', proposer_type, 'id', proposer_id
      ) AND
      receipt_json -> 'confirmer' @> jsonb_build_object(
        'type', confirmer_type, 'id', confirmer_id
      )
    )
)
      `.trim(),
      `CREATE INDEX ql3_pp_trust_transition_receipt_signer_idx ON "ql3"."plugin_package_publisher_trust_transition_receipts" (publisher, key_id, current_generation)`,
      `
REVOKE ALL ON
  "ql3"."plugin_package_publisher_trust_transition_proposals",
  "ql3"."plugin_package_publisher_trust_transition_receipts"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT, INSERT ON
  "ql3"."plugin_package_publisher_trust_transition_proposals"
TO ql3_package_manager
      `.trim(),
      `
GRANT SELECT ON
  "ql3"."plugin_package_publisher_trust_transition_receipts"
TO ql3_package_manager
      `.trim(),
      `
GRANT SELECT ON
  "ql3"."plugin_package_publisher_trust_transition_proposals"
TO ql3_package_executor
      `.trim(),
      `
GRANT SELECT, INSERT ON
  "ql3"."plugin_package_publisher_trust_transition_receipts"
TO ql3_package_executor
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 39,
      migration_id =
        'pg-0040-plugin-package-publisher-trust-transitions',
      capabilities = '${CAPABILITIES_V39}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 38
    AND migration_id =
      'pg-0039-plugin-package-publisher-trust-authority'
    AND capabilities = '${CAPABILITIES_V38}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 38'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
