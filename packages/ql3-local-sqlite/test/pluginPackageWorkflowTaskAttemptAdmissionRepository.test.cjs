const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  createInitialPluginPackageAutomationPublication,
} = require('@qinglong/runtime-core/plugin-package-automation-publication');
const {
  createPluginPackageWorkflowExecutionPlan,
} = require('@qinglong/runtime-core/plugin-package-workflow-execution-plan');
const {
  InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  PluginPackageWorkflowTaskAttemptAdmissionConflictError,
  PluginPackageWorkflowTaskAttemptAdmissionUnavailableError,
} = require('@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission');
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
  LocalSqlitePluginPackageTaskReconciliationRepository,
} = require('../dist/plugin-package/pluginPackageTaskReconciliationRepository');
const {
  LocalSqlitePluginPackageWorkflowAdmissionRepository,
} = require('../dist/plugin-package/workflow/pluginPackageWorkflowAdmissionRepository');
const {
  LocalSqlitePluginPackageWorkflowTaskAttemptAdmissionRepository,
} = require('../dist/plugin-package/workflow/pluginPackageWorkflowTaskAttemptAdmissionRepository');
const { LocalSqliteRunRepository } = require('../dist/run/runRepository');
const {
  LocalSqliteOperationAuthority,
} = require('../dist/authority/operationAuthority');
const {
  createLocalSqliteRunRuntimeCapabilities,
} = require('../dist/run/runRuntimeCapabilities');
const {
  LocalSqliteWorkflowTaskExecutionRepository,
} = require('../dist/plugin-package/workflow/workflowTaskExecutionRepository');
const {
  LocalSqlitePluginPackageWorkflowCancellationConvergenceRepository,
} = require('../dist/plugin-package/workflow/pluginPackageWorkflowCancellationConvergenceRepository');
const { auditLocalSqliteReadiness } = require('../dist/readiness/readiness');

function fixture(namespace) {
  const identity = createHash('sha256')
    .update(namespace)
    .digest('hex')
    .slice(0, 16);
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
    planId: `task-attempt-plan-${namespace}`,
    runId: `wta-run-${identity}`,
    workflowId: 'daily',
    stepRunIds: {
      collect: `wta-collect-${identity}`,
      summarize: `wta-summary-${identity}`,
    },
    publication,
    revision: value.revision,
    taskSpecSemanticRegistry: value.registry,
    plannedAtMs: 3_000,
  });
  return { ...value, publication, plan };
}

async function harness(t, namespace, { reconcile = true } = {}) {
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
  if (reconcile) {
    await new LocalSqlitePluginPackageTaskReconciliationRepository(
      client,
      value.registry,
    ).reconcile(value.revision, {
      async findActiveResourceGeneration() {
        return value.revision.generation;
      },
    });
  }
  await new LocalSqlitePluginPackageAutomationPublicationRepository(
    client,
  ).publish(value.publication);
  await new LocalSqlitePluginPackageWorkflowAdmissionRepository(client).admit(
    value.plan,
  );
  t.after(() => client.close());
  return {
    client,
    value,
    repository:
      new LocalSqlitePluginPackageWorkflowTaskAttemptAdmissionRepository(
        client,
      ),
  };
}

