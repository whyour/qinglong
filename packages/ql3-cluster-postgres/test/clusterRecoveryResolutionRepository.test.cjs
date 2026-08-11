const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PostgresClusterControlRecoveryResolutionRepository,
} = require('../dist');
const {
  pluginPackageWorkflowTaskAttemptAdmissionReceiptDigest,
} = require('@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission');
const {
  createStepRunRecord,
} = require('@qinglong/runtime-core/step-run');

const RUN_ID = '019f70b0-0000-7000-8000-000000000101';
const ATTEMPT_ID = '019f70b0-0000-7000-8000-000000000102';
const STEP_RUN_ID = '019f70b0-0000-7000-8000-000000000103';

function workflowStepRun() {
  return createStepRunRecord({
    id: STEP_RUN_ID,
    runId: RUN_ID,
    stepKey: 'collect',
    kind: 'task',
    definitionRef: 'pkg:demo:alpha',
    definitionDigest: 'a'.repeat(64),
    required: true,
    initialStatus: 'ready',
    mutationId: '019f70b0-0000-7000-8000-000000000104',
    createdAtMs: 300,
  });
}

function workflowAdmission(stepRun) {
  const unsigned = {
    schema:
      'qinglong/plugin-package-workflow-task-attempt-admission@v1',
    attemptId: ATTEMPT_ID,
    planDigest: 'c'.repeat(64),
    runId: RUN_ID,
    stepRunId: STEP_RUN_ID,
    stepRunVersion: stepRun.version,
    stepRunDigest: stepRun.stepRunDigest,
    resourceTaskId: 'alpha',
    taskReconciliationReceiptDigest: 'd'.repeat(64),
    taskId: 'pkg:demo:alpha',
    taskRevision: `qltd:v1:1:${'a'.repeat(64)}`,
    taskDefinitionDigest: 'a'.repeat(64),
    executorType: 'remote_worker',
    executionDigest: 'e'.repeat(64),
    attemptNumber: 1,
    eventId: '019f70b0-0000-7000-8000-000000000105',
    runVersion: 3,
    runEventSequence: 3,
    admittedAtMs: 400,
  };
  return {
    ...unsigned,
    receiptDigest:
      pluginPackageWorkflowTaskAttemptAdmissionReceiptDigest(unsigned),
  };
}

function claim() {
  return {
    candidate: {
      kind: 'attempt',
      id: ATTEMPT_ID,
      runId: RUN_ID,
      status: 'claimed',
      createdAtMs: 200,
    },
    observedAtMs: 1000,
    ownerId: 'replica-a',
    token: '00000000-0000-4000-8000-000000000001',
    version: 1,
    expiresAtMs: 31000,
  };
}

function runRow(overrides = {}) {
  return {
    id: RUN_ID,
    projectId: 'default',
    taskId: 'task-1',
    taskRevision: 'v1',
    taskName: null,
    taskSnapshotRef: null,
    legacyCronId: null,
    parentRunId: null,
    retryOfRunId: null,
    triggerId: null,
    triggerType: 'manual',
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    triggeredBy: null,
    requestId: null,
    scheduledForMs: null,
    status: 'dispatching',
    version: 1,
    eventSequence: 0,
    priority: 0,
    idempotencyKey: null,
    inputRef: null,
    outputRef: null,
    createdAtMs: '100',
    queuedAtMs: null,
    startedAtMs: null,
    finishedAtMs: null,
    cancelRequestedAtMs: null,
    cancelReason: null,
    errorCode: null,
    errorSummary: null,
    ...overrides,
  };
}

function attemptRow(overrides = {}) {
  return {
    id: ATTEMPT_ID,
    runId: RUN_ID,
    stepRunId: null,
    attempt: 1,
    status: 'claimed',
    executorType: 'worker',
    workerId: 'worker-1',
    executorHandle: null,
    pid: null,
    logArtifactId: null,
    leaseToken: 'lease-token',
    leaseExpiresAtMs: '900',
    deadlineAtMs: null,
    callbackTokenHash: null,
    callbackSequence: 0,
    createdAtMs: '200',
    startedAtMs: null,
    finishedAtMs: null,
    exitCode: null,
    errorCode: null,
    errorSummary: null,
    ...overrides,
  };
}

