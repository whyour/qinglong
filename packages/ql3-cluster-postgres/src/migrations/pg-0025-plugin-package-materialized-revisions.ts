import { definePostgresSqlMigration } from './sqlMigration';

const CAPABILITIES_V23 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_proposal":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';
const CAPABILITIES_V24 =
  '{"api_credential":1,"api_credential_admin":1,"api_credential_pepper_binding":1,"approved_action":1,"approved_action_execution":1,"cluster_execution_revision":1,"cluster_recovery":1,"cluster_recovery_claim":1,"cluster_scheduler_admission":1,"database_role_grants":1,"identity_admin":1,"plugin_package_admission":1,"plugin_package_authority_split":1,"plugin_package_identity_keyset_ledger":1,"plugin_package_install":1,"plugin_package_management_quota":1,"plugin_package_materialized_revision":1,"plugin_package_proposal":1,"project_policy":1,"run_core":1,"run_dispatch_lease":1,"run_retry_policy":1,"security_audit":1,"security_audit_query":1,"task_definition":1,"trigger_definition":1,"worker_attestation":1,"worker_credential":1,"worker_credential_delivery":1,"worker_credential_stage_discard":1,"worker_session":1}';

export const pg0025PluginPackageMaterializedRevisionsMigration =
  definePostgresSqlMigration({
    id: 'pg-0025-plugin-package-materialized-revisions',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_materialized_revisions" (
  generation_digest char(64) NOT NULL,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  generation integer NOT NULL,
  lock_digest char(64) NOT NULL,
  manifest_digest char(64) NOT NULL,
  revision_digest char(64) NOT NULL,
  revision_json jsonb NOT NULL,
  created_at_ms bigint NOT NULL,
  CONSTRAINT plugin_package_materialized_revisions_pkey
    PRIMARY KEY (generation_digest),
  CONSTRAINT ql3_plugin_package_materialized_revision_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_materialized_revision_identity_check CHECK (
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    generation BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_plugin_package_materialized_revision_digest_check CHECK (
    generation_digest ~ '^[0-9a-f]{64}$' AND
    lock_digest ~ '^[0-9a-f]{64}$' AND
    manifest_digest ~ '^[0-9a-f]{64}$' AND
    revision_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_materialized_revision_json_check CHECK (
    jsonb_typeof(revision_json) = 'object' AND
    octet_length(revision_json::text) BETWEEN 2 AND 25165824 AND
    revision_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-materialized-revision@v1',
      'generation', jsonb_build_object(
        'generationDigest', generation_digest,
        'projectId', project_id,
        'packageName', package_name,
        'generation', generation,
        'lockDigest', lock_digest
      ),
      'manifestDigest', manifest_digest,
      'revisionDigest', revision_digest
    )
  ),
  CONSTRAINT ql3_plugin_package_materialized_revision_time_check CHECK (
    created_at_ms >= 0
  )
)
      `.trim(),
      `
CREATE UNIQUE INDEX ql3_plugin_package_materialized_revision_generation_uidx
ON "ql3"."plugin_package_materialized_revisions"
  (project_id, package_name, generation)
      `.trim(),
      `
CREATE INDEX ql3_plugin_package_materialized_revision_lock_idx
ON "ql3"."plugin_package_materialized_revisions"
  (lock_digest, generation_digest)
      `.trim(),
      `
REVOKE ALL
ON "ql3"."plugin_package_materialized_revisions"
FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager,
     ql3_worker_ingress
      `.trim(),
      `
GRANT SELECT, INSERT
ON "ql3"."plugin_package_materialized_revisions"
TO ql3_package_executor
      `.trim(),
      `
DO $ql3$
BEGIN
  UPDATE "ql3"."schema_capabilities"
  SET contract_version = 24,
      migration_id = 'pg-0025-plugin-package-materialized-revisions',
      capabilities = '${CAPABILITIES_V24}'::jsonb,
      updated_at_ms = floor(
        extract(epoch FROM transaction_timestamp()) * 1000
      )::bigint
  WHERE contract_name = 'control-core'
    AND contract_version = 23
    AND migration_id = 'pg-0024-plugin-package-identity-keyset-ledger'
    AND capabilities = '${CAPABILITIES_V23}'::jsonb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'control-core capability is not at version 23'
      USING ERRCODE = 'check_violation';
  END IF;
END
$ql3$
      `.trim(),
    ],
  });