test('atomically admits the exact reconciled local Task revision and replays it', async (t) => {
  const { client, value, repository } = await harness(
    t,
    'sqlite-workflow-task-attempt',
  );
  const collect = value.plan.steps.find(({ stepKey }) => stepKey === 'collect');
  assert.ok(collect);
  assert.deepEqual(await repository.listCandidates({ limit: 8 }), {
    candidates: [
      {
        runId: value.plan.runId,
        stepRunId: collect.stepRunId,
        readyAtMs: 3_000,
        planDigest: value.plan.planDigest,
      },
    ],
    truncated: false,
  });

  const created = await repository.admit(value.plan.runId, collect.stepRunId);
  assert.equal(created.status, 'created');
  assert.equal(created.receipt.resourceTaskId, 'alpha');
  assert.equal(created.receipt.taskId, `pkg:${value.packageName}:alpha`);
  assert.match(created.receipt.taskRevision, /^qltd:v1:1:[0-9a-f]{64}$/);
  assert.equal(created.receipt.executorType, 'local_process');
  assert.equal(created.receipt.attemptNumber, 1);
  assert.equal(created.receipt.runVersion, 4);
  assert.deepEqual(
    await createLocalSqliteRunRuntimeCapabilities(
      new LocalSqliteOperationAuthority(client),
    ).dispatch.listLocalDispatchCandidates({ limit: 8 }),
    {
      candidates: [
        {
          runId: value.plan.runId,
          stepRunId: collect.stepRunId,
          projectId: value.projectId,
          taskId: created.receipt.taskId,
          taskRevision: created.receipt.taskRevision,
          attemptId: created.receipt.attemptId,
          attemptNumber: 1,
          executorType: 'local_process',
          priority: 0,
          queuedAtMs: 3_000,
          attemptCreatedAtMs: created.receipt.admittedAtMs,
        },
      ],
      truncated: false,
    },
  );
  assert.deepEqual(
    await repository.admit(value.plan.runId, collect.stepRunId),
    {
      status: 'existing',
      receipt: created.receipt,
    },
  );
  assert.deepEqual(await repository.listCandidates({ limit: 8 }), {
    candidates: [],
    truncated: false,
  });
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM "RunAttempts") AS attempts,
             (SELECT COUNT(*) FROM "RunEvents") AS events,
             (SELECT COUNT(*) FROM
               "QingLong3PluginPackageWorkflowTaskAttemptAdmissions")
               AS admissions,
             run.version AS "runVersion",
             run.event_sequence AS "eventSequence",
             step.status AS "stepStatus",
             step.attempt_count AS "stepAttemptCount"
           FROM "Runs" AS run
           JOIN "StepRuns" AS step
             ON step.run_id = run.id AND step.id = ?
           WHERE run.id = ?`,
        )
        .get(collect.stepRunId, value.plan.runId),
    },
    {
      attempts: 1,
      events: 4,
      admissions: 1,
      runVersion: 4,
      eventSequence: 4,
      stepStatus: 'ready',
      stepAttemptCount: 0,
    },
  );
  assert.equal((await auditLocalSqliteReadiness(client)).contractVersion, 52);
});

test('bounds candidate paging before SQL and fences cancellation', async (t) => {
  const { client, value, repository } = await harness(
    t,
    'sqlite-workflow-task-attempt-fence',
  );
  assert.throws(
    () => repository.listCandidates({ limit: 65 }),
    InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  );
  client
    .prepare(
      `UPDATE "Runs"
       SET cancel_requested_at_ms = ?, cancel_reason = 'user'
       WHERE id = ?`,
    )
    .run(4_000, value.plan.runId);
  assert.deepEqual(await repository.listCandidates({ limit: 8 }), {
    candidates: [],
    truncated: false,
  });
  await assert.rejects(
    repository.admit(value.plan.runId, value.plan.steps[0].stepRunId),
    InvalidPluginPackageWorkflowTaskAttemptAdmissionError,
  );
  assert.equal(
    client.prepare(`SELECT COUNT(*) AS count FROM "RunAttempts"`).get().count,
    0,
  );
});

test('keeps the parent Workflow running while one local Task starts and completes', async (t) => {
  const { client, value, repository } = await harness(
    t,
    'sqlite-workflow-task-local-execution',
  );
  const collect = value.plan.steps.find(({ stepKey }) => stepKey === 'collect');
  assert.ok(collect);
  const admitted = await repository.admit(value.plan.runId, collect.stepRunId);
  const runs = new LocalSqliteRunRepository(client);
  const execution = new LocalSqliteWorkflowTaskExecutionRepository(client);
  const callbackTokenHash = 'a'.repeat(64);
  const startingAtMs = admitted.receipt.admittedAtMs + 1;
  const runningAtMs = startingAtMs + 1;
  const finishedAtMs = runningAtMs + 1;
  assert.equal(
    (
      await execution.prepare({
        runId: value.plan.runId,
        attemptId: admitted.receipt.attemptId,
        stepRunId: collect.stepRunId,
        callbackTokenHash,
        deadlineAtMs: startingAtMs + 1_000,
        logArtifactId: 'local-0123456789abcdef0123456789abcd',
        atMs: startingAtMs,
        eventId: 'local-workflow-starting-event',
      })
    ).status,
    'applied',
  );
  const startingRun = await runs.findRunById(value.plan.runId);
  const startingAttempt = await runs.findAttemptById(
    admitted.receipt.attemptId,
  );
  assert.ok(startingRun);
  assert.ok(startingAttempt);
  assert.equal(
    (
      await execution.recordRunning({
        run: startingRun,
        attempt: startingAttempt,
        callbackTokenHash,
        executorHandle: 'qlp:v1:durable-local-workflow-handle',
        pid: 123,
        startedAtMs: runningAtMs,
        attemptEventId: 'local-workflow-running-attempt',
        stepMutationId: 'local-workflow-running-step',
      })
    ).status,
    'applied',
  );
  const runningRun = await runs.findRunById(value.plan.runId);
  const runningAttempt = await runs.findAttemptById(admitted.receipt.attemptId);
  assert.ok(runningRun);
  assert.ok(runningAttempt);
  assert.equal(
    await execution.complete({
      run: runningRun,
      attempt: runningAttempt,
      callbackSequence: 1,
      startedAtMs: runningAtMs,
      finishedAtMs,
      exitCode: 0,
      terminalStatus: 'succeeded',
      attemptEventId: 'local-workflow-completed-attempt',
      syntheticStartMutationId: 'unused-synthetic-start',
      terminalStepMutationId: 'local-workflow-completed-step',
    }),
    'completed',
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT run.status AS "runStatus",
                  attempt.status AS "attemptStatus",
                  attempt.callback_sequence AS "callbackSequence",
                  step.status AS "stepStatus",
                  step.attempt_count AS "stepAttemptCount"
           FROM "Runs" AS run
           JOIN "RunAttempts" AS attempt
             ON attempt.run_id = run.id AND attempt.id = ?
           JOIN "StepRuns" AS step
             ON step.run_id = run.id AND step.id = ?
           WHERE run.id = ?`,
        )
        .get(admitted.receipt.attemptId, collect.stepRunId, value.plan.runId),
    },
    {
      runStatus: 'running',
      attemptStatus: 'succeeded',
      callbackSequence: 1,
      stepStatus: 'succeeded',
      stepAttemptCount: 1,
    },
  );
});

