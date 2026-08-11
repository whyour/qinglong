const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  createPluginPackageWorkflowExecutionPlan,
  PluginPackageWorkflowAdmissionConflictError,
  PluginPackageWorkflowAdmissionNotAllowedError,
  PluginPackageWorkflowAdmissionUnavailableError,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  PluginPackageWorkflowAdministrationAuthorizationFenceConflictError,
} = require('@qinglong/runtime-core/plugin-package-workflow-administration');
const {
  transitionStepRunMutation,
} = require('@qinglong/runtime-core/step-run');
const {
  activateInstall,
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const { migrateLocalSqliteDatabase } = require('../dist/migration/migration');
const {
  LocalSqlitePluginPackageAutomationPublicationRepository,
} = require('../dist/plugin-package/pluginPackageAutomationPublicationRepository');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('../dist/plugin-package/pluginPackageInstallRepository');
const {
  LocalSqlitePluginPackageMaterializedRevisionRepository,
} = require('../dist/plugin-package/pluginPackageMaterializedRevisionRepository');
const {
  LocalSqlitePluginPackageWorkflowAdmissionRepository,
} = require('../dist/plugin-package/workflow/pluginPackageWorkflowAdmissionRepository');
const {
  LocalSqliteStepRunRepository,
} = require('../dist/run/stepRunRepository');
const { auditLocalSqliteReadiness } = require('../dist/readiness/readiness');

function fixture(namespace) {
  const value = pluginPackageTaskReconciliationFixture(namespace, {
    workflows: [
      {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'daily',
        name: 'Daily workflow',
        enabled: true,
        steps: [
          { id: 'collect', task: 'alpha', needs: [] },
          { id: 'summarize', task: 'beta', needs: ['collect'] },
        ],
      },
    ],
  });
  return {
    ...value,
    publication: createInitialPluginPackageAutomationPublication(
      value.revision,
      value.registry,
      2_000,
    ),
  };
}

function plan(value, overrides = {}) {
  return createPluginPackageWorkflowExecutionPlan({
    planId: `workflow-plan-${value.namespace}`,
    runId: `run-${value.namespace}`,
    workflowId: 'daily',
    stepRunIds: {
      collect: `step-collect-${value.namespace}`,
      summarize: `step-summarize-${value.namespace}`,
    },
    publication: value.publication,
    revision: value.revision,
    taskSpecSemanticRegistry: value.registry,
    plannedAtMs: 3_000,
    ...overrides,
  });
}

async function harness(t, namespace, { active = true } = {}) {
  const value = fixture(namespace);
  const client = new DatabaseSync(':memory:');
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  client
    .prepare(
      `INSERT INTO "QingLong3Projects"
       (id, name, slug, status, version, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'active', 1, 1, 1)`,
    )
    .run(value.projectId, value.projectId, value.projectId);
  if (active) {
    await activateInstall(
      new LocalSqlitePluginPackageInstallRepository(client),
      value,
    );
  }
  await new LocalSqlitePluginPackageMaterializedRevisionRepository(
    client,
    value.registry,
  ).publish(value.revision);
  await new LocalSqlitePluginPackageAutomationPublicationRepository(
    client,
  ).publish(value.publication);
  t.after(() => client.close());
  return {
    client,
    value,
    repository: new LocalSqlitePluginPackageWorkflowAdmissionRepository(client),
  };
}

test('atomically admits one generation-bound Workflow Run and exactly replays it', async (t) => {
  const { client, value, repository } = await harness(
    t,
    'sqlite-workflow-admit',
  );
  const executionPlan = plan(value);
  const created = await repository.admit(executionPlan);
  assert.equal(created.status, 'created');
  assert.equal(created.receipt.finalRunVersion, 3);
  assert.equal(created.receipt.finalRunEventSequence, 3);

  const replay = await repository.admit(
    JSON.parse(JSON.stringify(executionPlan)),
  );
  assert.deepEqual(replay, {
    status: 'existing',
    receipt: created.receipt,
  });
  assert.deepEqual(
    await repository.findByPlanId(executionPlan.planId),
    created.receipt,
  );
  assert.deepEqual(
    await repository.findByRunId(executionPlan.runId),
    created.receipt,
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT
           (SELECT COUNT(*) FROM "Runs") AS runs,
           (SELECT COUNT(*) FROM "StepRuns") AS steps,
           (SELECT COUNT(*) FROM "RunEvents") AS events,
           (SELECT COUNT(*) FROM "StepRunMutations") AS mutations,
           (SELECT COUNT(*)
            FROM "QingLong3PluginPackageWorkflowAdmissions") AS admissions`,
        )
        .get(),
    },
    { runs: 1, steps: 2, events: 3, mutations: 2, admissions: 1 },
  );
  assert.equal((await auditLocalSqliteReadiness(client)).contractVersion, 44);
});

test('runs an optional authorization guard inside new and replay transactions', async (t) => {
  const { value, repository } = await harness(t, 'tx-guard');
  const executionPlan = plan(value);
  const observations = [];
  const created = await repository.admit(executionPlan, (context) => {
    observations.push({
      replay: context.replay,
      planId: context.plan.planId,
      receiptDigest: context.receipt.receiptDigest,
    });
  });
  assert.deepEqual(
    await repository.findPlanByPlanId(executionPlan.planId),
    executionPlan,
  );
  await repository.admit(executionPlan, (context) => {
    observations.push({
      replay: context.replay,
      planId: context.plan.planId,
      receiptDigest: context.receipt.receiptDigest,
    });
  });
  assert.deepEqual(observations, [
    {
      replay: false,
      planId: executionPlan.planId,
      receiptDigest: created.receipt.receiptDigest,
    },
    {
      replay: true,
      planId: executionPlan.planId,
      receiptDigest: created.receipt.receiptDigest,
    },
  ]);
});

test('rolls back Workflow admission when the transaction authorization guard rejects', async (t) => {
  const { client, value, repository } = await harness(t, 'tx-reject');
  const executionPlan = plan(value);
  await assert.rejects(
    repository.admit(executionPlan, () => {
      throw new PluginPackageWorkflowAdministrationAuthorizationFenceConflictError();
    }),
    PluginPackageWorkflowAdministrationAuthorizationFenceConflictError,
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM "Runs") AS runs,
             (SELECT COUNT(*) FROM "StepRuns") AS steps,
             (SELECT COUNT(*) FROM "QingLong3PluginPackageWorkflowAdmissions") AS admissions`,
        )
        .get(),
    },
    { runs: 0, steps: 0, admissions: 0 },
  );
});

