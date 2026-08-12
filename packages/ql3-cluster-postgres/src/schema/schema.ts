import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const ql3Schema = pgSchema('ql3');

export const schemaMigrations = ql3Schema.table(
  'schema_migrations',
  {
    migrationId: varchar('migration_id', { length: 128 }).primaryKey(),
    streamId: varchar('stream_id', { length: 64 }).notNull(),
    dialect: varchar('dialect', { length: 16 }).notNull(),
    checksum: char('checksum', { length: 64 }).notNull(),
    appliedAtMs: bigint('applied_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'ql3_schema_migrations_dialect_check',
      sql`${table.dialect} = 'postgresql'`,
    ),
    check(
      'ql3_schema_migrations_checksum_check',
      sql`${table.checksum} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_schema_migrations_applied_at_check',
      sql`${table.appliedAtMs} >= 0`,
    ),
  ],
);

export const schemaCapabilities = ql3Schema.table(
  'schema_capabilities',
  {
    contractName: varchar('contract_name', { length: 64 }).primaryKey(),
    contractVersion: integer('contract_version').notNull(),
    migrationId: varchar('migration_id', { length: 128 }).notNull(),
    capabilities: jsonb('capabilities')
      .$type<Record<string, number>>()
      .notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'ql3_schema_capabilities_version_check',
      sql`${table.contractVersion} >= 0`,
    ),
    check(
      'ql3_schema_capabilities_payload_check',
      sql`jsonb_typeof(${table.capabilities}) = 'object'`,
    ),
    check(
      'ql3_schema_capabilities_updated_at_check',
      sql`${table.updatedAtMs} >= 0`,
    ),
    foreignKey({
      name: 'ql3_schema_capabilities_migration_fk',
      columns: [table.migrationId],
      foreignColumns: [schemaMigrations.migrationId],
    }),
  ],
);

export const projects = ql3Schema.table(
  'projects',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 128 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    version: integer('version').notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check('ql3_projects_id_check', sql`char_length(${table.id}) >= 1`),
    check('ql3_projects_name_check', sql`char_length(${table.name}) >= 1`),
    check(
      'ql3_projects_slug_check',
      sql`${table.slug} ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$'`,
    ),
    check(
      'ql3_projects_status_check',
      sql`${table.status} in ('active', 'archived')`,
    ),
    check(
      'ql3_projects_version_check',
      sql`${table.version} between 1 and 2147483647`,
    ),
    check('ql3_projects_created_at_check', sql`${table.createdAtMs} >= 0`),
    check(
      'ql3_projects_updated_at_check',
      sql`${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    uniqueIndex('ql3_projects_slug_uidx').on(table.slug),
  ],
);

export const pluginPackageInstalls = ql3Schema.table(
  'plugin_package_installs',
  {
    installationId: varchar('installation_id', { length: 128 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    packageVersion: varchar('package_version', { length: 128 }).notNull(),
    operation: varchar('operation', { length: 16 }).notNull(),
    lockDigest: char('lock_digest', { length: 64 }).notNull(),
    targetGeneration: integer('target_generation').notNull(),
    previousActiveLockDigest: char('previous_active_lock_digest', {
      length: 64,
    }),
    activeLockDigest: char('active_lock_digest', { length: 64 }),
    state: varchar('state', { length: 16 }).notNull(),
    version: integer('version').notNull(),
    lastMutationId: varchar('last_mutation_id', { length: 128 }).notNull(),
    lastMutationDigest: char('last_mutation_digest', {
      length: 64,
    }).notNull(),
    lockJson: jsonb('lock_json').$type<Record<string, unknown>>().notNull(),
    recordJson: jsonb('record_json').$type<Record<string, unknown>>().notNull(),
    recordDigest: char('record_digest', { length: 64 }).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_installs_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_installs_identity_check',
      sql`${table.installationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' and char_length(${table.packageVersion}) between 1 and 128 and ${table.lastMutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_plugin_package_installs_operation_check',
      sql`${table.operation} in ('install', 'reinstall', 'upgrade', 'rollback')`,
    ),
    check(
      'ql3_plugin_package_installs_state_check',
      sql`${table.state} in ('queued', 'staged', 'activating', 'active', 'failed')`,
    ),
    check(
      'ql3_plugin_package_installs_version_check',
      sql`${table.targetGeneration} between 1 and 2147483647 and ${table.version} between 1 and 2147483647`,
    ),
    check(
      'ql3_plugin_package_installs_digest_check',
      sql`${table.lockDigest} ~ '^[0-9a-f]{64}$' and (${table.previousActiveLockDigest} is null or ${table.previousActiveLockDigest} ~ '^[0-9a-f]{64}$') and (${table.activeLockDigest} is null or ${table.activeLockDigest} ~ '^[0-9a-f]{64}$') and ${table.lastMutationDigest} ~ '^[0-9a-f]{64}$' and ${table.recordDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_installs_record_check',
      sql`jsonb_typeof(${table.lockJson}) = 'object' and octet_length(${table.lockJson}::text) between 2 and 262144 and ${table.lockJson} @> jsonb_build_object('lockDigest', ${table.lockDigest}, 'projectId', ${table.projectId}, 'packageName', ${table.packageName}) and jsonb_typeof(${table.recordJson}) = 'object' and octet_length(${table.recordJson}::text) between 2 and 262144 and ${table.recordJson} @> jsonb_build_object('installationId', ${table.installationId}, 'projectId', ${table.projectId}, 'packageName', ${table.packageName}, 'lockDigest', ${table.lockDigest}, 'state', ${table.state}, 'version', ${table.version}, 'recordDigest', ${table.recordDigest})`,
    ),
    check(
      'ql3_plugin_package_installs_time_check',
      sql`${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    uniqueIndex('ql3_plugin_package_installs_quarantine_target_key').on(
      table.projectId,
      table.packageName,
      table.installationId,
      table.lockDigest,
      table.recordDigest,
    ),
    index('ql3_plugin_package_installs_recovery_idx')
      .on(table.state, table.packageName, table.installationId)
      .where(sql`${table.state} in ('queued', 'staged', 'activating')`),
    index('ql3_plugin_package_installs_project_history_idx').on(
      table.projectId,
      table.packageName,
      table.createdAtMs,
      table.installationId,
    ),
    uniqueIndex('ql3_plugin_package_installs_snapshot_source_uidx').on(
      table.projectId,
      table.packageName,
      table.installationId,
      table.targetGeneration,
      table.lockDigest,
    ),
  ],
);

export const pluginPackageInstallHeads = ql3Schema.table(
  'plugin_package_install_heads',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    installationId: varchar('installation_id', { length: 128 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'plugin_package_install_heads_pkey',
      columns: [table.projectId, table.packageName],
    }),
    foreignKey({
      name: 'ql3_plugin_package_install_heads_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_install_heads_install_fk',
      columns: [table.installationId],
      foreignColumns: [pluginPackageInstalls.installationId],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_install_heads_identity_check',
      sql`${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' and ${table.installationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    uniqueIndex('ql3_plugin_package_install_heads_install_uidx').on(
      table.installationId,
    ),
  ],
);

export const pluginPackageInstallMutations = ql3Schema.table(
  'plugin_package_install_mutations',
  {
    installationId: varchar('installation_id', { length: 128 }).notNull(),
    mutationId: varchar('mutation_id', { length: 128 }).notNull(),
    mutationDigest: char('mutation_digest', { length: 64 }).notNull(),
    resultingRecordDigest: char('resulting_record_digest', {
      length: 64,
    }).notNull(),
    occurredAtMs: bigint('occurred_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'plugin_package_install_mutations_pkey',
      columns: [table.installationId, table.mutationId],
    }),
    foreignKey({
      name: 'ql3_plugin_package_install_mutations_install_fk',
      columns: [table.installationId],
      foreignColumns: [pluginPackageInstalls.installationId],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_install_mutations_identity_check',
      sql`${table.mutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_plugin_package_install_mutations_digest_check',
      sql`${table.mutationDigest} ~ '^[0-9a-f]{64}$' and ${table.resultingRecordDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_install_mutations_time_check',
      sql`${table.occurredAtMs} >= 0`,
    ),
    index('ql3_plugin_package_install_mutations_result_idx').on(
      table.installationId,
      table.resultingRecordDigest,
    ),
  ],
);

export const pluginPackageMaterializedRevisions = ql3Schema.table(
  'plugin_package_materialized_revisions',
  {
    generationDigest: char('generation_digest', { length: 64 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    generation: integer('generation').notNull(),
    lockDigest: char('lock_digest', { length: 64 }).notNull(),
    manifestDigest: char('manifest_digest', { length: 64 }).notNull(),
    revisionDigest: char('revision_digest', { length: 64 }).notNull(),
    revisionJson: jsonb('revision_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_materialized_revision_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_materialized_revision_identity_check',
      sql`${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' and ${table.generation} between 1 and 2147483647`,
    ),
    check(
      'ql3_plugin_package_materialized_revision_digest_check',
      sql`${table.generationDigest} ~ '^[0-9a-f]{64}$' and ${table.lockDigest} ~ '^[0-9a-f]{64}$' and ${table.manifestDigest} ~ '^[0-9a-f]{64}$' and ${table.revisionDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_materialized_revision_json_check',
      sql`jsonb_typeof(${table.revisionJson}) = 'object' and octet_length(${table.revisionJson}::text) between 2 and 25165824 and ${table.revisionJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-materialized-revision@v1', 'generation', jsonb_build_object('generationDigest', ${table.generationDigest}, 'projectId', ${table.projectId}, 'packageName', ${table.packageName}, 'generation', ${table.generation}, 'lockDigest', ${table.lockDigest}), 'manifestDigest', ${table.manifestDigest}, 'revisionDigest', ${table.revisionDigest})`,
    ),
    check(
      'ql3_plugin_package_materialized_revision_time_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    uniqueIndex('ql3_plugin_package_materialized_revision_generation_uidx').on(
      table.projectId,
      table.packageName,
      table.generation,
    ),
    index('ql3_plugin_package_materialized_revision_lock_idx').on(
      table.lockDigest,
      table.generationDigest,
    ),
    uniqueIndex(
      'ql3_plugin_package_materialized_revision_snapshot_source_uidx',
    ).on(
      table.projectId,
      table.packageName,
      table.generation,
      table.generationDigest,
      table.lockDigest,
      table.revisionDigest,
    ),
  ],
);

export const projectToolDefinitionSnapshots = ql3Schema.table(
  'project_tool_definition_snapshots',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    activeVectorDigest: char('active_vector_digest', { length: 64 }).notNull(),
    definitionsDigest: char('definitions_digest', { length: 64 }).notNull(),
    snapshotDigest: char('snapshot_digest', { length: 64 }).notNull(),
    snapshotJson: jsonb('snapshot_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    committedAtMs: bigint('committed_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'project_tool_definition_snapshots_pkey',
      columns: [table.projectId, table.activeVectorDigest],
    }),
    foreignKey({
      name: 'ql3_project_tool_definition_snapshot_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    check(
      'ql3_project_tool_definition_snapshot_identity_check',
      sql`${table.projectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_project_tool_definition_snapshot_digest_check',
      sql`${table.activeVectorDigest} ~ '^[0-9a-f]{64}$' and ${table.definitionsDigest} ~ '^[0-9a-f]{64}$' and ${table.snapshotDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_project_tool_definition_snapshot_json_check',
      sql`jsonb_typeof(${table.snapshotJson}) = 'object' and octet_length(${table.snapshotJson}::text) between 2 and 8388608 and ${table.snapshotJson} @> jsonb_build_object('schema', 'qinglong/project-tool-definition-snapshot@v1', 'projectId', ${table.projectId}, 'activeVectorDigest', ${table.activeVectorDigest}, 'definitionsDigest', ${table.definitionsDigest}, 'snapshotDigest', ${table.snapshotDigest})`,
    ),
    check(
      'ql3_project_tool_definition_snapshot_time_check',
      sql`${table.committedAtMs} >= 0`,
    ),
    uniqueIndex('ql3_project_tool_definition_snapshot_digest_uidx').on(
      table.snapshotDigest,
    ),
    uniqueIndex('ql3_project_tool_snapshot_withdrawal_key').on(
      table.projectId,
      table.activeVectorDigest,
      table.snapshotDigest,
    ),
    index('ql3_project_tool_definition_snapshot_current_idx').on(
      table.projectId,
      sql`${table.committedAtMs} desc`,
      table.activeVectorDigest,
    ),
  ],
);

export const projectToolDefinitionSnapshotSources = ql3Schema.table(
  'project_tool_definition_snapshot_sources',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    activeVectorDigest: char('active_vector_digest', { length: 64 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    installationId: varchar('installation_id', { length: 128 }).notNull(),
    generation: integer('generation').notNull(),
    generationDigest: char('generation_digest', { length: 64 }).notNull(),
    lockDigest: char('lock_digest', { length: 64 }).notNull(),
    revisionDigest: char('revision_digest', { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'project_tool_definition_snapshot_sources_pkey',
      columns: [table.projectId, table.activeVectorDigest, table.packageName],
    }),
    foreignKey({
      name: 'ql3_project_tool_definition_snapshot_source_snapshot_fk',
      columns: [table.projectId, table.activeVectorDigest],
      foreignColumns: [
        projectToolDefinitionSnapshots.projectId,
        projectToolDefinitionSnapshots.activeVectorDigest,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_project_tool_definition_snapshot_source_install_fk',
      columns: [
        table.projectId,
        table.packageName,
        table.installationId,
        table.generation,
        table.lockDigest,
      ],
      foreignColumns: [
        pluginPackageInstalls.projectId,
        pluginPackageInstalls.packageName,
        pluginPackageInstalls.installationId,
        pluginPackageInstalls.targetGeneration,
        pluginPackageInstalls.lockDigest,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_project_tool_definition_snapshot_source_revision_fk',
      columns: [
        table.projectId,
        table.packageName,
        table.generation,
        table.generationDigest,
        table.lockDigest,
        table.revisionDigest,
      ],
      foreignColumns: [
        pluginPackageMaterializedRevisions.projectId,
        pluginPackageMaterializedRevisions.packageName,
        pluginPackageMaterializedRevisions.generation,
        pluginPackageMaterializedRevisions.generationDigest,
        pluginPackageMaterializedRevisions.lockDigest,
        pluginPackageMaterializedRevisions.revisionDigest,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_project_tool_definition_snapshot_source_identity_check',
      sql`${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' and ${table.installationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.generation} between 1 and 2147483647`,
    ),
    check(
      'ql3_project_tool_definition_snapshot_source_digest_check',
      sql`${table.activeVectorDigest} ~ '^[0-9a-f]{64}$' and ${table.generationDigest} ~ '^[0-9a-f]{64}$' and ${table.lockDigest} ~ '^[0-9a-f]{64}$' and ${table.revisionDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    index('ql3_project_tool_definition_snapshot_source_generation_idx').on(
      table.generationDigest,
      table.projectId,
      table.packageName,
    ),
    index('ql3_project_tool_definition_snapshot_source_install_idx').on(
      table.installationId,
      table.activeVectorDigest,
    ),
  ],
);

export const pluginPackageTaskReconciliations = ql3Schema.table(
  'plugin_package_task_reconciliations',
  {
    generationDigest: char('generation_digest', { length: 64 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    generation: integer('generation').notNull(),
    materializedRevisionDigest: char('materialized_revision_digest', {
      length: 64,
    }).notNull(),
    lockDigest: char('lock_digest', { length: 64 }).notNull(),
    previousLockDigest: char('previous_lock_digest', { length: 64 }),
    receiptDigest: char('receipt_digest', { length: 64 }).notNull(),
    receiptJson: jsonb('receipt_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    committedAtMs: bigint('committed_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_task_reconciliation_materialized_fk',
      columns: [table.generationDigest],
      foreignColumns: [pluginPackageMaterializedRevisions.generationDigest],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_task_reconciliation_identity_check',
      sql`${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' and ${table.generation} between 1 and 2147483647`,
    ),
    check(
      'ql3_plugin_package_task_reconciliation_digest_check',
      sql`${table.generationDigest} ~ '^[0-9a-f]{64}$' and ${table.materializedRevisionDigest} ~ '^[0-9a-f]{64}$' and ${table.lockDigest} ~ '^[0-9a-f]{64}$' and (${table.previousLockDigest} is null or ${table.previousLockDigest} ~ '^[0-9a-f]{64}$') and ${table.receiptDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_task_reconciliation_json_check',
      sql`jsonb_typeof(${table.receiptJson}) = 'object' and octet_length(${table.receiptJson}::text) between 2 and 8388608 and ${table.receiptJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-task-reconciliation@v1', 'generationDigest', ${table.generationDigest}, 'projectId', ${table.projectId}, 'packageName', ${table.packageName}, 'generation', ${table.generation}, 'materializedRevisionDigest', ${table.materializedRevisionDigest}, 'lockDigest', ${table.lockDigest}, 'receiptDigest', ${table.receiptDigest})`,
    ),
    check(
      'ql3_plugin_package_task_reconciliation_time_check',
      sql`${table.committedAtMs} >= 0`,
    ),
    uniqueIndex('ql3_plugin_package_task_reconciliation_generation_uidx').on(
      table.projectId,
      table.packageName,
      table.generation,
    ),
    uniqueIndex('ql3_plugin_package_task_reconciliation_receipt_uidx').on(
      table.generationDigest,
      table.receiptDigest,
    ),
    index('ql3_plugin_package_task_reconciliation_lock_idx').on(
      table.lockDigest,
      table.generationDigest,
    ),
  ],
);

export const pluginPackageTaskReconciliationItems = ql3Schema.table(
  'plugin_package_task_reconciliation_items',
  {
    generationDigest: char('generation_digest', { length: 64 }).notNull(),
    taskId: varchar('task_id', { length: 128 }).notNull(),
    revision: integer('revision').notNull(),
    disposition: varchar('disposition', { length: 24 }).notNull(),
    contentDigest: char('content_digest', { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'plugin_package_task_reconciliation_items_pkey',
      columns: [table.generationDigest, table.taskId],
    }),
    foreignKey({
      name: 'ql3_plugin_package_task_reconciliation_item_reconciliation_fk',
      columns: [table.generationDigest],
      foreignColumns: [pluginPackageTaskReconciliations.generationDigest],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_task_reconciliation_item_identity_check',
      sql`char_length(${table.taskId}) between 1 and 128 and ${table.revision} between 1 and 2147483647`,
    ),
    check(
      'ql3_plugin_package_task_reconciliation_item_disposition_check',
      sql`${table.disposition} in ('already_disabled','created','disabled','retained','updated')`,
    ),
    check(
      'ql3_plugin_package_task_reconciliation_item_digest_check',
      sql`${table.contentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    index('ql3_plugin_package_task_reconciliation_item_task_idx').on(
      table.taskId,
      table.generationDigest,
    ),
  ],
);

export const approvalRequests = ql3Schema.table(
  'approval_requests',
  {
    requestId: varchar('request_id', { length: 128 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    version: integer('version').notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    actionType: varchar('action_type', { length: 128 }).notNull(),
    actionRef: varchar('action_ref', { length: 255 }).notNull(),
    actionDigest: char('action_digest', { length: 64 }).notNull(),
    previewDigest: char('preview_digest', { length: 64 }).notNull(),
    requestedByType: varchar('requested_by_type', { length: 32 }).notNull(),
    requestedById: varchar('requested_by_id', { length: 255 }).notNull(),
    decisionId: varchar('decision_id', { length: 128 }),
    consumptionId: varchar('consumption_id', { length: 128 }),
    dispatchId: varchar('dispatch_id', { length: 128 }),
    expiresAtMs: bigint('expires_at_ms', { mode: 'number' }).notNull(),
    requestJson: jsonb('request_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    requestDigest: char('request_digest', { length: 64 }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_approval_requests_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    check(
      'ql3_approval_requests_identity_check',
      sql`${table.requestId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.actionType} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.actionRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'`,
    ),
    check(
      'ql3_approval_requests_state_version_check',
      sql`(${table.state} = 'pending' and ${table.version} = 1) or (${table.state} in ('approved', 'rejected') and ${table.version} = 2) or (${table.state} = 'consumed' and ${table.version} = 3)`,
    ),
    check(
      'ql3_approval_requests_digest_check',
      sql`${table.actionDigest} ~ '^[0-9a-f]{64}$' and ${table.previewDigest} ~ '^[0-9a-f]{64}$' and ${table.requestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_approval_requests_subject_check',
      sql`${table.requestedByType} in ('user', 'api_app', 'mcp_client', 'agent', 'system', 'worker') and char_length(${table.requestedById}) between 1 and 255`,
    ),
    check(
      'ql3_approval_requests_mutation_tuple_check',
      sql`(${table.version} = 1 and ${table.decisionId} is null and ${table.consumptionId} is null and ${table.dispatchId} is null) or (${table.version} = 2 and ${table.decisionId} is not null and ${table.consumptionId} is null and ${table.dispatchId} is null) or (${table.version} = 3 and ${table.decisionId} is not null and ${table.consumptionId} is not null and ${table.dispatchId} is not null)`,
    ),
    check(
      'ql3_approval_requests_json_check',
      sql`jsonb_typeof(${table.requestJson}) = 'object' and octet_length(${table.requestJson}::text) between 2 and 65536 and ${table.requestJson} @> jsonb_build_object('id', ${table.requestId}, 'projectId', ${table.projectId}, 'version', ${table.version}, 'state', ${table.state}, 'action', jsonb_build_object('actionType', ${table.actionType}, 'actionRef', ${table.actionRef}, 'actionDigest', ${table.actionDigest}, 'previewDigest', ${table.previewDigest}))`,
    ),
    check(
      'ql3_approval_requests_time_check',
      sql`${table.expiresAtMs} > 0 and ${table.updatedAtMs} >= 0`,
    ),
    uniqueIndex('ql3_approval_requests_decision_uidx')
      .on(table.decisionId)
      .where(sql`${table.decisionId} is not null`),
    uniqueIndex('ql3_approval_requests_consumption_uidx')
      .on(table.consumptionId)
      .where(sql`${table.consumptionId} is not null`),
    uniqueIndex('ql3_approval_requests_dispatch_uidx')
      .on(table.dispatchId)
      .where(sql`${table.dispatchId} is not null`),
    index('ql3_approval_requests_pending_idx')
      .on(table.expiresAtMs, table.requestId)
      .where(sql`${table.state} = 'pending'`),
    index('ql3_approval_requests_project_idx').on(
      table.projectId,
      table.updatedAtMs,
      table.requestId,
    ),
  ],
);

export const approvedActionDispatches = ql3Schema.table(
  'approved_action_dispatches',
  {
    dispatchId: varchar('dispatch_id', { length: 128 }).primaryKey(),
    approvalRequestId: varchar('approval_request_id', {
      length: 128,
    }).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    actionType: varchar('action_type', { length: 128 }).notNull(),
    actionRef: varchar('action_ref', { length: 255 }).notNull(),
    actionDigest: char('action_digest', { length: 64 }).notNull(),
    previewDigest: char('preview_digest', { length: 64 }).notNull(),
    dispatchJson: jsonb('dispatch_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    dispatchDigest: char('dispatch_digest', { length: 64 }).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_approved_action_dispatch_request_fk',
      columns: [table.approvalRequestId],
      foreignColumns: [approvalRequests.requestId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_approved_action_dispatch_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    check(
      'ql3_approved_action_dispatch_identity_check',
      sql`${table.dispatchId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.actionType} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.actionRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'`,
    ),
    check(
      'ql3_approved_action_dispatch_digest_check',
      sql`${table.actionDigest} ~ '^[0-9a-f]{64}$' and ${table.previewDigest} ~ '^[0-9a-f]{64}$' and ${table.dispatchDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_approved_action_dispatch_json_check',
      sql`jsonb_typeof(${table.dispatchJson}) = 'object' and octet_length(${table.dispatchJson}::text) between 2 and 65536 and ${table.dispatchJson} @> jsonb_build_object('id', ${table.dispatchId}, 'approvalRequestId', ${table.approvalRequestId}, 'projectId', ${table.projectId}, 'action', jsonb_build_object('actionType', ${table.actionType}, 'actionRef', ${table.actionRef}, 'actionDigest', ${table.actionDigest}, 'previewDigest', ${table.previewDigest}))`,
    ),
    check(
      'ql3_approved_action_dispatch_time_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    uniqueIndex('ql3_approved_action_dispatch_request_uidx').on(
      table.approvalRequestId,
    ),
    uniqueIndex('ql3_approved_action_dispatch_lifecycle_key').on(
      table.dispatchId,
      table.projectId,
      table.actionType,
      table.actionDigest,
      table.previewDigest,
    ),
    index('ql3_approved_action_dispatch_project_idx').on(
      table.projectId,
      table.createdAtMs,
      table.dispatchId,
    ),
  ],
);

export const approvedActionExecutions = ql3Schema.table(
  'approved_action_executions',
  {
    dispatchId: varchar('dispatch_id', { length: 128 }).primaryKey(),
    dispatchDigest: char('dispatch_digest', { length: 64 }).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    version: integer('version').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    eligibleAtMs: bigint('eligible_at_ms', { mode: 'number' }),
    nextAttemptAtMs: bigint('next_attempt_at_ms', { mode: 'number' }),
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseToken: varchar('lease_token', { length: 128 }),
    leaseExpiresAtMs: bigint('lease_expires_at_ms', { mode: 'number' }),
    startedAtMs: bigint('started_at_ms', { mode: 'number' }),
    resultMutationId: varchar('result_mutation_id', { length: 128 }),
    resultCode: varchar('result_code', { length: 64 }),
    resultDigest: char('result_digest', { length: 64 }),
    completedAtMs: bigint('completed_at_ms', { mode: 'number' }),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
    executionJson: jsonb('execution_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    executionDigest: char('execution_digest', { length: 64 }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_approved_action_execution_dispatch_fk',
      columns: [table.dispatchId],
      foreignColumns: [approvedActionDispatches.dispatchId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_approved_action_execution_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    check(
      'ql3_approved_action_execution_state_check',
      sql`${table.status} in ('pending','leased','executing','retry_wait','succeeded','failed','blocked') and ${table.version} between 0 and 2147483647 and ${table.attemptCount} between 0 and 16 and ${table.maxAttempts} between 1 and 16 and ${table.attemptCount} <= ${table.maxAttempts}`,
    ),
    check(
      'ql3_approved_action_execution_lease_check',
      sql`(${table.leaseOwner} is null and ${table.leaseToken} is null and ${table.leaseExpiresAtMs} is null) or (char_length(${table.leaseOwner}) between 1 and 128 and char_length(${table.leaseToken}) between 1 and 128 and ${table.leaseExpiresAtMs} > ${table.updatedAtMs})`,
    ),
    check(
      'ql3_approved_action_execution_result_check',
      sql`(${table.resultMutationId} is null and ${table.resultCode} is null) or (char_length(${table.resultMutationId}) between 1 and 128 and char_length(${table.resultCode}) between 1 and 64)`,
    ),
    check(
      'ql3_approved_action_execution_digest_check',
      sql`${table.dispatchDigest} ~ '^[0-9a-f]{64}$' and (${table.resultDigest} is null or ${table.resultDigest} ~ '^[0-9a-f]{64}$') and ${table.executionDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_approved_action_execution_json_check',
      sql`jsonb_typeof(${table.executionJson}) = 'object' and octet_length(${table.executionJson}::text) between 2 and 65536 and ${table.executionJson} @> jsonb_build_object('schema', 'qinglong/approved-action-execution@v1', 'dispatchId', ${table.dispatchId}, 'dispatchDigest', ${table.dispatchDigest}, 'projectId', ${table.projectId}, 'status', ${table.status}, 'version', ${table.version}, 'attemptCount', ${table.attemptCount}, 'maxAttempts', ${table.maxAttempts}, 'executionDigest', ${table.executionDigest})`,
    ),
    check(
      'ql3_approved_action_execution_time_check',
      sql`${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    index('ql3_approved_action_execution_due_idx')
      .on(table.eligibleAtMs, table.dispatchId)
      .where(sql`${table.status} in ('pending','leased','retry_wait')`),
    index('ql3_approved_action_execution_recovery_idx')
      .on(table.leaseExpiresAtMs, table.dispatchId)
      .where(sql`${table.status} = 'executing'`),
    index('ql3_approved_action_execution_project_idx').on(
      table.projectId,
      table.updatedAtMs,
      table.dispatchId,
    ),
  ],
);

export const pluginPackageInstallProposals = ql3Schema.table(
  'plugin_package_install_proposals',
  {
    actionRef: varchar('action_ref', { length: 255 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    actionType: varchar('action_type', { length: 128 }).notNull(),
    permission: varchar('permission', { length: 128 }).notNull(),
    actionDigest: char('action_digest', { length: 64 }).notNull(),
    previewDigest: char('preview_digest', { length: 64 }).notNull(),
    proposedByType: varchar('proposed_by_type', { length: 32 }).notNull(),
    proposedById: varchar('proposed_by_id', { length: 255 }).notNull(),
    fenceProjectVersion: integer('fence_project_version').notNull(),
    fenceBindingVersion: integer('fence_binding_version'),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    proposalJson: jsonb('proposal_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    proposalDigest: char('proposal_digest', { length: 64 }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_proposal_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_proposal_identity_check',
      sql`${table.actionRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' and ${table.actionType} = 'plugin_package.install' and ${table.permission} = 'package.manage' and ${table.proposedByType} in ('user','api_app','mcp_client','agent','system','worker') and char_length(${table.proposedById}) between 1 and 255`,
    ),
    check(
      'ql3_plugin_package_proposal_digest_check',
      sql`${table.actionDigest} ~ '^[0-9a-f]{64}$' and ${table.previewDigest} ~ '^[0-9a-f]{64}$' and ${table.proposalDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_proposal_json_check',
      sql`jsonb_typeof(${table.proposalJson}) = 'object' and octet_length(${table.proposalJson}::text) between 2 and 262144 and ${table.proposalJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-install-proposal@v1', 'actionRef', ${table.actionRef}, 'projectId', ${table.projectId}, 'actionType', ${table.actionType}, 'permission', ${table.permission}, 'actionDigest', ${table.actionDigest}, 'previewDigest', ${table.previewDigest}, 'proposedBy', jsonb_build_object('type', ${table.proposedByType}, 'id', ${table.proposedById}), 'proposalFence', jsonb_build_object('projectVersion', ${table.fenceProjectVersion}, 'bindingVersion', ${table.fenceBindingVersion}), 'createdAtMs', ${table.createdAtMs}, 'proposalDigest', ${table.proposalDigest})`,
    ),
    check(
      'ql3_plugin_package_proposal_time_check',
      sql`${table.fenceProjectVersion} > 0 and (${table.fenceBindingVersion} is null or ${table.fenceBindingVersion} > 0) and ${table.createdAtMs} >= 0`,
    ),
    index('ql3_plugin_package_proposal_project_idx').on(
      table.projectId,
      table.createdAtMs,
      table.actionRef,
    ),
  ],
);

export const pluginPackageManagementQuotaBuckets = ql3Schema.table(
  'plugin_package_management_quota_buckets',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    subjectType: varchar('subject_type', { length: 32 }).notNull(),
    subjectId: varchar('subject_id', { length: 255 }).notNull(),
    operation: varchar('operation', { length: 64 }).notNull(),
    windowStartedAtMs: bigint('window_started_at_ms', {
      mode: 'number',
    }).notNull(),
    consumedCount: integer('consumed_count').notNull(),
    receiptIds: jsonb('receipt_ids').$type<string[]>().notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'plugin_package_management_quota_buckets_pkey',
      columns: [
        table.projectId,
        table.subjectType,
        table.subjectId,
        table.operation,
      ],
    }),
    foreignKey({
      name: 'ql3_plugin_package_management_quota_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_management_quota_identity_check',
      sql`${table.subjectType} = 'user' and char_length(${table.subjectId}) between 1 and 255 and ${table.subjectId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'ql3_plugin_package_management_quota_operation_check',
      sql`${table.operation} in ('plugin-package.propose','plugin-package.decide','plugin-package.inspect')`,
    ),
    check(
      'ql3_plugin_package_management_quota_window_check',
      sql`${table.windowStartedAtMs} >= 0 and ${table.consumedCount} between 1 and 1000 and ${table.updatedAtMs} >= ${table.windowStartedAtMs}`,
    ),
    check(
      'ql3_plugin_package_management_quota_receipts_check',
      sql`jsonb_typeof(${table.receiptIds}) = 'array' and jsonb_array_length(${table.receiptIds}) = ${table.consumedCount} and octet_length(${table.receiptIds}::text) between 3 and 262144`,
    ),
  ],
);

export const workerCredentialManagementQuotaBuckets = ql3Schema.table(
  'worker_credential_management_quota_buckets',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    subjectType: varchar('subject_type', { length: 32 }).notNull(),
    subjectId: varchar('subject_id', { length: 255 }).notNull(),
    operation: varchar('operation', { length: 64 }).notNull(),
    windowStartedAtMs: bigint('window_started_at_ms', {
      mode: 'number',
    }).notNull(),
    consumedCount: integer('consumed_count').notNull(),
    receiptIds: jsonb('receipt_ids').$type<string[]>().notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'worker_credential_management_quota_buckets_pkey',
      columns: [
        table.projectId,
        table.subjectType,
        table.subjectId,
        table.operation,
      ],
    }),
    foreignKey({
      name: 'ql3_worker_credential_management_quota_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    check(
      'ql3_worker_credential_management_quota_identity_check',
      sql`${table.subjectType} = 'user' and char_length(${table.subjectId}) between 1 and 255 and ${table.subjectId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'ql3_worker_credential_management_quota_operation_check',
      sql`${table.operation} in ('worker-credential.plan','worker-credential.propose','worker-credential.decide','worker-credential.inspect')`,
    ),
    check(
      'ql3_worker_credential_management_quota_window_check',
      sql`${table.windowStartedAtMs} >= 0 and ${table.consumedCount} between 1 and 1000 and ${table.updatedAtMs} >= ${table.windowStartedAtMs}`,
    ),
    check(
      'ql3_worker_credential_management_quota_receipts_check',
      sql`jsonb_typeof(${table.receiptIds}) = 'array' and jsonb_array_length(${table.receiptIds}) = ${table.consumedCount} and octet_length(${table.receiptIds}::text) between 3 and 262144`,
    ),
  ],
);

export const pluginPackageIdentityKeysetLedger = ql3Schema.table(
  'plugin_package_identity_keyset_ledger',
  {
    authority: varchar('authority', { length: 64 }).notNull(),
    generation: bigint('generation', { mode: 'number' }).notNull(),
    digest: varchar('digest', { length: 43 }).notNull(),
    issuer: varchar('issuer', { length: 512 }).notNull(),
    audience: varchar('audience', { length: 256 }).notNull(),
    activeKeyIds: jsonb('active_key_ids').$type<string[]>().notNull(),
    revokedKeyIds: jsonb('revoked_key_ids').$type<string[]>().notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'plugin_package_identity_keyset_ledger_pkey',
      columns: [table.authority],
    }),
    check(
      'ql3_plugin_package_identity_keyset_authority_check',
      sql`${table.authority} in ('plugin-package-management', 'worker-credential-management')`,
    ),
    check(
      'ql3_plugin_package_identity_keyset_generation_check',
      sql`${table.generation} >= 1 and ${table.updatedAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_identity_keyset_digest_check',
      sql`${table.digest} ~ '^[A-Za-z0-9_-]{43}$'`,
    ),
    check(
      'ql3_plugin_package_identity_keyset_trust_domain_check',
      sql`char_length(${table.issuer}) between 1 and 512 and ${table.issuer} !~ '[[:cntrl:]]' and char_length(${table.audience}) between 1 and 256 and ${table.audience} !~ '[[:cntrl:]]'`,
    ),
    check(
      'ql3_plugin_package_identity_keyset_keys_check',
      sql`jsonb_typeof(${table.activeKeyIds}) = 'array' and jsonb_array_length(${table.activeKeyIds}) between 1 and 8 and octet_length(${table.activeKeyIds}::text) between 3 and 8192 and jsonb_typeof(${table.revokedKeyIds}) = 'array' and jsonb_array_length(${table.revokedKeyIds}) between 0 and 64 and octet_length(${table.revokedKeyIds}::text) between 2 and 16384`,
    ),
  ],
);

export const taskDefinitions = ql3Schema.table(
  'task_definitions',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    taskId: varchar('task_id', { length: 128 }).notNull(),
    currentRevision: integer('current_revision').notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'task_definitions_pkey',
      columns: [table.projectId, table.taskId],
    }),
    foreignKey({
      name: 'ql3_task_definitions_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    check(
      'ql3_task_definitions_id_check',
      sql`char_length(${table.projectId}) between 1 and 128 and char_length(${table.taskId}) between 1 and 128 and ${table.projectId} !~ '[[:cntrl:]]' and ${table.taskId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'ql3_task_definitions_revision_check',
      sql`${table.currentRevision} between 1 and 2147483647`,
    ),
    check(
      'ql3_task_definitions_time_check',
      sql`${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
  ],
);

export const taskDefinitionRevisions = ql3Schema.table(
  'task_definition_revisions',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    taskId: varchar('task_id', { length: 128 }).notNull(),
    revision: integer('revision').notNull(),
    mutationId: uuid('mutation_id').notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: varchar('description', { length: 4096 }),
    kind: varchar('kind', { length: 16 }).notNull(),
    specJson: jsonb('spec_json').$type<Record<string, unknown>>().notNull(),
    labelsJson: jsonb('labels_json').$type<Record<string, unknown>>().notNull(),
    enabled: boolean('enabled').notNull(),
    contentDigest: char('content_digest', { length: 64 }).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'task_definition_revisions_pkey',
      columns: [table.projectId, table.taskId, table.revision],
    }),
    foreignKey({
      name: 'ql3_task_definition_revisions_head_fk',
      columns: [table.projectId, table.taskId],
      foreignColumns: [taskDefinitions.projectId, taskDefinitions.taskId],
    }).onDelete('restrict'),
    check(
      'ql3_task_definition_revisions_revision_check',
      sql`${table.revision} between 1 and 2147483647`,
    ),
    check(
      'ql3_task_definition_revisions_name_check',
      sql`char_length(${table.name}) between 1 and 255 and (${table.description} is null or char_length(${table.description}) between 1 and 4096)`,
    ),
    check(
      'ql3_task_definition_revisions_kind_check',
      sql`${table.kind} in ('script', 'command', 'workflow', 'agent', 'tool')`,
    ),
    check(
      'ql3_task_definition_revisions_spec_check',
      sql`jsonb_typeof(${table.specJson}) = 'object' and octet_length(${table.specJson}::text) between 2 and 65536`,
    ),
    check(
      'ql3_task_definition_revisions_labels_check',
      sql`jsonb_typeof(${table.labelsJson}) = 'object' and octet_length(${table.labelsJson}::text) between 2 and 16384`,
    ),
    check(
      'ql3_task_definition_revisions_digest_check',
      sql`${table.contentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_task_definition_revisions_created_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    uniqueIndex('ql3_task_definition_revisions_mutation_uidx').on(
      table.mutationId,
    ),
    index('ql3_task_definition_revisions_project_kind_idx').on(
      table.projectId,
      table.kind,
      table.enabled,
      table.taskId,
      table.revision,
    ),
  ],
);

export const pluginPackageTaskOwnerships = ql3Schema.table(
  'plugin_package_task_ownerships',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    taskId: varchar('task_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    claimedGenerationDigest: char('claimed_generation_digest', {
      length: 64,
    }).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'plugin_package_task_ownerships_pkey',
      columns: [table.projectId, table.taskId],
    }),
    foreignKey({
      name: 'ql3_plugin_package_task_ownership_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_task_ownership_task_fk',
      columns: [table.projectId, table.taskId],
      foreignColumns: [taskDefinitions.projectId, taskDefinitions.taskId],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_task_ownership_identity_check',
      sql`char_length(${table.taskId}) between 1 and 128 and ${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
    check(
      'ql3_plugin_package_task_ownership_digest_check',
      sql`${table.claimedGenerationDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_task_ownership_namespace_check',
      sql`${table.taskId} like 'pkg:' || ${table.packageName} || ':%'`,
    ),
    check(
      'ql3_plugin_package_task_ownership_time_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    index('ql3_plugin_package_task_ownership_package_idx').on(
      table.projectId,
      table.packageName,
      table.taskId,
    ),
  ],
);

export const pluginPackageQuarantineEvents = ql3Schema.table(
  'plugin_package_quarantine_events',
  {
    eventDigest: char('event_digest', { length: 64 }).primaryKey(),
    mutationId: varchar('mutation_id', { length: 128 }).notNull(),
    revocationReceiptDigest: char('revocation_receipt_digest', {
      length: 64,
    }).notNull(),
    impactDigest: char('impact_digest', { length: 64 }).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    installationId: varchar('installation_id', { length: 128 }).notNull(),
    lockDigest: char('lock_digest', { length: 64 }).notNull(),
    installState: varchar('install_state', { length: 16 }).notNull(),
    installVersion: integer('install_version').notNull(),
    installRecordDigest: char('install_record_digest', {
      length: 64,
    }).notNull(),
    activeLockDigest: char('active_lock_digest', { length: 64 }),
    proposerType: varchar('proposer_type', { length: 16 }).notNull(),
    proposerId: varchar('proposer_id', { length: 255 }).notNull(),
    confirmerType: varchar('confirmer_type', { length: 16 }).notNull(),
    confirmerId: varchar('confirmer_id', { length: 255 }).notNull(),
    authorizationMode: varchar('authorization_mode', {
      length: 16,
    }).notNull(),
    reasonCode: varchar('reason_code', { length: 32 }).notNull(),
    occurredAtMs: bigint('occurred_at_ms', { mode: 'number' }).notNull(),
    eventJson: jsonb('event_json').$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_quarantine_install_fk',
      columns: [
        table.projectId,
        table.packageName,
        table.installationId,
        table.lockDigest,
        table.installRecordDigest,
      ],
      foreignColumns: [
        pluginPackageInstalls.projectId,
        pluginPackageInstalls.packageName,
        pluginPackageInstalls.installationId,
        pluginPackageInstalls.lockDigest,
        pluginPackageInstalls.recordDigest,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_quarantine_identity_check',
      sql`${table.mutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' and ${table.installationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.installState} in ('queued','staged','activating','active') and ${table.installVersion} between 1 and 2147483647`,
    ),
    check(
      'ql3_plugin_package_quarantine_state_check',
      sql`(${table.installState} = 'active' and ${table.activeLockDigest} = ${table.lockDigest}) or (${table.installState} <> 'active' and (${table.activeLockDigest} is null or ${table.activeLockDigest} <> ${table.lockDigest}))`,
    ),
    check(
      'ql3_plugin_package_quarantine_subject_check',
      sql`${table.proposerType} in ('user','api_app','mcp_client','agent','system','worker') and ${table.confirmerType} in ('user','api_app','mcp_client','agent','system','worker') and octet_length(${table.proposerId}) between 1 and 255 and octet_length(${table.confirmerId}) between 1 and 255 and ${table.authorizationMode} in ('dual_control','break_glass') and (${table.authorizationMode} = 'break_glass' or ${table.proposerType} <> ${table.confirmerType} or ${table.proposerId} <> ${table.confirmerId}) and ${table.reasonCode} in ('suspected_key_compromise','confirmed_key_compromise')`,
    ),
    check(
      'ql3_plugin_package_quarantine_digest_check',
      sql`${table.eventDigest} ~ '^[0-9a-f]{64}$' and ${table.revocationReceiptDigest} ~ '^[0-9a-f]{64}$' and ${table.impactDigest} ~ '^[0-9a-f]{64}$' and ${table.lockDigest} ~ '^[0-9a-f]{64}$' and ${table.installRecordDigest} ~ '^[0-9a-f]{64}$' and (${table.activeLockDigest} is null or ${table.activeLockDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      'ql3_plugin_package_quarantine_json_check',
      sql`jsonb_typeof(${table.eventJson}) = 'object' and octet_length(${table.eventJson}::text) between 2 and 262144 and ${table.eventJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-quarantine-event@v1', 'mutationId', ${table.mutationId}, 'revocationReceiptDigest', ${table.revocationReceiptDigest}, 'impactDigest', ${table.impactDigest}, 'authorizationMode', ${table.authorizationMode}, 'reasonCode', ${table.reasonCode}, 'occurredAtMs', ${table.occurredAtMs}, 'eventDigest', ${table.eventDigest})`,
    ),
    check(
      'ql3_plugin_package_quarantine_time_check',
      sql`${table.occurredAtMs} >= 0`,
    ),
    uniqueIndex('ql3_plugin_package_quarantine_mutation_key').on(
      table.mutationId,
    ),
    uniqueIndex('ql3_plugin_package_quarantine_target_key').on(
      table.projectId,
      table.packageName,
      table.installationId,
      table.lockDigest,
    ),
    index('ql3_plugin_package_quarantine_lock_idx').on(
      table.lockDigest,
      table.projectId,
      table.packageName,
    ),
    index('ql3_plugin_package_quarantine_project_idx').on(
      table.projectId,
      table.packageName,
      table.occurredAtMs,
      table.eventDigest,
    ),
  ],
);

export const pluginPackageWithdrawalReceipts = ql3Schema.table(
  'plugin_package_withdrawal_receipts',
  {
    eventDigest: char('event_digest', { length: 64 }).primaryKey(),
    receiptDigest: char('receipt_digest', { length: 64 }).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    capabilityStatus: varchar('capability_status', { length: 16 }).notNull(),
    taskCount: integer('task_count').notNull(),
    previousActiveVectorDigest: char('previous_active_vector_digest', {
      length: 64,
    }),
    currentActiveVectorDigest: char('current_active_vector_digest', {
      length: 64,
    }),
    currentToolSnapshotDigest: char('current_tool_snapshot_digest', {
      length: 64,
    }),
    retainedSourceCount: integer('retained_source_count').notNull(),
    committedAtMs: bigint('committed_at_ms', { mode: 'number' }).notNull(),
    receiptJson: jsonb('receipt_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_withdrawal_event_fk',
      columns: [table.eventDigest],
      foreignColumns: [pluginPackageQuarantineEvents.eventDigest],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_withdrawal_snapshot_fk',
      columns: [
        table.projectId,
        table.currentActiveVectorDigest,
        table.currentToolSnapshotDigest,
      ],
      foreignColumns: [
        projectToolDefinitionSnapshots.projectId,
        projectToolDefinitionSnapshots.activeVectorDigest,
        projectToolDefinitionSnapshots.snapshotDigest,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_withdrawal_disposition_check',
      sql`(${table.capabilityStatus} = 'not_active' and ${table.taskCount} = 0 and ${table.previousActiveVectorDigest} is null and ${table.currentActiveVectorDigest} is null and ${table.currentToolSnapshotDigest} is null and ${table.retainedSourceCount} = 0) or (${table.capabilityStatus} = 'withdrawn' and ${table.taskCount} between 0 and 128 and ${table.previousActiveVectorDigest} is not null and ${table.currentActiveVectorDigest} is not null and ${table.previousActiveVectorDigest} <> ${table.currentActiveVectorDigest} and ${table.currentToolSnapshotDigest} is not null and ${table.retainedSourceCount} between 0 and 128)`,
    ),
    check(
      'ql3_plugin_package_withdrawal_digest_check',
      sql`${table.eventDigest} ~ '^[0-9a-f]{64}$' and ${table.receiptDigest} ~ '^[0-9a-f]{64}$' and (${table.previousActiveVectorDigest} is null or ${table.previousActiveVectorDigest} ~ '^[0-9a-f]{64}$') and (${table.currentActiveVectorDigest} is null or ${table.currentActiveVectorDigest} ~ '^[0-9a-f]{64}$') and (${table.currentToolSnapshotDigest} is null or ${table.currentToolSnapshotDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      'ql3_plugin_package_withdrawal_json_check',
      sql`jsonb_typeof(${table.receiptJson}) = 'object' and octet_length(${table.receiptJson}::text) between 2 and 8388608 and ${table.receiptJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-withdrawal-receipt@v1', 'eventDigest', ${table.eventDigest}, 'committedAtMs', ${table.committedAtMs}, 'receiptDigest', ${table.receiptDigest})`,
    ),
    check(
      'ql3_plugin_package_withdrawal_time_check',
      sql`${table.committedAtMs} >= 0`,
    ),
    uniqueIndex('ql3_plugin_package_withdrawal_receipt_key').on(
      table.receiptDigest,
    ),
    index('ql3_plugin_package_withdrawal_snapshot_idx').on(
      table.currentToolSnapshotDigest,
      table.eventDigest,
    ),
  ],
);

export const pluginPackageWithdrawalTasks = ql3Schema.table(
  'plugin_package_withdrawal_tasks',
  {
    eventDigest: char('event_digest', { length: 64 }).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    taskId: varchar('task_id', { length: 128 }).notNull(),
    previousRevision: integer('previous_revision').notNull(),
    disabledRevision: integer('disabled_revision').notNull(),
    previousContentDigest: char('previous_content_digest', {
      length: 64,
    }).notNull(),
    disabledContentDigest: char('disabled_content_digest', {
      length: 64,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'plugin_package_withdrawal_tasks_pkey',
      columns: [table.eventDigest, table.taskId],
    }),
    foreignKey({
      name: 'ql3_plugin_package_withdrawal_task_receipt_fk',
      columns: [table.eventDigest],
      foreignColumns: [pluginPackageWithdrawalReceipts.eventDigest],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_withdrawal_task_previous_fk',
      columns: [table.projectId, table.taskId, table.previousRevision],
      foreignColumns: [
        taskDefinitionRevisions.projectId,
        taskDefinitionRevisions.taskId,
        taskDefinitionRevisions.revision,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_withdrawal_task_disabled_fk',
      columns: [table.projectId, table.taskId, table.disabledRevision],
      foreignColumns: [
        taskDefinitionRevisions.projectId,
        taskDefinitionRevisions.taskId,
        taskDefinitionRevisions.revision,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_withdrawal_task_identity_check',
      sql`${table.taskId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.previousRevision} between 1 and 2147483646 and ${table.disabledRevision} = ${table.previousRevision} + 1`,
    ),
    check(
      'ql3_plugin_package_withdrawal_task_digest_check',
      sql`${table.eventDigest} ~ '^[0-9a-f]{64}$' and ${table.previousContentDigest} ~ '^[0-9a-f]{64}$' and ${table.disabledContentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    index('ql3_plugin_package_withdrawal_task_idx').on(
      table.projectId,
      table.taskId,
      table.eventDigest,
    ),
  ],
);

export const pluginPackageLifecycleEvents = ql3Schema.table(
  'plugin_package_lifecycle_events',
  {
    eventDigest: char('event_digest', { length: 64 }).primaryKey(),
    mutationId: varchar('mutation_id', { length: 128 }).notNull(),
    dispatchId: varchar('dispatch_id', { length: 128 }).notNull(),
    approvedActionType: varchar('approved_action_type', {
      length: 128,
    }).notNull(),
    action: varchar('action', { length: 16 }).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    installationId: varchar('installation_id', { length: 128 }).notNull(),
    lockDigest: char('lock_digest', { length: 64 }).notNull(),
    installVersion: integer('install_version').notNull(),
    installRecordDigest: char('install_record_digest', {
      length: 64,
    }).notNull(),
    expectedVersion: integer('expected_version').notNull(),
    expectedDisposition: varchar('expected_disposition', {
      length: 16,
    }).notNull(),
    expectedEventDigest: char('expected_event_digest', { length: 64 }),
    generationDigest: char('generation_digest', { length: 64 }).notNull(),
    materializedRevisionDigest: char('materialized_revision_digest', {
      length: 64,
    }).notNull(),
    currentToolSnapshotDigest: char('current_tool_snapshot_digest', {
      length: 64,
    }).notNull(),
    referenceGraphDigest: char('reference_graph_digest', {
      length: 64,
    }).notNull(),
    impactDigest: char('impact_digest', { length: 64 }).notNull(),
    actionDigest: char('action_digest', { length: 64 }).notNull(),
    requestedByType: varchar('requested_by_type', { length: 16 }).notNull(),
    requestedById: varchar('requested_by_id', { length: 255 }).notNull(),
    approvedByType: varchar('approved_by_type', { length: 16 }).notNull(),
    approvedById: varchar('approved_by_id', { length: 255 }).notNull(),
    authorizationMode: varchar('authorization_mode', {
      length: 32,
    }).notNull(),
    occurredAtMs: bigint('occurred_at_ms', { mode: 'number' }).notNull(),
    eventJson: jsonb('event_json').$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_lifecycle_install_fk',
      columns: [
        table.projectId,
        table.packageName,
        table.installationId,
        table.lockDigest,
        table.installRecordDigest,
      ],
      foreignColumns: [
        pluginPackageInstalls.projectId,
        pluginPackageInstalls.packageName,
        pluginPackageInstalls.installationId,
        pluginPackageInstalls.lockDigest,
        pluginPackageInstalls.recordDigest,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_lifecycle_dispatch_fk',
      columns: [
        table.dispatchId,
        table.projectId,
        table.approvedActionType,
        table.actionDigest,
        table.impactDigest,
      ],
      foreignColumns: [
        approvedActionDispatches.dispatchId,
        approvedActionDispatches.projectId,
        approvedActionDispatches.actionType,
        approvedActionDispatches.actionDigest,
        approvedActionDispatches.previewDigest,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_lifecycle_previous_event_fk',
      columns: [table.expectedEventDigest],
      foreignColumns: [table.eventDigest],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_lifecycle_identity_check',
      sql`${table.mutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.dispatchId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' and ${table.installationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.installVersion} between 1 and 2147483647 and ${table.action} in ('disable','enable','uninstall') and ${table.approvedActionType} = 'plugin_package.lifecycle.' || ${table.action}`,
    ),
    check(
      'ql3_plugin_package_lifecycle_expectation_check',
      sql`(${table.action} = 'disable' and ${table.expectedDisposition} = 'active') or (${table.action} in ('enable','uninstall') and ${table.expectedDisposition} = 'disabled')`,
    ),
    check(
      'ql3_plugin_package_lifecycle_origin_check',
      sql`(${table.expectedVersion} = 0 and ${table.expectedDisposition} = 'active' and ${table.expectedEventDigest} is null) or (${table.expectedVersion} between 1 and 2147483646 and ${table.expectedEventDigest} is not null)`,
    ),
    check(
      'ql3_plugin_package_lifecycle_subject_check',
      sql`${table.requestedByType} = 'user' and ${table.approvedByType} = 'user' and octet_length(${table.requestedById}) between 1 and 255 and octet_length(${table.approvedById}) between 1 and 255 and ${table.authorizationMode} in ('human_confirmation','separation_of_duty') and ((${table.authorizationMode} = 'human_confirmation' and ${table.requestedById} = ${table.approvedById}) or (${table.authorizationMode} = 'separation_of_duty' and ${table.requestedById} <> ${table.approvedById}))`,
    ),
    check(
      'ql3_plugin_package_lifecycle_digest_check',
      sql`${table.eventDigest} ~ '^[0-9a-f]{64}$' and ${table.lockDigest} ~ '^[0-9a-f]{64}$' and ${table.installRecordDigest} ~ '^[0-9a-f]{64}$' and ${table.generationDigest} ~ '^[0-9a-f]{64}$' and ${table.materializedRevisionDigest} ~ '^[0-9a-f]{64}$' and ${table.currentToolSnapshotDigest} ~ '^[0-9a-f]{64}$' and ${table.referenceGraphDigest} ~ '^[0-9a-f]{64}$' and ${table.impactDigest} ~ '^[0-9a-f]{64}$' and ${table.actionDigest} ~ '^[0-9a-f]{64}$' and (${table.expectedEventDigest} is null or ${table.expectedEventDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      'ql3_plugin_package_lifecycle_json_check',
      sql`jsonb_typeof(${table.eventJson}) = 'object' and octet_length(${table.eventJson}::text) between 2 and 524288 and ${table.eventJson} @> jsonb_build_object('schema','qinglong/plugin-package-lifecycle-event@v1','mutationId',${table.mutationId},'dispatchId',${table.dispatchId},'actionDigest',${table.actionDigest},'authorizationMode',${table.authorizationMode},'occurredAtMs',${table.occurredAtMs},'eventDigest',${table.eventDigest})`,
    ),
    check(
      'ql3_plugin_package_lifecycle_time_check',
      sql`${table.occurredAtMs} >= 0`,
    ),
    uniqueIndex('ql3_plugin_package_lifecycle_mutation_key').on(
      table.mutationId,
    ),
    uniqueIndex('ql3_plugin_package_lifecycle_dispatch_key').on(
      table.dispatchId,
    ),
    uniqueIndex('ql3_plugin_package_lifecycle_target_version_key').on(
      table.projectId,
      table.packageName,
      table.installationId,
      table.lockDigest,
      table.expectedVersion,
    ),
    index('ql3_plugin_package_lifecycle_project_idx').on(
      table.projectId,
      table.packageName,
      table.occurredAtMs,
      table.eventDigest,
    ),
  ],
);

export const pluginPackageLifecycleHeads = ql3Schema.table(
  'plugin_package_lifecycle_heads',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    installationId: varchar('installation_id', { length: 128 }).notNull(),
    lockDigest: char('lock_digest', { length: 64 }).notNull(),
    installRecordDigest: char('install_record_digest', {
      length: 64,
    }).notNull(),
    version: integer('version').notNull(),
    disposition: varchar('disposition', { length: 16 }).notNull(),
    eventDigest: char('event_digest', { length: 64 }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'plugin_package_lifecycle_heads_pkey',
      columns: [table.projectId, table.packageName],
    }),
    foreignKey({
      name: 'ql3_plugin_package_lifecycle_head_install_fk',
      columns: [
        table.projectId,
        table.packageName,
        table.installationId,
        table.lockDigest,
        table.installRecordDigest,
      ],
      foreignColumns: [
        pluginPackageInstalls.projectId,
        pluginPackageInstalls.packageName,
        pluginPackageInstalls.installationId,
        pluginPackageInstalls.lockDigest,
        pluginPackageInstalls.recordDigest,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_lifecycle_head_event_fk',
      columns: [table.eventDigest],
      foreignColumns: [pluginPackageLifecycleEvents.eventDigest],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_lifecycle_head_state_check',
      sql`${table.version} between 1 and 2147483647 and ${table.disposition} in ('active','disabled','uninstalled') and ${table.updatedAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_lifecycle_head_digest_check',
      sql`${table.lockDigest} ~ '^[0-9a-f]{64}$' and ${table.installRecordDigest} ~ '^[0-9a-f]{64}$' and ${table.eventDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    uniqueIndex('ql3_plugin_package_lifecycle_head_event_key').on(
      table.eventDigest,
    ),
  ],
);

export const pluginPackageLifecycleReceipts = ql3Schema.table(
  'plugin_package_lifecycle_receipts',
  {
    eventDigest: char('event_digest', { length: 64 }).primaryKey(),
    receiptDigest: char('receipt_digest', { length: 64 }).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    action: varchar('action', { length: 16 }).notNull(),
    capabilityStatus: varchar('capability_status', { length: 16 }).notNull(),
    taskCount: integer('task_count').notNull(),
    previousActiveVectorDigest: char('previous_active_vector_digest', {
      length: 64,
    }).notNull(),
    currentActiveVectorDigest: char('current_active_vector_digest', {
      length: 64,
    }).notNull(),
    currentToolSnapshotDigest: char('current_tool_snapshot_digest', {
      length: 64,
    }).notNull(),
    retainedSourceCount: integer('retained_source_count').notNull(),
    committedAtMs: bigint('committed_at_ms', { mode: 'number' }).notNull(),
    receiptJson: jsonb('receipt_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_lifecycle_receipt_event_fk',
      columns: [table.eventDigest],
      foreignColumns: [pluginPackageLifecycleEvents.eventDigest],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_lifecycle_receipt_snapshot_fk',
      columns: [
        table.projectId,
        table.currentActiveVectorDigest,
        table.currentToolSnapshotDigest,
      ],
      foreignColumns: [
        projectToolDefinitionSnapshots.projectId,
        projectToolDefinitionSnapshots.activeVectorDigest,
        projectToolDefinitionSnapshots.snapshotDigest,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_lifecycle_receipt_state_check',
      sql`(${table.action} = 'disable' and ${table.capabilityStatus} = 'withdrawn' and ${table.previousActiveVectorDigest} <> ${table.currentActiveVectorDigest}) or (${table.action} = 'enable' and ${table.capabilityStatus} = 'restored' and ${table.previousActiveVectorDigest} <> ${table.currentActiveVectorDigest}) or (${table.action} = 'uninstall' and ${table.capabilityStatus} = 'retired' and ${table.taskCount} = 0 and ${table.previousActiveVectorDigest} = ${table.currentActiveVectorDigest})`,
    ),
    check(
      'ql3_plugin_package_lifecycle_receipt_bounds_check',
      sql`${table.taskCount} between 0 and 128 and ${table.retainedSourceCount} between 0 and 128 and ${table.committedAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_lifecycle_receipt_digest_check',
      sql`${table.eventDigest} ~ '^[0-9a-f]{64}$' and ${table.receiptDigest} ~ '^[0-9a-f]{64}$' and ${table.previousActiveVectorDigest} ~ '^[0-9a-f]{64}$' and ${table.currentActiveVectorDigest} ~ '^[0-9a-f]{64}$' and ${table.currentToolSnapshotDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_lifecycle_receipt_json_check',
      sql`jsonb_typeof(${table.receiptJson}) = 'object' and octet_length(${table.receiptJson}::text) between 2 and 524288 and ${table.receiptJson} @> jsonb_build_object('schema','qinglong/plugin-package-lifecycle-receipt@v1','eventDigest',${table.eventDigest},'action',${table.action},'committedAtMs',${table.committedAtMs},'receiptDigest',${table.receiptDigest})`,
    ),
    uniqueIndex('ql3_plugin_package_lifecycle_receipt_key').on(
      table.receiptDigest,
    ),
    index('ql3_plugin_package_lifecycle_receipt_snapshot_idx').on(
      table.projectId,
      table.currentActiveVectorDigest,
      table.eventDigest,
    ),
  ],
);

export const pluginPackageLifecycleTasks = ql3Schema.table(
  'plugin_package_lifecycle_tasks',
  {
    eventDigest: char('event_digest', { length: 64 }).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    taskId: varchar('task_id', { length: 128 }).notNull(),
    previousRevision: integer('previous_revision').notNull(),
    currentRevision: integer('current_revision').notNull(),
    previousContentDigest: char('previous_content_digest', {
      length: 64,
    }).notNull(),
    currentContentDigest: char('current_content_digest', {
      length: 64,
    }).notNull(),
    previousEnabled: boolean('previous_enabled').notNull(),
    currentEnabled: boolean('current_enabled').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'plugin_package_lifecycle_tasks_pkey',
      columns: [table.eventDigest, table.taskId],
    }),
    foreignKey({
      name: 'ql3_plugin_package_lifecycle_task_receipt_fk',
      columns: [table.eventDigest],
      foreignColumns: [pluginPackageLifecycleReceipts.eventDigest],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_lifecycle_task_previous_fk',
      columns: [table.projectId, table.taskId, table.previousRevision],
      foreignColumns: [
        taskDefinitionRevisions.projectId,
        taskDefinitionRevisions.taskId,
        taskDefinitionRevisions.revision,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_lifecycle_task_current_fk',
      columns: [table.projectId, table.taskId, table.currentRevision],
      foreignColumns: [
        taskDefinitionRevisions.projectId,
        taskDefinitionRevisions.taskId,
        taskDefinitionRevisions.revision,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_lifecycle_task_transition_check',
      sql`${table.taskId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.currentRevision} = ${table.previousRevision} + 1 and ${table.previousEnabled} <> ${table.currentEnabled}`,
    ),
    check(
      'ql3_plugin_package_lifecycle_task_digest_check',
      sql`${table.eventDigest} ~ '^[0-9a-f]{64}$' and ${table.previousContentDigest} ~ '^[0-9a-f]{64}$' and ${table.currentContentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    index('ql3_plugin_package_lifecycle_task_idx').on(
      table.projectId,
      table.taskId,
      table.eventDigest,
    ),
  ],
);

export const pluginPackageLifecyclePlans = ql3Schema.table(
  'plugin_package_lifecycle_plans',
  {
    actionRef: varchar('action_ref', { length: 255 }).primaryKey(),
    planDigest: char('plan_digest', { length: 64 }).notNull(),
    action: varchar('action', { length: 16 }).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    installationId: varchar('installation_id', { length: 128 }).notNull(),
    lockDigest: char('lock_digest', { length: 64 }).notNull(),
    impactDigest: char('impact_digest', { length: 64 }).notNull(),
    requestedByType: varchar('requested_by_type', { length: 16 }).notNull(),
    requestedById: varchar('requested_by_id', { length: 255 }).notNull(),
    plannedAtMs: bigint('planned_at_ms', { mode: 'number' }).notNull(),
    expiresAtMs: bigint('expires_at_ms', { mode: 'number' }).notNull(),
    planJson: jsonb('plan_json').$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_lifecycle_plan_install_fk',
      columns: [table.installationId],
      foreignColumns: [pluginPackageInstalls.installationId],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_lifecycle_plan_identity_check',
      sql`${table.actionRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' and ${table.action} in ('disable', 'enable', 'uninstall') and ${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' and ${table.requestedByType} = 'user' and char_length(${table.requestedById}) between 1 and 255 and ${table.requestedById} !~ '[[:cntrl:]]'`,
    ),
    check(
      'ql3_plugin_package_lifecycle_plan_digest_check',
      sql`${table.planDigest} ~ '^[0-9a-f]{64}$' and ${table.lockDigest} ~ '^[0-9a-f]{64}$' and ${table.impactDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_lifecycle_plan_time_check',
      sql`${table.plannedAtMs} >= 0 and ${table.expiresAtMs} > ${table.plannedAtMs} and ${table.expiresAtMs} - ${table.plannedAtMs} <= 900000`,
    ),
    check(
      'ql3_plugin_package_lifecycle_plan_json_check',
      sql`jsonb_typeof(${table.planJson}) = 'object' and octet_length(${table.planJson}::text) between 2 and 98304 and ${table.planJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-lifecycle-plan@v1', 'actionRef', ${table.actionRef}, 'planDigest', ${table.planDigest}, 'requestedBy', jsonb_build_object('type', ${table.requestedByType}, 'id', ${table.requestedById}), 'plannedAtMs', ${table.plannedAtMs}, 'expiresAtMs', ${table.expiresAtMs}, 'impact', jsonb_build_object('action', ${table.action}, 'impactDigest', ${table.impactDigest}, 'target', jsonb_build_object('projectId', ${table.projectId}, 'packageName', ${table.packageName}, 'installationId', ${table.installationId}, 'lockDigest', ${table.lockDigest})))`,
    ),
    uniqueIndex('ql3_plugin_package_lifecycle_plan_digest_key').on(
      table.planDigest,
    ),
    uniqueIndex('ql3_plugin_package_lifecycle_plan_impact_key').on(
      table.projectId,
      table.packageName,
      table.installationId,
      table.lockDigest,
      table.impactDigest,
    ),
    index('ql3_plugin_package_lifecycle_plan_expiry_idx').on(
      table.expiresAtMs,
      table.actionRef,
    ),
  ],
);

export const pluginPackageAutomationDispositionEvents = ql3Schema.table(
  'plugin_package_automation_disposition_events',
  {
    eventDigest: char('event_digest', { length: 64 }).primaryKey(),
    eventKind: varchar('event_kind', { length: 16 }).notNull(),
  },
  (table) => [
    check(
      'ql3_plugin_package_automation_disposition_kind_check',
      sql`${table.eventKind} in ('lifecycle','quarantine')`,
    ),
    check(
      'ql3_plugin_package_automation_disposition_digest_check',
      sql`${table.eventDigest} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const pluginPackageAutomationPublications = ql3Schema.table(
  'plugin_package_automation_publications',
  {
    publicationDigest: char('publication_digest', { length: 64 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    installationId: varchar('installation_id', { length: 128 }).notNull(),
    lockDigest: char('lock_digest', { length: 64 }).notNull(),
    generation: integer('generation').notNull(),
    generationDigest: char('generation_digest', { length: 64 }).notNull(),
    materializedRevisionDigest: char('materialized_revision_digest', {
      length: 64,
    }).notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    version: integer('version').notNull(),
    previousPublicationDigest: char('previous_publication_digest', {
      length: 64,
    }),
    lifecycleEventDigest: char('lifecycle_event_digest', { length: 64 }),
    publishedAtMs: bigint('published_at_ms', { mode: 'number' }).notNull(),
    publicationJson: jsonb('publication_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_automation_publication_revision_fk',
      columns: [table.generationDigest],
      foreignColumns: [pluginPackageMaterializedRevisions.generationDigest],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_automation_publication_previous_fk',
      columns: [table.previousPublicationDigest],
      foreignColumns: [table.publicationDigest],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_automation_publication_disposition_fk',
      columns: [table.lifecycleEventDigest],
      foreignColumns: [pluginPackageAutomationDispositionEvents.eventDigest],
    }).onDelete('restrict'),
    uniqueIndex('ql3_plugin_package_automation_publication_version_key').on(
      table.projectId,
      table.packageName,
      table.version,
    ),
    uniqueIndex('ql3_plugin_package_automation_publication_previous_key')
      .on(table.previousPublicationDigest)
      .where(sql`${table.previousPublicationDigest} is not null`),
    index('ql3_plugin_package_automation_publication_generation_idx').on(
      table.generationDigest,
      table.publicationDigest,
    ),
    check(
      'ql3_plugin_package_automation_publication_identity_check',
      sql`${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' and ${table.generation} between 1 and 2147483647 and ${table.state} in ('active','withdrawn','absent') and ${table.version} between 1 and 2147483647 and ${table.publishedAtMs} >= 0 and ((${table.version} = 1 and ${table.state} in ('active','absent') and ${table.previousPublicationDigest} is null and ${table.lifecycleEventDigest} is null) or (${table.version} > 1 and ${table.previousPublicationDigest} is not null)) and (${table.state} <> 'withdrawn' or ${table.lifecycleEventDigest} is not null)`,
    ),
    check(
      'ql3_plugin_package_automation_publication_digest_check',
      sql`${table.publicationDigest} ~ '^[0-9a-f]{64}$' and ${table.lockDigest} ~ '^[0-9a-f]{64}$' and ${table.generationDigest} ~ '^[0-9a-f]{64}$' and ${table.materializedRevisionDigest} ~ '^[0-9a-f]{64}$' and (${table.previousPublicationDigest} is null or ${table.previousPublicationDigest} ~ '^[0-9a-f]{64}$') and (${table.lifecycleEventDigest} is null or ${table.lifecycleEventDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      'ql3_plugin_package_automation_publication_json_check',
      sql`jsonb_typeof(${table.publicationJson}) = 'object' and octet_length(${table.publicationJson}::text) between 2 and 12582912 and ${table.publicationJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-automation-publication@v1', 'state', ${table.state}, 'version', ${table.version}, 'previousPublicationDigest', ${table.previousPublicationDigest}, 'lifecycleEventDigest', ${table.lifecycleEventDigest}, 'publishedAtMs', ${table.publishedAtMs}, 'publicationDigest', ${table.publicationDigest}, 'target', jsonb_build_object('projectId', ${table.projectId}, 'packageName', ${table.packageName}, 'installationId', ${table.installationId}, 'lockDigest', ${table.lockDigest}, 'generation', ${table.generation}, 'generationDigest', ${table.generationDigest}, 'materializedRevisionDigest', ${table.materializedRevisionDigest})) and jsonb_typeof(${table.publicationJson} -> 'definitions' -> 'workflows') = 'array' and jsonb_typeof(${table.publicationJson} -> 'definitions' -> 'prompts') = 'array' and ((${table.state} = 'absent' and jsonb_array_length(${table.publicationJson} -> 'definitions' -> 'workflows') + jsonb_array_length(${table.publicationJson} -> 'definitions' -> 'prompts') = 0) or (${table.state} <> 'absent' and jsonb_array_length(${table.publicationJson} -> 'definitions' -> 'workflows') + jsonb_array_length(${table.publicationJson} -> 'definitions' -> 'prompts') > 0))`,
    ),
  ],
);

export const pluginPackageAutomationPublicationHeads = ql3Schema.table(
  'plugin_package_automation_publication_heads',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    publicationDigest: char('publication_digest', { length: 64 }).notNull(),
    generationDigest: char('generation_digest', { length: 64 }).notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    version: integer('version').notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.packageName],
      name: 'plugin_package_automation_publication_heads_pkey',
    }),
    foreignKey({
      name: 'ql3_plugin_package_automation_publication_head_publication_fk',
      columns: [table.publicationDigest],
      foreignColumns: [pluginPackageAutomationPublications.publicationDigest],
    }).onDelete('restrict'),
    uniqueIndex('ql3_plugin_package_automation_publication_head_digest_key').on(
      table.publicationDigest,
    ),
    check(
      'ql3_plugin_package_automation_publication_head_state_check',
      sql`${table.publicationDigest} ~ '^[0-9a-f]{64}$' and ${table.generationDigest} ~ '^[0-9a-f]{64}$' and ${table.state} in ('active','withdrawn','absent') and ${table.version} between 1 and 2147483647 and ${table.updatedAtMs} >= 0`,
    ),
  ],
);

export const pluginPackagePublisherProvenance = ql3Schema.table(
  'plugin_package_publisher_provenance',
  {
    installationId: varchar('installation_id', { length: 128 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    lockDigest: char('lock_digest', { length: 64 }).notNull(),
    artifactDigest: char('artifact_digest', { length: 64 }).notNull(),
    manifestDigest: char('manifest_digest', { length: 64 }).notNull(),
    contentDigest: char('content_digest', { length: 64 }).notNull(),
    stageEvidenceDigest: char('stage_evidence_digest', {
      length: 64,
    }).notNull(),
    publisher: varchar('publisher', { length: 253 }).notNull(),
    keyId: varchar('key_id', { length: 128 }).notNull(),
    signatureDigest: char('signature_digest', { length: 64 }).notNull(),
    keyNotBeforeMs: bigint('key_not_before_ms', {
      mode: 'number',
    }).notNull(),
    keyNotAfterMs: bigint('key_not_after_ms', { mode: 'number' }).notNull(),
    verifiedAtMs: bigint('verified_at_ms', { mode: 'number' }).notNull(),
    provenanceDigest: char('provenance_digest', { length: 64 }).notNull(),
    provenanceJson: jsonb('provenance_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_publisher_provenance_install_fk',
      columns: [table.installationId],
      foreignColumns: [pluginPackageInstalls.installationId],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_publisher_provenance_identity_check',
      sql`${table.installationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' and ${table.publisher} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$' and ${table.keyId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_plugin_package_publisher_provenance_digest_check',
      sql`${table.lockDigest} ~ '^[0-9a-f]{64}$' and ${table.artifactDigest} ~ '^[0-9a-f]{64}$' and ${table.manifestDigest} ~ '^[0-9a-f]{64}$' and ${table.contentDigest} ~ '^[0-9a-f]{64}$' and ${table.stageEvidenceDigest} ~ '^[0-9a-f]{64}$' and ${table.signatureDigest} ~ '^[0-9a-f]{64}$' and ${table.provenanceDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_publisher_provenance_time_check',
      sql`${table.keyNotBeforeMs} >= 0 and ${table.keyNotAfterMs} > ${table.keyNotBeforeMs} and ${table.verifiedAtMs} >= ${table.keyNotBeforeMs} and ${table.verifiedAtMs} < ${table.keyNotAfterMs}`,
    ),
    check(
      'ql3_plugin_package_publisher_provenance_json_check',
      sql`jsonb_typeof(${table.provenanceJson}) = 'object' and octet_length(${table.provenanceJson}::text) between 2 and 262144 and ${table.provenanceJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-publisher-provenance@v1', 'installationId', ${table.installationId}, 'lockDigest', ${table.lockDigest}, 'provenanceDigest', ${table.provenanceDigest})`,
    ),
    uniqueIndex('ql3_plugin_package_publisher_provenance_digest_key').on(
      table.provenanceDigest,
    ),
    index('ql3_plugin_package_publisher_provenance_signer_idx').on(
      table.publisher,
      table.keyId,
      table.projectId,
      table.packageName,
      table.installationId,
    ),
    index('ql3_plugin_package_publisher_provenance_lock_idx').on(
      table.lockDigest,
      table.installationId,
    ),
  ],
);

export const pluginPackagePublisherRevocationReceipts = ql3Schema.table(
  'plugin_package_publisher_revocation_receipts',
  {
    receiptDigest: char('receipt_digest', { length: 64 }).primaryKey(),
    mutationId: varchar('mutation_id', { length: 128 }).notNull(),
    publisher: varchar('publisher', { length: 253 }).notNull(),
    keyId: varchar('key_id', { length: 128 }).notNull(),
    previousTrustDigest: char('previous_trust_digest', {
      length: 64,
    }).notNull(),
    currentTrustDigest: char('current_trust_digest', {
      length: 64,
    }).notNull(),
    proposerType: varchar('proposer_type', { length: 16 }).notNull(),
    proposerId: varchar('proposer_id', { length: 255 }).notNull(),
    confirmerType: varchar('confirmer_type', { length: 16 }).notNull(),
    confirmerId: varchar('confirmer_id', { length: 255 }).notNull(),
    authorizationMode: varchar('authorization_mode', {
      length: 16,
    }).notNull(),
    reasonCode: varchar('reason_code', { length: 32 }).notNull(),
    revokedAtMs: bigint('revoked_at_ms', { mode: 'number' }).notNull(),
    receiptJson: jsonb('receipt_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    check(
      'ql3_plugin_package_publisher_revocation_identity_check',
      sql`${table.mutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.publisher} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$' and ${table.keyId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.proposerType} in ('user','api_app','mcp_client','agent','system','worker') and ${table.confirmerType} in ('user','api_app','mcp_client','agent','system','worker') and octet_length(${table.proposerId}) between 1 and 255 and octet_length(${table.confirmerId}) between 1 and 255 and ${table.authorizationMode} in ('dual_control','break_glass') and (${table.authorizationMode} = 'break_glass' or ${table.proposerType} <> ${table.confirmerType} or ${table.proposerId} <> ${table.confirmerId}) and ${table.reasonCode} in ('suspected_key_compromise','confirmed_key_compromise')`,
    ),
    check(
      'ql3_plugin_package_publisher_revocation_digest_check',
      sql`${table.receiptDigest} ~ '^[0-9a-f]{64}$' and ${table.previousTrustDigest} ~ '^[0-9a-f]{64}$' and ${table.currentTrustDigest} ~ '^[0-9a-f]{64}$' and ${table.previousTrustDigest} <> ${table.currentTrustDigest}`,
    ),
    check(
      'ql3_plugin_package_publisher_revocation_time_check',
      sql`${table.revokedAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_publisher_revocation_json_check',
      sql`jsonb_typeof(${table.receiptJson}) = 'object' and octet_length(${table.receiptJson}::text) between 2 and 262144 and ${table.receiptJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-publisher-key-revocation-receipt@v1', 'mutationId', ${table.mutationId}, 'publisher', ${table.publisher}, 'keyId', ${table.keyId}, 'receiptDigest', ${table.receiptDigest})`,
    ),
    uniqueIndex('ql3_plugin_package_publisher_revocation_mutation_key').on(
      table.mutationId,
    ),
    uniqueIndex('ql3_plugin_package_publisher_revocation_signer_key').on(
      table.publisher,
      table.keyId,
    ),
  ],
);

export const pluginPackagePublisherRevocationImpacts = ql3Schema.table(
  'plugin_package_publisher_revocation_impacts',
  {
    revocationReceiptDigest: char('revocation_receipt_digest', {
      length: 64,
    }).primaryKey(),
    impactDigest: char('impact_digest', { length: 64 }).notNull(),
    itemCount: integer('item_count').notNull(),
    generatedAtMs: bigint('generated_at_ms', { mode: 'number' }).notNull(),
    impactJson: jsonb('impact_json').$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_publisher_impact_receipt_fk',
      columns: [table.revocationReceiptDigest],
      foreignColumns: [pluginPackagePublisherRevocationReceipts.receiptDigest],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_publisher_impact_digest_check',
      sql`${table.revocationReceiptDigest} ~ '^[0-9a-f]{64}$' and ${table.impactDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_publisher_impact_count_check',
      sql`${table.itemCount} between 0 and 4096 and ${table.generatedAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_publisher_impact_json_check',
      sql`jsonb_typeof(${table.impactJson}) = 'object' and octet_length(${table.impactJson}::text) between 2 and 8388608 and ${table.impactJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-publisher-key-revocation-impact@v1', 'revocationReceiptDigest', ${table.revocationReceiptDigest}, 'impactDigest', ${table.impactDigest}) and jsonb_array_length(${table.impactJson} -> 'items') = ${table.itemCount}`,
    ),
    uniqueIndex('ql3_plugin_package_publisher_impact_digest_key').on(
      table.impactDigest,
    ),
  ],
);

export const pluginPackagePublisherRevocationImpactItems = ql3Schema.table(
  'plugin_package_publisher_revocation_impact_items',
  {
    impactDigest: char('impact_digest', { length: 64 }).notNull(),
    provenanceDigest: char('provenance_digest', { length: 64 }).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    installationId: varchar('installation_id', { length: 128 }).notNull(),
    lockDigest: char('lock_digest', { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'plugin_package_publisher_revocation_impact_items_pkey',
      columns: [table.impactDigest, table.provenanceDigest],
    }),
    foreignKey({
      name: 'ql3_plugin_package_publisher_impact_item_impact_fk',
      columns: [table.impactDigest],
      foreignColumns: [pluginPackagePublisherRevocationImpacts.impactDigest],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_publisher_impact_item_provenance_fk',
      columns: [table.provenanceDigest],
      foreignColumns: [pluginPackagePublisherProvenance.provenanceDigest],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_publisher_impact_item_install_fk',
      columns: [table.installationId],
      foreignColumns: [pluginPackageInstalls.installationId],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_publisher_impact_item_identity_check',
      sql`${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' and ${table.installationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.impactDigest} ~ '^[0-9a-f]{64}$' and ${table.provenanceDigest} ~ '^[0-9a-f]{64}$' and ${table.lockDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    uniqueIndex('ql3_plugin_package_publisher_impact_item_install_key').on(
      table.impactDigest,
      table.installationId,
    ),
    index('ql3_plugin_package_publisher_impact_item_target_idx').on(
      table.projectId,
      table.packageName,
      table.installationId,
      table.lockDigest,
    ),
  ],
);

export const pluginPackagePublisherTrustSnapshots = ql3Schema.table(
  'plugin_package_publisher_trust_snapshots',
  {
    snapshotDigest: char('snapshot_digest', { length: 64 }).primaryKey(),
    keyCount: integer('key_count').notNull(),
    observedBy: varchar('observed_by', { length: 128 }).notNull(),
    observedAtMs: bigint('observed_at_ms', { mode: 'number' }).notNull(),
    snapshotJson: jsonb('snapshot_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    check(
      'ql3_plugin_package_publisher_trust_snapshot_identity_check',
      sql`${table.observedBy} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_plugin_package_publisher_trust_snapshot_digest_check',
      sql`${table.snapshotDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_publisher_trust_snapshot_count_check',
      sql`${table.keyCount} between 0 and 32 and ${table.observedAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_publisher_trust_snapshot_json_check',
      sql`jsonb_typeof(${table.snapshotJson}) = 'object' and octet_length(${table.snapshotJson}::text) between 2 and 262144 and ${table.snapshotJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-publisher-trust-snapshot@v1', 'snapshotDigest', ${table.snapshotDigest}) and jsonb_array_length(${table.snapshotJson} -> 'keys') = ${table.keyCount}`,
    ),
  ],
);

export const pluginPackagePublisherTrustHeads = ql3Schema.table(
  'plugin_package_publisher_trust_heads',
  {
    authorityId: varchar('authority_id', { length: 128 }).primaryKey(),
    generation: integer('generation').notNull(),
    baseSnapshotDigest: char('base_snapshot_digest', {
      length: 64,
    }).notNull(),
    effectiveTrustDigest: char('effective_trust_digest', {
      length: 64,
    }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
    headDigest: char('head_digest', { length: 64 }).notNull(),
    headJson: jsonb('head_json').$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_publisher_trust_head_snapshot_fk',
      columns: [table.baseSnapshotDigest],
      foreignColumns: [pluginPackagePublisherTrustSnapshots.snapshotDigest],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_publisher_trust_head_effective_snapshot_fk',
      columns: [table.effectiveTrustDigest],
      foreignColumns: [pluginPackagePublisherTrustSnapshots.snapshotDigest],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_publisher_trust_head_identity_check',
      sql`${table.authorityId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.generation} between 1 and 2147483647`,
    ),
    check(
      'ql3_plugin_package_publisher_trust_head_digest_check',
      sql`${table.baseSnapshotDigest} ~ '^[0-9a-f]{64}$' and ${table.effectiveTrustDigest} ~ '^[0-9a-f]{64}$' and ${table.headDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_publisher_trust_head_time_check',
      sql`${table.updatedAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_publisher_trust_head_json_check',
      sql`jsonb_typeof(${table.headJson}) = 'object' and octet_length(${table.headJson}::text) between 2 and 65536 and ${table.headJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-publisher-trust-head@v1', 'authorityId', ${table.authorityId}, 'generation', ${table.generation}, 'headDigest', ${table.headDigest})`,
    ),
  ],
);

export const pluginPackagePublisherRevocationProposals = ql3Schema.table(
  'plugin_package_publisher_revocation_proposals',
  {
    actionRef: varchar('action_ref', { length: 255 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    authorityId: varchar('authority_id', { length: 128 }).notNull(),
    trustGeneration: integer('trust_generation').notNull(),
    publisher: varchar('publisher', { length: 253 }).notNull(),
    keyId: varchar('key_id', { length: 128 }).notNull(),
    previousTrustDigest: char('previous_trust_digest', {
      length: 64,
    }).notNull(),
    currentTrustDigest: char('current_trust_digest', {
      length: 64,
    }).notNull(),
    actionType: varchar('action_type', { length: 128 }).notNull(),
    permission: varchar('permission', { length: 128 }).notNull(),
    actionDigest: char('action_digest', { length: 64 }).notNull(),
    previewDigest: char('preview_digest', { length: 64 }).notNull(),
    authorizationMode: varchar('authorization_mode', {
      length: 16,
    }).notNull(),
    reasonCode: varchar('reason_code', { length: 32 }).notNull(),
    proposedByType: varchar('proposed_by_type', { length: 32 }).notNull(),
    proposedById: varchar('proposed_by_id', { length: 255 }).notNull(),
    proposerAssurance: varchar('proposer_assurance', {
      length: 32,
    }).notNull(),
    fenceProjectVersion: integer('fence_project_version').notNull(),
    fenceBindingVersion: integer('fence_binding_version'),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    proposalJson: jsonb('proposal_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    proposalDigest: char('proposal_digest', { length: 64 }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_publisher_revocation_proposal_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_publisher_revocation_proposal_head_fk',
      columns: [table.authorityId],
      foreignColumns: [pluginPackagePublisherTrustHeads.authorityId],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_publisher_revocation_proposal_identity_check',
      sql`${table.actionRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' and ${table.authorityId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.publisher} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$' and ${table.keyId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.actionType} = 'plugin_package.publisher_key.revoke' and ${table.permission} = 'package.manage' and ${table.authorizationMode} in ('dual_control','break_glass') and ${table.reasonCode} in ('suspected_key_compromise','confirmed_key_compromise') and ${table.proposedByType} in ('user','api_app','mcp_client','agent','system','worker') and octet_length(${table.proposedById}) between 1 and 255 and ${table.proposerAssurance} in ('single_factor','multi_factor','service','hardware','local_console') and (${table.authorizationMode} <> 'break_glass' or ${table.proposerAssurance} = 'hardware')`,
    ),
    check(
      'ql3_plugin_package_publisher_revocation_proposal_digest_check',
      sql`${table.previousTrustDigest} ~ '^[0-9a-f]{64}$' and ${table.currentTrustDigest} ~ '^[0-9a-f]{64}$' and ${table.previousTrustDigest} <> ${table.currentTrustDigest} and ${table.actionDigest} ~ '^[0-9a-f]{64}$' and ${table.previewDigest} ~ '^[0-9a-f]{64}$' and ${table.proposalDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_publisher_revocation_proposal_time_check',
      sql`${table.trustGeneration} between 1 and 2147483647 and ${table.fenceProjectVersion} between 1 and 2147483647 and (${table.fenceBindingVersion} is null or ${table.fenceBindingVersion} between 1 and 2147483647) and ${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_publisher_revocation_proposal_json_check',
      sql`jsonb_typeof(${table.proposalJson}) = 'object' and octet_length(${table.proposalJson}::text) between 2 and 262144 and ${table.proposalJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-publisher-key-revocation-proposal@v1', 'actionRef', ${table.actionRef}, 'projectId', ${table.projectId}, 'proposalDigest', ${table.proposalDigest})`,
    ),
    uniqueIndex(
      'ql3_plugin_package_publisher_revocation_proposal_digest_key',
    ).on(table.proposalDigest),
    index('ql3_plugin_package_publisher_revocation_proposal_project_idx').on(
      table.projectId,
      table.createdAtMs,
      table.actionRef,
    ),
    index('ql3_plugin_package_publisher_revocation_proposal_signer_idx').on(
      table.publisher,
      table.keyId,
      table.trustGeneration,
    ),
  ],
);

export const pluginPackagePublisherTrustTransitionProposals = ql3Schema.table(
  'plugin_package_publisher_trust_transition_proposals',
  {
    actionRef: varchar('action_ref', { length: 255 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    authorityId: varchar('authority_id', { length: 128 }).notNull(),
    trustGeneration: integer('trust_generation').notNull(),
    mode: varchar('mode', { length: 16 }).notNull(),
    publisher: varchar('publisher', { length: 253 }).notNull(),
    keyId: varchar('key_id', { length: 128 }).notNull(),
    previousTrustDigest: char('previous_trust_digest', {
      length: 64,
    }).notNull(),
    currentTrustDigest: char('current_trust_digest', {
      length: 64,
    }).notNull(),
    actionType: varchar('action_type', { length: 128 }).notNull(),
    permission: varchar('permission', { length: 128 }).notNull(),
    actionDigest: char('action_digest', { length: 64 }).notNull(),
    previewDigest: char('preview_digest', { length: 64 }).notNull(),
    proposedByType: varchar('proposed_by_type', {
      length: 32,
    }).notNull(),
    proposedById: varchar('proposed_by_id', { length: 255 }).notNull(),
    proposerAssurance: varchar('proposer_assurance', {
      length: 32,
    }).notNull(),
    fenceProjectVersion: integer('fence_project_version').notNull(),
    fenceBindingVersion: integer('fence_binding_version'),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    proposalJson: jsonb('proposal_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    proposalDigest: char('proposal_digest', { length: 64 }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_pp_trust_transition_proposal_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_pp_trust_transition_proposal_head_fk',
      columns: [table.authorityId],
      foreignColumns: [pluginPackagePublisherTrustHeads.authorityId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_pp_trust_transition_proposal_previous_fk',
      columns: [table.previousTrustDigest],
      foreignColumns: [pluginPackagePublisherTrustSnapshots.snapshotDigest],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_pp_trust_transition_proposal_current_fk',
      columns: [table.currentTrustDigest],
      foreignColumns: [pluginPackagePublisherTrustSnapshots.snapshotDigest],
    }).onDelete('restrict'),
    check(
      'ql3_pp_trust_transition_proposal_identity_check',
      sql`${table.actionRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' and ${table.authorityId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.publisher} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$' and ${table.keyId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.mode} in ('overlap_add','safe_retire') and ${table.actionType} = case ${table.mode} when 'overlap_add' then 'plugin_package.publisher_key.overlap_add' when 'safe_retire' then 'plugin_package.publisher_key.safe_retire' end and ${table.permission} = 'package.manage' and ${table.proposedByType} = 'user' and octet_length(${table.proposedById}) between 1 and 255 and ${table.proposerAssurance} in ('multi_factor','hardware')`,
    ),
    check(
      'ql3_pp_trust_transition_proposal_digest_check',
      sql`${table.previousTrustDigest} ~ '^[0-9a-f]{64}$' and ${table.currentTrustDigest} ~ '^[0-9a-f]{64}$' and ${table.previousTrustDigest} <> ${table.currentTrustDigest} and ${table.actionDigest} ~ '^[0-9a-f]{64}$' and ${table.previewDigest} ~ '^[0-9a-f]{64}$' and ${table.proposalDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_pp_trust_transition_proposal_time_check',
      sql`${table.trustGeneration} between 1 and 2147483647 and ${table.fenceProjectVersion} between 1 and 2147483647 and (${table.fenceBindingVersion} is null or ${table.fenceBindingVersion} between 1 and 2147483647) and ${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_pp_trust_transition_proposal_json_check',
      sql`jsonb_typeof(${table.proposalJson}) = 'object' and octet_length(${table.proposalJson}::text) between 2 and 262144 and ${table.proposalJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-publisher-trust-transition-proposal@v1', 'actionRef', ${table.actionRef}, 'projectId', ${table.projectId}, 'proposalDigest', ${table.proposalDigest})`,
    ),
    uniqueIndex('ql3_pp_trust_transition_proposal_digest_key').on(
      table.proposalDigest,
    ),
    index('ql3_pp_trust_transition_proposal_project_idx').on(
      table.projectId,
      table.createdAtMs,
      table.actionRef,
    ),
    index('ql3_pp_trust_transition_proposal_signer_idx').on(
      table.publisher,
      table.keyId,
      table.trustGeneration,
    ),
  ],
);

export const pluginPackagePublisherTrustTransitionReceipts = ql3Schema.table(
  'plugin_package_publisher_trust_transition_receipts',
  {
    mutationId: varchar('mutation_id', { length: 128 }).primaryKey(),
    proposalDigest: char('proposal_digest', { length: 64 }).notNull(),
    authorityId: varchar('authority_id', { length: 128 }).notNull(),
    previousGeneration: integer('previous_generation').notNull(),
    currentGeneration: integer('current_generation').notNull(),
    mode: varchar('mode', { length: 16 }).notNull(),
    publisher: varchar('publisher', { length: 253 }).notNull(),
    keyId: varchar('key_id', { length: 128 }).notNull(),
    previousTrustDigest: char('previous_trust_digest', {
      length: 64,
    }).notNull(),
    currentTrustDigest: char('current_trust_digest', {
      length: 64,
    }).notNull(),
    proposerType: varchar('proposer_type', { length: 32 }).notNull(),
    proposerId: varchar('proposer_id', { length: 255 }).notNull(),
    confirmerType: varchar('confirmer_type', { length: 32 }).notNull(),
    confirmerId: varchar('confirmer_id', { length: 255 }).notNull(),
    retirementMatchingInstallations: integer(
      'retirement_matching_installations',
    ),
    executedAtMs: bigint('executed_at_ms', { mode: 'number' }).notNull(),
    receiptJson: jsonb('receipt_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    receiptDigest: char('receipt_digest', { length: 64 }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_pp_trust_transition_receipt_dispatch_fk',
      columns: [table.mutationId],
      foreignColumns: [approvedActionDispatches.dispatchId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_pp_trust_transition_receipt_proposal_fk',
      columns: [table.proposalDigest],
      foreignColumns: [
        pluginPackagePublisherTrustTransitionProposals.proposalDigest,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_pp_trust_transition_receipt_head_fk',
      columns: [table.authorityId],
      foreignColumns: [pluginPackagePublisherTrustHeads.authorityId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_pp_trust_transition_receipt_previous_fk',
      columns: [table.previousTrustDigest],
      foreignColumns: [pluginPackagePublisherTrustSnapshots.snapshotDigest],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_pp_trust_transition_receipt_current_fk',
      columns: [table.currentTrustDigest],
      foreignColumns: [pluginPackagePublisherTrustSnapshots.snapshotDigest],
    }).onDelete('restrict'),
    check(
      'ql3_pp_trust_transition_receipt_identity_check',
      sql`${table.mutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.proposalDigest} ~ '^[0-9a-f]{64}$' and ${table.authorityId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.mode} in ('overlap_add','safe_retire') and ${table.publisher} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$' and ${table.keyId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.proposerType} = 'user' and ${table.confirmerType} = 'user' and octet_length(${table.proposerId}) between 1 and 255 and octet_length(${table.confirmerId}) between 1 and 255 and (${table.proposerType}, ${table.proposerId}) <> (${table.confirmerType}, ${table.confirmerId})`,
    ),
    check(
      'ql3_pp_trust_transition_receipt_transition_check',
      sql`${table.previousGeneration} between 1 and 2147483646 and ${table.currentGeneration} = ${table.previousGeneration} + 1 and ${table.previousTrustDigest} ~ '^[0-9a-f]{64}$' and ${table.currentTrustDigest} ~ '^[0-9a-f]{64}$' and ${table.previousTrustDigest} <> ${table.currentTrustDigest} and ((${table.mode} = 'overlap_add' and ${table.retirementMatchingInstallations} is null) or (${table.mode} = 'safe_retire' and ${table.retirementMatchingInstallations} = 0)) and ${table.executedAtMs} >= 0 and ${table.receiptDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_pp_trust_transition_receipt_json_check',
      sql`jsonb_typeof(${table.receiptJson}) = 'object' and octet_length(${table.receiptJson}::text) between 2 and 262144 and ${table.receiptJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-publisher-trust-transition-receipt@v1', 'mutationId', ${table.mutationId}, 'proposalDigest', ${table.proposalDigest}, 'receiptDigest', ${table.receiptDigest})`,
    ),
    uniqueIndex('ql3_pp_trust_transition_receipt_proposal_key').on(
      table.proposalDigest,
    ),
    uniqueIndex('ql3_pp_trust_transition_receipt_digest_key').on(
      table.receiptDigest,
    ),
    index('ql3_pp_trust_transition_receipt_signer_idx').on(
      table.publisher,
      table.keyId,
      table.currentGeneration,
    ),
  ],
);

export const taskExecutionRevisions = ql3Schema.table(
  'task_execution_revisions',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    taskId: varchar('task_id', { length: 128 }).notNull(),
    sourceRevision: integer('source_revision').notNull(),
    taskRevision: varchar('task_revision', { length: 96 }).notNull(),
    sourceContentDigest: char('source_content_digest', {
      length: 64,
    }).notNull(),
    executorType: varchar('executor_type', { length: 32 }).notNull(),
    planSchema: varchar('plan_schema', { length: 64 }).notNull(),
    planJson: jsonb('plan_json').$type<Record<string, unknown>>().notNull(),
    contentDigest: char('content_digest', { length: 64 }).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'task_execution_revisions_pkey',
      columns: [
        table.projectId,
        table.taskId,
        table.sourceRevision,
        table.executorType,
      ],
    }),
    foreignKey({
      name: 'ql3_task_execution_revisions_source_fk',
      columns: [table.projectId, table.taskId, table.sourceRevision],
      foreignColumns: [
        taskDefinitionRevisions.projectId,
        taskDefinitionRevisions.taskId,
        taskDefinitionRevisions.revision,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_task_execution_revisions_identity_check',
      sql`${table.taskRevision} = concat('qltd:v1:', ${table.sourceRevision}::text, ':', ${table.sourceContentDigest}) and ${table.sourceContentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_task_execution_revisions_executor_check',
      sql`${table.executorType} = 'remote_worker'`,
    ),
    check(
      'ql3_task_execution_revisions_plan_check',
      sql`${table.planSchema} = 'qinglong/command-execution@v1' and jsonb_typeof(${table.planJson}) = 'object' and octet_length(${table.planJson}::text) between 2 and 98304`,
    ),
    check(
      'ql3_task_execution_revisions_digest_check',
      sql`${table.contentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_task_execution_revisions_created_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    uniqueIndex('ql3_task_execution_revisions_ref_uidx').on(
      table.projectId,
      table.taskId,
      table.taskRevision,
      table.executorType,
    ),
  ],
);

export const triggers = ql3Schema.table(
  'triggers',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    triggerId: varchar('trigger_id', { length: 128 }).notNull(),
    taskId: varchar('task_id', { length: 128 }).notNull(),
    currentRevision: integer('current_revision').notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'triggers_pkey',
      columns: [table.projectId, table.triggerId],
    }),
    foreignKey({
      name: 'ql3_triggers_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_triggers_task_fk',
      columns: [table.projectId, table.taskId],
      foreignColumns: [taskDefinitions.projectId, taskDefinitions.taskId],
    }).onDelete('restrict'),
    check(
      'ql3_triggers_id_check',
      sql`char_length(${table.projectId}) between 1 and 128 and char_length(${table.triggerId}) between 1 and 128 and char_length(${table.taskId}) between 1 and 128 and ${table.projectId} !~ '[[:cntrl:]]' and ${table.triggerId} !~ '[[:cntrl:]]' and ${table.taskId} !~ '[[:cntrl:]]'`,
    ),
    check(
      'ql3_triggers_revision_check',
      sql`${table.currentRevision} between 1 and 2147483647`,
    ),
    check(
      'ql3_triggers_time_check',
      sql`${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    uniqueIndex('ql3_triggers_task_uidx').on(
      table.projectId,
      table.triggerId,
      table.taskId,
    ),
  ],
);

export const triggerRevisions = ql3Schema.table(
  'trigger_revisions',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    triggerId: varchar('trigger_id', { length: 128 }).notNull(),
    revision: integer('revision').notNull(),
    mutationId: uuid('mutation_id').notNull(),
    taskId: varchar('task_id', { length: 128 }).notNull(),
    taskRevision: integer('task_revision').notNull(),
    taskContentDigest: char('task_content_digest', { length: 64 }).notNull(),
    specJson: jsonb('spec_json').$type<Record<string, unknown>>().notNull(),
    enabled: boolean('enabled').notNull(),
    contentDigest: char('content_digest', { length: 64 }).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'trigger_revisions_pkey',
      columns: [table.projectId, table.triggerId, table.revision],
    }),
    foreignKey({
      name: 'ql3_trigger_revisions_head_fk',
      columns: [table.projectId, table.triggerId, table.taskId],
      foreignColumns: [triggers.projectId, triggers.triggerId, triggers.taskId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_trigger_revisions_task_revision_fk',
      columns: [table.projectId, table.taskId, table.taskRevision],
      foreignColumns: [
        taskDefinitionRevisions.projectId,
        taskDefinitionRevisions.taskId,
        taskDefinitionRevisions.revision,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_trigger_revisions_revision_check',
      sql`${table.revision} between 1 and 2147483647 and ${table.taskRevision} between 1 and 2147483647`,
    ),
    check(
      'ql3_trigger_revisions_task_digest_check',
      sql`${table.taskContentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_trigger_revisions_spec_check',
      sql`jsonb_typeof(${table.specJson}) = 'object' and octet_length(${table.specJson}::text) between 2 and 16384`,
    ),
    check(
      'ql3_trigger_revisions_digest_check',
      sql`${table.contentDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_trigger_revisions_created_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    uniqueIndex('ql3_trigger_revisions_mutation_uidx').on(table.mutationId),
    index('ql3_trigger_revisions_project_enabled_idx').on(
      table.projectId,
      table.enabled,
      table.triggerId,
      table.revision,
    ),
    index('ql3_trigger_revisions_task_idx').on(
      table.projectId,
      table.taskId,
      table.taskRevision,
      table.triggerId,
      table.revision,
    ),
  ],
);

export const triggerSchedules = ql3Schema.table(
  'trigger_schedules',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    triggerId: varchar('trigger_id', { length: 128 }).notNull(),
    triggerRevision: integer('trigger_revision').notNull(),
    nextFireAtMs: bigint('next_fire_at_ms', { mode: 'number' }),
    lastScheduledAtMs: bigint('last_scheduled_at_ms', { mode: 'number' }),
    stateVersion: integer('state_version').notNull(),
    claimOwner: varchar('claim_owner', { length: 128 }),
    claimToken: uuid('claim_token'),
    claimVersion: integer('claim_version').notNull(),
    claimExpiresAtMs: bigint('claim_expires_at_ms', { mode: 'number' }),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'trigger_schedules_pkey',
      columns: [table.projectId, table.triggerId],
    }),
    foreignKey({
      name: 'ql3_trigger_schedules_revision_fk',
      columns: [table.projectId, table.triggerId, table.triggerRevision],
      foreignColumns: [
        triggerRevisions.projectId,
        triggerRevisions.triggerId,
        triggerRevisions.revision,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_trigger_schedules_revision_check',
      sql`${table.triggerRevision} between 1 and 2147483647`,
    ),
    check(
      'ql3_trigger_schedules_cursor_check',
      sql`${table.nextFireAtMs} is null or ${table.nextFireAtMs} >= 0`,
    ),
    check(
      'ql3_trigger_schedules_last_check',
      sql`${table.lastScheduledAtMs} is null or ${table.lastScheduledAtMs} >= 0`,
    ),
    check(
      'ql3_trigger_schedules_version_check',
      sql`${table.stateVersion} between 0 and 2147483647 and ${table.claimVersion} between 0 and 2147483647`,
    ),
    check(
      'ql3_trigger_schedules_claim_owner_check',
      sql`${table.claimOwner} is null or (char_length(${table.claimOwner}) between 1 and 128 and ${table.claimOwner} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')`,
    ),
    check(
      'ql3_trigger_schedules_claim_shape_check',
      sql`(${table.claimOwner} is null and ${table.claimToken} is null and ${table.claimExpiresAtMs} is null) or (${table.claimOwner} is not null and ${table.claimToken} is not null and ${table.claimVersion} >= 1 and ${table.claimExpiresAtMs} is not null and ${table.claimExpiresAtMs} > ${table.updatedAtMs})`,
    ),
    check(
      'ql3_trigger_schedules_updated_check',
      sql`${table.updatedAtMs} >= 0`,
    ),
    index('ql3_trigger_schedules_due_idx').on(
      table.nextFireAtMs,
      table.claimExpiresAtMs,
      table.projectId,
      table.triggerId,
    ),
    index('ql3_trigger_schedules_claim_expiry_idx')
      .on(table.claimExpiresAtMs, table.projectId, table.triggerId)
      .where(sql`${table.claimToken} is not null`),
  ],
);

export const projectRoleBindings = ql3Schema.table(
  'project_role_bindings',
  {
    projectId: varchar('project_id', { length: 128 }).notNull(),
    subjectType: varchar('subject_type', { length: 32 }).notNull(),
    subjectId: varchar('subject_id', { length: 255 }).notNull(),
    version: integer('version').notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    role: varchar('role', { length: 16 }),
    mutationId: varchar('mutation_id', { length: 64 }).notNull(),
    changedByType: varchar('changed_by_type', { length: 32 }).notNull(),
    changedById: varchar('changed_by_id', { length: 255 }).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'ql3_project_role_bindings_subject_type_check',
      sql`${table.subjectType} in ('user', 'api_app', 'mcp_client', 'agent', 'system', 'worker')`,
    ),
    check(
      'ql3_project_role_bindings_subject_id_check',
      sql`char_length(${table.subjectId}) >= 1`,
    ),
    check(
      'ql3_project_role_bindings_version_check',
      sql`${table.version} between 1 and 2147483647`,
    ),
    check(
      'ql3_project_role_bindings_state_check',
      sql`${table.state} in ('active', 'revoked')`,
    ),
    check(
      'ql3_project_role_bindings_role_state_check',
      sql`(${table.state} = 'active' and ${table.role} in ('owner', 'admin', 'operator', 'viewer')) or (${table.state} = 'revoked' and ${table.role} is null)`,
    ),
    check(
      'ql3_project_role_bindings_mutation_id_check',
      sql`${table.mutationId} ~ '^[A-Za-z0-9._:-]{1,64}$'`,
    ),
    check(
      'ql3_project_role_bindings_changed_by_type_check',
      sql`${table.changedByType} in ('user', 'api_app', 'mcp_client', 'agent', 'system', 'worker')`,
    ),
    check(
      'ql3_project_role_bindings_changed_by_id_check',
      sql`char_length(${table.changedById}) >= 1`,
    ),
    check(
      'ql3_project_role_bindings_created_at_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    foreignKey({
      name: 'ql3_project_role_bindings_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('cascade'),
    primaryKey({
      name: 'project_role_bindings_pkey',
      columns: [
        table.projectId,
        table.subjectType,
        table.subjectId,
        table.version,
      ],
    }),
    index('ql3_project_role_bindings_current_idx').on(
      table.projectId,
      table.subjectType,
      table.subjectId,
      table.version,
    ),
    uniqueIndex('ql3_project_role_bindings_mutation_uidx').on(
      table.projectId,
      table.mutationId,
    ),
    index('ql3_project_role_bindings_subject_idx').on(
      table.subjectType,
      table.subjectId,
      table.projectId,
      table.version,
    ),
  ],
);

export const identitySubjects = ql3Schema.table(
  'identity_subjects',
  {
    subjectType: varchar('subject_type', { length: 32 }).notNull(),
    subjectId: varchar('subject_id', { length: 255 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    version: integer('version').notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'ql3_identity_subjects_type_check',
      sql`${table.subjectType} in ('user', 'api_app', 'mcp_client', 'agent', 'system', 'worker')`,
    ),
    check(
      'ql3_identity_subjects_id_check',
      sql`char_length(${table.subjectId}) >= 1`,
    ),
    check(
      'ql3_identity_subjects_status_check',
      sql`${table.status} in ('active', 'disabled')`,
    ),
    check(
      'ql3_identity_subjects_version_check',
      sql`${table.version} between 1 and 2147483647`,
    ),
    check(
      'ql3_identity_subjects_created_at_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_identity_subjects_updated_at_check',
      sql`${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    primaryKey({
      name: 'identity_subjects_pkey',
      columns: [table.subjectType, table.subjectId],
    }),
    index('ql3_identity_subjects_status_idx').on(
      table.status,
      table.subjectType,
      table.subjectId,
    ),
  ],
);

export const apiCredentials = ql3Schema.table(
  'api_credentials',
  {
    credentialId: varchar('credential_id', { length: 64 }).notNull(),
    version: integer('version').notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    subjectType: varchar('subject_type', { length: 32 }).notNull(),
    subjectId: varchar('subject_id', { length: 255 }).notNull(),
    pepperKeyId: varchar('pepper_key_id', { length: 64 }).notNull(),
    secretDigest: char('secret_digest', { length: 64 }).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    notBeforeAtMs: bigint('not_before_at_ms', { mode: 'number' }).notNull(),
    expiresAtMs: bigint('expires_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'ql3_api_credentials_id_check',
      sql`${table.credentialId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'`,
    ),
    check(
      'ql3_api_credentials_version_check',
      sql`${table.version} between 1 and 2147483647`,
    ),
    check(
      'ql3_api_credentials_state_check',
      sql`${table.state} in ('active', 'revoked')`,
    ),
    check(
      'ql3_api_credentials_subject_type_check',
      sql`${table.subjectType} in ('user', 'api_app', 'mcp_client', 'agent')`,
    ),
    check(
      'ql3_api_credentials_subject_id_check',
      sql`char_length(${table.subjectId}) >= 1`,
    ),
    check(
      'ql3_api_credentials_pepper_key_id_check',
      sql`${table.pepperKeyId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'`,
    ),
    check(
      'ql3_api_credentials_secret_digest_check',
      sql`${table.secretDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'ql3_api_credentials_created_at_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_api_credentials_not_before_check',
      sql`${table.notBeforeAtMs} >= ${table.createdAtMs}`,
    ),
    check(
      'ql3_api_credentials_expires_at_check',
      sql`${table.expiresAtMs} > ${table.notBeforeAtMs}`,
    ),
    primaryKey({
      name: 'api_credentials_pkey',
      columns: [table.credentialId, table.version],
    }),
    foreignKey({
      name: 'ql3_api_credentials_subject_fk',
      columns: [table.subjectType, table.subjectId],
      foreignColumns: [
        identitySubjects.subjectType,
        identitySubjects.subjectId,
      ],
    }).onDelete('restrict'),
    index('ql3_api_credentials_current_idx').on(
      table.credentialId,
      table.version,
    ),
    index('ql3_api_credentials_subject_idx').on(
      table.subjectType,
      table.subjectId,
      table.credentialId,
      table.version,
    ),
  ],
);

export const securityAuditEvents = ql3Schema.table(
  'security_audit_events',
  {
    eventId: uuid('event_id').primaryKey(),
    requestId: varchar('request_id', { length: 128 }).notNull(),
    operationId: varchar('operation_id', { length: 128 }).notNull(),
    projectId: varchar('project_id', { length: 128 }),
    subjectType: varchar('subject_type', { length: 32 }),
    subjectId: varchar('subject_id', { length: 255 }),
    authenticationId: varchar('authentication_id', { length: 128 }),
    outcome: varchar('outcome', { length: 32 }).notNull(),
    reasons: jsonb('reasons').$type<readonly string[]>().notNull(),
    projectVersion: integer('project_version'),
    bindingVersion: integer('binding_version'),
    occurredAtMs: bigint('occurred_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'ql3_security_audit_events_request_id_check',
      sql`${table.requestId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_security_audit_events_operation_id_check',
      sql`${table.operationId} ~ '^[a-z][a-z0-9_.:-]{0,127}$'`,
    ),
    check(
      'ql3_security_audit_events_project_id_check',
      sql`${table.projectId} is null or ${table.projectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_security_audit_events_subject_type_check',
      sql`${table.subjectType} is null or ${table.subjectType} in ('user', 'api_app', 'mcp_client', 'agent', 'system', 'worker')`,
    ),
    check(
      'ql3_security_audit_events_subject_id_check',
      sql`${table.subjectId} is null or char_length(${table.subjectId}) >= 1`,
    ),
    check(
      'ql3_security_audit_events_authentication_id_check',
      sql`${table.authenticationId} is null or ${table.authenticationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_security_audit_events_outcome_check',
      sql`${table.outcome} in ('authentication_rejected', 'authentication_unavailable', 'authorization_unavailable', 'denied', 'approval_required', 'allowed')`,
    ),
    check(
      'ql3_security_audit_events_reasons_check',
      sql`jsonb_typeof(${table.reasons}) = 'array' and jsonb_array_length(${table.reasons}) between 1 and 8 and octet_length(${table.reasons}::text) <= 1024`,
    ),
    check(
      'ql3_security_audit_events_project_version_check',
      sql`${table.projectVersion} is null or ${table.projectVersion} >= 1`,
    ),
    check(
      'ql3_security_audit_events_binding_version_check',
      sql`${table.bindingVersion} is null or ${table.bindingVersion} >= 1`,
    ),
    check(
      'ql3_security_audit_events_occurred_at_check',
      sql`${table.occurredAtMs} >= 0`,
    ),
    check(
      'ql3_security_audit_events_identity_check',
      sql`(${table.outcome} in ('authentication_rejected', 'authentication_unavailable') and ${table.subjectType} is null and ${table.subjectId} is null and ${table.authenticationId} is null) or (${table.outcome} not in ('authentication_rejected', 'authentication_unavailable') and ${table.subjectType} is not null and ${table.subjectId} is not null and ${table.authenticationId} is not null)`,
    ),
    check(
      'ql3_security_audit_events_fence_check',
      sql`${table.projectVersion} is not null or ${table.bindingVersion} is null`,
    ),
    index('ql3_security_audit_events_occurred_idx').on(
      table.occurredAtMs,
      table.eventId,
    ),
    index('ql3_security_audit_events_subject_idx')
      .on(table.subjectType, table.subjectId, table.occurredAtMs, table.eventId)
      .where(sql`${table.subjectType} is not null`),
    index('ql3_security_audit_events_project_idx')
      .on(table.projectId, table.occurredAtMs, table.eventId)
      .where(sql`${table.projectId} is not null`),
  ],
);

export const pluginPackageAdmissionReceipts = ql3Schema.table(
  'plugin_package_admission_receipts',
  {
    dispatchId: varchar('dispatch_id', { length: 128 }).primaryKey(),
    dispatchDigest: char('dispatch_digest', { length: 64 }).notNull(),
    approvalRequestId: varchar('approval_request_id', {
      length: 128,
    }).notNull(),
    actionRef: varchar('action_ref', { length: 255 }).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 64 }).notNull(),
    installationId: varchar('installation_id', { length: 128 }).notNull(),
    lockDigest: char('lock_digest', { length: 64 }).notNull(),
    recordDigest: char('record_digest', { length: 64 }).notNull(),
    mutationId: varchar('mutation_id', { length: 128 }).notNull(),
    mutationDigest: char('mutation_digest', { length: 64 }).notNull(),
    auditEventId: uuid('audit_event_id').notNull(),
    admittedAtMs: bigint('admitted_at_ms', { mode: 'number' }).notNull(),
    receiptJson: jsonb('receipt_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    receiptDigest: char('receipt_digest', { length: 64 }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_admission_dispatch_fk',
      columns: [table.dispatchId],
      foreignColumns: [approvedActionDispatches.dispatchId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_admission_request_fk',
      columns: [table.approvalRequestId],
      foreignColumns: [approvalRequests.requestId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_admission_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_admission_install_fk',
      columns: [table.installationId],
      foreignColumns: [pluginPackageInstalls.installationId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_admission_audit_fk',
      columns: [table.auditEventId],
      foreignColumns: [securityAuditEvents.eventId],
    }).onDelete('restrict'),
    check(
      'ql3_plugin_package_admission_identity_check',
      sql`${table.dispatchId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.approvalRequestId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.actionRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' and ${table.projectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' and ${table.installationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.mutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_plugin_package_admission_digest_check',
      sql`${table.dispatchDigest} ~ '^[0-9a-f]{64}$' and ${table.lockDigest} ~ '^[0-9a-f]{64}$' and ${table.recordDigest} ~ '^[0-9a-f]{64}$' and ${table.mutationDigest} ~ '^[0-9a-f]{64}$' and ${table.receiptDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_admission_json_check',
      sql`jsonb_typeof(${table.receiptJson}) = 'object' and octet_length(${table.receiptJson}::text) between 2 and 65536 and ${table.receiptJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-admission-receipt@v1', 'dispatchId', ${table.dispatchId}, 'dispatchDigest', ${table.dispatchDigest}, 'approvalRequestId', ${table.approvalRequestId}, 'actionRef', ${table.actionRef}, 'projectId', ${table.projectId}, 'packageName', ${table.packageName}, 'installationId', ${table.installationId}, 'lockDigest', ${table.lockDigest}, 'recordDigest', ${table.recordDigest}, 'mutationId', ${table.mutationId}, 'mutationDigest', ${table.mutationDigest}, 'auditEventId', ${table.auditEventId}::text, 'admittedAtMs', ${table.admittedAtMs}, 'receiptDigest', ${table.receiptDigest})`,
    ),
    check(
      'ql3_plugin_package_admission_time_check',
      sql`${table.admittedAtMs} >= 0`,
    ),
    uniqueIndex('ql3_plugin_package_admission_install_uidx').on(
      table.installationId,
    ),
    uniqueIndex('ql3_plugin_package_admission_audit_uidx').on(
      table.auditEventId,
    ),
    index('ql3_plugin_package_admission_project_idx').on(
      table.projectId,
      table.admittedAtMs,
      table.dispatchId,
    ),
  ],
);

export const identitySubjectMutations = ql3Schema.table(
  'identity_subject_mutations',
  {
    mutationId: uuid('mutation_id').primaryKey(),
    operation: varchar('operation', { length: 16 }).notNull(),
    subjectType: varchar('subject_type', { length: 32 }).notNull(),
    subjectId: varchar('subject_id', { length: 255 }).notNull(),
    subjectVersion: integer('subject_version').notNull(),
    expectedPreviousVersion: integer('expected_previous_version').notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    changedByType: varchar('changed_by_type', { length: 32 }).notNull(),
    changedById: varchar('changed_by_id', { length: 255 }).notNull(),
    auditEventId: uuid('audit_event_id').notNull(),
    identityCreatedAtMs: bigint('identity_created_at_ms', {
      mode: 'number',
    }).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'ql3_identity_subject_mutations_operation_check',
      sql`${table.operation} in ('import', 'register', 'enable', 'disable')`,
    ),
    check(
      'ql3_identity_subject_mutations_subject_type_check',
      sql`${table.subjectType} in ('user', 'api_app', 'mcp_client', 'agent', 'system', 'worker')`,
    ),
    check(
      'ql3_identity_subject_mutations_subject_id_check',
      sql`char_length(${table.subjectId}) >= 1`,
    ),
    check(
      'ql3_identity_subject_mutations_version_check',
      sql`${table.subjectVersion} between 1 and 2147483647`,
    ),
    check(
      'ql3_identity_subject_mutations_previous_version_check',
      sql`${table.expectedPreviousVersion} between 0 and 2147483646`,
    ),
    check(
      'ql3_identity_subject_mutations_status_check',
      sql`${table.status} in ('active', 'disabled')`,
    ),
    check(
      'ql3_identity_subject_mutations_changed_by_type_check',
      sql`${table.changedByType} in ('user', 'system')`,
    ),
    check(
      'ql3_identity_subject_mutations_changed_by_id_check',
      sql`char_length(${table.changedById}) >= 1`,
    ),
    check(
      'ql3_identity_subject_mutations_identity_created_at_check',
      sql`${table.identityCreatedAtMs} >= 0`,
    ),
    check(
      'ql3_identity_subject_mutations_created_at_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_identity_subject_mutations_version_fence_check',
      sql`${table.subjectVersion} = ${table.expectedPreviousVersion} + 1`,
    ),
    check(
      'ql3_identity_subject_mutations_transition_check',
      sql`${table.operation} = 'import' or (${table.operation} = 'register' and ${table.expectedPreviousVersion} = 0 and ${table.status} = 'active') or (${table.operation} = 'enable' and ${table.expectedPreviousVersion} >= 1 and ${table.status} = 'active') or (${table.operation} = 'disable' and ${table.expectedPreviousVersion} >= 1 and ${table.status} = 'disabled')`,
    ),
    check(
      'ql3_identity_subject_mutations_audit_identity_check',
      sql`${table.mutationId} = ${table.auditEventId}`,
    ),
    foreignKey({
      name: 'ql3_identity_subject_mutations_subject_fk',
      columns: [table.subjectType, table.subjectId],
      foreignColumns: [
        identitySubjects.subjectType,
        identitySubjects.subjectId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_identity_subject_mutations_audit_fk',
      columns: [table.auditEventId],
      foreignColumns: [securityAuditEvents.eventId],
    }).onDelete('restrict'),
    uniqueIndex('ql3_identity_subject_mutations_subject_version_uidx').on(
      table.subjectType,
      table.subjectId,
      table.subjectVersion,
    ),
    index('ql3_identity_subject_mutations_actor_idx').on(
      table.changedByType,
      table.changedById,
      table.createdAtMs,
      table.mutationId,
    ),
  ],
);

export const apiCredentialMutations = ql3Schema.table(
  'api_credential_mutations',
  {
    mutationId: uuid('mutation_id').primaryKey(),
    operation: varchar('operation', { length: 16 }).notNull(),
    credentialId: varchar('credential_id', { length: 64 }).notNull(),
    credentialVersion: integer('credential_version').notNull(),
    expectedPreviousVersion: integer('expected_previous_version').notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    subjectType: varchar('subject_type', { length: 32 }).notNull(),
    subjectId: varchar('subject_id', { length: 255 }).notNull(),
    subjectStatus: varchar('subject_status', { length: 16 }).notNull(),
    changedByType: varchar('changed_by_type', { length: 32 }).notNull(),
    changedById: varchar('changed_by_id', { length: 255 }).notNull(),
    auditEventId: uuid('audit_event_id').notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'ql3_api_credential_mutations_operation_check',
      sql`${table.operation} in ('import', 'issue', 'rotate', 'revoke')`,
    ),
    check(
      'ql3_api_credential_mutations_id_check',
      sql`${table.credentialId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'`,
    ),
    check(
      'ql3_api_credential_mutations_version_check',
      sql`${table.credentialVersion} between 1 and 2147483647`,
    ),
    check(
      'ql3_api_credential_mutations_previous_version_check',
      sql`${table.expectedPreviousVersion} between 0 and 2147483646`,
    ),
    check(
      'ql3_api_credential_mutations_state_check',
      sql`${table.state} in ('active', 'revoked')`,
    ),
    check(
      'ql3_api_credential_mutations_subject_type_check',
      sql`${table.subjectType} in ('user', 'api_app', 'mcp_client', 'agent')`,
    ),
    check(
      'ql3_api_credential_mutations_subject_id_check',
      sql`char_length(${table.subjectId}) >= 1`,
    ),
    check(
      'ql3_api_credential_mutations_subject_status_check',
      sql`${table.subjectStatus} in ('active', 'disabled')`,
    ),
    check(
      'ql3_api_credential_mutations_changed_by_type_check',
      sql`${table.changedByType} in ('user', 'system')`,
    ),
    check(
      'ql3_api_credential_mutations_changed_by_id_check',
      sql`char_length(${table.changedById}) >= 1`,
    ),
    check(
      'ql3_api_credential_mutations_created_at_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_api_credential_mutations_version_fence_check',
      sql`${table.credentialVersion} = ${table.expectedPreviousVersion} + 1`,
    ),
    check(
      'ql3_api_credential_mutations_transition_check',
      sql`${table.operation} = 'import' or (${table.operation} = 'issue' and ${table.expectedPreviousVersion} = 0 and ${table.state} = 'active') or (${table.operation} = 'rotate' and ${table.expectedPreviousVersion} >= 1 and ${table.state} = 'active') or (${table.operation} = 'revoke' and ${table.expectedPreviousVersion} >= 1 and ${table.state} = 'revoked')`,
    ),
    check(
      'ql3_api_credential_mutations_audit_identity_check',
      sql`${table.mutationId} = ${table.auditEventId}`,
    ),
    foreignKey({
      name: 'ql3_api_credential_mutations_credential_fk',
      columns: [table.credentialId, table.credentialVersion],
      foreignColumns: [apiCredentials.credentialId, apiCredentials.version],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_api_credential_mutations_subject_fk',
      columns: [table.subjectType, table.subjectId],
      foreignColumns: [
        identitySubjects.subjectType,
        identitySubjects.subjectId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_api_credential_mutations_audit_fk',
      columns: [table.auditEventId],
      foreignColumns: [securityAuditEvents.eventId],
    }).onDelete('restrict'),
    uniqueIndex('ql3_api_credential_mutations_credential_version_uidx').on(
      table.credentialId,
      table.credentialVersion,
    ),
    index('ql3_api_credential_mutations_actor_idx').on(
      table.changedByType,
      table.changedById,
      table.createdAtMs,
      table.mutationId,
    ),
  ],
);

export const runs = ql3Schema.table(
  'runs',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    taskId: varchar('task_id', { length: 255 }).notNull(),
    taskRevision: varchar('task_revision', { length: 128 }).notNull(),
    taskName: varchar('task_name', { length: 255 }),
    taskSnapshotRef: varchar('task_snapshot_ref', { length: 512 }),
    legacyCronId: integer('legacy_cron_id'),
    parentRunId: varchar('parent_run_id', { length: 36 }),
    retryOfRunId: varchar('retry_of_run_id', { length: 36 }),
    triggerId: varchar('trigger_id', { length: 128 }),
    triggerType: varchar('trigger_type', { length: 64 }).notNull(),
    executionOrigin: varchar('execution_origin', { length: 64 }).notNull(),
    executionOwner: varchar('execution_owner', { length: 16 }).notNull(),
    triggeredBy: varchar('triggered_by', { length: 255 }),
    requestId: varchar('request_id', { length: 128 }),
    scheduledForMs: bigint('scheduled_for_ms', { mode: 'number' }),
    status: varchar('status', { length: 32 }).notNull(),
    version: integer('version').default(0).notNull(),
    eventSequence: integer('event_sequence').default(0).notNull(),
    priority: integer('priority').default(0).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }),
    inputRef: varchar('input_ref', { length: 512 }),
    outputRef: varchar('output_ref', { length: 512 }),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    queuedAtMs: bigint('queued_at_ms', { mode: 'number' }),
    startedAtMs: bigint('started_at_ms', { mode: 'number' }),
    finishedAtMs: bigint('finished_at_ms', { mode: 'number' }),
    cancelRequestedAtMs: bigint('cancel_requested_at_ms', { mode: 'number' }),
    cancelReason: varchar('cancel_reason', { length: 16 }),
    errorCode: varchar('error_code', { length: 128 }),
    errorSummary: varchar('error_summary', { length: 1024 }),
  },
  (table) => [
    check(
      'ql3_runs_legacy_cron_id_check',
      sql`${table.legacyCronId} is null or ${table.legacyCronId} >= 1`,
    ),
    check(
      'ql3_runs_execution_owner_check',
      sql`${table.executionOwner} = 'runtime'`,
    ),
    check(
      'ql3_runs_scheduled_for_check',
      sql`${table.scheduledForMs} is null or ${table.scheduledForMs} >= 0`,
    ),
    check(
      'ql3_runs_status_check',
      sql`${table.status} in ('created', 'queued', 'dispatching', 'running', 'waiting_approval', 'retry_wait', 'lost', 'succeeded', 'failed', 'cancelled', 'timed_out')`,
    ),
    check('ql3_runs_version_check', sql`${table.version} >= 0`),
    check('ql3_runs_event_sequence_check', sql`${table.eventSequence} >= 0`),
    check('ql3_runs_created_at_check', sql`${table.createdAtMs} >= 0`),
    check(
      'ql3_runs_queued_at_check',
      sql`${table.queuedAtMs} is null or ${table.queuedAtMs} >= 0`,
    ),
    check(
      'ql3_runs_started_at_check',
      sql`${table.startedAtMs} is null or ${table.startedAtMs} >= 0`,
    ),
    check(
      'ql3_runs_finished_at_check',
      sql`${table.finishedAtMs} is null or ${table.finishedAtMs} >= 0`,
    ),
    check(
      'ql3_runs_cancel_requested_at_check',
      sql`${table.cancelRequestedAtMs} is null or ${table.cancelRequestedAtMs} >= 0`,
    ),
    check(
      'ql3_runs_cancel_reason_check',
      sql`${table.cancelReason} is null or ${table.cancelReason} in ('user', 'policy', 'shutdown', 'reconcile', 'timeout')`,
    ),
    foreignKey({
      name: 'ql3_runs_parent_fk',
      columns: [table.parentRunId],
      foreignColumns: [table.id],
    }),
    foreignKey({
      name: 'ql3_runs_retry_of_fk',
      columns: [table.retryOfRunId],
      foreignColumns: [table.id],
    }),
    uniqueIndex('ql3_runs_project_idempotency_uidx')
      .on(table.projectId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index('ql3_runs_project_created_idx').on(
      table.projectId,
      table.createdAtMs,
      table.id,
    ),
    index('ql3_runs_task_created_idx').on(
      table.taskId,
      table.createdAtMs,
      table.id,
    ),
    index('ql3_runs_dispatch_candidates_idx')
      .on(table.priority.desc(), table.queuedAtMs, table.id)
      .where(
        sql`${table.executionOwner} = 'runtime' and ${table.status} in ('queued', 'dispatching') and ${table.cancelRequestedAtMs} is null and ${table.queuedAtMs} is not null`,
      ),
    index('ql3_runs_runtime_recovery_idx')
      .on(table.createdAtMs, table.id)
      .where(
        sql`${table.executionOwner} = 'runtime' and ${table.status} in ('created', 'dispatching', 'running')`,
      ),
    index('ql3_runs_lost_retry_idx').on(
      table.executionOwner,
      table.status,
      table.id,
    ),
  ],
);

export const stepRuns = ql3Schema.table(
  'step_runs',
  {
    id: varchar('id', { length: 128 }).primaryKey(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    parentStepRunId: varchar('parent_step_run_id', { length: 128 }),
    stepKey: varchar('step_key', { length: 128 }).notNull(),
    kind: varchar('kind', { length: 32 }).notNull(),
    definitionRef: varchar('definition_ref', { length: 512 }).notNull(),
    definitionDigest: char('definition_digest', { length: 64 }).notNull(),
    required: boolean('required').notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    version: integer('version').notNull(),
    attemptCount: integer('attempt_count').notNull(),
    inputRef: varchar('input_ref', { length: 512 }),
    outputRef: varchar('output_ref', { length: 512 }),
    approvalRequestId: varchar('approval_request_id', { length: 128 }),
    readyAtMs: bigint('ready_at_ms', { mode: 'number' }),
    startedAtMs: bigint('started_at_ms', { mode: 'number' }),
    finishedAtMs: bigint('finished_at_ms', { mode: 'number' }),
    resultCode: varchar('result_code', { length: 64 }),
    errorSummary: varchar('error_summary', { length: 2048 }),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
    lastMutationId: varchar('last_mutation_id', { length: 128 }).notNull(),
    stepRunDigest: char('step_run_digest', { length: 64 }).notNull(),
    stepRunJson: jsonb('step_run_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_step_runs_run_fk',
      columns: [table.runId],
      foreignColumns: [runs.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ql3_step_runs_parent_fk',
      columns: [table.runId, table.parentStepRunId],
      foreignColumns: [table.runId, table.id],
    }).onDelete('restrict'),
    check(
      'ql3_step_runs_identity_check',
      sql`${table.id} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.runId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and (${table.parentStepRunId} is null or (${table.parentStepRunId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.parentStepRunId} <> ${table.id})) and ${table.stepKey} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and octet_length(${table.definitionRef}) between 1 and 512`,
    ),
    check(
      'ql3_step_runs_kind_check',
      sql`${table.kind} in ('task','tool','model','agent','condition','approval','subworkflow')`,
    ),
    check(
      'ql3_step_runs_status_check',
      sql`${table.status} in ('pending','ready','waiting_approval','running','lost','succeeded','failed','skipped','cancelled','timed_out')`,
    ),
    check(
      'ql3_step_runs_digest_check',
      sql`${table.definitionDigest} ~ '^[0-9a-f]{64}$' and ${table.stepRunDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_step_runs_counter_check',
      sql`${table.version} between 1 and 2147483647 and ${table.attemptCount} between 0 and 64`,
    ),
    check(
      'ql3_step_runs_reference_check',
      sql`(${table.inputRef} is null or octet_length(${table.inputRef}) between 1 and 512) and (${table.outputRef} is null or octet_length(${table.outputRef}) between 1 and 512) and (${table.approvalRequestId} is null or ${table.approvalRequestId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')`,
    ),
    check(
      'ql3_step_runs_time_check',
      sql`${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs} and (${table.readyAtMs} is null or ${table.readyAtMs} between ${table.createdAtMs} and ${table.updatedAtMs}) and (${table.startedAtMs} is null or (${table.readyAtMs} is not null and ${table.startedAtMs} between ${table.readyAtMs} and ${table.updatedAtMs})) and (${table.finishedAtMs} is null or (${table.finishedAtMs} between ${table.createdAtMs} and ${table.updatedAtMs} and (${table.readyAtMs} is null or ${table.finishedAtMs} >= ${table.readyAtMs}) and (${table.startedAtMs} is null or ${table.finishedAtMs} >= ${table.startedAtMs})))`,
    ),
    check(
      'ql3_step_runs_state_shape_check',
      sql`(${table.status} = 'pending' and ${table.readyAtMs} is null and ${table.startedAtMs} is null and ${table.finishedAtMs} is null) or (${table.status} in ('ready','waiting_approval') and ${table.readyAtMs} is not null and ${table.startedAtMs} is null and ${table.finishedAtMs} is null) or (${table.status} in ('running','lost') and ${table.readyAtMs} is not null and ${table.startedAtMs} is not null and ${table.finishedAtMs} is null) or (${table.status} in ('succeeded','failed','skipped','cancelled','timed_out') and ${table.finishedAtMs} is not null)`,
    ),
    check(
      'ql3_step_runs_approval_shape_check',
      sql`${table.status} <> 'waiting_approval' or ${table.approvalRequestId} is not null`,
    ),
    check(
      'ql3_step_runs_result_shape_check',
      sql`(${table.outputRef} is null or ${table.status} = 'succeeded') and ((${table.status} = 'succeeded' and ${table.resultCode} is null and ${table.errorSummary} is null) or (${table.status} in ('failed','skipped','cancelled','timed_out','lost') and ${table.resultCode} is not null) or (${table.status} in ('pending','ready','waiting_approval','running') and ${table.resultCode} is null and ${table.errorSummary} is null)) and (${table.resultCode} is null or ${table.resultCode} ~ '^[a-z][a-z0-9_]{0,63}$') and (${table.errorSummary} is null or octet_length(${table.errorSummary}) between 1 and 2048)`,
    ),
    check(
      'ql3_step_runs_mutation_identity_check',
      sql`${table.lastMutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_step_runs_json_check',
      sql`jsonb_typeof(${table.stepRunJson}) = 'object' and octet_length(${table.stepRunJson}::text) between 2 and 16384 and ${table.stepRunJson} @> jsonb_build_object('schema', 'qinglong/step-run@v1', 'id', ${table.id}, 'runId', ${table.runId}, 'parentStepRunId', ${table.parentStepRunId}, 'stepKey', ${table.stepKey}, 'kind', ${table.kind}, 'definitionRef', ${table.definitionRef}, 'definitionDigest', ${table.definitionDigest}, 'required', ${table.required}, 'status', ${table.status}, 'version', ${table.version}, 'attemptCount', ${table.attemptCount}, 'inputRef', ${table.inputRef}, 'outputRef', ${table.outputRef}, 'approvalRequestId', ${table.approvalRequestId}, 'readyAtMs', ${table.readyAtMs}, 'startedAtMs', ${table.startedAtMs}, 'finishedAtMs', ${table.finishedAtMs}, 'resultCode', ${table.resultCode}, 'errorSummary', ${table.errorSummary}, 'createdAtMs', ${table.createdAtMs}, 'updatedAtMs', ${table.updatedAtMs}, 'lastMutationId', ${table.lastMutationId}, 'stepRunDigest', ${table.stepRunDigest})`,
    ),
    uniqueIndex('ql3_step_runs_run_id_uidx').on(table.runId, table.id),
    uniqueIndex('ql3_step_runs_run_step_uidx').on(table.runId, table.stepKey),
    index('ql3_step_runs_run_status_idx').on(
      table.runId,
      table.status,
      table.id,
    ),
    index('ql3_step_runs_recovery_idx')
      .on(table.status, table.updatedAtMs, table.id)
      .where(sql`${table.status} in ('waiting_approval','running','lost')`),
  ],
);

export const toolExecutionTraceAnchors = ql3Schema.table(
  'tool_execution_trace_anchors',
  {
    traceId: char('trace_id', { length: 32 }).notNull(),
    spanId: char('span_id', { length: 16 }).notNull(),
    parentSpanId: char('parent_span_id', { length: 16 }),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    stepRunId: varchar('step_run_id', { length: 128 }).notNull(),
    invocationPlanDigest: char('invocation_plan_digest', {
      length: 64,
    }).notNull(),
    bindingDigest: char('binding_digest', { length: 64 }).notNull(),
    adapterDigest: char('adapter_digest', { length: 64 }).notNull(),
    redactionContractDigest: char('redaction_contract_digest', {
      length: 64,
    }).notNull(),
    auditContractDigest: char('audit_contract_digest', {
      length: 64,
    }).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    traceDigest: char('trace_digest', { length: 64 }).notNull(),
    traceJson: jsonb('trace_json').$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    primaryKey({
      name: 'tool_execution_trace_anchors_pkey',
      columns: [table.traceId, table.spanId],
    }),
    foreignKey({
      name: 'ql3_tool_execution_trace_step_fk',
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
    }).onDelete('cascade'),
    check(
      'ql3_tool_execution_trace_identity_check',
      sql`${table.traceId} ~ '^[0-9a-f]{32}$' and ${table.spanId} ~ '^[0-9a-f]{16}$' and (${table.parentSpanId} is null or (${table.parentSpanId} ~ '^[0-9a-f]{16}$' and ${table.parentSpanId} <> ${table.spanId})) and ${table.projectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.runId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.stepRunId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_tool_execution_trace_digest_check',
      sql`${table.invocationPlanDigest} ~ '^[0-9a-f]{64}$' and ${table.bindingDigest} ~ '^[0-9a-f]{64}$' and ${table.adapterDigest} ~ '^[0-9a-f]{64}$' and ${table.redactionContractDigest} ~ '^[0-9a-f]{64}$' and ${table.auditContractDigest} ~ '^[0-9a-f]{64}$' and ${table.traceDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_tool_execution_trace_time_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_tool_execution_trace_json_check',
      sql`jsonb_typeof(${table.traceJson}) = 'object' and octet_length(${table.traceJson}::text) between 2 and 16384 and ${table.traceJson} @> jsonb_build_object('schema', 'qinglong/tool-execution-trace-anchor@v1', 'traceId', ${table.traceId}, 'spanId', ${table.spanId}, 'parentSpanId', ${table.parentSpanId}, 'projectId', ${table.projectId}, 'runId', ${table.runId}, 'stepRunId', ${table.stepRunId}, 'invocationPlanDigest', ${table.invocationPlanDigest}, 'bindingDigest', ${table.bindingDigest}, 'adapterDigest', ${table.adapterDigest}, 'redactionContractDigest', ${table.redactionContractDigest}, 'auditContractDigest', ${table.auditContractDigest}, 'createdAtMs', ${table.createdAtMs}, 'traceDigest', ${table.traceDigest})`,
    ),
    index('ql3_tool_execution_trace_run_idx').on(
      table.runId,
      table.createdAtMs,
      table.traceId,
      table.spanId,
    ),
    index('ql3_tool_execution_trace_step_idx').on(
      table.runId,
      table.stepRunId,
      table.createdAtMs,
      table.traceId,
      table.spanId,
    ),
  ],
);

export const toolExecutionAuditReceipts = ql3Schema.table(
  'tool_execution_audit_receipts',
  {
    eventId: uuid('event_id').primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    stepRunId: varchar('step_run_id', { length: 128 }).notNull(),
    traceId: char('trace_id', { length: 32 }).notNull(),
    spanId: char('span_id', { length: 16 }).notNull(),
    traceDigest: char('trace_digest', { length: 64 }).notNull(),
    invocationPlanDigest: char('invocation_plan_digest', {
      length: 64,
    }).notNull(),
    bindingDigest: char('binding_digest', { length: 64 }).notNull(),
    auditRecordDigest: char('audit_record_digest', {
      length: 64,
    }).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    receiptDigest: char('receipt_digest', { length: 64 }).notNull(),
    auditJson: jsonb('audit_json').$type<Record<string, unknown>>().notNull(),
    receiptJson: jsonb('receipt_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_tool_execution_audit_event_fk',
      columns: [table.eventId],
      foreignColumns: [securityAuditEvents.eventId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_execution_audit_trace_fk',
      columns: [table.traceId, table.spanId],
      foreignColumns: [
        toolExecutionTraceAnchors.traceId,
        toolExecutionTraceAnchors.spanId,
      ],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ql3_tool_execution_audit_step_fk',
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
    }).onDelete('cascade'),
    check(
      'ql3_tool_execution_audit_identity_check',
      sql`${table.projectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.runId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.stepRunId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.traceId} ~ '^[0-9a-f]{32}$' and ${table.spanId} ~ '^[0-9a-f]{16}$'`,
    ),
    check(
      'ql3_tool_execution_audit_digest_check',
      sql`${table.traceDigest} ~ '^[0-9a-f]{64}$' and ${table.invocationPlanDigest} ~ '^[0-9a-f]{64}$' and ${table.bindingDigest} ~ '^[0-9a-f]{64}$' and ${table.auditRecordDigest} ~ '^[0-9a-f]{64}$' and ${table.receiptDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_tool_execution_audit_time_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_tool_execution_audit_json_check',
      sql`jsonb_typeof(${table.auditJson}) = 'object' and octet_length(${table.auditJson}::text) between 2 and 8192 and ${table.auditJson} @> jsonb_build_object('eventId', ${table.eventId}, 'projectId', ${table.projectId}, 'operationId', 'tool.invoke.start', 'outcome', 'allowed', 'occurredAtMs', ${table.createdAtMs}) and jsonb_typeof(${table.auditJson} -> 'fence') = 'object'`,
    ),
    check(
      'ql3_tool_execution_audit_receipt_json_check',
      sql`jsonb_typeof(${table.receiptJson}) = 'object' and octet_length(${table.receiptJson}::text) between 2 and 16384 and ${table.receiptJson} @> jsonb_build_object('schema', 'qinglong/tool-execution-audit-receipt@v1', 'eventId', ${table.eventId}, 'projectId', ${table.projectId}, 'runId', ${table.runId}, 'stepRunId', ${table.stepRunId}, 'traceId', ${table.traceId}, 'spanId', ${table.spanId}, 'traceDigest', ${table.traceDigest}, 'invocationPlanDigest', ${table.invocationPlanDigest}, 'bindingDigest', ${table.bindingDigest}, 'auditRecordDigest', ${table.auditRecordDigest}, 'createdAtMs', ${table.createdAtMs}, 'receiptDigest', ${table.receiptDigest})`,
    ),
    uniqueIndex('ql3_tool_execution_audit_trace_uidx').on(
      table.traceId,
      table.spanId,
    ),
    index('ql3_tool_execution_audit_run_idx').on(
      table.runId,
      table.createdAtMs,
      table.traceId,
      table.spanId,
    ),
    index('ql3_tool_execution_audit_step_idx').on(
      table.runId,
      table.stepRunId,
      table.createdAtMs,
      table.eventId,
    ),
  ],
);

export const toolExecutionStartBarriers = ql3Schema.table(
  'tool_execution_start_barriers',
  {
    startId: varchar('start_id', { length: 128 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    stepRunId: varchar('step_run_id', { length: 128 }).notNull(),
    startedStepRunVersion: integer('started_step_run_version').notNull(),
    stepRunMutationId: varchar('step_run_mutation_id', {
      length: 128,
    }).notNull(),
    runEventId: varchar('run_event_id', { length: 128 }).notNull(),
    traceId: char('trace_id', { length: 32 }).notNull(),
    spanId: char('span_id', { length: 16 }).notNull(),
    auditEventId: uuid('audit_event_id').notNull(),
    commandDigest: char('command_digest', { length: 64 }).notNull(),
    barrierDigest: char('barrier_digest', { length: 64 }).notNull(),
    startedAtMs: bigint('started_at_ms', { mode: 'number' }).notNull(),
    barrierJson: jsonb('barrier_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_tool_start_step_fk',
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_start_trace_fk',
      columns: [table.traceId, table.spanId],
      foreignColumns: [
        toolExecutionTraceAnchors.traceId,
        toolExecutionTraceAnchors.spanId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_start_mutation_fk',
      columns: [table.stepRunMutationId],
      foreignColumns: [stepRunMutations.mutationId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_start_event_fk',
      columns: [table.runEventId],
      foreignColumns: [runEvents.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_start_audit_fk',
      columns: [table.auditEventId],
      foreignColumns: [toolExecutionAuditReceipts.eventId],
    }).onDelete('restrict'),
    check(
      'ql3_tool_start_identity_check',
      sql`${table.startId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.projectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.runId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.stepRunId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.stepRunMutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.runEventId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.traceId} ~ '^[0-9a-f]{32}$' and ${table.spanId} ~ '^[0-9a-f]{16}$'`,
    ),
    check(
      'ql3_tool_start_version_time_check',
      sql`${table.startedStepRunVersion} between 2 and 2147483647 and ${table.startedAtMs} >= 0`,
    ),
    check(
      'ql3_tool_start_digest_check',
      sql`${table.commandDigest} ~ '^[0-9a-f]{64}$' and ${table.barrierDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_tool_start_json_check',
      sql`jsonb_typeof(${table.barrierJson}) = 'object' and octet_length(${table.barrierJson}::text) between 2 and 16384 and ${table.barrierJson} @> jsonb_build_object('schema', 'qinglong/tool-execution-start-barrier@v1', 'startId', ${table.startId}, 'projectId', ${table.projectId}, 'runId', ${table.runId}, 'stepRunId', ${table.stepRunId}, 'startedStepRunVersion', ${table.startedStepRunVersion}, 'stepRunMutationId', ${table.stepRunMutationId}, 'runEventId', ${table.runEventId}, 'traceId', ${table.traceId}, 'spanId', ${table.spanId}, 'auditEventId', ${table.auditEventId}, 'commandDigest', ${table.commandDigest}, 'barrierDigest', ${table.barrierDigest}, 'startedAtMs', ${table.startedAtMs})`,
    ),
    uniqueIndex('ql3_tool_start_step_version_uidx').on(
      table.runId,
      table.stepRunId,
      table.startedStepRunVersion,
    ),
    uniqueIndex('ql3_tool_start_mutation_uidx').on(table.stepRunMutationId),
    uniqueIndex('ql3_tool_start_event_uidx').on(table.runEventId),
    uniqueIndex('ql3_tool_start_trace_uidx').on(table.traceId, table.spanId),
    uniqueIndex('ql3_tool_start_audit_uidx').on(table.auditEventId),
    index('ql3_tool_start_run_time_idx').on(
      table.runId,
      table.startedAtMs,
      table.startId,
    ),
  ],
);

export const toolInvocationInputArtifacts = ql3Schema.table(
  'tool_invocation_input_artifacts',
  {
    artifactId: varchar('artifact_id', { length: 128 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    actionRef: varchar('action_ref', { length: 255 }).notNull(),
    inputDigest: char('input_digest', { length: 64 }).notNull(),
    invocationActionDigest: char('invocation_action_digest', {
      length: 64,
    }).notNull(),
    artifactDigest: char('artifact_digest', { length: 64 }).notNull(),
    keyId: varchar('key_id', { length: 128 }).notNull(),
    algorithm: varchar('algorithm', { length: 32 }).notNull(),
    plaintextBytes: integer('plaintext_bytes').notNull(),
    sealedAtMs: bigint('sealed_at_ms', { mode: 'number' }).notNull(),
    artifactJson: jsonb('artifact_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_tool_input_artifact_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    check(
      'ql3_tool_input_artifact_identity_check',
      sql`${table.artifactId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.projectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.actionRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' and ${table.keyId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' and ${table.algorithm} = 'aes-256-gcm'`,
    ),
    check(
      'ql3_tool_input_artifact_digest_check',
      sql`${table.inputDigest} ~ '^[0-9a-f]{64}$' and ${table.invocationActionDigest} ~ '^[0-9a-f]{64}$' and ${table.artifactDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_tool_input_artifact_budget_check',
      sql`${table.plaintextBytes} between 0 and 65536 and ${table.sealedAtMs} >= 0`,
    ),
    check(
      'ql3_tool_input_artifact_json_check',
      sql`jsonb_typeof(${table.artifactJson}) = 'object' and octet_length(${table.artifactJson}::text) between 2 and 98304 and ${table.artifactJson} @> jsonb_build_object('schema', 'qinglong/tool-invocation-input-artifact@v1', 'artifactId', ${table.artifactId}, 'projectId', ${table.projectId}, 'actionRef', ${table.actionRef}, 'inputDigest', ${table.inputDigest}, 'invocationActionDigest', ${table.invocationActionDigest}, 'artifactDigest', ${table.artifactDigest}, 'keyId', ${table.keyId}, 'algorithm', ${table.algorithm}, 'plaintextBytes', ${table.plaintextBytes}, 'sealedAtMs', ${table.sealedAtMs})`,
    ),
    uniqueIndex('ql3_tool_input_artifact_action_uidx').on(
      table.projectId,
      table.actionRef,
    ),
    uniqueIndex('ql3_tool_input_artifact_start_binding_uidx').on(
      table.artifactId,
      table.artifactDigest,
      table.projectId,
      table.actionRef,
      table.inputDigest,
    ),
    index('ql3_tool_input_artifact_project_time_idx').on(
      table.projectId,
      table.sealedAtMs,
      table.artifactId,
    ),
  ],
);

export const toolInvocationPreviewArtifacts = ql3Schema.table(
  'tool_invocation_preview_artifacts',
  {
    artifactId: varchar('artifact_id', { length: 128 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    actionRef: varchar('action_ref', { length: 255 }).notNull(),
    actionDigest: char('action_digest', { length: 64 }).notNull(),
    previewDigest: char('preview_digest', { length: 64 }).notNull(),
    redactionContractDigest: char('redaction_contract_digest', {
      length: 64,
    }).notNull(),
    artifactDigest: char('artifact_digest', { length: 64 }).notNull(),
    byteLength: integer('byte_length').notNull(),
    sealedAtMs: bigint('sealed_at_ms', { mode: 'number' }).notNull(),
    artifactJson: jsonb('artifact_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_tool_preview_artifact_project_fk',
      columns: [table.projectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    check(
      'ql3_tool_preview_artifact_identity_check',
      sql`${table.artifactId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.projectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.actionRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$'`,
    ),
    check(
      'ql3_tool_preview_artifact_digest_check',
      sql`${table.actionDigest} ~ '^[0-9a-f]{64}$' and ${table.previewDigest} ~ '^[0-9a-f]{64}$' and ${table.redactionContractDigest} ~ '^[0-9a-f]{64}$' and ${table.artifactDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_tool_preview_artifact_budget_check',
      sql`${table.byteLength} between 2 and 8192 and ${table.sealedAtMs} >= 0`,
    ),
    check(
      'ql3_tool_preview_artifact_json_check',
      sql`jsonb_typeof(${table.artifactJson}) = 'object' and octet_length(${table.artifactJson}::text) between 2 and 16384 and ${table.artifactJson} @> jsonb_build_object('schema', 'qinglong/tool-invocation-preview-artifact@v1', 'artifactId', ${table.artifactId}, 'projectId', ${table.projectId}, 'actionRef', ${table.actionRef}, 'actionDigest', ${table.actionDigest}, 'previewDigest', ${table.previewDigest}, 'redactionContractDigest', ${table.redactionContractDigest}, 'artifactDigest', ${table.artifactDigest}, 'byteLength', ${table.byteLength}, 'sealedAtMs', ${table.sealedAtMs})`,
    ),
    uniqueIndex('ql3_tool_preview_artifact_action_uidx').on(
      table.projectId,
      table.actionRef,
    ),
    uniqueIndex('ql3_tool_preview_artifact_action_digest_uidx').on(
      table.actionDigest,
    ),
    uniqueIndex('ql3_tool_preview_artifact_start_binding_uidx').on(
      table.artifactId,
      table.artifactDigest,
      table.projectId,
      table.actionRef,
      table.actionDigest,
      table.previewDigest,
      table.redactionContractDigest,
    ),
    index('ql3_tool_preview_artifact_project_time_idx').on(
      table.projectId,
      table.sealedAtMs,
      table.artifactId,
    ),
  ],
);

export const toolExecutionStartArtifactBindings = ql3Schema.table(
  'tool_execution_start_artifact_bindings',
  {
    startId: varchar('start_id', { length: 128 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    actionRef: varchar('action_ref', { length: 255 }).notNull(),
    inputArtifactId: varchar('input_artifact_id', {
      length: 128,
    }).notNull(),
    inputArtifactDigest: char('input_artifact_digest', {
      length: 64,
    }).notNull(),
    inputDigest: char('input_digest', { length: 64 }).notNull(),
    previewArtifactId: varchar('preview_artifact_id', {
      length: 128,
    }).notNull(),
    previewArtifactDigest: char('preview_artifact_digest', {
      length: 64,
    }).notNull(),
    actionDigest: char('action_digest', { length: 64 }).notNull(),
    previewDigest: char('preview_digest', { length: 64 }).notNull(),
    redactionContractDigest: char('redaction_contract_digest', {
      length: 64,
    }).notNull(),
    boundAtMs: bigint('bound_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_tool_start_artifact_barrier_fk',
      columns: [table.startId],
      foreignColumns: [toolExecutionStartBarriers.startId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_start_input_artifact_fk',
      columns: [
        table.inputArtifactId,
        table.inputArtifactDigest,
        table.projectId,
        table.actionRef,
        table.inputDigest,
      ],
      foreignColumns: [
        toolInvocationInputArtifacts.artifactId,
        toolInvocationInputArtifacts.artifactDigest,
        toolInvocationInputArtifacts.projectId,
        toolInvocationInputArtifacts.actionRef,
        toolInvocationInputArtifacts.inputDigest,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_start_preview_artifact_fk',
      columns: [
        table.previewArtifactId,
        table.previewArtifactDigest,
        table.projectId,
        table.actionRef,
        table.actionDigest,
        table.previewDigest,
        table.redactionContractDigest,
      ],
      foreignColumns: [
        toolInvocationPreviewArtifacts.artifactId,
        toolInvocationPreviewArtifacts.artifactDigest,
        toolInvocationPreviewArtifacts.projectId,
        toolInvocationPreviewArtifacts.actionRef,
        toolInvocationPreviewArtifacts.actionDigest,
        toolInvocationPreviewArtifacts.previewDigest,
        toolInvocationPreviewArtifacts.redactionContractDigest,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_tool_start_artifact_identity_check',
      sql`${table.startId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.projectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.actionRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' and ${table.inputArtifactId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.previewArtifactId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_tool_start_artifact_digest_check',
      sql`${table.inputArtifactDigest} ~ '^[0-9a-f]{64}$' and ${table.inputDigest} ~ '^[0-9a-f]{64}$' and ${table.previewArtifactDigest} ~ '^[0-9a-f]{64}$' and ${table.actionDigest} ~ '^[0-9a-f]{64}$' and ${table.previewDigest} ~ '^[0-9a-f]{64}$' and ${table.redactionContractDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check('ql3_tool_start_artifact_time_check', sql`${table.boundAtMs} >= 0`),
    index('ql3_tool_start_artifact_input_idx').on(
      table.inputArtifactId,
      table.startId,
    ),
    index('ql3_tool_start_artifact_preview_idx').on(
      table.previewArtifactId,
      table.startId,
    ),
  ],
);

export const toolExecutionCompletions = ql3Schema.table(
  'tool_execution_completions',
  {
    startId: varchar('start_id', { length: 128 }).primaryKey(),
    artifactId: varchar('artifact_id', { length: 128 }).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    runId: varchar('run_id', { length: 128 }).notNull(),
    stepRunId: varchar('step_run_id', { length: 128 }).notNull(),
    startedStepRunVersion: integer('started_step_run_version').notNull(),
    completedStepRunVersion: integer('completed_step_run_version').notNull(),
    barrierDigest: char('barrier_digest', { length: 64 }).notNull(),
    adapterDigest: char('adapter_digest', { length: 64 }).notNull(),
    outputDigest: char('output_digest', { length: 64 }).notNull(),
    executionResultDigest: char('execution_result_digest', {
      length: 64,
    }).notNull(),
    artifactDigest: char('artifact_digest', { length: 64 }).notNull(),
    keyId: varchar('key_id', { length: 128 }).notNull(),
    algorithm: varchar('algorithm', { length: 32 }).notNull(),
    plaintextBytes: integer('plaintext_bytes').notNull(),
    stepRunMutationId: varchar('step_run_mutation_id', {
      length: 128,
    }).notNull(),
    stepRunMutationDigest: char('step_run_mutation_digest', {
      length: 64,
    }).notNull(),
    completedStepRunDigest: char('completed_step_run_digest', {
      length: 64,
    }).notNull(),
    runEventId: varchar('run_event_id', { length: 128 }).notNull(),
    completedAtMs: bigint('completed_at_ms', { mode: 'number' }).notNull(),
    completionDigest: char('completion_digest', { length: 64 }).notNull(),
    artifactJson: jsonb('artifact_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    completionJson: jsonb('completion_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_tool_completion_start_fk',
      columns: [table.startId],
      foreignColumns: [toolExecutionStartBarriers.startId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_completion_step_fk',
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_completion_mutation_fk',
      columns: [table.stepRunMutationId],
      foreignColumns: [stepRunMutations.mutationId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_completion_event_fk',
      columns: [table.runEventId],
      foreignColumns: [runEvents.id],
    }).onDelete('restrict'),
    check(
      'ql3_tool_completion_identity_check',
      sql`${table.startId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.artifactId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.projectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.runId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.stepRunId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.keyId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' and ${table.stepRunMutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.runEventId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_tool_completion_version_check',
      sql`${table.startedStepRunVersion} between 2 and 2147483646 and ${table.completedStepRunVersion} = ${table.startedStepRunVersion} + 1`,
    ),
    check(
      'ql3_tool_completion_digest_check',
      sql`${table.barrierDigest} ~ '^[0-9a-f]{64}$' and ${table.adapterDigest} ~ '^[0-9a-f]{64}$' and ${table.outputDigest} ~ '^[0-9a-f]{64}$' and ${table.executionResultDigest} ~ '^[0-9a-f]{64}$' and ${table.artifactDigest} ~ '^[0-9a-f]{64}$' and ${table.stepRunMutationDigest} ~ '^[0-9a-f]{64}$' and ${table.completedStepRunDigest} ~ '^[0-9a-f]{64}$' and ${table.completionDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_tool_completion_budget_check',
      sql`${table.algorithm} = 'aes-256-gcm' and ${table.plaintextBytes} between 0 and 262144 and ${table.completedAtMs} >= 0 and octet_length(${table.artifactJson}::text) between 2 and 393216 and octet_length(${table.completionJson}::text) between 2 and 24576`,
    ),
    check(
      'ql3_tool_completion_json_check',
      sql`jsonb_typeof(${table.artifactJson}) = 'object' and ${table.artifactJson} @> jsonb_build_object('schema', 'qinglong/tool-execution-result-artifact@v1', 'artifactId', ${table.artifactId}, 'projectId', ${table.projectId}, 'startId', ${table.startId}, 'runId', ${table.runId}, 'stepRunId', ${table.stepRunId}, 'barrierDigest', ${table.barrierDigest}, 'adapterDigest', ${table.adapterDigest}, 'outputDigest', ${table.outputDigest}, 'executionResultDigest', ${table.executionResultDigest}, 'artifactDigest', ${table.artifactDigest}, 'keyId', ${table.keyId}, 'algorithm', ${table.algorithm}, 'plaintextBytes', ${table.plaintextBytes}, 'sealedAtMs', ${table.completedAtMs}) and jsonb_typeof(${table.completionJson}) = 'object' and ${table.completionJson} @> jsonb_build_object('schema', 'qinglong/tool-execution-completion@v1', 'startId', ${table.startId}, 'projectId', ${table.projectId}, 'runId', ${table.runId}, 'stepRunId', ${table.stepRunId}, 'startedStepRunVersion', ${table.startedStepRunVersion}, 'completedStepRunVersion', ${table.completedStepRunVersion}, 'barrierDigest', ${table.barrierDigest}, 'adapterDigest', ${table.adapterDigest}, 'resultArtifact', jsonb_build_object('artifactId', ${table.artifactId}, 'artifactDigest', ${table.artifactDigest}, 'outputDigest', ${table.outputDigest}, 'executionResultDigest', ${table.executionResultDigest}), 'stepRunMutationId', ${table.stepRunMutationId}, 'stepRunMutationDigest', ${table.stepRunMutationDigest}, 'completedStepRunDigest', ${table.completedStepRunDigest}, 'runEventId', ${table.runEventId}, 'completedAtMs', ${table.completedAtMs}, 'completionDigest', ${table.completionDigest})`,
    ),
    uniqueIndex('ql3_tool_completion_artifact_uidx').on(table.artifactId),
    uniqueIndex('ql3_tool_completion_mutation_uidx').on(
      table.stepRunMutationId,
    ),
    uniqueIndex('ql3_tool_completion_event_uidx').on(table.runEventId),
    uniqueIndex('ql3_tool_completion_step_version_uidx').on(
      table.runId,
      table.stepRunId,
      table.completedStepRunVersion,
    ),
    index('ql3_tool_completion_project_time_idx').on(
      table.projectId,
      table.completedAtMs,
      table.startId,
    ),
  ],
);

export const toolExecutionFailureCompletions = ql3Schema.table(
  'tool_execution_failure_completions',
  {
    startId: varchar('start_id', { length: 128 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    runId: varchar('run_id', { length: 128 }).notNull(),
    stepRunId: varchar('step_run_id', { length: 128 }).notNull(),
    startedStepRunVersion: integer('started_step_run_version').notNull(),
    completedStepRunVersion: integer('completed_step_run_version').notNull(),
    barrierDigest: char('barrier_digest', { length: 64 }).notNull(),
    adapterDigest: char('adapter_digest', { length: 64 }).notNull(),
    outcome: varchar('outcome', { length: 16 }).notNull(),
    resultCode: varchar('result_code', { length: 64 }).notNull(),
    errorSummary: varchar('error_summary', { length: 128 }).notNull(),
    stepRunMutationId: varchar('step_run_mutation_id', {
      length: 128,
    }).notNull(),
    stepRunMutationDigest: char('step_run_mutation_digest', {
      length: 64,
    }).notNull(),
    completedStepRunDigest: char('completed_step_run_digest', {
      length: 64,
    }).notNull(),
    runEventId: varchar('run_event_id', { length: 128 }).notNull(),
    completedAtMs: bigint('completed_at_ms', { mode: 'number' }).notNull(),
    completionDigest: char('completion_digest', { length: 64 }).notNull(),
    completionJson: jsonb('completion_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_tool_failure_completion_start_fk',
      columns: [table.startId],
      foreignColumns: [toolExecutionStartBarriers.startId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_failure_completion_step_fk',
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_failure_completion_mutation_fk',
      columns: [table.stepRunMutationId],
      foreignColumns: [stepRunMutations.mutationId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_failure_completion_event_fk',
      columns: [table.runEventId],
      foreignColumns: [runEvents.id],
    }).onDelete('restrict'),
    check(
      'ql3_tool_failure_completion_identity_check',
      sql`${table.startId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.projectId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.runId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.stepRunId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.stepRunMutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.runEventId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_tool_failure_completion_version_check',
      sql`${table.startedStepRunVersion} between 2 and 2147483646 and ${table.completedStepRunVersion} = ${table.startedStepRunVersion} + 1`,
    ),
    check(
      'ql3_tool_failure_completion_digest_check',
      sql`${table.barrierDigest} ~ '^[0-9a-f]{64}$' and ${table.adapterDigest} ~ '^[0-9a-f]{64}$' and ${table.stepRunMutationDigest} ~ '^[0-9a-f]{64}$' and ${table.completedStepRunDigest} ~ '^[0-9a-f]{64}$' and ${table.completionDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_tool_failure_completion_fact_check',
      sql`(${table.outcome} = 'failed' and ${table.resultCode} = 'tool_adapter_failed' and ${table.errorSummary} = 'Trusted Tool execution failed') or (${table.outcome} = 'timed_out' and ${table.resultCode} = 'tool_deadline_exceeded' and ${table.errorSummary} = 'Trusted Tool execution deadline exceeded')`,
    ),
    check(
      'ql3_tool_failure_completion_budget_check',
      sql`${table.completedAtMs} >= 0 and octet_length(${table.completionJson}::text) between 2 and 24576`,
    ),
    check(
      'ql3_tool_failure_completion_json_check',
      sql`jsonb_typeof(${table.completionJson}) = 'object' and ${table.completionJson} @> jsonb_build_object('schema', 'qinglong/tool-execution-failure-completion@v1', 'startId', ${table.startId}, 'projectId', ${table.projectId}, 'runId', ${table.runId}, 'stepRunId', ${table.stepRunId}, 'startedStepRunVersion', ${table.startedStepRunVersion}, 'completedStepRunVersion', ${table.completedStepRunVersion}, 'barrierDigest', ${table.barrierDigest}, 'adapterDigest', ${table.adapterDigest}, 'outcome', ${table.outcome}, 'resultCode', ${table.resultCode}, 'errorSummary', ${table.errorSummary}, 'stepRunMutationId', ${table.stepRunMutationId}, 'stepRunMutationDigest', ${table.stepRunMutationDigest}, 'completedStepRunDigest', ${table.completedStepRunDigest}, 'runEventId', ${table.runEventId}, 'completedAtMs', ${table.completedAtMs}, 'completionDigest', ${table.completionDigest})`,
    ),
    uniqueIndex('ql3_tool_failure_completion_mutation_uidx').on(
      table.stepRunMutationId,
    ),
    uniqueIndex('ql3_tool_failure_completion_event_uidx').on(table.runEventId),
    uniqueIndex('ql3_tool_failure_completion_step_version_uidx').on(
      table.runId,
      table.stepRunId,
      table.completedStepRunVersion,
    ),
    index('ql3_tool_failure_completion_project_time_idx').on(
      table.projectId,
      table.completedAtMs,
      table.startId,
    ),
  ],
);

export const toolResultKeyCatalogGenerations = ql3Schema.table(
  'tool_result_key_catalog_generations',
  {
    authority: varchar('authority', { length: 64 }).notNull(),
    generation: integer('generation').notNull(),
    previousGeneration: integer('previous_generation'),
    previousCatalogDigest: char('previous_catalog_digest', { length: 64 }),
    activeKeyId: varchar('active_key_id', { length: 128 }),
    mutationKind: varchar('mutation_kind', { length: 16 }).notNull(),
    mutationId: varchar('mutation_id', { length: 128 }).notNull(),
    catalogDigest: char('catalog_digest', { length: 64 }).notNull(),
    commandDigest: char('command_digest', { length: 64 }).notNull(),
    committedAtMs: bigint('committed_at_ms', { mode: 'number' }).notNull(),
    catalogJson: jsonb('catalog_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: 'tool_result_key_catalog_generations_pkey',
      columns: [table.authority, table.generation],
    }),
    foreignKey({
      name: 'ql3_tool_result_key_catalog_previous_fk',
      columns: [
        table.authority,
        table.previousGeneration,
        table.previousCatalogDigest,
      ],
      foreignColumns: [table.authority, table.generation, table.catalogDigest],
    }).onDelete('restrict'),
    check(
      'ql3_tool_result_key_catalog_authority_check',
      sql`${table.authority} = 'trusted-tool-results'`,
    ),
    check(
      'ql3_tool_result_key_catalog_generation_check',
      sql`${table.generation} between 1 and 2147483647 and ((${table.generation} = 1 and ${table.previousGeneration} is null and ${table.previousCatalogDigest} is null and ${table.mutationKind} = 'bootstrap') or (${table.generation} > 1 and ${table.previousGeneration} = ${table.generation} - 1 and ${table.previousCatalogDigest} is not null and ${table.mutationKind} in ('rotate', 'retire', 'mark_lost', 'restore')))`,
    ),
    check(
      'ql3_tool_result_key_catalog_identity_check',
      sql`${table.activeKeyId} is null or ${table.activeKeyId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'`,
    ),
    check(
      'ql3_tool_result_key_catalog_digest_check',
      sql`(${table.previousCatalogDigest} is null or ${table.previousCatalogDigest} ~ '^[0-9a-f]{64}$') and ${table.catalogDigest} ~ '^[0-9a-f]{64}$' and ${table.commandDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_tool_result_key_catalog_budget_check',
      sql`${table.committedAtMs} >= 0 and ${table.mutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and octet_length(${table.catalogJson}::text) between 2 and 65536`,
    ),
    check(
      'ql3_tool_result_key_catalog_json_check',
      sql`jsonb_typeof(${table.catalogJson}) = 'object' and ${table.catalogJson} @> jsonb_build_object('schema', 'qinglong/tool-result-key-catalog@v1', 'generation', ${table.generation}, 'previousCatalogDigest', ${table.previousCatalogDigest}, 'activeKeyId', ${table.activeKeyId}, 'mutationKind', ${table.mutationKind}, 'mutationId', ${table.mutationId}, 'catalogDigest', ${table.catalogDigest}, 'committedAtMs', ${table.committedAtMs}) and jsonb_typeof(${table.catalogJson} -> 'keys') = 'array' and jsonb_array_length(${table.catalogJson} -> 'keys') between 1 and 64`,
    ),
    uniqueIndex('ql3_tool_result_key_catalog_generation_digest_key').on(
      table.authority,
      table.generation,
      table.catalogDigest,
    ),
    uniqueIndex('ql3_tool_result_key_catalog_mutation_key').on(
      table.mutationId,
    ),
    uniqueIndex('ql3_tool_result_key_catalog_digest_key').on(
      table.catalogDigest,
    ),
    index('ql3_tool_result_key_catalog_current_idx').on(
      table.authority,
      sql`${table.generation} desc`,
    ),
  ],
);

export const toolExecutionResultKeyBindings = ql3Schema.table(
  'tool_execution_result_key_bindings',
  {
    startId: varchar('start_id', { length: 128 }).primaryKey(),
    artifactId: varchar('artifact_id', { length: 128 }).notNull(),
    artifactDigest: char('artifact_digest', { length: 64 }).notNull(),
    catalogAuthority: varchar('catalog_authority', { length: 64 }).notNull(),
    catalogGeneration: integer('catalog_generation').notNull(),
    catalogDigest: char('catalog_digest', { length: 64 }).notNull(),
    keyId: varchar('key_id', { length: 128 }).notNull(),
    materialProof: char('material_proof', { length: 64 }).notNull(),
    bindingDigest: char('binding_digest', { length: 64 }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_tool_result_key_binding_completion_fk',
      columns: [table.startId],
      foreignColumns: [toolExecutionCompletions.startId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_result_key_binding_artifact_fk',
      columns: [table.artifactId],
      foreignColumns: [toolExecutionCompletions.artifactId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_tool_result_key_binding_catalog_fk',
      columns: [
        table.catalogAuthority,
        table.catalogGeneration,
        table.catalogDigest,
      ],
      foreignColumns: [
        toolResultKeyCatalogGenerations.authority,
        toolResultKeyCatalogGenerations.generation,
        toolResultKeyCatalogGenerations.catalogDigest,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_tool_result_key_binding_authority_check',
      sql`${table.catalogAuthority} = 'trusted-tool-results'`,
    ),
    check(
      'ql3_tool_result_key_binding_identity_check',
      sql`${table.startId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.artifactId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.keyId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' and ${table.catalogGeneration} between 1 and 2147483647`,
    ),
    check(
      'ql3_tool_result_key_binding_digest_check',
      sql`${table.artifactDigest} ~ '^[0-9a-f]{64}$' and ${table.catalogDigest} ~ '^[0-9a-f]{64}$' and ${table.materialProof} ~ '^[0-9a-f]{64}$' and ${table.bindingDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    uniqueIndex('ql3_tool_result_key_binding_artifact_key').on(
      table.artifactId,
    ),
    uniqueIndex('ql3_tool_result_key_binding_digest_key').on(
      table.bindingDigest,
    ),
    index('ql3_tool_result_key_binding_catalog_idx').on(
      table.catalogGeneration,
      table.keyId,
      table.startId,
    ),
  ],
);

export const toolExecutionResultRekeyOverlays = ql3Schema.table(
  'tool_execution_result_rekey_overlays',
  {
    overlayId: varchar('overlay_id', { length: 128 }).primaryKey(),
    artifactId: varchar('artifact_id', { length: 128 }).notNull(),
    sourceBindingDigest: char('source_binding_digest', {
      length: 64,
    }).notNull(),
    revision: integer('revision').notNull(),
    previousOverlayDigest: char('previous_overlay_digest', { length: 64 }),
    fromKeyId: varchar('from_key_id', { length: 128 }).notNull(),
    targetCatalogAuthority: varchar('target_catalog_authority', {
      length: 64,
    }).notNull(),
    targetCatalogGeneration: integer('target_catalog_generation').notNull(),
    targetCatalogDigest: char('target_catalog_digest', {
      length: 64,
    }).notNull(),
    targetKeyId: varchar('target_key_id', { length: 128 }).notNull(),
    targetMaterialProof: char('target_material_proof', {
      length: 64,
    }).notNull(),
    mutationId: varchar('mutation_id', { length: 128 }).notNull(),
    commandDigest: char('command_digest', { length: 64 }).notNull(),
    overlayDigest: char('overlay_digest', { length: 64 }).notNull(),
    rekeyedAtMs: bigint('rekeyed_at_ms', { mode: 'number' }).notNull(),
    overlayJson: jsonb('overlay_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_result_rekey_artifact_fk',
      columns: [table.artifactId],
      foreignColumns: [toolExecutionResultKeyBindings.artifactId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_result_rekey_binding_fk',
      columns: [table.sourceBindingDigest],
      foreignColumns: [toolExecutionResultKeyBindings.bindingDigest],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_result_rekey_previous_fk',
      columns: [table.previousOverlayDigest],
      foreignColumns: [table.overlayDigest],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_result_rekey_catalog_fk',
      columns: [
        table.targetCatalogAuthority,
        table.targetCatalogGeneration,
        table.targetCatalogDigest,
      ],
      foreignColumns: [
        toolResultKeyCatalogGenerations.authority,
        toolResultKeyCatalogGenerations.generation,
        toolResultKeyCatalogGenerations.catalogDigest,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_result_rekey_revision_check',
      sql`${table.revision} between 1 and 2147483647 and ((${table.revision} = 1 and ${table.previousOverlayDigest} is null) or (${table.revision} > 1 and ${table.previousOverlayDigest} is not null))`,
    ),
    check(
      'ql3_result_rekey_authority_check',
      sql`${table.targetCatalogAuthority} = 'trusted-tool-results'`,
    ),
    check(
      'ql3_result_rekey_identity_check',
      sql`${table.overlayId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.artifactId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.mutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.fromKeyId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' and ${table.targetKeyId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' and ${table.fromKeyId} <> ${table.targetKeyId} and ${table.targetCatalogGeneration} between 1 and 2147483647`,
    ),
    check(
      'ql3_result_rekey_digest_check',
      sql`(${table.previousOverlayDigest} is null or ${table.previousOverlayDigest} ~ '^[0-9a-f]{64}$') and ${table.sourceBindingDigest} ~ '^[0-9a-f]{64}$' and ${table.targetCatalogDigest} ~ '^[0-9a-f]{64}$' and ${table.targetMaterialProof} ~ '^[0-9a-f]{64}$' and ${table.commandDigest} ~ '^[0-9a-f]{64}$' and ${table.overlayDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_result_rekey_budget_check',
      sql`${table.rekeyedAtMs} >= 0 and octet_length(${table.overlayJson}::text) between 2 and 393216`,
    ),
    check(
      'ql3_result_rekey_json_check',
      sql`jsonb_typeof(${table.overlayJson}) = 'object' and ${table.overlayJson} @> jsonb_build_object('schema', 'qinglong/tool-execution-result-rekey-overlay@v1', 'overlayId', ${table.overlayId}, 'sourceBindingDigest', ${table.sourceBindingDigest}, 'revision', ${table.revision}, 'previousOverlayDigest', ${table.previousOverlayDigest}, 'fromKeyId', ${table.fromKeyId}, 'rekeyedAtMs', ${table.rekeyedAtMs}, 'overlayDigest', ${table.overlayDigest}) and ${table.overlayJson} -> 'sourceArtifact' ->> 'artifactId' = ${table.artifactId} and ${table.overlayJson} -> 'targetCatalogFence' @> jsonb_build_object('generation', ${table.targetCatalogGeneration}, 'catalogDigest', ${table.targetCatalogDigest}, 'keyId', ${table.targetKeyId}, 'materialProof', ${table.targetMaterialProof})`,
    ),
    uniqueIndex('ql3_result_rekey_mutation_key').on(table.mutationId),
    uniqueIndex('ql3_result_rekey_digest_key').on(table.overlayDigest),
    uniqueIndex('ql3_result_rekey_artifact_revision_key').on(
      table.artifactId,
      table.revision,
    ),
    uniqueIndex('ql3_result_rekey_artifact_revision_digest_key').on(
      table.artifactId,
      table.revision,
      table.overlayDigest,
    ),
    index('ql3_result_rekey_artifact_idx').on(
      table.artifactId,
      sql`${table.revision} desc`,
    ),
    index('ql3_result_rekey_target_idx').on(
      table.targetKeyId,
      table.artifactId,
      sql`${table.revision} desc`,
    ),
  ],
);

export const toolExecutionResultRekeyHeads = ql3Schema.table(
  'tool_execution_result_rekey_heads',
  {
    artifactId: varchar('artifact_id', { length: 128 }).primaryKey(),
    revision: integer('revision').notNull(),
    overlayId: varchar('overlay_id', { length: 128 }).notNull(),
    overlayDigest: char('overlay_digest', { length: 64 }).notNull(),
    targetCatalogGeneration: integer('target_catalog_generation').notNull(),
    targetCatalogDigest: char('target_catalog_digest', {
      length: 64,
    }).notNull(),
    targetKeyId: varchar('target_key_id', { length: 128 }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_result_rekey_head_overlay_fk',
      columns: [table.artifactId, table.revision, table.overlayDigest],
      foreignColumns: [
        toolExecutionResultRekeyOverlays.artifactId,
        toolExecutionResultRekeyOverlays.revision,
        toolExecutionResultRekeyOverlays.overlayDigest,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_result_rekey_head_identity_check',
      sql`${table.revision} between 1 and 2147483647 and ${table.artifactId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.overlayId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.targetKeyId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' and ${table.targetCatalogGeneration} between 1 and 2147483647 and ${table.updatedAtMs} >= 0`,
    ),
    check(
      'ql3_result_rekey_head_digest_check',
      sql`${table.overlayDigest} ~ '^[0-9a-f]{64}$' and ${table.targetCatalogDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    uniqueIndex('ql3_result_rekey_head_overlay_key').on(table.overlayId),
    uniqueIndex('ql3_result_rekey_head_digest_key').on(table.overlayDigest),
    index('ql3_result_rekey_head_target_idx').on(
      table.targetKeyId,
      table.artifactId,
    ),
  ],
);

export const toolResultKeyRetirementReceipts = ql3Schema.table(
  'tool_result_key_retirement_receipts',
  {
    receiptDigest: char('receipt_digest', { length: 64 }).primaryKey(),
    catalogAuthority: varchar('catalog_authority', { length: 64 }).notNull(),
    catalogGeneration: integer('catalog_generation').notNull(),
    catalogDigest: char('catalog_digest', { length: 64 }).notNull(),
    keyId: varchar('key_id', { length: 128 }).notNull(),
    materialProof: char('material_proof', { length: 64 }).notNull(),
    mutationId: varchar('mutation_id', { length: 128 }).notNull(),
    commandDigest: char('command_digest', { length: 64 }).notNull(),
    bindingCount: integer('binding_count').notNull(),
    overlayHeadCount: integer('overlay_head_count').notNull(),
    uncoveredBindingCount: integer('uncovered_binding_count').notNull(),
    uncoveredOverlayHeadCount: integer(
      'uncovered_overlay_head_count',
    ).notNull(),
    coverageDigest: char('coverage_digest', { length: 64 }).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    receiptJson: jsonb('receipt_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_result_retirement_catalog_fk',
      columns: [
        table.catalogAuthority,
        table.catalogGeneration,
        table.catalogDigest,
      ],
      foreignColumns: [
        toolResultKeyCatalogGenerations.authority,
        toolResultKeyCatalogGenerations.generation,
        toolResultKeyCatalogGenerations.catalogDigest,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_result_retirement_authority_check',
      sql`${table.catalogAuthority} = 'trusted-tool-results'`,
    ),
    check(
      'ql3_result_retirement_identity_check',
      sql`${table.catalogGeneration} between 1 and 2147483647 and ${table.keyId} ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' and ${table.mutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_result_retirement_count_check',
      sql`${table.bindingCount} between 0 and 2147483647 and ${table.overlayHeadCount} between 0 and 2147483647 and ${table.uncoveredBindingCount} = 0 and ${table.uncoveredOverlayHeadCount} = 0 and ${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_result_retirement_digest_check',
      sql`${table.receiptDigest} ~ '^[0-9a-f]{64}$' and ${table.catalogDigest} ~ '^[0-9a-f]{64}$' and ${table.materialProof} ~ '^[0-9a-f]{64}$' and ${table.commandDigest} ~ '^[0-9a-f]{64}$' and ${table.coverageDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_result_retirement_json_check',
      sql`jsonb_typeof(${table.receiptJson}) = 'object' and ${table.receiptJson} @> jsonb_build_object('schema', 'qinglong/tool-result-key-retirement-receipt@v1', 'catalogGeneration', ${table.catalogGeneration}, 'catalogDigest', ${table.catalogDigest}, 'keyId', ${table.keyId}, 'materialProof', ${table.materialProof}, 'mutationId', ${table.mutationId}, 'bindingCount', ${table.bindingCount}, 'overlayHeadCount', ${table.overlayHeadCount}, 'uncoveredBindingCount', 0, 'uncoveredOverlayHeadCount', 0, 'coverageDigest', ${table.coverageDigest}, 'createdAtMs', ${table.createdAtMs}, 'receiptDigest', ${table.receiptDigest})`,
    ),
    uniqueIndex('ql3_result_retirement_mutation_key').on(table.mutationId),
    index('ql3_result_retirement_catalog_idx').on(
      table.catalogGeneration,
      table.keyId,
    ),
  ],
);

export const runAttempts = ql3Schema.table(
  'run_attempts',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    stepRunId: varchar('step_run_id', { length: 128 }),
    attempt: integer('attempt').notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    executorType: varchar('executor_type', { length: 64 }).notNull(),
    workerId: varchar('worker_id', { length: 128 }),
    workerSessionId: varchar('worker_session_id', { length: 36 }),
    workerGeneration: integer('worker_generation'),
    executorHandle: varchar('executor_handle', { length: 2048 }),
    pid: integer('pid'),
    logArtifactId: varchar('log_artifact_id', { length: 36 }),
    leaseToken: varchar('lease_token', { length: 128 }),
    leaseTokenDigest: char('lease_token_digest', { length: 64 }),
    leaseGeneration: integer('lease_generation'),
    leaseVersion: integer('lease_version'),
    leaseExpiresAtMs: bigint('lease_expires_at_ms', { mode: 'number' }),
    offerId: varchar('offer_id', { length: 128 }),
    deadlineAtMs: bigint('deadline_at_ms', { mode: 'number' }),
    callbackTokenHash: varchar('callback_token_hash', { length: 128 }),
    callbackSequence: integer('callback_sequence').default(0).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    startedAtMs: bigint('started_at_ms', { mode: 'number' }),
    finishedAtMs: bigint('finished_at_ms', { mode: 'number' }),
    exitCode: integer('exit_code'),
    errorCode: varchar('error_code', { length: 128 }),
    errorSummary: varchar('error_summary', { length: 1024 }),
  },
  (table) => [
    check('ql3_run_attempts_attempt_check', sql`${table.attempt} >= 1`),
    check(
      'ql3_run_attempts_status_check',
      sql`${table.status} in ('claimed', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'lost')`,
    ),
    check(
      'ql3_run_attempts_pid_check',
      sql`${table.pid} is null or ${table.pid} >= 1`,
    ),
    check(
      'ql3_run_attempts_lease_expiry_check',
      sql`${table.leaseExpiresAtMs} is null or ${table.leaseExpiresAtMs} >= 0`,
    ),
    check(
      'ql3_run_attempts_worker_session_id_check',
      sql`${table.workerSessionId} is null or ${table.workerSessionId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      'ql3_run_attempts_worker_generation_check',
      sql`${table.workerGeneration} is null or ${table.workerGeneration} between 1 and 2147483647`,
    ),
    check(
      'ql3_run_attempts_lease_generation_check',
      sql`${table.leaseGeneration} is null or ${table.leaseGeneration} between 1 and 2147483647`,
    ),
    check(
      'ql3_run_attempts_lease_version_check',
      sql`${table.leaseVersion} is null or ${table.leaseVersion} between 0 and 2147483647`,
    ),
    check(
      'ql3_run_attempts_lease_token_digest_check',
      sql`${table.leaseTokenDigest} is null or ${table.leaseTokenDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_run_attempts_offer_id_check',
      sql`${table.offerId} is null or char_length(${table.offerId}) between 1 and 128`,
    ),
    check(
      'ql3_run_attempts_remote_fence_shape_check',
      sql`(${table.workerSessionId} is null and ${table.workerGeneration} is null and ${table.leaseGeneration} is null and ${table.leaseVersion} is null and ${table.leaseTokenDigest} is null and ${table.offerId} is null) or (${table.workerId} is not null and ${table.workerSessionId} is not null and ${table.workerGeneration} is not null and ${table.leaseGeneration} is not null and ${table.leaseVersion} is not null and ${table.leaseTokenDigest} is not null and ${table.offerId} is not null)`,
    ),
    check(
      'ql3_run_attempts_deadline_check',
      sql`${table.deadlineAtMs} is null or ${table.deadlineAtMs} >= 0`,
    ),
    check(
      'ql3_run_attempts_callback_sequence_check',
      sql`${table.callbackSequence} >= 0`,
    ),
    check('ql3_run_attempts_created_at_check', sql`${table.createdAtMs} >= 0`),
    check(
      'ql3_run_attempts_started_at_check',
      sql`${table.startedAtMs} is null or ${table.startedAtMs} >= 0`,
    ),
    check(
      'ql3_run_attempts_finished_at_check',
      sql`${table.finishedAtMs} is null or ${table.finishedAtMs} >= 0`,
    ),
    foreignKey({
      name: 'ql3_run_attempts_run_fk',
      columns: [table.runId],
      foreignColumns: [runs.id],
    }),
    foreignKey({
      name: 'ql3_run_attempts_step_run_fk',
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
    }).onDelete('restrict'),
    uniqueIndex('ql3_run_attempts_run_attempt_uidx').on(
      table.runId,
      table.attempt,
    ),
    index('ql3_run_attempts_dispatch_candidates_idx').on(
      table.status,
      table.runId,
      table.createdAtMs,
      table.id,
    ),
    index('ql3_run_attempts_recovery_idx')
      .on(table.leaseExpiresAtMs, table.createdAtMs, table.id)
      .where(sql`${table.status} in ('claimed', 'starting', 'running')`),
    index('ql3_run_attempts_lease_idx')
      .on(table.leaseExpiresAtMs, table.id)
      .where(sql`${table.leaseExpiresAtMs} is not null`),
    index('ql3_run_log_retention_candidate_idx')
      .on(table.finishedAtMs, table.id)
      .where(
        sql`${table.executorType} = 'remote_worker' and ${table.logArtifactId} is not null and ${table.status} in ('succeeded', 'failed', 'cancelled', 'timed_out')`,
      ),
  ],
);

export const runAttemptLogRetentionControls = ql3Schema.table(
  'run_attempt_log_retention_controls',
  {
    attemptId: varchar('attempt_id', { length: 36 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    logArtifactId: varchar('log_artifact_id', { length: 36 }).notNull(),
    executorType: varchar('executor_type', { length: 32 }).notNull(),
    finishedAtMs: bigint('finished_at_ms', { mode: 'number' }).notNull(),
    eligibleAtMs: bigint('eligible_at_ms', { mode: 'number' }).notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    claimOwner: varchar('claim_owner', { length: 128 }),
    claimToken: varchar('claim_token', { length: 64 }),
    claimVersion: integer('claim_version').default(1).notNull(),
    claimExpiresAtMs: bigint('claim_expires_at_ms', { mode: 'number' }),
    nextClaimAtMs: bigint('next_claim_at_ms', { mode: 'number' }),
    failureCount: integer('failure_count').default(0).notNull(),
    lastFailureCode: varchar('last_failure_code', { length: 64 }),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    uniqueIndex('ql3_run_log_retention_control_artifact_key').on(
      table.logArtifactId,
    ),
    check(
      'ql3_run_log_retention_control_identity_check',
      sql`char_length(${table.projectId}) between 1 and 128 and char_length(${table.runId}) between 1 and 36 and char_length(${table.attemptId}) between 1 and 36 and ${table.logArtifactId} ~ '^wlog-[a-f0-9]{30}$' and ${table.executorType} = 'remote_worker'`,
    ),
    check(
      'ql3_run_log_retention_control_time_check',
      sql`${table.finishedAtMs} >= 0 and ${table.eligibleAtMs} >= ${table.finishedAtMs} and ${table.createdAtMs} >= 0 and ${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    check(
      'ql3_run_log_retention_control_state_check',
      sql`${table.state} in ('claimed', 'retry', 'manual')`,
    ),
    check(
      'ql3_run_log_retention_control_claim_owner_check',
      sql`${table.claimOwner} is null or ${table.claimOwner} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_run_log_retention_control_claim_token_check',
      sql`${table.claimToken} is null or ${table.claimToken} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,63}$'`,
    ),
    check(
      'ql3_run_log_retention_control_claim_version_check',
      sql`${table.claimVersion} between 1 and 2147483647`,
    ),
    check(
      'ql3_run_log_retention_control_claim_expiry_check',
      sql`${table.claimExpiresAtMs} is null or ${table.claimExpiresAtMs} >= 0`,
    ),
    check(
      'ql3_run_log_retention_control_next_claim_check',
      sql`${table.nextClaimAtMs} is null or ${table.nextClaimAtMs} >= 0`,
    ),
    check(
      'ql3_run_log_retention_control_failure_count_check',
      sql`${table.failureCount} between 0 and 2147483647`,
    ),
    check(
      'ql3_run_log_retention_control_failure_code_check',
      sql`${table.lastFailureCode} is null or ${table.lastFailureCode} in ('artifact_unavailable', 'artifact_integrity_mismatch', 'retirement_record_unavailable')`,
    ),
    check(
      'ql3_run_log_retention_control_state_shape_check',
      sql`(${table.state} = 'claimed' and ${table.claimOwner} is not null and ${table.claimToken} is not null and ${table.claimExpiresAtMs} is not null and ${table.nextClaimAtMs} is null) or (${table.state} = 'retry' and ${table.claimOwner} is null and ${table.claimToken} is null and ${table.claimExpiresAtMs} is null and ${table.nextClaimAtMs} is not null and ${table.lastFailureCode} is not null) or (${table.state} = 'manual' and ${table.claimOwner} is null and ${table.claimToken} is null and ${table.claimExpiresAtMs} is null and ${table.nextClaimAtMs} is null and ${table.lastFailureCode} is not null)`,
    ),
    foreignKey({
      name: 'ql3_run_log_retention_control_attempt_fk',
      columns: [table.attemptId],
      foreignColumns: [runAttempts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ql3_run_log_retention_control_run_fk',
      columns: [table.runId],
      foreignColumns: [runs.id],
    }).onDelete('cascade'),
    index('ql3_run_log_retention_retry_idx')
      .on(table.nextClaimAtMs, table.finishedAtMs, table.attemptId)
      .where(sql`${table.state} = 'retry'`),
    index('ql3_run_log_retention_claim_expiry_idx')
      .on(table.claimExpiresAtMs, table.finishedAtMs, table.attemptId)
      .where(sql`${table.state} = 'claimed'`),
  ],
);

export const runAttemptLogArtifactTombstones = ql3Schema.table(
  'run_attempt_log_artifact_tombstones',
  {
    logArtifactId: varchar('log_artifact_id', { length: 36 }).primaryKey(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    attemptId: varchar('attempt_id', { length: 36 }).notNull(),
    executorType: varchar('executor_type', { length: 32 }).notNull(),
    finishedAtMs: bigint('finished_at_ms', { mode: 'number' }).notNull(),
    eligibleAtMs: bigint('eligible_at_ms', { mode: 'number' }).notNull(),
    retiredAtMs: bigint('retired_at_ms', { mode: 'number' }).notNull(),
    disposition: varchar('disposition', { length: 16 }).notNull(),
    byteLength: bigint('byte_length', { mode: 'number' }).notNull(),
    truncated: varchar('truncated', { length: 16 }).notNull(),
    maximumBytes: bigint('maximum_bytes', { mode: 'number' }),
    truncationObservedAtMs: bigint('truncation_observed_at_ms', {
      mode: 'number',
    }),
    recordDigest: char('record_digest', { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex('ql3_run_log_tombstone_attempt_key').on(table.attemptId),
    check(
      'ql3_run_log_tombstone_identity_check',
      sql`char_length(${table.projectId}) between 1 and 128 and char_length(${table.runId}) between 1 and 36 and char_length(${table.attemptId}) between 1 and 36 and ${table.logArtifactId} ~ '^wlog-[a-f0-9]{30}$' and ${table.executorType} = 'remote_worker'`,
    ),
    check(
      'ql3_run_log_tombstone_time_check',
      sql`${table.finishedAtMs} >= 0 and ${table.eligibleAtMs} >= ${table.finishedAtMs} and ${table.retiredAtMs} >= ${table.eligibleAtMs}`,
    ),
    check(
      'ql3_run_log_tombstone_disposition_check',
      sql`${table.disposition} in ('deleted', 'already_absent') and (${table.disposition} <> 'already_absent' or ${table.byteLength} = 0)`,
    ),
    check(
      'ql3_run_log_tombstone_size_check',
      sql`${table.byteLength} between 0 and 1073741824`,
    ),
    check(
      'ql3_run_log_tombstone_truncation_check',
      sql`(${table.truncated} = 'unknown' and ${table.maximumBytes} is null and ${table.truncationObservedAtMs} is null) or (${table.truncated} in ('true', 'false') and ${table.maximumBytes} >= 1 and ${table.truncationObservedAtMs} >= 0)`,
    ),
    check(
      'ql3_run_log_tombstone_digest_check',
      sql`${table.recordDigest} ~ '^[a-f0-9]{64}$'`,
    ),
    foreignKey({
      name: 'ql3_run_log_tombstone_attempt_fk',
      columns: [table.attemptId],
      foreignColumns: [runAttempts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ql3_run_log_tombstone_run_fk',
      columns: [table.runId],
      foreignColumns: [runs.id],
    }).onDelete('cascade'),
    index('ql3_run_log_tombstone_retired_idx').on(
      table.retiredAtMs,
      table.attemptId,
    ),
  ],
);

export const workerSessions = ql3Schema.table(
  'worker_sessions',
  {
    workerId: varchar('worker_id', { length: 128 }).primaryKey(),
    sessionId: varchar('session_id', { length: 36 }).notNull(),
    generation: integer('generation').notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    version: integer('version').notNull(),
    capabilitiesJson: varchar('capabilities_json', {
      length: 16_384,
    }).notNull(),
    capabilitiesHash: char('capabilities_hash', { length: 64 }).notNull(),
    maxConcurrentRuns: integer('max_concurrent_runs').notNull(),
    availableSlots: integer('available_slots').notNull(),
    registeredAtMs: bigint('registered_at_ms', { mode: 'number' }).notNull(),
    lastHeartbeatAtMs: bigint('last_heartbeat_at_ms', {
      mode: 'number',
    }).notNull(),
    leaseExpiresAtMs: bigint('lease_expires_at_ms', {
      mode: 'number',
    }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'ql3_worker_sessions_worker_id_check',
      sql`${table.workerId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_worker_sessions_session_id_check',
      sql`${table.sessionId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      'ql3_worker_sessions_generation_check',
      sql`${table.generation} between 1 and 2147483647`,
    ),
    check(
      'ql3_worker_sessions_status_check',
      sql`${table.status} in ('online', 'draining', 'offline')`,
    ),
    check(
      'ql3_worker_sessions_version_check',
      sql`${table.version} between 0 and 2147483647`,
    ),
    check(
      'ql3_worker_sessions_capabilities_check',
      sql`octet_length(${table.capabilitiesJson}) between 2 and 16384`,
    ),
    check(
      'ql3_worker_sessions_capabilities_hash_check',
      sql`${table.capabilitiesHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_worker_sessions_concurrency_check',
      sql`${table.maxConcurrentRuns} between 1 and 1024 and ${table.availableSlots} between 0 and ${table.maxConcurrentRuns}`,
    ),
    check(
      'ql3_worker_sessions_timestamps_check',
      sql`${table.registeredAtMs} >= 0 and ${table.lastHeartbeatAtMs} >= ${table.registeredAtMs} and ${table.updatedAtMs} >= ${table.lastHeartbeatAtMs} and ((${table.status} = 'offline' and ${table.leaseExpiresAtMs} >= ${table.lastHeartbeatAtMs}) or (${table.status} <> 'offline' and ${table.leaseExpiresAtMs} > ${table.lastHeartbeatAtMs}))`,
    ),
    check(
      'ql3_worker_sessions_status_capacity_check',
      sql`${table.status} = 'online' or ${table.availableSlots} = 0`,
    ),
    index('ql3_worker_sessions_available_idx')
      .on(table.workerId)
      .where(sql`${table.status} = 'online' and ${table.availableSlots} > 0`),
  ],
);

export const runDispatchLeases = ql3Schema.table(
  'run_dispatch_leases',
  {
    attemptId: varchar('attempt_id', { length: 36 }).primaryKey(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(),
    version: integer('version').notNull(),
    leaseGeneration: integer('lease_generation').notNull(),
    workerId: varchar('worker_id', { length: 128 }).notNull(),
    workerSessionId: varchar('worker_session_id', { length: 36 }).notNull(),
    workerGeneration: integer('worker_generation').notNull(),
    leaseTokenDigest: char('lease_token_digest', { length: 64 }).notNull(),
    offerId: varchar('offer_id', { length: 128 }).notNull(),
    acquiredAtMs: bigint('acquired_at_ms', { mode: 'number' }).notNull(),
    renewedAtMs: bigint('renewed_at_ms', { mode: 'number' }).notNull(),
    expiresAtMs: bigint('expires_at_ms', { mode: 'number' }).notNull(),
    releasedAtMs: bigint('released_at_ms', { mode: 'number' }),
    releaseReason: varchar('release_reason', { length: 32 }),
    completedAtMs: bigint('completed_at_ms', { mode: 'number' }),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'ql3_run_dispatch_leases_status_check',
      sql`${table.status} in ('leased', 'released', 'completed')`,
    ),
    check(
      'ql3_run_dispatch_leases_version_check',
      sql`${table.version} between 0 and 2147483647`,
    ),
    check(
      'ql3_run_dispatch_leases_generation_check',
      sql`${table.leaseGeneration} between 1 and 2147483647`,
    ),
    check(
      'ql3_run_dispatch_leases_worker_generation_check',
      sql`${table.workerGeneration} between 1 and 2147483647`,
    ),
    check(
      'ql3_run_dispatch_leases_token_digest_check',
      sql`${table.leaseTokenDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_run_dispatch_leases_offer_id_check',
      sql`char_length(${table.offerId}) between 1 and 128`,
    ),
    check(
      'ql3_run_dispatch_leases_timestamps_check',
      sql`${table.acquiredAtMs} >= 0 and ${table.renewedAtMs} >= ${table.acquiredAtMs} and ${table.expiresAtMs} > ${table.renewedAtMs} and ${table.updatedAtMs} >= ${table.acquiredAtMs}`,
    ),
    check(
      'ql3_run_dispatch_leases_state_shape_check',
      sql`(${table.status} = 'leased' and ${table.releasedAtMs} is null and ${table.releaseReason} is null and ${table.completedAtMs} is null) or (${table.status} = 'released' and ${table.releasedAtMs} is not null and ${table.releaseReason} in ('declined', 'shutdown', 'start_failed', 'capacity_changed', 'lease_expired') and ${table.completedAtMs} is null) or (${table.status} = 'completed' and ${table.releasedAtMs} is null and ${table.releaseReason} is null and ${table.completedAtMs} is not null)`,
    ),
    foreignKey({
      name: 'ql3_run_dispatch_leases_attempt_fk',
      columns: [table.attemptId],
      foreignColumns: [runAttempts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ql3_run_dispatch_leases_run_fk',
      columns: [table.runId],
      foreignColumns: [runs.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ql3_run_dispatch_leases_worker_fk',
      columns: [table.workerId],
      foreignColumns: [workerSessions.workerId],
    }),
    uniqueIndex('ql3_run_dispatch_leases_offer_uidx').on(table.offerId),
    index('ql3_run_dispatch_leases_worker_active_idx')
      .on(
        table.workerId,
        table.workerSessionId,
        table.workerGeneration,
        table.expiresAtMs,
        table.attemptId,
      )
      .where(sql`${table.status} = 'leased'`),
    index('ql3_run_dispatch_leases_expiry_idx')
      .on(table.expiresAtMs, table.attemptId)
      .where(sql`${table.status} = 'leased'`),
  ],
);

export const workerCredentials = ql3Schema.table(
  'worker_credentials',
  {
    credentialId: varchar('credential_id', { length: 64 }).notNull(),
    version: integer('version').notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    workerId: varchar('worker_id', { length: 128 }).notNull(),
    secretDigest: char('secret_digest', { length: 64 }).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    notBeforeAtMs: bigint('not_before_at_ms', { mode: 'number' }).notNull(),
    expiresAtMs: bigint('expires_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'worker_credentials_pkey',
      columns: [table.credentialId, table.version],
    }),
    check(
      'ql3_worker_credentials_id_check',
      sql`${table.credentialId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'`,
    ),
    check(
      'ql3_worker_credentials_version_check',
      sql`${table.version} between 1 and 2147483647`,
    ),
    check(
      'ql3_worker_credentials_state_check',
      sql`${table.state} in ('active', 'revoked')`,
    ),
    check(
      'ql3_worker_credentials_worker_id_check',
      sql`${table.workerId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_worker_credentials_digest_check',
      sql`${table.secretDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_worker_credentials_lifetime_check',
      sql`${table.createdAtMs} >= 0 and ${table.notBeforeAtMs} >= 0 and ${table.expiresAtMs} > greatest(${table.createdAtMs}, ${table.notBeforeAtMs})`,
    ),
    index('ql3_worker_credentials_latest_idx').on(
      table.credentialId,
      table.version,
    ),
  ],
);

export const workerCredentialManagementPlans = ql3Schema.table(
  'worker_credential_management_plans',
  {
    actionRef: varchar('action_ref', { length: 255 }).primaryKey(),
    authorityProjectId: varchar('authority_project_id', {
      length: 128,
    }).notNull(),
    action: varchar('action', { length: 16 }).notNull(),
    deliveryId: varchar('delivery_id', { length: 36 }).notNull(),
    workerId: varchar('worker_id', { length: 128 }).notNull(),
    credentialId: varchar('credential_id', { length: 64 }).notNull(),
    previousCredentialId: varchar('previous_credential_id', { length: 64 }),
    credentialNotBeforeAtMs: bigint('credential_not_before_at_ms', {
      mode: 'number',
    }).notNull(),
    credentialExpiresAtMs: bigint('credential_expires_at_ms', {
      mode: 'number',
    }).notNull(),
    deploymentTargetDigest: char('deployment_target_digest', {
      length: 64,
    }).notNull(),
    deploymentGeneration: varchar('deployment_generation', {
      length: 128,
    }).notNull(),
    requestedByType: varchar('requested_by_type', { length: 16 }).notNull(),
    requestedById: varchar('requested_by_id', { length: 255 }).notNull(),
    plannedAtMs: bigint('planned_at_ms', { mode: 'number' }).notNull(),
    expiresAtMs: bigint('expires_at_ms', { mode: 'number' }).notNull(),
    planDigest: char('plan_digest', { length: 64 }).notNull(),
    previewDigest: char('preview_digest', { length: 64 }).notNull(),
    planJson: jsonb('plan_json').$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_worker_credential_management_plan_project_fk',
      columns: [table.authorityProjectId],
      foreignColumns: [projects.id],
    }).onDelete('restrict'),
    check(
      'ql3_worker_credential_management_plan_identity_check',
      sql`${table.actionRef} ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$' and ${table.action} in ('issue', 'rotate') and ${table.deliveryId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and ${table.workerId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.credentialId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' and (${table.previousCredentialId} is null or ${table.previousCredentialId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$') and ${table.deploymentGeneration} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.requestedByType} = 'user' and char_length(${table.requestedById}) between 1 and 255 and ${table.requestedById} !~ '[[:cntrl:]]'`,
    ),
    check(
      'ql3_worker_credential_management_plan_action_check',
      sql`(${table.action} = 'issue' and ${table.previousCredentialId} is null) or (${table.action} = 'rotate' and ${table.previousCredentialId} is not null and ${table.previousCredentialId} <> ${table.credentialId})`,
    ),
    check(
      'ql3_worker_credential_management_plan_digest_check',
      sql`${table.deploymentTargetDigest} ~ '^[0-9a-f]{64}$' and ${table.planDigest} ~ '^[0-9a-f]{64}$' and ${table.previewDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_worker_credential_management_plan_time_check',
      sql`${table.plannedAtMs} >= 0 and ${table.expiresAtMs} > ${table.plannedAtMs} and ${table.expiresAtMs} - ${table.plannedAtMs} <= 900000 and ${table.credentialNotBeforeAtMs} >= ${table.plannedAtMs} and ${table.credentialExpiresAtMs} > ${table.credentialNotBeforeAtMs} and ${table.credentialExpiresAtMs} - ${table.credentialNotBeforeAtMs} <= 63072000000`,
    ),
    check(
      'ql3_worker_credential_management_plan_json_check',
      sql`jsonb_typeof(${table.planJson}) = 'object' and octet_length(${table.planJson}::text) between 2 and 16384`,
    ),
    uniqueIndex('ql3_worker_credential_management_plan_digest_key').on(
      table.planDigest,
    ),
    uniqueIndex('ql3_worker_credential_management_plan_delivery_key').on(
      table.deliveryId,
    ),
    index('ql3_worker_credential_management_plan_expiry_idx').on(
      table.expiresAtMs,
      table.actionRef,
    ),
  ],
);

export const workerCredentialMutations = ql3Schema.table(
  'worker_credential_mutations',
  {
    mutationId: varchar('mutation_id', { length: 36 }).primaryKey(),
    operation: varchar('operation', { length: 16 }).notNull(),
    credentialId: varchar('credential_id', { length: 64 }).notNull(),
    credentialVersion: integer('credential_version').notNull(),
    expectedPreviousVersion: integer('expected_previous_version').notNull(),
    changedByType: varchar('changed_by_type', { length: 32 }).notNull(),
    changedById: varchar('changed_by_id', { length: 255 }).notNull(),
    auditEventId: uuid('audit_event_id').notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'ql3_worker_credential_mutations_id_check',
      sql`${table.mutationId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      'ql3_worker_credential_mutations_operation_check',
      sql`${table.operation} in ('issue', 'rotate', 'revoke')`,
    ),
    check(
      'ql3_worker_credential_mutations_version_check',
      sql`${table.credentialVersion} between 1 and 2147483647 and ${table.expectedPreviousVersion} between 0 and 2147483646 and ${table.credentialVersion} = ${table.expectedPreviousVersion} + 1`,
    ),
    check(
      'ql3_worker_credential_mutations_actor_check',
      sql`${table.changedByType} in ('user', 'system') and char_length(${table.changedById}) between 1 and 255`,
    ),
    check(
      'ql3_worker_credential_mutations_created_at_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    foreignKey({
      name: 'ql3_worker_credential_mutations_credential_fk',
      columns: [table.credentialId, table.credentialVersion],
      foreignColumns: [
        workerCredentials.credentialId,
        workerCredentials.version,
      ],
    }),
    foreignKey({
      name: 'ql3_worker_credential_mutations_audit_fk',
      columns: [table.auditEventId],
      foreignColumns: [securityAuditEvents.eventId],
    }),
    uniqueIndex('ql3_worker_credential_mutations_audit_uidx').on(
      table.auditEventId,
    ),
  ],
);

export const workerCredentialDeliveries = ql3Schema.table(
  'worker_credential_deliveries',
  {
    deliveryId: varchar('delivery_id', { length: 36 }).notNull(),
    version: integer('version').notNull(),
    state: varchar('state', { length: 32 }).notNull(),
    workerId: varchar('worker_id', { length: 128 }).notNull(),
    credentialId: varchar('credential_id', { length: 64 }).notNull(),
    credentialVersion: integer('credential_version').notNull(),
    previousCredentialId: varchar('previous_credential_id', { length: 64 }),
    secretDigest: char('secret_digest', { length: 64 }).notNull(),
    tokenDigest: char('token_digest', { length: 64 }).notNull(),
    deploymentTargetDigest: char('deployment_target_digest', {
      length: 64,
    }).notNull(),
    deploymentGeneration: varchar('deployment_generation', {
      length: 128,
    }).notNull(),
    stagedAtMs: bigint('staged_at_ms', { mode: 'number' }).notNull(),
    credentialCommittedAtMs: bigint('credential_committed_at_ms', {
      mode: 'number',
    }).notNull(),
    publishedAtMs: bigint('published_at_ms', { mode: 'number' }),
    publicationDigest: char('publication_digest', { length: 64 }),
    observedAtMs: bigint('observed_at_ms', { mode: 'number' }),
    observedSessionId: varchar('observed_session_id', { length: 36 }),
    observedSessionVersion: integer('observed_session_version'),
    previousRevokedAtMs: bigint('previous_revoked_at_ms', {
      mode: 'number',
    }),
  },
  (table) => [
    primaryKey({
      name: 'worker_credential_deliveries_pkey',
      columns: [table.deliveryId, table.version],
    }),
    check(
      'ql3_worker_credential_deliveries_version_check',
      sql`${table.version} between 1 and 4 and ${table.credentialVersion} = 1`,
    ),
    check(
      'ql3_worker_credential_deliveries_id_check',
      sql`${table.deliveryId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      'ql3_worker_credential_deliveries_state_check',
      sql`${table.state} in ('credential_committed', 'published', 'observed', 'previous_revoked')`,
    ),
    check(
      'ql3_worker_credential_deliveries_worker_check',
      sql`char_length(${table.workerId}) between 1 and 128 and ${table.workerId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_worker_credential_deliveries_credential_check',
      sql`char_length(${table.credentialId}) between 1 and 64 and ${table.credentialId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' and (${table.previousCredentialId} is null or (char_length(${table.previousCredentialId}) between 1 and 64 and ${table.previousCredentialId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' and ${table.previousCredentialId} <> ${table.credentialId}))`,
    ),
    check(
      'ql3_worker_credential_deliveries_digest_check',
      sql`${table.secretDigest} ~ '^[0-9a-f]{64}$' and ${table.tokenDigest} ~ '^[0-9a-f]{64}$' and ${table.deploymentTargetDigest} ~ '^[0-9a-f]{64}$' and (${table.publicationDigest} is null or ${table.publicationDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      'ql3_worker_credential_deliveries_generation_check',
      sql`char_length(${table.deploymentGeneration}) between 1 and 128 and ${table.deploymentGeneration} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_worker_credential_deliveries_session_check',
      sql`${table.observedSessionId} is null or ${table.observedSessionId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      'ql3_worker_credential_deliveries_time_check',
      sql`${table.stagedAtMs} >= 0 and ${table.credentialCommittedAtMs} >= ${table.stagedAtMs} and (${table.publishedAtMs} is null or ${table.publishedAtMs} >= ${table.credentialCommittedAtMs}) and (${table.observedAtMs} is null or ${table.observedAtMs} >= ${table.publishedAtMs}) and (${table.previousRevokedAtMs} is null or ${table.previousRevokedAtMs} >= ${table.observedAtMs})`,
    ),
    check(
      'ql3_worker_credential_deliveries_state_shape_check',
      sql`(${table.version} = 1 and ${table.state} = 'credential_committed' and ${table.publishedAtMs} is null and ${table.publicationDigest} is null and ${table.observedAtMs} is null and ${table.observedSessionId} is null and ${table.observedSessionVersion} is null and ${table.previousRevokedAtMs} is null) or (${table.version} = 2 and ${table.state} = 'published' and ${table.publishedAtMs} is not null and ${table.publicationDigest} is not null and ${table.observedAtMs} is null and ${table.observedSessionId} is null and ${table.observedSessionVersion} is null and ${table.previousRevokedAtMs} is null) or (${table.version} = 3 and ${table.state} = 'observed' and ${table.publishedAtMs} is not null and ${table.publicationDigest} is not null and ${table.observedAtMs} is not null and ${table.observedSessionId} is not null and ${table.observedSessionVersion} between 1 and 2147483647 and ${table.previousRevokedAtMs} is null) or (${table.version} = 4 and ${table.state} = 'previous_revoked' and ${table.previousCredentialId} is not null and ${table.publishedAtMs} is not null and ${table.publicationDigest} is not null and ${table.observedAtMs} is not null and ${table.observedSessionId} is not null and ${table.observedSessionVersion} between 1 and 2147483647 and ${table.previousRevokedAtMs} is not null)`,
    ),
    foreignKey({
      name: 'ql3_worker_credential_deliveries_mutation_fk',
      columns: [table.deliveryId],
      foreignColumns: [workerCredentialMutations.mutationId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_worker_credential_deliveries_credential_fk',
      columns: [table.credentialId, table.credentialVersion],
      foreignColumns: [
        workerCredentials.credentialId,
        workerCredentials.version,
      ],
    }).onDelete('restrict'),
    index('ql3_worker_credential_deliveries_recovery_idx').on(
      table.state,
      table.deliveryId,
      table.version,
    ),
    uniqueIndex('ql3_worker_credential_deliveries_credential_uidx')
      .on(table.credentialId, table.credentialVersion)
      .where(sql`${table.version} = 1`),
    index('ql3_worker_credential_deliveries_credential_idx').on(
      table.credentialId,
      table.credentialVersion,
      table.deliveryId,
      table.version,
    ),
  ],
);

export const workerCredentialStageDiscards = ql3Schema.table(
  'worker_credential_stage_discards',
  {
    deliveryId: varchar('delivery_id', { length: 36 }).notNull(),
    version: integer('version').notNull(),
    state: varchar('state', { length: 32 }).notNull(),
    workerId: varchar('worker_id', { length: 128 }).notNull(),
    credentialId: varchar('credential_id', { length: 64 }).notNull(),
    credentialVersion: integer('credential_version').notNull(),
    previousCredentialId: varchar('previous_credential_id', { length: 64 }),
    secretDigest: char('secret_digest', { length: 64 }).notNull(),
    tokenDigest: char('token_digest', { length: 64 }).notNull(),
    deploymentTargetDigest: char('deployment_target_digest', {
      length: 64,
    }).notNull(),
    deploymentGeneration: varchar('deployment_generation', {
      length: 128,
    }).notNull(),
    stagedAtMs: bigint('staged_at_ms', { mode: 'number' }).notNull(),
    authorizedAtMs: bigint('authorized_at_ms', { mode: 'number' }).notNull(),
    discardedAtMs: bigint('discarded_at_ms', { mode: 'number' }),
  },
  (table) => [
    primaryKey({
      name: 'worker_credential_stage_discards_pkey',
      columns: [table.deliveryId, table.version],
    }),
    check(
      'ql3_worker_credential_stage_discards_version_check',
      sql`${table.version} between 1 and 2 and ${table.credentialVersion} = 1`,
    ),
    check(
      'ql3_worker_credential_stage_discards_id_check',
      sql`${table.deliveryId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      'ql3_worker_credential_stage_discards_state_check',
      sql`${table.state} in ('discard_authorized', 'discarded')`,
    ),
    check(
      'ql3_worker_credential_stage_discards_worker_check',
      sql`char_length(${table.workerId}) between 1 and 128 and ${table.workerId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_worker_credential_stage_discards_credential_check',
      sql`char_length(${table.credentialId}) between 1 and 64 and ${table.credentialId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' and (${table.previousCredentialId} is null or (char_length(${table.previousCredentialId}) between 1 and 64 and ${table.previousCredentialId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' and ${table.previousCredentialId} <> ${table.credentialId}))`,
    ),
    check(
      'ql3_worker_credential_stage_discards_digest_check',
      sql`${table.secretDigest} ~ '^[0-9a-f]{64}$' and ${table.tokenDigest} ~ '^[0-9a-f]{64}$' and ${table.deploymentTargetDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_worker_credential_stage_discards_generation_check',
      sql`char_length(${table.deploymentGeneration}) between 1 and 128 and ${table.deploymentGeneration} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_worker_credential_stage_discards_time_check',
      sql`${table.stagedAtMs} >= 0 and ${table.authorizedAtMs} >= 0 and (${table.discardedAtMs} is null or ${table.discardedAtMs} >= ${table.authorizedAtMs})`,
    ),
    check(
      'ql3_worker_credential_stage_discards_state_shape_check',
      sql`(${table.version} = 1 and ${table.state} = 'discard_authorized' and ${table.discardedAtMs} is null) or (${table.version} = 2 and ${table.state} = 'discarded' and ${table.discardedAtMs} is not null)`,
    ),
    index('ql3_worker_credential_stage_discards_recovery_idx').on(
      table.state,
      table.deliveryId,
      table.version,
    ),
  ],
);

export const workerExecutionAttestations = ql3Schema.table(
  'worker_execution_attestations',
  {
    attestationId: varchar('attestation_id', { length: 36 }).primaryKey(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    attemptId: varchar('attempt_id', { length: 36 }).notNull(),
    sequence: integer('sequence').notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    workerId: varchar('worker_id', { length: 128 }).notNull(),
    workerSessionId: varchar('worker_session_id', { length: 36 }).notNull(),
    workerGeneration: integer('worker_generation').notNull(),
    leaseTokenDigest: char('lease_token_digest', { length: 64 }).notNull(),
    leaseGeneration: integer('lease_generation').notNull(),
    leaseVersion: integer('lease_version').notNull(),
    offerId: varchar('offer_id', { length: 128 }).notNull(),
    callbackSequence: integer('callback_sequence').notNull(),
    executorHandle: varchar('executor_handle', { length: 512 }).notNull(),
    journalRevision: integer('journal_revision').notNull(),
    receivedAtMs: bigint('received_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'ql3_worker_execution_attestations_id_check',
      sql`${table.attestationId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      'ql3_worker_execution_attestations_sequence_check',
      sql`${table.sequence} between 1 and 2147483647`,
    ),
    check(
      'ql3_worker_execution_attestations_state_check',
      sql`${table.state} in ('running', 'stopped')`,
    ),
    check(
      'ql3_worker_execution_attestations_worker_id_check',
      sql`${table.workerId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_worker_execution_attestations_session_id_check',
      sql`${table.workerSessionId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
    ),
    check(
      'ql3_worker_execution_attestations_generation_check',
      sql`${table.workerGeneration} between 1 and 2147483647 and ${table.leaseGeneration} between 1 and 2147483647 and ${table.leaseVersion} between 0 and 2147483647`,
    ),
    check(
      'ql3_worker_execution_attestations_digest_check',
      sql`${table.leaseTokenDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_worker_execution_attestations_offer_check',
      sql`char_length(${table.offerId}) between 1 and 128`,
    ),
    check(
      'ql3_worker_execution_attestations_callback_check',
      sql`${table.callbackSequence} between 0 and 2147483647`,
    ),
    check(
      'ql3_worker_execution_attestations_handle_check',
      sql`char_length(${table.executorHandle}) between 1 and 512`,
    ),
    check(
      'ql3_worker_execution_attestations_journal_check',
      sql`${table.journalRevision} between 1 and 2147483647`,
    ),
    check(
      'ql3_worker_execution_attestations_received_at_check',
      sql`${table.receivedAtMs} >= 0`,
    ),
    foreignKey({
      name: 'ql3_worker_execution_attestations_run_fk',
      columns: [table.runId],
      foreignColumns: [runs.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ql3_worker_execution_attestations_attempt_fk',
      columns: [table.attemptId],
      foreignColumns: [runAttempts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ql3_worker_execution_attestations_worker_fk',
      columns: [table.workerId],
      foreignColumns: [workerSessions.workerId],
    }),
    uniqueIndex('ql3_worker_execution_attestations_sequence_uidx').on(
      table.attemptId,
      table.leaseGeneration,
      table.sequence,
    ),
    index('ql3_worker_execution_attestations_exact_idx').on(
      table.attemptId,
      table.leaseGeneration,
      table.sequence,
    ),
  ],
);

export const runRecoveryControls = ql3Schema.table(
  'run_recovery_controls',
  {
    targetKind: varchar('target_kind', { length: 16 }).notNull(),
    targetId: varchar('target_id', { length: 36 }).notNull(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    attemptId: varchar('attempt_id', { length: 36 }),
    targetStatus: varchar('target_status', { length: 32 }).notNull(),
    targetCreatedAtMs: bigint('target_created_at_ms', {
      mode: 'number',
    }).notNull(),
    observedAtMs: bigint('observed_at_ms', { mode: 'number' }).notNull(),
    state: varchar('state', { length: 16 }).notNull(),
    claimOwner: varchar('claim_owner', { length: 128 }),
    claimToken: varchar('claim_token', { length: 64 }),
    claimVersion: integer('claim_version').default(0).notNull(),
    claimExpiresAtMs: bigint('claim_expires_at_ms', { mode: 'number' }),
    nextClaimAtMs: bigint('next_claim_at_ms', { mode: 'number' }),
    failureCount: integer('failure_count').default(0).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'run_recovery_controls_pkey',
      columns: [table.targetKind, table.targetId],
    }),
    check(
      'ql3_run_recovery_controls_target_kind_check',
      sql`${table.targetKind} in ('run', 'attempt')`,
    ),
    check(
      'ql3_run_recovery_controls_target_id_check',
      sql`char_length(${table.targetId}) >= 1`,
    ),
    check(
      'ql3_run_recovery_controls_target_shape_check',
      sql`(${table.targetKind} = 'run' and ${table.targetId} = ${table.runId} and ${table.attemptId} is null and ${table.targetStatus} in ('created', 'dispatching', 'running')) or (${table.targetKind} = 'attempt' and ${table.targetId} = ${table.attemptId} and ${table.attemptId} is not null and ${table.targetStatus} in ('claimed', 'starting', 'running'))`,
    ),
    check(
      'ql3_run_recovery_controls_target_created_at_check',
      sql`${table.targetCreatedAtMs} >= 0`,
    ),
    check(
      'ql3_run_recovery_controls_observed_at_check',
      sql`${table.observedAtMs} >= 0`,
    ),
    check(
      'ql3_run_recovery_controls_state_check',
      sql`${table.state} in ('available', 'claimed', 'retry', 'manual', 'resolved')`,
    ),
    check(
      'ql3_run_recovery_controls_claim_owner_check',
      sql`${table.claimOwner} is null or ${table.claimOwner} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_run_recovery_controls_claim_token_check',
      sql`${table.claimToken} is null or ${table.claimToken} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,63}$'`,
    ),
    check(
      'ql3_run_recovery_controls_claim_version_check',
      sql`${table.claimVersion} between 0 and 2147483647`,
    ),
    check(
      'ql3_run_recovery_controls_claim_expires_at_check',
      sql`${table.claimExpiresAtMs} is null or ${table.claimExpiresAtMs} >= 0`,
    ),
    check(
      'ql3_run_recovery_controls_next_claim_at_check',
      sql`${table.nextClaimAtMs} is null or ${table.nextClaimAtMs} >= 0`,
    ),
    check(
      'ql3_run_recovery_controls_failure_count_check',
      sql`${table.failureCount} between 0 and 2147483647`,
    ),
    check(
      'ql3_run_recovery_controls_created_at_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_run_recovery_controls_updated_at_check',
      sql`${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    check(
      'ql3_run_recovery_controls_state_shape_check',
      sql`(${table.state} = 'claimed' and ${table.claimOwner} is not null and ${table.claimToken} is not null and ${table.claimExpiresAtMs} is not null and ${table.nextClaimAtMs} is null) or (${table.state} = 'retry' and ${table.claimOwner} is null and ${table.claimToken} is null and ${table.claimExpiresAtMs} is null and ${table.nextClaimAtMs} is not null) or (${table.state} in ('available', 'manual', 'resolved') and ${table.claimOwner} is null and ${table.claimToken} is null and ${table.claimExpiresAtMs} is null and ${table.nextClaimAtMs} is null)`,
    ),
    foreignKey({
      name: 'ql3_run_recovery_controls_run_fk',
      columns: [table.runId],
      foreignColumns: [runs.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ql3_run_recovery_controls_attempt_fk',
      columns: [table.attemptId],
      foreignColumns: [runAttempts.id],
    }).onDelete('cascade'),
    index('ql3_run_recovery_controls_available_idx')
      .on(table.targetCreatedAtMs, table.targetKind, table.targetId)
      .where(sql`${table.state} in ('available', 'resolved')`),
    index('ql3_run_recovery_controls_retry_idx')
      .on(
        table.nextClaimAtMs,
        table.targetCreatedAtMs,
        table.targetKind,
        table.targetId,
      )
      .where(sql`${table.state} = 'retry'`),
    index('ql3_run_recovery_controls_claim_expiry_idx')
      .on(
        table.claimExpiresAtMs,
        table.targetCreatedAtMs,
        table.targetKind,
        table.targetId,
      )
      .where(sql`${table.state} = 'claimed'`),
  ],
);

export const runEvents = ql3Schema.table(
  'run_events',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    sequence: integer('sequence').notNull(),
    type: varchar('type', { length: 128 }).notNull(),
    dedupeKey: varchar('dedupe_key', { length: 255 }),
    actorType: varchar('actor_type', { length: 64 }).notNull(),
    actorId: varchar('actor_id', { length: 255 }),
    attemptId: varchar('attempt_id', { length: 36 }),
    stepRunId: varchar('step_run_id', { length: 128 }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check('ql3_run_events_sequence_check', sql`${table.sequence} >= 1`),
    check(
      'ql3_run_events_actor_type_check',
      sql`${table.actorType} in ('user', 'api_app', 'trigger', 'agent', 'mcp_client', 'worker', 'executor', 'system', 'legacy_shell', 'scheduler', 'reconciler', 'compatibility')`,
    ),
    check(
      'ql3_run_events_payload_check',
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    check('ql3_run_events_created_at_check', sql`${table.createdAtMs} >= 0`),
    foreignKey({
      name: 'ql3_run_events_run_fk',
      columns: [table.runId],
      foreignColumns: [runs.id],
    }),
    foreignKey({
      name: 'ql3_run_events_attempt_fk',
      columns: [table.attemptId],
      foreignColumns: [runAttempts.id],
    }),
    foreignKey({
      name: 'ql3_run_events_step_run_fk',
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
    }).onDelete('restrict'),
    uniqueIndex('ql3_run_events_run_sequence_uidx').on(
      table.runId,
      table.sequence,
    ),
    uniqueIndex('ql3_run_events_run_dedupe_uidx')
      .on(table.runId, table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
    index('ql3_run_events_run_created_idx').on(
      table.runId,
      table.createdAtMs,
      table.id,
    ),
  ],
);

export const stepRunMutations = ql3Schema.table(
  'step_run_mutations',
  {
    mutationId: varchar('mutation_id', { length: 128 }).primaryKey(),
    mutationDigest: char('mutation_digest', { length: 64 }).notNull(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    stepRunId: varchar('step_run_id', { length: 128 }).notNull(),
    stepRunDigest: char('step_run_digest', { length: 64 }).notNull(),
    eventId: varchar('event_id', { length: 36 }).notNull(),
    eventSequence: integer('event_sequence').notNull(),
    runVersion: integer('run_version').notNull(),
    stepRunJson: jsonb('step_run_json')
      .$type<Record<string, unknown>>()
      .notNull(),
    committedAtMs: bigint('committed_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_step_run_mutations_step_fk',
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ql3_step_run_mutations_event_fk',
      columns: [table.eventId],
      foreignColumns: [runEvents.id],
    }).onDelete('cascade'),
    check(
      'ql3_step_run_mutations_identity_check',
      sql`${table.mutationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.runId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.stepRunId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'ql3_step_run_mutations_digest_check',
      sql`${table.mutationDigest} ~ '^[0-9a-f]{64}$' and ${table.stepRunDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_step_run_mutations_counter_check',
      sql`${table.eventSequence} between 1 and 2147483647 and ${table.runVersion} between 1 and 2147483647 and ${table.committedAtMs} >= 0`,
    ),
    check(
      'ql3_step_run_mutations_json_check',
      sql`jsonb_typeof(${table.stepRunJson}) = 'object' and octet_length(${table.stepRunJson}::text) between 2 and 16384 and ${table.stepRunJson} @> jsonb_build_object('schema', 'qinglong/step-run@v1', 'id', ${table.stepRunId}, 'runId', ${table.runId}, 'lastMutationId', ${table.mutationId}, 'stepRunDigest', ${table.stepRunDigest})`,
    ),
    uniqueIndex('ql3_step_run_mutations_event_uidx').on(table.eventId),
    index('ql3_step_run_mutations_step_idx').on(
      table.runId,
      table.stepRunId,
      table.eventSequence,
      table.mutationId,
    ),
  ],
);

export const pluginPackageWorkflowAdmissions = ql3Schema.table(
  'plugin_package_workflow_admissions',
  {
    planDigest: char('plan_digest', { length: 64 }).primaryKey(),
    planId: varchar('plan_id', { length: 128 }).notNull(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    packageName: varchar('package_name', { length: 63 }).notNull(),
    installationId: varchar('installation_id', { length: 128 }).notNull(),
    lockDigest: char('lock_digest', { length: 64 }).notNull(),
    generation: integer('generation').notNull(),
    generationDigest: char('generation_digest', { length: 64 }).notNull(),
    materializedRevisionDigest: char('materialized_revision_digest', {
      length: 64,
    }).notNull(),
    publicationDigest: char('publication_digest', { length: 64 }).notNull(),
    workflowId: varchar('workflow_id', { length: 63 }).notNull(),
    workflowDefinitionDigest: char('workflow_definition_digest', {
      length: 64,
    }).notNull(),
    stepCount: integer('step_count').notNull(),
    admittedAtMs: bigint('admitted_at_ms', { mode: 'number' }).notNull(),
    finalRunVersion: integer('final_run_version').notNull(),
    finalRunEventSequence: integer('final_run_event_sequence').notNull(),
    receiptDigest: char('receipt_digest', { length: 64 }).notNull(),
    planJson: jsonb('plan_json').$type<Record<string, unknown>>().notNull(),
    receiptJson: jsonb('receipt_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ql3_plugin_package_workflow_admission_run_fk',
      columns: [table.runId],
      foreignColumns: [runs.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_workflow_admission_publication_fk',
      columns: [table.publicationDigest],
      foreignColumns: [pluginPackageAutomationPublications.publicationDigest],
    }).onDelete('restrict'),
    uniqueIndex('plugin_package_workflow_admissions_plan_id_key').on(
      table.planId,
    ),
    uniqueIndex('plugin_package_workflow_admissions_run_id_key').on(
      table.runId,
    ),
    uniqueIndex('plugin_package_workflow_admissions_receipt_digest_key').on(
      table.receiptDigest,
    ),
    uniqueIndex('ql3_plugin_package_workflow_admission_plan_run_key').on(
      table.planDigest,
      table.runId,
    ),
    index('ql3_plugin_package_workflow_admission_target_idx').on(
      table.projectId,
      table.packageName,
      table.admittedAtMs,
      table.planDigest,
    ),
    index('ql3_plugin_package_workflow_admission_workflow_history_idx').on(
      table.projectId,
      table.packageName,
      table.workflowId,
      table.admittedAtMs,
      table.runId,
    ),
    check(
      'ql3_plugin_package_workflow_admission_identity_check',
      sql`${table.planId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.runId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' and ${table.packageName} ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' and ${table.workflowId} ~ '^[a-z][a-z0-9-]{0,62}$' and ${table.generation} between 1 and 2147483647 and ${table.stepCount} between 1 and 128 and ${table.admittedAtMs} >= 0 and ${table.finalRunVersion} = ${table.stepCount} + 1 and ${table.finalRunEventSequence} = ${table.stepCount} + 1`,
    ),
    check(
      'ql3_plugin_package_workflow_admission_digest_check',
      sql`${table.planDigest} ~ '^[0-9a-f]{64}$' and ${table.lockDigest} ~ '^[0-9a-f]{64}$' and ${table.generationDigest} ~ '^[0-9a-f]{64}$' and ${table.materializedRevisionDigest} ~ '^[0-9a-f]{64}$' and ${table.publicationDigest} ~ '^[0-9a-f]{64}$' and ${table.workflowDefinitionDigest} ~ '^[0-9a-f]{64}$' and ${table.receiptDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'ql3_plugin_package_workflow_admission_json_check',
      sql`jsonb_typeof(${table.planJson}) = 'object' and octet_length(${table.planJson}::text) between 2 and 262144 and ${table.planJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-workflow-execution-plan@v1', 'planId', ${table.planId}, 'planDigest', ${table.planDigest}, 'runId', ${table.runId}, 'plannedAtMs', ${table.admittedAtMs}) and ${table.planJson} -> 'target' @> jsonb_build_object('projectId', ${table.projectId}, 'packageName', ${table.packageName}, 'installationId', ${table.installationId}, 'lockDigest', ${table.lockDigest}, 'generation', ${table.generation}, 'generationDigest', ${table.generationDigest}, 'materializedRevisionDigest', ${table.materializedRevisionDigest}, 'publicationDigest', ${table.publicationDigest}, 'workflowId', ${table.workflowId}, 'workflowDefinitionDigest', ${table.workflowDefinitionDigest}) and jsonb_typeof(${table.planJson} -> 'steps') = 'array' and jsonb_array_length(${table.planJson} -> 'steps') = ${table.stepCount} and jsonb_typeof(${table.receiptJson}) = 'object' and octet_length(${table.receiptJson}::text) between 2 and 262144 and ${table.receiptJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-workflow-admission-receipt@v1', 'planId', ${table.planId}, 'planDigest', ${table.planDigest}, 'runId', ${table.runId}, 'publicationDigest', ${table.publicationDigest}, 'workflowId', ${table.workflowId}, 'finalRunVersion', ${table.finalRunVersion}, 'finalRunEventSequence', ${table.finalRunEventSequence}, 'admittedAtMs', ${table.admittedAtMs}, 'receiptDigest', ${table.receiptDigest}) and jsonb_typeof(${table.receiptJson} -> 'steps') = 'array' and jsonb_array_length(${table.receiptJson} -> 'steps') = ${table.stepCount}`,
    ),
  ],
);

export const pluginPackageWorkflowAdmissionSteps = ql3Schema.table(
  'plugin_package_workflow_admission_steps',
  {
    planDigest: char('plan_digest', { length: 64 }).notNull(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    stepKey: varchar('step_key', { length: 63 }).notNull(),
    stepRunId: varchar('step_run_id', { length: 128 }).notNull(),
    taskId: varchar('task_id', { length: 63 }).notNull(),
    taskDefinitionRef: varchar('task_definition_ref', {
      length: 512,
    }).notNull(),
    taskDefinitionDigest: char('task_definition_digest', {
      length: 64,
    }).notNull(),
    needsJson: jsonb('needs_json').$type<readonly string[]>().notNull(),
    initialStatus: varchar('initial_status', { length: 16 }).notNull(),
    mutationId: varchar('mutation_id', { length: 128 }).notNull(),
    eventId: varchar('event_id', { length: 36 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'plugin_package_workflow_admission_steps_pkey',
      columns: [table.planDigest, table.stepKey],
    }),
    foreignKey({
      name: 'ql3_plugin_package_workflow_admission_step_admission_fk',
      columns: [table.planDigest, table.runId],
      foreignColumns: [
        pluginPackageWorkflowAdmissions.planDigest,
        pluginPackageWorkflowAdmissions.runId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_workflow_admission_step_run_fk',
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_workflow_admission_step_mutation_fk',
      columns: [table.mutationId],
      foreignColumns: [stepRunMutations.mutationId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_workflow_admission_step_event_fk',
      columns: [table.eventId],
      foreignColumns: [runEvents.id],
    }).onDelete('restrict'),
    uniqueIndex('plugin_package_workflow_admission_steps_step_run_id_key').on(
      table.stepRunId,
    ),
    uniqueIndex('plugin_package_workflow_admission_steps_mutation_id_key').on(
      table.mutationId,
    ),
    uniqueIndex('plugin_package_workflow_admission_steps_event_id_key').on(
      table.eventId,
    ),
    index('ql3_plugin_package_workflow_admission_step_task_idx').on(
      table.taskId,
      table.taskDefinitionDigest,
      table.planDigest,
    ),
    check(
      'ql3_plugin_package_workflow_admission_step_identity_check',
      sql`${table.stepKey} ~ '^[a-z][a-z0-9-]{0,62}$' and ${table.taskId} ~ '^[a-z][a-z0-9-]{0,62}$' and ${table.initialStatus} in ('pending', 'ready') and ${table.taskDefinitionDigest} ~ '^[0-9a-f]{64}$' and jsonb_typeof(${table.needsJson}) = 'array' and jsonb_array_length(${table.needsJson}) between 0 and 127`,
    ),
  ],
);

export const pluginPackageWorkflowTaskAttemptAdmissions = ql3Schema.table(
  'plugin_package_workflow_task_attempt_admissions',
  {
    receiptDigest: char('receipt_digest', { length: 64 }).primaryKey(),
    attemptId: varchar('attempt_id', { length: 36 }).notNull(),
    planDigest: char('plan_digest', { length: 64 }).notNull(),
    runId: varchar('run_id', { length: 36 }).notNull(),
    stepRunId: varchar('step_run_id', { length: 128 }).notNull(),
    stepRunVersion: integer('step_run_version').notNull(),
    stepRunDigest: char('step_run_digest', { length: 64 }).notNull(),
    generationDigest: char('generation_digest', { length: 64 }).notNull(),
    resourceTaskId: varchar('resource_task_id', { length: 128 }).notNull(),
    taskReconciliationReceiptDigest: char(
      'task_reconciliation_receipt_digest',
      { length: 64 },
    ).notNull(),
    projectId: varchar('project_id', { length: 128 }).notNull(),
    taskId: varchar('task_id', { length: 128 }).notNull(),
    sourceRevision: integer('source_revision').notNull(),
    taskRevision: varchar('task_revision', { length: 96 }).notNull(),
    taskDefinitionDigest: char('task_definition_digest', {
      length: 64,
    }).notNull(),
    executorType: varchar('executor_type', { length: 32 }).notNull(),
    executionDigest: char('execution_digest', { length: 64 }).notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    eventId: varchar('event_id', { length: 36 }).notNull(),
    runVersion: integer('run_version').notNull(),
    runEventSequence: integer('run_event_sequence').notNull(),
    admittedAtMs: bigint('admitted_at_ms', { mode: 'number' }).notNull(),
    receiptJson: jsonb('receipt_json')
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    uniqueIndex(
      'plugin_package_workflow_task_attempt_admissions_attempt_id_key',
    ).on(table.attemptId),
    uniqueIndex(
      'plugin_package_workflow_task_attempt_admissions_event_id_key',
    ).on(table.eventId),
    uniqueIndex('plugin_package_workflow_task_attempt_admissions_epoch_key').on(
      table.runId,
      table.stepRunId,
      table.stepRunVersion,
    ),
    uniqueIndex(
      'plugin_package_workflow_task_attempt_admissions_number_key',
    ).on(table.runId, table.attemptNumber),
    foreignKey({
      name: 'ql3_plugin_package_workflow_task_attempt_admission_plan_fk',
      columns: [table.planDigest, table.runId],
      foreignColumns: [
        pluginPackageWorkflowAdmissions.planDigest,
        pluginPackageWorkflowAdmissions.runId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_workflow_task_attempt_admission_step_fk',
      columns: [table.runId, table.stepRunId],
      foreignColumns: [stepRuns.runId, stepRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_workflow_task_attempt_admission_attempt_fk',
      columns: [table.attemptId],
      foreignColumns: [runAttempts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_workflow_task_attempt_admission_event_fk',
      columns: [table.eventId],
      foreignColumns: [runEvents.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_pp_workflow_task_attempt_reconciliation_fk',
      columns: [table.generationDigest, table.taskReconciliationReceiptDigest],
      foreignColumns: [
        pluginPackageTaskReconciliations.generationDigest,
        pluginPackageTaskReconciliations.receiptDigest,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ql3_plugin_package_workflow_task_attempt_admission_execution_fk',
      columns: [
        table.projectId,
        table.taskId,
        table.sourceRevision,
        table.executorType,
      ],
      foreignColumns: [
        taskExecutionRevisions.projectId,
        taskExecutionRevisions.taskId,
        taskExecutionRevisions.sourceRevision,
        taskExecutionRevisions.executorType,
      ],
    }).onDelete('restrict'),
    check(
      'ql3_pp_workflow_task_attempt_identity_check',
      sql`${table.attemptId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' and ${table.runId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' and char_length(${table.stepRunId}) between 1 and 128 and char_length(${table.resourceTaskId}) between 1 and 128 and char_length(${table.projectId}) between 1 and 128 and char_length(${table.taskId}) between 1 and 128 and ${table.eventId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$' and ${table.executorType} = 'remote_worker'`,
    ),
    check(
      'ql3_pp_workflow_task_attempt_counter_check',
      sql`${table.stepRunVersion} between 1 and 2147483647 and ${table.sourceRevision} between 1 and 2147483647 and ${table.attemptNumber} between 1 and 8192 and ${table.runVersion} between 1 and 2147483647 and ${table.runEventSequence} = ${table.runVersion} and ${table.admittedAtMs} >= 0`,
    ),
    check(
      'ql3_plugin_package_workflow_task_attempt_admission_digest_check',
      sql`${table.receiptDigest} ~ '^[0-9a-f]{64}$' and ${table.planDigest} ~ '^[0-9a-f]{64}$' and ${table.stepRunDigest} ~ '^[0-9a-f]{64}$' and ${table.generationDigest} ~ '^[0-9a-f]{64}$' and ${table.taskReconciliationReceiptDigest} ~ '^[0-9a-f]{64}$' and ${table.taskDefinitionDigest} ~ '^[0-9a-f]{64}$' and ${table.executionDigest} ~ '^[0-9a-f]{64}$' and ${table.taskRevision} = concat('qltd:v1:', ${table.sourceRevision}::text, ':', ${table.taskDefinitionDigest})`,
    ),
    check(
      'ql3_plugin_package_workflow_task_attempt_admission_json_check',
      sql`jsonb_typeof(${table.receiptJson}) = 'object' and octet_length(${table.receiptJson}::text) between 2 and 16384 and ${table.receiptJson} @> jsonb_build_object('schema', 'qinglong/plugin-package-workflow-task-attempt-admission@v1', 'receiptDigest', ${table.receiptDigest}, 'attemptId', ${table.attemptId}, 'planDigest', ${table.planDigest}, 'runId', ${table.runId}, 'stepRunId', ${table.stepRunId}, 'stepRunVersion', ${table.stepRunVersion}, 'stepRunDigest', ${table.stepRunDigest}, 'resourceTaskId', ${table.resourceTaskId}, 'taskReconciliationReceiptDigest', ${table.taskReconciliationReceiptDigest}, 'taskId', ${table.taskId}, 'taskRevision', ${table.taskRevision}, 'taskDefinitionDigest', ${table.taskDefinitionDigest}, 'executorType', ${table.executorType}, 'executionDigest', ${table.executionDigest}, 'attemptNumber', ${table.attemptNumber}, 'eventId', ${table.eventId}, 'runVersion', ${table.runVersion}, 'runEventSequence', ${table.runEventSequence}, 'admittedAtMs', ${table.admittedAtMs})`,
    ),
    index('ql3_pp_workflow_task_attempt_candidate_idx').on(
      table.runId,
      table.stepRunId,
      table.admittedAtMs,
    ),
  ],
);

export const runRetryPolicies = ql3Schema.table(
  'run_retry_policies',
  {
    runId: varchar('run_id', { length: 36 }).primaryKey(),
    maxAttempts: integer('max_attempts').notNull(),
    retryOnLost: boolean('retry_on_lost').notNull(),
    safety: varchar('safety', { length: 16 }).notNull(),
    backoffBaseMs: bigint('backoff_base_ms', { mode: 'number' }).notNull(),
    backoffMaxMs: bigint('backoff_max_ms', { mode: 'number' }).notNull(),
    nextAttemptAtMs: bigint('next_attempt_at_ms', { mode: 'number' }),
    version: integer('version').default(0).notNull(),
    createdAtMs: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAtMs: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    check(
      'ql3_run_retry_policies_max_attempts_check',
      sql`${table.maxAttempts} between 1 and 16`,
    ),
    check(
      'ql3_run_retry_policies_safety_check',
      sql`${table.safety} in ('unknown', 'idempotent', 'deduplicated')`,
    ),
    check(
      'ql3_run_retry_policies_backoff_base_check',
      sql`${table.backoffBaseMs} between 0 and 86400000`,
    ),
    check(
      'ql3_run_retry_policies_backoff_max_check',
      sql`${table.backoffMaxMs} between ${table.backoffBaseMs} and 86400000`,
    ),
    check(
      'ql3_run_retry_policies_next_attempt_check',
      sql`${table.nextAttemptAtMs} is null or ${table.nextAttemptAtMs} >= 0`,
    ),
    check('ql3_run_retry_policies_version_check', sql`${table.version} >= 0`),
    check(
      'ql3_run_retry_policies_created_at_check',
      sql`${table.createdAtMs} >= 0`,
    ),
    check(
      'ql3_run_retry_policies_updated_at_check',
      sql`${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    foreignKey({
      name: 'ql3_run_retry_policies_run_fk',
      columns: [table.runId],
      foreignColumns: [runs.id],
    }).onDelete('cascade'),
    index('ql3_run_retry_policies_due_idx')
      .on(table.nextAttemptAtMs, table.runId)
      .where(sql`${table.nextAttemptAtMs} is not null`),
  ],
);

export const ql3PostgresTables = [
  schemaMigrations,
  schemaCapabilities,
  projects,
  pluginPackageInstalls,
  pluginPackageInstallHeads,
  pluginPackageInstallMutations,
  pluginPackageMaterializedRevisions,
  projectToolDefinitionSnapshots,
  projectToolDefinitionSnapshotSources,
  pluginPackageQuarantineEvents,
  pluginPackageWithdrawalReceipts,
  pluginPackageWithdrawalTasks,
  pluginPackageLifecycleEvents,
  pluginPackageLifecycleHeads,
  pluginPackageLifecycleReceipts,
  pluginPackageLifecycleTasks,
  pluginPackageLifecyclePlans,
  pluginPackageAutomationDispositionEvents,
  pluginPackageAutomationPublications,
  pluginPackageAutomationPublicationHeads,
  pluginPackageWorkflowAdmissions,
  pluginPackageWorkflowAdmissionSteps,
  pluginPackageWorkflowTaskAttemptAdmissions,
  pluginPackagePublisherProvenance,
  pluginPackagePublisherRevocationReceipts,
  pluginPackagePublisherRevocationImpacts,
  pluginPackagePublisherRevocationImpactItems,
  pluginPackagePublisherTrustSnapshots,
  pluginPackagePublisherTrustHeads,
  pluginPackagePublisherRevocationProposals,
  pluginPackagePublisherTrustTransitionProposals,
  pluginPackagePublisherTrustTransitionReceipts,
  pluginPackageTaskOwnerships,
  pluginPackageTaskReconciliations,
  pluginPackageTaskReconciliationItems,
  approvalRequests,
  approvedActionDispatches,
  approvedActionExecutions,
  pluginPackageInstallProposals,
  pluginPackageManagementQuotaBuckets,
  workerCredentialManagementQuotaBuckets,
  pluginPackageIdentityKeysetLedger,
  pluginPackageAdmissionReceipts,
  taskDefinitions,
  taskDefinitionRevisions,
  taskExecutionRevisions,
  triggers,
  triggerRevisions,
  triggerSchedules,
  projectRoleBindings,
  identitySubjects,
  apiCredentials,
  securityAuditEvents,
  identitySubjectMutations,
  apiCredentialMutations,
  runs,
  stepRuns,
  toolExecutionTraceAnchors,
  toolExecutionAuditReceipts,
  toolExecutionStartBarriers,
  toolInvocationInputArtifacts,
  toolInvocationPreviewArtifacts,
  toolExecutionStartArtifactBindings,
  toolExecutionCompletions,
  toolExecutionFailureCompletions,
  toolResultKeyCatalogGenerations,
  toolExecutionResultKeyBindings,
  toolExecutionResultRekeyOverlays,
  toolExecutionResultRekeyHeads,
  toolResultKeyRetirementReceipts,
  runAttempts,
  runAttemptLogRetentionControls,
  runAttemptLogArtifactTombstones,
  workerSessions,
  runDispatchLeases,
  workerCredentials,
  workerCredentialManagementPlans,
  workerCredentialMutations,
  workerCredentialDeliveries,
  workerCredentialStageDiscards,
  workerExecutionAttestations,
  runRecoveryControls,
  runEvents,
  stepRunMutations,
  runRetryPolicies,
] as const;
