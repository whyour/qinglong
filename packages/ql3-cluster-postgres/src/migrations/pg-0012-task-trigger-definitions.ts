import { definePostgresSqlMigration } from './sqlMigration';

export const pg0012TaskTriggerDefinitionsMigration =
  definePostgresSqlMigration({
    id: 'pg-0012-task-trigger-definitions',
    statements: [
      `
CREATE TABLE "ql3"."task_definitions" (
  project_id varchar(128) NOT NULL,
  task_id varchar(128) NOT NULL,
  current_revision integer NOT NULL,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT task_definitions_pkey PRIMARY KEY (project_id, task_id),
  CONSTRAINT ql3_task_definitions_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_task_definitions_id_check CHECK (
    char_length(project_id) BETWEEN 1 AND 128
    AND char_length(task_id) BETWEEN 1 AND 128
    AND project_id !~ '[[:cntrl:]]'
    AND task_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ql3_task_definitions_revision_check
    CHECK (current_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT ql3_task_definitions_time_check
    CHECK (created_at_ms >= 0 AND updated_at_ms >= created_at_ms)
)
      `.trim(),
      `
CREATE TABLE "ql3"."task_definition_revisions" (
  project_id varchar(128) NOT NULL,
  task_id varchar(128) NOT NULL,
  revision integer NOT NULL,
  mutation_id uuid NOT NULL,
  name varchar(255) NOT NULL,
  description varchar(4096),
  kind varchar(16) NOT NULL,
  spec_json jsonb NOT NULL,
  labels_json jsonb NOT NULL,
  enabled boolean NOT NULL,
  content_digest char(64) NOT NULL,
  created_at_ms bigint NOT NULL,
  CONSTRAINT task_definition_revisions_pkey
    PRIMARY KEY (project_id, task_id, revision),
  CONSTRAINT ql3_task_definition_revisions_head_fk
    FOREIGN KEY (project_id, task_id)
    REFERENCES "ql3"."task_definitions" (project_id, task_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_task_definition_revisions_revision_check
    CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT ql3_task_definition_revisions_name_check CHECK (
    char_length(name) BETWEEN 1 AND 255
    AND (description IS NULL OR char_length(description) BETWEEN 1 AND 4096)
  ),
  CONSTRAINT ql3_task_definition_revisions_kind_check
    CHECK (kind IN ('script', 'command', 'workflow', 'agent', 'tool')),
  CONSTRAINT ql3_task_definition_revisions_spec_check CHECK (
    jsonb_typeof(spec_json) = 'object'
    AND octet_length(spec_json::text) BETWEEN 2 AND 65536
  ),
  CONSTRAINT ql3_task_definition_revisions_labels_check CHECK (
    jsonb_typeof(labels_json) = 'object'
    AND octet_length(labels_json::text) BETWEEN 2 AND 16384
  ),
  CONSTRAINT ql3_task_definition_revisions_digest_check
    CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ql3_task_definition_revisions_created_check
    CHECK (created_at_ms >= 0)
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_task_definition_revisions_mutation_uidx
ON "ql3"."task_definition_revisions" (mutation_id)
      `.trim(),
      `
CREATE INDEX ql3_task_definition_revisions_project_kind_idx
ON "ql3"."task_definition_revisions"
  (project_id, kind, enabled, task_id, revision)
      `.trim(),
      `
CREATE TABLE "ql3"."triggers" (
  project_id varchar(128) NOT NULL,
  trigger_id varchar(128) NOT NULL,
  task_id varchar(128) NOT NULL,
  current_revision integer NOT NULL,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT triggers_pkey PRIMARY KEY (project_id, trigger_id),
  CONSTRAINT ql3_triggers_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id) ON DELETE RESTRICT,
  CONSTRAINT ql3_triggers_task_fk
    FOREIGN KEY (project_id, task_id)
    REFERENCES "ql3"."task_definitions" (project_id, task_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_triggers_id_check CHECK (
    char_length(project_id) BETWEEN 1 AND 128
    AND char_length(trigger_id) BETWEEN 1 AND 128
    AND char_length(task_id) BETWEEN 1 AND 128
    AND project_id !~ '[[:cntrl:]]'
    AND trigger_id !~ '[[:cntrl:]]'
    AND task_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ql3_triggers_revision_check
    CHECK (current_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT ql3_triggers_time_check
    CHECK (created_at_ms >= 0 AND updated_at_ms >= created_at_ms)
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_triggers_task_uidx
ON "ql3"."triggers" (project_id, trigger_id, task_id)
      `.trim(),
      `
CREATE TABLE "ql3"."trigger_revisions" (
  project_id varchar(128) NOT NULL,
  trigger_id varchar(128) NOT NULL,
  revision integer NOT NULL,
  mutation_id uuid NOT NULL,
  task_id varchar(128) NOT NULL,
  task_revision integer NOT NULL,
  task_content_digest char(64) NOT NULL,
  spec_json jsonb NOT NULL,
  enabled boolean NOT NULL,
  content_digest char(64) NOT NULL,
  created_at_ms bigint NOT NULL,
  CONSTRAINT trigger_revisions_pkey
    PRIMARY KEY (project_id, trigger_id, revision),
  CONSTRAINT ql3_trigger_revisions_head_fk
    FOREIGN KEY (project_id, trigger_id, task_id)
    REFERENCES "ql3"."triggers" (project_id, trigger_id, task_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_trigger_revisions_task_revision_fk
    FOREIGN KEY (project_id, task_id, task_revision)
    REFERENCES "ql3"."task_definition_revisions" (project_id, task_id, revision)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_trigger_revisions_revision_check CHECK (
    revision BETWEEN 1 AND 2147483647
    AND task_revision BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_trigger_revisions_task_digest_check
    CHECK (task_content_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ql3_trigger_revisions_spec_check CHECK (
    jsonb_typeof(spec_json) = 'object'
    AND octet_length(spec_json::text) BETWEEN 2 AND 16384
  ),
  CONSTRAINT ql3_trigger_revisions_digest_check
    CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ql3_trigger_revisions_created_check
    CHECK (created_at_ms >= 0)
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_trigger_revisions_mutation_uidx
ON "ql3"."trigger_revisions" (mutation_id)
      `.trim(),
      `
CREATE INDEX ql3_trigger_revisions_project_enabled_idx
ON "ql3"."trigger_revisions"
  (project_id, enabled, trigger_id, revision)
      `.trim(),
      `
CREATE INDEX ql3_trigger_revisions_task_idx
ON "ql3"."trigger_revisions"
  (project_id, task_id, task_revision, trigger_id, revision)
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 11,
      migration_id = 'pg-0012-task-trigger-definitions',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_recovery":1,"cluster_recovery_claim":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_session":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 10
    AND migration_id = 'pg-0011-api-credential-pepper-binding'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_recovery":1,"cluster_recovery_claim":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"worker_attestation":1,"worker_credential":1,"worker_session":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 10'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