test('times out one local Workflow Task without cancelling its parent Run', async (t) => {
  const { client, value, repository } = await harness(
    t,
    'sqlite-workflow-task-local-timeout',
  );
  const collect = value.plan.steps[0];
  const admitted = await repository.admit(value.plan.runId, collect.stepRunId);
  const runs = new LocalSqliteRunRepository(client);
  const execution = new LocalSqliteWorkflowTaskExecutionRepository(client);
  const callbackTokenHash = 'b'.repeat(64);
  const startingAtMs = admitted.receipt.admittedAtMs + 1;
  const deadlineAtMs = startingAtMs + 10;
  await execution.prepare({
    runId: value.plan.runId,
    attemptId: admitted.receipt.attemptId,
    stepRunId: collect.stepRunId,
    callbackTokenHash,
    deadlineAtMs,
    atMs: startingAtMs,
    eventId: 'local-workflow-timeout-starting',
  });
  let run = await runs.findRunById(value.plan.runId);
  let attempt = await runs.findAttemptById(admitted.receipt.attemptId);
  assert.ok(run);
  assert.ok(attempt);
  await execution.recordRunning({
    run,
    attempt,
    callbackTokenHash,
    executorHandle: 'qlp:v1:timeout-workflow-handle',
    pid: 124,
    startedAtMs: startingAtMs + 1,
    attemptEventId: 'local-workflow-timeout-running-attempt',
    stepMutationId: 'local-workflow-timeout-running-step',
  });
  run = await runs.findRunById(value.plan.runId);
  attempt = await runs.findAttemptById(admitted.receipt.attemptId);
  assert.ok(run);
  assert.ok(attempt);
  assert.equal(
    await execution.requestTimeout({
      run,
      attempt,
      dueAtMs: deadlineAtMs,
      eventId: 'local-workflow-timeout-requested',
    }),
    'requested',
  );
  run = await runs.findRunById(value.plan.runId);
  attempt = await runs.findAttemptById(admitted.receipt.attemptId);
  assert.ok(run);
  assert.ok(attempt);
  assert.equal(
    await execution.recordControlTerminal({
      run,
      attempt,
      reason: 'timeout',
      terminalStatus: 'timed_out',
      errorCode: 'EXECUTION_TIMED_OUT',
      errorSummary: 'Execution exceeded its configured timeout',
      finishedAtMs: deadlineAtMs + 1,
      attemptEventId: 'local-workflow-timeout-terminal-attempt',
      stepMutationId: 'local-workflow-timeout-terminal-step',
    }),
    'terminal',
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT run.status AS "runStatus",
                  run.cancel_requested_at_ms AS "cancelRequestedAtMs",
                  attempt.status AS "attemptStatus",
                  step.status AS "stepStatus"
           FROM "Runs" AS run
           JOIN "RunAttempts" AS attempt
             ON attempt.run_id = run.id AND attempt.id = ?
           JOIN "StepRuns" AS step
             ON step.run_id = run.id AND step.id = ?
           WHERE run.id = ?`,
        )
        .get(admitted.receipt.attemptId, collect.stepRunId, value.plan.runId),
    },
    {
      runStatus: 'running',
      cancelRequestedAtMs: null,
      attemptStatus: 'timed_out',
      stepStatus: 'timed_out',
    },
  );
});

test('requeues one orphaned claimed Workflow Task at a fresh Step epoch', async (t) => {
  const { client, value, repository } = await harness(
    t,
    'sqlite-workflow-task-local-recovery',
  );
  const collect = value.plan.steps[0];
  const admitted = await repository.admit(value.plan.runId, collect.stepRunId);
  const runs = new LocalSqliteRunRepository(client);
  const recovery = new LocalSqliteWorkflowTaskExecutionRepository(client);
  assert.deepEqual(await recovery.listRecoveryCandidates({ limit: 8 }), {
    candidates: [
      {
        runId: value.plan.runId,
        attemptId: admitted.receipt.attemptId,
        attemptCreatedAtMs: admitted.receipt.admittedAtMs,
      },
    ],
    truncated: false,
  });
  const run = await runs.findRunById(value.plan.runId);
  const attempt = await runs.findAttemptById(admitted.receipt.attemptId);
  assert.ok(run);
  assert.ok(attempt);
  assert.equal(
    await recovery.recover({
      run,
      attempt,
      reason: 'unstarted_claim_expired',
      observedAtMs: admitted.receipt.admittedAtMs + 1,
    }),
    'requeued',
  );
  assert.equal((await runs.findRunById(value.plan.runId)).status, 'running');
  assert.equal(
    (await runs.findAttemptById(admitted.receipt.attemptId)).status,
    'lost',
  );
  const refreshed = await repository.listCandidates({ limit: 8 });
  assert.equal(refreshed.candidates.length, 1);
  assert.equal(refreshed.candidates[0].stepRunId, collect.stepRunId);
  const second = await repository.admit(value.plan.runId, collect.stepRunId);
  assert.equal(second.status, 'created');
  assert.equal(second.receipt.attemptNumber, 2);
  assert.notEqual(second.receipt.attemptId, admitted.receipt.attemptId);
});

test('rolls back when the exact generation has no reconciled execution revision', async (t) => {
  const { client, value, repository } = await harness(
    t,
    'sqlite-workflow-task-attempt-unreconciled',
    { reconcile: false },
  );
  await assert.rejects(
    repository.admit(value.plan.runId, value.plan.steps[0].stepRunId),
    PluginPackageWorkflowTaskAttemptAdmissionConflictError,
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT version, event_sequence AS "eventSequence",
                  (SELECT COUNT(*) FROM "RunAttempts") AS attempts
           FROM "Runs" WHERE id = ?`,
        )
        .get(value.plan.runId),
    },
    { version: 3, eventSequence: 3, attempts: 0 },
  );
});

