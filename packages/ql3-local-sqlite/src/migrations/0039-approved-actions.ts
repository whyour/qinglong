import { defineLocalSqliteMigration } from './sqlMigration';

export const local0039ApprovedActionsMigration = defineLocalSqliteMigration({
  id: '0039-approved-actions',
  statements: [
    `
CREATE TABLE "QingLong3ApprovalRequests" (
  request_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_ref TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  preview_digest TEXT NOT NULL,
  requested_by_type TEXT NOT NULL,
  requested_by_id TEXT NOT NULL,
  decision_id TEXT,
  consumption_id TEXT,
  dispatch_id TEXT,
  expires_at_ms INTEGER NOT NULL,
  request_json TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CONSTRAINT ql3_approval_requests_project_fk
    FOREIGN KEY (project_id) REFERENCES "QingLong3Projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_approval_requests_identity_check CHECK (
    length(request_id) BETWEEN 1 AND 128 AND
    length(action_type) BETWEEN 1 AND 128 AND
    length(action_ref) BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_approval_requests_state_version_check CHECK (
    (state = 'pending' AND version = 1) OR
    (state IN ('approved','rejected') AND version = 2) OR
    (state = 'consumed' AND version = 3)
  ),
  CONSTRAINT ql3_approval_requests_digest_check CHECK (
    length(action_digest) = 64 AND action_digest NOT GLOB '*[^0-9a-f]*' AND
    length(preview_digest) = 64 AND preview_digest NOT GLOB '*[^0-9a-f]*' AND
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_approval_requests_subject_check CHECK (
    requested_by_type IN
      ('user','api_app','mcp_client','agent','system','worker') AND
    length(requested_by_id) BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_approval_requests_mutation_tuple_check CHECK (
    (version = 1 AND decision_id IS NULL AND consumption_id IS NULL AND
      dispatch_id IS NULL) OR
    (version = 2 AND decision_id IS NOT NULL AND consumption_id IS NULL AND
      dispatch_id IS NULL) OR
    (version = 3 AND decision_id IS NOT NULL AND consumption_id IS NOT NULL AND
      dispatch_id IS NOT NULL)
  ),
  CONSTRAINT ql3_approval_requests_json_check CHECK (
    length(request_json) BETWEEN 2 AND 65536 AND
    json_valid(request_json) AND json_type(request_json) = 'object' AND
    json_extract(request_json, '$.id') = request_id AND
    json_extract(request_json, '$.projectId') = project_id AND
    json_extract(request_json, '$.version') = version AND
    json_extract(request_json, '$.state') = state AND
    json_extract(request_json, '$.action.actionType') = action_type AND
    json_extract(request_json, '$.action.actionRef') = action_ref AND
    json_extract(request_json, '$.action.actionDigest') = action_digest AND
    json_extract(request_json, '$.action.previewDigest') = preview_digest
  ),
  CONSTRAINT ql3_approval_requests_time_check
    CHECK (expires_at_ms > 0 AND updated_at_ms >= 0)
)
    `,
    `CREATE UNIQUE INDEX ql3_approval_requests_decision_uidx ON "QingLong3ApprovalRequests" (decision_id)`,
    `CREATE UNIQUE INDEX ql3_approval_requests_consumption_uidx ON "QingLong3ApprovalRequests" (consumption_id)`,
    `CREATE UNIQUE INDEX ql3_approval_requests_dispatch_uidx ON "QingLong3ApprovalRequests" (dispatch_id)`,
    `CREATE INDEX ql3_approval_requests_pending_idx ON "QingLong3ApprovalRequests" (expires_at_ms, request_id) WHERE state = 'pending'`,
    `CREATE INDEX ql3_approval_requests_project_idx ON "QingLong3ApprovalRequests" (project_id, updated_at_ms, request_id)`,
    `
CREATE TABLE "QingLong3ApprovedActionDispatches" (
  dispatch_id TEXT PRIMARY KEY,
  approval_request_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  action_ref TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  preview_digest TEXT NOT NULL,
  dispatch_json TEXT NOT NULL,
  dispatch_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  CONSTRAINT ql3_approved_action_dispatch_request_fk
    FOREIGN KEY (approval_request_id)
    REFERENCES "QingLong3ApprovalRequests" (request_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_approved_action_dispatch_project_fk
    FOREIGN KEY (project_id) REFERENCES "QingLong3Projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_approved_action_dispatch_identity_check CHECK (
    length(dispatch_id) BETWEEN 1 AND 128 AND
    length(action_type) BETWEEN 1 AND 128 AND
    length(action_ref) BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_approved_action_dispatch_digest_check CHECK (
    length(action_digest) = 64 AND action_digest NOT GLOB '*[^0-9a-f]*' AND
    length(preview_digest) = 64 AND preview_digest NOT GLOB '*[^0-9a-f]*' AND
    length(dispatch_digest) = 64 AND dispatch_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_approved_action_dispatch_json_check CHECK (
    length(dispatch_json) BETWEEN 2 AND 65536 AND
    json_valid(dispatch_json) AND json_type(dispatch_json) = 'object' AND
    json_extract(dispatch_json, '$.id') = dispatch_id AND
    json_extract(dispatch_json, '$.approvalRequestId') = approval_request_id AND
    json_extract(dispatch_json, '$.projectId') = project_id AND
    json_extract(dispatch_json, '$.action.actionType') = action_type AND
    json_extract(dispatch_json, '$.action.actionRef') = action_ref AND
    json_extract(dispatch_json, '$.action.actionDigest') = action_digest AND
    json_extract(dispatch_json, '$.action.previewDigest') = preview_digest
  ),
  CONSTRAINT ql3_approved_action_dispatch_time_check
    CHECK (created_at_ms >= 0)
)
    `,
    `CREATE UNIQUE INDEX ql3_approved_action_dispatch_request_uidx ON "QingLong3ApprovedActionDispatches" (approval_request_id)`,
    `CREATE INDEX ql3_approved_action_dispatch_project_idx ON "QingLong3ApprovedActionDispatches" (project_id, created_at_ms, dispatch_id)`,
  ],
});
