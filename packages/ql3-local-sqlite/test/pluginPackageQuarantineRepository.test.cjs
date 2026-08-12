const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  PluginPackageQuarantineConflictError,
  PluginPackageQuarantineUnavailableError,
  createPluginPackageQuarantineEvent,
} = require('@qinglong/runtime-core/plugin-package-quarantine');
const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  RunRepositoryConstraintError,
} = require('@qinglong/runtime-core/run-repository');
const {
  createTaskDefinitionRevisionRef,
} = require('@qinglong/runtime-core/task-definition-execution-compiler');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  LocalSqliteOperationAuthority,
} = require('../dist/authority/operationAuthority');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('../dist/plugin-package/pluginPackageInstallRepository');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('../dist/plugin-package/pluginPackageMaterializedRevisionRepository');
const {
  LocalSqlitePluginPackageAutomationPublicationRepository,
} = require('../dist/plugin-package/pluginPackageAutomationPublicationRepository');
const {
  LocalSqlitePluginPackageTaskReconciliationRepository,
} = require('../dist/plugin-package/pluginPackageTaskReconciliationRepository');
const {
  LocalSqliteProjectToolDefinitionSnapshotRepository,
} = require('../dist/tool-execution/projectToolDefinitionSnapshotRepository');
const { LocalSqliteRunRepository } = require('../dist/run/runRepository');
const {
  EDGE_PLUGIN_PACKAGE_QUARANTINE_ACTIVE_SOURCE_LIMIT,
  LocalSqlitePluginPackageQuarantineRepository,
} = require('../dist/plugin-package/pluginPackageQuarantineRepository');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');
const {
  LocalSqliteReadinessError,
  auditLocalSqliteReadiness,
} = require('../dist/readiness/readiness');

const digest = (value) => value.repeat(64);

async function harness(t, namespace) {
  const fixture = pluginPackageTaskReconciliationFixture(namespace, {
    profile: 'edge',
    workflows: [
      {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'daily',
        name: 'Daily workflow',
        enabled: true,
        steps: [{ id: 'run', task: 'alpha', needs: [] }],
      },
    ],
    prompts: [
      {
        schema: 'qinglong/plugin-package-prompt-resource@v1',
        id: 'operator',
        name: 'Operator prompt',
        template: 'Run {{task}}',
        parameters: [{ name: 'task', required: true }],
      },
    ],
  });
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  client
    .prepare(
      `INSERT INTO "QingLong3Projects"
       (id, name, slug, status, version, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'active', 1, 1, 1)`,
    )
    .run(fixture.projectId, fixture.projectId, fixture.projectId);
  const authority = new LocalSqliteOperationAuthority(client);
  t.after(() => authority.close());
  return {
    fixture,
    client,
    install: new LocalSqlitePluginPackageInstallRepository(authority),
    materialized: new LocalSqlitePluginPackageMaterializedRevisionRepository(
      authority,
      fixture.registry,
    ),
    automation: new LocalSqlitePluginPackageAutomationPublicationRepository(
      authority,
    ),
    reconciliation: new LocalSqlitePluginPackageTaskReconciliationRepository(
      authority,
      fixture.registry,
    ),
    snapshots: new LocalSqliteProjectToolDefinitionSnapshotRepository(
      authority,
    ),
    runs: new LocalSqliteRunRepository(authority),
    quarantine: new LocalSqlitePluginPackageQuarantineRepository(authority, {
      registry: fixture.registry,
      activeSourceLimit: EDGE_PLUGIN_PACKAGE_QUARANTINE_ACTIVE_SOURCE_LIMIT,
    }),
  };
}

function quarantineEvent(fixture, record = fixture.install.active) {
  return createPluginPackageQuarantineEvent({
    mutationId: `quarantine-${fixture.namespace}`,
    revocationReceiptDigest: digest('d'),
    impactDigest: digest('e'),
    target: {
      projectId: record.projectId,
      packageName: record.packageName,
      installationId: record.installationId,
      lockDigest: record.lockDigest,
      installState: record.state,
      installVersion: record.version,
      installRecordDigest: record.recordDigest,
      activeLockDigest: record.activeLockDigest,
    },
    proposer: { type: 'user', id: 'owner-a' },
    confirmer: { type: 'user', id: 'owner-b' },
    authorizationMode: 'dual_control',
    reasonCode: 'confirmed_key_compromise',
    occurredAtMs: record.updatedAtMs + 1,
  });
}

