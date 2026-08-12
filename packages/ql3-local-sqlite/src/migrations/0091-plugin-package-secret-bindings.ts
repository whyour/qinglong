import { defineLocalSqliteMigration } from './sqlMigration';

export const local0091PluginPackageSecretBindingsMigration =
  defineLocalSqliteMigration({
    id: '0091-plugin-package-secret-bindings',
    statements: [
      `
CREATE TABLE "QingLong3PluginPackageSecretBindings" (
  generation_digest TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  lock_digest TEXT NOT NULL,
  generation INTEGER NOT NULL,
  manifest_digest TEXT NOT NULL,
  authority_kind TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  bound_at_ms INTEGER NOT NULL,
  binding_digest TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  CONSTRAINT ql3_plugin_package_secret_binding_project_fk
    FOREIGN KEY (project_id) REFERENCES "QingLong3Projects" (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_secret_binding_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "QingLong3PluginPackageInstalls" (installation_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_secret_binding_identity_check CHECK (
    length(project_id) BETWEEN 1 AND 128 AND
    length(package_name) BETWEEN 1 AND 63 AND
    length(installation_id) BETWEEN 1 AND 128 AND
    generation BETWEEN 1 AND 2147483647 AND
    authority_kind IN ('approved-action-execution','local-owner-confirmation') AND
    bound_at_ms >= 0
  ),
  CONSTRAINT ql3_plugin_package_secret_binding_digest_check CHECK (
    length(generation_digest) = 64 AND generation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(lock_digest) = 64 AND lock_digest NOT GLOB '*[^0-9a-f]*' AND
    length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*' AND
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*' AND
    length(binding_digest) = 64 AND binding_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_plugin_package_secret_binding_json_check CHECK (
    length(CAST(binding_json AS BLOB)) BETWEEN 2 AND 65536 AND
    json_valid(binding_json) AND json_type(binding_json) = 'object' AND
    json_extract(binding_json, '$.schema') = 'qinglong/plugin-package-secret-binding@v1' AND
    json_extract(binding_json, '$.target.generationDigest') = generation_digest AND
    json_extract(binding_json, '$.target.projectId') = project_id AND
    json_extract(binding_json, '$.target.packageName') = package_name AND
    json_extract(binding_json, '$.target.installationId') = installation_id AND
    json_extract(binding_json, '$.target.lockDigest') = lock_digest AND
    json_extract(binding_json, '$.target.generation') = generation AND
    json_extract(binding_json, '$.target.manifestDigest') = manifest_digest AND
    json_extract(binding_json, '$.authority.kind') = authority_kind AND
    json_extract(binding_json, '$.authority.evidenceDigest') = evidence_digest AND
    json_extract(binding_json, '$.boundAtMs') = bound_at_ms AND
    json_extract(binding_json, '$.bindingDigest') = binding_digest AND
    json_type(binding_json, '$.entries') = 'array' AND
    json_array_length(json_extract(binding_json, '$.entries')) BETWEEN 1 AND 64
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_secret_binding_generation_uidx ON "QingLong3PluginPackageSecretBindings" (project_id, package_name, generation)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_secret_binding_digest_uidx ON "QingLong3PluginPackageSecretBindings" (binding_digest)`,
      `CREATE INDEX ql3_plugin_package_secret_binding_install_idx ON "QingLong3PluginPackageSecretBindings" (installation_id, generation_digest)`,
    ],
  });
