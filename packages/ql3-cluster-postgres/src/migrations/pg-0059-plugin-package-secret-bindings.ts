import { CAPABILITIES_V57 } from './pg-0058-plugin-package-automation-disposition-events';
import { definePostgresSqlMigration } from './sqlMigration';

export const CAPABILITIES_V58 = CAPABILITIES_V57.replace(
  '"plugin_package_task_reconciliation":1,',
  '"plugin_package_secret_binding":1,"plugin_package_task_reconciliation":1,',
);

export const pg0059PluginPackageSecretBindingsMigration =
  definePostgresSqlMigration({
    id: 'pg-0059-plugin-package-secret-bindings',
    statements: [
      `
CREATE TABLE "ql3"."plugin_package_secret_bindings" (
  generation_digest char(64) PRIMARY KEY,
  project_id varchar(128) NOT NULL,
  package_name varchar(63) NOT NULL,
  installation_id varchar(128) NOT NULL,
  lock_digest char(64) NOT NULL,
  generation integer NOT NULL,
  manifest_digest char(64) NOT NULL,
  authority_kind varchar(32) NOT NULL,
  evidence_digest char(64) NOT NULL,
  bound_at_ms bigint NOT NULL,
  binding_digest char(64) NOT NULL,
  binding_json jsonb NOT NULL,
  CONSTRAINT ql3_plugin_package_secret_binding_project_fk
    FOREIGN KEY (project_id) REFERENCES "ql3"."projects" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_secret_binding_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "ql3"."plugin_package_installs" (installation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_secret_binding_identity_check CHECK (
    project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    package_name ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' AND
    installation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND
    generation BETWEEN 1 AND 2147483647 AND
    authority_kind IN ('approved-action-execution','local-owner-confirmation') AND
    bound_at_ms >= 0
  ),
  CONSTRAINT ql3_plugin_package_secret_binding_digest_check CHECK (
    generation_digest ~ '^[0-9a-f]{64}$' AND
    lock_digest ~ '^[0-9a-f]{64}$' AND
    manifest_digest ~ '^[0-9a-f]{64}$' AND
    evidence_digest ~ '^[0-9a-f]{64}$' AND
    binding_digest ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ql3_plugin_package_secret_binding_json_check CHECK (
    jsonb_typeof(binding_json) = 'object' AND
    octet_length(binding_json::text) BETWEEN 2 AND 65536 AND
    binding_json @> jsonb_build_object(
      'schema', 'qinglong/plugin-package-secret-binding@v1',
      'target', jsonb_build_object(
        'generationDigest', generation_digest,
        'projectId', project_id,
        'packageName', package_name,
        'installationId', installation_id,
        'lockDigest', lock_digest,
        'generation', generation,
        'manifestDigest', manifest_digest
      ),
      'authority', jsonb_build_object(
        'kind', authority_kind,
        'evidenceDigest', evidence_digest
      ),
      'boundAtMs', bound_at_ms,
      'bindingDigest', binding_digest
    ) AND
    jsonb_typeof(binding_json -> 'entries') = 'array' AND
    jsonb_array_length(binding_json -> 'entries') BETWEEN 1 AND 64
  )
)
      `.trim(),
      `CREATE UNIQUE INDEX ql3_plugin_package_secret_binding_generation_uidx ON "ql3"."plugin_package_secret_bindings" (project_id, package_name, generation)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_secret_binding_digest_uidx ON "ql3"."plugin_package_secret_bindings" (binding_digest)`,
      `CREATE INDEX ql3_plugin_package_secret_binding_install_idx ON "ql3"."plugin_package_secret_bindings" (installation_id, generation_digest)`,
      `REVOKE ALL ON "ql3"."plugin_package_secret_bindings" FROM PUBLIC, ql3_runtime, ql3_admin, ql3_package_manager, ql3_package_executor, ql3_worker_ingress`,
      `GRANT SELECT, INSERT ON "ql3"."plugin_package_secret_bindings" TO ql3_package_executor`,
      `DO $ql3$ BEGIN UPDATE "ql3"."schema_capabilities" SET contract_version = 58, migration_id = 'pg-0059-plugin-package-secret-bindings', capabilities = '${CAPABILITIES_V58}'::jsonb, updated_at_ms = floor(extract(epoch FROM transaction_timestamp()) * 1000)::bigint WHERE contract_name = 'control-core' AND contract_version = 57 AND migration_id = 'pg-0058-plugin-package-automation-disposition-events' AND capabilities = '${CAPABILITIES_V57}'::jsonb; IF NOT FOUND THEN RAISE EXCEPTION 'control-core capability is not at version 57' USING ERRCODE = 'check_violation'; END IF; END $ql3$`,
    ],
  });
