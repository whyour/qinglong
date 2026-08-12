const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const {
  runMigrationStream,
} = require('@qinglong/runtime-core/migration-stream');
const {
  createLocalExecutionContextRecipe,
  createLocalTaskExecutionRevision,
} = require('@qinglong/runtime-core/local-dispatch');
const {
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');
const {
  createBuiltInTaskSpecSemanticRegistry,
} = require('@qinglong/runtime-core/task-spec-semantic');
const {
  compileLocalCommandTaskDefinition,
} = require('@qinglong/runtime-core/task-definition-execution-compiler');
const {
  LocalSqliteConfigurationError,
  LocalSqliteReadinessError,
  auditLocalSqlitePath,
  migrateLocalSqlitePath,
  openLocalSqliteRuntimeDatabase,
} = require('../dist');
const {
  localSqliteMigrationDefinition,
} = require('../dist/migration/migration');
const {
  LocalSqliteMigrationStreamStore,
} = require('../dist/migration/migrationStreamStore');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-local-sqlite-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    databasePath: path.join(directory, 'qinglong3.sqlite'),
  };
}

test('creates a reviewed edge database and opens runtime only after readiness', async (t) => {
  const { databasePath } = fixture(t);
  const options = { databasePath, profile: 'edge' };

  const migrated = await migrateLocalSqlitePath(options);
  assert.deepEqual(migrated.readiness.migrationIds, [
    '0001-run-core',
    '0002-capability',
    '0003-completion-receipt-journal',
    '0004-capability-v2',
    '0005-local-dispatch-plan',
    '0006-capability-v3',
    '0007-local-secret-envelopes',
    '0008-capability-v4',
    '0009-local-project-policy-audit',
    '0010-capability-v5',
    '0011-local-identity-credential',
    '0012-capability-v6',
    '0013-local-owner-bootstrap',
    '0014-capability-v7',
    '0015-local-owner-delivery-acknowledgements',
    '0016-capability-v8',
    '0017-api-credential-pepper-bindings',
    '0018-capability-v9',
    '0019-local-owner-pepper-catalog',
    '0020-capability-v10',
    '0021-local-owner-credential-recovery',
    '0022-capability-v11',
    '0023-local-owner-pepper-material-gc',
    '0024-capability-v12',
    '0025-local-owner-delivery-acknowledgement-gc',
    '0026-capability-v13',
    '0027-task-definitions',
    '0028-capability-v14',
    '0029-local-execution-revision-digest',
    '0030-capability-v15',
    '0031-trigger-definitions',
    '0032-capability-v16',
    '0033-legacy-adoption-ledger',
    '0034-capability-v17',
    '0035-local-scheduler',
    '0036-capability-v18',
    '0037-plugin-package-installs',
    '0038-capability-v19',
    '0039-approved-actions',
    '0040-capability-v20',
    '0041-plugin-package-admission-receipts',
    '0042-capability-v21',
    '0043-approved-action-executions-and-package-proposals',
    '0044-capability-v22',
    '0045-plugin-package-materialized-revisions',
    '0046-capability-v23',
    '0047-plugin-package-task-reconciliations',
    '0048-capability-v24',
    '0049-project-tool-definition-snapshots',
    '0050-capability-v25',
    '0051-step-runs',
    '0052-capability-v26',
    '0053-tool-execution-evidence',
    '0054-capability-v27',
    '0055-tool-execution-start-barriers',
    '0056-capability-v28',
    '0057-tool-invocation-artifacts',
    '0058-capability-v29',
    '0059-tool-execution-artifact-bindings',
    '0060-capability-v30',
    '0061-tool-execution-completions',
    '0062-capability-v31',
    '0063-tool-execution-failure-completions',
    '0064-capability-v32',
    '0065-tool-result-key-catalog',
    '0066-capability-v33',
    '0067-tool-result-rekey-overlays',
    '0068-capability-v34',
    '0069-plugin-package-quarantine',
    '0070-capability-v35',
    '0071-local-identity-credential-administration',
    '0072-capability-v36',
    '0073-local-project-administration',
    '0074-capability-v37',
    '0075-security-audit-compactions',
    '0076-capability-v38',
    '0077-plugin-package-lifecycle',
    '0078-capability-v39',
    '0079-plugin-package-automation-publications',
    '0080-capability-v40',
    '0081-plugin-package-workflow-admissions',
    '0082-capability-v41',
    '0083-plugin-package-workflow-task-attempt-admissions',
    '0084-capability-v42',
    '0085-plugin-package-workflow-run-list-index',
    '0086-capability-v43',
    '0087-run-attempt-log-retention',
    '0088-capability-v44',
    '0089-plugin-package-automation-disposition-events',
    '0090-capability-v45',
  ]);
  assert.equal(migrated.readiness.contractName, 'local-control-core');
  assert.equal(migrated.readiness.contractVersion, 45);
  assert.equal(migrated.readiness.journalMode, 'delete');
  assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);

  assert.deepEqual(await auditLocalSqlitePath(options), migrated.readiness);
  const runtime = await openLocalSqliteRuntimeDatabase(options);
  assert.equal(runtime.profile, 'edge');
  assert.deepEqual(runtime.readiness, migrated.readiness);
  assert.deepEqual(Object.keys(runtime.localDispatch).sort(), [
    'appendLocalExecutionContextRecipe',
    'appendLocalTaskExecutionRevision',
    'listLocalDispatchCandidates',
    'resolveLocalExecutionContextRecipe',
    'resolveLocalTaskExecutionRevision',
  ]);
  assert.deepEqual(Object.keys(runtime.executionControl).sort(), [
    'listLocalActiveExecutions',
    'listLocalExecutionControlCandidates',
  ]);
  assert.deepEqual(Object.keys(runtime.startupRecovery), ['inspectCandidates']);
  assert.deepEqual(Object.keys(runtime.completionReceipts).sort(), [
    'listCandidates',
    'markQuarantined',
    'register',
    'resolve',
  ]);
  for (const capability of [
    runtime.localDispatch,
    runtime.executionControl,
    runtime.startupRecovery,
    runtime.completionReceipts,
  ]) {
    assert.equal(Object.isFrozen(capability), true);
    assert.notEqual(capability, runtime.runRepository);
  }
  assert.equal(runtime.runRepository.register, undefined);
  assert.equal(runtime.runRepository.listLocalDispatchCandidates, undefined);
  assert.equal(
    typeof runtime.localSecrets.resolveLocalSecretEnvelopes,
    'function',
  );
  assert.equal(typeof runtime.projectPolicy.resolve, 'function');
  assert.equal(
    typeof runtime.localSecretAdministration
      .appendAuthorizedLocalSecretEnvelope,
    'function',
  );
  assert.equal(typeof runtime.securityAudit.record, 'function');
  assert.equal(typeof runtime.apiCredentials.resolve, 'function');
  assert.equal(
    typeof runtime.taskDefinitions.findCurrentTaskDefinition,
    'function',
  );
  assert.equal(typeof runtime.triggers.findCurrentTrigger, 'function');
  assert.equal(
    typeof (await runtime.projectToolDefinitionSnapshots()).findCurrent,
    'function',
  );
  assert.equal(
    typeof (await runtime.pluginPackageAutomationPublications())
      .listPendingPage,
    'function',
  );
  await Promise.all([runtime.close(), runtime.close()]);
  for (const operation of [
    runtime.runRepository.findRunById('closed-run'),
    runtime.localDispatch.listLocalDispatchCandidates({ limit: 1 }),
    runtime.executionControl.listLocalExecutionControlCandidates({
      observedAtMs: 1,
      limit: 1,
    }),
    runtime.startupRecovery.inspectCandidates({ limit: 1 }),
    runtime.completionReceipts.listCandidates({
      observedAtMs: 1,
      limit: 1,
    }),
  ]) {
    await assert.rejects(
      operation,
      (error) => error?.name === 'RunRepositoryOperationError',
    );
  }
});

