import { defineLocalSqliteMigration } from './sqlMigration';

export const local0049ProjectToolDefinitionSnapshotsMigration =
  defineLocalSqliteMigration({
    id: '0049-project-tool-definition-snapshots',
    statements: [
      `
CREATE UNIQUE INDEX ql3_plugin_package_installs_snapshot_source_uidx
ON "QingLong3PluginPackageInstalls" (
  project_id, package_name, installation_id, target_generation, lock_digest
)
      `,
      `
CREATE UNIQUE INDEX ql3_plugin_package_materialized_revision_snapshot_source_uidx
ON "QingLong3PluginPackageMaterializedRevisions" (
  project_id, package_name, generation, generation_digest,
  lock_digest, revision_digest
)
      `,
      `
CREATE TABLE "QingLong3ProjectToolDefinitionSnapshots" (
  project_id TEXT NOT NULL,
  active_vector_digest TEXT NOT NULL,
  definitions_digest TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (project_id, active_vector_digest),
  CONSTRAINT ql3_project_tool_definition_snapshot_project_fk
    FOREIGN KEY (project_id) REFERENCES "QingLong3Projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_project_tool_definition_snapshot_identity_check CHECK (
    length(project_id) BETWEEN 1 AND 128
  ),
  CONSTRAINT ql3_project_tool_definition_snapshot_digest_check CHECK (
    length(active_vector_digest) = 64 AND
      active_vector_digest NOT GLOB '*[^0-9a-f]*' AND
    length(definitions_digest) = 64 AND
      definitions_digest NOT GLOB '*[^0-9a-f]*' AND
    length(snapshot_digest) = 64 AND
      snapshot_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_project_tool_definition_snapshot_json_check CHECK (
    length(snapshot_json) BETWEEN 2 AND 8388608 AND
    json_valid(snapshot_json) AND json_type(snapshot_json) = 'object' AND
    json_extract(snapshot_json, '$.schema') =
      'qinglong/project-tool-definition-snapshot@v1' AND
    json_extract(snapshot_json, '$.projectId') = project_id AND
    json_extract(snapshot_json, '$.activeVectorDigest') =
      active_vector_digest AND
    json_extract(snapshot_json, '$.definitionsDigest') =
      definitions_digest AND
    json_extract(snapshot_json, '$.snapshotDigest') = snapshot_digest
  ),
  CONSTRAINT ql3_project_tool_definition_snapshot_time_check CHECK (
    committed_at_ms >= 0
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_project_tool_definition_snapshot_digest_uidx ON "QingLong3ProjectToolDefinitionSnapshots" (snapshot_digest)`,
      `CREATE INDEX ql3_project_tool_definition_snapshot_current_idx ON "QingLong3ProjectToolDefinitionSnapshots" (project_id, committed_at_ms DESC, active_vector_digest)`,
      `
CREATE TABLE "QingLong3ProjectToolDefinitionSnapshotSources" (
  project_id TEXT NOT NULL,
  active_vector_digest TEXT NOT NULL,
  package_name TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  generation_digest TEXT NOT NULL,
  lock_digest TEXT NOT NULL,
  revision_digest TEXT NOT NULL,
  PRIMARY KEY (project_id, active_vector_digest, package_name),
  CONSTRAINT ql3_project_tool_definition_snapshot_source_snapshot_fk
    FOREIGN KEY (project_id, active_vector_digest)
    REFERENCES "QingLong3ProjectToolDefinitionSnapshots" (
      project_id, active_vector_digest
    )
    ON DELETE RESTRICT,
  CONSTRAINT ql3_project_tool_definition_snapshot_source_install_fk
    FOREIGN KEY (
      project_id, package_name, installation_id, generation, lock_digest
    )
    REFERENCES "QingLong3PluginPackageInstalls" (
      project_id, package_name, installation_id, target_generation, lock_digest
    )
    ON DELETE RESTRICT,
  CONSTRAINT ql3_project_tool_definition_snapshot_source_revision_fk
    FOREIGN KEY (
      project_id, package_name, generation, generation_digest,
      lock_digest, revision_digest
    )
    REFERENCES "QingLong3PluginPackageMaterializedRevisions" (
      project_id, package_name, generation, generation_digest,
      lock_digest, revision_digest
    )
    ON DELETE RESTRICT,
  CONSTRAINT ql3_project_tool_definition_snapshot_source_identity_check
    CHECK (
      length(package_name) BETWEEN 1 AND 63 AND
      length(installation_id) BETWEEN 1 AND 128 AND
      generation BETWEEN 1 AND 2147483647
    ),
  CONSTRAINT ql3_project_tool_definition_snapshot_source_digest_check CHECK (
    length(active_vector_digest) = 64 AND
      active_vector_digest NOT GLOB '*[^0-9a-f]*' AND
    length(generation_digest) = 64 AND
      generation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(lock_digest) = 64 AND
      lock_digest NOT GLOB '*[^0-9a-f]*' AND
    length(revision_digest) = 64 AND
      revision_digest NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `CREATE INDEX ql3_project_tool_definition_snapshot_source_generation_idx ON "QingLong3ProjectToolDefinitionSnapshotSources" (generation_digest, project_id, package_name)`,
      `CREATE INDEX ql3_project_tool_definition_snapshot_source_install_idx ON "QingLong3ProjectToolDefinitionSnapshotSources" (installation_id, active_vector_digest)`,
    ],
  });
