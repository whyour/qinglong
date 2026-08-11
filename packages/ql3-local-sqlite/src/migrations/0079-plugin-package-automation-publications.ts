import { defineLocalSqliteMigration } from './sqlMigration';

export const local0079PluginPackageAutomationPublicationsMigration =
  defineLocalSqliteMigration({
    id: '0079-plugin-package-automation-publications',
    statements: [
      `
CREATE TABLE "QingLong3PluginPackageAutomationPublications" (
  publication_digest TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  lock_digest TEXT NOT NULL,
  generation INTEGER NOT NULL,
  generation_digest TEXT NOT NULL,
  materialized_revision_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL,
  previous_publication_digest TEXT,
  lifecycle_event_digest TEXT,
  published_at_ms INTEGER NOT NULL,
  publication_json TEXT NOT NULL,
  CONSTRAINT ql3_plugin_package_automation_publication_revision_fk
    FOREIGN KEY (generation_digest)
    REFERENCES "QingLong3PluginPackageMaterializedRevisions" (
      generation_digest
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_automation_publication_previous_fk
    FOREIGN KEY (previous_publication_digest)
    REFERENCES "QingLong3PluginPackageAutomationPublications" (
      publication_digest
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_automation_publication_lifecycle_fk
    FOREIGN KEY (lifecycle_event_digest)
    REFERENCES "QingLong3PluginPackageLifecycleEvents" (event_digest)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_automation_publication_identity_check CHECK (
    length(project_id) BETWEEN 1 AND 128 AND
    length(package_name) BETWEEN 1 AND 63 AND
    length(installation_id) BETWEEN 1 AND 128 AND
    generation BETWEEN 1 AND 2147483647 AND
    state IN ('active','withdrawn','absent') AND
    version BETWEEN 1 AND 2147483647 AND
    published_at_ms >= 0 AND
    (
      version = 1 AND state IN ('active','absent') AND
      previous_publication_digest IS NULL AND
      lifecycle_event_digest IS NULL
      OR
      version > 1 AND previous_publication_digest IS NOT NULL
    ) AND
    (state <> 'withdrawn' OR lifecycle_event_digest IS NOT NULL)
  ),
  CONSTRAINT ql3_plugin_package_automation_publication_digest_check CHECK (
    length(publication_digest) = 64 AND
      publication_digest NOT GLOB '*[^0-9a-f]*' AND
    length(lock_digest) = 64 AND
      lock_digest NOT GLOB '*[^0-9a-f]*' AND
    length(generation_digest) = 64 AND
      generation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(materialized_revision_digest) = 64 AND
      materialized_revision_digest NOT GLOB '*[^0-9a-f]*' AND
    (
      previous_publication_digest IS NULL OR
      length(previous_publication_digest) = 64 AND
        previous_publication_digest NOT GLOB '*[^0-9a-f]*'
    ) AND
    (
      lifecycle_event_digest IS NULL OR
      length(lifecycle_event_digest) = 64 AND
        lifecycle_event_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CONSTRAINT ql3_plugin_package_automation_publication_json_check CHECK (
    length(CAST(publication_json AS BLOB)) BETWEEN 2 AND 12582912 AND
    json_valid(publication_json) AND
    json_type(publication_json) = 'object' AND
    json_extract(publication_json, '$.schema') =
      'qinglong/plugin-package-automation-publication@v1' AND
    json_extract(publication_json, '$.target.projectId') = project_id AND
    json_extract(publication_json, '$.target.packageName') = package_name AND
    json_extract(publication_json, '$.target.installationId') =
      installation_id AND
    json_extract(publication_json, '$.target.lockDigest') = lock_digest AND
    json_extract(publication_json, '$.target.generation') = generation AND
    json_extract(publication_json, '$.target.generationDigest') =
      generation_digest AND
    json_extract(publication_json, '$.target.materializedRevisionDigest') =
      materialized_revision_digest AND
    json_extract(publication_json, '$.state') = state AND
    json_extract(publication_json, '$.version') = version AND
    (
      previous_publication_digest IS NULL AND
      json_type(publication_json, '$.previousPublicationDigest') = 'null'
      OR
      json_extract(publication_json, '$.previousPublicationDigest') =
        previous_publication_digest
    ) AND
    (
      lifecycle_event_digest IS NULL AND
      json_type(publication_json, '$.lifecycleEventDigest') = 'null'
      OR
      json_extract(publication_json, '$.lifecycleEventDigest') =
        lifecycle_event_digest
    ) AND
    json_extract(publication_json, '$.publishedAtMs') = published_at_ms AND
    json_extract(publication_json, '$.publicationDigest') =
      publication_digest AND
    json_type(publication_json, '$.definitions.workflows') = 'array' AND
    json_type(publication_json, '$.definitions.prompts') = 'array' AND
    (
      state = 'absent' AND
      json_array_length(
        json_extract(publication_json, '$.definitions.workflows')
      ) + json_array_length(
        json_extract(publication_json, '$.definitions.prompts')
      ) = 0
      OR
      state <> 'absent' AND
      json_array_length(
        json_extract(publication_json, '$.definitions.workflows')
      ) + json_array_length(
        json_extract(publication_json, '$.definitions.prompts')
      ) > 0
    )
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_automation_publication_version_uidx ON "QingLong3PluginPackageAutomationPublications" (project_id, package_name, version)`,
      `CREATE UNIQUE INDEX ql3_plugin_package_automation_publication_previous_uidx ON "QingLong3PluginPackageAutomationPublications" (previous_publication_digest) WHERE previous_publication_digest IS NOT NULL`,
      `CREATE INDEX ql3_plugin_package_automation_publication_generation_idx ON "QingLong3PluginPackageAutomationPublications" (generation_digest, publication_digest)`,
      `
CREATE TABLE "QingLong3PluginPackageAutomationPublicationHeads" (
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  publication_digest TEXT NOT NULL,
  generation_digest TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (project_id, package_name),
  CONSTRAINT ql3_plugin_package_automation_publication_head_publication_fk
    FOREIGN KEY (publication_digest)
    REFERENCES "QingLong3PluginPackageAutomationPublications" (
      publication_digest
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT ql3_plugin_package_automation_publication_head_state_check CHECK (
    length(project_id) BETWEEN 1 AND 128 AND
    length(package_name) BETWEEN 1 AND 63 AND
    length(publication_digest) = 64 AND
      publication_digest NOT GLOB '*[^0-9a-f]*' AND
    length(generation_digest) = 64 AND
      generation_digest NOT GLOB '*[^0-9a-f]*' AND
    state IN ('active','withdrawn','absent') AND
    version BETWEEN 1 AND 2147483647 AND
    updated_at_ms >= 0
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_automation_publication_head_digest_uidx ON "QingLong3PluginPackageAutomationPublicationHeads" (publication_digest)`,
    ],
  });
