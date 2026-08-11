require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
const {
  projectPolicyMigration,
} = require('../../back/migrations/0017-project-policy');
const {
  APPROVAL_REQUEST_CONSUMPTION_ID_INDEX,
  APPROVAL_REQUEST_DECISION_ID_INDEX,
  APPROVAL_REQUEST_PENDING_INDEX,
  APPROVAL_REQUEST_REQUESTER_INDEX,
  APPROVAL_REQUEST_TABLE,
  APPROVED_ACTION_DISPATCH_PENDING_INDEX,
  APPROVED_ACTION_DISPATCH_REQUEST_INDEX,
  APPROVED_ACTION_DISPATCH_TABLE,
  approvalRequestMigration,
} = require('../../back/migrations/0020-approval-requests');
const {
  approvedActionDispatchExecutionMigration,
} = require('../../back/migrations/0021-approved-action-dispatch-executions');
const { runMigrations } = require('../../back/migrations/runner');
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
  ApprovalHumanDecisionRequiredError,
  ApprovalMutationConflictError,
  ApprovalPolicyDeniedError,
  ApprovalPolicyFenceConflictError,
  ApprovalRequestExpiredError,
  ApprovalRequestStateConflictError,
  ApprovalRequestVersionConflictError,
} = require('../../back/runtime/domain/approvalRequest');

const PROJECT_ID = 'default';
const AGENT = Object.freeze({ type: 'agent', id: 'agent-1' });
const OWNER = Object.freeze({ type: 'user', id: 'owner-1' });
const VIEWER = Object.freeze({ type: 'user', id: 'viewer-1' });
const SYSTEM = Object.freeze({ type: 'system', id: 'approval-dispatcher' });
const NOW = 100_000;
const EXPIRES_AT = 200_000;

function action(overrides = {}) {
  return {
    permission: 'tool.call:filesystem.write',
    actionType: 'tool_call',
    actionRef: 'planned-action-1',
    actionDigest: 'a'.repeat(64),
    previewDigest: 'b'.repeat(64),
    ...overrides,
  };
}

function createInput(overrides = {}) {
  return {
    id: 'approval-1',
    projectId: PROJECT_ID,
    action: action(),
    risk: 'high',
    requestedBy: AGENT,
    requestedAtMs: NOW,
    expiresAtMs: EXPIRES_AT,
    ...overrides,
  };
}

function decisionInput(overrides = {}) {
  return {
    requestId: 'approval-1',
    expectedVersion: 1,
    decisionId: 'decision-1',
    decision: 'approved',
    reasonCode: 'reviewed_action',
    decidedBy: OWNER,
    decidedAtMs: NOW + 10,
    ...overrides,
  };
}

function consumptionInput(overrides = {}) {
  return {
    requestId: 'approval-1',
    expectedVersion: 2,
    consumptionId: 'consumption-1',
    dispatchId: 'dispatch-1',
    action: action(),
    requestedBy: AGENT,
    consumedBy: SYSTEM,
    consumedAtMs: NOW + 20,
    ...overrides,
  };
}

async function migrate(database) {
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [
      projectPolicyMigration,
      approvalRequestMigration,
      approvedActionDispatchExecutionMigration,
    ],
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
      createdAtMs: NOW - 100,
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
  await migrate(database);
  const policyRepository = new LegacySequelizeProjectPolicyRepository(database);
  await bind(policyRepository, OWNER, 'owner', 'bind-owner');
  await bind(policyRepository, AGENT, 'operator', 'bind-agent');
  await bind(policyRepository, VIEWER, 'viewer', 'bind-viewer');
  const repository = new LegacySequelizeApprovalRequestRepository(database);
  const policy = new ProjectPolicyEngine(policyRepository);
  return {
    database,
    policyRepository,
    repository,
    policy,
    service: new ApprovalRequestService(repository, policy),
  };
}

test('migration owns bounded approval and durable dispatch indexes', async (t) => {
  const { database, service } = await setup(t);
  await service.create(createInput());
  const rows = await database
    .getQueryInterface()
    .select(null, APPROVAL_REQUEST_TABLE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action_digest, 'a'.repeat(64));
  assert.equal(rows[0].preview_digest, 'b'.repeat(64));
  assert.equal(JSON.stringify(rows).includes('filesystem.write'), true);
  assert.equal('preview' in rows[0], false);
  assert.equal('arguments' in rows[0], false);
  assert.equal('secret' in rows[0], false);

  const requestIndexes = new Set(
    (await database.getQueryInterface().showIndex(APPROVAL_REQUEST_TABLE)).map(
      (index) => index.name,
    ),
  );
  for (const name of [
    APPROVAL_REQUEST_DECISION_ID_INDEX,
    APPROVAL_REQUEST_CONSUMPTION_ID_INDEX,
    APPROVAL_REQUEST_PENDING_INDEX,
    APPROVAL_REQUEST_REQUESTER_INDEX,
  ]) {
    assert.ok(requestIndexes.has(name));
  }
  const dispatchIndexes = new Set(
    (
      await database
        .getQueryInterface()
        .showIndex(APPROVED_ACTION_DISPATCH_TABLE)
    ).map((index) => index.name),
  );
  assert.ok(dispatchIndexes.has(APPROVED_ACTION_DISPATCH_REQUEST_INDEX));
  assert.ok(dispatchIndexes.has(APPROVED_ACTION_DISPATCH_PENDING_INDEX));
});

