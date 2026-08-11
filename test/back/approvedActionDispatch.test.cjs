require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { QueryTypes, Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  projectPolicyMigration,
} = require('../../back/migrations/0017-project-policy');
const {
  APPROVAL_REQUEST_TABLE,
  APPROVED_ACTION_DISPATCH_TABLE,
  approvalRequestMigration,
} = require('../../back/migrations/0020-approval-requests');
const {
  APPROVED_ACTION_DISPATCH_EXECUTION_DUE_INDEX,
  APPROVED_ACTION_DISPATCH_EXECUTION_LEASE_INDEX,
  APPROVED_ACTION_DISPATCH_EXECUTION_PROJECT_INDEX,
  APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
  approvedActionDispatchExecutionMigration,
} = require('../../back/migrations/0021-approved-action-dispatch-executions');
const {
  approvedActionRecoveryMigration,
} = require('../../back/migrations/0022-approved-action-recovery');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeApprovedActionDispatchRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/approvedActionDispatchRepository');
const {
  LegacySequelizeApprovalRequestRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/approvalRequestRepository');
const {
  LegacySequelizeProjectPolicyRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/projectPolicyRepository');
const {
  ApprovalRequestService,
} = require('../../back/runtime/application/approvalRequestService');
const {
  ProjectPolicyEngine,
} = require('../../back/runtime/application/projectPolicyEngine');
const {
  ApprovedActionDispatchBindingConflictError,
  ApprovedActionDispatchFenceRejectedError,
  ApprovedActionDispatchRepositoryError,
} = require('../../back/runtime/domain/approvedActionDispatchExecution');
const {
  ApprovalUnavailableError,
} = require('../../back/runtime/domain/approvalRequest');

const PROJECT_ID = 'default';
const AGENT = Object.freeze({ type: 'agent', id: 'agent-1' });
const OWNER = Object.freeze({ type: 'user', id: 'owner-1' });
const SYSTEM = Object.freeze({ type: 'system', id: 'approval-dispatcher' });
const BASE_TIME = 100_000;

function action(name, digestCharacter = 'a') {
  return {
    permission: 'tool.call:filesystem.write',
    actionType: 'tool_call',
    actionRef: `planned-${name}`,
    actionDigest: digestCharacter.repeat(64),
    previewDigest: 'f'.repeat(64),
  };
}

async function migrate(database, migrations) {
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations,
    logger: { info() {} },
  });
}