test('standalone opts into bounded WAL while edge keeps rollback journal', async (t) => {
  const { databasePath } = fixture(t);
  const options = { databasePath, profile: 'standalone' };
  const migrated = await migrateLocalSqlitePath(options);
  assert.equal(migrated.readiness.journalMode, 'wal');
  const runtime = await openLocalSqliteRuntimeDatabase(options);
  assert.equal(runtime.readiness.journalMode, 'wal');
  await runtime.close();
});

test('loads one shared trusted Tool storage bundle only when requested', async (t) => {
  const { databasePath } = fixture(t);
  const options = { databasePath, profile: 'edge' };
  await migrateLocalSqlitePath(options);
  const runtime = await openLocalSqliteRuntimeDatabase(options);

  const first = await runtime.trustedToolStorage();
  const second = await runtime.trustedToolStorage();
  assert.equal(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(typeof first.invocationArtifacts.findInput, 'function');
  assert.equal(typeof first.stepRuns.findById, 'function');
  assert.equal(typeof first.startBarriers.findByStartId, 'function');
  assert.equal(typeof first.completions.findByStartId, 'function');
  assert.equal(typeof first.failureCompletions.findByStartId, 'function');
  assert.equal(typeof first.resultKeyCatalog.findCurrent, 'function');
  assert.equal(first.resultKeyCatalog.append, undefined);
  assert.equal(typeof first.resultRekeys.findHeadByArtifactId, 'function');
  assert.equal(first.resultRekeys.append, undefined);
  assert.equal(typeof first.toolDefinitionSnapshots.findCurrent, 'function');
  assert.equal(
    first.toolDefinitionSnapshots,
    await runtime.projectToolDefinitionSnapshots(),
  );

  await runtime.close();
});

test('backfills legacy credential provenance and recovery-required catalog state', async () => {
  const client = new DatabaseSync(':memory:');
  try {
    client.exec('PRAGMA foreign_keys = ON');
    const legacyStream = {
      ...localSqliteMigrationDefinition,
      migrations: localSqliteMigrationDefinition.migrations.slice(0, 16),
    };
    await runMigrationStream({
      stream: legacyStream,
      store: new LocalSqliteMigrationStreamStore(client),
    });
    client.exec(`
      INSERT INTO "QingLong3IdentitySubjects" (
        "subject_type", "subject_id", "status", "version",
        "created_at_ms", "updated_at_ms"
      ) VALUES ('user', 'legacy-user', 'active', 1, 1, 1);
      INSERT INTO "QingLong3ApiCredentials" (
        "credential_id", "version", "state", "subject_type", "subject_id",
        "secret_digest", "created_at_ms", "not_before_at_ms", "expires_at_ms"
      ) VALUES (
        'legacy-credential', 1, 'active', 'user', 'legacy-user',
        '${'a'.repeat(64)}', 1, 1, 2
      );
    `);
    await localSqliteMigrationDefinition.migrations[16].up({ client });
    client.exec('BEGIN IMMEDIATE');
    try {
      await localSqliteMigrationDefinition.migrations[18].up({ client });
      client.exec('COMMIT');
    } catch (error) {
      if (client.isTransaction) client.exec('ROLLBACK');
      throw error;
    }
    assert.deepEqual(
      {
        ...client
          .prepare(
            `SELECT credential_id, credential_version, pepper_key_id
               FROM "QingLong3ApiCredentialPepperBindings"`,
          )
          .get(),
      },
      {
        credential_id: 'legacy-credential',
        credential_version: 1,
        pepper_key_id: 'legacy-v1',
      },
    );
    assert.deepEqual(
      {
        ...client
          .prepare(
            `SELECT pepper_key_id, state, version, material_digest
               FROM "QingLong3LocalOwnerPepperKeys"`,
          )
          .get(),
      },
      {
        pepper_key_id: 'legacy-v1',
        state: 'recovery_required',
        version: 1,
        material_digest: null,
      },
    );
  } finally {
    client.close();
  }
});

test('backfills v14 execution revisions with a verified independent digest', async () => {
  const client = new DatabaseSync(':memory:');
  try {
    client.exec('PRAGMA foreign_keys = ON');
    await runMigrationStream({
      stream: {
        ...localSqliteMigrationDefinition,
        migrations: localSqliteMigrationDefinition.migrations.slice(0, 28),
      },
      store: new LocalSqliteMigrationStreamStore(client),
    });
    const recipe = createLocalExecutionContextRecipe({
      environment: [{ name: 'VALUE', kind: 'public', value: 'legacy' }],
      createdAtMs: 10,
    });
    client
      .prepare(
        `INSERT INTO "QingLong3LocalExecutionContextRecipes" (
           "context_ref", "environment_json", "content_digest", "created_at_ms"
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        recipe.contextRef,
        JSON.stringify(recipe.environment),
        recipe.contentDigest,
        recipe.createdAtMs,
      );
    client
      .prepare(
        `INSERT INTO "QingLong3LocalTaskExecutionRevisions" (
           "project_id", "task_id", "task_revision", "executor_type",
           "command_json", "working_directory", "timeout_ms",
           "context_ref", "created_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'default',
        'legacy-task',
        'legacy-revision',
        'local_process',
        JSON.stringify({ kind: 'argv', file: '/bin/echo', args: ['legacy'] }),
        '/tmp',
        1000,
        recipe.contextRef,
        11,
      );
    const registry = createBuiltInTaskSpecSemanticRegistry();
    const taskCommand = {
      projectId: 'default',
      taskId: 'task-definition-backfill',
      expectedRevision: null,
      mutationId: '019f7200-0000-7000-8000-000000000029',
      name: 'Backfilled TaskDefinition',
      kind: 'command',
      spec: registry.normalize({
        projectId: 'default',
        taskId: 'task-definition-backfill',
        kind: 'command',
        spec: {
          schema: 'qinglong/command@v1',
          config: {
            command: {
              kind: 'argv',
              file: '/bin/echo',
              args: ['definition'],
            },
          },
        },
      }),
      labels: {},
      enabled: true,
      occurredAtMs: 12,
    };
    const taskDefinition = createTaskDefinitionRecord(taskCommand, 12);
    const taskPlan = compileLocalCommandTaskDefinition(
      taskDefinition,
      registry,
    );
    client
      .prepare(
        `INSERT INTO "QingLong3TaskDefinitions" (
           "project_id", "task_id", "current_revision",
           "created_at_ms", "updated_at_ms"
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        taskDefinition.projectId,
        taskDefinition.taskId,
        taskDefinition.revision,
        taskDefinition.createdAtMs,
        taskDefinition.updatedAtMs,
      );
    client
      .prepare(
        `INSERT INTO "QingLong3TaskDefinitionRevisions" (
           "project_id", "task_id", "revision", "mutation_id",
           "name", "description", "kind", "spec_json", "labels_json",
           "enabled", "content_digest", "created_at_ms"
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskDefinition.projectId,
        taskDefinition.taskId,
        taskDefinition.revision,
        taskDefinition.mutationId,
        taskDefinition.name,
        null,
        taskDefinition.kind,
        JSON.stringify(taskDefinition.spec),
        JSON.stringify(taskDefinition.labels),
        1,
        taskDefinition.contentDigest,
        taskDefinition.updatedAtMs,
      );

    await runMigrationStream({
      stream: localSqliteMigrationDefinition,
      store: new LocalSqliteMigrationStreamStore(client),
    });

    const expected = createLocalTaskExecutionRevision({
      projectId: 'default',
      taskId: 'legacy-task',
      taskRevision: 'legacy-revision',
      executorType: 'local_process',
      command: { kind: 'argv', file: '/bin/echo', args: ['legacy'] },
      workingDirectory: '/tmp',
      timeoutMs: 1000,
      contextRef: recipe.contextRef,
      createdAtMs: 11,
    });
    const stored = client
      .prepare(
        `SELECT "content_digest" AS "contentDigest", "command_json" AS "commandJson"
         FROM "QingLong3LocalTaskExecutionRevisions"`,
      )
      .get();
    assert.equal(stored.contentDigest, expected.contentDigest);
    assert.equal(stored.commandJson, JSON.stringify(expected.command));
    assert.deepEqual(
      {
        ...client
          .prepare(
            `SELECT "content_digest" AS "contentDigest",
                    "context_ref" AS "contextRef"
             FROM "QingLong3LocalTaskExecutionRevisions"
             WHERE "project_id" = ? AND "task_id" = ?
               AND "task_revision" = ?`,
          )
          .get(
            taskDefinition.projectId,
            taskDefinition.taskId,
            taskPlan.executionRevision.taskRevision,
          ),
      },
      {
        contentDigest: taskPlan.executionRevision.contentDigest,
        contextRef: taskPlan.contextRecipe.contextRef,
      },
    );
    assert.deepEqual(
      {
        ...client
          .prepare(
            `SELECT contract_version, migration_id
             FROM "QingLong3SchemaCapabilities"
             WHERE contract_name = 'local-control-core'`,
          )
          .get(),
      },
      {
        contract_version: 45,
        migration_id: '0089-plugin-package-automation-disposition-events',
      },
    );
  } finally {
    client.close();
  }
});

test('rolls the digest migration back when a legacy revision is not canonical', async () => {
  const client = new DatabaseSync(':memory:');
  try {
    client.exec('PRAGMA foreign_keys = ON');
    await runMigrationStream({
      stream: {
        ...localSqliteMigrationDefinition,
        migrations: localSqliteMigrationDefinition.migrations.slice(0, 28),
      },
      store: new LocalSqliteMigrationStreamStore(client),
    });
    const recipe = createLocalExecutionContextRecipe({
      environment: [],
      createdAtMs: 1,
    });
    client
      .prepare(
        `INSERT INTO "QingLong3LocalExecutionContextRecipes" (
           "context_ref", "environment_json", "content_digest", "created_at_ms"
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(recipe.contextRef, '[]', recipe.contentDigest, 1);
    client
      .prepare(
        `INSERT INTO "QingLong3LocalTaskExecutionRevisions" (
           "project_id", "task_id", "task_revision", "executor_type",
           "command_json", "working_directory", "timeout_ms",
           "context_ref", "created_at_ms"
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        'default',
        'corrupt-task',
        'corrupt-revision',
        'local_process',
        '{}',
        recipe.contextRef,
        1,
      );

    await assert.rejects(
      runMigrationStream({
        stream: localSqliteMigrationDefinition,
        store: new LocalSqliteMigrationStreamStore(client),
      }),
      /command kind is invalid/,
    );
    assert.equal(
      client
        .prepare(
          `SELECT COUNT(*) AS count FROM pragma_table_info(
             'QingLong3LocalTaskExecutionRevisions'
           ) WHERE name = 'content_digest'`,
        )
        .get().count,
      0,
    );
    assert.equal(
      client
        .prepare(`SELECT COUNT(*) AS count FROM "QingLong3SchemaMigrations"`)
        .get().count,
      28,
    );
  } finally {
    client.close();
  }
});

test('runtime entrypoint keeps migration, compiler and Plugin Package adapter lazy', () => {
  const script = `
    require('@qinglong/local-sqlite/runtime');
    const loaded = Object.keys(require.cache)
      .filter((entry) =>
        /[\\/]migrations[\\/]|[\\/]migration\\.js$|taskDefinitionExecutionCompiler\\.js$|pluginPackageInstallRepository\\.js$|approvedActionExecutionRepository\\.js$|pluginPackageProposalRepository\\.js$/.test(entry),
      );
    process.stdout.write(JSON.stringify(loaded));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('readiness inspection subpath excludes DDL and mutable repositories', () => {
  const script = `
    const inspection = require(${JSON.stringify(
      path.resolve(__dirname, '../dist/readiness/readinessInspection.js'),
    )});
    const loaded = Object.keys(require.cache)
      .filter((entry) =>
        /[\\/]migrations[\\/]|[\\/]migration\\.js$|runRepository\\.js$|pluginPackageInstallRepository\\.js$/.test(entry),
      );
    process.stdout.write(JSON.stringify({
      inspection: typeof inspection.inspectLocalSqliteReadinessPath,
      loaded,
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    inspection: 'function',
    loaded: [],
  });
});

test('Approved Action execution and Package proposal authorities require explicit subpaths', () => {
  const root = require('@qinglong/local-sqlite');
  const execution = require('@qinglong/local-sqlite/approved-action-execution');
  const proposal = require('@qinglong/local-sqlite/plugin-package-proposal');
  assert.equal(root.LocalSqliteApprovedActionExecutionRepository, undefined);
  assert.equal(
    root.LocalSqlitePluginPackageInstallProposalRepository,
    undefined,
  );
  assert.equal(
    typeof execution.LocalSqliteApprovedActionExecutionRepository,
    'function',
  );
  assert.equal(
    typeof proposal.LocalSqlitePluginPackageInstallProposalRepository,
    'function',
  );
});

test('runtime bootstrap never auto-migrates an unprepared database', async (t) => {
  const { databasePath } = fixture(t);
  new DatabaseSync(databasePath).close();

  await assert.rejects(
    openLocalSqliteRuntimeDatabase({ databasePath, profile: 'standalone' }),
    LocalSqliteReadinessError,
  );
  const client = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(
      client
        .prepare(
          `SELECT 1 FROM sqlite_schema
           WHERE type = 'table' AND name = 'QingLong3SchemaMigrations'`,
        )
        .get(),
      undefined,
    );
  } finally {
    client.close();
  }
});

test('fails closed for schema drift and migration checksum drift', async (t) => {
  const { databasePath } = fixture(t);
  const options = { databasePath, profile: 'standalone' };
  await migrateLocalSqlitePath(options);

  const client = new DatabaseSync(databasePath);
  client.exec('DROP INDEX ql3_local_events_run_sequence_uidx');
  client
    .prepare(
      `UPDATE "QingLong3SchemaMigrations"
       SET checksum = ? WHERE migration_id = '0001-run-core'`,
    )
    .run('0'.repeat(64));
  client.close();

  await assert.rejects(
    auditLocalSqlitePath(options),
    (error) =>
      error instanceof LocalSqliteReadinessError &&
      /audit failed/.test(error.message),
  );
});

test('excludes reviewed optional feature tables while preserving unknown table drift evidence', async (t) => {
  const { databasePath } = fixture(t);
  const options = { databasePath, profile: 'edge' };
  await migrateLocalSqlitePath(options);
  const client = new DatabaseSync(databasePath);
  assert.equal((await auditLocalSqlitePath(options)).tableCount, 79);
  client.exec(
    'CREATE TABLE "ModelInvocationFeatureHead" (feature_id TEXT PRIMARY KEY)',
  );
  client.close();

  assert.equal((await auditLocalSqlitePath(options)).tableCount, 79);

  const unknownClient = new DatabaseSync(databasePath);
  unknownClient.exec('CREATE TABLE "UserExtensionData" (id TEXT PRIMARY KEY)');
  unknownClient.close();

  assert.equal((await auditLocalSqlitePath(options)).tableCount, 80);

  const triggerClient = new DatabaseSync(databasePath);
  triggerClient.exec(`
    CREATE TRIGGER unreviewed_run_trigger AFTER INSERT ON "Runs"
    BEGIN
      SELECT 1;
    END
  `);
  triggerClient.close();
  await assert.rejects(
    auditLocalSqlitePath(options),
    /reviewed trigger contract is incompatible/,
  );
});

test('rejects wrong Profiles, relative paths and symlink targets before opening', async (t) => {
  const { directory, databasePath } = fixture(t);
  await assert.rejects(
    () =>
      migrateLocalSqlitePath({
        databasePath,
        profile: 'cluster-control',
      }),
    LocalSqliteConfigurationError,
  );
  await assert.rejects(
    () =>
      migrateLocalSqlitePath({ databasePath: 'relative.db', profile: 'edge' }),
    LocalSqliteConfigurationError,
  );

  const target = path.join(directory, 'target.sqlite');
  new DatabaseSync(target).close();
  const link = path.join(directory, 'linked.sqlite');
  fs.symlinkSync(target, link);
  await assert.rejects(
    migrateLocalSqlitePath({ databasePath: link, profile: 'edge' }),
    LocalSqliteConfigurationError,
  );
});
