const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  createPluginPackageWorkflowAdmissionBundle,
  createPluginPackageWorkflowExecutionPlan,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  InvalidPluginPackageWorkflowFrontierError,
  PluginPackageWorkflowFrontierUnavailableError,
  resolvePluginPackageWorkflowFrontier,
} = require('@qinglong/runtime-core/plugin-package-workflow-frontier');
const {
  transitionStepRunMutation,
} = require('@qinglong/runtime-core/step-run');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  PostgresPluginPackageWorkflowFrontierRepository,
} = require('../dist/plugin-package/workflow/pluginPackageWorkflowFrontierRepository');

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
  const bundle = createPluginPackageWorkflowAdmissionBundle(plan);
  return { ...value, publication, plan, bundle };
}

function transition(stepRun, to, runVersion, atMs) {
  return transitionStepRunMutation(
    stepRun,
    {
      expectedVersion: stepRun.version,
      expectedDigest: stepRun.stepRunDigest,
      mutationId: `${stepRun.stepKey}-${to}-${stepRun.version}`,
      to,
      atMs,
      ...(to === 'failed' ? { resultCode: 'task_failed' } : {}),
    },
    {
      expectedRunVersion: runVersion,
      expectedRunEventSequence: runVersion,
      eventId: `${stepRun.stepKey}-${to}-event-${stepRun.version}`,
      dedupeKey: `${stepRun.stepKey}-${to}-event-${stepRun.version}`,
      actor: { type: 'executor' },
    },
  ).stepRun;
}

function progressedSnapshot(value, collectTerminal = 'succeeded') {
  const collectInitial = value.bundle.stepMutations.find(
    ({ stepRun }) => stepRun.stepKey === 'collect',
  ).stepRun;
  const summarize = value.bundle.stepMutations.find(
    ({ stepRun }) => stepRun.stepKey === 'summarize',
  ).stepRun;
  const collectRunning = transition(collectInitial, 'running', 3, 4_000);
  const collect = transition(
    collectRunning,
    collectTerminal,
    4,
    5_000,
  );
  return {
    run: Object.freeze({
      ...value.bundle.run,
      version: 5,
      eventSequence: 5,
    }),
    stepRuns: Object.freeze([collect, summarize]),
  };
}

function runRow(run) {
  return {
    id: run.id,
    projectId: run.projectId,
    taskId: run.taskId,
    taskRevision: run.taskRevision,
    taskName: run.taskName ?? null,
    taskSnapshotRef: run.taskSnapshotRef ?? null,
    legacyCronId: run.legacyCronId ?? null,
    parentRunId: run.parentRunId ?? null,
    retryOfRunId: run.retryOfRunId ?? null,
    triggerId: run.triggerId ?? null,
    triggerType: run.triggerType,
    executionOrigin: run.executionOrigin,
    executionOwner: run.executionOwner,
    triggeredBy: run.triggeredBy ?? null,
    requestId: run.requestId ?? null,
    scheduledForMs: run.scheduledForMs ?? null,
    status: run.status,
    version: run.version,
    eventSequence: run.eventSequence,
    priority: run.priority,
    idempotencyKey: run.idempotencyKey ?? null,
    inputRef: run.inputRef ?? null,
    outputRef: run.outputRef ?? null,
    createdAtMs: run.createdAtMs,
    queuedAtMs: run.queuedAtMs ?? null,
    startedAtMs: run.startedAtMs ?? null,
    finishedAtMs: run.finishedAtMs ?? null,
    cancelRequestedAtMs: run.cancelRequestedAtMs ?? null,
    cancelReason: run.cancelReason ?? null,
    errorCode: run.errorCode ?? null,
    errorSummary: run.errorSummary ?? null,
  };
}

function stepRunRow(stepRun) {
  return {
    id: stepRun.id,
    runId: stepRun.runId,
    parentStepRunId: stepRun.parentStepRunId,
    stepKey: stepRun.stepKey,
    kind: stepRun.kind,
    definitionRef: stepRun.definitionRef,
    definitionDigest: stepRun.definitionDigest,
    required: stepRun.required,
    status: stepRun.status,
    version: stepRun.version,
    attemptCount: stepRun.attemptCount,
    inputRef: stepRun.inputRef ?? null,
    outputRef: stepRun.outputRef ?? null,
    approvalRequestId: stepRun.approvalRequestId ?? null,
    readyAtMs: stepRun.readyAtMs ?? null,
    startedAtMs: stepRun.startedAtMs ?? null,
    finishedAtMs: stepRun.finishedAtMs ?? null,
    resultCode: stepRun.resultCode ?? null,
    errorSummary: stepRun.errorSummary ?? null,
    createdAtMs: stepRun.createdAtMs,
    updatedAtMs: stepRun.updatedAtMs,
    lastMutationId: stepRun.lastMutationId,
    stepRunDigest: stepRun.stepRunDigest,
    stepRunJson: stepRun,
  };
}

