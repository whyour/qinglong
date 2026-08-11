import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V36 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V37 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"plugin_package_publisher_provenance":1,"plugin_package_quarantine":1,"plugin_package_task_reconciliation":1,"project_policy":1,"project_tool_definition_snapshot":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"step_run":1,"task_definition":1,"tool_execution_artifact_binding":1,"tool_execution_completion":1,"tool_execution_evidence":1,"tool_execution_failure_completion":1,"tool_execution_start_barrier":1,"tool_invocation_artifact":1,"tool_result_key_catalog":1,"tool_result_rekey":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0038PluginPackagePublisherProvenanceMigration =
  definePostgresSqlMigration({
    id: 'pg-0038-plugin-package-publisher-provenance',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_publisher_provenance" (
  installation_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  lock_digest char(64) NOT NULL,
  artifact_digest char(64) NOT NULL,
  manifest_digest char(64) NOT NULL,
  content_digest char(64) NOT NULL,
  stage_evidence_digest char(64) NOT NULL,
  publisher varchar(253) NOT NULL,
  key_id varchar(128) NOT NULL,
  signature_digest char(64) NOT NULL,
  key_not_before_ms bigint NOT NULL,
  key_not_after_ms bigint NOT NULL,
  verified_at_ms bigint NOT NULL,
  provenance_digest char(64) NOT NULL,
  provenance_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_publisher_provenance_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "ql3"."plugin_package_installs" (installation_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_publisher_provenance_identity_check CHECK (
    installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    publisher ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$' AND
    key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_plugin_package_publisher_provenance_digest_check CHECK (
    lock_digest ~ '^[0-9a-f]{64}$' AND
    artifact_digest ~ '^[0-9a-f]{64}$' AND
    manifest_digest ~ '^[0-9a-f]{64}$' AND
    content_digest ~ '^[0-9a-f]{64}$' AND
    stage_evidence_digest ~ '^[0-9a-f]{64}$' AND
    signature_digest ~ '^[0-9a-f]{64}$' AND
    provenance_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_publisher_provenance_time_check CHECK (
    key_not_before_ms >= 0 AND
    key_not_after_ms > key_not_before_ms AND
    verified_at_ms >= key_not_before_ms AND
    verified_at_ms < key_not_after_ms
  ),
  CONSTRAINT ql3_plugin_package_publisher_provenance_json_check CHECK (
    jsonb_typeof(provenance_json) = 'object' AND
    octet_length(provenance_json::text) BETWEEN 2 AND 262144 AND
    provenance_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-publisher-provenance@v1',
      'projectId', project_id,
      'packageName', package_name,
      'installationId', installation_id,
      'lockDigest', lock_digest,
      'artifactDigest', artifact_digest,
      'manifestDigest', manifest_digest,
      'contentDigest', content_digest,
      'stageEvidenceDigest', stage_evidence_digest,
      'publisher', publisher,
      'keyId', key_id,
      'signatureDigest', signature_digest,
      'keyNotBeforeMs', key_not_before_ms,
      'keyNotAfterMs', key_not_after_ms,
      'verifiedAtMs', verified_at_ms,
      'provenanceDigest', provenance_digest
    )
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_publisher_provenance_digest_key ON "ql3"."plugin_package_publisher_provenance" (provenance_digest)`,
      `CREATE INDEX ql3_plugin_package_publisher_provenance_signer_idx ON "ql3"."plugin_package_publisher_provenance" (publisher, key_id, project_id, package_name, installation_id)`,
      `CREATE INDEX ql3_plugin_package_publisher_provenance_lock_idx ON "ql3"."plugin_package_publisher_provenance" (lock_digest, installation_id)`,
      `
CREATE TABLE "ql3"."plugin_package_publisher_revocation_receipts" (
  receipt_digest char(64) PRIMARY KEY,
  mutation_id varchar(128) NOT NULL,
  publisher varchar(253) NOT NULL,
  key_id varchar(128) NOT NULL,
  previous_trust_digest char(64) NOT NULL,
  current_trust_digest char(64) NOT NULL,
  proposer_type varchar(16) NOT NULL,
  proposer_id varchar(255) NOT NULL,
  confirmer_type varchar(16) NOT NULL,
  confirmer_id varchar(255) NOT NULL,
  authorization_mode varchar(16) NOT NULL,
  reason_code varchar(32) NOT NULL,
  revoked_at_ms bigint NOT NULL,
  receipt_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_publisher_revocation_identity_check CHECK (
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    publisher ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$' AND
    key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
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
  CONSTRAINT ql3_plugin_package_publisher_revocation_digest_check CHECK (
    receipt_digest ~ '^[0-9a-f]{64}$' AND
    previous_trust_digest ~ '^[0-9a-f]{64}$' AND
    current_trust_digest ~ '^[0-9a-f]{64}$' AND
    previous_trust_digest <> current_trust_digest
  ),
  CONSTRAINT ql3_plugin_package_publisher_revocation_time_check CHECK (
    revoked_at_ms >= 0
  ),
  CONSTRAINT ql3_plugin_package_publisher_revocation_json_check CHECK (
    jsonb_typeof(receipt_json) = 'object' AND
    octet_length(receipt_json::text) BETWEEN 2 AND 262144 AND
    receipt_json @> jsonb_build_object(
      'schema',
        'qinglong/plugin-package-publisher-key-revocation-receipt@v1',
      'mutationId', mutation_id,
      'publisher', publisher,
      'keyId', key_id,
      'previousTrustDigest', previous_trust_digest,
      'currentTrustDigest', current_trust_digest,
      'authorizationMode', authorization_mode,
      'reasonCode', reason_code,
      'revokedAtMs', revoked_at_ms,
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
      `CREATE UNIQUE INDEX ql3_plugin_package_publisher_revocation_mutation_key ON "ql3"."plugin_package_publisher_revocation_receipts" (mutation_id)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_publisher_revocation_signer_key ON "ql3"."plugin_package_publisher_revocation_receipts" (publisher, key_id)`,
      `
CREATE TABLE "ql3"."plugin_package_publisher_revocation_impacts" (
  revocation_receipt_digest char(64) PRIMARY KEY,
  impact_digest char(64) NOT NULL,
  item_count integer NOT NULL,
  generated_at_ms bigint NOT NULL,
  impact_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_publisher_impact_receipt_fk
    FOREIGN KEY (revocation_receipt_digest)
    REFERENCES "ql3"."plugin_package_publisher_revocation_receipts"
      (receipt_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_publisher_impact_digest_check CHECK (
    revocation_receipt_digest ~ '^[0-9a-f]{64}$' AND
    impact_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_publisher_impact_count_check CHECK (
    item_count BETWEEN 0 AND 4096 AND generated_at_ms >= 0
  ),
  CONSTRAINT ql3_plugin_package_publisher_impact_json_check CHECK (
    jsonb_typeof(impact_json) = 'object' AND
    octet_length(impact_json::text) BETWEEN 2 AND 8388608 AND
    impact_json @> jsonb_build_object(
      'schema',
        'qinglong/plugin-package-publisher-key-revocation-impact@v1',
      'revocationReceiptDigest', revocation_receipt_digest,
      'generatedAtMs', generated_at_ms,
      'impactDigest', impact_digest
    ) AND
    jsonb_array_length(impact_json -> 'items') = item_count
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_publisher_impact_digest_key ON "ql3"."plugin_package_publisher_revocation_impacts" (impact_digest)`,
      `
CREATE TABLE "ql3"."plugin_package_publisher_revocation_impact_items" (
  impact_digest char(64) NOT NULL,
  provenance_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  lock_digest char(64) NOT NULL,
  PRIMARY KEY (impact_digest, provenance_digest),
  CONSTRAINT ql3_plugin_package_publisher_impact_item_impact_fk
    FOREIGN KEY (impact_digest)
    REFERENCES "ql3"."plugin_package_publisher_revocation_impacts"
      (impact_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_publisher_impact_item_provenance_fk
    FOREIGN KEY (provenance_digest)
    REFERENCES "ql3"."plugin_package_publisher_provenance"
      (provenance_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_publisher_impact_item_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "ql3"."plugin_package_installs" (installation_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_publisher_impact_item_identity_check CHECK (
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    impact_digest ~ '^[0-9a-f]{64}$' AND
    provenance_digest ~ '^[0-9a-f]{64}$' AND
    lock_digest ~ '^[0-9a-f]{64}$'
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_publisher_impact_item_install_key ON "ql3"."plugin_package_publisher_revocation_impact_items" (impact_digest, installation_id)`,
      `CREATE INDEX ql3_plugin_package_publisher_impact_item_target_idx ON "ql3"."plugin_package_publisher_revocation_impact_items" (project_id, package_name, installation_id, lock_digest)`,
      `
CREATE FUNCTION "ql3"."enforce_plugin_package_stage_provenance"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, ql3
AS $ql3$
BEGIN
  IF OLD.state = 'queued' AND NEW.state = 'staged' AND NOT EXISTS (
    SELECT 1
    FROM "ql3"."plugin_package_publisher_provenance" AS provenance
    WHERE provenance.installation_id = NEW.installation_id
      AND provenance.project_id = NEW.project_id
      AND provenance.package_name = NEW.package_name
      AND provenance.lock_digest = NEW.lock_digest
      AND provenance.artifact_digest =
        NEW.lock_json -> 'source' ->> 'artifactDigest'
      AND provenance.manifest_digest = NEW.lock_json ->> 'manifestDigest'
      AND provenance.content_digest =
        NEW.lock_json -> 'source' ->> 'contentDigest'
      AND provenance.stage_evidence_digest =
        NEW.record_json -> 'stageReceipt' ->> 'evidenceDigest'
  ) THEN
    RAISE EXCEPTION
      'Plugin Package stage requires exact publisher provenance'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$ql3$
      `.trim(),
      `
CREATE TRIGGER ql3_plugin_package_stage_provenance_guard
BEFORE UPDATE ON "ql3"."plugin_package_installs"
FOR EACH ROW EXECUTE FUNCTION
  "ql3"."enforce_plugin_package_stage_provenance"()
      `.trim(),
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
    FROM "ql3"."plugin_package_task_reconciliations" AS reconciliation
    JOIN "ql3"."plugin_package_task_reconciliation_items" AS item
      ON item.generation_digest = reconciliation.generation_digest
     AND item.task_id = p_task_id
     AND 'qltd:v1:' || item.revision || ':' || item.content_digest =
       p_task_revision
    WHERE reconciliation.project_id = p_project_id
      AND (
        EXISTS (
          SELECT 1
          FROM "ql3"."plugin_package_quarantine_events" AS quarantine
          WHERE quarantine.project_id = reconciliation.project_id
            AND quarantine.package_name = reconciliation.package_name
            AND quarantine.lock_digest = reconciliation.lock_digest
        ) OR EXISTS (
          SELECT 1
          FROM "ql3"."plugin_package_publisher_provenance" AS provenance
          JOIN "ql3"."plugin_package_publisher_revocation_receipts" AS revoked
            ON revoked.publisher = provenance.publisher
           AND revoked.key_id = provenance.key_id
          WHERE provenance.lock_digest = reconciliation.lock_digest
        )
      )
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
    FROM "ql3"."project_tool_definition_snapshot_sources" AS source
    JOIN "ql3"."project_tool_definition_snapshots" AS snapshot
      ON snapshot.project_id = source.project_id
     AND snapshot.active_vector_digest = source.active_vector_digest
    CROSS JOIN LATERAL jsonb_array_elements(
      snapshot.snapshot_json -> 'definitions'
    ) AS definition(item)
    WHERE source.project_id = p_project_id
      AND definition.item ->> 'packageName' = source.package_name
      AND 'tool:' ||
        (definition.item -> 'definition' ->> 'name') || '@' ||
        (definition.item -> 'definition' ->> 'version') = p_definition_ref
      AND definition.item ->> 'definitionDigest' = p_definition_digest
      AND (
        EXISTS (
          SELECT 1
          FROM "ql3"."plugin_package_quarantine_events" AS quarantine
          WHERE quarantine.project_id = source.project_id
            AND quarantine.package_name = source.package_name
            AND quarantine.installation_id = source.installation_id
            AND quarantine.lock_digest = source.lock_digest
        ) OR EXISTS (
          SELECT 1
          FROM "ql3"."plugin_package_publisher_provenance" AS provenance
          JOIN "ql3"."plugin_package_publisher_revocation_receipts" AS revoked
            ON revoked.publisher = provenance.publisher
           AND revoked.key_id = provenance.key_id
          WHERE provenance.installation_id = source.installation_id
            AND provenance.lock_digest = source.lock_digest
        )
      )
  );
END
$ql3$
      `.trim(),
      `
REVOKE ALL ON
  "ql3"."plugin_package_publisher_provenance",
  "ql3"."plugin_package_publisher_revocation_receipts",
  "ql3"."plugin_package_publisher_revocation_impacts",
  "ql3"."plugin_package_publisher_revocation_impact_items"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
REVOKE ALL ON FUNCTION
  "ql3"."enforce_plugin_package_stage_provenance"()
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_package_executor, ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT, INSERT ON
  "ql3"."plugin_package_publisher_provenance",
  "ql3"."plugin_package_publisher_revocation_receipts",
  "ql3"."plugin_package_publisher_revocation_impacts",
  "ql3"."plugin_package_publisher_revocation_impact_items"
TO ql3_package_executor
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 37,
      migration_id = 'pg-0038-plugin-package-publisher-provenance',
      capabilities = '${CAPABILITIES_V37}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 36
    AND migration_id = 'pg-0037-plugin-package-quarantine'
    AND capabilities = '${CAPABILITIES_V36}'::jsonb;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 36'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
