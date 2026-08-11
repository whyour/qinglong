import { defineLocalSqliteMigration } from './sqlMigration';

export const local0037PluginPackageInstallsMigration =
  defineLocalSqliteMigration({
    id: '0037-plugin-package-installs',
    statements: [
      `
CREATE TABLE "QingLong3PluginPackageInstalls" (
  installation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  package_version TEXT NOT NULL,
  operation TEXT NOT NULL,
  lock_digest TEXT NOT NULL,
  target_generation INTEGER NOT NULL,
  previous_active_lock_digest TEXT,
  active_lock_digest TEXT,
  state TEXT NOT NULL,
  version INTEGER NOT NULL,
  last_mutation_id TEXT NOT NULL,
  last_mutation_digest TEXT NOT NULL,
  lock_json TEXT NOT NULL,
  record_json TEXT NOT NULL,
  record_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CONSTRAINT ql3_plugin_package_installs_project_fk
    FOREIGN KEY (project_id) REFERENCES "QingLong3Projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_installs_identity_check CHECK (
    length(installation_id) BETWEEN 1 AND 128 AND
    length(package_name) BETWEEN 1 AND 253 AND
    length(package_version) BETWEEN 1 AND 128 AND
    length(last_mutation_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_plugin_package_installs_operation_check
    CHECK (operation IN ('install','reinstall','upgrade','rollback')),
  CONSTRAINT ql3_plugin_package_installs_state_check
    CHECK (state IN ('queued','staged','activating','active','failed')),
  CONSTRAINT ql3_plugin_package_installs_version_check CHECK (
    target_generation BETWEEN 1 AND 2147483647 AND
    version BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_plugin_package_installs_digest_check CHECK (
    length(lock_digest) = 64 AND lock_digest NOT GLOB '*[^0-9a-f]*' AND
    (previous_active_lock_digest IS NULL OR
      (length(previous_active_lock_digest) = 64 AND
       previous_active_lock_digest NOT GLOB '*[^0-9a-f]*')) AND
    (active_lock_digest IS NULL OR
      (length(active_lock_digest) = 64 AND
       active_lock_digest NOT GLOB '*[^0-9a-f]*')) AND
    length(last_mutation_digest) = 64 AND
      last_mutation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(record_digest) = 64 AND record_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_plugin_package_installs_record_check CHECK (
    length(lock_json) BETWEEN 2 AND 262144 AND
    json_valid(lock_json) AND json_type(lock_json) = 'object' AND
    json_extract(lock_json, '$.lockDigest') = lock_digest AND
    json_extract(lock_json, '$.projectId') = project_id AND
    json_extract(lock_json, '$.packageName') = package_name AND
    length(record_json) BETWEEN 2 AND 262144 AND
    json_valid(record_json) AND json_type(record_json) = 'object' AND
    json_extract(record_json, '$.installationId') = installation_id AND
    json_extract(record_json, '$.projectId') = project_id AND
    json_extract(record_json, '$.packageName') = package_name AND
    json_extract(record_json, '$.lockDigest') = lock_digest AND
    json_extract(record_json, '$.state') = state AND
    json_extract(record_json, '$.version') = version AND
    json_extract(record_json, '$.recordDigest') = record_digest
  ),
  CONSTRAINT ql3_plugin_package_installs_time_check CHECK (
    created_at_ms >= 0 AND updated_at_ms >= created_at_ms
  )
)
      `,
      `
CREATE TABLE "QingLong3PluginPackageInstallHeads" (
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  PRIMARY KEY (project_id, package_name),
  CONSTRAINT ql3_plugin_package_install_heads_project_fk
    FOREIGN KEY (project_id) REFERENCES "QingLong3Projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_install_heads_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "QingLong3PluginPackageInstalls" (installation_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_install_heads_identity_check CHECK (
    length(package_name) BETWEEN 1 AND 253 AND
    length(installation_id) BETWEEN 1 AND 128
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_install_heads_install_uidx ON "QingLong3PluginPackageInstallHeads" (installation_id)`,
      `
CREATE TABLE "QingLong3PluginPackageInstallMutations" (
  installation_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  mutation_digest TEXT NOT NULL,
  resulting_record_digest TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  PRIMARY KEY (installation_id, mutation_id),
  CONSTRAINT ql3_plugin_package_install_mutations_install_fk
    FOREIGN KEY (installation_id)
    REFERENCES "QingLong3PluginPackageInstalls" (installation_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_install_mutations_identity_check
    CHECK (length(mutation_id) BETWEEN 1 AND 128),
  CONSTRAINT ql3_plugin_package_install_mutations_digest_check CHECK (
    length(mutation_digest) = 64 AND
      mutation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(resulting_record_digest) = 64 AND
      resulting_record_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_plugin_package_install_mutations_time_check
    CHECK (occurred_at_ms >= 0)
)
      `,
      `CREATE INDEX ql3_plugin_package_installs_recovery_idx ON "QingLong3PluginPackageInstalls" (state, package_name, installation_id) WHERE state IN ('queued','staged','activating')`,
      `CREATE INDEX ql3_plugin_package_installs_project_history_idx ON "QingLong3PluginPackageInstalls" (project_id, package_name, created_at_ms, installation_id)`,
      `CREATE INDEX ql3_plugin_package_install_mutations_result_idx ON "QingLong3PluginPackageInstallMutations" (installation_id, resulting_record_digest)`,
    ],
  });