test('fails closed on receipt drift and publishes only an explicit subpath', async (t) => {
  const { client, value, repository } = await harness(
    t,
    'sqlite-workflow-task-attempt-drift',
  );
  const stepRunId = value.plan.steps[0].stepRunId;
  await repository.admit(value.plan.runId, stepRunId);
  client.exec('PRAGMA ignore_check_constraints = ON');
  client
    .prepare(
      `UPDATE "QingLong3PluginPackageWorkflowTaskAttemptAdmissions"
       SET receipt_json = json_set(receipt_json, '$.taskId', 'drift')
       WHERE run_id = ? AND step_run_id = ?`,
    )
    .run(value.plan.runId, stepRunId);
  await assert.rejects(
    repository.admit(value.plan.runId, stepRunId),
    PluginPackageWorkflowTaskAttemptAdmissionUnavailableError,
  );

  const subpath = require('@qinglong/local-sqlite/plugin-package-workflow-task-attempt-admission');
  const root = require('../dist');
  assert.equal(
    subpath.LocalSqlitePluginPackageWorkflowTaskAttemptAdmissionRepository,
    LocalSqlitePluginPackageWorkflowTaskAttemptAdmissionRepository,
  );
  assert.equal(
    root.LocalSqlitePluginPackageWorkflowTaskAttemptAdmissionRepository,
    undefined,
  );
});

