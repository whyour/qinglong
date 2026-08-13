const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  postgresqlControlSchemaContract,
  postgresqlMainMigrationManifest,
} = require('@qinglong/cluster-postgres');
const { bootstrapClusterAdmin } = require('@qinglong/cluster-admin');

const PEPPER = 'A'.repeat(43);
const WORKER_PEPPER = Buffer.alloc(32, 0x42).toString('base64url');

function history() {
  return postgresqlMainMigrationManifest.migrations.map((migration, index) => ({
    streamId: postgresqlMainMigrationManifest.id,
    dialect: postgresqlMainMigrationManifest.dialect,
    migrationId: migration.id,
    checksum: migration.checksum,
    appliedAtMs: index + 1,
  }));
}

function adminPrivileges() {
  const writable = new Set([
    'identity_subjects',
    'api_credentials',
    'security_audit_events',
    'identity_subject_mutations',
    'api_credential_mutations',
    'worker_credentials',
    'worker_credential_mutations',
    'worker_credential_deliveries',
    'worker_credential_stage_discards',
    'tool_result_key_catalog_generations',
    'tool_execution_result_rekey_overlays',
    'tool_execution_result_rekey_heads',
    'tool_result_key_retirement_receipts',
  ]);
  const readable = new Set([
    'schema_migrations',
    'schema_capabilities',
    'projects',
    'plugin_package_task_ownerships',
    'tool_execution_completions',
    'tool_execution_result_key_bindings',
    ...writable,
  ]);
  return postgresqlControlSchemaContract.tables.map(({ name: tableName }) => ({
    tableName,
    selectAllowed: readable.has(tableName),
    insertAllowed: writable.has(tableName),
    updateAllowed: [
      'identity_subjects',
      'worker_credentials',
      'tool_execution_result_rekey_heads',
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
                currentUser: 'ql3_admin',
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
        if (text.includes('FROM pg_trigger triggers')) {
          return {
            rows: contract.triggers.map((definition) => ({
              triggerName: definition.name,
              tableName: definition.tableName,
              functionName: definition.functionName,
              enabled: 'O',
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
          return { rows: adminPrivileges() };
        }
        if (text.includes('has_function_privilege')) {
          return {
            rows: contract.functions.map(({ name: functionName }) => ({
              functionName,
              executeAllowed: ![
                'commit_plugin_package_lifecycle',
                'commit_plugin_package_task_reconciliation',
                'commit_plugin_package_quarantine',
                'enforce_plugin_package_secret_binding_target',
                'enforce_plugin_package_secret_materialization',
                'enforce_plugin_package_stage_provenance',
                'lock_active_plugin_package_project',
                'lock_approval_policy_fence',
                'lock_run_management_policy_fence',
                'plugin_package_lifecycle_blocking_runs',
                'plugin_package_secret_binding_planning_snapshot',
                'plugin_package_automation_start_allowed',
                'plugin_package_run_start_allowed',
                'plugin_package_tool_start_allowed',
                'plugin_package_workflow_admission_snapshot',
                'plugin_package_workflow_task_attempt_snapshot',
                'register_plugin_package_automation_disposition_event',
                'create_plugin_package_secret_binding_approval_plan',
              ].includes(functionName),
              isOwner: false,
            })),
          };
        }
        throw new Error(`unexpected query: ${text}`);
      },
      async connect() {
        throw new Error('not used during bootstrap');
      },
    },
    async close() {
      closes += 1;
    },
  };
  return { resource, closes: () => closes };
}

test('rejects an invalid pepper before opening PostgreSQL', async () => {
  let opens = 0;
  await assert.rejects(
    bootstrapClusterAdmin({
      apiCredentialPepper: 'invalid',
      workerCredentialPepper: WORKER_PEPPER,
      async openDatabase() {
        opens += 1;
        return database().resource;
      },
    }),
    /pepper is invalid/,
  );
  assert.equal(opens, 0);
});

test('rejects invalid optional configuration before opening PostgreSQL', async () => {
  let opens = 0;
  await assert.rejects(
    bootstrapClusterAdmin({
      apiCredentialPepper: PEPPER,
      workerCredentialPepper: WORKER_PEPPER,
      now: 1,
      async openDatabase() {
        opens += 1;
        return database().resource;
      },
    }),
    /clock is invalid/,
  );
  assert.equal(opens, 0);
});

test('closes PostgreSQL after readiness failure', async () => {
  const db = database('150018');
  await assert.rejects(
    bootstrapClusterAdmin({
      apiCredentialPepper: PEPPER,
      workerCredentialPepper: WORKER_PEPPER,
      async openDatabase() {
        return db.resource;
      },
    }),
    (error) => error.code === 'server_version_unsupported',
  );
  assert.equal(db.closes(), 1);
});

test('assembles isolated administration and audit ports after readiness', async () => {
  const db = database();
  const runtime = await bootstrapClusterAdmin({
    apiCredentialPepper: PEPPER,
    workerCredentialPepper: WORKER_PEPPER,
    async openDatabase() {
      return db.resource;
    },
  });
  assert.equal(runtime.evidence.currentUser, 'ql3_admin');
  assert.equal(
    runtime.evidence.contractVersion,
    postgresqlControlSchemaContract.contractVersion,
  );
  assert.equal(typeof runtime.administration.issueCredential, 'function');
  assert.equal(typeof runtime.audit.list, 'function');
  assert.equal(typeof runtime.workerCredentials.issue, 'function');
  assert.equal('taskDefinitions' in runtime, false);
  assert.equal('triggers' in runtime, false);
  await Promise.all([runtime.close(), runtime.close()]);
  assert.equal(db.closes(), 1);
});
