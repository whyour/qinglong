import { defineLocalSqliteMigration } from './sqlMigration';

export const local0045PluginPackageMaterializedRevisionsMigration =
  defineLocalSqliteMigration({
    id: '0045-plugin-package-materialized-revisions',
    statements: [
      `
CREATE TABLE "QingLong3PluginPackageMaterializedRevisions" (
  generation_digest TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  generation INTEGER NOT NULL,
  lock_digest TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  revision_digest TEXT NOT NULL,
  revision_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  CONSTRAINT ql3_plugin_package_materialized_revision_project_fk
    FOREIGN KEY (project_id) REFERENCES "QingLong3Projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_materialized_revision_identity_check CHECK (
    length(package_name) BETWEEN 1 AND 63 AND
    generation BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_plugin_package_materialized_revision_digest_check CHECK (
    length(generation_digest) = 64 AND
      generation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(lock_digest) = 64 AND
      lock_digest NOT GLOB '*[^0-9a-f]*' AND
    length(manifest_digest) = 64 AND
      manifest_digest NOT GLOB '*[^0-9a-f]*' AND
    length(revision_digest) = 64 AND
      revision_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_plugin_package_materialized_revision_json_check CHECK (
    length(revision_json) BETWEEN 2 AND 25165824 AND
    json_valid(revision_json) AND json_type(revision_json) = 'object' AND
    json_extract(revision_json, '$.schema') =
      'qinglong/plugin-package-materialized-revision@v1' AND
    json_extract(revision_json, '$.generation.generationDigest') =
      generation_digest AND
    json_extract(revision_json, '$.generation.projectId') = project_id AND
    json_extract(revision_json, '$.generation.packageName') = package_name AND
    json_extract(revision_json, '$.generation.generation') = generation AND
    json_extract(revision_json, '$.generation.lockDigest') = lock_digest AND
    json_extract(revision_json, '$.manifestDigest') = manifest_digest AND
    json_extract(revision_json, '$.revisionDigest') = revision_digest
  ),
  CONSTRAINT ql3_plugin_package_materialized_revision_time_check CHECK (
    created_at_ms >= 0
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_materialized_revision_generation_uidx ON "QingLong3PluginPackageMaterializedRevisions" (project_id, package_name, generation)`,
      `CREATE INDEX ql3_plugin_package_materialized_revision_lock_idx ON "QingLong3PluginPackageMaterializedRevisions" (lock_digest, generation_digest)`,
    ],
  });