async function bind(policyRepository, subject, role, mutationId) {
  await policyRepository.append({
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

async function setup(t, storage = ':memory:') {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
  t.after(() => database.close());
  await migrate(database, [
    projectPolicyMigration,
    approvalRequestMigration,
    approvedActionDispatchExecutionMigration,
    approvedActionRecoveryMigration,
  ]);
  const policyRepository = new LegacySequelizeProjectPolicyRepository(database);
  await bind(policyRepository, OWNER, 'owner', 'bind-owner');
  await bind(policyRepository, AGENT, 'operator', 'bind-agent');
  const approvalRepository = new LegacySequelizeApprovalRequestRepository(
    database,
  );
  return {
    database,
    approvalRepository,
    approvalService: new ApprovalRequestService(
      approvalRepository,
      new ProjectPolicyEngine(policyRepository),
    ),
    executionRepository: new LegacySequelizeApprovedActionDispatchRepository(
      database,
    ),
  };
}

async function prepareDispatch(service, name, offset = 0, digest = 'a') {
  const requestedAtMs = BASE_TIME + offset;
  const binding = action(name, digest);
  await service.create({
    id: `approval-${name}`,
    projectId: PROJECT_ID,
    action: binding,
    risk: 'high',
    requestedBy: AGENT,
    requestedAtMs,
    expiresAtMs: requestedAtMs + 60_000,
  });
  await service.decide({
    requestId: `approval-${name}`,
    expectedVersion: 1,
    decisionId: `decision-${name}`,
    decision: 'approved',
    reasonCode: 'reviewed_action',
    decidedBy: OWNER,
    decidedAtMs: requestedAtMs + 10,
  });
  const consumed = await service.consume({
    requestId: `approval-${name}`,
    expectedVersion: 2,
    consumptionId: `consumption-${name}`,
    dispatchId: `dispatch-${name}`,
    action: binding,
    requestedBy: AGENT,
    consumedBy: SYSTEM,
    consumedAtMs: requestedAtMs + 20,
  });
  return consumed.dispatch;
}

function claimInput(dispatchId, overrides = {}) {
  return {
    dispatchId,
    owner: 'dispatcher-1',
    leaseToken: 'lease-1',
    nowMs: BASE_TIME + 1_000,
    leaseDurationMs: 1_000,
    ...overrides,
  };
}

test('0021 backfills immutable dispatches and owns bounded execution indexes', async (t) => {
  const database = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
  });
  t.after(() => database.close());
  await migrate(database, [projectPolicyMigration, approvalRequestMigration]);
  const queryInterface = database.getQueryInterface();
  await queryInterface.bulkInsert(APPROVAL_REQUEST_TABLE, [
    {
      id: 'approval-backfill',
      project_id: PROJECT_ID,
      version: 3,
      state: 'consumed',
      permission: 'tool.call:filesystem.write',
      action_type: 'tool_call',
      action_ref: 'planned-backfill',
      action_digest: 'a'.repeat(64),
      preview_digest: 'f'.repeat(64),
      risk: 'high',
      requested_by_type: 'agent',
      requested_by_id: AGENT.id,
      requested_at_ms: BASE_TIME,
      expires_at_ms: BASE_TIME + 60_000,
      decision_id: 'decision-backfill',
      decision: 'approved',
      decision_reason_code: 'reviewed_action',
      decided_by_type: 'user',
      decided_by_id: OWNER.id,
      decided_at_ms: BASE_TIME + 10,
      consumption_id: 'consumption-backfill',
      dispatch_id: 'dispatch-backfill',
      consumed_by_type: 'system',
      consumed_by_id: SYSTEM.id,
      consumed_at_ms: BASE_TIME + 20,
    },
  ]);
  await queryInterface.bulkInsert(APPROVED_ACTION_DISPATCH_TABLE, [
    {
      id: 'dispatch-backfill',
      approval_request_id: 'approval-backfill',
      approval_request_version: 3,
      project_id: PROJECT_ID,
      state: 'pending',
      permission: 'tool.call:filesystem.write',
      action_type: 'tool_call',
      action_ref: 'planned-backfill',
      action_digest: 'a'.repeat(64),
      preview_digest: 'f'.repeat(64),
      requested_by_type: 'agent',
      requested_by_id: AGENT.id,
      consumed_by_type: 'system',
      consumed_by_id: SYSTEM.id,
      created_at_ms: BASE_TIME + 20,
    },
  ]);
  await migrate(database, [approvedActionDispatchExecutionMigration]);

  const rows = await queryInterface.select(
    null,
    APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dispatch_id, 'dispatch-backfill');
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].version, 0);
  assert.equal(rows[0].eligible_at_ms, BASE_TIME + 20);
  const indexes = new Set(
    (
      await queryInterface.showIndex(APPROVED_ACTION_DISPATCH_EXECUTION_TABLE)
    ).map((index) => index.name),
  );
  for (const name of [
    APPROVED_ACTION_DISPATCH_EXECUTION_DUE_INDEX,
    APPROVED_ACTION_DISPATCH_EXECUTION_PROJECT_INDEX,
    APPROVED_ACTION_DISPATCH_EXECUTION_LEASE_INDEX,
  ]) {
    assert.ok(indexes.has(name));
  }
});

