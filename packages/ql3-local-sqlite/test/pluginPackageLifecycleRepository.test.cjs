const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  createApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createInitialPluginPackageAutomationPublication,
  pluginPackageAutomationDefinitionsFromRevision,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  InvalidPluginPackageLifecycleError,
  PluginPackageLifecycleConflictError,
  PluginPackageLifecycleUnavailableError,
  createPluginPackageLifecycleEvent,
} = require('@qinglong/runtime-core/plugin-package-lifecycle');
const {
  createProjectToolDefinitionSnapshot,
  projectToolDefinitionSnapshotContribution,
} = require('@qinglong/runtime-core/project-tool-definition-snapshot');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  LocalSqliteApprovalRequestRepository,
} = require('../dist/approved-action/approvalRequestRepository');
const { LocalSqliteOperationAuthority } = require('../dist/authority/operationAuthority');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('../dist/plugin-package/pluginPackageInstallRepository');
const {
  LocalSqlitePluginPackageAutomationPublicationRepository,
} = require('../dist/plugin-package/pluginPackageAutomationPublicationRepository');
const {
  EDGE_PLUGIN_PACKAGE_LIFECYCLE_ACTIVE_SOURCE_LIMIT,
  LocalSqlitePluginPackageLifecycleRepository,
} = require('../dist/plugin-package/pluginPackageLifecycleRepository');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('../dist/plugin-package/pluginPackageMaterializedRevisionRepository');
const {
  LocalSqlitePluginPackageTaskReconciliationRepository,
} = require('../dist/plugin-package/pluginPackageTaskReconciliationRepository');
const {
  LocalSqliteProjectToolDefinitionSnapshotRepository,
} = require('../dist/tool-execution/projectToolDefinitionSnapshotRepository');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');
const {
  LocalSqliteReadinessError,
  auditLocalSqliteReadiness,
} = require('../dist/readiness/readiness');

const OWNER = Object.freeze({ type: 'user', id: 'owner-001' });
const OTHER_OWNER = Object.freeze({ type: 'user', id: 'owner-002' });
const SYSTEM = Object.freeze({ type: 'system', id: 'lifecycle-dispatcher' });
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });

function audit(
  eventId,
  requestId,
  operationId,
  subject,
  authenticationId,
  outcome,
  projectId,
  occurredAtMs,
) {
  return {
    eventId,
    requestId,
    operationId,
    projectId,
    subject,
    authenticationId,
    outcome,
    reasons: [outcome === 'approval_required' ? 'package_review' : 'role_grant'],
    fence: FENCE,
    occurredAtMs,
  };
}

function auditId(sequence, offset) {
  return `90000000-0000-4000-8000-${String(sequence * 10 + offset).padStart(
    12,
    '0',
  )}`;
}

