const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  postgresqlControlSchemaContract,
  postgresqlMainMigrationManifest,
} = require('@qinglong/cluster-postgres');
const {
  MAX_PLUGIN_PACKAGE_RECOVERY_PAGES,
} = require('@qinglong/runtime-core/plugin-package-recovery');
const {
  recoverClusterPluginPackages,
} = require('@qinglong/cluster-admin/plugin-package-recovery');

function history() {
  return postgresqlMainMigrationManifest.migrations.map((migration, index) => ({
    streamId: postgresqlMainMigrationManifest.id,
    dialect: postgresqlMainMigrationManifest.dialect,
    migrationId: migration.id,
    checksum: migration.checksum,
    appliedAtMs: index + 1,
  }));
}

function executorPrivileges() {
  const insertable = new Set([
    'security_audit_events',
    'plugin_package_installs',
    'plugin_package_install_heads',
    'plugin_package_install_mutations',
    'approved_action_dispatches',
    'approved_action_executions',
    'plugin_package_admission_receipts',
    'plugin_package_materialized_revisions',
    'plugin_package_automation_publications',
    'plugin_package_automation_publication_heads',
    'plugin_package_secret_bindings',
    'project_tool_definition_snapshots',
    'project_tool_definition_snapshot_sources',
    'plugin_package_publisher_provenance',
    'plugin_package_publisher_revocation_receipts',
    'plugin_package_publisher_revocation_impacts',
    'plugin_package_publisher_revocation_impact_items',
    'plugin_package_publisher_trust_snapshots',
    'plugin_package_publisher_trust_transition_receipts',
    'plugin_package_lifecycle_plans',
  ]);
  const readable = new Set([
    'schema_migrations',
    'schema_capabilities',
    'projects',
    'project_role_bindings',
    'approval_requests',
    'plugin_package_install_proposals',
    'plugin_package_task_ownerships',
    'plugin_package_task_reconciliations',
    'plugin_package_task_reconciliation_items',
    'plugin_package_quarantine_events',
    'plugin_package_withdrawal_receipts',
    'plugin_package_withdrawal_tasks',
    'plugin_package_publisher_provenance',
    'plugin_package_publisher_revocation_receipts',
    'plugin_package_publisher_revocation_impacts',
    'plugin_package_publisher_revocation_impact_items',
    'plugin_package_publisher_trust_snapshots',
    'plugin_package_publisher_trust_heads',
    'plugin_package_publisher_revocation_proposals',
    'plugin_package_publisher_trust_transition_proposals',
    'plugin_package_publisher_trust_transition_receipts',
    'plugin_package_lifecycle_events',
    'plugin_package_lifecycle_heads',
    'plugin_package_lifecycle_receipts',
    'plugin_package_lifecycle_tasks',
    'task_definitions',
    'task_definition_revisions',
    'task_execution_revisions',
    ...insertable,
  ]);
  return postgresqlControlSchemaContract.tables.map(({ name: tableName }) => ({
    tableName,
    selectAllowed: readable.has(tableName),
    insertAllowed: insertable.has(tableName),
    updateAllowed: [
      'plugin_package_installs',
      'plugin_package_install_heads',
      'approval_requests',
      'approved_action_executions',
      'plugin_package_publisher_trust_heads',
      'plugin_package_automation_publication_heads',
    ].includes(tableName),
    deleteAllowed: false,
    isOwner: false,
  }));
}

