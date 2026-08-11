const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createInitialPluginPackageAutomationPublication,
} = require('../dist/plugin-package/pluginPackageAutomationPublication');
const {
  createPluginPackageWorkflowAdmissionBundle,
  createPluginPackageWorkflowExecutionPlan,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  InvalidPluginPackageWorkflowFrontierError,
  resolvePluginPackageWorkflowFrontier,
} = require('@qinglong/runtime-core/plugin-package-workflow-frontier');
const {
  transitionStepRunMutation,
} = require('../dist/run/stepRun');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');

function fixture(namespace = 'workflow-frontier', steps) {
  const value = pluginPackageTaskReconciliationFixture(namespace, {
    workflows: [
      {
        schema: 'qinglong/plugin-package-workflow-resource@v1',
        id: 'daily',
        name: 'Daily workflow',
        enabled: true,
        steps:
          steps ??
          [
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
  const workflowSteps = steps ?? [
    { id: 'collect', task: 'alpha', needs: [] },
    { id: 'summarize', task: 'beta', needs: ['collect'] },
  ];
  const plan = createPluginPackageWorkflowExecutionPlan({
    planId: `${namespace}-plan`,
    runId: `${namespace}-run`,
    workflowId: 'daily',
    stepRunIds: Object.fromEntries(
      workflowSteps.map(({ id }) => [id, `${namespace}-${id}`]),
    ),
    publication,
    revision: value.revision,
    taskSpecSemanticRegistry: value.registry,
    plannedAtMs: 3_000,
  });
  return createPluginPackageWorkflowAdmissionBundle(plan);
}

function transition(stepRun, to, runVersion, runEventSequence, atMs) {
  return transitionStepRunMutation(
    stepRun,
    {
      expectedVersion: stepRun.version,
      expectedDigest: stepRun.stepRunDigest,
      mutationId: `test-${stepRun.stepKey}-${to}-${stepRun.version}`,
      to,
      atMs,
      ...(to === 'failed' ? { resultCode: 'task_failed' } : {}),
      ...(to === 'succeeded'
        ? { outputRef: `artifact:${stepRun.stepKey}` }
        : {}),
    },
    {
      expectedRunVersion: runVersion,
      expectedRunEventSequence: runEventSequence,
      eventId: `event-${stepRun.stepKey}-${to}-${stepRun.version}`,
      dedupeKey: `event-${stepRun.stepKey}-${to}-${stepRun.version}`,
      actor: { type: 'executor' },
    },
  ).stepRun;
}

function admittedStepRuns(bundle) {
  return bundle.stepMutations.map(({ stepRun }) => stepRun);
}

test('promotes a dependent pending Task after every need succeeds', () => {
  const bundle = fixture();
  const [collect, summarize] = admittedStepRuns(bundle);
  const running = transition(
    collect,
    'running',
    bundle.run.version,
    bundle.run.eventSequence,
    4_000,
  );
  const succeeded = transition(
    running,
    'succeeded',
    bundle.run.version + 1,
    bundle.run.eventSequence + 1,
    5_000,
  );
  const resolution = resolvePluginPackageWorkflowFrontier({
    plan: bundle.plan,
    run: {
      ...bundle.run,
      version: bundle.run.version + 2,
      eventSequence: bundle.run.eventSequence + 2,
    },
    stepRuns: [succeeded, summarize],
    observedAtMs: 6_000,
  });

  assert.equal(resolution.stepMutations.length, 1);
  assert.equal(resolution.stepMutations[0].previousStatus, 'pending');
  assert.equal(resolution.stepMutations[0].stepRun.status, 'ready');
  assert.equal(resolution.stepMutations[0].event.id.length <= 36, true);
  assert.equal(resolution.stepMutations[0].event.actorType, 'reconciler');
  assert.deepEqual(resolution.readyStepRunIds, [summarize.id]);
  assert.equal(resolution.terminalStatus, null);
});

test('propagates a required dependency failure through the whole DAG in one pass', () => {
  const steps = [
    { id: 'collect', task: 'alpha', needs: [] },
    { id: 'prepare', task: 'beta', needs: ['collect'] },
    { id: 'publish', task: 'alpha', needs: ['prepare'] },
  ];
  const bundle = fixture('workflow-frontier-failure', steps);
  const [collect, prepare, publish] = admittedStepRuns(bundle);
  const running = transition(
    collect,
    'running',
    bundle.run.version,
    bundle.run.eventSequence,
    4_000,
  );
  const failed = transition(
    running,
    'failed',
    bundle.run.version + 1,
    bundle.run.eventSequence + 1,
    5_000,
  );
  const resolution = resolvePluginPackageWorkflowFrontier({
    plan: bundle.plan,
    run: {
      ...bundle.run,
      version: bundle.run.version + 2,
      eventSequence: bundle.run.eventSequence + 2,
    },
    stepRuns: [failed, prepare, publish],
    observedAtMs: 6_000,
  });

  assert.deepEqual(
    resolution.stepMutations.map(({ stepRun }) => [
      stepRun.stepKey,
      stepRun.status,
      stepRun.resultCode,
    ]),
    [
      ['prepare', 'skipped', 'dependency_not_succeeded'],
      ['publish', 'skipped', 'dependency_not_succeeded'],
    ],
  );
  assert.equal(
    resolution.stepMutations[1].expectedRunVersion,
    resolution.stepMutations[0].expectedRunVersion + 1,
  );
  assert.deepEqual(resolution.readyStepRunIds, []);
  assert.equal(resolution.terminalStatus, 'failed');
  assert.equal(resolution.terminalTransition.status, 'failed');
  assert.equal(
    resolution.terminalTransition.errorCode,
    'workflow_step_failed',
  );
  assert.equal(
    resolution.terminalTransition.expectedRunVersion,
    bundle.run.version + 4,
  );
  assert.equal(resolution.terminalTransition.event.id.length <= 36, true);
  assert.equal(resolution.terminalTransition.event.type, 'workflow.failed');
});

test('keeps dependents pending while a required predecessor is executable', () => {
  const bundle = fixture('workflow-frontier-waiting');
  const resolution = resolvePluginPackageWorkflowFrontier({
    plan: bundle.plan,
    run: bundle.run,
    stepRuns: admittedStepRuns(bundle),
    observedAtMs: 4_000,
  });

  assert.deepEqual(resolution.stepMutations, []);
  assert.deepEqual(resolution.readyStepRunIds, [
    bundle.plan.steps.find(({ stepKey }) => stepKey === 'collect').stepRunId,
  ]);
  assert.equal(resolution.terminalStatus, null);
});

test('returns succeeded only after every required StepRun succeeds', () => {
  const bundle = fixture('workflow-frontier-terminal');
  const [collect, summarize] = admittedStepRuns(bundle);
  const collectRunning = transition(
    collect,
    'running',
    bundle.run.version,
    bundle.run.eventSequence,
    4_000,
  );
  const collectSucceeded = transition(
    collectRunning,
    'succeeded',
    bundle.run.version + 1,
    bundle.run.eventSequence + 1,
    5_000,
  );
  const summarizeReady = transition(
    summarize,
    'ready',
    bundle.run.version + 2,
    bundle.run.eventSequence + 2,
    6_000,
  );
  const summarizeRunning = transition(
    summarizeReady,
    'running',
    bundle.run.version + 3,
    bundle.run.eventSequence + 3,
    7_000,
  );
  const summarizeSucceeded = transition(
    summarizeRunning,
    'succeeded',
    bundle.run.version + 4,
    bundle.run.eventSequence + 4,
    8_000,
  );
  const resolution = resolvePluginPackageWorkflowFrontier({
    plan: bundle.plan,
    run: {
      ...bundle.run,
      version: bundle.run.version + 5,
      eventSequence: bundle.run.eventSequence + 5,
    },
    stepRuns: [collectSucceeded, summarizeSucceeded],
    observedAtMs: 9_000,
  });

  assert.deepEqual(resolution.stepMutations, []);
  assert.deepEqual(resolution.readyStepRunIds, []);
  assert.equal(resolution.terminalStatus, 'succeeded');
  assert.equal(resolution.terminalTransition.status, 'succeeded');
  assert.equal(resolution.terminalTransition.errorCode, null);
  assert.equal(
    resolution.terminalTransition.event.sequence,
    bundle.run.eventSequence + 6,
  );
});

test('fails closed on incomplete or definition-drifted durable StepRuns', () => {
  const bundle = fixture('workflow-frontier-corrupt');
  const stepRuns = admittedStepRuns(bundle);
  assert.throws(
    () =>
      resolvePluginPackageWorkflowFrontier({
        plan: bundle.plan,
        run: bundle.run,
        stepRuns: stepRuns.slice(0, 1),
        observedAtMs: 4_000,
      }),
    InvalidPluginPackageWorkflowFrontierError,
  );
  assert.throws(
    () =>
      resolvePluginPackageWorkflowFrontier({
        plan: bundle.plan,
        run: bundle.run,
        stepRuns: [
          {
            ...stepRuns[0],
            definitionDigest: 'f'.repeat(64),
          },
          stepRuns[1],
        ],
        observedAtMs: 4_000,
      }),
    InvalidPluginPackageWorkflowFrontierError,
  );
});

test('does not advance a Workflow after aggregate cancellation is requested', () => {
  const bundle = fixture('workflow-frontier-cancelled');
  assert.throws(
    () =>
      resolvePluginPackageWorkflowFrontier({
        plan: bundle.plan,
        run: {
          ...bundle.run,
          cancelRequestedAtMs: 3_500,
          cancelReason: 'user',
        },
        stepRuns: admittedStepRuns(bundle),
        observedAtMs: 4_000,
      }),
    InvalidPluginPackageWorkflowFrontierError,
  );
});

test('publishes frontier planning only through its explicit runtime-core subpath', () => {
  const subpath = require('@qinglong/runtime-core/plugin-package-workflow-frontier');
  const root = require('../dist');
  assert.equal(
    subpath.resolvePluginPackageWorkflowFrontier,
    resolvePluginPackageWorkflowFrontier,
  );
  assert.equal(root.resolvePluginPackageWorkflowFrontier, undefined);
});