test('exactly replays immutable admission after the Workflow StepRun advances', async (t) => {
  const { client, value, repository } = await harness(
    t,
    'sqlite-workflow-progress-replay',
  );
  const executionPlan = plan(value);
  const created = await repository.admit(executionPlan);
  const stepRuns = new LocalSqliteStepRunRepository(client);
  const collect = await stepRuns.findByRunAndStepKey(
    executionPlan.runId,
    'collect',
  );
  assert.ok(collect);
  const running = transitionStepRunMutation(
    collect,
    {
      expectedVersion: collect.version,
      expectedDigest: collect.stepRunDigest,
      mutationId: 'workflow-progress-running',
      to: 'running',
      atMs: 4_000,
    },
    {
      expectedRunVersion: created.receipt.finalRunVersion,
      expectedRunEventSequence: created.receipt.finalRunEventSequence,
      eventId: 'workflow-progress-running-event',
      dedupeKey: 'workflow-progress-running-event',
      actor: { type: 'executor' },
    },
  );
  await stepRuns.apply(running);
  const succeeded = transitionStepRunMutation(
    running.stepRun,
    {
      expectedVersion: running.stepRun.version,
      expectedDigest: running.stepRun.stepRunDigest,
      mutationId: 'workflow-progress-succeeded',
      to: 'succeeded',
      atMs: 5_000,
    },
    {
      expectedRunVersion: created.receipt.finalRunVersion + 1,
      expectedRunEventSequence: created.receipt.finalRunEventSequence + 1,
      eventId: 'workflow-progress-succeeded-event',
      dedupeKey: 'workflow-progress-succeeded-event',
      actor: { type: 'executor' },
    },
  );
  await stepRuns.apply(succeeded);

  assert.deepEqual(await repository.admit(executionPlan), {
    status: 'existing',
    receipt: created.receipt,
  });
  assert.deepEqual(
    await repository.findByRunId(executionPlan.runId),
    created.receipt,
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT status, version, event_sequence AS "eventSequence"
           FROM "Runs" WHERE id = ?`,
        )
        .get(executionPlan.runId),
    },
    { status: 'running', version: 5, eventSequence: 5 },
  );
  assert.equal((await auditLocalSqliteReadiness(client)).contractVersion, 44);
});

test('fails closed before writing when the exact installation is not active', async (t) => {
  const { client, value, repository } = await harness(
    t,
    'sqlite-workflow-not-allowed',
    { active: false },
  );
  await assert.rejects(
    repository.admit(plan(value)),
    PluginPackageWorkflowAdmissionNotAllowedError,
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT
           (SELECT COUNT(*) FROM "Runs") AS runs,
           (SELECT COUNT(*)
            FROM "QingLong3PluginPackageWorkflowAdmissions") AS admissions`,
        )
        .get(),
    },
    { runs: 0, admissions: 0 },
  );
});

