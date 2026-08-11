const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  createPluginPackageWorkflowExecutionPlan,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  InvalidPluginPackageWorkflowFrontierError,
  PluginPackageWorkflowFrontierUnavailableError,
} = require('@qinglong/runtime-core/plugin-package-workflow-frontier');
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
  LocalSqlitePluginPackageWorkflowFrontierRepository,
} = require('../dist/plugin-package/workflow/pluginPackageWorkflowFrontierRepository');
const {
  LocalSqliteStepRunRepository,
} = require('../dist/run/stepRunRepository');

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
  const publication = createInitialPluginPackageAutomationPublication(
    value.revision,
    value.registry,
    2_000,
  );
  const plan = createPluginPackageWorkflowExecutionPlan({
    planId: `wf-plan-${namespace}`,
    runId: `wf-run-${namespace}`,
    workflowId: 'daily',
    stepRunIds: {
      collect: `wf-collect-${namespace}`,
      summarize: `wf-summary-${namespace}`,
    },
    publication,
    revision: value.revision,
    taskSpecSemanticRegistry: value.registry,
    plannedAtMs: 3_000,
  });
  return { ...value, publication, plan };
}

async function harness(t, namespace) {
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
  await activateInstall(
    new LocalSqlitePluginPackageInstallRepository(client),
    value,
  );
  await new LocalSqlitePluginPackageMaterializedRevisionRepository(
    client,
    value.registry,
  ).publish(value.revision);
  await new LocalSqlitePluginPackageAutomationPublicationRepository(
    client,
  ).publish(value.publication);
  const admission =
    new LocalSqlitePluginPackageWorkflowAdmissionRepository(client);
  const admitted = await admission.admit(value.plan);
  t.after(() => client.close());
  return {
    client,
    value,
    admission,
    admitted,
    frontier:
      new LocalSqlitePluginPackageWorkflowFrontierRepository(client),
    stepRuns: new LocalSqliteStepRunRepository(client),
  };
}

async function transitionStep(
  harnessValue,
  stepKey,
  to,
  runVersion,
  atMs,
) {
  const current = await harnessValue.stepRuns.findByRunAndStepKey(
    harnessValue.value.plan.runId,
    stepKey,
  );
  assert.ok(current);
  const mutation = transitionStepRunMutation(
    current,
    {
      expectedVersion: current.version,
      expectedDigest: current.stepRunDigest,
      mutationId: `${stepKey}-${to}-${current.version}`,
      to,
      atMs,
      ...(to === 'failed' ? { resultCode: 'task_failed' } : {}),
    },
    {
      expectedRunVersion: runVersion,
      expectedRunEventSequence: runVersion,
      eventId: `${stepKey}-${to}-event-${current.version}`,
      dedupeKey: `${stepKey}-${to}-event-${current.version}`,
      actor: { type: 'executor' },
    },
  );
  return harnessValue.stepRuns.apply(mutation);
}

test('advances only an actionable dependency and terminalizes exactly once', async (t) => {
  const value = await harness(t, 'frontier-ok');
  assert.deepEqual(await value.frontier.listCandidates({ limit: 8 }), {
    candidates: [],
    truncated: false,
  });

  await transitionStep(value, 'collect', 'running', 3, 4_000);
  await transitionStep(value, 'collect', 'succeeded', 4, 5_000);
  const actionable = await value.frontier.listCandidates({ limit: 8 });
  assert.deepEqual(actionable, {
    candidates: [
      {
        runId: value.value.plan.runId,
        planDigest: value.value.plan.planDigest,
        admittedAtMs: 3_000,
      },
    ],
    truncated: false,
  });
  const advanced = await value.frontier.advance(value.value.plan.runId);
  assert.equal(advanced.status, 'advanced');
  assert.equal(advanced.stepMutationCount, 1);
  assert.deepEqual(advanced.readyStepRunIds, [
    value.value.plan.steps.find(({ stepKey }) => stepKey === 'summarize')
      .stepRunId,
  ]);
  assert.equal(advanced.runVersion, 6);
  assert.deepEqual(await value.frontier.listCandidates({ limit: 8 }), {
    candidates: [],
    truncated: false,
  });

  await transitionStep(
    value,
    'summarize',
    'running',
    6,
    advanced.observedAtMs + 1,
  );
  await transitionStep(
    value,
    'summarize',
    'succeeded',
    7,
    advanced.observedAtMs + 2,
  );
  assert.equal(
    (await value.frontier.listCandidates({ limit: 8 })).candidates.length,
    1,
  );
  const terminal = await value.frontier.advance(value.value.plan.runId);
  assert.equal(terminal.status, 'terminal');
  assert.equal(terminal.terminalStatus, 'succeeded');
  assert.equal(terminal.runVersion, 9);
  assert.deepEqual(
    {
      ...value.client
        .prepare(
          `SELECT status, version, event_sequence AS "eventSequence",
                  finished_at_ms IS NOT NULL AS finished,
                  error_code AS "errorCode"
           FROM "Runs" WHERE id = ?`,
        )
        .get(value.value.plan.runId),
    },
    {
      status: 'succeeded',
      version: 9,
      eventSequence: 9,
      finished: 1,
      errorCode: null,
    },
  );
  const replay = await value.frontier.advance(value.value.plan.runId);
  assert.equal(replay.status, 'settled');
  assert.equal(replay.terminalStatus, 'succeeded');
  assert.deepEqual(await value.admission.admit(value.value.plan), {
    status: 'existing',
    receipt: value.admitted.receipt,
  });
});

