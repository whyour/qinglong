import { definePostgresSqlMigration } from './sqlMigration';

export const pg0018PluginPackageInstallsMigration = definePostgresSqlMigration({
  id: 'pg-0018-plugin-package-installs',
  statements: [
    `
CREATE TABLE "ql3"."plugin_package_installs" (
  installation_id varchar(128) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  package_version varchar(128) NOT NULL,
  operation varchar(16) NOT NULL,
  lock_digest char(64) NOT NULL,
  target_generation integer NOT NULL,
  previous_active_lock_digest char(64),
  active_lock_digest char(64),
  state varchar(16) NOT NULL,
  version integer NOT NULL,
  last_mutation_id varchar(128) NOT NULL,
  last_mutation_digest char(64) NOT NULL,
  lock_json jsonb NOT NULL,
  record_json jsonb NOT NULL,
  record_digest char(64) NOT NULL,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT ql3_plugin_package_installs_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_installs_identity_check CHECK (
    installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    AND char_length(package_version) BETWEEN 1 AND 128
    AND last_mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_plugin_package_installs_operation_check CHECK (
    operation IN ('install', 'reinstall', 'upgrade', 'rollback')
  ),
  CONSTRAINT ql3_plugin_package_installs_state_check CHECK (
    state IN ('queued', 'staged', 'activating', 'active', 'failed')
  ),
  CONSTRAINT ql3_plugin_package_installs_version_check CHECK (
    target_generation BETWEEN 1 AND 2147483647
    AND version BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_plugin_package_installs_digest_check CHECK (
    lock_digest ~ '^[0-9a-f]{64}$'
    AND (
      previous_active_lock_digest IS NULL
      OR previous_active_lock_digest ~ '^[0-9a-f]{64}$'
    )
    AND (
      active_lock_digest IS NULL
      OR active_lock_digest ~ '^[0-9a-f]{64}$'
    )
    AND last_mutation_digest ~ '^[0-9a-f]{64}$'
    AND record_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_installs_record_check CHECK (
    jsonb_typeof(lock_json) = 'object'
    AND octet_length(lock_json::text) BETWEEN 2 AND 262144
    AND lock_json @> jsonb_build_object(
      'lockDigest', lock_digest,
      'projectId', project_id,
      'packageName', package_name
    )
    AND jsonb_typeof(record_json) = 'object'
    AND octet_length(record_json::text) BETWEEN 2 AND 262144
    AND record_json @> jsonb_build_object(
      'installationId', installation_id,
      'projectId', project_id,
      'packageName', package_name,
      'lockDigest', lock_digest,
      'state', state,
      'version', version,
      'recordDigest', record_digest
    )
  ),
  CONSTRAINT ql3_plugin_package_installs_time_check CHECK (
    created_at_ms >= 0
    AND updated_at_ms >= created_at_ms
  )
)
      `.trim(),
    `
CREATE TABLE "ql3"."plugin_package_install_heads" (
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  CONSTRAINT plugin_package_install_heads_pkey
    PRIMARY KEY (project_id, package_name),
  CONSTRAINT ql3_plugin_package_install_heads_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_install_heads_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "ql3"."plugin_package_installs" (installation_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_install_heads_identity_check CHECK (
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
    AND installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  )
)
      `.trim(),
    `
CREATE UNIQUE INDEX ql3_plugin_package_install_heads_install_uidx
ON "ql3"."plugin_package_install_heads" (installation_id)
      `.trim(),
    `
CREATE TABLE "ql3"."plugin_package_install_mutations" (
  installation_id varchar(128) NOT NULL,
  mutation_id varchar(128) NOT NULL,
  mutation_digest char(64) NOT NULL,
  resulting_record_digest char(64) NOT NULL,
  occurred_at_ms bigint NOT NULL,
  CONSTRAINT plugin_package_install_mutations_pkey
    PRIMARY KEY (installation_id, mutation_id),
  CONSTRAINT ql3_plugin_package_install_mutations_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "ql3"."plugin_package_installs" (installation_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_install_mutations_identity_check CHECK (
    mutation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT ql3_plugin_package_install_mutations_digest_check CHECK (
    mutation_digest ~ '^[0-9a-f]{64}$'
    AND resulting_record_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_install_mutations_time_check CHECK (
    occurred_at_ms >= 0
  )
)
      `.trim(),
    `
CREATE INDEX ql3_plugin_package_installs_recovery_idx
ON "ql3"."plugin_package_installs" (state, package_name, installation_id)
WHERE state IN ('queued', 'staged', 'activating')
      `.trim(),
    `
CREATE INDEX ql3_plugin_package_installs_project_history_idx
ON "ql3"."plugin_package_installs"
  (project_id, package_name, created_at_ms, installation_id)
      `.trim(),
    `
CREATE INDEX ql3_plugin_package_install_mutations_result_idx
ON "ql3"."plugin_package_install_mutations"
  (installation_id, resulting_record_digest)
      `.trim(),
    `
CREATE FUNCTION "ql3"."lock_active_plugin_package_project"(varchar)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, ql3
AS $ql3$
DECLARE
  project_is_active boolean;
BEGIN
  SELECT projects.status = 'active'
  INTO project_is_active
  FROM "ql3"."projects" AS projects
  WHERE projects.id = $1
  FOR SHARE;

  RETURN COALESCE(project_is_active, false);
END
$ql3$
      `.trim(),
    `
REVOKE ALL
ON FUNCTION "ql3"."lock_active_plugin_package_project"(varchar)
FROM PUBLIC
      `.trim(),
    `
GRANT EXECUTE
ON FUNCTION "ql3"."lock_active_plugin_package_project"(varchar)
TO ql3_admin
      `.trim(),
    `
GRANT SELECT, INSERT, UPDATE
ON "ql3"."plugin_package_installs", "ql3"."plugin_package_install_heads"
TO ql3_admin
      `.trim(),
    `
GRANT SELECT, INSERT
ON "ql3"."plugin_package_install_mutations"
TO ql3_admin
      `.trim(),
    `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 17,
      migration_id = 'pg-0018-plugin-package-installs',
      capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_install":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 16
    AND migration_id = 'pg-0017-database-role-grants'
    AND capabilities = '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 16'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
  ],
});