test('converges a cancelling local Workflow in bounded per-Run transactions', async (t) => {
  const { client, value, repository } = await harness(
    t,
    'sqlite-workflow-cancellation',
  );
  const collect = value.plan.steps.find(({ stepKey }) => stepKey === 'collect');
  assert.ok(collect);
  await repository.admit(value.plan.runId, collect.stepRunId);
  client
    .prepare(
      `UPDATE "Runs"
       SET cancel_requested_at_ms = ?, cancel_reason = 'user'
       WHERE id = ? AND status = 'running'`,
    )
    .run(4_000, value.plan.runId);

  const cancellation =
    new LocalSqlitePluginPackageWorkflowCancellationConvergenceRepository(
      client,
    );
  assert.deepEqual(await cancellation.convergePage({ limit: 8 }), {
    scanned: 1,
    settledRuns: 1,
    settledAttempts: 1,
    blocked: 0,
    hasMore: false,
  });
  assert.deepEqual(
    {
      ...client
        .prepare(
          `SELECT status, version,
                  event_sequence AS "eventSequence",
                  (SELECT group_concat(status, ',')
                     FROM (
                       SELECT DISTINCT status FROM "RunAttempts"
                       WHERE run_id = run.id ORDER BY status
                     )) AS "attemptStatuses",
                  (SELECT group_concat(status, ',')
                     FROM (
                       SELECT DISTINCT status FROM "StepRuns"
                       WHERE run_id = run.id ORDER BY status
                     )) AS "stepStatuses",
                  (SELECT group_concat(type, ',')
                     FROM (
                       SELECT type FROM "RunEvents"
                       WHERE run_id = run.id AND sequence >= 4
                       ORDER BY sequence
                     )) AS events
           FROM "Runs" AS run WHERE id = ?`,
        )
        .get(value.plan.runId),
    },
    {
      status: 'cancelled',
      version: 8,
      eventSequence: 8,
      attemptStatuses: 'cancelled',
      stepStatuses: 'cancelled',
      events: [
        'workflow.task_attempt_admitted',
        'workflow.task_attempt.cancelled',
        'step.cancelled',
        'step.cancelled',
        'workflow.cancelled',
      ].join(','),
    },
  );
  assert.deepEqual(await cancellation.convergePage({ limit: 8 }), {
    scanned: 0,
    settledRuns: 0,
    settledAttempts: 0,
    blocked: 0,
    hasMore: false,
  });

  const subpath = require('@qinglong/local-sqlite/plugin-package-workflow-cancellation-convergence');
  const root = require('../dist');
  assert.equal(
    subpath.LocalSqlitePluginPackageWorkflowCancellationConvergenceRepository,
    LocalSqlitePluginPackageWorkflowCancellationConvergenceRepository,
  );
  assert.equal(
    root.LocalSqlitePluginPackageWorkflowCancellationConvergenceRepository,
    undefined,
  );
});