test('approval consumption atomically creates the immutable dispatch and execution baseline', async (t) => {
  const { database, approvalService, executionRepository } = await setup(t);
  const dispatch = await prepareDispatch(approvalService, 'atomic');
  const snapshot = await executionRepository.findById(dispatch.id);
  assert.equal(snapshot.execution.status, 'pending');
  assert.equal(snapshot.execution.version, 0);
  assert.equal(snapshot.execution.attemptCount, 0);
  assert.equal(snapshot.execution.eligibleAtMs, dispatch.createdAtMs);

  await approvalService.create({
    id: 'approval-rollback',
    projectId: PROJECT_ID,
    action: action('rollback', 'b'),
    risk: 'high',
    requestedBy: AGENT,
    requestedAtMs: BASE_TIME + 100,
    expiresAtMs: BASE_TIME + 60_100,
  });
  await approvalService.decide({
    requestId: 'approval-rollback',
    expectedVersion: 1,
    decisionId: 'decision-rollback',
    decision: 'approved',
    reasonCode: 'reviewed_action',
    decidedBy: OWNER,
    decidedAtMs: BASE_TIME + 110,
  });
  await database.query(
    `CREATE TRIGGER fail_approved_execution_insert
       BEFORE INSERT ON "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}"
       BEGIN SELECT RAISE(ABORT, 'forced execution insert failure'); END`,
  );
  await assert.rejects(
    approvalService.consume({
      requestId: 'approval-rollback',
      expectedVersion: 2,
      consumptionId: 'consumption-rollback',
      dispatchId: 'dispatch-rollback',
      action: action('rollback', 'b'),
      requestedBy: AGENT,
      consumedBy: SYSTEM,
      consumedAtMs: BASE_TIME + 120,
    }),
    ApprovalUnavailableError,
  );
  assert.equal(await executionRepository.findById('dispatch-rollback'), null);
  assert.equal(
    (
      await database.query(
        `SELECT state FROM "${APPROVAL_REQUEST_TABLE}"
          WHERE id = 'approval-rollback'`,
        { type: QueryTypes.SELECT },
      )
    )[0].state,
    'approved',
  );
});

test('lists a bounded stable due page without loading executing or future work', async (t) => {
  const { approvalService, executionRepository } = await setup(t);
  await prepareDispatch(approvalService, 'page-a', 0, 'a');
  await prepareDispatch(approvalService, 'page-b', 10, 'b');
  await prepareDispatch(approvalService, 'page-c', 20, 'c');
  const first = await executionRepository.listDue({
    nowMs: BASE_TIME + 1_000,
    limit: 2,
  });
  assert.deepEqual(
    first.dispatches.map((entry) => entry.dispatch.id),
    ['dispatch-page-a', 'dispatch-page-b'],
  );
  assert.equal(first.truncated, true);
  const second = await executionRepository.listDue({
    nowMs: BASE_TIME + 1_000,
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    second.dispatches.map((entry) => entry.dispatch.id),
    ['dispatch-page-c'],
  );
  assert.equal(second.truncated, false);
});

test('claims idempotently and lets only an expired pre-start lease be taken over', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-action-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const storage = path.join(directory, 'database.sqlite');
  const first = await setup(t, storage);
  await prepareDispatch(first.approvalService, 'race');
  const secondDatabase = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
  t.after(() => secondDatabase.close());
  const secondRepository = new LegacySequelizeApprovedActionDispatchRepository(
    secondDatabase,
  );

  const results = await Promise.all([
    first.executionRepository.claim(claimInput('dispatch-race')),
    secondRepository.claim(
      claimInput('dispatch-race', {
        owner: 'dispatcher-2',
        leaseToken: 'lease-2',
      }),
    ),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'claimed').length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === 'leased').length,
    1,
  );
  const winner = results.find((result) => result.status === 'claimed');
  assert.equal(
    (
      await first.executionRepository.claim(
        claimInput('dispatch-race', {
          owner: winner.snapshot.execution.leaseOwner,
          leaseToken: winner.snapshot.execution.leaseToken,
        }),
      )
    ).status,
    'claimed',
  );

  const takeover = await secondRepository.claim(
    claimInput('dispatch-race', {
      owner: 'dispatcher-3',
      leaseToken: 'lease-3',
      nowMs: BASE_TIME + 2_000,
    }),
  );
  assert.equal(takeover.status, 'claimed');
  assert.equal(takeover.snapshot.execution.attemptCount, 2);
  assert.equal(takeover.snapshot.execution.leaseOwner, 'dispatcher-3');
});