async function harness(t, namespace, fixtureOptions = {}) {
  const fixture = pluginPackageTaskReconciliationFixture(namespace, {
    profile: 'edge',
    ...fixtureOptions,
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
    .run(
      fixture.projectId,
      OWNER.id,
      `grant-${namespace}`,
      OWNER.id,
    );
  const authority = new LocalSqliteOperationAuthority(client);
  t.after(() => authority.close());
  return {
    fixture,
    client,
    authority,
    approval: new LocalSqliteApprovalRequestRepository(authority),
    automations:
      new LocalSqlitePluginPackageAutomationPublicationRepository(authority),
    install: new LocalSqlitePluginPackageInstallRepository(authority),
    materialized: new LocalSqlitePluginPackageMaterializedRevisionRepository(
      authority,
      fixture.registry,
    ),
    reconciliation: new LocalSqlitePluginPackageTaskReconciliationRepository(
      authority,
      fixture.registry,
    ),
    snapshots: new LocalSqliteProjectToolDefinitionSnapshotRepository(
      authority,
    ),
    lifecycle: new LocalSqlitePluginPackageLifecycleRepository(authority, {
      registry: fixture.registry,
      activeSourceLimit:
        EDGE_PLUGIN_PACKAGE_LIFECYCLE_ACTIVE_SOURCE_LIMIT,
    }),
    approvalSequence: 0,
  };
}

async function publishActivePackage(value) {
  await activateInstall(value.install, value.fixture);
  await value.materialized.publish(value.fixture.revision);
  if (
    pluginPackageAutomationDefinitionsFromRevision(
      value.fixture.revision,
      value.fixture.registry,
    )
  ) {
    await value.automations.publish(
      createInitialPluginPackageAutomationPublication(
        value.fixture.revision,
        value.fixture.registry,
        1_000,
      ),
    );
  }
  await value.reconciliation.reconcile(value.fixture.revision, {
    async findActiveResourceGeneration() {
      return value.fixture.revision.generation;
    },
  });
  await value.snapshots.publish(
    createProjectToolDefinitionSnapshot({
      projectId: value.fixture.projectId,
      contributions: [
        projectToolDefinitionSnapshotContribution(
          value.fixture.revision,
          value.fixture.registry,
        ),
      ],
    }),
  );
}

async function approveLifecycleEvent(
  value,
  impact,
  subjects = Object.freeze({
    requestedBy: OWNER,
    approvedBy: OWNER,
  }),
) {
  value.approvalSequence += 1;
  const sequence = value.approvalSequence;
  const requestId = `lifecycle-approval-${sequence}`;
  const dispatchId = `lifecycle-dispatch-${sequence}`;
  const requestedAtMs = 10_000 * sequence + 1;
  const decidedAtMs = requestedAtMs + 1;
  const consumedAtMs = requestedAtMs + 2;
  const occurredAtMs = requestedAtMs + 3;
  const expiresAtMs = requestedAtMs + 1_000;
  const action = {
    permission: 'package.manage',
    actionType: `plugin_package.lifecycle.${impact.action}`,
    actionRef: `lifecycle:${impact.impactDigest}`,
    actionDigest: require('@qinglong/runtime-core/plugin-package-lifecycle')
      .pluginPackageLifecycleActionDigest(impact),
    previewDigest: impact.impactDigest,
  };
  await value.approval.create({
    request: createApprovalRequest({
      id: requestId,
      projectId: value.fixture.projectId,
      action,
      risk: 'high',
      decisionMode: 'human_confirmation',
      requestedBy: subjects.requestedBy,
      requestedAtMs,
      expiresAtMs,
      requestFence: FENCE,
    }),
    audit: audit(
      auditId(sequence, 1),
      `lifecycle-http-${sequence}`,
      'approval.request',
      subjects.requestedBy,
      `auth-request-${sequence}`,
      'approval_required',
      value.fixture.projectId,
      requestedAtMs,
    ),
  });
  await value.approval.decide({
    requestId,
    expectedVersion: 1,
    decisionId: `lifecycle-decision-${sequence}`,
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: subjects.approvedBy,
      authenticationId: `auth-approve-${sequence}`,
      authenticatedAtMs: decidedAtMs - 1,
      expiresAtMs,
      assurance: 'local_console',
    },
    decidedAtMs,
    authorizationFence: FENCE,
    audit: audit(
      auditId(sequence, 2),
      `lifecycle-http-${sequence}`,
      'approval.decide',
      subjects.approvedBy,
      `auth-approve-${sequence}`,
      'allowed',
      value.fixture.projectId,
      decidedAtMs,
    ),
  });
  const consumed = await value.approval.consume({
    requestId,
    expectedVersion: 2,
    consumptionId: `lifecycle-consume-${sequence}`,
    dispatchId,
    action,
    requestedBy: subjects.requestedBy,
    consumedBy: SYSTEM,
    consumedAtMs,
    authorizationFence: FENCE,
    audit: audit(
      auditId(sequence, 3),
      `lifecycle-dispatch-cycle-${sequence}`,
      'approval.consume',
      SYSTEM,
      `auth-dispatch-${sequence}`,
      'allowed',
      value.fixture.projectId,
      consumedAtMs,
    ),
  });
  return createPluginPackageLifecycleEvent({
    dispatchId: consumed.dispatch.id,
    impact,
    requestedBy: subjects.requestedBy,
    approvedBy: subjects.approvedBy,
    authorizationMode: 'human_confirmation',
    occurredAtMs,
  });
}

function taskHeads(value) {
  return value.client
    .prepare(
      `SELECT head.task_id AS "taskId",
              revision.revision,
              revision.enabled
       FROM "QingLong3TaskDefinitions" AS head
       JOIN "QingLong3TaskDefinitionRevisions" AS revision
         ON revision.project_id = head.project_id
        AND revision.task_id = head.task_id
        AND revision.revision = head.current_revision
       WHERE head.project_id = ?
       ORDER BY head.task_id`,
    )
    .all(value.fixture.projectId)
    .map((row) => ({ ...row }));
}

test('atomically disables, exactly replays and restores only lifecycle Tasks', async (t) => {
  const value = await harness(t, 'sqlite-lifecycle-roundtrip');
  await publishActivePackage(value);
  const before = await value.snapshots.findCurrent(value.fixture.projectId);
  assert.equal(before.snapshot.sources.length, 1);

  const disableImpact = await value.lifecycle.plan(
    'disable',
    value.fixture.projectId,
    value.fixture.packageName,
  );
  assert.equal(disableImpact.expected.disposition, 'active');
  assert.deepEqual(disableImpact.taskIds, [
    `pkg:${value.fixture.packageName}:alpha`,
    `pkg:${value.fixture.packageName}:beta`,
  ]);
  const disableEvent = await approveLifecycleEvent(value, disableImpact);
  let authorizationChecks = 0;
  const disabled = await value.lifecycle.transition(disableEvent, () => {
    authorizationChecks += 1;
  });
  assert.equal(disabled.status, 'created');
  assert.equal(authorizationChecks, 2);
  assert.equal(disabled.receipt.lifecycle.disposition, 'disabled');
  assert.equal(disabled.receipt.capability.status, 'withdrawn');
  assert.equal(disabled.receipt.capability.retainedSourceCount, 0);
  assert.deepEqual(taskHeads(value), [
    {
      taskId: `pkg:${value.fixture.packageName}:alpha`,
      revision: 2,
      enabled: 0,
    },
    {
      taskId: `pkg:${value.fixture.packageName}:beta`,
      revision: 2,
      enabled: 0,
    },
  ]);
  assert.equal(
    (await value.snapshots.findCurrent(value.fixture.projectId)).snapshot.sources
      .length,
    0,
  );

  const replay = await value.lifecycle.transition(disableEvent, () => {
    authorizationChecks += 1;
  });
  assert.equal(replay.status, 'existing');
  assert.equal(authorizationChecks, 4);
  assert.deepEqual(replay.receipt, disabled.receipt);

  const enableImpact = await value.lifecycle.plan(
    'enable',
    value.fixture.projectId,
    value.fixture.packageName,
  );
  assert.deepEqual(enableImpact.taskIds, disableImpact.taskIds);
  const enableEvent = await approveLifecycleEvent(value, enableImpact);
  const enabled = await value.lifecycle.transition(enableEvent, () => {});
  assert.equal(enabled.receipt.lifecycle.disposition, 'active');
  assert.equal(enabled.receipt.capability.status, 'restored');
  assert.equal(enabled.receipt.capability.retainedSourceCount, 1);
  assert.deepEqual(taskHeads(value), [
    {
      taskId: `pkg:${value.fixture.packageName}:alpha`,
      revision: 3,
      enabled: 1,
    },
    {
      taskId: `pkg:${value.fixture.packageName}:beta`,
      revision: 3,
      enabled: 1,
    },
  ]);
  assert.equal(
    (await value.snapshots.findCurrent(value.fixture.projectId)).snapshot.sources
      .length,
    1,
  );
  assert.deepEqual(
    await value.lifecycle.findByEventDigest(enableEvent.eventDigest),
    enabled.receipt,
  );
  await auditLocalSqliteReadiness(value.client);
});

test('atomically withdraws and restores Workflow and Prompt publications', async (t) => {
  const value = await harness(t, 'sqlite-lifecycle-automation', {
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
        id: 'greeting',
        name: 'Greeting prompt',
        template: 'Hello {{name}}',
        parameters: [{ name: 'name', required: true }],
      },
    ],
  });
  await publishActivePackage(value);
  const initial = await value.automations.findCurrent(
    value.fixture.projectId,
    value.fixture.packageName,
  );
  assert.equal(initial.state, 'active');
  assert.equal(initial.version, 1);

  const disableImpact = await value.lifecycle.plan(
    'disable',
    value.fixture.projectId,
    value.fixture.packageName,
  );
  const disableEvent = await approveLifecycleEvent(value, disableImpact);
  let checks = 0;
  await assert.rejects(
    value.lifecycle.transition(disableEvent, () => {
      checks += 1;
      if (checks === 2) throw new Error('authorization expired');
    }),
    (error) =>
      error instanceof PluginPackageLifecycleUnavailableError &&
      error.cause?.message === 'authorization expired',
  );
  assert.deepEqual(
    await value.automations.findCurrent(
      value.fixture.projectId,
      value.fixture.packageName,
    ),
    initial,
  );
  assert.deepEqual(
    taskHeads(value).map(({ revision, enabled }) => ({ revision, enabled })),
    [
      { revision: 1, enabled: 1 },
      { revision: 1, enabled: 1 },
    ],
  );

  const disabled = await value.lifecycle.transition(disableEvent, () => {});
  const withdrawn = await value.automations.findCurrent(
    value.fixture.projectId,
    value.fixture.packageName,
  );
  assert.equal(disabled.status, 'created');
  assert.equal(withdrawn.state, 'withdrawn');
  assert.equal(withdrawn.version, 2);
  assert.equal(withdrawn.lifecycleEventDigest, disableEvent.eventDigest);
  assert.equal(withdrawn.previousPublicationDigest, initial.publicationDigest);
  assert.deepEqual(withdrawn.definitions, initial.definitions);

  const enableImpact = await value.lifecycle.plan(
    'enable',
    value.fixture.projectId,
    value.fixture.packageName,
  );
  const enableEvent = await approveLifecycleEvent(value, enableImpact);
  await value.lifecycle.transition(enableEvent, () => {});
  const restored = await value.automations.findCurrent(
    value.fixture.projectId,
    value.fixture.packageName,
  );
  assert.equal(restored.state, 'active');
  assert.equal(restored.version, 3);
  assert.equal(restored.lifecycleEventDigest, enableEvent.eventDigest);
  assert.equal(
    restored.previousPublicationDigest,
    withdrawn.publicationDigest,
  );
  assert.deepEqual(restored.definitions, initial.definitions);
  await auditLocalSqliteReadiness(value.client);
});

