import { definePostgresSqlMigration } from './sqlMigration';

export const POSTGRESQL_PROJECT_TABLE = 'projects';
export const POSTGRESQL_PROJECT_ROLE_BINDING_TABLE = 'project_role_bindings';

export const pg0004ProjectPolicyMigration = definePostgresSqlMigration({
  id: 'pg-0004-project-policy',
  statements: [
    `
CREATE TABLE "ql3"."${POSTGRESQL_PROJECT_TABLE}" (
  id varchar(128) PRIMARY KEY
    CONSTRAINT ql3_projects_id_check CHECK (char_length(id) >= 1),
  name varchar(255) NOT NULL
    CONSTRAINT ql3_projects_name_check CHECK (char_length(name) >= 1),
  slug varchar(128) NOT NULL
    CONSTRAINT ql3_projects_slug_check
    CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$'),
  status varchar(16) NOT NULL
    CONSTRAINT ql3_projects_status_check
    CHECK (status IN ('active', 'archived')),
  version integer NOT NULL
    CONSTRAINT ql3_projects_version_check
    CHECK (version BETWEEN 1 AND 2147483647),
  created_at_ms bigint NOT NULL
    CONSTRAINT ql3_projects_created_at_check CHECK (created_at_ms >= 0),
  updated_at_ms bigint NOT NULL
    CONSTRAINT ql3_projects_updated_at_check
    CHECK (updated_at_ms >= created_at_ms)
)
    `.trim(),
    `
CREATE UNIQUE INDEX ql3_projects_slug_uidx
ON "ql3"."${POSTGRESQL_PROJECT_TABLE}" (slug)
    `.trim(),
    `
INSERT INTO "ql3"."${POSTGRESQL_PROJECT_TABLE}" (
  id, name, slug, status, version, created_at_ms, updated_at_ms
)
VALUES ('default', 'Default', 'default', 'active', 1, 0, 0)
    `.trim(),
    `
CREATE TABLE "ql3"."${POSTGRESQL_PROJECT_ROLE_BINDING_TABLE}" (
  project_id varchar(128) NOT NULL,
  subject_type varchar(32) NOT NULL
    CONSTRAINT ql3_project_role_bindings_subject_type_check
    CHECK (subject_type IN ('user', 'api_app', 'mcp_client', 'agent', 'system', 'worker')),
  subject_id varchar(255) NOT NULL
    CONSTRAINT ql3_project_role_bindings_subject_id_check
    CHECK (char_length(subject_id) >= 1),
  version integer NOT NULL
    CONSTRAINT ql3_project_role_bindings_version_check
    CHECK (version BETWEEN 1 AND 2147483647),
  state varchar(16) NOT NULL
    CONSTRAINT ql3_project_role_bindings_state_check
    CHECK (state IN ('active', 'revoked')),
  role varchar(16),
  mutation_id varchar(64) NOT NULL
    CONSTRAINT ql3_project_role_bindings_mutation_id_check
    CHECK (mutation_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  changed_by_type varchar(32) NOT NULL
    CONSTRAINT ql3_project_role_bindings_changed_by_type_check
    CHECK (changed_by_type IN ('user', 'api_app', 'mcp_client', 'agent', 'system', 'worker')),
  changed_by_id varchar(255) NOT NULL
    CONSTRAINT ql3_project_role_bindings_changed_by_id_check
    CHECK (char_length(changed_by_id) >= 1),
  created_at_ms bigint NOT NULL
    CONSTRAINT ql3_project_role_bindings_created_at_check
    CHECK (created_at_ms >= 0),
  CONSTRAINT project_role_bindings_pkey
    PRIMARY KEY (project_id, subject_type, subject_id, version),
  CONSTRAINT ql3_project_role_bindings_role_state_check
    CHECK (
      (state = 'active' AND role IN ('owner', 'admin', 'operator', 'viewer'))
      OR (state = 'revoked' AND role IS NULL)
    ),
  CONSTRAINT ql3_project_role_bindings_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."${POSTGRESQL_PROJECT_TABLE}" (id)
    ON DELETE CASCADE
)
    `.trim(),
    `
CREATE INDEX ql3_project_role_bindings_current_idx
ON "ql3"."${POSTGRESQL_PROJECT_ROLE_BINDING_TABLE}"
  (project_id, subject_type, subject_id, version DESC)
    `.trim(),
    `
CREATE UNIQUE INDEX ql3_project_role_bindings_mutation_uidx
ON "ql3"."${POSTGRESQL_PROJECT_ROLE_BINDING_TABLE}"
  (project_id, mutation_id)
    `.trim(),
    `
CREATE INDEX ql3_project_role_bindings_subject_idx
ON "ql3"."${POSTGRESQL_PROJECT_ROLE_BINDING_TABLE}"
  (subject_type, subject_id, project_id, version DESC)
    `.trim(),
    `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 3,
      migration_id = 'pg-0004-project-policy',
      capabilities = '{"project_policy":1,"run_core":1,"run_retry_policy":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 2
    AND migration_id = 'pg-0003-run-retry-policy'
    AND capabilities = '{"run_core":1,"run_retry_policy":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 2'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
    `.trim(),
  ],
});
