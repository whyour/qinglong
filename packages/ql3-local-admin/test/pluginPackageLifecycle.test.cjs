const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  createProjectToolDefinitionSnapshot,
  projectToolDefinitionSnapshotContribution,
} = require('@qinglong/runtime-core/project-tool-definition-snapshot');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  LocalSqliteOperationAuthority,
} = require('@qinglong/local-sqlite/operation-authority');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('@qinglong/local-sqlite/plugin-package-install');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('@qinglong/local-sqlite/plugin-package-materialized-revision');
const {
  LocalSqlitePluginPackageTaskReconciliationRepository,
} = require('@qinglong/local-sqlite/plugin-package-task-reconciliation');
const {
  LocalSqliteProjectToolDefinitionSnapshotRepository,
} = require('@qinglong/local-sqlite/project-tool-definition-snapshot');
const {
  migrateLocalSqliteDatabase,
} = require('@qinglong/local-sqlite/migration');
const {
  createLocalPluginPackageLifecycleService,
} = require('@qinglong/local-admin/package-lifecycle');

const OWNER = Object.freeze({ type: 'user', id: 'owner-lifecycle' });

function principal(at) {
  return {
    subject: OWNER,
    authenticationId: 'owner-lifecycle-console',
    authenticatedAtMs: at - 1,
    expiresAtMs: at + 60_000,
    assurance: 'local_console',
  };
}

async function harness(t) {
  const fixture = pluginPackageTaskReconciliationFixture('local-admin-life', {
    profile: 'edge',
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
  client
    .prepare(
      `INSERT INTO "QingLong3ProjectRoleBindings" (
         project_id, subject_type, subject_id, version, state, role,
         mutation_id, changed_by_type, changed_by_id, created_at_ms
       ) VALUES (?, 'user', ?, 1, 'active', 'owner', ?, 'user', ?, 1)`,
    )
    .run(fixture.projectId, OWNER.id, 'grant-local-admin-life', OWNER.id);
  const authority = new LocalSqliteOperationAuthority(client);
  t.after(() => authority.close());
  const installs = new LocalSqlitePluginPackageInstallRepository(authority);
  const materialized =
    new LocalSqlitePluginPackageMaterializedRevisionRepository(
      authority,
      fixture.registry,
    );
  const reconciliations =
    new LocalSqlitePluginPackageTaskReconciliationRepository(
      authority,
      fixture.registry,
    );
  const snapshots =
    new LocalSqliteProjectToolDefinitionSnapshotRepository(authority);
  await activateInstall(installs, fixture);
  await materialized.publish(fixture.revision);
  await reconciliations.reconcile(fixture.revision, {
    async findActiveResourceGeneration() {
      return fixture.revision.generation;
    },
  });
  await snapshots.publish(
    createProjectToolDefinitionSnapshot({
      projectId: fixture.projectId,
      contributions: [
        projectToolDefinitionSnapshotContribution(
          fixture.revision,
          fixture.registry,
        ),
      ],
    }),
  );
  let time = 50_000;
  const service = createLocalPluginPackageLifecycleService({
    authority,
    now: () => time++,
  });
  return { fixture, client, service, time: () => time };
}

function execution(impact, ordinal, principalValue, confirmAuthorization) {
  return {
    impact,
    approvalRequestId: `local-life-approval-${ordinal}`,
    decisionId: `local-life-decision-${ordinal}`,
    consumptionId: `local-life-consumption-${ordinal}`,
    dispatchId: `local-life-dispatch-${ordinal}`,
    approvalAuditEventId: `91000000-0000-4000-8000-${String(
      ordinal * 10 + 1,
    ).padStart(12, '0')}`,
    decisionAuditEventId: `91000000-0000-4000-8000-${String(
      ordinal * 10 + 2,
    ).padStart(12, '0')}`,
    consumptionAuditEventId: `91000000-0000-4000-8000-${String(
      ordinal * 10 + 3,
    ).padStart(12, '0')}`,
    reasonCode: 'reviewed',
    principal: principalValue,
    confirmAuthorization,
  };
}

test('plans and executes replay-safe local lifecycle without another package or authority', async (t) => {
  const value = await harness(t);
  const owner = principal(value.time());
  const disable = await value.service.plan(
    'disable',
    value.fixture.projectId,
    value.fixture.packageName,
    owner,
  );
  assert.equal(disable.expected.disposition, 'active');
  assert.ok(disable.resourceCounts.tasks > 0);

  let confirmations = 0;
  const disableCommand = execution(disable, 1, owner, () => {
    confirmations += 1;
  });
  const disabled = await value.service.execute(disableCommand);
  assert.equal(disabled.status, 'created');
  assert.equal(disabled.approval.state, 'consumed');
  assert.equal(disabled.receipt.lifecycle.disposition, 'disabled');
  assert.equal(disabled.receipt.capability.status, 'withdrawn');
  assert.equal(
    disabled.receipt.capability.taskTransitions.length,
    disable.taskIds.length,
  );
  assert.ok(confirmations >= 3);

  const replayed = await value.service.execute(disableCommand);
  assert.equal(replayed.status, 'existing');
  assert.equal(replayed.receipt.receiptDigest, disabled.receipt.receiptDigest);
  assert.equal(
    value.client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3PluginPackageLifecycleEvents"`,
      )
      .get().count,
    1,
  );

  const enable = await value.service.plan(
    'enable',
    value.fixture.projectId,
    value.fixture.packageName,
    owner,
  );
  const enabled = await value.service.execute(
    execution(enable, 2, owner, () => undefined),
  );
  assert.equal(enabled.receipt.lifecycle.disposition, 'active');
  assert.equal(enabled.receipt.capability.status, 'restored');
  assert.equal(
    enabled.receipt.capability.taskTransitions.length,
    disable.taskIds.length,
  );
});

test('rejects lifecycle plan before storage mutation for an unbound local User', async (t) => {
  const value = await harness(t);
  const outsider = {
    ...principal(value.time()),
    subject: { type: 'user', id: 'outsider' },
  };
  await assert.rejects(
    value.service.plan(
      'disable',
      value.fixture.projectId,
      value.fixture.packageName,
      outsider,
    ),
    /not authorized by current Project policy/,
  );
  assert.equal(
    value.client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3PluginPackageLifecycleEvents"`,
      )
      .get().count,
    0,
  );
});
