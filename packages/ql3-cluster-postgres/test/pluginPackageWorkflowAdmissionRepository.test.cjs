const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  createPluginPackageWorkflowAdmissionBundle,
  createPluginPackageWorkflowExecutionPlan,
  PluginPackageWorkflowAdmissionNotAllowedError,
  PluginPackageWorkflowAdmissionUnavailableError,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  transitionStepRunMutation,
} = require('@qinglong/runtime-core/step-run');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  PostgresPluginPackageWorkflowAdmissionRepository,
} = require('../dist/plugin-package/workflow/pluginPackageWorkflowAdmissionRepository');

function fixture(namespace = 'postgres-workflow-admission') {
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
    planId: `workflow-plan-${namespace}`,
    runId: `run-${namespace}`,
    workflowId: 'daily',
    stepRunIds: {
      collect: `step-collect-${namespace}`,
      summarize: `step-summarize-${namespace}`,
    },
    publication,
    revision: value.revision,
    taskSpecSemanticRegistry: value.registry,
    plannedAtMs: 3_000,
  });
  return { ...value, publication, plan };
}

function poolWithClient(client) {
  return {
    async query(text, values) {
      return client.query(text, values);
    },
    async connect() {
      return client;
    },
  };
}

function admissionRow(bundle) {
  const { plan, receipt } = bundle;
  return {
    planDigest: plan.planDigest,
    planId: plan.planId,
    runId: plan.runId,
    projectId: plan.target.projectId,
    packageName: plan.target.packageName,
    installationId: plan.target.installationId,
    lockDigest: plan.target.lockDigest,
    generation: plan.target.generation,
    generationDigest: plan.target.generationDigest,
    materializedRevisionDigest: plan.target.materializedRevisionDigest,
    publicationDigest: plan.target.publicationDigest,
    workflowId: plan.target.workflowId,
    workflowDefinitionDigest: plan.target.workflowDefinitionDigest,
    stepCount: plan.steps.length,
    admittedAtMs: receipt.admittedAtMs,
    finalRunVersion: receipt.finalRunVersion,
    finalRunEventSequence: receipt.finalRunEventSequence,
    receiptDigest: receipt.receiptDigest,
    planJson: plan,
    receiptJson: receipt,
  };
}

function runRow(run) {
  return {
    projectId: run.projectId,
    taskId: run.taskId,
    taskRevision: run.taskRevision,
    taskSnapshotRef: run.taskSnapshotRef ?? null,
    triggerType: run.triggerType,
    executionOrigin: run.executionOrigin,
    executionOwner: run.executionOwner,
    requestId: run.requestId ?? null,
    status: run.status,
    version: run.version,
    eventSequence: run.eventSequence,
    priority: run.priority,
    idempotencyKey: run.idempotencyKey ?? null,
    createdAtMs: run.createdAtMs,
    startedAtMs: run.startedAtMs ?? null,
  };
}

function eventRow(event) {
  return {
    id: event.id,
    sequence: event.sequence,
    type: event.type,
    dedupeKey: event.dedupeKey ?? null,
    actorType: event.actorType,
    actorId: event.actorId ?? null,
    stepRunId: event.stepRunId ?? null,
    payload: event.payload,
    createdAtMs: event.createdAtMs,
  };
}

