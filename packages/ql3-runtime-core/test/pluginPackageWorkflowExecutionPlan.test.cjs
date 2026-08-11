const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createInitialPluginPackageAutomationPublication,
  createPluginPackageAutomationLifecyclePublication,
} = require('../dist/plugin-package/pluginPackageAutomationPublication');
const {
  createPluginPackageWorkflowAdmissionBundle,
  createPluginPackageWorkflowExecutionPlan,
  InvalidPluginPackageWorkflowAdmissionReceiptError,
  InvalidPluginPackageWorkflowExecutionPlanError,
  normalizePluginPackageWorkflowAdmissionReceipt,
  normalizePluginPackageWorkflowExecutionPlan,
  PluginPackageWorkflowExecutionPlanConflictError,
  pluginPackageWorkflowAdmissionReceiptDigest,
  pluginPackageWorkflowExecutionPlanDigest,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');

function fixture(namespace = 'workflow-execution-plan') {
  const value = pluginPackageTaskReconciliationFixture(namespace, {
    workflows: [
      {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'daily',
        name: 'Daily workflow',
        enabled: true,
        steps: [
          {
            id: 'collect',
            task: 'alpha',
            needs: [],
          },
          {
            id: 'summarize',
            task: 'beta',
            needs: ['collect'],
          },
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

function planInput(value, overrides = {}) {
  return {
    planId: 'workflow-plan-001',
    runId: 'workflow-run-001',
    workflowId: 'daily',
    stepRunIds: {
      collect: 'step-run-collect-001',
      summarize: 'step-run-summarize-001',
    },
    publication: value.publication,
    revision: value.revision,
    taskSpecSemanticRegistry: value.registry,
    plannedAtMs: 3_000,
    ...overrides,
  };
}

test('binds one active publication and exact materialized Tasks into a canonical DAG plan', () => {
  const value = fixture();
  const plan = createPluginPackageWorkflowExecutionPlan(planInput(value));

  assert.equal(
    plan.target.publicationDigest,
    value.publication.publicationDigest,
  );
  assert.equal(
    plan.target.materializedRevisionDigest,
    value.revision.revisionDigest,
  );
  assert.equal(plan.target.workflowId, 'daily');
  assert.match(plan.target.workflowDefinitionDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    plan.steps.map(
      ({ stepKey, taskId, needs, initialStatus, taskDefinitionRef }) => ({
        stepKey,
        taskId,
        needs,
        initialStatus,
        taskDefinitionRef,
      }),
    ),
    [
      {
        stepKey: 'collect',
        taskId: 'alpha',
        needs: [],
        initialStatus: 'ready',
        taskDefinitionRef: `plugin-package:${value.revision.revisionDigest}:task:alpha`,
      },
      {
        stepKey: 'summarize',
        taskId: 'beta',
        needs: ['collect'],
        initialStatus: 'pending',
        taskDefinitionRef: `plugin-package:${value.revision.revisionDigest}:task:beta`,
      },
    ],
  );
  assert.equal(
    plan.steps.every(({ required }) => required),
    true,
  );
  assert.equal(plan.planDigest, pluginPackageWorkflowExecutionPlanDigest(plan));
  assert.deepEqual(normalizePluginPackageWorkflowExecutionPlan(plan), plan);
  assert.deepEqual(
    normalizePluginPackageWorkflowExecutionPlan(
      JSON.parse(JSON.stringify(plan)),
    ),
    plan,
  );
  assert.equal(
    createPluginPackageWorkflowExecutionPlan(planInput(value)).planDigest,
    plan.planDigest,
  );
});

test('rejects withdrawn, drifted and incomplete Workflow execution inputs', () => {
  const value = fixture('workflow-execution-plan-conflict');
  const withdrawn = createPluginPackageAutomationLifecyclePublication({
    previous: value.publication,
    state: 'withdrawn',
    lifecycleEventDigest: 'a'.repeat(64),
    publishedAtMs: 2_001,
  });
  assert.throws(
    () =>
      createPluginPackageWorkflowExecutionPlan(
        planInput(value, { publication: withdrawn }),
      ),
    PluginPackageWorkflowExecutionPlanConflictError,
  );

  const replacement = fixture('workflow-execution-plan-replacement');
  assert.throws(
    () =>
      createPluginPackageWorkflowExecutionPlan(
        planInput(value, { revision: replacement.revision }),
      ),
    PluginPackageWorkflowExecutionPlanConflictError,
  );
  assert.throws(
    () =>
      createPluginPackageWorkflowExecutionPlan(
        planInput(value, {
          stepRunIds: { collect: 'step-run-collect-001' },
        }),
      ),
    InvalidPluginPackageWorkflowExecutionPlanError,
  );
  assert.throws(
    () =>
      createPluginPackageWorkflowExecutionPlan(
        planInput(value, {
          stepRunIds: {
            collect: 'step-run-shared',
            summarize: 'step-run-shared',
          },
        }),
      ),
    InvalidPluginPackageWorkflowExecutionPlanError,
  );
});

test('fails closed when a durable plan digest or generation-bound Task reference drifts', () => {
  const value = fixture('workflow-execution-plan-normalization');
  const plan = createPluginPackageWorkflowExecutionPlan(planInput(value));
  assert.throws(
    () =>
      normalizePluginPackageWorkflowExecutionPlan({
        ...plan,
        planDigest: 'f'.repeat(64),
      }),
    InvalidPluginPackageWorkflowExecutionPlanError,
  );
  assert.throws(
    () =>
      normalizePluginPackageWorkflowExecutionPlan({
        ...plan,
        steps: plan.steps.map((step) =>
          step.stepKey === 'collect'
            ? {
                ...step,
                taskDefinitionRef:
                  'plugin-package:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff:task:alpha',
              }
            : step,
        ),
      }),
    InvalidPluginPackageWorkflowExecutionPlanError,
  );
});

test('derives a deterministic atomic admission bundle and durable receipt', () => {
  const value = fixture('workflow-admission-bundle');
  const plan = createPluginPackageWorkflowExecutionPlan(planInput(value));
  const bundle = createPluginPackageWorkflowAdmissionBundle(plan);

  assert.deepEqual(bundle.plan, plan);
  assert.equal(bundle.run.id, plan.runId);
  assert.equal(bundle.run.status, 'running');
  assert.equal(bundle.run.version, 3);
  assert.equal(bundle.run.eventSequence, 3);
  assert.equal(bundle.admissionEvent.sequence, 1);
  assert.equal(bundle.admissionEvent.type, 'workflow.admitted');
  assert.equal(bundle.admissionEvent.id.length <= 36, true);
  assert.deepEqual(
    bundle.stepMutations.map((mutation) => ({
      stepKey: mutation.stepRun.stepKey,
      status: mutation.stepRun.status,
      expectedRunVersion: mutation.expectedRunVersion,
      expectedRunEventSequence: mutation.expectedRunEventSequence,
      eventSequence: mutation.event.sequence,
    })),
    [
      {
        stepKey: 'collect',
        status: 'ready',
        expectedRunVersion: 1,
        expectedRunEventSequence: 1,
        eventSequence: 2,
      },
      {
        stepKey: 'summarize',
        status: 'pending',
        expectedRunVersion: 2,
        expectedRunEventSequence: 2,
        eventSequence: 3,
      },
    ],
  );
  assert.equal(bundle.receipt.planDigest, plan.planDigest);
  assert.equal(bundle.receipt.finalRunVersion, 3);
  assert.equal(bundle.receipt.finalRunEventSequence, 3);
  assert.equal(
    bundle.receipt.receiptDigest,
    pluginPackageWorkflowAdmissionReceiptDigest(bundle.receipt),
  );
  assert.equal(
    bundle.stepMutations.every(
      ({ event }) => event.id.length <= 36 && event.dedupeKey.length <= 36,
    ),
    true,
  );
  assert.deepEqual(
    normalizePluginPackageWorkflowAdmissionReceipt(
      JSON.parse(JSON.stringify(bundle.receipt)),
    ),
    bundle.receipt,
  );
  assert.deepEqual(createPluginPackageWorkflowAdmissionBundle(plan), bundle);
});

test('rejects tampered Workflow admission receipts and counters', () => {
  const value = fixture('workflow-admission-receipt-invalid');
  const bundle = createPluginPackageWorkflowAdmissionBundle(
    createPluginPackageWorkflowExecutionPlan(planInput(value)),
  );

  assert.throws(
    () =>
      normalizePluginPackageWorkflowAdmissionReceipt({
        ...bundle.receipt,
        receiptDigest: 'f'.repeat(64),
      }),
    InvalidPluginPackageWorkflowAdmissionReceiptError,
  );
  assert.throws(
    () =>
      normalizePluginPackageWorkflowAdmissionReceipt({
        ...bundle.receipt,
        finalRunVersion: 2,
      }),
    InvalidPluginPackageWorkflowAdmissionReceiptError,
  );
});

test('keeps Run and RunEvent identities portable across SQLite and PostgreSQL', () => {
  const value = fixture('workflow-portable-identity');
  assert.throws(
    () =>
      createPluginPackageWorkflowExecutionPlan(
        planInput(value, { runId: `r${'a'.repeat(36)}` }),
      ),
    InvalidPluginPackageWorkflowExecutionPlanError,
  );
});

test('publishes the pure planner only through its explicit runtime-core subpath', () => {
  const subpath = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
  const root = require('../dist');
  assert.equal(
    subpath.createPluginPackageWorkflowExecutionPlan,
    createPluginPackageWorkflowExecutionPlan,
  );
  assert.equal(root.createPluginPackageWorkflowExecutionPlan, undefined);
});