test('diagnoses live Run blockers and retires history only after they clear', async (t) => {
  const value = await harness(t, 'sqlite-lifecycle-uninstall');
  await publishActivePackage(value);
  const disableImpact = await value.lifecycle.plan(
    'disable',
    value.fixture.projectId,
    value.fixture.packageName,
  );
  await value.lifecycle.transition(
    await approveLifecycleEvent(value, disableImpact),
    () => {},
  );
  const task = taskHeads(value)[0];
  value.client
    .prepare(
      `INSERT INTO "Runs" (
         id, project_id, task_id, task_revision, trigger_type,
         execution_origin, execution_owner, status, version,
         event_sequence, priority, created_at_ms
       ) VALUES (?, ?, ?, ?, 'manual', 'manual', 'runtime', 'queued',
                 0, 0, 0, 1)`,
    )
    .run(
      '019f9b00-0000-4000-a000-000000000001',
      value.fixture.projectId,
      task.taskId,
      String(task.revision),
    );
  const blocked = await value.lifecycle.plan(
    'uninstall',
    value.fixture.projectId,
    value.fixture.packageName,
  );
  assert.deepEqual(
    blocked.blockingReferences.map(({ kind, ownerId }) => ({ kind, ownerId })),
    [
      {
        kind: 'execution_recovery',
        ownerId: '019f9b00-0000-4000-a000-000000000001',
      },
    ],
  );
  assert.throws(
    () =>
      createPluginPackageLifecycleEvent({
        dispatchId: 'blocked-dispatch',
        impact: blocked,
        requestedBy: OWNER,
        approvedBy: OWNER,
        authorizationMode: 'human_confirmation',
        occurredAtMs: 1,
      }),
    InvalidPluginPackageLifecycleError,
  );

  value.client
    .prepare(`UPDATE "Runs" SET status = 'succeeded' WHERE id = ?`)
    .run('019f9b00-0000-4000-a000-000000000001');
  const impact = await value.lifecycle.plan(
    'uninstall',
    value.fixture.projectId,
    value.fixture.packageName,
  );
  assert.deepEqual(impact.blockingReferences, []);
  const retired = await value.lifecycle.transition(
    await approveLifecycleEvent(value, impact),
    () => {},
  );
  assert.equal(retired.receipt.lifecycle.disposition, 'uninstalled');
  assert.equal(retired.receipt.capability.status, 'retired');
  assert.deepEqual(retired.receipt.capability.taskTransitions, []);
  assert.equal(
    value.client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM "QingLong3PluginPackageLifecycleEvents"
         WHERE project_id = ? AND package_name = ?`,
      )
      .get(value.fixture.projectId, value.fixture.packageName).count,
    2,
  );
  await auditLocalSqliteReadiness(value.client);
});

test('rejects stale approved impact without leaving Task or lifecycle facts', async (t) => {
  const value = await harness(t, 'sqlite-lifecycle-stale');
  await publishActivePackage(value);
  const impact = await value.lifecycle.plan(
    'disable',
    value.fixture.projectId,
    value.fixture.packageName,
  );
  const event = await approveLifecycleEvent(value, impact);
  const task = taskHeads(value)[0];
  value.client
    .prepare(
      `INSERT INTO "Runs" (
         id, project_id, task_id, task_revision, trigger_type,
         execution_origin, execution_owner, status, version,
         event_sequence, priority, created_at_ms
       ) VALUES (?, ?, ?, ?, 'manual', 'manual', 'runtime', 'queued',
                 0, 0, 0, 1)`,
    )
    .run(
      '019f9b00-0000-4000-a000-000000000002',
      value.fixture.projectId,
      task.taskId,
      String(task.revision),
    );
  await assert.rejects(
    value.lifecycle.transition(event, () => {}),
    PluginPackageLifecycleConflictError,
  );
  assert.deepEqual(taskHeads(value).map(({ revision, enabled }) => ({
    revision,
    enabled,
  })), [
    { revision: 1, enabled: 1 },
    { revision: 1, enabled: 1 },
  ]);
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

test('fails closed on dispatch subject drift and incomplete Task evidence', async (t) => {
  const value = await harness(t, 'sqlite-lifecycle-corrupt');
  await publishActivePackage(value);
  const impact = await value.lifecycle.plan(
    'disable',
    value.fixture.projectId,
    value.fixture.packageName,
  );
  const approved = await approveLifecycleEvent(value, impact);
  const drifted = createPluginPackageLifecycleEvent({
    dispatchId: approved.dispatchId,
    impact,
    requestedBy: OTHER_OWNER,
    approvedBy: OTHER_OWNER,
    authorizationMode: 'human_confirmation',
    occurredAtMs: approved.occurredAtMs,
  });
  await assert.rejects(
    value.lifecycle.transition(drifted, () => {}),
    PluginPackageLifecycleConflictError,
  );

  const created = await value.lifecycle.transition(approved, () => {});
  value.client.exec('PRAGMA foreign_keys = OFF');
  value.client
    .prepare(
      `DELETE FROM "QingLong3PluginPackageLifecycleTasks"
       WHERE event_digest = ? AND task_id = ?`,
    )
    .run(
      approved.eventDigest,
      `pkg:${value.fixture.packageName}:alpha`,
    );
  await assert.rejects(
    value.lifecycle.findByEventDigest(approved.eventDigest),
    PluginPackageLifecycleUnavailableError,
  );
  await assert.rejects(
    auditLocalSqliteReadiness(value.client),
    LocalSqliteReadinessError,
  );
  assert.equal(created.receipt.capability.taskTransitions.length, 2);
});

test('publishes lifecycle storage only through its explicit subpath', () => {
  const entrypoint = require('@qinglong/local-sqlite/plugin-package-lifecycle');
  assert.equal(
    entrypoint.LocalSqlitePluginPackageLifecycleRepository,
    LocalSqlitePluginPackageLifecycleRepository,
  );
  assert.equal(
    require('../dist').LocalSqlitePluginPackageLifecycleRepository,
    undefined,
  );
});