test('rolls back every Run artifact on identity collision or Task drift', async (t) => {
  const first = await harness(t, 'sqlite-workflow-collision');
  const firstPlan = plan(first.value);
  await first.repository.admit(firstPlan);
  const colliding = plan(first.value, {
    planId: `${firstPlan.planId}-other`,
  });
  await assert.rejects(
    first.repository.admit(colliding),
    PluginPackageWorkflowAdmissionConflictError,
  );
  assert.deepEqual(
    {
      ...first.client
        .prepare(
          `SELECT
           (SELECT COUNT(*) FROM "Runs") AS runs,
           (SELECT COUNT(*) FROM "StepRuns") AS steps,
           (SELECT COUNT(*) FROM "RunEvents") AS events,
           (SELECT COUNT(*)
            FROM "QingLong3PluginPackageWorkflowAdmissions") AS admissions`,
        )
        .get(),
    },
    { runs: 1, steps: 2, events: 3, admissions: 1 },
  );

  const drift = await harness(t, 'sqlite-workflow-task-drift');
  drift.client.exec('PRAGMA ignore_check_constraints = ON');
  drift.client
    .prepare(
      `UPDATE "QingLong3PluginPackageMaterializedRevisions"
       SET revision_json = json_set(
         revision_json, '$.resources[0].value.enabled', json('false')
       )
       WHERE generation_digest = ?`,
    )
    .run(drift.value.revision.generation.generationDigest);
  await assert.rejects(
    drift.repository.admit(plan(drift.value)),
    PluginPackageWorkflowAdmissionConflictError,
  );
  assert.equal(
    drift.client.prepare(`SELECT COUNT(*) AS count FROM "Runs"`).get().count,
    0,
  );
});

test('detects durable Workflow admission evidence changed in place', async (t) => {
  const { client, value, repository } = await harness(
    t,
    'sqlite-workflow-corrupt',
  );
  const executionPlan = plan(value);
  await repository.admit(executionPlan);
  client.exec('PRAGMA ignore_check_constraints = ON');
  client
    .prepare(
      `UPDATE "QingLong3PluginPackageWorkflowAdmissions"
       SET receipt_json = json_set(receipt_json, '$.workflowId', 'changed')
       WHERE plan_digest = ?`,
    )
    .run(executionPlan.planDigest);
  await assert.rejects(
    repository.findByPlanId(executionPlan.planId),
    PluginPackageWorkflowAdmissionUnavailableError,
  );
});

test('publishes Workflow admission only through an explicit local SQLite subpath', () => {
  const subpath = require('@qinglong/local-sqlite/plugin-package-workflow-admission');
  const root = require('../dist');
  assert.equal(
    subpath.LocalSqlitePluginPackageWorkflowAdmissionRepository,
    LocalSqlitePluginPackageWorkflowAdmissionRepository,
  );
  assert.equal(
    root.LocalSqlitePluginPackageWorkflowAdmissionRepository,
    undefined,
  );
});
