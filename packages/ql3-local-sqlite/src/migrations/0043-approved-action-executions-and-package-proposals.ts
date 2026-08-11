import { defineLocalSqliteMigration } from './sqlMigration';

export const local0043ApprovedActionExecutionsAndPackageProposalsMigration =
  defineLocalSqliteMigration({
    id: '0043-approved-action-executions-and-package-proposals',
    statements: [
      `
CREATE TABLE "QingLong3PluginPackageInstallProposals" (
  action_ref TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  permission TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  preview_digest TEXT NOT NULL,
  proposed_by_type TEXT NOT NULL,
  proposed_by_id TEXT NOT NULL,
  fence_project_version INTEGER NOT NULL,
  fence_binding_version INTEGER,
  created_at_ms INTEGER NOT NULL,
  proposal_json TEXT NOT NULL,
  proposal_digest TEXT NOT NULL,
  CONSTRAINT ql3_plugin_package_proposal_project_fk
    FOREIGN KEY (project_id) REFERENCES "QingLong3Projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_proposal_identity_check CHECK (
    length(action_ref) BETWEEN 1 AND 255 AND
    action_type = 'plugin_package.install' AND
    permission = 'package.manage' AND
    proposed_by_type IN
      ('user','api_app','mcp_client','agent','system','worker') AND
    length(proposed_by_id) BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_plugin_package_proposal_digest_check CHECK (
    length(action_digest) = 64 AND action_digest NOT GLOB '*[^0-9a-f]*' AND
    length(preview_digest) = 64 AND preview_digest NOT GLOB '*[^0-9a-f]*' AND
    length(proposal_digest) = 64 AND
      proposal_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_plugin_package_proposal_json_check CHECK (
    length(proposal_json) BETWEEN 2 AND 262144 AND
    json_valid(proposal_json) AND json_type(proposal_json) = 'object' AND
    json_extract(proposal_json, '$.schema') =
      'qinglong/plugin-package-install-proposal@v1' AND
    json_extract(proposal_json, '$.actionRef') = action_ref AND
    json_extract(proposal_json, '$.projectId') = project_id AND
    json_extract(proposal_json, '$.actionType') = action_type AND
    json_extract(proposal_json, '$.permission') = permission AND
    json_extract(proposal_json, '$.actionDigest') = action_digest AND
    json_extract(proposal_json, '$.previewDigest') = preview_digest AND
    json_extract(proposal_json, '$.proposedBy.type') = proposed_by_type AND
    json_extract(proposal_json, '$.proposedBy.id') = proposed_by_id AND
    json_extract(proposal_json, '$.proposalFence.projectVersion') =
      fence_project_version AND
    json_extract(proposal_json, '$.proposalFence.bindingVersion')
      IS fence_binding_version AND
    json_extract(proposal_json, '$.createdAtMs') = created_at_ms AND
    json_extract(proposal_json, '$.proposalDigest') = proposal_digest
  ),
  CONSTRAINT ql3_plugin_package_proposal_time_check CHECK (
    fence_project_version > 0 AND
    (fence_binding_version IS NULL OR fence_binding_version > 0) AND
    created_at_ms >= 0
  )
)
      `,
      `CREATE INDEX ql3_plugin_package_proposal_project_idx ON "QingLong3PluginPackageInstallProposals" (project_id, created_at_ms, action_ref)`,
      `
CREATE TABLE "QingLong3ApprovedActionExecutions" (
  dispatch_id TEXT PRIMARY KEY,
  dispatch_digest TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  eligible_at_ms INTEGER,
  next_attempt_at_ms INTEGER,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at_ms INTEGER,
  started_at_ms INTEGER,
  result_mutation_id TEXT,
  result_code TEXT,
  result_digest TEXT,
  completed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  execution_json TEXT NOT NULL,
  execution_digest TEXT NOT NULL,
  CONSTRAINT ql3_approved_action_execution_dispatch_fk
    FOREIGN KEY (dispatch_id)
    REFERENCES "QingLong3ApprovedActionDispatches" (dispatch_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_approved_action_execution_project_fk
    FOREIGN KEY (project_id) REFERENCES "QingLong3Projects" (id)
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
    (lease_owner IS NULL AND lease_token IS NULL AND
      lease_expires_at_ms IS NULL) OR
    (length(lease_owner) BETWEEN 1 AND 128 AND
      length(lease_token) BETWEEN 1 AND 128 AND
      lease_expires_at_ms > updated_at_ms)
  ),
  CONSTRAINT ql3_approved_action_execution_result_check CHECK (
    (result_mutation_id IS NULL AND result_code IS NULL) OR
    (length(result_mutation_id) BETWEEN 1 AND 128 AND
      length(result_code) BETWEEN 1 AND 64)
  ),
  CONSTRAINT ql3_approved_action_execution_digest_check CHECK (
    length(dispatch_digest) = 64 AND
      dispatch_digest NOT GLOB '*[^0-9a-f]*' AND
    (result_digest IS NULL OR
      (length(result_digest) = 64 AND
        result_digest NOT GLOB '*[^0-9a-f]*')) AND
    length(execution_digest) = 64 AND
      execution_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_approved_action_execution_json_check CHECK (
    length(execution_json) BETWEEN 2 AND 65536 AND
    json_valid(execution_json) AND json_type(execution_json) = 'object' AND
    json_extract(execution_json, '$.schema') =
      'qinglong/approved-action-execution@v1' AND
    json_extract(execution_json, '$.dispatchId') = dispatch_id AND
    json_extract(execution_json, '$.dispatchDigest') = dispatch_digest AND
    json_extract(execution_json, '$.projectId') = project_id AND
    json_extract(execution_json, '$.status') = status AND
    json_extract(execution_json, '$.version') = version AND
    json_extract(execution_json, '$.attemptCount') = attempt_count AND
    json_extract(execution_json, '$.maxAttempts') = max_attempts AND
    json_extract(execution_json, '$.executionDigest') = execution_digest
  ),
  CONSTRAINT ql3_approved_action_execution_time_check CHECK (
    created_at_ms >= 0 AND updated_at_ms >= created_at_ms
  )
)
      `,
      `CREATE INDEX ql3_approved_action_execution_due_idx ON "QingLong3ApprovedActionExecutions" (eligible_at_ms, dispatch_id) WHERE status IN ('pending','leased','retry_wait')`,
      `CREATE INDEX ql3_approved_action_execution_recovery_idx ON "QingLong3ApprovedActionExecutions" (lease_expires_at_ms, dispatch_id) WHERE status = 'executing'`,
      `CREATE INDEX ql3_approved_action_execution_project_idx ON "QingLong3ApprovedActionExecutions" (project_id, updated_at_ms, dispatch_id)`,
    ],
  });
