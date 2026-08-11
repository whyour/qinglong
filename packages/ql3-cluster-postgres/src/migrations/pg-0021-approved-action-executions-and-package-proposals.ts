import { definePostgresSqlMigration } from './sqlMigration';

export const pg0021ApprovedActionExecutionsAndPackageProposalsMigration =
  definePostgresSqlMigration({
    id: 'pg-0021-approved-action-executions-and-package-proposals',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_install_proposals" (
  action_ref varchar(255) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  action_type varchar(128) NOT NULL,
  permission varchar(128) NOT NULL,
  action_digest char(64) NOT NULL,
  preview_digest char(64) NOT NULL,
  proposed_by_type varchar(32) NOT NULL,
  proposed_by_id varchar(255) NOT NULL,
  fence_project_version integer NOT NULL,
  fence_binding_version integer,
  created_at_ms bigint NOT NULL,
  proposal_json jsonb NOT NULL,
  proposal_digest char(64) NOT NULL,
  CONSTRAINT ql3_plugin_package_proposal_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_proposal_identity_check CHECK (
    action_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'
    AND action_type = 'plugin_package.install'
    AND permission = 'package.manage'
    AND proposed_by_type IN
      ('user','api_app','mcp_client','agent','system','worker')
    AND char_length(proposed_by_id) BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_plugin_package_proposal_digest_check CHECK (
    action_digest ~ '^[0-9a-f]{64}$'
    AND preview_digest ~ '^[0-9a-f]{64}$'
    AND proposal_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_proposal_json_check CHECK (
    jsonb_typeof(proposal_json) = 'object'
    AND octet_length(proposal_json::text) BETWEEN 2 AND 262144
    AND proposal_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-install-proposal@v1',
      'actionRef', action_ref,
      'projectId', project_id,
      'actionType', action_type,
      'permission', permission,
      'actionDigest', action_digest,
      'previewDigest', preview_digest,
      'proposedBy', jsonb_build_object(
        'type', proposed_by_type,
        'id', proposed_by_id
      ),
      'proposalFence', jsonb_build_object(
        'projectVersion', fence_project_version,
        'bindingVersion', fence_binding_version
      ),
      'createdAtMs', created_at_ms,
      'proposalDigest', proposal_digest
    )
  ),
  CONSTRAINT ql3_plugin_package_proposal_time_check CHECK (
    fence_project_version > 0
    AND (fence_binding_version IS NULL OR fence_binding_version > 0)
    AND created_at_ms >= 0
  )
)
      `.trim(),
      `
CREATE INDEX ql3_plugin_package_proposal_project_idx
ON "ql3"."plugin_package_install_proposals"
  (project_id, created_at_ms, action_ref)
      `.trim(),
      `
CREATE TABLE "ql3"."approved_action_executions" (
  dispatch_id varchar(128) PRIMARY KEY,
  dispatch_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  status varchar(16) NOT NULL,
  version integer NOT NULL,
  attempt_count integer NOT NULL,
  max_attempts integer NOT NULL,
  eligible_at_ms bigint,
  next_attempt_at_ms bigint,
  lease_owner varchar(128),
  lease_token varchar(128),
  lease_expires_at_ms bigint,
  started_at_ms bigint,
  result_mutation_id varchar(128),
  result_code varchar(64),
  result_digest char(64),
  completed_at_ms bigint,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  execution_json jsonb NOT NULL,
  execution_digest char(64) NOT NULL,
  CONSTRAINT ql3_approved_action_execution_dispatch_fk
    FOREIGN KEY (dispatch_id)
    REFERENCES "ql3"."approved_action_dispatches" (dispatch_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_approved_action_execution_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_approved_action_execution_state_check CHECK (
    status IN
      ('pending','leased','executing','retry_wait','succeeded','failed','blocked')
    AND version BETWEEN 0 AND 2147483647
    AND attempt_count BETWEEN 0 AND 16
    AND max_attempts BETWEEN 1 AND 16
    AND attempt_count <= max_attempts
  ),
  CONSTRAINT ql3_approved_action_execution_lease_check CHECK (
    (
      lease_owner IS NULL AND lease_token IS NULL
      AND lease_expires_at_ms IS NULL
    )
    OR (
      char_length(lease_owner) BETWEEN 1 AND 128
      AND char_length(lease_token) BETWEEN 1 AND 128
      AND lease_expires_at_ms > updated_at_ms
    )
  ),
  CONSTRAINT ql3_approved_action_execution_result_check CHECK (
    (
      result_mutation_id IS NULL AND result_code IS NULL
    )
    OR (
      char_length(result_mutation_id) BETWEEN 1 AND 128
      AND char_length(result_code) BETWEEN 1 AND 64
    )
  ),
  CONSTRAINT ql3_approved_action_execution_digest_check CHECK (
    dispatch_digest ~ '^[0-9a-f]{64}$'
    AND (result_digest IS NULL OR result_digest ~ '^[0-9a-f]{64}$')
    AND execution_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_approved_action_execution_json_check CHECK (
    jsonb_typeof(execution_json) = 'object'
    AND octet_length(execution_json::text) BETWEEN 2 AND 65536
    AND execution_json @> jsonb_build_object(
      'schema', 'qinglong/approved-action-execution@v1',
      'dispatchId', dispatch_id,
      'dispatchDigest', dispatch_digest,
      'projectId', project_id,
      'status', status,
      'version', version,
      'attemptCount', attempt_count,
      'maxAttempts', max_attempts,
      'executionDigest', execution_digest
    )
  ),
  CONSTRAINT ql3_approved_action_execution_time_check CHECK (
    created_at_ms >= 0 AND updated_at_ms >= created_at_ms
  )
)
      `.trim(),
      `
CREATE INDEX ql3_approved_action_execution_due_idx
ON "ql3"."approved_action_executions" (eligible_at_ms, dispatch_id)
WHERE status IN ('pending','leased','retry_wait')
      `.trim(),
      `
CREATE INDEX ql3_approved_action_execution_recovery_idx
ON "ql3"."approved_action_executions" (lease_expires_at_ms, dispatch_id)
WHERE status = 'executing'
      `.trim(),
      `
CREATE INDEX ql3_approved_action_execution_project_idx
ON "ql3"."approved_action_executions"
  (project_id, updated_at_ms, dispatch_id)
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."plugin_package_install_proposals"
TO ql3_admin
      `.trim(),
      `
GRANT SELECT, INSERT, UPDATE
ON "ql3"."approved_action_executions"
TO ql3_admin
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 20,
      migration_id =
        'pg-0021-approved-action-executions-and-package-proposals',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_install":1,"plugin_package_proposal":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 19
    AND migration_id = 'pg-0020-plugin-package-admission-receipts'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_install":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 19'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