function stepEvidenceRow(bundle, stepKey, currentStepRun) {
  const mutation = bundle.stepMutations.find(
    ({ stepRun }) => stepRun.stepKey === stepKey,
  );
  const step = bundle.plan.steps.find(
    (candidate) => candidate.stepKey === stepKey,
  );
  assert.ok(mutation);
  assert.ok(step);
  return {
    stepRunId: mutation.stepRun.id,
    taskId: step.taskId,
    taskDefinitionRef: step.taskDefinitionRef,
    taskDefinitionDigest: step.taskDefinitionDigest,
    needsJson: step.needs,
    initialStatus: step.initialStatus,
    mutationId: mutation.mutationId,
    eventId: mutation.event.id,
    currentStepKey: (currentStepRun ?? mutation.stepRun).stepKey,
    currentKind: (currentStepRun ?? mutation.stepRun).kind,
    currentDefinitionRef: (currentStepRun ?? mutation.stepRun).definitionRef,
    currentDefinitionDigest:
      (currentStepRun ?? mutation.stepRun).definitionDigest,
    currentRequired: (currentStepRun ?? mutation.stepRun).required,
    currentStatus: (currentStepRun ?? mutation.stepRun).status,
    currentVersion: (currentStepRun ?? mutation.stepRun).version,
    currentLastMutationId: (currentStepRun ?? mutation.stepRun).lastMutationId,
    currentStepRunDigest: (currentStepRun ?? mutation.stepRun).stepRunDigest,
    currentStepRunJson: currentStepRun ?? mutation.stepRun,
    mutationDigest: mutation.mutationDigest,
    eventSequence: mutation.event.sequence,
    runVersion: mutation.expectedRunVersion + 1,
    initialStepRunDigest: mutation.stepRun.stepRunDigest,
    initialStepRunJson: mutation.stepRun,
  };
}