function harness(options = {}) {
  const queries = [];
  let released = 0;
  let runUpdates = 0;
  const client = {
    async query(text, values = []) {
      queries.push({ text, values });
      if (text.includes('run_recovery_controls')) {
        return options.fenced
          ? { rows: [], rowCount: 0 }
          : { rows: [{ observedAtMs: '1000' }], rowCount: 1 };
      }
      if (text.includes('FROM "ql3"."runs"')) {
        return {
          rows: [
            runRow(
              options.workflowTask
                ? {
                    taskId: 'workflow-alpha',
                    taskRevision: 'b'.repeat(64),
                    triggerType: 'plugin_package_workflow',
                    executionOrigin: 'system',
                    requestId: 'workflow-plan-1',
                    idempotencyKey:
                      'plugin-package-workflow:workflow-plan-1',
                    status: 'running',
                    version: 5,
                    eventSequence: 5,
                    startedAtMs: '200',
                  }
                : {},
            ),
          ],
          rowCount: 1,
        };
      }
      if (text.includes('FROM "ql3"."run_attempts"')) {
        return {
          rows: [
            attemptRow(
              {
                ...(options.workflowTask
                  ? {
                    stepRunId: STEP_RUN_ID,
                    executorType: 'remote_worker',
                    createdAtMs: '400',
                  }
                  : {}),
                ...(options.leased
                  ? {
                      workerSessionId:
                        '019f70b0-0000-7000-8000-000000000201',
                      workerGeneration: 2,
                      leaseTokenDigest: 'f'.repeat(64),
                      leaseGeneration: 3,
                      leaseVersion: 7,
                      offerId: 'offer-1',
                    }
                  : {}),
              },
            ),
          ],
          rowCount: 1,
        };
      }
      if (
        text.includes(
          'plugin_package_workflow_task_attempt_admissions',
        )
      ) {
        return options.workflowTask
          ? {
              rows: [{
                admissionJson: options.workflowTask.admission,
                stepRunJson: options.workflowTask.stepRun,
              }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (text.startsWith('UPDATE "ql3"."runs"')) {
        runUpdates += 1;
        return { rows: [{ id: RUN_ID }], rowCount: 1 };
      }
      if (text.startsWith('UPDATE "ql3"."run_attempts"')) {
        return options.attemptConflict
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: ATTEMPT_ID }], rowCount: 1 };
      }
      if (text.startsWith('UPDATE "ql3"."run_dispatch_leases"')) {
        return options.leaseConflict
          ? { rows: [], rowCount: 0 }
          : { rows: [], rowCount: 1 };
      }
      if (text.startsWith('UPDATE "ql3"."step_runs"')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('INSERT INTO "ql3"."run_events"')) {
        return { rows: [], rowCount: 1 };
      }
      if (
        text.startsWith(
          'INSERT INTO "ql3"."step_run_mutations"',
        )
      ) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      released += 1;
    },
  };
  return {
    queries,
    released: () => released,
    runUpdates: () => runUpdates,
    pool: {
      async connect() {
        return client;
      },
      query: (...args) => client.query(...args),
    },
  };
}

test('loads only under a live claim fence and returns a normalized snapshot', async () => {
  const database = harness();
  const repository = new PostgresClusterControlRecoveryResolutionRepository(
    database.pool,
  );
  const loaded = await repository.load(claim());

  assert.equal(loaded.observedAtMs, 1000);
  assert.equal(loaded.run.status, 'dispatching');
  assert.equal(loaded.attempt.status, 'claimed');
  assert.equal(loaded.attempt.leaseExpiresAtMs, 900);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(database.queries[4].text.includes('FOR UPDATE'), false);
  assert.equal(database.queries.at(-1).text, 'COMMIT');
  assert.equal(database.released(), 1);
});

test('locks the claim and commits both lost transitions and events atomically', async () => {
  const database = harness();
  let event = 0;
  const repository = new PostgresClusterControlRecoveryResolutionRepository(
    database.pool,
    () => `00000000-0000-4000-8000-${String(++event).padStart(12, '0')}`,
  );
  const loaded = await repository.load(claim());
  assert.equal(
    await repository.applyLost(claim(), loaded, {
      kind: 'mark_attempt_and_run_lost',
      reason: 'unstarted_claim_expired',
    }),
    'applied',
  );

  const applyQueries = database.queries.slice(8);
  assert.equal(
    applyQueries.some(({ text }) => text.includes('FOR UPDATE OF control')),
    true,
  );
  assert.equal(
    applyQueries.filter(({ text }) => text.startsWith('UPDATE "ql3"."runs"'))
      .length,
    2,
  );
  assert.equal(
    applyQueries.filter(({ text }) =>
      text.startsWith('UPDATE "ql3"."run_attempts"'),
    ).length,
    1,
  );
  const events = applyQueries.filter(({ text }) =>
    text.startsWith('INSERT INTO "ql3"."run_events"'),
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].values.includes('reconciler'), true);
  assert.equal(events[0].values.includes('replica-a'), true);
  assert.equal(applyQueries.at(-1).text, 'COMMIT');
});