test('creates, approves and atomically emits a one-time durable dispatch', async (t) => {
  const { database, service } = await setup(t);
  const pending = await service.create(createInput());
  assert.equal(pending.state, 'pending');
  assert.equal(pending.version, 1);

  const approved = await service.decide(decisionInput());
  assert.equal(approved.state, 'approved');
  assert.equal(approved.version, 2);
  assert.deepEqual(approved.decidedBy, OWNER);

  const consumed = await service.consume(consumptionInput());
  assert.equal(consumed.request.state, 'consumed');
  assert.equal(consumed.request.version, 3);
  assert.equal(consumed.dispatch.state, 'pending');
  assert.equal(consumed.dispatch.approvalRequestId, pending.id);
  assert.equal(
    consumed.dispatch.action.actionDigest,
    pending.action.actionDigest,
  );
  assert.equal(
    (
      await database
        .getQueryInterface()
        .select(null, APPROVED_ACTION_DISPATCH_TABLE)
    ).length,
    1,
  );
});

test('only require-approval actions can create requests', async (t) => {
  const { service } = await setup(t);
  await assert.rejects(
    service.create(createInput({ requestedBy: OWNER })),
    ApprovalPolicyDeniedError,
  );
  await assert.rejects(
    service.create(
      createInput({ requestedBy: { type: 'agent', id: 'unbound-agent' } }),
    ),
    ApprovalPolicyDeniedError,
  );
});

test('decisions require a bound human user with approval.decide', async (t) => {
  const { service } = await setup(t);
  await service.create(createInput());
  await assert.rejects(
    service.decide(decisionInput({ decidedBy: AGENT })),
    ApprovalHumanDecisionRequiredError,
  );
  await assert.rejects(
    service.decide(decisionInput({ decidedBy: VIEWER })),
    ApprovalPolicyDeniedError,
  );
  const rejected = await service.decide(
    decisionInput({ decision: 'rejected', reasonCode: 'unsafe_action' }),
  );
  assert.equal(rejected.state, 'rejected');
  await assert.rejects(
    service.consume(consumptionInput()),
    ApprovalRequestStateConflictError,
  );
});

test('expiry is exact and does not require background timers', async (t) => {
  const { service } = await setup(t);
  await service.create(createInput());
  assert.equal(
    (await service.get('approval-1', EXPIRES_AT - 1)).effectiveStatus,
    'pending',
  );
  assert.equal(
    (await service.get('approval-1', EXPIRES_AT)).effectiveStatus,
    'expired',
  );
  await assert.rejects(
    service.decide(decisionInput({ decidedAtMs: EXPIRES_AT })),
    ApprovalRequestExpiredError,
  );

  await service.create(createInput({ id: 'approval-2' }));
  await service.decide(
    decisionInput({
      requestId: 'approval-2',
      decisionId: 'decision-2',
      decidedAtMs: EXPIRES_AT - 2,
    }),
  );
  await assert.rejects(
    service.consume(
      consumptionInput({
        requestId: 'approval-2',
        consumptionId: 'consumption-2',
        dispatchId: 'dispatch-2',
        consumedAtMs: EXPIRES_AT,
      }),
    ),
    ApprovalRequestExpiredError,
  );
});

test('exact mutation replays are idempotent and drift conflicts', async (t) => {
  const { service } = await setup(t);
  const pending = await service.create(createInput());
  assert.deepEqual(await service.create(createInput()), pending);
  await assert.rejects(
    service.create(createInput({ risk: 'critical' })),
    ApprovalMutationConflictError,
  );

  const approved = await service.decide(decisionInput());
  assert.deepEqual(await service.decide(decisionInput()), approved);
  await assert.rejects(
    service.decide(decisionInput({ reasonCode: 'different_review' })),
    ApprovalMutationConflictError,
  );

  const consumed = await service.consume(consumptionInput());
  assert.deepEqual(await service.consume(consumptionInput()), consumed);
  assert.deepEqual(await service.create(createInput()), consumed.request);
  await assert.rejects(
    service.consume(
      consumptionInput({ action: action({ actionDigest: 'c'.repeat(64) }) }),
    ),
    ApprovalMutationConflictError,
  );
});