function transactionPool(value, snapshot, options = {}) {
  const queries = [];
  let connections = 0;
  let releases = 0;
  const pool = {
    async query(text, values) {
      queries.push({ connection: 0, text, values });
      if (text.includes('plugin_package_workflow_admissions')) {
        return {
          rows: options.candidateRows ?? [
            {
              runId: value.plan.runId,
              planDigest: value.plan.planDigest,
              admittedAtMs: 3_000,
            },
          ],
        };
      }
      return { rows: [] };
    },
    async connect() {
      connections += 1;
      const connection = connections;
      let serializationFailureRemaining =
        connection <= (options.serializationFailures ?? 0) ? 1 : 0;
      return {
        async query(text, values) {
          queries.push({ connection, text, values });
          if (
            serializationFailureRemaining > 0 &&
            text.includes('plugin_package_workflow_admissions')
          ) {
            serializationFailureRemaining -= 1;
            throw Object.assign(new Error('could not serialize access'), {
              code: '40001',
            });
          }
          if (
            text.includes('plugin_package_workflow_admissions') &&
            text.includes('plan_json')
          ) {
            return {
              rows: [
                {
                  planDigest: value.plan.planDigest,
                  planJson: value.plan,
                },
              ],
            };
          }
          if (text.includes('FROM "ql3"."runs"')) {
            return { rows: [runRow(snapshot.run)] };
          }
          if (text.includes('FROM "ql3"."step_runs"')) {
            return { rows: snapshot.stepRuns.map(stepRunRow) };
          }
          if (text.includes('transaction_timestamp()')) {
            return { rows: [{ observedAtMs: options.observedAtMs ?? 6_000 }] };
          }
          return { rows: [], rowCount: 1 };
        },
        release() {
          releases += 1;
          queries.push({ connection, text: 'RELEASE' });
        },
      };
    },
  };
  return {
    pool,
    queries,
    get connections() {
      return connections;
    },
    get releases() {
      return releases;
    },
  };
}

test('bounds and keyset-pages only actionable Workflow candidates', async () => {
  const value = fixture('pg-frontier-page');
  const snapshot = progressedSnapshot(value);
  const secondDigest = 'f'.repeat(64);
  const db = transactionPool(value, snapshot, {
    candidateRows: [
      {
        runId: value.plan.runId,
        planDigest: value.plan.planDigest,
        admittedAtMs: 3_000,
      },
      {
        runId: 'wf-run-next',
        planDigest: secondDigest,
        admittedAtMs: 3_001,
      },
    ],
  });
  const repository =
    new PostgresPluginPackageWorkflowFrontierRepository(db.pool);

  assert.deepEqual(
    await repository.listCandidates({
      limit: 1,
      after: {
        admittedAtMs: 2_999,
        planDigest: '0'.repeat(64),
      },
    }),
    {
      candidates: [
        {
          runId: value.plan.runId,
          planDigest: value.plan.planDigest,
          admittedAtMs: 3_000,
        },
      ],
      truncated: true,
      next: {
        admittedAtMs: 3_000,
        planDigest: value.plan.planDigest,
      },
    },
  );
  const candidateQuery = db.queries[0];
  assert.deepEqual(candidateQuery.values, [2_999, '0'.repeat(64), 2]);
  assert.match(candidateQuery.text, /jsonb_array_elements_text/);
  assert.match(
    candidateQuery.text,
    /run\.cancel_requested_at_ms IS NULL/,
  );
  assert.match(candidateQuery.text, /current\.status = 'pending'/);
  assert.match(candidateQuery.text, /dependency\.status IN/);
  assert.match(candidateQuery.text, /LIMIT \$3/);
  await assert.rejects(
    repository.listCandidates({ limit: 65 }),
    InvalidPluginPackageWorkflowFrontierError,
  );
  assert.equal(db.queries.length, 1);
});