async function publishActivePackage(value) {
  await activateInstall(value.install, value.fixture);
  await value.materialized.publish(value.fixture.revision);
  await value.automation.publish(
    createInitialPluginPackageAutomationPublication(
      value.fixture.revision,
      value.fixture.registry,
      value.fixture.install.active.updatedAtMs,
    ),
  );
  await value.reconciliation.reconcile(value.fixture.revision, {
    async findActiveResourceGeneration() {
      return value.fixture.revision.generation;
    },
  });
}

test('withdraws active Package Tasks and Tool source in one exact replayable transaction', async (t) => {
  const value = await harness(t, 'sqlite-quarantine-active');
  await publishActivePackage(value);
  const event = quarantineEvent(value.fixture);
  assert.deepEqual(
    await value.quarantine.findTargetsByLockDigest(event.target.lockDigest),
    [event.target],
  );

  let authorizationChecks = 0;
  const created = await value.quarantine.quarantine(event, () => {
    authorizationChecks += 1;
  });
  assert.equal(authorizationChecks, 2);
  assert.equal(created.status, 'created');
  assert.equal(created.receipt.capability.status, 'withdrawn');
  assert.deepEqual(
    created.receipt.capability.taskWithdrawals.map(
      ({ taskId, previousRevision, disabledRevision }) => ({
        taskId,
        previousRevision,
        disabledRevision,
      }),
    ),
    [
      {
        taskId: `pkg:${value.fixture.packageName}:alpha`,
        previousRevision: 1,
        disabledRevision: 2,
      },
      {
        taskId: `pkg:${value.fixture.packageName}:beta`,
        previousRevision: 1,
        disabledRevision: 2,
      },
    ],
  );
  assert.equal(created.receipt.capability.retainedSourceCount, 0);
  assert.notEqual(
    created.receipt.capability.previousActiveVectorDigest,
    created.receipt.capability.currentActiveVectorDigest,
  );
  assert.deepEqual(
    value.client
      .prepare(
        `SELECT task_id AS "taskId", current_revision AS "revision"
         FROM "QingLong3TaskDefinitions"
         WHERE project_id = ? ORDER BY task_id`,
      )
      .all(value.fixture.projectId)
      .map((row) => ({ ...row })),
    [
      { taskId: `pkg:${value.fixture.packageName}:alpha`, revision: 2 },
      { taskId: `pkg:${value.fixture.packageName}:beta`, revision: 2 },
    ],
  );
  assert.equal(
    value.client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3TaskDefinitionRevisions"
         WHERE project_id = ? AND enabled = 0`,
      )
      .get(value.fixture.projectId).count,
    2,
  );
  assert.equal(
    value.client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3ProjectToolDefinitionSnapshotSources"
         WHERE project_id = ? AND active_vector_digest = ?`,
      )
      .get(
        value.fixture.projectId,
        created.receipt.capability.currentActiveVectorDigest,
      ).count,
    0,
  );
  assert.equal(
    (await value.snapshots.findCurrent(value.fixture.projectId)).snapshot
      .snapshotDigest,
    created.receipt.capability.currentToolSnapshotDigest,
  );
  const automation = await value.automation.findCurrent(
    value.fixture.projectId,
    value.fixture.packageName,
  );
  assert.equal(automation.state, 'withdrawn');
  assert.equal(automation.lifecycleEventDigest, event.eventDigest);
  assert.equal(automation.version, 2);

  const replay = await value.quarantine.quarantine(event, () => {
    authorizationChecks += 1;
  });
  assert.equal(authorizationChecks, 4);
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.receipt, created.receipt);
  assert.deepEqual(
    await value.quarantine.findByEventDigest(event.eventDigest),
    created.receipt,
  );
});

test('records a queued target without inventing Task or Tool withdrawal', async (t) => {
  const value = await harness(t, 'sqlite-quarantine-queued');
  await value.install.create(value.fixture.install.create);
  const event = quarantineEvent(value.fixture, value.fixture.install.queued);
  const created = await value.quarantine.quarantine(event, () => {});
  assert.equal(created.receipt.capability.status, 'not_active');
  assert.deepEqual(created.receipt.capability.taskWithdrawals, []);
  assert.deepEqual(await value.install.listRecoveryPage({ limit: 1 }), {
    records: [],
    truncated: false,
  });
  assert.equal(
    value.client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3ProjectToolDefinitionSnapshots"`,
      )
      .get().count,
    0,
  );
});