test('policy versions fence every mutation against revocation races', async (t) => {
  const { policyRepository, policy, repository } = await setup(t);
  const authorization = await policy.decideWithFence({
    projectId: PROJECT_ID,
    subject: AGENT,
    permission: action().permission,
  });
  assert.equal(authorization.decision.effect, 'require_approval');
  await policyRepository.append({
    expectedCurrentVersion: 1,
    binding: {
      projectId: PROJECT_ID,
      subject: AGENT,
      version: 2,
      state: 'revoked',
      mutationId: 'revoke-agent',
      changedBy: OWNER,
      createdAtMs: NOW,
    },
  });
  const request = {
    ...createInput(),
    version: 1,
    state: 'pending',
    decisionId: null,
    decision: null,
    decisionReasonCode: null,
    decidedBy: null,
    decidedAtMs: null,
    consumptionId: null,
    dispatchId: null,
    consumedBy: null,
    consumedAtMs: null,
  };
  await assert.rejects(
    repository.create({
      request,
      authorizationFence: authorization.fence,
    }),
    ApprovalPolicyFenceConflictError,
  );
});

test('two SQLite connections allow only one decision and one consumption', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-approval-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const storage = path.join(directory, 'database.sqlite');
  const first = await setup(t, storage);
  const secondDatabase = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
  t.after(() => secondDatabase.close());
  const secondPolicyRepository = new LegacySequelizeProjectPolicyRepository(
    secondDatabase,
  );
  const secondRepository = new LegacySequelizeApprovalRequestRepository(
    secondDatabase,
  );
  const secondService = new ApprovalRequestService(
    secondRepository,
    new ProjectPolicyEngine(secondPolicyRepository),
  );

  await first.service.create(createInput());
  const decisions = await Promise.allSettled([
    first.service.decide(decisionInput()),
    secondService.decide(
      decisionInput({ decisionId: 'decision-racer', reasonCode: 'racer' }),
    ),
  ]);
  assert.equal(
    decisions.filter((entry) => entry.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    decisions.filter((entry) => entry.status === 'rejected').length,
    1,
  );
  assert.ok(
    decisions
      .filter((entry) => entry.status === 'rejected')
      .every(
        (entry) =>
          entry.reason instanceof ApprovalRequestVersionConflictError ||
          entry.reason instanceof ApprovalRequestStateConflictError,
      ),
  );

  const approved = await first.repository.findById('approval-1');
  const winnerDecisionId = approved.decisionId;
  const winnerDecision =
    winnerDecisionId === 'decision-1'
      ? decisionInput()
      : decisionInput({ decisionId: 'decision-racer', reasonCode: 'racer' });
  assert.deepEqual(await first.service.decide(winnerDecision), approved);

  const consumptions = await Promise.allSettled([
    first.service.consume(consumptionInput()),
    secondService.consume(
      consumptionInput({
        consumptionId: 'consumption-racer',
        dispatchId: 'dispatch-racer',
      }),
    ),
  ]);
  assert.equal(
    consumptions.filter((entry) => entry.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    consumptions.filter((entry) => entry.status === 'rejected').length,
    1,
  );
  assert.equal(
    (
      await first.database
        .getQueryInterface()
        .select(null, APPROVED_ACTION_DISPATCH_TABLE)
    ).length,
    1,
  );
});

test('dispatch collisions roll back consumption and leave approval reusable', async (t) => {
  const { database, service, repository } = await setup(t);
  await service.create(createInput());
  await service.decide(decisionInput());
  await service.create(
    createInput({
      id: 'approval-2',
      action: action({ actionRef: 'planned-action-2' }),
    }),
  );
  await service.decide(
    decisionInput({ requestId: 'approval-2', decisionId: 'decision-2' }),
  );
  await service.consume(consumptionInput());
  await assert.rejects(
    service.consume(
      consumptionInput({
        requestId: 'approval-2',
        consumptionId: 'consumption-2',
        dispatchId: 'dispatch-1',
        action: action({ actionRef: 'planned-action-2' }),
      }),
    ),
    ApprovalMutationConflictError,
  );
  assert.equal((await repository.findById('approval-2')).state, 'approved');
  assert.equal(
    (
      await database
        .getQueryInterface()
        .select(null, APPROVED_ACTION_DISPATCH_TABLE)
    ).length,
    1,
  );
});