function database(serverVersionNum = '160014') {
  const contract = postgresqlControlSchemaContract;
  let closes = 0;
  const resource = {
    pool: {
      async query(text) {
        if (text.includes("current_setting('server_version_num')")) {
          return {
            rows: [
              {
                serverVersionNum,
                currentUser: 'ql3_package_executor',
                inRecovery: false,
                transactionReadOnly: 'off',
              },
            ],
          };
        }
        if (text.includes('FROM "ql3"."schema_migrations"')) {
          return { rows: history() };
        }
        if (text.includes('FROM "ql3"."schema_capabilities"')) {
          return {
            rows: [
              {
                contractName: contract.contractName,
                contractVersion: contract.contractVersion,
                migrationId: contract.migrationId,
                capabilities: contract.capabilities,
              },
            ],
          };
        }
        if (text.includes('FROM pg_class tables')) {
          return {
            rows: contract.tables.flatMap((table) =>
              table.columns.map((columnName) => ({
                tableName: table.name,
                columnName,
              })),
            ),
          };
        }
        if (text.includes('FROM pg_indexes')) {
          return { rows: contract.indexes.map((indexName) => ({ indexName })) };
        }
        if (text.includes('FROM pg_constraint')) {
          return {
            rows: [
              ...contract.checks.map((constraintName) => ({
                constraintName,
                constraintType: 'check',
              })),
              ...contract.foreignKeys.map((constraintName) => ({
                constraintName,
                constraintType: 'foreign_key',
              })),
            ],
          };
        }
        if (text.includes('FROM pg_proc routines')) {
          return {
            rows: contract.functions.map((definition) => ({
              functionName: definition.name,
              identityArguments: definition.identityArguments,
              owner: definition.owner,
              securityDefiner: definition.securityDefiner,
              volatility: definition.volatility,
              configuration: definition.configuration,
              publicExecute: false,
            })),
          };
        }
        if (text.includes('FROM pg_catalog.pg_roles')) {
          return {
            rows: [
              {
                canLogin: true,
                superuser: false,
                createDatabase: false,
                createRole: false,
                replication: false,
                bypassRowLevelSecurity: false,
                databaseConnect: true,
              },
            ],
          };
        }
        if (text.includes('has_schema_privilege')) {
          return { rows: [{ schemaUsage: true, schemaCreate: false }] };
        }
        if (text.includes('has_table_privilege')) {
          return { rows: executorPrivileges() };
        }
        if (text.includes('has_function_privilege')) {
          return {
            rows: contract.functions.map(({ name: functionName }) => ({
              functionName,
              executeAllowed: ![
                'enforce_plugin_package_secret_materialization',
                'enforce_plugin_package_stage_provenance',
                'plugin_package_automation_start_allowed',
                'plugin_package_run_start_allowed',
                'plugin_package_tool_start_allowed',
                'plugin_package_workflow_admission_snapshot',
                'plugin_package_workflow_task_attempt_snapshot',
                'lock_run_management_policy_fence',
                'register_plugin_package_automation_disposition_event',
              ].includes(functionName),
              isOwner: false,
            })),
          };
        }
        if (text.includes('plugin_package_install_heads')) {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${text}`);
      },
      async connect() {
        throw new Error('empty recovery must not open a transaction');
      },
    },
    async close() {
      closes += 1;
    },
  };
  return { resource, closes: () => closes };
}

function options(db, overrides = {}) {
  const unavailable = async () => {
    throw new Error('empty recovery must not use Kubernetes');
  };
  return {
    openDatabase: async () => db.resource,
    api: {
      readNamespacedConfigMap: unavailable,
      createNamespacedConfigMap: unavailable,
      replaceNamespacedConfigMap: unavailable,
    },
    stageAuthority: {
      stage: unavailable,
      verify: unavailable,
      publisherEvidence: unavailable,
    },
    resourceByteSource: { open: unavailable },
    clusterIdentity: 'cluster-test',
    trustAuthorityId: 'cluster',
    namespace: 'qinglong',
    now: () => 1_000,
    ...overrides,
  };
}

test('rejects invalid bounds before opening PostgreSQL', async () => {
  const db = database();
  let opens = 0;
  await assert.rejects(
    recoverClusterPluginPackages(
      options(db, {
        maxPages: MAX_PLUGIN_PACKAGE_RECOVERY_PAGES + 1,
        openDatabase: async () => {
          opens += 1;
          return db.resource;
        },
      }),
    ),
    /configuration is invalid/,
  );
  assert.equal(opens, 0);
  assert.equal(db.closes(), 0);
});

test('proves an empty executor queue and closes PostgreSQL before returning', async () => {
  const db = database();
  const result = await recoverClusterPluginPackages(options(db));

  assert.equal(result.evidence.currentUser, 'ql3_package_executor');
  assert.deepEqual(result.provenanceRecovery, {
    pages: 1,
    scanned: 0,
    created: 0,
    existing: 0,
    remaining: false,
    safeToAdmit: true,
  });
  assert.deepEqual(result.recovery, {
    pages: 1,
    scanned: 0,
    settled: 0,
    retry: 0,
    manualRequired: 0,
    superseded: 0,
    remaining: false,
    safeToAdmit: true,
  });
  assert.deepEqual(result.taskPublicationRecovery, {
    pages: 1,
    scanned: 0,
    settled: 0,
    retry: 0,
    manualRequired: 0,
    superseded: 0,
    remaining: false,
    safeToAdmit: true,
  });
  assert.deepEqual(result.automationPublicationRecovery, {
    pages: 1,
    scanned: 0,
    settled: 0,
    retry: 0,
    manualRequired: 0,
    superseded: 0,
    remaining: false,
    safeToAdmit: true,
  });
  assert.deepEqual(result.toolSnapshotRecovery, {
    pages: 1,
    scanned: 0,
    settled: 0,
    retry: 0,
    manualRequired: 0,
    remaining: false,
    safeToAdmit: true,
  });
  assert.equal(db.closes(), 1);
  assert.equal(
    require('@qinglong/cluster-admin').recoverClusterPluginPackages,
    undefined,
  );
});

test('resolves a database-bound stage authority after readiness', async () => {
  const db = database();
  let factories = 0;
  const configured = options(db);
  delete configured.stageAuthority;
  configured.stageAuthorityFactory = async (pool) => {
    factories += 1;
    assert.equal(pool, db.resource.pool);
    return {
      stage: configured.resourceByteSource.open,
      verify: configured.resourceByteSource.open,
      publisherEvidence: configured.resourceByteSource.open,
    };
  };
  await recoverClusterPluginPackages(configured);
  assert.equal(factories, 1);
  assert.equal(db.closes(), 1);
});

test('closes PostgreSQL when admin readiness fails', async () => {
  const db = database('150018');
  await assert.rejects(
    recoverClusterPluginPackages(options(db)),
    (error) => error.code === 'server_version_unsupported',
  );
  assert.equal(db.closes(), 1);
});