test('start barrier binds the exact approval and action digest before side effects', async (t) => {
  const { approvalService, executionRepository } = await setup(t);
  const dispatch = await prepareDispatch(approvalService, 'start');
  const claimed = await executionRepository.claim(
    claimInput(dispatch.id, { nowMs: BASE_TIME + 1_000 }),
  );
  await assert.rejects(
    executionRepository.start({
      dispatchId: dispatch.id,
      approvalRequestId: dispatch.approvalRequestId,
      actionDigest: 'e'.repeat(64),
      owner: 'dispatcher-1',
      leaseToken: 'lease-1',
      expectedVersion: claimed.snapshot.execution.version,
      startedAtMs: BASE_TIME + 1_100,
    }),
    ApprovedActionDispatchBindingConflictError,
  );
  const started = await executionRepository.start({
    dispatchId: dispatch.id,
    approvalRequestId: dispatch.approvalRequestId,
    actionDigest: dispatch.action.actionDigest,
    owner: 'dispatcher-1',
    leaseToken: 'lease-1',
    expectedVersion: claimed.snapshot.execution.version,
    startedAtMs: BASE_TIME + 1_100,
  });
  assert.equal(started.execution.status, 'executing');
  assert.equal(started.execution.eligibleAtMs, null);
  assert.deepEqual(
    await executionRepository.start({
      dispatchId: dispatch.id,
      approvalRequestId: dispatch.approvalRequestId,
      actionDigest: dispatch.action.actionDigest,
      owner: 'dispatcher-1',
      leaseToken: 'lease-1',
      expectedVersion: claimed.snapshot.execution.version,
      startedAtMs: BASE_TIME + 1_100,
    }),
    started,
  );
});

test('executing lease expiry requires recovery and can never auto-take over', async (t) => {
  const { approvalService, executionRepository } = await setup(t);
  const dispatch = await prepareDispatch(approvalService, 'recovery');
  const claimed = await executionRepository.claim(
    claimInput(dispatch.id, {
      nowMs: BASE_TIME + 1_000,
      leaseDurationMs: 100,
    }),
  );
  const started = await executionRepository.start({
    dispatchId: dispatch.id,
    approvalRequestId: dispatch.approvalRequestId,
    actionDigest: dispatch.action.actionDigest,
    owner: 'dispatcher-1',
    leaseToken: 'lease-1',
    expectedVersion: claimed.snapshot.execution.version,
    startedAtMs: BASE_TIME + 1_010,
  });
  const takeover = await executionRepository.claim(
    claimInput(dispatch.id, {
      owner: 'dispatcher-2',
      leaseToken: 'lease-2',
      nowMs: BASE_TIME + 1_100,
    }),
  );
  assert.equal(takeover.status, 'recovery_required');
  assert.equal(takeover.snapshot.execution.leaseOwner, 'dispatcher-1');
  assert.equal(
    (
      await executionRepository.listDue({
        nowMs: BASE_TIME + 10_000,
        limit: 64,
      })
    ).dispatches.length,
    0,
  );
  const renewed = await executionRepository.renew({
    dispatchId: dispatch.id,
    owner: 'dispatcher-1',
    leaseToken: 'lease-1',
    expectedVersion: started.execution.version,
    nowMs: BASE_TIME + 1_200,
    leaseDurationMs: 1_000,
  });
  assert.equal(renewed.execution.status, 'executing');
});

test('pre-effect failures retry safely but exhaust into a terminal block', async (t) => {
  const { database, approvalService, executionRepository } = await setup(t);
  const dispatch = await prepareDispatch(approvalService, 'retry');
  await database.query(
    `UPDATE "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}"
        SET max_attempts = 2
      WHERE dispatch_id = :dispatchId`,
    { replacements: { dispatchId: dispatch.id } },
  );
  const first = await executionRepository.claim(claimInput(dispatch.id));
  const retry = await executionRepository.releaseBeforeStart({
    dispatchId: dispatch.id,
    owner: 'dispatcher-1',
    leaseToken: 'lease-1',
    expectedVersion: first.snapshot.execution.version,
    resultMutationId: 'preflight-result-1',
    resultCode: 'executor_unavailable',
    atMs: BASE_TIME + 1_010,
    retryAtMs: BASE_TIME + 1_020,
  });
  assert.equal(retry.execution.status, 'retry_wait');
  assert.deepEqual(
    await executionRepository.releaseBeforeStart({
      dispatchId: dispatch.id,
      owner: 'dispatcher-1',
      leaseToken: 'lease-1',
      expectedVersion: first.snapshot.execution.version,
      resultMutationId: 'preflight-result-1',
      resultCode: 'executor_unavailable',
      atMs: BASE_TIME + 1_010,
      retryAtMs: BASE_TIME + 1_020,
    }),
    retry,
  );
  assert.equal(
    (
      await executionRepository.claim(
        claimInput(dispatch.id, { nowMs: BASE_TIME + 1_019 }),
      )
    ).status,
    'not_due',
  );
  const second = await executionRepository.claim(
    claimInput(dispatch.id, {
      leaseToken: 'lease-2',
      nowMs: BASE_TIME + 1_020,
    }),
  );
  const blocked = await executionRepository.releaseBeforeStart({
    dispatchId: dispatch.id,
    owner: 'dispatcher-1',
    leaseToken: 'lease-2',
    expectedVersion: second.snapshot.execution.version,
    resultMutationId: 'preflight-result-2',
    resultCode: 'executor_unavailable',
    atMs: BASE_TIME + 1_030,
    retryAtMs: BASE_TIME + 1_040,
  });
  assert.equal(blocked.execution.status, 'blocked');
  assert.equal(blocked.execution.completedAtMs, BASE_TIME + 1_030);
});

