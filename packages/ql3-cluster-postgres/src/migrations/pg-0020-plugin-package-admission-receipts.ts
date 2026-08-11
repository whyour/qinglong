import { definePostgresSqlMigration } from './sqlMigration';

export const pg0020PluginPackageAdmissionReceiptsMigration =
  definePostgresSqlMigration({
    id: 'pg-0020-plugin-package-admission-receipts',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_admission_receipts" (
  dispatch_id varchar(128) PRIMARY KEY,
  dispatch_digest char(64) NOT NULL,
  approval_request_id varchar(128) NOT NULL,
  action_ref varchar(255) NOT NULL,
  project_id varchar(128) NOT NULL,
  package_name varchar(64) NOT NULL,
  installation_id varchar(128) NOT NULL,
  lock_digest char(64) NOT NULL,
  record_digest char(64) NOT NULL,
  mutation_id varchar(128) NOT NULL,
  mutation_digest char(64) NOT NULL,
  audit_event_id uuid NOT NULL,
  admitted_at_ms bigint NOT NULL,
  receipt_json jsonb NOT NULL,
  receipt_digest char(64) NOT NULL,
  CONSTRAINT ql3_plugin_package_admission_dispatch_fk
    FOREIGN KEY (dispatch_id)
    REFERENCES "ql3"."approved_action_dispatches" (dispatch_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_admission_request_fk
    FOREIGN KEY (approval_request_id)
    REFERENCES "ql3"."approval_requests" (request_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_admission_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_admission_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "ql3"."plugin_package_installs" (installation_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_admission_audit_fk
    FOREIGN KEY (audit_event_id)
    REFERENCES "ql3"."security_audit_events" (event_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_admission_identity_check CHECK (
    dispatch_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND approval_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND action_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'
    AND project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    AND installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_plugin_package_admission_digest_check CHECK (
    dispatch_digest ~ '^[0-9a-f]{64}$'
    AND lock_digest ~ '^[0-9a-f]{64}$'
    AND record_digest ~ '^[0-9a-f]{64}$'
    AND mutation_digest ~ '^[0-9a-f]{64}$'
    AND receipt_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_admission_json_check CHECK (
    jsonb_typeof(receipt_json) = 'object'
    AND octet_length(receipt_json::text) BETWEEN 2 AND 65536
    AND receipt_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-admission-receipt@v1',
      'dispatchId', dispatch_id,
      'dispatchDigest', dispatch_digest,
      'approvalRequestId', approval_request_id,
      'actionRef', action_ref,
      'projectId', project_id,
      'packageName', package_name,
      'installationId', installation_id,
      'lockDigest', lock_digest,
      'recordDigest', record_digest,
      'mutationId', mutation_id,
      'mutationDigest', mutation_digest,
      'auditEventId', audit_event_id::text,
      'admittedAtMs', admitted_at_ms,
      'receiptDigest', receipt_digest
    )
  ),
  CONSTRAINT ql3_plugin_package_admission_time_check CHECK (
    admitted_at_ms >= 0
  )
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_plugin_package_admission_install_uidx
ON "ql3"."plugin_package_admission_receipts" (installation_id)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_plugin_package_admission_audit_uidx
ON "ql3"."plugin_package_admission_receipts" (audit_event_id)
      `.trim(),
      `
CREATE INDEX ql3_plugin_package_admission_project_idx
ON "ql3"."plugin_package_admission_receipts"
  (project_id, admitted_at_ms, dispatch_id)
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."plugin_package_admission_receipts"
TO ql3_admin
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 19,
      migration_id = 'pg-0020-plugin-package-admission-receipts',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_install":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 18
    AND migration_id = 'pg-0019-approved-actions'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_install":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 18'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