test('skips downstream work and fails the aggregate atomically', async (t) => {
  const value = await harness(t, 'frontier-fail');
  await transitionStep(value, 'collect', 'running', 3, 4_000);
  await transitionStep(value, 'collect', 'failed', 4, 5_000);
  const result = await value.frontier.advance(value.value.plan.runId);
  assert.equal(result.status, 'terminal');
  assert.equal(result.stepMutationCount, 1);
  assert.equal(result.terminalStatus, 'failed');
  assert.equal(result.runVersion, 7);
  assert.deepEqual(
    {
      ...value.client
        .prepare(
          `SELECT run.status, run.version,
                  run.event_sequence AS "eventSequence",
                  run.error_code AS "errorCode",
                  step.status AS "stepStatus",
                  step.result_code AS "resultCode",
                  (SELECT COUNT(*) FROM "RunEvents"
                    WHERE run_id = run.id) AS events
           FROM "Runs" AS run
           JOIN "StepRuns" AS step
             ON step.run_id = run.id AND step.step_key = 'summarize'
           WHERE run.id = ?`,
        )
        .get(value.value.plan.runId),
    },
    {
      status: 'failed',
      version: 7,
      eventSequence: 7,
      errorCode: 'workflow_step_failed',
      stepStatus: 'skipped',
      resultCode: 'dependency_not_succeeded',
      events: 7,
    },
  );
});

test('bounds paging before SQL and fails closed on current StepRun drift', async (t) => {
  const value = await harness(t, 'frontier-drift');
  assert.throws(
    () => value.frontier.listCandidates({ limit: 65 }),
    InvalidPluginPackageWorkflowFrontierError,
  );
  await transitionStep(value, 'collect', 'running', 3, 4_000);
  await transitionStep(value, 'collect', 'succeeded', 4, 5_000);
  value.client.exec('PRAGMA ignore_check_constraints = ON');
  value.client
    .prepare(
      `UPDATE "StepRuns"
       SET step_run_json = json_set(step_run_json, '$.definitionRef', 'drift')
       WHERE run_id = ? AND step_key = 'summarize'`,
    )
    .run(value.value.plan.runId);
  await assert.rejects(
    value.frontier.advance(value.value.plan.runId),
    PluginPackageWorkflowFrontierUnavailableError,
  );
  assert.deepEqual(
    {
      ...value.client
        .prepare(
          `SELECT status, version, event_sequence AS "eventSequence"
           FROM "Runs" WHERE id = ?`,
        )
        .get(value.value.plan.runId),
    },
    { status: 'running', version: 5, eventSequence: 5 },
  );
});

test('publishes Workflow frontier only through its explicit SQLite subpath', () => {
  const subpath = require('@qinglong/local-sqlite/plugin-package-workflow-frontier');
  const root = require('../dist');
  assert.equal(
    subpath.LocalSqlitePluginPackageWorkflowFrontierRepository,
    LocalSqlitePluginPackageWorkflowFrontierRepository,
  );
  assert.equal(
    root.LocalSqlitePluginPackageWorkflowFrontierRepository,
    undefined,
  );
});
