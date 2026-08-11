require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { QueryTypes, Sequelize } = require('sequelize');
const {
  defineSchemaMigrationModel,
} = require('../../back/data/schemaMigration');
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
  APPROVED_ACTION_RECOVERY_AUTHORIZATION_AUTH_INDEX,
  APPROVED_ACTION_RECOVERY_AUTHORIZATION_MUTATION_INDEX,
  APPROVED_ACTION_RECOVERY_AUTHORIZATION_PROJECT_INDEX,
  APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE,
  approvedActionRecoveryAuthorizationMigration,
} = require('../../back/migrations/0024-approved-action-recovery-authorization');
const { runMigrations } = require('../../back/migrations/runner');
const {
  LegacySequelizeApprovedActionDispatchRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/approvedActionDispatchRepository');
const {
  LegacySequelizeApprovedActionRecoveryRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/approvedActionRecoveryRepository');
const {
  LegacySequelizeApprovalRequestRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/approvalRequestRepository');
const {
  LegacySequelizeProjectPolicyRepository,
} = require('../../back/runtime/adapters/legacy-sequelize/projectPolicyRepository');
const {
  ApprovedActionManualRecoveryService,
} = require('../../back/runtime/application/approvedActionManualRecoveryService');
const {
  ApprovalRequestService,
} = require('../../back/runtime/application/approvalRequestService');
const {
  ProjectPolicyEngine,
} = require('../../back/runtime/application/projectPolicyEngine');
const {
  ApprovedActionRecoveryRepositoryError,
  ApprovedActionRecoveryFenceRejectedError,
} = require('../../back/runtime/domain/approvedActionRecovery');
const {
  ApprovedActionRecoveryAuthorizationDeniedError,
  ApprovedActionRecoveryHumanRequiredError,
  ApprovedActionRecoveryStrongAuthenticationRequiredError,
} = require('../../back/runtime/domain/approvedActionRecoveryAuthorization');

const PROJECT_ID = 'default';
const AGENT = Object.freeze({ type: 'agent', id: 'agent-1' });
const OWNER = Object.freeze({ type: 'user', id: 'owner-1' });
const SYSTEM = Object.freeze({ type: 'system', id: 'approval-dispatcher' });
const BASE_TIME = 300_000;
const RESOLUTION_TIME = BASE_TIME + 2_000;

async function migrate(database) {
  await runMigrations({
    database,
    migrationModel: defineSchemaMigrationModel(database),
    migrations: [
      projectPolicyMigration,
      approvalRequestMigration,
      approvedActionDispatchExecutionMigration,
      approvedActionRecoveryMigration,
      approvedActionRecoveryAuthorizationMigration,
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
  const policyRepository = new LegacySequelizeProjectPolicyRepository(database);
  await bind(policyRepository, OWNER, 'owner', 'bind-owner');
  await bind(policyRepository, AGENT, 'operator', 'bind-agent');
  const policy = new ProjectPolicyEngine(policyRepository);
  const approvals = new ApprovalRequestService(
    new LegacySequelizeApprovalRequestRepository(database),
    policy,
  );
  const executions = new LegacySequelizeApprovedActionDispatchRepository(
    database,
  );
  const recovery = new LegacySequelizeApprovedActionRecoveryRepository(
    database,
  );
  const action = {
    permission: 'tool.call:filesystem.write',
    actionType: 'tool_call',
    actionRef: 'manual-recovery-plan',
    actionDigest: 'a'.repeat(64),
    previewDigest: 'f'.repeat(64),
  };
  await approvals.create({
    id: 'approval-manual-recovery',
    projectId: PROJECT_ID,
    action,
    risk: 'critical',
    requestedBy: AGENT,
    requestedAtMs: BASE_TIME,
    expiresAtMs: BASE_TIME + 60_000,
  });
  await approvals.decide({
    requestId: 'approval-manual-recovery',
    expectedVersion: 1,
    decisionId: 'decision-manual-recovery',
    decision: 'approved',
    reasonCode: 'reviewed_action',
    decidedBy: OWNER,
    decidedAtMs: BASE_TIME + 10,
  });
  const dispatch = (
    await approvals.consume({
      requestId: 'approval-manual-recovery',
      expectedVersion: 2,
      consumptionId: 'consumption-manual-recovery',
      dispatchId: 'dispatch-manual-recovery',
      action,
      requestedBy: AGENT,
      consumedBy: SYSTEM,
      consumedAtMs: BASE_TIME + 20,
    })
  ).dispatch;
  const claimed = await executions.claim({
    dispatchId: dispatch.id,
    owner: 'dispatcher-1',
    leaseToken: 'execution-lease-1',
    nowMs: BASE_TIME + 100,
    leaseDurationMs: 100,
  });
  const started = await executions.start({
    dispatchId: dispatch.id,
    approvalRequestId: dispatch.approvalRequestId,
    actionDigest: dispatch.action.actionDigest,
    owner: 'dispatcher-1',
    leaseToken: 'execution-lease-1',
    expectedVersion: claimed.snapshot.execution.version,
    startedAtMs: BASE_TIME + 110,
  });
  return {
    database,
    policyRepository,
    policy,
    recovery,
    dispatch,
    started,
  };
}

function principal(overrides = {}) {
  return {
    subject: OWNER,
    authenticationId: 'mfa-session-1',
    authenticatedAtMs: RESOLUTION_TIME - 1_000,
    expiresAtMs: RESOLUTION_TIME + 60_000,
    assurance: 'multi_factor',
    ...overrides,
  };
}

function input(state, overrides = {}) {
  return {
    dispatchId: state.dispatch.id,
    expectedExecutionVersion: state.started.execution.version,
    expectedRecoveryVersion: 0,
    mutationId: 'manual-resolution-1',
    decision: 'abandon_unknown',
    reasonCode: 'operator_abandoned_unknown',
    principal: principal(),
    ...overrides,
  };
}

test('0024 stores a strong-auth and Policy-fenced fact with manual resolution', async (t) => {
  const state = await setup(t);
  const service = new ApprovedActionManualRecoveryService(
    state.recovery,
    state.policy,
    () => RESOLUTION_TIME,
  );
  const result = await service.resolve(input(state));
  assert.equal(result.status, 'resolved');
  assert.equal(result.snapshot.action.execution.status, 'blocked');
  assert.equal(result.snapshot.resolution.resolvedBy.id, OWNER.id);
  assert.deepEqual(await service.resolve(input(state)), result);

  const [fact] = await state.database.query(
    `SELECT * FROM "${APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE}"`,
    { type: QueryTypes.SELECT },
  );
  assert.equal(fact.dispatch_id, state.dispatch.id);
  assert.equal(fact.mutation_id, 'manual-resolution-1');
  assert.equal(fact.resolved_by_id, OWNER.id);
  assert.equal(fact.authentication_id, 'mfa-session-1');
  assert.equal(fact.assurance, 'multi_factor');
  assert.equal(fact.project_version, 1);
  assert.equal(fact.binding_version, 1);
  assert.match(fact.fact_digest, /^[0-9a-f]{64}$/);

  const indexes = new Set(
    (
      await state.database
        .getQueryInterface()
        .showIndex(APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE)
    ).map((index) => index.name),
  );
  for (const name of [
    APPROVED_ACTION_RECOVERY_AUTHORIZATION_MUTATION_INDEX,
    APPROVED_ACTION_RECOVERY_AUTHORIZATION_PROJECT_INDEX,
    APPROVED_ACTION_RECOVERY_AUTHORIZATION_AUTH_INDEX,
  ]) {
    assert.ok(indexes.has(name));
  }
});

test('requires a stable User and recent strong authentication before storage reads', async () => {
  let reads = 0;
  const repository = {
    async findById() {
      reads += 1;
      return null;
    },
  };
  const policy = {
    async decideWithFence() {
      throw new Error('unreachable');
    },
  };
  const service = new ApprovedActionManualRecoveryService(
    repository,
    policy,
    () => RESOLUTION_TIME,
  );
  const base = {
    dispatchId: 'dispatch-auth-check',
    expectedExecutionVersion: 2,
    expectedRecoveryVersion: 0,
    mutationId: 'manual-auth-check',
    decision: 'confirm_failed',
    reasonCode: 'human_confirmed_failure',
  };
  await assert.rejects(
    service.resolve({
      ...base,
      principal: principal({
        subject: { type: 'agent', id: 'agent-1' },
      }),
    }),
    ApprovedActionRecoveryHumanRequiredError,
  );
  await assert.rejects(
    service.resolve({
      ...base,
      principal: principal({ assurance: 'single_factor' }),
    }),
    ApprovedActionRecoveryStrongAuthenticationRequiredError,
  );
  await assert.rejects(
    service.resolve({
      ...base,
      principal: principal({ authenticatedAtMs: RESOLUTION_TIME - 300_001 }),
    }),
    ApprovedActionRecoveryStrongAuthenticationRequiredError,
  );
  assert.equal(reads, 0);
});

test('operator Policy is denied and an authorization revocation race is fenced', async (t) => {
  const denied = await setup(t);
  await denied.policyRepository.append({
    expectedCurrentVersion: 0,
    binding: {
      projectId: PROJECT_ID,
      subject: { type: 'user', id: 'operator-1' },
      version: 1,
      state: 'active',
      role: 'operator',
      mutationId: 'bind-operator',
      changedBy: OWNER,
      createdAtMs: BASE_TIME,
    },
  });
  const deniedService = new ApprovedActionManualRecoveryService(
    denied.recovery,
    denied.policy,
    () => RESOLUTION_TIME,
  );
  await assert.rejects(
    deniedService.resolve(
      input(denied, {
        principal: principal({
          subject: { type: 'user', id: 'operator-1' },
        }),
      }),
    ),
    ApprovedActionRecoveryAuthorizationDeniedError,
  );

  const raced = await setup(t);
  const racingPolicy = {
    async decideWithFence(request) {
      const decision = await raced.policy.decideWithFence(request);
      await raced.policyRepository.append({
        expectedCurrentVersion: 1,
        binding: {
          projectId: PROJECT_ID,
          subject: OWNER,
          version: 2,
          state: 'revoked',
          mutationId: 'revoke-owner-during-recovery',
          changedBy: OWNER,
          createdAtMs: RESOLUTION_TIME,
        },
      });
      return decision;
    },
  };
  const racedService = new ApprovedActionManualRecoveryService(
    raced.recovery,
    racingPolicy,
    () => RESOLUTION_TIME,
  );
  await assert.rejects(
    racedService.resolve(input(raced)),
    ApprovedActionRecoveryFenceRejectedError,
  );
  const after = await raced.recovery.findById(raced.dispatch.id);
  assert.equal(after.action.execution.status, 'executing');
  assert.equal(after.recovery.status, 'armed');
});

test('authorization fact failure rolls the manual terminal transition back', async (t) => {
  const state = await setup(t);
  await state.database.query(
    `CREATE TRIGGER reject_recovery_authorization
       BEFORE INSERT ON "${APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE}"
       BEGIN SELECT RAISE(ABORT, 'authorization rejected'); END`,
  );
  const service = new ApprovedActionManualRecoveryService(
    state.recovery,
    state.policy,
    () => RESOLUTION_TIME,
  );
  await assert.rejects(
    service.resolve(input(state)),
    ApprovedActionRecoveryRepositoryError,
  );
  const after = await state.recovery.findById(state.dispatch.id);
  assert.equal(after.action.execution.status, 'executing');
  assert.equal(after.recovery.status, 'armed');
  assert.equal(after.resolution, null);
  assert.equal(
    (
      await state.database.query(
        `SELECT dispatch_id FROM "${APPROVED_ACTION_RECOVERY_AUTHORIZATION_TABLE}"`,
        { type: QueryTypes.SELECT },
      )
    ).length,
    0,
  );
});
