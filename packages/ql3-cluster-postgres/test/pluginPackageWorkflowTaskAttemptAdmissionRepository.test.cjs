const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  compileClusterCommandTaskDefinition,
} = require('@qinglong/runtime-core/cluster-execution-revision');
const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  planPluginPackageTaskReconciliation,
  pluginPackageTaskReconciliationTaskIds,
} = require('@qinglong/runtime-core/plugin-package-task-reconciliation');
const {
  createPluginPackageWorkflowAdmissionBundle,
  createPluginPackageWorkflowExecutionPlan,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  PluginPackageWorkflowTaskAttemptAdmissionConflictError,
} = require('@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission');
const {
  pluginPackageTaskReconciliationFixture,
} = require('../../../test/contracts/pluginPackageTaskReconciliationRepositoryContract.cjs');
const {
  PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository,
} = require('../dist/plugin-package/workflow/pluginPackageWorkflowTaskAttemptAdmissionRepository');

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
    planId: `wf-attempt-plan-${namespace}`,
    runId: `wf-attempt-run-${namespace}`,
    workflowId: 'daily',
    stepRunIds: {
      collect: `wf-attempt-collect-${namespace}`,
      summarize: `wf-attempt-summary-${namespace}`,
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
  const execution = compileClusterCommandTaskDefinition(
    taskDefinition,
    value.registry,
  );
  const stepRun = admission.stepMutations.find(
    ({ stepRun: candidate }) => candidate.stepKey === 'collect',
  ).stepRun;
  return {
    ...value,
    plan,
    admission,
    reconciliation: reconciliationPlan.receipt,
    execution,
    stepRun,
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
    parentStepRunId: stepRun.parentStepRunId ?? null,
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

function snapshotRow(value) {
  const execution = value.execution;
  return {
    planJson: value.plan,
    reconciliationJson: value.reconciliation,
    executionProjectId: execution.projectId,
    executionTaskId: execution.taskId,
    executionSourceRevision: execution.sourceRevision,
    executionTaskRevision: execution.taskRevision,
    executionSourceContentDigest: execution.sourceContentDigest,
    executionExecutorType: execution.executorType,
    executionPlanSchema: execution.planSchema,
    executionPlanJson: {
      command: execution.command,
      environment: execution.environment,
      ...(execution.workingDirectory === undefined
        ? {}
        : { workingDirectory: execution.workingDirectory }),
      ...(execution.timeoutMs === undefined
        ? {}
        : { timeoutMs: execution.timeoutMs }),
      ...(execution.placement === undefined
        ? {}
        : { placement: execution.placement }),
    },
    executionContentDigest: execution.contentDigest,
    executionCreatedAtMs: execution.createdAtMs,
  };
}

function mockPool(value, options = {}) {
  const queries = [];
  let connections = 0;
  let releases = 0;
  return {
    pool: {
      async connect() {
        connections += 1;
        const connection = connections;
        let retryFailure =
          connection <= (options.serializationFailures ?? 0);
        return {
          async query(text, values) {
            queries.push({ connection, text, values });
            if (
              retryFailure &&
              text.includes(
                'plugin_package_workflow_task_attempt_snapshot',
              )
            ) {
              retryFailure = false;
              throw Object.assign(new Error('serialization failure'), {
                code: '40001',
              });
            }
            if (
              text.includes('FROM "ql3"."step_runs" AS current')
            ) {
              return {
                rows: options.candidateRows ?? [
                  {
                    runId: value.plan.runId,
                    stepRunId: value.stepRun.id,
                    readyAtMs: value.stepRun.readyAtMs,
                    planDigest: value.plan.planDigest,
                  },
                ],
              };
            }
            if (text.includes('FROM "ql3"."runs"')) {
              return {
                rows: [
                  runRow(options.run ?? value.admission.run),
                ],
              };
            }
            if (
              text.includes('FROM "ql3"."step_runs"') &&
              text.includes('FOR UPDATE')
            ) {
              return { rows: [stepRunRow(value.stepRun)] };
            }
            if (
              text.includes(
                'plugin_package_workflow_task_attempt_admissions',
              ) &&
              text.includes('receipt_json') &&
              text.includes('WHERE run_id')
            ) {
              return {
                rows: options.existingReceipt
                  ? [
                      {
                        receiptDigest:
                          options.existingReceipt.receiptDigest,
                        receiptJson: options.existingReceipt,
                      },
                    ]
                  : [],
              };
            }
            if (
              text.includes(
                'plugin_package_workflow_task_attempt_snapshot',
              )
            ) {
              return {
                rows: options.snapshotMissing
                  ? []
                  : [snapshotRow(value)],
              };
            }
            if (text.includes('transaction_timestamp()')) {
              return {
                rows: [{ admittedAtMs: options.admittedAtMs ?? 4_000 }],
              };
            }
            if (text.includes('MAX(attempt)')) {
              return {
                rows: [
                  { attemptNumber: options.attemptNumber ?? 1 },
                ],
              };
            }
            return { rows: [], rowCount: 1 };
          },
          release() {
            releases += 1;
            queries.push({ connection, text: 'RELEASE' });
          },
        };
      },
    },
    queries,
    get connections() {
      return connections;
    },
    get releases() {
      return releases;
    },
  };
}

test('bounds and keyset-pages only ready uncancelled Task attempts', async () => {
  const value = fixture('pg-wta-page');
  const db = mockPool(value, {
    candidateRows: [
      {
        runId: value.plan.runId,
        stepRunId: value.stepRun.id,
        readyAtMs: value.stepRun.readyAtMs,
        planDigest: value.plan.planDigest,
      },
      {
        runId: 'wf-attempt-run-next',
        stepRunId: 'wf-attempt-step-next',
        readyAtMs: value.stepRun.readyAtMs + 1,
        planDigest: 'f'.repeat(64),
      },
    ],
  });
  const repository =
    new PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository(
      db.pool,
    );

  assert.deepEqual(
    await repository.listCandidates({
      limit: 1,
      after: {
        readyAtMs: value.stepRun.readyAtMs - 1,
        stepRunId: 'previous-step',
      },
    }),
    {
      candidates: [
        {
          runId: value.plan.runId,
          stepRunId: value.stepRun.id,
          readyAtMs: value.stepRun.readyAtMs,
          planDigest: value.plan.planDigest,
        },
      ],
      truncated: true,
      next: {
        readyAtMs: value.stepRun.readyAtMs,
        stepRunId: value.stepRun.id,
      },
    },
  );
  const query = db.queries[0];
  assert.deepEqual(query.values, [
    'previous-step',
    value.stepRun.readyAtMs - 1,
    2,
  ]);
  assert.match(query.text, /run\.cancel_requested_at_ms IS NULL/);
  assert.match(query.text, /current\.status = 'ready'/);
  assert.match(query.text, /NOT EXISTS/);
  assert.match(query.text, /LIMIT \$3/);
  await assert.rejects(
    repository.listCandidates({ limit: 65 }),
    InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  );
});

test('atomically admits the exact cluster execution and replays the epoch', async () => {
  const value = fixture('pg-wta-create');
  const db = mockPool(value);
  const repository =
    new PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository(
      db.pool,
    );

  const created = await repository.admit(
    value.plan.runId,
    value.stepRun.id,
  );
  assert.equal(created.status, 'created');
  assert.equal(created.receipt.resourceTaskId, 'alpha');
  assert.equal(
    created.receipt.taskId,
    `pkg:${value.packageName}:alpha`,
  );
  assert.equal(created.receipt.executorType, 'remote_worker');
  assert.equal(created.receipt.executionDigest, value.execution.contentDigest);
  assert.equal(created.receipt.attemptNumber, 1);
  assert.equal(created.receipt.runVersion, value.admission.run.version + 1);

  const sql = db.queries.map(({ text }) => text);
  assert.equal(sql[0], 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.match(
    sql.find((text) => text.includes('FROM "ql3"."runs"')),
    /FOR UPDATE/,
  );
  assert.match(
    sql.find(
      (text) =>
        text.includes('FROM "ql3"."step_runs"') &&
        text.includes('FOR UPDATE'),
    ),
    /FOR UPDATE/,
  );
  assert.ok(
    sql.some((text) =>
      text.includes('plugin_package_workflow_task_attempt_snapshot'),
    ),
  );
  assert.equal(
    sql.filter((text) => text.includes('UPDATE "ql3"."runs"')).length,
    1,
  );
  assert.ok(
    sql.some((text) => text.includes('INSERT INTO "ql3"."run_attempts"')),
  );
  assert.ok(
    sql.some((text) => text.includes('INSERT INTO "ql3"."run_events"')),
  );
  assert.ok(
    sql.some((text) =>
      text.includes(
        '"ql3"."plugin_package_workflow_task_attempt_admissions"',
      ),
    ),
  );
  assert.equal(sql.at(-2), 'COMMIT');
  assert.equal(sql.at(-1), 'RELEASE');

  const replayDb = mockPool(value, {
    existingReceipt: created.receipt,
    run: {
      ...value.admission.run,
      version: created.receipt.runVersion,
      eventSequence: created.receipt.runEventSequence,
    },
  });
  const replay =
    new PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository(
      replayDb.pool,
    );
  assert.deepEqual(
    await replay.admit(value.plan.runId, value.stepRun.id),
    { status: 'existing', receipt: created.receipt },
  );
  assert.equal(
    replayDb.queries.some(({ text }) =>
      text.includes('plugin_package_workflow_task_attempt_snapshot'),
    ),
    false,
  );
});

test('retries serialization once and fails closed without a snapshot', async () => {
  const value = fixture('pg-wta-retry');
  const retried = mockPool(value, { serializationFailures: 1 });
  const repository =
    new PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository(
      retried.pool,
    );
  assert.equal(
    (
      await repository.admit(value.plan.runId, value.stepRun.id)
    ).status,
    'created',
  );
  assert.equal(retried.connections, 2);
  assert.equal(retried.releases, 2);
  assert.ok(retried.queries.some(({ text }) => text === 'ROLLBACK'));

  const missing = mockPool(value, { snapshotMissing: true });
  await assert.rejects(
    new PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository(
      missing.pool,
    ).admit(value.plan.runId, value.stepRun.id),
    PluginPackageWorkflowTaskAttemptAdmissionConflictError,
  );
  assert.ok(missing.queries.some(({ text }) => text === 'ROLLBACK'));
  assert.equal(
    missing.queries.some(({ text }) =>
      text.includes('INSERT INTO "ql3"."run_attempts"'),
    ),
    false,
  );
});

test('is available only through the explicit package subpath', () => {
  assert.match(
    require.resolve(
      '@qinglong/cluster-postgres/plugin-package-workflow-task-attempt-admission',
    ),
    /pluginPackageWorkflowTaskAttemptAdmissionRepository\.js$/,
  );
  const root = require('@qinglong/cluster-postgres');
  assert.equal(
    root.PostgresPluginPackageWorkflowTaskAttemptAdmissionRepository,
    undefined,
  );
});
