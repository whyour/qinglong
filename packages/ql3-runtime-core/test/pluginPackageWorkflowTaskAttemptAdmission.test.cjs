const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createInitialPluginPackageAutomationPublication,
} = require('../dist/plugin-package/pluginPackageAutomationPublication');
const {
  planPluginPackageTaskReconciliation,
  pluginPackageTaskReconciliationTaskIds,
} = require('../dist/plugin-package/pluginPackageTaskReconciliation');
const {
  createPluginPackageWorkflowAdmissionBundle,
  createPluginPackageWorkflowExecutionPlan,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  createPluginPackageWorkflowTaskAttemptAdmission,
  InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt,
} = require('@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission');
const {
  compileLocalCommandTaskDefinition,
} = require('../dist/task-definition/taskDefinitionExecutionCompiler');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');

function fixture(namespace = 'workflow-task-attempt') {
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
  const admission = createPluginPackageWorkflowAdmissionBundle(plan);
  const reconciliationPlan = planPluginPackageTaskReconciliation({
    revision: value.revision,
    previousReceipt: null,
    facts: pluginPackageTaskReconciliationTaskIds(
      value.revision,
      null,
      value.registry,
    ).map((taskId) => ({
      taskId,
      packageName: null,
      current: null,
    })),
    committedAtMs: 2_500,
    taskSpecSemanticRegistry: value.registry,
  });
  const taskDefinition = reconciliationPlan.writes.find(
    ({ definition }) =>
      definition.taskId === `pkg:${value.packageName}:alpha`,
  ).definition;
  const executionRevision = compileLocalCommandTaskDefinition(
    taskDefinition,
    value.registry,
  ).executionRevision;
  const stepRun = admission.stepMutations.find(
    ({ stepRun }) => stepRun.stepKey === 'collect',
  ).stepRun;
  return {
    ...value,
    publication,
    plan,
    admission,
    reconciliation: reconciliationPlan.receipt,
    taskDefinition,
    executionRevision,
    stepRun,
  };
}

function input(value, overrides = {}) {
  return {
    plan: value.plan,
    run: value.admission.run,
    stepRun: value.stepRun,
    taskReconciliation: value.reconciliation,
    execution: value.executionRevision,
    attemptNumber: 1,
    admittedAtMs: 4_000,
    ...overrides,
  };
}

test('binds one ready source StepRun to one exact executable Task Attempt', () => {
  const value = fixture();
  const bundle = createPluginPackageWorkflowTaskAttemptAdmission(input(value));

  assert.equal(bundle.attempt.runId, value.plan.runId);
  assert.equal(bundle.attempt.stepRunId, value.stepRun.id);
  assert.equal(bundle.attempt.status, 'claimed');
  assert.equal(bundle.attempt.executorType, 'local_process');
  assert.equal(bundle.attempt.callbackSequence, 0);
  assert.equal(bundle.attempt.id.length <= 36, true);
  assert.equal(bundle.event.id.length <= 36, true);
  assert.equal(bundle.event.type, 'workflow.task_attempt_admitted');
  assert.equal(bundle.event.attemptId, bundle.attempt.id);
  assert.equal(bundle.event.stepRunId, value.stepRun.id);
  assert.equal(bundle.run.status, 'running');
  assert.equal(bundle.run.version, 4);
  assert.equal(bundle.run.eventSequence, 4);
  assert.equal(
    bundle.receipt.resourceTaskId,
    'alpha',
  );
  assert.equal(
    bundle.receipt.taskId,
    `pkg:${value.packageName}:alpha`,
  );
  assert.equal(
    bundle.receipt.taskRevision,
    value.executionRevision.taskRevision,
  );
  assert.equal(
    bundle.receipt.taskReconciliationReceiptDigest,
    value.reconciliation.receiptDigest,
  );
  assert.deepEqual(
    normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt(
      bundle.receipt,
    ),
    bundle.receipt,
  );
  assert.deepEqual(
    createPluginPackageWorkflowTaskAttemptAdmission(input(value)),
    bundle,
  );
});

test('keeps Task execution generation-bound instead of reading a current head', () => {
  const value = fixture('workflow-task-attempt-binding');
  assert.throws(
    () =>
      createPluginPackageWorkflowTaskAttemptAdmission(
        input(value, {
          execution: {
            ...value.executionRevision,
            taskId: `pkg:${value.packageName}:beta`,
          },
        }),
      ),
    InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  );
  assert.throws(
    () =>
      createPluginPackageWorkflowTaskAttemptAdmission(
        input(value, {
          taskReconciliation: {
            ...value.reconciliation,
            receiptDigest: 'f'.repeat(64),
          },
        }),
      ),
    InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  );
  assert.throws(
    () =>
      createPluginPackageWorkflowTaskAttemptAdmission(
        input(value, {
          execution: {
            ...value.executionRevision,
            contentDigest: 'f'.repeat(64),
          },
        }),
      ),
    InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  );
});

test('rejects pending, cancelled and exhausted admission fences', () => {
  const value = fixture('workflow-task-attempt-fence');
  const pending = value.admission.stepMutations.find(
    ({ stepRun }) => stepRun.stepKey === 'summarize',
  ).stepRun;
  assert.throws(
    () =>
      createPluginPackageWorkflowTaskAttemptAdmission(
        input(value, { stepRun: pending }),
      ),
    InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  );
  assert.throws(
    () =>
      createPluginPackageWorkflowTaskAttemptAdmission(
        input(value, {
          run: {
            ...value.admission.run,
            cancelRequestedAtMs: 3_500,
            cancelReason: 'user',
          },
        }),
      ),
    InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  );
  assert.throws(
    () =>
      createPluginPackageWorkflowTaskAttemptAdmission(
        input(value, {
          attemptNumber: 8_193,
        }),
      ),
    InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  );
});

test('rejects receipt drift and publishes only the explicit subpath', () => {
  const value = fixture('workflow-task-attempt-receipt');
  const bundle = createPluginPackageWorkflowTaskAttemptAdmission(input(value));
  assert.throws(
    () =>
      normalizePluginPackageWorkflowTaskAttemptAdmissionReceipt({
        ...bundle.receipt,
        attemptNumber: 2,
      }),
    InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  );
  const authority = require('@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission');
  const root = require('../dist');
  assert.equal(
    authority.createPluginPackageWorkflowTaskAttemptAdmission,
    createPluginPackageWorkflowTaskAttemptAdmission,
  );
  assert.equal(
    root.createPluginPackageWorkflowTaskAttemptAdmission,
    undefined,
  );
});
