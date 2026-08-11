require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { QueryTypes, Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const { runSchemaMigration } = require('../../back/migrations/0002-run-schema');
const {
  runCancellationRequestMigration,
} = require('../../back/migrations/0004-run-cancellation-request');
const {
  runAttemptDeadlineMigration,
} = require('../../back/migrations/0006-run-attempt-deadline');
const {
  runRetryPolicyMigration,
} = require('../../back/migrations/0011-run-retry-policy');
const {
  projectPolicyMigration,
} = require('../../back/migrations/0017-project-policy');
const {
  approvalRequestMigration,
} = require('../../back/migrations/0020-approval-requests');
const {
  approvedActionDispatchExecutionMigration,
} = require('../../back/migrations/0021-approved-action-dispatch-executions');
const {
  approvedActionRecoveryMigration,
} = require('../../back/migrations/0022-approved-action-recovery');
const {
  APPROVED_RUN_ACTION_RECEIPT_PROJECT_INDEX,
  APPROVED_RUN_ACTION_RECEIPT_RESOURCE_UNIQUE_INDEX,
  APPROVED_RUN_ACTION_RECEIPT_TABLE,
  approvedRunActionReceiptMigration,
} = require('../../back/migrations/0023-approved-run-action-receipts');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeApprovedActionDispatchRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/approvedActionDispatchRepository');
const {
  LegacySequelizeApprovedActionRecoveryRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/approvedActionRecoveryRepository');
const {
  LegacySequelizeApprovedRunActionRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/approvedRunActionRepository');
const {
  LegacySequelizeApprovedRunRecoveryEvidenceProvider,
} = require('../../back/runtime/adapters/legacy-sequelize/approvedRunRecoveryEvidenceProvider');
const {
  LegacySequelizeApprovalRequestRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/approvalRequestRepository');
const {
  LegacySequelizeProjectPolicyRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/projectPolicyRepository');
const {
  LegacySequelizeRunRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/runRepository');
const {
  ApprovedActionDispatcher,
} = require('../../back/runtime/application/approvedActionDispatcher');
const {
  ApprovedActionRecoveryReconciler,
} = require('../../back/runtime/application/approvedActionRecoveryReconciler');
const {
  ApprovedRunActionHandler,
} = require('../../back/runtime/application/approvedRunActionHandler');
const {
  ApprovalRequestService,
} = require('../../back/runtime/application/approvalRequestService');
const {
  PrimaryRunCreator,
} = require('../../back/runtime/application/primaryRunCreator');
const {
  ProjectPolicyEngine,
} = require('../../back/runtime/application/projectPolicyEngine');
const {
  ApprovedRunActionBindingConflictError,
  ApprovedRunActionRepositoryError,
  InvalidApprovedRunActionError,
  digestApprovedRunCreationPlan,
  normalizeApprovedRunCreationPlan,
} = require('../../back/runtime/domain/approvedRunAction');

const PROJECT_ID = 'default';
const AGENT = Object.freeze({ type: 'agent', id: 'agent-1' });
const OWNER = Object.freeze({ type: 'user', id: 'owner-1' });
const SYSTEM = Object.freeze({ type: 'system', id: 'approval-dispatcher' });
const BASE_TIME = 200_000;

function plan(name = 'one') {
  return {
    schemaVersion: 1,
    actionRef: `approved-run-${name}`,
    projectId: PROJECT_ID,
    taskId: `task-${name}`,
    taskRevision: `revision-${name}`,
    executorType: 'local_process',
    priority: 3,
    taskName: `Task ${name}`,
    taskSnapshotRef: `task-snapshot:${name}`,
    inputRef: `input:${name}`,
  };
}

async function migrate(database) {
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [
      runSchemaMigration,
      runCancellationRequestMigration,
      runAttemptDeadlineMigration,
      runRetryPolicyMigration,
      projectPolicyMigration,
      approvalRequestMigration,
      approvedActionDispatchExecutionMigration,
      approvedActionRecoveryMigration,
      approvedRunActionReceiptMigration,
    ],
    logger: { info() {} },
  });
}

async function bind(repository, subject, role, mutationId) {
  await repository.append({
    expectedCurrentVersion: 0,
    binding: {
      projectId: PROJECT_ID,
      subject,
      version: 1,
      state: 'active',
      role,
      mutationId,
      changedBy: OWNER,
      createdAtMs: BASE_TIME - 100,
    },
  });
}

async function setup(t) {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  await migrate(database);
  const policy = new LegacySequelizeProjectPolicyRepository(database);
  await bind(policy, OWNER, 'owner', 'bind-owner');
  await bind(policy, AGENT, 'operator', 'bind-agent');
  const approvals = new ApprovalRequestService(
    new LegacySequelizeApprovalRequestRepository(database),
    new ProjectPolicyEngine(policy),
  );
  return {
    database,
    approvals,
    executions: new LegacySequelizeApprovedActionDispatchRepository(database),
  };
}

async function prepareApprovedRun(
  setupResult,
  name,
  approvedPlan = plan(name),
) {
  const actionDigest = digestApprovedRunCreationPlan(approvedPlan);
  const action = {
    permission: 'run.start',
    actionType: 'run.create',
    actionRef: approvedPlan.actionRef,
    actionDigest,
    previewDigest: 'f'.repeat(64),
  };
  const requestedAtMs = BASE_TIME + 100;
  await setupResult.approvals.create({
    id: `approval-${name}`,
    projectId: PROJECT_ID,
    action,
    risk: 'high',
    requestedBy: AGENT,
    requestedAtMs,
    expiresAtMs: requestedAtMs + 60_000,
  });
  await setupResult.approvals.decide({
    requestId: `approval-${name}`,
    expectedVersion: 1,
    decisionId: `decision-${name}`,
    decision: 'approved',
    reasonCode: 'reviewed_action',
    decidedBy: OWNER,
    decidedAtMs: requestedAtMs + 10,
  });
  const consumed = await setupResult.approvals.consume({
    requestId: `approval-${name}`,
    expectedVersion: 2,
    consumptionId: `consumption-${name}`,
    dispatchId: `dispatch-${name}`,
    action,
    requestedBy: AGENT,
    consumedBy: SYSTEM,
    consumedAtMs: requestedAtMs + 20,
  });
  return consumed.dispatch;
}

async function startApprovedRun(setupResult, name, approvedPlan = plan(name)) {
  const dispatch = await prepareApprovedRun(setupResult, name, approvedPlan);
  const claimed = await setupResult.executions.claim({
    dispatchId: dispatch.id,
    owner: 'dispatcher-1',
    leaseToken: `lease-${name}`,
    nowMs: BASE_TIME + 130,
    leaseDurationMs: 1_000,
  });
  assert.equal(claimed.status, 'claimed');
  return setupResult.executions.start({
    dispatchId: dispatch.id,
    approvalRequestId: dispatch.approvalRequestId,
    actionDigest: dispatch.action.actionDigest,
    owner: 'dispatcher-1',
    leaseToken: `lease-${name}`,
    expectedVersion: claimed.snapshot.execution.version,
    startedAtMs: BASE_TIME + 140,
  });
}

function recoveryContext(snapshot) {
  return {
    snapshot: { action: snapshot },
    idempotencyKey: snapshot.dispatch.id,
    observedAtMs: BASE_TIME + 10_000,
  };
}

test('canonical Run action plans are exact-shape and digest-stable', () => {
  const first = plan('canonical');
  const reordered = {
    inputRef: first.inputRef,
    priority: first.priority,
    executorType: first.executorType,
    taskRevision: first.taskRevision,
    taskId: first.taskId,
    projectId: first.projectId,
    actionRef: first.actionRef,
    schemaVersion: first.schemaVersion,
    taskSnapshotRef: first.taskSnapshotRef,
    taskName: first.taskName,
  };
  assert.equal(
    digestApprovedRunCreationPlan(first),
    digestApprovedRunCreationPlan(reordered),
  );
  assert.throws(
    () => normalizeApprovedRunCreationPlan({ ...first, hidden: true }),
    InvalidApprovedRunActionError,
  );
});

test('0023 owns bounded receipt indexes and enforces immutable tuple checks', async (t) => {
  const state = await setup(t);
  const { database } = state;
  const indexes = await database
    .getQueryInterface()
    .showIndex(APPROVED_RUN_ACTION_RECEIPT_TABLE);
  assert.ok(
    indexes.some(
      (index) => index.name === APPROVED_RUN_ACTION_RECEIPT_PROJECT_INDEX,
    ),
  );
  assert.ok(
    indexes.some(
      (index) =>
        index.name === APPROVED_RUN_ACTION_RECEIPT_RESOURCE_UNIQUE_INDEX &&
        index.unique,
    ),
  );
  const approvedPlan = plan('constraints');
  const snapshot = await startApprovedRun(state, 'constraints', approvedPlan);
  await new LegacySequelizeApprovedRunActionRepository(database, {
    clock: () => snapshot.execution.startedAtMs + 5,
  }).create({ snapshot, plan: approvedPlan });
  await assert.rejects(
    database.query(
      `UPDATE "${APPROVED_RUN_ACTION_RECEIPT_TABLE}"
          SET outcome = 'failed'
        WHERE dispatch_id = :dispatchId`,
      { replacements: { dispatchId: snapshot.dispatch.id } },
    ),
  );
  await assert.rejects(
    database.query(
      `UPDATE "${APPROVED_RUN_ACTION_RECEIPT_TABLE}"
          SET idempotency_key = 'different-dispatch'
        WHERE dispatch_id = :dispatchId`,
      { replacements: { dispatchId: snapshot.dispatch.id } },
    ),
  );
  await assert.rejects(
    database.query(
      `UPDATE "${APPROVED_RUN_ACTION_RECEIPT_TABLE}"
          SET created_at_ms = finished_at_ms + 1
        WHERE dispatch_id = :dispatchId`,
      { replacements: { dispatchId: snapshot.dispatch.id } },
    ),
  );
});

test('handler atomically creates one queued Run and a fully bound receipt', async (t) => {
  const state = await setup(t);
  const approvedPlan = plan('atomic');
  const snapshot = await startApprovedRun(state, 'atomic', approvedPlan);
  const repository = new LegacySequelizeApprovedRunActionRepository(
    state.database,
    {
      clock: () => snapshot.execution.startedAtMs + 5,
      createId: (() => {
        const ids = [
          '019f8000-0000-7000-8000-000000000001',
          '019f8000-0000-7000-8000-000000000002',
          '019f8000-0000-7000-8000-000000000003',
          '019f8000-0000-7000-8000-000000000004',
        ];
        return () => ids.shift();
      })(),
    },
  );
  const resolver = {
    async resolve() {
      return approvedPlan;
    },
  };
  const handler = new ApprovedRunActionHandler(resolver, repository);
  const inspection = await handler.inspect(snapshot.dispatch);
  assert.deepEqual(inspection, {
    status: 'ready',
    actionDigest: snapshot.dispatch.action.actionDigest,
  });
  const context = {
    dispatch: snapshot.dispatch,
    execution: snapshot.execution,
    idempotencyKey: snapshot.dispatch.id,
    fence: {
      owner: snapshot.execution.leaseOwner,
      leaseToken: snapshot.execution.leaseToken,
      version: snapshot.execution.version,
    },
  };
  assert.deepEqual(await handler.execute(context), {
    outcome: 'succeeded',
    resultCode: 'approved_run_created',
  });
  assert.deepEqual(await handler.execute(context), {
    outcome: 'succeeded',
    resultCode: 'approved_run_created',
  });

  const runs = await state.database.query('SELECT * FROM "Runs"', {
    type: QueryTypes.SELECT,
  });
  const receipts = await state.database.query(
    `SELECT * FROM "${APPROVED_RUN_ACTION_RECEIPT_TABLE}"`,
    { type: QueryTypes.SELECT },
  );
  assert.equal(runs.length, 1);
  assert.equal(receipts.length, 1);
  assert.equal(runs[0].status, 'queued');
  assert.equal(runs[0].idempotency_key, snapshot.dispatch.id);
  assert.equal(runs[0].request_id, snapshot.dispatch.approvalRequestId);
  assert.equal(receipts[0].resource_id, runs[0].id);
  assert.equal(receipts[0].execution_attempt, snapshot.execution.attemptCount);
  assert.equal(receipts[0].execution_version, snapshot.execution.version);
  assert.equal(receipts[0].started_at_ms, snapshot.execution.startedAtMs);
});

test('receipt insertion failure rolls the Run aggregate back with it', async (t) => {
  const state = await setup(t);
  const approvedPlan = plan('rollback');
  const snapshot = await startApprovedRun(state, 'rollback', approvedPlan);
  await state.database.query(
    `CREATE TRIGGER reject_approved_run_receipt
       BEFORE INSERT ON "${APPROVED_RUN_ACTION_RECEIPT_TABLE}"
       BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END`,
  );
  const repository = new LegacySequelizeApprovedRunActionRepository(
    state.database,
    { clock: () => snapshot.execution.startedAtMs + 5 },
  );
  await assert.rejects(
    repository.create({ snapshot, plan: approvedPlan }),
    ApprovedRunActionRepositoryError,
  );
  assert.equal(
    (
      await state.database.query('SELECT id FROM "Runs"', {
        type: QueryTypes.SELECT,
      })
    ).length,
    0,
  );
  assert.equal(
    (
      await state.database.query(
        'SELECT dispatch_id FROM "ApprovedRunActionReceipts"',
        {
          type: QueryTypes.SELECT,
        },
      )
    ).length,
    0,
  );
});

test('atomic creation accepts same-fence renew and records the current version', async (t) => {
  const state = await setup(t);
  const approvedPlan = plan('renewed');
  const started = await startApprovedRun(state, 'renewed', approvedPlan);
  const renewed = await state.executions.renew({
    dispatchId: started.dispatch.id,
    owner: started.execution.leaseOwner,
    leaseToken: started.execution.leaseToken,
    expectedVersion: started.execution.version,
    nowMs: started.execution.startedAtMs + 10,
    leaseDurationMs: 1_000,
  });
  const repository = new LegacySequelizeApprovedRunActionRepository(
    state.database,
    { clock: () => started.execution.startedAtMs + 20 },
  );
  await repository.create({ snapshot: started, plan: approvedPlan });
  const [receipt] = await state.database.query(
    `SELECT execution_version FROM "${APPROVED_RUN_ACTION_RECEIPT_TABLE}"`,
    { type: QueryTypes.SELECT },
  );
  assert.equal(receipt.execution_version, renewed.execution.version);
  const provider = new LegacySequelizeApprovedRunRecoveryEvidenceProvider(
    state.database,
  );
  assert.equal(
    (await provider.inspect(recoveryContext(renewed))).finding,
    'verified_succeeded',
  );
});

test('terminal resolution fences stale handler context before any Run write', async (t) => {
  const state = await setup(t);
  const approvedPlan = plan('fenced');
  const started = await startApprovedRun(state, 'fenced', approvedPlan);
  await state.executions.complete({
    dispatchId: started.dispatch.id,
    owner: started.execution.leaseOwner,
    leaseToken: started.execution.leaseToken,
    expectedVersion: started.execution.version,
    resultMutationId: 'terminal-before-action',
    outcome: 'failed',
    resultCode: 'fenced_before_action',
    completedAtMs: started.execution.startedAtMs + 10,
  });
  const repository = new LegacySequelizeApprovedRunActionRepository(
    state.database,
    { clock: () => started.execution.startedAtMs + 20 },
  );
  await assert.rejects(
    repository.create({ snapshot: started, plan: approvedPlan }),
    ApprovedRunActionBindingConflictError,
  );
  assert.equal(
    (
      await state.database.query('SELECT id FROM "Runs"', {
        type: QueryTypes.SELECT,
      })
    ).length,
    0,
  );
});

test('evidence provider verifies only the atomic receipt and bound Run fact', async (t) => {
  const state = await setup(t);
  const approvedPlan = plan('evidence');
  const snapshot = await startApprovedRun(state, 'evidence', approvedPlan);
  const provider = new LegacySequelizeApprovedRunRecoveryEvidenceProvider(
    state.database,
  );
  assert.deepEqual(await provider.inspect(recoveryContext(snapshot)), {
    finding: 'missing',
    resultCode: 'approved_run_receipt_missing',
  });
  const repository = new LegacySequelizeApprovedRunActionRepository(
    state.database,
    { clock: () => snapshot.execution.startedAtMs + 5 },
  );
  await repository.create({ snapshot, plan: approvedPlan });
  const evidence = await provider.inspect(recoveryContext(snapshot));
  assert.equal(evidence.finding, 'verified_succeeded');
  assert.equal(evidence.resultCode, 'approved_run_receipt_verified');
  assert.match(evidence.evidenceDigest, /^[0-9a-f]{64}$/);

  await state.database.query(
    `UPDATE "${APPROVED_RUN_ACTION_RECEIPT_TABLE}"
        SET action_digest = :digest
      WHERE dispatch_id = :dispatchId`,
    {
      replacements: {
        digest: '0'.repeat(64),
        dispatchId: snapshot.dispatch.id,
      },
    },
  );
  assert.deepEqual(await provider.inspect(recoveryContext(snapshot)), {
    finding: 'conflict',
    resultCode: 'approved_run_receipt_conflict',
  });
});

test('a Run idempotency collision without an atomic receipt is conflict, not success', async (t) => {
  const state = await setup(t);
  const approvedPlan = plan('collision');
  const snapshot = await startApprovedRun(state, 'collision', approvedPlan);
  const creator = new PrimaryRunCreator(
    new LegacySequelizeRunRepository(state.database),
  );
  await creator.create(
    {
      projectId: PROJECT_ID,
      taskId: approvedPlan.taskId,
      taskRevision: approvedPlan.taskRevision,
      triggerType: 'untrusted_collision',
      executionOrigin: 'system',
      requestId: snapshot.dispatch.approvalRequestId,
      idempotencyKey: snapshot.dispatch.id,
      acceptedAtMs: snapshot.execution.startedAtMs,
      actor: { type: 'system' },
    },
    'local_process',
  );
  const provider = new LegacySequelizeApprovedRunRecoveryEvidenceProvider(
    state.database,
  );
  assert.deepEqual(await provider.inspect(recoveryContext(snapshot)), {
    finding: 'conflict',
    resultCode: 'approved_run_receipt_conflict',
  });
});

test('receipt recovers a dispatcher crash after the Run commit but before completion', async (t) => {
  const state = await setup(t);
  const approvedPlan = plan('crash-window');
  const dispatch = await prepareApprovedRun(
    state,
    'crash-window',
    approvedPlan,
  );
  const crashingRepository = {
    findById: (...args) => state.executions.findById(...args),
    listDue: (...args) => state.executions.listDue(...args),
    claim: (...args) => state.executions.claim(...args),
    start: (...args) => state.executions.start(...args),
    renew: (...args) => state.executions.renew(...args),
    releaseBeforeStart: (...args) =>
      state.executions.releaseBeforeStart(...args),
    async complete() {
      throw new Error('simulated completion persistence outage');
    },
  };
  const actionRepository = new LegacySequelizeApprovedRunActionRepository(
    state.database,
    { clock: () => BASE_TIME + 1_010 },
  );
  const handler = new ApprovedRunActionHandler(
    {
      async resolve() {
        return approvedPlan;
      },
    },
    actionRepository,
  );
  let dispatchNow = BASE_TIME + 1_000;
  let dispatchId = 0;
  const dispatcher = new ApprovedActionDispatcher(
    crashingRepository,
    [handler],
    {
      owner: 'dispatcher-crash-test',
      leaseDurationMs: 1_000,
      clock: () => ++dispatchNow,
      createId: () => `dispatch-mutation-${++dispatchId}`,
    },
  );
  const dispatched = await dispatcher.dispatchBatch({ limit: 1 });
  assert.equal(dispatched.started, 1);
  assert.equal(dispatched.succeeded, 0);
  assert.equal(dispatched.unavailable, 1);
  assert.equal(dispatched.recoveryRequired, 1);
  assert.equal(
    (await state.executions.findById(dispatch.id)).execution.status,
    'executing',
  );

  let recoveryNow = BASE_TIME + 3_000;
  let recoveryId = 0;
  const reconciler = new ApprovedActionRecoveryReconciler(
    new LegacySequelizeApprovedActionRecoveryRepository(state.database),
    [new LegacySequelizeApprovedRunRecoveryEvidenceProvider(state.database)],
    {
      owner: 'recovery-crash-test',
      leaseDurationMs: 1_000,
      clock: () => ++recoveryNow,
      createId: () => `recovery-mutation-${++recoveryId}`,
    },
  );
  const recovered = await reconciler.reconcileBatch({ limit: 1 });
  assert.equal(recovered.verifiedSucceeded, 1);
  assert.equal(
    (await state.executions.findById(dispatch.id)).execution.status,
    'succeeded',
  );
});