test('completion is fenced, idempotent, and indeterminate evidence blocks replay', async (t) => {
  const { approvalService, executionRepository } = await setup(t);
  const dispatch = await prepareDispatch(approvalService, 'complete');
  const claimed = await executionRepository.claim(claimInput(dispatch.id));
  const started = await executionRepository.start({
    dispatchId: dispatch.id,
    approvalRequestId: dispatch.approvalRequestId,
    actionDigest: dispatch.action.actionDigest,
    owner: 'dispatcher-1',
    leaseToken: 'lease-1',
    expectedVersion: claimed.snapshot.execution.version,
    startedAtMs: BASE_TIME + 1_010,
  });
  await assert.rejects(
    executionRepository.complete({
      dispatchId: dispatch.id,
      owner: 'dispatcher-2',
      leaseToken: 'lease-2',
      expectedVersion: started.execution.version,
      resultMutationId: 'completion-wrong',
      outcome: 'succeeded',
      resultCode: 'ok',
      completedAtMs: BASE_TIME + 1_100,
    }),
    ApprovedActionDispatchFenceRejectedError,
  );
  const command = {
    dispatchId: dispatch.id,
    owner: 'dispatcher-1',
    leaseToken: 'lease-1',
    expectedVersion: started.execution.version,
    resultMutationId: 'completion-1',
    outcome: 'indeterminate',
    resultCode: 'transport_lost_after_start',
    completedAtMs: BASE_TIME + 2_100,
  };
  const completed = await executionRepository.complete(command);
  assert.equal(completed.execution.status, 'blocked');
  assert.deepEqual(await executionRepository.complete(command), completed);
  assert.equal(
    (await executionRepository.claim(claimInput(dispatch.id))).status,
    'blocked',
  );
});

test('a successful result can arrive after lease expiry without re-executing', async (t) => {
  const { approvalService, executionRepository } = await setup(t);
  const dispatch = await prepareDispatch(approvalService, 'success');
  const claimed = await executionRepository.claim(
    claimInput(dispatch.id, {
      nowMs: BASE_TIME + 1_000,
      leaseDurationMs: 100,
    }),
  );
  const started = await executionRepository.start({
    dispatchId: dispatch.id,
    approvalRequestId: dispatch.approvalRequestId,
    actionDigest: dispatch.action.actionDigest,
    owner: 'dispatcher-1',
    leaseToken: 'lease-1',
    expectedVersion: claimed.snapshot.execution.version,
    startedAtMs: BASE_TIME + 1_010,
  });
  const command = {
    dispatchId: dispatch.id,
    owner: 'dispatcher-1',
    leaseToken: 'lease-1',
    expectedVersion: started.execution.version,
    resultMutationId: 'completion-success',
    outcome: 'succeeded',
    resultCode: 'ok',
    completedAtMs: BASE_TIME + 2_000,
  };
  const completed = await executionRepository.complete(command);
  assert.equal(completed.execution.status, 'succeeded');
  assert.deepEqual(await executionRepository.complete(command), completed);
  assert.equal(
    (await executionRepository.claim(claimInput(dispatch.id))).status,
    'succeeded',
  );
});

test('missing execution state is corruption rather than an absent dispatch', async (t) => {
  const { database, approvalService, executionRepository } = await setup(t);
  const dispatch = await prepareDispatch(approvalService, 'corrupt');
  await database.query('PRAGMA foreign_keys = OFF');
  await database.query(
    `DELETE FROM "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}"
      WHERE dispatch_id = :dispatchId`,
    { replacements: { dispatchId: dispatch.id } },
  );
  await database.query('PRAGMA foreign_keys = ON');
  await assert.rejects(
    executionRepository.findById(dispatch.id),
    ApprovedActionDispatchRepositoryError,
  );
});
