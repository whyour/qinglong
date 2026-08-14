import { CAPABILITIES_V63 } from '../migrations/pg-0064-plugin-package-secret-binding-transition-approval-plans';
import { definePostgresSqlMigration } from '../migrations/sqlMigration';

export const CAPABILITIES_V64 = CAPABILITIES_V63.replace(
  '"approved_action_execution":1,',
  '"approved_action_execution":1,"approved_action_manual_recovery":1,',
);

export const pg0065ApprovedActionManualRecoveryMigration =
  definePostgresSqlMigration({
    id: 'pg-0065-approved-action-manual-recovery',
    statements: [
      `
CREATE TABLE "ql3"."approved_action_manual_recovery_resolutions" (
  dispatch_id varchar(128) PRIMARY KEY,
  dispatch_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  action_type varchar(128) NOT NULL,
  action_digest char(64) NOT NULL,
  execution_version integer NOT NULL,
  execution_digest char(64) NOT NULL,
  mutation_id varchar(128) NOT NULL,
  decision varchar(32) NOT NULL,
  evidence_digest char(64) NOT NULL,
  reason_code varchar(64) NOT NULL,
  resolved_by_type varchar(16) NOT NULL,
  resolved_by_id varchar(255) NOT NULL,
  authentication_id varchar(128) NOT NULL,
  assurance varchar(32) NOT NULL,
  authenticated_at_ms bigint NOT NULL,
  project_version integer NOT NULL,
  binding_version integer NOT NULL,
  audit_event_id uuid NOT NULL,
  resolved_at_ms bigint NOT NULL,
  resolution_json jsonb NOT NULL,
  resolution_digest char(64) NOT NULL,
  CONSTRAINT ql3_approved_action_manual_recovery_dispatch_fk
    FOREIGN KEY (dispatch_id)
    REFERENCES "ql3"."approved_action_dispatches" (dispatch_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_approved_action_manual_recovery_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_approved_action_manual_recovery_audit_fk
    FOREIGN KEY (audit_event_id)
    REFERENCES "ql3"."security_audit_events" (event_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_approved_action_manual_recovery_identity_check CHECK (
    dispatch_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    action_type IN (
      'plugin_package.secret_binding.bind',
      'plugin_package.secret_binding.transition'
    ) AND
    execution_version BETWEEN 1 AND 2147483647 AND
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    decision IN ('confirm_failed', 'abandon_unknown') AND
    reason_code ~ '^[a-z][a-z0-9_]{0,63}$' AND
    resolved_by_type = 'user' AND
    octet_length(resolved_by_id) BETWEEN 1 AND 255 AND
    resolved_by_id !~ '[[:cntrl:]]' AND
    authentication_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    assurance IN ('multi_factor', 'hardware') AND
    project_version >= 1 AND binding_version >= 1
  ),
  CONSTRAINT ql3_approved_action_manual_recovery_digest_check CHECK (
    dispatch_digest ~ '^[0-9a-f]{64}$' AND
    action_digest ~ '^[0-9a-f]{64}$' AND
    execution_digest ~ '^[0-9a-f]{64}$' AND
    evidence_digest ~ '^[0-9a-f]{64}$' AND
    resolution_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_approved_action_manual_recovery_time_check CHECK (
    authenticated_at_ms >= 0 AND
    resolved_at_ms >= authenticated_at_ms AND
    resolved_at_ms - authenticated_at_ms <= 300000
  ),
  CONSTRAINT ql3_approved_action_manual_recovery_json_check CHECK (
    jsonb_typeof(resolution_json) = 'object' AND
    octet_length(resolution_json::text) BETWEEN 2 AND 65536 AND
    resolution_json @> jsonb_build_object(
      'schema', 'qinglong/approved-action-manual-recovery@v1',
      'dispatchId', dispatch_id,
      'dispatchDigest', dispatch_digest,
      'projectId', project_id,
      'actionType', action_type,
      'actionDigest', action_digest,
      'executionVersion', execution_version,
      'executionDigest', execution_digest,
      'mutationId', mutation_id,
      'decision', decision,
      'evidenceDigest', evidence_digest,
      'reasonCode', reason_code,
      'resolvedBy', jsonb_build_object(
        'type', resolved_by_type,
        'id', resolved_by_id
      ),
      'authenticationId', authentication_id,
      'assurance', assurance,
      'authenticatedAtMs', authenticated_at_ms,
      'authorizationFence', jsonb_build_object(
        'projectVersion', project_version,
        'bindingVersion', binding_version
      ),
      'auditEventId', audit_event_id,
      'resolvedAtMs', resolved_at_ms,
      'resolutionDigest', resolution_digest
    )
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_approved_action_manual_recovery_mutation_uidx ON "ql3"."approved_action_manual_recovery_resolutions" (mutation_id)`,
      `CREATE UNIQUE INDEX ql3_approved_action_manual_recovery_digest_uidx ON "ql3"."approved_action_manual_recovery_resolutions" (resolution_digest)`,
      `CREATE INDEX ql3_approved_action_manual_recovery_project_idx ON "ql3"."approved_action_manual_recovery_resolutions" (project_id, resolved_at_ms, dispatch_id)`,
      `
CREATE FUNCTION "ql3"."resolve_approved_action_manual_recovery"(
  p_resolution_json jsonb,
  p_next_execution_json jsonb,
  p_audit_json jsonb
)
RETURNS varchar
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
DECLARE
  current_execution_json jsonb;
  current_execution_digest char(64);
  current_version integer;
  current_status varchar;
  current_project_id varchar;
  current_dispatch_digest char(64);
  current_action_type varchar;
  current_action_digest char(64);
  current_lease_expires_at_ms bigint;
  existing_resolution_json jsonb;
  expected_status varchar;
  expected_result_code varchar;
BEGIN
  IF NOT pg_has_role(session_user, 'ql3_approval_manager', 'member') THEN
    RAISE EXCEPTION 'Approval manager authority is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF jsonb_typeof(p_resolution_json) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_resolution_json)) <> 20
    OR jsonb_typeof(p_next_execution_json) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_next_execution_json)) <> 21
    OR jsonb_typeof(p_audit_json) <> 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(p_audit_json)) <> 10
  THEN
    RAISE EXCEPTION 'Approved Action manual recovery input is malformed'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT resolution_json
    INTO existing_resolution_json
    FROM "ql3"."approved_action_manual_recovery_resolutions"
   WHERE dispatch_id = p_resolution_json ->> 'dispatchId';
  IF FOUND THEN
    SELECT execution_json
      INTO current_execution_json
      FROM "ql3"."approved_action_executions"
     WHERE dispatch_id = p_resolution_json ->> 'dispatchId';
    IF existing_resolution_json = p_resolution_json
      AND current_execution_json = p_next_execution_json
      AND EXISTS (
        SELECT 1
          FROM "ql3"."security_audit_events" AS audit
         WHERE audit.event_id = (p_audit_json ->> 'eventId')::uuid
           AND audit.request_id = p_audit_json ->> 'requestId'
           AND audit.operation_id = 'approval.recover.resolve'
           AND audit.project_id = p_resolution_json ->> 'projectId'
           AND audit.subject_type = 'user'
           AND audit.subject_id = p_resolution_json #>> '{resolvedBy,id}'
           AND audit.authentication_id = p_resolution_json ->> 'authenticationId'
           AND audit.outcome = 'allowed'
           AND audit.reasons = p_audit_json -> 'reasons'
           AND audit.project_version = (p_resolution_json #>> '{authorizationFence,projectVersion}')::integer
           AND audit.binding_version = (p_resolution_json #>> '{authorizationFence,bindingVersion}')::integer
           AND audit.occurred_at_ms = (p_resolution_json ->> 'resolvedAtMs')::bigint
      )
    THEN
      RETURN 'existing';
    END IF;
    RAISE EXCEPTION 'Approved Action manual recovery replay conflicts'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT "ql3"."lock_approval_policy_fence"(
    p_resolution_json ->> 'projectId',
    p_resolution_json #>> '{resolvedBy,type}',
    p_resolution_json #>> '{resolvedBy,id}',
    (p_resolution_json #>> '{authorizationFence,projectVersion}')::integer,
    (p_resolution_json #>> '{authorizationFence,bindingVersion}')::integer
  ) THEN
    RAISE EXCEPTION 'Approved Action manual recovery policy fence changed'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT execution.execution_json,
         execution.execution_digest,
         execution.version,
         execution.status,
         execution.project_id,
         execution.dispatch_digest,
         dispatch.action_type,
         dispatch.action_digest,
         execution.lease_expires_at_ms
    INTO current_execution_json,
         current_execution_digest,
         current_version,
         current_status,
         current_project_id,
         current_dispatch_digest,
         current_action_type,
         current_action_digest,
         current_lease_expires_at_ms
    FROM "ql3"."approved_action_executions" AS execution
    JOIN "ql3"."approved_action_dispatches" AS dispatch
      ON dispatch.dispatch_id = execution.dispatch_id
   WHERE execution.dispatch_id = p_resolution_json ->> 'dispatchId'
   FOR UPDATE OF execution;

  IF NOT FOUND
    OR current_status <> 'executing'
    OR current_lease_expires_at_ms IS NULL
    OR current_lease_expires_at_ms > (p_resolution_json ->> 'resolvedAtMs')::bigint
    OR current_project_id <> p_resolution_json ->> 'projectId'
    OR current_dispatch_digest <> p_resolution_json ->> 'dispatchDigest'
    OR current_action_type <> p_resolution_json ->> 'actionType'
    OR current_action_type NOT IN (
      'plugin_package.secret_binding.bind',
      'plugin_package.secret_binding.transition'
    )
    OR current_action_digest <> p_resolution_json ->> 'actionDigest'
    OR current_version <> (p_resolution_json ->> 'executionVersion')::integer
    OR current_execution_digest <> p_resolution_json ->> 'executionDigest'
  THEN
    RAISE EXCEPTION 'Approved Action manual recovery execution fence changed'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_resolution_json ->> 'decision' = 'confirm_failed' THEN
    expected_status := 'failed';
    expected_result_code := 'manual_recovery_confirmed_failed';
  ELSIF p_resolution_json ->> 'decision' = 'abandon_unknown' THEN
    expected_status := 'blocked';
    expected_result_code := 'manual_recovery_abandoned_unknown';
  ELSE
    RAISE EXCEPTION 'Approved Action manual recovery decision is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT p_next_execution_json ?& ARRAY[
       'schema', 'dispatchId', 'dispatchDigest', 'projectId', 'status',
       'version', 'attemptCount', 'maxAttempts', 'eligibleAtMs',
       'nextAttemptAtMs', 'leaseOwner', 'leaseToken', 'leaseExpiresAtMs',
       'startedAtMs', 'resultMutationId', 'resultCode', 'resultDigest',
       'completedAtMs', 'createdAtMs', 'updatedAtMs', 'executionDigest'
     ]::text[]
    OR p_next_execution_json - ARRAY[
       'status', 'version', 'eligibleAtMs', 'nextAttemptAtMs',
       'leaseOwner', 'leaseToken', 'leaseExpiresAtMs', 'resultMutationId',
       'resultCode', 'resultDigest', 'completedAtMs', 'updatedAtMs',
       'executionDigest'
     ]::text[]
     <> current_execution_json - ARRAY[
       'status', 'version', 'eligibleAtMs', 'nextAttemptAtMs',
       'leaseOwner', 'leaseToken', 'leaseExpiresAtMs', 'resultMutationId',
       'resultCode', 'resultDigest', 'completedAtMs', 'updatedAtMs',
       'executionDigest'
     ]::text[]
    OR p_next_execution_json ->> 'status' <> expected_status
    OR (p_next_execution_json ->> 'version')::integer <> current_version + 1
    OR p_next_execution_json -> 'eligibleAtMs' <> 'null'::jsonb
    OR p_next_execution_json -> 'nextAttemptAtMs' <> 'null'::jsonb
    OR p_next_execution_json -> 'leaseOwner' <> 'null'::jsonb
    OR p_next_execution_json -> 'leaseToken' <> 'null'::jsonb
    OR p_next_execution_json -> 'leaseExpiresAtMs' <> 'null'::jsonb
    OR p_next_execution_json ->> 'resultMutationId' <> p_resolution_json ->> 'mutationId'
    OR p_next_execution_json ->> 'resultCode' <> expected_result_code
    OR p_next_execution_json -> 'resultDigest' <> 'null'::jsonb
    OR (p_next_execution_json ->> 'completedAtMs')::bigint <> (p_resolution_json ->> 'resolvedAtMs')::bigint
    OR (p_next_execution_json ->> 'updatedAtMs')::bigint <> (p_resolution_json ->> 'resolvedAtMs')::bigint
    OR p_next_execution_json ->> 'executionDigest' !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'Approved Action manual recovery terminal execution is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_audit_json ->> 'eventId' <> p_resolution_json ->> 'auditEventId'
    OR p_audit_json ->> 'operationId' <> 'approval.recover.resolve'
    OR p_audit_json ->> 'projectId' <> p_resolution_json ->> 'projectId'
    OR p_audit_json #>> '{subject,type}' <> 'user'
    OR p_audit_json #>> '{subject,id}' <> p_resolution_json #>> '{resolvedBy,id}'
    OR p_audit_json ->> 'authenticationId' <> p_resolution_json ->> 'authenticationId'
    OR p_audit_json ->> 'outcome' <> 'allowed'
    OR p_audit_json -> 'reasons' <> '["role_grant","strong_authentication","manual_recovery"]'::jsonb
    OR p_audit_json -> 'fence' <> p_resolution_json -> 'authorizationFence'
    OR (p_audit_json ->> 'occurredAtMs')::bigint <> (p_resolution_json ->> 'resolvedAtMs')::bigint
  THEN
    RAISE EXCEPTION 'Approved Action manual recovery audit is invalid'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO "ql3"."security_audit_events" (
    event_id, request_id, operation_id, project_id, subject_type, subject_id,
    authentication_id, outcome, reasons, project_version, binding_version,
    occurred_at_ms
  ) VALUES (
    (p_audit_json ->> 'eventId')::uuid,
    p_audit_json ->> 'requestId',
    p_audit_json ->> 'operationId',
    p_audit_json ->> 'projectId',
    p_audit_json #>> '{subject,type}',
    p_audit_json #>> '{subject,id}',
    p_audit_json ->> 'authenticationId',
    p_audit_json ->> 'outcome',
    p_audit_json -> 'reasons',
    (p_audit_json #>> '{fence,projectVersion}')::integer,
    (p_audit_json #>> '{fence,bindingVersion}')::integer,
    (p_audit_json ->> 'occurredAtMs')::bigint
  );

  UPDATE "ql3"."approved_action_executions"
     SET status = expected_status,
         version = (p_next_execution_json ->> 'version')::integer,
         eligible_at_ms = NULL,
         next_attempt_at_ms = NULL,
         lease_owner = NULL,
         lease_token = NULL,
         lease_expires_at_ms = NULL,
         result_mutation_id = p_next_execution_json ->> 'resultMutationId',
         result_code = expected_result_code,
         result_digest = NULL,
         completed_at_ms = (p_next_execution_json ->> 'completedAtMs')::bigint,
         updated_at_ms = (p_next_execution_json ->> 'updatedAtMs')::bigint,
         execution_json = p_next_execution_json,
         execution_digest = p_next_execution_json ->> 'executionDigest'
   WHERE dispatch_id = p_resolution_json ->> 'dispatchId'
     AND version = current_version
     AND execution_digest = current_execution_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Approved Action manual recovery update fence changed'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO "ql3"."approved_action_manual_recovery_resolutions" (
    dispatch_id, dispatch_digest, project_id, action_type, action_digest,
    execution_version, execution_digest, mutation_id, decision,
    evidence_digest, reason_code, resolved_by_type, resolved_by_id,
    authentication_id, assurance, authenticated_at_ms, project_version,
    binding_version, audit_event_id, resolved_at_ms, resolution_json,
    resolution_digest
  ) VALUES (
    p_resolution_json ->> 'dispatchId',
    p_resolution_json ->> 'dispatchDigest',
    p_resolution_json ->> 'projectId',
    p_resolution_json ->> 'actionType',
    p_resolution_json ->> 'actionDigest',
    (p_resolution_json ->> 'executionVersion')::integer,
    p_resolution_json ->> 'executionDigest',
    p_resolution_json ->> 'mutationId',
    p_resolution_json ->> 'decision',
    p_resolution_json ->> 'evidenceDigest',
    p_resolution_json ->> 'reasonCode',
    p_resolution_json #>> '{resolvedBy,type}',
    p_resolution_json #>> '{resolvedBy,id}',
    p_resolution_json ->> 'authenticationId',
    p_resolution_json ->> 'assurance',
    (p_resolution_json ->> 'authenticatedAtMs')::bigint,
    (p_resolution_json #>> '{authorizationFence,projectVersion}')::integer,
    (p_resolution_json #>> '{authorizationFence,bindingVersion}')::integer,
    (p_resolution_json ->> 'auditEventId')::uuid,
    (p_resolution_json ->> 'resolvedAtMs')::bigint,
    p_resolution_json,
    p_resolution_json ->> 'resolutionDigest'
  );

  RETURN 'resolved';
END
$ql3$
      `.trim(),
      `REVOKE ALL ON "ql3"."approved_action_manual_recovery_resolutions" FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress, ql3_worker_credential_manager, ql3_worker_credential_executor, ql3_automation_manager, ql3_approval_manager, ql3_run_manager`,
      `GRANT SELECT ON "ql3"."approved_action_dispatches", "ql3"."approved_action_executions", "ql3"."approved_action_manual_recovery_resolutions" TO ql3_approval_manager`,
      `REVOKE ALL ON FUNCTION "ql3"."resolve_approved_action_manual_recovery"(jsonb, jsonb, jsonb) FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress, ql3_worker_credential_manager, ql3_worker_credential_executor, ql3_automation_manager, ql3_approval_manager, ql3_run_manager`,
      `GRANT EXECUTE ON FUNCTION "ql3"."resolve_approved_action_manual_recovery"(jsonb, jsonb, jsonb) TO ql3_approval_manager`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 64, migration_id = 'pg-0065-approved-action-manual-recovery', capabilities = '${CAPABILITIES_V64}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 63 AND migration_id = 'pg-0064-plugin-package-secret-binding-transition-approval-plans' AND capabilities = '${CAPABILITIES_V63}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 63' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });
