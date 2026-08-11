import { definePostgresSqlMigration } from './sqlMigration';

export const POSTGRESQL_IDENTITY_SUBJECT_MUTATION_TABLE =
  'identity_subject_mutations';
export const POSTGRESQL_API_CREDENTIAL_MUTATION_TABLE =
  'api_credential_mutations';

export const pg0006IdentityCredentialAdministrationMigration =
  definePostgresSqlMigration({
    id: 'pg-0006-identity-credential-administration',
    statements: [
      `
CREATE TABLE "ql3"."${POSTGRESQL_IDENTITY_SUBJECT_MUTATION_TABLE}" (
  mutation_id uuid PRIMARY KEY,
  operation varchar(16) NOT NULL
    CONSTRAINT ql3_identity_subject_mutations_operation_check
    CHECK (operation IN ('import', 'register', 'enable', 'disable')),
  subject_type varchar(32) NOT NULL
    CONSTRAINT ql3_identity_subject_mutations_subject_type_check
    CHECK (subject_type IN ('user', 'api_app', 'mcp_client', 'agent', 'system', 'worker')),
  subject_id varchar(255) NOT NULL
    CONSTRAINT ql3_identity_subject_mutations_subject_id_check
    CHECK (char_length(subject_id) >= 1),
  subject_version integer NOT NULL
    CONSTRAINT ql3_identity_subject_mutations_version_check
    CHECK (subject_version BETWEEN 1 AND 2147483647),
  expected_previous_version integer NOT NULL
    CONSTRAINT ql3_identity_subject_mutations_previous_version_check
    CHECK (expected_previous_version BETWEEN 0 AND 2147483646),
  status varchar(16) NOT NULL
    CONSTRAINT ql3_identity_subject_mutations_status_check
    CHECK (status IN ('active', 'disabled')),
  changed_by_type varchar(32) NOT NULL
    CONSTRAINT ql3_identity_subject_mutations_changed_by_type_check
    CHECK (changed_by_type IN ('user', 'system')),
  changed_by_id varchar(255) NOT NULL
    CONSTRAINT ql3_identity_subject_mutations_changed_by_id_check
    CHECK (char_length(changed_by_id) >= 1),
  audit_event_id uuid NOT NULL,
  identity_created_at_ms bigint NOT NULL
    CONSTRAINT ql3_identity_subject_mutations_identity_created_at_check
    CHECK (identity_created_at_ms >= 0),
  created_at_ms bigint NOT NULL
    CONSTRAINT ql3_identity_subject_mutations_created_at_check
    CHECK (created_at_ms >= 0),
  CONSTRAINT ql3_identity_subject_mutations_version_fence_check
    CHECK (subject_version = expected_previous_version + 1),
  CONSTRAINT ql3_identity_subject_mutations_transition_check
    CHECK (
      operation = 'import'
      OR (operation = 'register' AND expected_previous_version = 0 AND status = 'active')
      OR (operation = 'enable' AND expected_previous_version >= 1 AND status = 'active')
      OR (operation = 'disable' AND expected_previous_version >= 1 AND status = 'disabled')
    ),
  CONSTRAINT ql3_identity_subject_mutations_audit_identity_check
    CHECK (mutation_id = audit_event_id),
  CONSTRAINT ql3_identity_subject_mutations_subject_fk
    FOREIGN KEY (subject_type, subject_id)
    REFERENCES "ql3"."identity_subjects" (subject_type, subject_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_identity_subject_mutations_audit_fk
    FOREIGN KEY (audit_event_id)
    REFERENCES "ql3"."security_audit_events" (event_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_identity_subject_mutations_subject_version_uidx
    UNIQUE (subject_type, subject_id, subject_version)
)
      `.trim(),
      `
CREATE INDEX ql3_identity_subject_mutations_actor_idx
ON "ql3"."${POSTGRESQL_IDENTITY_SUBJECT_MUTATION_TABLE}"
  (changed_by_type, changed_by_id, created_at_ms DESC, mutation_id)
      `.trim(),
      `
WITH source AS (
  SELECT
    subject.*,
    md5('ql3-identity-import:' || subject.subject_type || ':' || subject.subject_id) AS digest
  FROM "ql3"."identity_subjects" AS subject
), imported AS (
  SELECT
    source.*,
    (
      substr(digest, 1, 8) || '-' || substr(digest, 9, 4) || '-4' ||
      substr(digest, 14, 3) || '-8' || substr(digest, 18, 3) || '-' ||
      substr(digest, 21, 12)
    )::uuid AS mutation_id
  FROM source
)
INSERT INTO "ql3"."security_audit_events" (
  event_id, request_id, operation_id, project_id, subject_type, subject_id,
  authentication_id, outcome, reasons, project_version, binding_version,
  occurred_at_ms
)
SELECT
  mutation_id,
  'migration:' || mutation_id::text,
  'identity.import',
  NULL,
  'system',
  'pg-0006',
  'migration:pg-0006',
  'allowed',
  '["identity_admin"]'::jsonb,
  NULL,
  NULL,
  created_at_ms
FROM imported
      `.trim(),
      `
WITH source AS (
  SELECT
    subject.*,
    md5('ql3-identity-import:' || subject.subject_type || ':' || subject.subject_id) AS digest
  FROM "ql3"."identity_subjects" AS subject
), imported AS (
  SELECT
    source.*,
    (
      substr(digest, 1, 8) || '-' || substr(digest, 9, 4) || '-4' ||
      substr(digest, 14, 3) || '-8' || substr(digest, 18, 3) || '-' ||
      substr(digest, 21, 12)
    )::uuid AS mutation_id
  FROM source
)
INSERT INTO "ql3"."${POSTGRESQL_IDENTITY_SUBJECT_MUTATION_TABLE}" (
  mutation_id, operation, subject_type, subject_id, subject_version,
  expected_previous_version, status, changed_by_type, changed_by_id,
  audit_event_id, identity_created_at_ms, created_at_ms
)
SELECT
  mutation_id,
  'import',
  subject_type,
  subject_id,
  version,
  version - 1,
  status,
  'system',
  'pg-0006',
  mutation_id,
  created_at_ms,
  created_at_ms
FROM imported
      `.trim(),
      `
CREATE TABLE "ql3"."${POSTGRESQL_API_CREDENTIAL_MUTATION_TABLE}" (
  mutation_id uuid PRIMARY KEY,
  operation varchar(16) NOT NULL
    CONSTRAINT ql3_api_credential_mutations_operation_check
    CHECK (operation IN ('import', 'issue', 'rotate', 'revoke')),
  credential_id varchar(64) NOT NULL
    CONSTRAINT ql3_api_credential_mutations_id_check
    CHECK (credential_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  credential_version integer NOT NULL
    CONSTRAINT ql3_api_credential_mutations_version_check
    CHECK (credential_version BETWEEN 1 AND 2147483647),
  expected_previous_version integer NOT NULL
    CONSTRAINT ql3_api_credential_mutations_previous_version_check
    CHECK (expected_previous_version BETWEEN 0 AND 2147483646),
  state varchar(16) NOT NULL
    CONSTRAINT ql3_api_credential_mutations_state_check
    CHECK (state IN ('active', 'revoked')),
  subject_type varchar(32) NOT NULL
    CONSTRAINT ql3_api_credential_mutations_subject_type_check
    CHECK (subject_type IN ('user', 'api_app', 'mcp_client', 'agent')),
  subject_id varchar(255) NOT NULL
    CONSTRAINT ql3_api_credential_mutations_subject_id_check
    CHECK (char_length(subject_id) >= 1),
  subject_status varchar(16) NOT NULL
    CONSTRAINT ql3_api_credential_mutations_subject_status_check
    CHECK (subject_status IN ('active', 'disabled')),
  changed_by_type varchar(32) NOT NULL
    CONSTRAINT ql3_api_credential_mutations_changed_by_type_check
    CHECK (changed_by_type IN ('user', 'system')),
  changed_by_id varchar(255) NOT NULL
    CONSTRAINT ql3_api_credential_mutations_changed_by_id_check
    CHECK (char_length(changed_by_id) >= 1),
  audit_event_id uuid NOT NULL,
  created_at_ms bigint NOT NULL
    CONSTRAINT ql3_api_credential_mutations_created_at_check
    CHECK (created_at_ms >= 0),
  CONSTRAINT ql3_api_credential_mutations_version_fence_check
    CHECK (credential_version = expected_previous_version + 1),
  CONSTRAINT ql3_api_credential_mutations_transition_check
    CHECK (
      operation = 'import'
      OR (operation = 'issue' AND expected_previous_version = 0 AND state = 'active')
      OR (operation = 'rotate' AND expected_previous_version >= 1 AND state = 'active')
      OR (operation = 'revoke' AND expected_previous_version >= 1 AND state = 'revoked')
    ),
  CONSTRAINT ql3_api_credential_mutations_audit_identity_check
    CHECK (mutation_id = audit_event_id),
  CONSTRAINT ql3_api_credential_mutations_credential_fk
    FOREIGN KEY (credential_id, credential_version)
    REFERENCES "ql3"."api_credentials" (credential_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_api_credential_mutations_subject_fk
    FOREIGN KEY (subject_type, subject_id)
    REFERENCES "ql3"."identity_subjects" (subject_type, subject_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_api_credential_mutations_audit_fk
    FOREIGN KEY (audit_event_id)
    REFERENCES "ql3"."security_audit_events" (event_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_api_credential_mutations_credential_version_uidx
    UNIQUE (credential_id, credential_version)
)
      `.trim(),
      `
CREATE INDEX ql3_api_credential_mutations_actor_idx
ON "ql3"."${POSTGRESQL_API_CREDENTIAL_MUTATION_TABLE}"
  (changed_by_type, changed_by_id, created_at_ms DESC, mutation_id)
      `.trim(),
      `
WITH source AS (
  SELECT
    credential.*,
    md5('ql3-credential-import:' || credential.credential_id || ':' || credential.version::text) AS digest
  FROM "ql3"."api_credentials" AS credential
), imported AS (
  SELECT
    source.*,
    (
      substr(digest, 1, 8) || '-' || substr(digest, 9, 4) || '-4' ||
      substr(digest, 14, 3) || '-8' || substr(digest, 18, 3) || '-' ||
      substr(digest, 21, 12)
    )::uuid AS mutation_id
  FROM source
)
INSERT INTO "ql3"."security_audit_events" (
  event_id, request_id, operation_id, project_id, subject_type, subject_id,
  authentication_id, outcome, reasons, project_version, binding_version,
  occurred_at_ms
)
SELECT
  mutation_id,
  'migration:' || mutation_id::text,
  'credential.import',
  NULL,
  'system',
  'pg-0006',
  'migration:pg-0006',
  'allowed',
  '["credential_admin"]'::jsonb,
  NULL,
  NULL,
  created_at_ms
FROM imported
      `.trim(),
      `
WITH source AS (
  SELECT
    credential.*,
    md5('ql3-credential-import:' || credential.credential_id || ':' || credential.version::text) AS digest
  FROM "ql3"."api_credentials" AS credential
), imported AS (
  SELECT
    source.*,
    (
      substr(digest, 1, 8) || '-' || substr(digest, 9, 4) || '-4' ||
      substr(digest, 14, 3) || '-8' || substr(digest, 18, 3) || '-' ||
      substr(digest, 21, 12)
    )::uuid AS mutation_id
  FROM source
)
INSERT INTO "ql3"."${POSTGRESQL_API_CREDENTIAL_MUTATION_TABLE}" (
  mutation_id, operation, credential_id, credential_version,
  expected_previous_version, state, subject_type, subject_id,
  subject_status, changed_by_type, changed_by_id, audit_event_id, created_at_ms
)
SELECT
  mutation_id,
  'import',
  credential_id,
  version,
  version - 1,
  state,
  subject_type,
  subject_id,
  (
    SELECT identity.status
    FROM "ql3"."identity_subjects" AS identity
    WHERE identity.subject_type = imported.subject_type
      AND identity.subject_id = imported.subject_id
  ),
  'system',
  'pg-0006',
  mutation_id,
  created_at_ms
FROM imported
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 5,
      migration_id = 'pg-0006-identity-credential-administration',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 4
    AND migration_id = 'pg-0005-api-credential-security-audit'
    AND capabilities = '{"api_credential":1,"project_policy":1,"run_core":1,"run_retry_policy":1,"security_audit":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 4'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