test('advances a ready dependency with locked rows and one aggregate Run CAS', async () => {
  const value = fixture('pg-frontier-advance');
  const snapshot = progressedSnapshot(value);
  const db = transactionPool(value, snapshot);
  const repository =
    new PostgresPluginPackageWorkflowFrontierRepository(db.pool);

  const result = await repository.advance(value.plan.runId);
  assert.equal(result.status, 'advanced');
  assert.equal(result.stepMutationCount, 1);
  assert.equal(result.terminalStatus, null);
  assert.equal(result.runVersion, 6);
  assert.deepEqual(result.readyStepRunIds, [
    value.plan.steps.find(({ stepKey }) => stepKey === 'summarize').stepRunId,
  ]);

  const sql = db.queries.map(({ text }) => text);
  assert.equal(sql[0], 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.match(
    sql.find((text) => text.includes('FROM "ql3"."runs"')),
    /FOR UPDATE/,
  );
  assert.match(
    sql.find((text) => text.includes('FROM "ql3"."step_runs"')),
    /FOR UPDATE/,
  );
  assert.equal(
    sql.filter((text) => text.includes('UPDATE "ql3"."runs"')).length,
    1,
  );
  assert.equal(
    sql.filter((text) => text.includes('UPDATE "ql3"."step_runs"')).length,
    1,
  );
  assert.equal(
    sql.filter((text) => text.includes('INSERT INTO "ql3"."run_events"'))
      .length,
    1,
  );
  assert.equal(
    sql.filter((text) =>
      text.includes('INSERT INTO "ql3"."step_run_mutations"'),
    ).length,
    1,
  );
  assert.equal(sql.at(-2), 'COMMIT');
  assert.equal(sql.at(-1), 'RELEASE');
});

test('skips blocked work and terminalizes the aggregate in one transaction', async () => {
  const value = fixture('pg-frontier-terminal');
  const snapshot = progressedSnapshot(value, 'failed');
  const db = transactionPool(value, snapshot);
  const repository =
    new PostgresPluginPackageWorkflowFrontierRepository(db.pool);

  const result = await repository.advance(value.plan.runId);
  assert.equal(result.status, 'terminal');
  assert.equal(result.stepMutationCount, 1);
  assert.equal(result.terminalStatus, 'failed');
  assert.equal(result.runVersion, 7);
  const runUpdate = db.queries.find(({ text }) =>
    text.includes('UPDATE "ql3"."runs"'),
  );
  assert.deepEqual(runUpdate.values.slice(0, 4), [
    'failed',
    2,
    6_000,
    'workflow_step_failed',
  ]);
  assert.equal(
    db.queries.filter(({ text }) =>
      text.includes('INSERT INTO "ql3"."run_events"'),
    ).length,
    2,
  );
  assert.equal(db.queries.at(-2).text, 'COMMIT');
});

test('retries a serialization race with a fresh client and converges', async () => {
  const value = fixture('pg-frontier-retry');
  const snapshot = progressedSnapshot(value);
  const db = transactionPool(value, snapshot, {
    serializationFailures: 1,
  });
  const repository =
    new PostgresPluginPackageWorkflowFrontierRepository(db.pool);

  assert.equal((await repository.advance(value.plan.runId)).status, 'advanced');
  assert.equal(db.connections, 2);
  assert.equal(db.releases, 2);
  assert.equal(
    db.queries.filter(({ text }) => text === 'ROLLBACK').length,
    1,
  );

  const unavailableDb = transactionPool(value, snapshot, {
    serializationFailures: 99,
  });
  await assert.rejects(
    new PostgresPluginPackageWorkflowFrontierRepository(
      unavailableDb.pool,
    ).advance(value.plan.runId),
    PluginPackageWorkflowFrontierUnavailableError,
  );
  assert.equal(unavailableDb.connections, 3);
  assert.equal(unavailableDb.releases, 3);
});

test('returns settled for an already terminal aggregate without writes', async () => {
  const value = fixture('pg-frontier-settled');
  const progressed = progressedSnapshot(value);
  const frontier = resolvePluginPackageWorkflowFrontier({
    plan: value.plan,
    run: progressed.run,
    stepRuns: progressed.stepRuns,
    observedAtMs: 6_000,
  });
  const summarizeReady = frontier.stepMutations[0].stepRun;
  const summarizeRunning = transition(summarizeReady, 'running', 6, 7_000);
  const summarizeSucceeded = transition(
    summarizeRunning,
    'succeeded',
    7,
    8_000,
  );
  const terminalResolution = resolvePluginPackageWorkflowFrontier({
    plan: value.plan,
    run: {
      ...progressed.run,
      version: 8,
      eventSequence: 8,
    },
    stepRuns: [progressed.stepRuns[0], summarizeSucceeded],
    observedAtMs: 9_000,
  });
  const terminal = terminalResolution.terminalTransition;
  assert.ok(terminal);
  const snapshot = {
    run: Object.freeze({
      ...progressed.run,
      status: terminal.status,
      version: 9,
      eventSequence: 9,
      finishedAtMs: terminal.finishedAtMs,
      errorCode: terminal.errorCode ?? undefined,
    }),
    stepRuns: Object.freeze([
      progressed.stepRuns[0],
      summarizeSucceeded,
    ]),
  };
  const db = transactionPool(value, snapshot, { observedAtMs: 9_000 });

  const result =
    await new PostgresPluginPackageWorkflowFrontierRepository(
      db.pool,
    ).advance(value.plan.runId);
  assert.equal(result.status, 'settled');
  assert.equal(result.terminalStatus, 'succeeded');
  assert.equal(
    db.queries.some(({ text }) => text.includes('UPDATE "ql3"')),
    false,
  );
  assert.equal(db.queries.at(-2).text, 'COMMIT');
});

test('publishes Workflow frontier only through its explicit cluster subpath', () => {
  const authority = require('@qinglong/cluster-postgres/plugin-package-workflow-frontier');
  const root = require('../dist');
  const runtime = require('@qinglong/cluster-postgres/runtime');
  assert.equal(
    authority.PostgresPluginPackageWorkflowFrontierRepository,
    PostgresPluginPackageWorkflowFrontierRepository,
  );
  assert.equal(
    root.PostgresPluginPackageWorkflowFrontierRepository,
    undefined,
  );
  assert.equal(
    runtime.PostgresPluginPackageWorkflowFrontierRepository,
    undefined,
  );
});
