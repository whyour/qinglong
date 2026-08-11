import { defineLocalSqliteMigration } from './sqlMigration';

export const local0047PluginPackageTaskReconciliationsMigration =
  defineLocalSqliteMigration({
    id: '0047-plugin-package-task-reconciliations',
    statements: [
      `
CREATE TABLE "QingLong3PluginPackageTaskOwnerships" (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  claimed_generation_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (project_id, task_id),
  CONSTRAINT ql3_plugin_package_task_ownership_project_fk
    FOREIGN KEY (project_id) REFERENCES "QingLong3Projects" (id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_task_ownership_task_fk
    FOREIGN KEY (project_id, task_id)
    REFERENCES "QingLong3TaskDefinitions" (project_id, task_id)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_task_ownership_identity_check CHECK (
    length(task_id) BETWEEN 1 AND 128 AND
    length(package_name) BETWEEN 1 AND 63
  ),
  CONSTRAINT ql3_plugin_package_task_ownership_digest_check CHECK (
    length(claimed_generation_digest) = 64 AND
      claimed_generation_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_plugin_package_task_ownership_namespace_check CHECK (
    task_id LIKE 'pkg:' || package_name || ':%'
  ),
  CONSTRAINT ql3_plugin_package_task_ownership_time_check CHECK (
    created_at_ms >= 0
  )
)
      `,
      `CREATE INDEX ql3_plugin_package_task_ownership_package_idx ON "QingLong3PluginPackageTaskOwnerships" (project_id, package_name, task_id)`,
      `
CREATE TABLE "QingLong3PluginPackageTaskReconciliations" (
  generation_digest TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  generation INTEGER NOT NULL,
  materialized_revision_digest TEXT NOT NULL,
  lock_digest TEXT NOT NULL,
  previous_lock_digest TEXT,
  receipt_digest TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  CONSTRAINT ql3_plugin_package_task_reconciliation_materialized_fk
    FOREIGN KEY (generation_digest)
    REFERENCES "QingLong3PluginPackageMaterializedRevisions" (generation_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_task_reconciliation_identity_check CHECK (
    length(package_name) BETWEEN 1 AND 63 AND
    generation BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_plugin_package_task_reconciliation_digest_check CHECK (
    length(generation_digest) = 64 AND
      generation_digest NOT GLOB '*[^0-9a-f]*' AND
    length(materialized_revision_digest) = 64 AND
      materialized_revision_digest NOT GLOB '*[^0-9a-f]*' AND
    length(lock_digest) = 64 AND lock_digest NOT GLOB '*[^0-9a-f]*' AND
    (previous_lock_digest IS NULL OR
      (length(previous_lock_digest) = 64 AND
       previous_lock_digest NOT GLOB '*[^0-9a-f]*')) AND
    length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT ql3_plugin_package_task_reconciliation_json_check CHECK (
    length(receipt_json) BETWEEN 2 AND 8388608 AND
    json_valid(receipt_json) AND json_type(receipt_json) = 'object' AND
    json_extract(receipt_json, '$.schema') =
      'qinglong/plugin-package-task-reconciliation@v1' AND
    json_extract(receipt_json, '$.generationDigest') = generation_digest AND
    json_extract(receipt_json, '$.projectId') = project_id AND
    json_extract(receipt_json, '$.packageName') = package_name AND
    json_extract(receipt_json, '$.generation') = generation AND
    json_extract(receipt_json, '$.materializedRevisionDigest') =
      materialized_revision_digest AND
    json_extract(receipt_json, '$.lockDigest') = lock_digest AND
    json_extract(receipt_json, '$.receiptDigest') = receipt_digest
  ),
  CONSTRAINT ql3_plugin_package_task_reconciliation_time_check CHECK (
    committed_at_ms >= 0
  )
)
      `,
      `CREATE UNIQUE INDEX ql3_plugin_package_task_reconciliation_generation_uidx ON "QingLong3PluginPackageTaskReconciliations" (project_id, package_name, generation)`,
      `CREATE INDEX ql3_plugin_package_task_reconciliation_lock_idx ON "QingLong3PluginPackageTaskReconciliations" (lock_digest, generation_digest)`,
      `
CREATE TABLE "QingLong3PluginPackageTaskReconciliationItems" (
  generation_digest TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  disposition TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  PRIMARY KEY (generation_digest, task_id),
  CONSTRAINT ql3_plugin_package_task_reconciliation_item_reconciliation_fk
    FOREIGN KEY (generation_digest)
    REFERENCES "QingLong3PluginPackageTaskReconciliations" (generation_digest)
    ON DELETE RESTRICT,
  CONSTRAINT ql3_plugin_package_task_reconciliation_item_identity_check CHECK (
    length(task_id) BETWEEN 1 AND 128 AND
    revision BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT ql3_plugin_package_task_reconciliation_item_disposition_check
    CHECK (disposition IN (
      'already_disabled','created','disabled','retained','updated'
    )),
  CONSTRAINT ql3_plugin_package_task_reconciliation_item_digest_check CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  )
)
      `,
      `CREATE INDEX ql3_plugin_package_task_reconciliation_item_task_idx ON "QingLong3PluginPackageTaskReconciliationItems" (task_id, generation_digest)`,
    ],
  });