test('admits the complete Workflow evidence in one SERIALIZABLE transaction', async () => {
  const value = fixture();
  const queries = [];
  let released = false;
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (
        text.includes('plugin_package_workflow_admissions') &&
        text.includes('WHERE plan_id')
      ) {
        return { rows: [] };
      }
      if (text.includes('plugin_package_workflow_admission_snapshot')) {
        return {
          rows: [
            {
              publicationJson: value.publication,
              revisionJson: value.revision,
            },
          ],
        };
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  const repository = new PostgresPluginPackageWorkflowAdmissionRepository(
    poolWithClient(client),
  );

  const result = await repository.admit(value.plan);
  assert.equal(result.status, 'created');
  assert.equal(result.receipt.finalRunVersion, 3);
  assert.equal(queries[0].text, 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.equal(queries.at(-1).text, 'COMMIT');
  assert.equal(released, true);
  assert.equal(
    queries.some(
      ({ text }) =>
        text.includes('plugin_package_workflow_admissions') &&
        text.includes('FOR SHARE'),
    ),
    false,
    'append-only replay must not require UPDATE authority',
  );
  assert.equal(
    queries.filter(({ text }) => /INSERT INTO "ql3"\."runs"/.test(text)).length,
    1,
  );
  assert.equal(
    queries.filter(({ text }) => /INSERT INTO "ql3"\."step_runs"/.test(text))
      .length,
    2,
  );
  assert.equal(
    queries.filter(({ text }) => /INSERT INTO "ql3"\."run_events"/.test(text))
      .length,
    3,
  );
  assert.equal(
    queries.filter(({ text }) =>
      /INSERT INTO "ql3"\."step_run_mutations"/.test(text),
    ).length,
    2,
  );
  assert.equal(
    queries.filter(({ text }) =>
      /INSERT INTO "ql3"\."plugin_package_workflow_admissions"/.test(text),
    ).length,
    1,
  );
});

test('exactly replays durable admission after current StepRun progression', async () => {
  const value = fixture('postgres-workflow-replay');
  const bundle = createPluginPackageWorkflowAdmissionBundle(value.plan);
  const collect = bundle.stepMutations.find(
    ({ stepRun }) => stepRun.stepKey === 'collect',
  ).stepRun;
  const running = transitionStepRunMutation(
    collect,
    {
      expectedVersion: collect.version,
      expectedDigest: collect.stepRunDigest,
      mutationId: 'postgres-workflow-progress-running',
      to: 'running',
      atMs: 4_000,
    },
    {
      expectedRunVersion: bundle.run.version,
      expectedRunEventSequence: bundle.run.eventSequence,
      eventId: 'postgres-workflow-running-event',
      dedupeKey: 'postgres-workflow-running-event',
      actor: { type: 'executor' },
    },
  );
  const succeeded = transitionStepRunMutation(
    running.stepRun,
    {
      expectedVersion: running.stepRun.version,
      expectedDigest: running.stepRun.stepRunDigest,
      mutationId: 'postgres-workflow-progress-success',
      to: 'succeeded',
      atMs: 5_000,
    },
    {
      expectedRunVersion: bundle.run.version + 1,
      expectedRunEventSequence: bundle.run.eventSequence + 1,
      eventId: 'postgres-workflow-success-event',
      dedupeKey: 'postgres-workflow-success-event',
      actor: { type: 'executor' },
    },
  );
  const queries = [];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (
        text.includes('plugin_package_workflow_admissions') &&
        text.includes('WHERE plan_id')
      ) {
        return {
          rows: [admissionRow(bundle)],
        };
      }
      if (text.includes('FROM "ql3"."runs" WHERE id')) {
        return {
          rows: [
            runRow({
              ...bundle.run,
              version: bundle.run.version + 2,
              eventSequence: bundle.run.eventSequence + 2,
            }),
          ],
        };
      }
      if (text.includes('FROM "ql3"."run_events"')) {
        return {
          rows: [
            eventRow(bundle.admissionEvent),
            ...bundle.stepMutations.map(({ event }) => eventRow(event)),
          ],
        };
      }
      if (
        text.includes('FROM "ql3"."plugin_package_workflow_admission_steps"')
      ) {
        return {
          rows: [
            stepEvidenceRow(
              bundle,
              values[1],
              values[1] === 'collect' ? succeeded.stepRun : undefined,
            ),
          ],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresPluginPackageWorkflowAdmissionRepository(
    poolWithClient(client),
  );

  assert.deepEqual(await repository.findPlanByPlanId(value.plan.planId), value.plan);
  assert.deepEqual(await repository.admit(value.plan), {
    status: 'existing',
    receipt: bundle.receipt,
  });
  assert.equal(
    queries.some(({ text }) =>
      text.includes('plugin_package_workflow_admission_snapshot'),
    ),
    false,
  );
  const initialEventsQuery = queries.find(({ text }) =>
    text.includes('FROM "ql3"."run_events"'),
  );
  assert.match(initialEventsQuery.text, /sequence <= \$2/);
  assert.deepEqual(initialEventsQuery.values, [
    value.plan.runId,
    bundle.receipt.finalRunEventSequence,
  ]);
  assert.equal(queries.at(-1).text, 'COMMIT');
});

test('rolls back without Run evidence when the database guard denies admission', async () => {
  const value = fixture('postgres-workflow-denied');
  const queries = [];
  const client = {
    async query(text, values) {
      queries.push({ text, values });
      if (
        text.includes('plugin_package_workflow_admissions') &&
        text.includes('WHERE plan_id')
      ) {
        return { rows: [] };
      }
      if (text.includes('plugin_package_workflow_admission_snapshot')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresPluginPackageWorkflowAdmissionRepository(
    poolWithClient(client),
  );

  await assert.rejects(
    repository.admit(value.plan),
    PluginPackageWorkflowAdmissionNotAllowedError,
  );
  assert.equal(queries.at(-1).text, 'ROLLBACK');
  assert.equal(
    queries.some(({ text }) => /INSERT INTO "ql3"\."runs"/.test(text)),
    false,
  );
});

test('surfaces serialization failure as bounded retryable unavailability', async () => {
  const value = fixture('postgres-workflow-serialization');
  const serializationFailure = Object.assign(
    new Error('could not serialize access'),
    { code: '40001' },
  );
  const client = {
    async query(text) {
      if (
        text.includes('plugin_package_workflow_admissions') &&
        text.includes('WHERE plan_id')
      ) {
        throw serializationFailure;
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresPluginPackageWorkflowAdmissionRepository(
    poolWithClient(client),
  );

  await assert.rejects(
    repository.admit(value.plan),
    PluginPackageWorkflowAdmissionUnavailableError,
  );
});

test('publishes Workflow admission only through its explicit cluster subpath', () => {
  const authority = require('@qinglong/cluster-postgres/plugin-package-workflow-admission');
  const root = require('../dist');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  assert.equal(
    authority.PostgresPluginPackageWorkflowAdmissionRepository,
    PostgresPluginPackageWorkflowAdmissionRepository,
  );
  assert.equal(
    root.PostgresPluginPackageWorkflowAdmissionRepository,
    undefined,
  );
  assert.equal(
    runtime.PostgresPluginPackageWorkflowAdmissionRepository,
    undefined,
  );
});