test('rolls back every withdrawal fact when the target install advanced', async (t) => {
  const value = await harness(t, 'sqlite-quarantine-stale');
  await publishActivePackage(value);
  const stale = quarantineEvent(value.fixture, {
    ...value.fixture.install.active,
    version: value.fixture.install.active.version - 1,
  });
  await assert.rejects(
    value.quarantine.quarantine(stale, () => {}),
    PluginPackageQuarantineConflictError,
  );
  assert.equal(
    value.client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3PluginPackageQuarantineEvents"`,
      )
      .get().count,
    0,
  );
  assert.equal(
    value.client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3TaskDefinitionRevisions"
         WHERE project_id = ? AND enabled = 0`,
      )
      .get(value.fixture.projectId).count,
    0,
  );
  assert.equal(
    (
      await value.automation.findCurrent(
        value.fixture.projectId,
        value.fixture.packageName,
      )
    ).state,
    'active',
  );
});

test('fails closed when quarantine automation withdrawal evidence is rewound', async (t) => {
  const value = await harness(t, 'sqlite-quarantine-automation-corrupt');
  await publishActivePackage(value);
  const event = quarantineEvent(value.fixture);
  await value.quarantine.quarantine(event, () => {});
  const active = value.client
    .prepare(
      `SELECT publication_digest AS "publicationDigest"
       FROM "QingLong3PluginPackageAutomationPublications"
       WHERE project_id = ? AND package_name = ? AND state = 'active'`,
    )
    .get(value.fixture.projectId, value.fixture.packageName);
  value.client.exec('PRAGMA foreign_keys = OFF');
  value.client
    .prepare(
      `UPDATE "QingLong3PluginPackageAutomationPublicationHeads"
       SET publication_digest = ?, state = 'active', version = 1
       WHERE project_id = ? AND package_name = ?`,
    )
    .run(
      active.publicationDigest,
      value.fixture.projectId,
      value.fixture.packageName,
    );
  value.client
    .prepare(
      `DELETE FROM "QingLong3PluginPackageAutomationPublications"
       WHERE project_id = ? AND package_name = ? AND state = 'withdrawn'`,
    )
    .run(value.fixture.projectId, value.fixture.packageName);
  await assert.rejects(
    value.quarantine.findByEventDigest(event.eventDigest),
    PluginPackageQuarantineUnavailableError,
  );
});

test('rolls back withdrawal when the in-transaction Owner fence changes before commit', async (t) => {
  const value = await harness(t, 'sqlite-quarantine-owner-fence');
  await publishActivePackage(value);
  let checks = 0;
  await assert.rejects(
    value.quarantine.quarantine(quarantineEvent(value.fixture), () => {
      checks += 1;
      if (checks === 2) throw new Error('Owner fence changed');
    }),
    (error) =>
      error instanceof PluginPackageQuarantineUnavailableError &&
      error.cause?.message === 'Owner fence changed',
  );
  assert.equal(checks, 2);
  assert.equal(
    value.client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3PluginPackageQuarantineEvents"`,
      )
      .get().count,
    0,
  );
  assert.equal(
    value.client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3TaskDefinitionRevisions"
         WHERE project_id = ? AND enabled = 0`,
      )
      .get(value.fixture.projectId).count,
    0,
  );
});

test('fails closed when durable withdrawal task evidence is incomplete', async (t) => {
  const value = await harness(t, 'sqlite-quarantine-corrupt');
  await publishActivePackage(value);
  const event = quarantineEvent(value.fixture);
  await value.quarantine.quarantine(event, () => {});
  value.client.exec('PRAGMA foreign_keys = OFF');
  value.client
    .prepare(
      `DELETE FROM "QingLong3PluginPackageWithdrawalTasks"
       WHERE event_digest = ? AND task_id = ?`,
    )
    .run(event.eventDigest, `pkg:${value.fixture.packageName}:alpha`);
  await assert.rejects(
    value.quarantine.findByEventDigest(event.eventDigest),
    PluginPackageQuarantineUnavailableError,
  );
  await assert.rejects(
    auditLocalSqliteReadiness(value.client),
    LocalSqliteReadinessError,
  );
});

test('rejects dispatch of a Run pinned to the quarantined Package Task revision', async (t) => {
  const value = await harness(t, 'sqlite-quarantine-run-fence');
  await publishActivePackage(value);
  const task = value.client
    .prepare(
      `SELECT head.task_id AS "taskId", revision.revision,
              revision.content_digest AS "contentDigest"
       FROM "QingLong3TaskDefinitions" AS head
       JOIN "QingLong3TaskDefinitionRevisions" AS revision
         ON revision.project_id = head.project_id
        AND revision.task_id = head.task_id
        AND revision.revision = head.current_revision
       WHERE head.project_id = ?
       ORDER BY head.task_id LIMIT 1`,
    )
    .get(value.fixture.projectId);
  const run = {
    id: '019f9a00-0000-4000-a000-000000000001',
    projectId: value.fixture.projectId,
    taskId: task.taskId,
    taskRevision: createTaskDefinitionRevisionRef({
      revision: task.revision,
      contentDigest: task.contentDigest,
    }),
    taskName: 'quarantine fence',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'queued',
    version: 0,
    eventSequence: 0,
    priority: 0,
    createdAtMs: 1_000,
    queuedAtMs: 1_001,
  };
  await value.runs.transaction((transaction) => transaction.insertRun(run));
  await value.quarantine.quarantine(quarantineEvent(value.fixture), () => {});
  await assert.rejects(
    value.runs.transaction((transaction) =>
      transaction.compareAndSetRun(
        { ...run, status: 'dispatching', version: 1 },
        0,
      ),
    ),
    RunRepositoryConstraintError,
  );
  assert.equal((await value.runs.findRunById(run.id)).status, 'queued');
});

test('rejects a Package Run while lifecycle is disabled and admits it after enable', async (t) => {
  const value = await harness(t, 'sqlite-lifecycle-run-fence');
  await publishActivePackage(value);
  const task = value.client
    .prepare(
      `SELECT head.task_id AS "taskId", revision.revision,
              revision.content_digest AS "contentDigest"
       FROM "QingLong3TaskDefinitions" AS head
       JOIN "QingLong3TaskDefinitionRevisions" AS revision
         ON revision.project_id = head.project_id
        AND revision.task_id = head.task_id
        AND revision.revision = head.current_revision
       WHERE head.project_id = ?
       ORDER BY head.task_id LIMIT 1`,
    )
    .get(value.fixture.projectId);
  const run = {
    id: '019f9a00-0000-4000-a000-000000000002',
    projectId: value.fixture.projectId,
    taskId: task.taskId,
    taskRevision: createTaskDefinitionRevisionRef({
      revision: task.revision,
      contentDigest: task.contentDigest,
    }),
    taskName: 'lifecycle fence',
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    status: 'queued',
    version: 0,
    eventSequence: 0,
    priority: 0,
    createdAtMs: 1_000,
    queuedAtMs: 1_001,
  };
  await value.runs.transaction((transaction) => transaction.insertRun(run));
  value.client.exec('PRAGMA foreign_keys = OFF');
  value.client
    .prepare(
      `INSERT INTO "QingLong3PluginPackageLifecycleHeads" (
         project_id, package_name, installation_id, lock_digest,
         install_record_digest, version, disposition, event_digest,
         updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, 1, 'disabled', ?, 2)`,
    )
    .run(
      value.fixture.projectId,
      value.fixture.packageName,
      value.fixture.install.active.installationId,
      value.fixture.install.active.lockDigest,
      value.fixture.install.active.recordDigest,
      digest('f'),
    );
  value.client.exec('PRAGMA foreign_keys = ON');

  await assert.rejects(
    value.runs.transaction((transaction) =>
      transaction.compareAndSetRun(
        { ...run, status: 'dispatching', version: 1 },
        0,
      ),
    ),
    RunRepositoryConstraintError,
  );
  assert.equal((await value.runs.findRunById(run.id)).status, 'queued');

  value.client
    .prepare(
      `UPDATE "QingLong3PluginPackageLifecycleHeads"
       SET disposition = 'active', version = 2, updated_at_ms = 3
       WHERE project_id = ? AND package_name = ?`,
    )
    .run(value.fixture.projectId, value.fixture.packageName);
  assert.equal(
    await value.runs.transaction((transaction) =>
      transaction.compareAndSetRun(
        { ...run, status: 'dispatching', version: 1 },
        0,
      ),
    ),
    true,
  );
  assert.equal((await value.runs.findRunById(run.id)).status, 'dispatching');
});

test('publishes quarantine storage only through its explicit subpath', () => {
  const entrypoint = require('@qinglong/local-sqlite/plugin-package-quarantine');
  assert.equal(
    entrypoint.LocalSqlitePluginPackageQuarantineRepository,
    LocalSqlitePluginPackageQuarantineRepository,
  );
  assert.equal(
    require('../dist').LocalSqlitePluginPackageQuarantineRepository,
    undefined,
  );
});
