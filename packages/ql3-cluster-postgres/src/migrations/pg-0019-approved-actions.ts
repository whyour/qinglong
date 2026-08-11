import { definePostgresSqlMigration } from './sqlMigration';

export const pg0019ApprovedActionsMigration = definePostgresSqlMigration({
  id: 'pg-0019-approved-actions',
  statements: [
    `
CREATE TABLE "ql3"."approval_requests" (
  request_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  version integer NOT NULL,
  state varchar(16) NOT NULL,
  action_type varchar(128) NOT NULL,
  action_ref varchar(255) NOT NULL,
  action_digest char(64) NOT NULL,
  preview_digest char(64) NOT NULL,
  requested_by_type varchar(32) NOT NULL,
  requested_by_id varchar(255) NOT NULL,
  decision_id varchar(128),
  consumption_id varchar(128),
  dispatch_id varchar(128),
  expires_at_ms bigint NOT NULL,
  request_json jsonb NOT NULL,
  request_digest char(64) NOT NULL,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT ql3_approval_requests_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_approval_requests_identity_check CHECK (
    request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND action_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND action_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'
  ),
  CONSTRAINT ql3_approval_requests_state_version_check CHECK (
    (state = 'pending' AND version = 1)
    OR (state IN ('approved', 'rejected') AND version = 2)
    OR (state = 'consumed' AND version = 3)
  ),
  CONSTRAINT ql3_approval_requests_digest_check CHECK (
    action_digest ~ '^[0-9a-f]{64}$'
    AND preview_digest ~ '^[0-9a-f]{64}$'
    AND request_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_approval_requests_subject_check CHECK (
    requested_by_type IN
      ('user','api_app','mcp_client','agent','system','worker')
    AND char_length(requested_by_id) BETWEEN 1 AND 255
  ),
  CONSTRAINT ql3_approval_requests_mutation_tuple_check CHECK (
    (
      version = 1 AND decision_id IS NULL
      AND consumption_id IS NULL AND dispatch_id IS NULL
    )
    OR (
      version = 2 AND decision_id IS NOT NULL
      AND consumption_id IS NULL AND dispatch_id IS NULL
    )
    OR (
      version = 3 AND decision_id IS NOT NULL
      AND consumption_id IS NOT NULL AND dispatch_id IS NOT NULL
    )
  ),
  CONSTRAINT ql3_approval_requests_json_check CHECK (
    jsonb_typeof(request_json) = 'object'
    AND octet_length(request_json::text) BETWEEN 2 AND 65536
    AND request_json @> jsonb_build_object(
      'id', request_id,
      'projectId', project_id,
      'version', version,
      'state', state,
      'action', jsonb_build_object(
        'actionType', action_type,
        'actionRef', action_ref,
        'actionDigest', action_digest,
        'previewDigest', preview_digest
      )
    )
  ),
  CONSTRAINT ql3_approval_requests_time_check CHECK (
    expires_at_ms > 0 AND updated_at_ms >= 0
  )
)
      `.trim(),
    `
CREATE UNIQUE INDEX ql3_approval_requests_decision_uidx
ON "ql3"."approval_requests" (decision_id)
WHERE decision_id IS NOT NULL
      `.trim(),
    `
CREATE UNIQUE INDEX ql3_approval_requests_consumption_uidx
ON "ql3"."approval_requests" (consumption_id)
WHERE consumption_id IS NOT NULL
      `.trim(),
    `
CREATE UNIQUE INDEX ql3_approval_requests_dispatch_uidx
ON "ql3"."approval_requests" (dispatch_id)
WHERE dispatch_id IS NOT NULL
      `.trim(),
    `
CREATE INDEX ql3_approval_requests_pending_idx
ON "ql3"."approval_requests" (expires_at_ms, request_id)
WHERE state = 'pending'
      `.trim(),
    `
CREATE INDEX ql3_approval_requests_project_idx
ON "ql3"."approval_requests" (project_id, updated_at_ms, request_id)
      `.trim(),
    `
CREATE TABLE "ql3"."approved_action_dispatches" (
  dispatch_id varchar(128) PRIMARY KEY,
  approval_request_id varchar(128) NOT NULL,
  project_id varchar(128) NOT NULL,
  action_type varchar(128) NOT NULL,
  action_ref varchar(255) NOT NULL,
  action_digest char(64) NOT NULL,
  preview_digest char(64) NOT NULL,
  dispatch_json jsonb NOT NULL,
  dispatch_digest char(64) NOT NULL,
  created_at_ms bigint NOT NULL,
  CONSTRAINT ql3_approved_action_dispatch_request_fk
    FOREIGN KEY (approval_request_id)
    REFERENCES "ql3"."approval_requests" (request_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_approved_action_dispatch_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_approved_action_dispatch_identity_check CHECK (
    dispatch_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND action_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND action_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'
  ),
  CONSTRAINT ql3_approved_action_dispatch_digest_check CHECK (
    action_digest ~ '^[0-9a-f]{64}$'
    AND preview_digest ~ '^[0-9a-f]{64}$'
    AND dispatch_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_approved_action_dispatch_json_check CHECK (
    jsonb_typeof(dispatch_json) = 'object'
    AND octet_length(dispatch_json::text) BETWEEN 2 AND 65536
    AND dispatch_json @> jsonb_build_object(
      'id', dispatch_id,
      'approvalRequestId', approval_request_id,
      'projectId', project_id,
      'action', jsonb_build_object(
        'actionType', action_type,
        'actionRef', action_ref,
        'actionDigest', action_digest,
        'previewDigest', preview_digest
      )
    )
  ),
  CONSTRAINT ql3_approved_action_dispatch_time_check CHECK (
    created_at_ms >= 0
  )
)
      `.trim(),
    `
CREATE UNIQUE INDEX ql3_approved_action_dispatch_request_uidx
ON "ql3"."approved_action_dispatches" (approval_request_id)
      `.trim(),
    `
CREATE INDEX ql3_approved_action_dispatch_project_idx
ON "ql3"."approved_action_dispatches"
  (project_id, created_at_ms, dispatch_id)
      `.trim(),
    `
CREATE FUNCTION "ql3"."lock_approval_policy_fence"(
  varchar,
  varchar,
  varchar,
  integer,
  integer
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
DECLARE
  current_project_version integer;
  current_project_status varchar;
  current_binding_version integer;
BEGIN
  SELECT project.version, project.status
  INTO current_project_version, current_project_status
  FROM "ql3"."projects" AS project
  WHERE project.id = $1
  FOR SHARE;

  SELECT binding.version
  INTO current_binding_version
  FROM "ql3"."project_role_bindings" AS binding
  WHERE binding.project_id = $1
    AND binding.subject_type = $2
    AND binding.subject_id = $3
  ORDER BY binding.version DESC
  LIMIT 1
  FOR SHARE;

  RETURN current_project_status = 'active'
    AND current_project_version = $4
    AND current_binding_version IS NOT DISTINCT FROM $5;
END
$ql3$
      `.trim(),
    `
REVOKE ALL
ON FUNCTION "ql3"."lock_approval_policy_fence"(
  varchar, varchar, varchar, integer, integer
)
FROM PUBLIC
      `.trim(),
    `
GRANT EXECUTE
ON FUNCTION "ql3"."lock_approval_policy_fence"(
  varchar, varchar, varchar, integer, integer
)
TO ql3_admin
      `.trim(),
    `
GRANT SELECT, INSERT, UPDATE
ON "ql3"."approval_requests"
TO ql3_admin
      `.trim(),
    `
GRANT SELECT, INSERT
ON "ql3"."approved_action_dispatches"
TO ql3_admin
      `.trim(),
    `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 18,
      migration_id = 'pg-0019-approved-actions',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_install":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 17
    AND migration_id = 'pg-0018-plugin-package-installs'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_install":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 17'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
  ],
});
