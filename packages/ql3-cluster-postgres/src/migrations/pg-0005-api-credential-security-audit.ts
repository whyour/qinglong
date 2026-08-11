import { definePostgresSqlMigration } from './sqlMigration';

export const POSTGRESQL_IDENTITY_SUBJECT_TABLE = 'identity_subjects';
export const POSTGRESQL_API_CREDENTIAL_TABLE = 'api_credentials';
export const POSTGRESQL_SECURITY_AUDIT_EVENT_TABLE = 'security_audit_events';

export const pg0005ApiCredentialSecurityAuditMigration =
  definePostgresSqlMigration({
    id: 'pg-0005-api-credential-security-audit',
    statements: [
      `
CREATE TABLE "ql3"."${POSTGRESQL_IDENTITY_SUBJECT_TABLE}" (
  subject_type varchar(32) NOT NULL
    CONSTRAINT ql3_identity_subjects_type_check
    CHECK (subject_type IN ('user', 'api_app', 'mcp_client', 'agent', 'system', 'worker')),
  subject_id varchar(255) NOT NULL
    CONSTRAINT ql3_identity_subjects_id_check
    CHECK (char_length(subject_id) >= 1),
  status varchar(16) NOT NULL
    CONSTRAINT ql3_identity_subjects_status_check
    CHECK (status IN ('active', 'disabled')),
  version integer NOT NULL
    CONSTRAINT ql3_identity_subjects_version_check
    CHECK (version BETWEEN 1 AND 2147483647),
  created_at_ms bigint NOT NULL
    CONSTRAINT ql3_identity_subjects_created_at_check
    CHECK (created_at_ms >= 0),
  updated_at_ms bigint NOT NULL
    CONSTRAINT ql3_identity_subjects_updated_at_check
    CHECK (updated_at_ms >= created_at_ms),
  CONSTRAINT identity_subjects_pkey
    PRIMARY KEY (subject_type, subject_id)
)
      `.trim(),
      `
CREATE INDEX ql3_identity_subjects_status_idx
ON "ql3"."${POSTGRESQL_IDENTITY_SUBJECT_TABLE}"
  (status, subject_type, subject_id)
      `.trim(),
      `
CREATE TABLE "ql3"."${POSTGRESQL_API_CREDENTIAL_TABLE}" (
  credential_id varchar(64) NOT NULL
    CONSTRAINT ql3_api_credentials_id_check
    CHECK (credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  version integer NOT NULL
    CONSTRAINT ql3_api_credentials_version_check
    CHECK (version BETWEEN 1 AND 2147483647),
  state varchar(16) NOT NULL
    CONSTRAINT ql3_api_credentials_state_check
    CHECK (state IN ('active', 'revoked')),
  subject_type varchar(32) NOT NULL
    CONSTRAINT ql3_api_credentials_subject_type_check
    CHECK (subject_type IN ('user', 'api_app', 'mcp_client', 'agent')),
  subject_id varchar(255) NOT NULL
    CONSTRAINT ql3_api_credentials_subject_id_check
    CHECK (char_length(subject_id) >= 1),
  secret_digest char(64) NOT NULL
    CONSTRAINT ql3_api_credentials_secret_digest_check
    CHECK (secret_digest ~ '^[a-f0-9]{64}$'),
  created_at_ms bigint NOT NULL
    CONSTRAINT ql3_api_credentials_created_at_check
    CHECK (created_at_ms >= 0),
  not_before_at_ms bigint NOT NULL
    CONSTRAINT ql3_api_credentials_not_before_check
    CHECK (not_before_at_ms >= created_at_ms),
  expires_at_ms bigint NOT NULL
    CONSTRAINT ql3_api_credentials_expires_at_check
    CHECK (expires_at_ms > not_before_at_ms),
  CONSTRAINT api_credentials_pkey
    PRIMARY KEY (credential_id, version),
  CONSTRAINT ql3_api_credentials_subject_fk
    FOREIGN KEY (subject_type, subject_id)
    REFERENCES "ql3"."${POSTGRESQL_IDENTITY_SUBJECT_TABLE}"
      (subject_type, subject_id)
    ON DELETE RESTRICT
)
      `.trim(),
      `
CREATE INDEX ql3_api_credentials_current_idx
ON "ql3"."${POSTGRESQL_API_CREDENTIAL_TABLE}"
  (credential_id, version DESC)
      `.trim(),
      `
CREATE INDEX ql3_api_credentials_subject_idx
ON "ql3"."${POSTGRESQL_API_CREDENTIAL_TABLE}"
  (subject_type, subject_id, credential_id, version DESC)
      `.trim(),
      `
CREATE TABLE "ql3"."${POSTGRESQL_SECURITY_AUDIT_EVENT_TABLE}" (
  event_id uuid PRIMARY KEY,
  request_id varchar(128) NOT NULL
    CONSTRAINT ql3_security_audit_events_request_id_check
    CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  operation_id varchar(128) NOT NULL
    CONSTRAINT ql3_security_audit_events_operation_id_check
    CHECK (operation_id ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
  project_id varchar(128)
    CONSTRAINT ql3_security_audit_events_project_id_check
    CHECK (
      project_id IS NULL
      OR project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
  subject_type varchar(32)
    CONSTRAINT ql3_security_audit_events_subject_type_check
    CHECK (
      subject_type IS NULL
      OR subject_type IN ('user', 'api_app', 'mcp_client', 'agent', 'system', 'worker')
    ),
  subject_id varchar(255)
    CONSTRAINT ql3_security_audit_events_subject_id_check
    CHECK (subject_id IS NULL OR char_length(subject_id) >= 1),
  authentication_id varchar(128)
    CONSTRAINT ql3_security_audit_events_authentication_id_check
    CHECK (
      authentication_id IS NULL
      OR authentication_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
  outcome varchar(32) NOT NULL
    CONSTRAINT ql3_security_audit_events_outcome_check
    CHECK (
      outcome IN (
        'authentication_rejected',
        'authentication_unavailable',
        'authorization_unavailable',
        'denied',
        'approval_required',
        'allowed'
      )
    ),
  reasons jsonb NOT NULL
    CONSTRAINT ql3_security_audit_events_reasons_check
    CHECK (
      jsonb_typeof(reasons) = 'array'
      AND jsonb_array_length(reasons) BETWEEN 1 AND 8
      AND octet_length(reasons::text) <= 1024
    ),
  project_version integer
    CONSTRAINT ql3_security_audit_events_project_version_check
    CHECK (project_version IS NULL OR project_version >= 1),
  binding_version integer
    CONSTRAINT ql3_security_audit_events_binding_version_check
    CHECK (binding_version IS NULL OR binding_version >= 1),
  occurred_at_ms bigint NOT NULL
    CONSTRAINT ql3_security_audit_events_occurred_at_check
    CHECK (occurred_at_ms >= 0),
  CONSTRAINT ql3_security_audit_events_identity_check
    CHECK (
      (
        outcome IN ('authentication_rejected', 'authentication_unavailable')
        AND subject_type IS NULL
        AND subject_id IS NULL
        AND authentication_id IS NULL
      )
      OR (
        outcome NOT IN ('authentication_rejected', 'authentication_unavailable')
        AND subject_type IS NOT NULL
        AND subject_id IS NOT NULL
        AND authentication_id IS NOT NULL
      )
    ),
  CONSTRAINT ql3_security_audit_events_fence_check
    CHECK (project_version IS NOT NULL OR binding_version IS NULL)
)
      `.trim(),
      `
CREATE INDEX ql3_security_audit_events_occurred_idx
ON "ql3"."${POSTGRESQL_SECURITY_AUDIT_EVENT_TABLE}"
  (occurred_at_ms DESC, event_id)
      `.trim(),
      `
CREATE INDEX ql3_security_audit_events_subject_idx
ON "ql3"."${POSTGRESQL_SECURITY_AUDIT_EVENT_TABLE}"
  (subject_type, subject_id, occurred_at_ms DESC, event_id)
WHERE subject_type IS NOT NULL
      `.trim(),
      `
CREATE INDEX ql3_security_audit_events_project_idx
ON "ql3"."${POSTGRESQL_SECURITY_AUDIT_EVENT_TABLE}"
  (project_id, occurred_at_ms DESC, event_id)
WHERE project_id IS NOT NULL
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 4,
      migration_id = 'pg-0005-api-credential-security-audit',
      capabilities = '{"api_credential":1,"project_policy":1,"run_core":1,"run_retry_policy":1,"security_audit":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 3
    AND migration_id = 'pg-0004-project-policy'
    AND capabilities = '{"project_policy":1,"run_core":1,"run_retry_policy":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 3'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