test('releases an expired dispatch lease under the same Attempt authority transaction', async () => {
  const database = harness({ leased: true });
  const repository = new PostgresClusterControlRecoveryResolutionRepository(
    database.pool,
  );
  const loaded = await repository.load(claim());

  assert.equal(
    await repository.applyLost(claim(), loaded, {
      kind: 'mark_attempt_and_run_lost',
      reason: 'unstarted_claim_expired',
    }),
    'applied',
  );
  const leaseUpdate = database.queries.find(({ text }) =>
    text.startsWith('UPDATE "ql3"."run_dispatch_leases"'),
  );
  assert.ok(leaseUpdate);
  assert.deepEqual(leaseUpdate.values, [
    ATTEMPT_ID,
    8,
    1000,
    7,
    3,
  ]);
  const attemptUpdate = database.queries.find(({ text }) =>
    text.startsWith('UPDATE "ql3"."run_attempts"'),
  );
  assert.equal(attemptUpdate.values.includes(8), true);
  assert.equal(database.queries.at(-1).text, 'COMMIT');
});

test('atomically loses and requeues one admission-bound Workflow Task epoch', async () => {
  const stepRun = workflowStepRun();
  const database = harness({
    workflowTask: {
      admission: workflowAdmission(stepRun),
      stepRun,
    },
  });
  const repository =
    new PostgresClusterControlRecoveryResolutionRepository(database.pool);
  const loaded = await repository.load(claim());
  assert.equal(loaded.workflowTask.admission.attemptId, ATTEMPT_ID);
  assert.equal(loaded.workflowTask.stepRun.status, 'ready');

  assert.equal(
    await repository.applyLost(claim(), loaded, {
      kind: 'recover_workflow_task',
      reason: 'unstarted_claim_expired',
    }),
    'applied',
  );

  const runUpdate = database.queries.find(
    ({ text, values }) =>
      text.startsWith('UPDATE "ql3"."runs"') &&
      values[0] === RUN_ID &&
      values.length === 5,
  );
  assert.ok(runUpdate);
  assert.deepEqual(runUpdate.values.slice(1), [7, 7, 5, 5]);
  const attemptUpdate = database.queries.find(({ text }) =>
    text.startsWith('UPDATE "ql3"."run_attempts"'));
  assert.ok(attemptUpdate);
  assert.equal(attemptUpdate.values.includes('lost'), true);
  const stepUpdate = database.queries.find(({ text }) =>
    text.startsWith('UPDATE "ql3"."step_runs"'));
  assert.ok(stepUpdate);
  assert.equal(stepUpdate.values[0], 'ready');
  assert.equal(stepUpdate.values[1], stepRun.version + 1);
  assert.notEqual(stepUpdate.values[12], stepRun.stepRunDigest);
  const events = database.queries.filter(({ text }) =>
    text.startsWith('INSERT INTO "ql3"."run_events"'));
  assert.equal(events.length, 2);
  assert.equal(
    database.queries.filter(({ text }) =>
      text.startsWith('INSERT INTO "ql3"."step_run_mutations"'),
    ).length,
    1,
  );
  assert.equal(database.queries.at(-1).text, 'COMMIT');
});

test('rolls back partial CAS work and reports a stale aggregate', async () => {
  const database = harness({ attemptConflict: true });
  const repository = new PostgresClusterControlRecoveryResolutionRepository(
    database.pool,
  );
  const loaded = await repository.load(claim());
  assert.equal(
    await repository.applyLost(claim(), loaded, {
      kind: 'mark_attempt_and_run_lost',
      reason: 'unstarted_claim_expired',
    }),
    'stale',
  );
  assert.equal(database.runUpdates(), 1);
  assert.equal(database.queries.at(-1).text, 'ROLLBACK');
});

test('does not read or mutate Run state after the recovery fence is lost', async () => {
  const database = harness({ fenced: true });
  const repository = new PostgresClusterControlRecoveryResolutionRepository(
    database.pool,
  );
  assert.equal(await repository.load(claim()), 'fenced');
  assert.equal(
    database.queries.some(({ text }) => text.includes('FROM "ql3"."runs"')),
    false,
  );
});
