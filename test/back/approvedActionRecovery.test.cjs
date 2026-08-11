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
  approvalRequestMigration,
} = require('../../back/migrations/0020-approval-requests');
const {
  APPROVED_ACTION_DISPATCH_EXECUTION_TABLE,
  approvedActionDispatchExecutionMigration,
} = require('../../back/migrations/0021-approved-action-dispatch-executions');
const {
  APPROVED_ACTION_RECOVERY_CONTROL_TABLE,
  APPROVED_ACTION_RECOVERY_DUE_INDEX,
  APPROVED_ACTION_RECOVERY_LEASE_INDEX,
  APPROVED_ACTION_RECOVERY_PROJECT_INDEX,
  APPROVED_ACTION_RECOVERY_RESOLUTION_MUTATION_INDEX,
  APPROVED_ACTION_RECOVERY_RESOLUTION_PROJECT_INDEX,
  APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE,
  approvedActionRecoveryMigration,
} = require('../../back/migrations/0022-approved-action-recovery');
const {
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
  ApprovalRequestService,
} = require('../../back/runtime/application/approvalRequestService');
const {
  ProjectPolicyEngine,
} = require('../../back/runtime/application/projectPolicyEngine');
const {
  ApprovedActionDispatchRepositoryError,
} = require('../../back/runtime/domain/approvedActionDispatchExecution');
const {
  ApprovedActionRecoveryFenceRejectedError,
} = require('../../back/runtime/domain/approvedActionRecovery');
const {
  createApprovedActionRecoveryAuthorizationFact,
} = require('../../back/runtime/domain/approvedActionRecoveryAuthorization');

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

async function setup(t, storage = ':memory:', includeRecovery = true) {
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
    ...(includeRecovery
      ? [
          approvedActionRecoveryMigration,
          approvedActionRecoveryAuthorizationMigration,
        ]
      : []),
  ]);
  const policyRepository = new LegacySequelizeProjectPolicyRepository(database);
  await bind(policyRepository, OWNER, 'owner', 'bind-owner');
  await bind(policyRepository, AGENT, 'operator', 'bind-agent');
  const approvalRepository = new LegacySequelizeApprovalRequestRepository(
    database,
  );
  return {
    database,
    approvalService: new ApprovalRequestService(
      approvalRepository,
      new ProjectPolicyEngine(policyRepository),
    ),
    actionRepository: new LegacySequelizeApprovedActionDispatchRepository(
      database,
    ),
    recoveryRepository: includeRecovery
      ? new LegacySequelizeApprovedActionRecoveryRepository(database)
      : null,
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
  return (
    await service.consume({
      requestId: `approval-${name}`,
      expectedVersion: 2,
      consumptionId: `consumption-${name}`,
      dispatchId: `dispatch-${name}`,
      action: binding,
      requestedBy: AGENT,
      consumedBy: SYSTEM,
      consumedAtMs: requestedAtMs + 20,
    })
  ).dispatch;
}

async function startAction(actionRepository, dispatch, options = {}) {
  const nowMs = options.nowMs ?? BASE_TIME + 1_000;
  const leaseDurationMs = options.leaseDurationMs ?? 100;
  const owner = options.owner ?? 'dispatcher-1';
  const leaseToken = options.leaseToken ?? 'execution-lease-1';
  const claimed = await actionRepository.claim({
    dispatchId: dispatch.id,
    owner,
    leaseToken,
    nowMs,
    leaseDurationMs,
  });
  assert.equal(claimed.status, 'claimed');
  const started = await actionRepository.start({
    dispatchId: dispatch.id,
    approvalRequestId: dispatch.approvalRequestId,
    actionDigest: dispatch.action.actionDigest,
    owner,
    leaseToken,
    expectedVersion: claimed.snapshot.execution.version,
    startedAtMs: nowMs + 10,
  });
  return {
    claimed,
    started,
    owner,
    leaseToken,
    leaseExpiresAtMs: nowMs + leaseDurationMs,
  };
}

async function claimRecovery(recoveryRepository, dispatchId, overrides = {}) {
  return recoveryRepository.claim({
    dispatchId,
    owner: 'resolver-1',
    leaseToken: 'recovery-lease-1',
    nowMs: BASE_TIME + 1_100,
    leaseDurationMs: 1_000,
    ...overrides,
  });
}

test('0022 backfills executing controls and owns bounded recovery indexes', async (t) => {
  const context = await setup(t, ':memory:', false);
  const dispatch = await prepareDispatch(context.approvalService, 'backfill');
  await context.database.query(
    `UPDATE "${APPROVED_ACTION_DISPATCH_EXECUTION_TABLE}"
        SET status = 'executing', version = 2, attempt_count = 1,
            eligible_at_ms = NULL, lease_owner = 'dispatcher-1',
            lease_token = 'execution-lease-1',
            lease_expires_at_ms = :leaseExpiresAtMs,
            started_at_ms = :startedAtMs, updated_at_ms = :startedAtMs
      WHERE dispatch_id = :dispatchId`,
    {
      replacements: {
        dispatchId: dispatch.id,
        startedAtMs: BASE_TIME + 1_010,
        leaseExpiresAtMs: BASE_TIME + 1_100,
      },
    },
  );
  await migrate(context.database, [approvedActionRecoveryMigration]);
  const rows = await context.database.query(
    `SELECT * FROM "${APPROVED_ACTION_RECOVERY_CONTROL_TABLE}"`,
    { type: QueryTypes.SELECT },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dispatch_id, dispatch.id);
  assert.equal(rows[0].execution_version, 2);
  assert.equal(rows[0].status, 'armed');
  assert.equal(rows[0].next_scan_at_ms, BASE_TIME + 1_100);
  const controlIndexes = new Set(
    (
      await context.database
        .getQueryInterface()
        .showIndex(APPROVED_ACTION_RECOVERY_CONTROL_TABLE)
    ).map((index) => index.name),
  );
  for (const name of [
    APPROVED_ACTION_RECOVERY_DUE_INDEX,
    APPROVED_ACTION_RECOVERY_PROJECT_INDEX,
    APPROVED_ACTION_RECOVERY_LEASE_INDEX,
  ]) {
    assert.ok(controlIndexes.has(name));
  }
  const resolutionIndexes = new Set(
    (
      await context.database
        .getQueryInterface()
        .showIndex(APPROVED_ACTION_RECOVERY_RESOLUTION_TABLE)
    ).map((index) => index.name),
  );
  assert.ok(
    resolutionIndexes.has(APPROVED_ACTION_RECOVERY_RESOLUTION_MUTATION_INDEX),
  );
  assert.ok(
    resolutionIndexes.has(APPROVED_ACTION_RECOVERY_RESOLUTION_PROJECT_INDEX),
  );
});

test('start barrier atomically arms recovery and rolls back when control insert fails', async (t) => {
  const context = await setup(t);
  const dispatch = await prepareDispatch(
    context.approvalService,
    'start-atomic',
  );
  const claimed = await context.actionRepository.claim({
    dispatchId: dispatch.id,
    owner: 'dispatcher-1',
    leaseToken: 'execution-lease-1',
    nowMs: BASE_TIME + 1_000,
    leaseDurationMs: 100,
  });
  await context.database.query(
    `CREATE TRIGGER fail_recovery_control_insert
       BEFORE INSERT ON "${APPROVED_ACTION_RECOVERY_CONTROL_TABLE}"
       BEGIN SELECT RAISE(ABORT, 'forced recovery insert failure'); END`,
  );
  await assert.rejects(
    context.actionRepository.start({
      dispatchId: dispatch.id,
      approvalRequestId: dispatch.approvalRequestId,
      actionDigest: dispatch.action.actionDigest,
      owner: 'dispatcher-1',
      leaseToken: 'execution-lease-1',
      expectedVersion: claimed.snapshot.execution.version,
      startedAtMs: BASE_TIME + 1_010,
    }),
    ApprovedActionDispatchRepositoryError,
  );
  assert.equal(
    (await context.actionRepository.findById(dispatch.id)).execution.status,
    'leased',
  );
  assert.equal(await context.recoveryRepository.findById(dispatch.id), null);
});

test('normal completion closes the recovery control without creating a recovery resolution', async (t) => {
  const context = await setup(t);
  const dispatch = await prepareDispatch(context.approvalService, 'complete');
  const execution = await startAction(context.actionRepository, dispatch);
  const armed = await context.recoveryRepository.findById(dispatch.id);
  assert.equal(armed.recovery.status, 'armed');
  assert.equal(
    armed.recovery.executionVersion,
    execution.started.execution.version,
  );
  assert.equal(armed.recovery.nextScanAtMs, execution.leaseExpiresAtMs);
  const completed = await context.actionRepository.complete({
    dispatchId: dispatch.id,
    owner: execution.owner,
    leaseToken: execution.leaseToken,
    expectedVersion: execution.started.execution.version,
    resultMutationId: 'normal-completion-1',
    outcome: 'succeeded',
    resultCode: 'ok',
    completedAtMs: BASE_TIME + 1_120,
  });
  assert.equal(completed.execution.status, 'succeeded');
  const closed = await context.recoveryRepository.findById(dispatch.id);
  assert.equal(closed.recovery.status, 'resolved');
  assert.equal(closed.recovery.resolutionMutationId, 'normal-completion-1');
  assert.equal(closed.resolution, null);
  assert.equal(
    (await claimRecovery(context.recoveryRepository, dispatch.id)).status,
    'resolved',
  );
});

test('a late execution renew re-arms recovery and fences the stale resolver lease', async (t) => {
  const context = await setup(t);
  const dispatch = await prepareDispatch(context.approvalService, 'renew');
  const execution = await startAction(context.actionRepository, dispatch);
  const claimed = await claimRecovery(context.recoveryRepository, dispatch.id);
  assert.equal(claimed.status, 'claimed');
  const renewed = await context.actionRepository.renew({
    dispatchId: dispatch.id,
    owner: execution.owner,
    leaseToken: execution.leaseToken,
    expectedVersion: execution.started.execution.version,
    nowMs: BASE_TIME + 1_150,
    leaseDurationMs: 1_000,
  });
  assert.equal(
    renewed.execution.version,
    execution.started.execution.version + 1,
  );
  const rearmed = await context.recoveryRepository.findById(dispatch.id);
  assert.equal(rearmed.recovery.status, 'armed');
  assert.equal(rearmed.recovery.executionVersion, renewed.execution.version);
  assert.equal(rearmed.recovery.nextScanAtMs, BASE_TIME + 2_150);
  assert.equal(rearmed.recovery.leaseOwner, null);
  await assert.rejects(
    context.recoveryRepository.recordFinding({
      dispatchId: dispatch.id,
      expectedExecutionVersion: claimed.snapshot.action.execution.version,
      expectedRecoveryVersion: claimed.snapshot.recovery.version,
      owner: 'resolver-1',
      leaseToken: 'recovery-lease-1',
      findingMutationId: 'stale-finding-1',
      finding: 'missing',
      resultCode: 'receipt_missing',
      observedAtMs: BASE_TIME + 1_160,
      retryAtMs: BASE_TIME + 1_200,
    }),
    ApprovedActionRecoveryFenceRejectedError,
  );
});

test('lists a bounded stable recovery page and excludes live executions', async (t) => {
  const context = await setup(t);
  const firstDispatch = await prepareDispatch(
    context.approvalService,
    'due-a',
    0,
    'a',
  );
  const secondDispatch = await prepareDispatch(
    context.approvalService,
    'due-b',
    10,
    'b',
  );
  const liveDispatch = await prepareDispatch(
    context.approvalService,
    'live',
    20,
    'c',
  );
  await startAction(context.actionRepository, firstDispatch);
  await startAction(context.actionRepository, secondDispatch);
  await startAction(context.actionRepository, liveDispatch, {
    leaseDurationMs: 1_000,
  });
  const first = await context.recoveryRepository.listDue({
    nowMs: BASE_TIME + 1_100,
    limit: 1,
  });
  assert.deepEqual(
    first.recoveries.map((entry) => entry.action.dispatch.id),
    ['dispatch-due-a'],
  );
  assert.equal(first.truncated, true);
  const second = await context.recoveryRepository.listDue({
    nowMs: BASE_TIME + 1_100,
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    second.recoveries.map((entry) => entry.action.dispatch.id),
    ['dispatch-due-b'],
  );
  assert.equal(second.truncated, false);
});

test('two SQLite resolvers claim once and only an expired recovery lease is taken over', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const storage = path.join(directory, 'database.sqlite');
  const first = await setup(t, storage);
  const dispatch = await prepareDispatch(first.approvalService, 'claim-race');
  await startAction(first.actionRepository, dispatch);
  const secondDatabase = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
  t.after(() => secondDatabase.close());
  const secondRepository = new LegacySequelizeApprovedActionRecoveryRepository(
    secondDatabase,
  );
  const results = await Promise.all([
    claimRecovery(first.recoveryRepository, dispatch.id, {
      leaseDurationMs: 100,
    }),
    claimRecovery(secondRepository, dispatch.id, {
      owner: 'resolver-2',
      leaseToken: 'recovery-lease-2',
      leaseDurationMs: 100,
    }),
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
      await claimRecovery(first.recoveryRepository, dispatch.id, {
        owner: winner.snapshot.recovery.leaseOwner,
        leaseToken: winner.snapshot.recovery.leaseToken,
        leaseDurationMs: 100,
      })
    ).status,
    'claimed',
  );
  const takeover = await claimRecovery(secondRepository, dispatch.id, {
    owner: 'resolver-3',
    leaseToken: 'recovery-lease-3',
    nowMs: BASE_TIME + 1_200,
    leaseDurationMs: 100,
  });
  assert.equal(takeover.status, 'claimed');
  assert.equal(takeover.snapshot.recovery.leaseOwner, 'resolver-3');
});

test('recovery finding replay is exact and unsupported evidence becomes manual-only', async (t) => {
  const context = await setup(t);
  const dispatch = await prepareDispatch(context.approvalService, 'finding');
  await startAction(context.actionRepository, dispatch);
  const claimed = await claimRecovery(context.recoveryRepository, dispatch.id);
  assert.equal(claimed.status, 'claimed');
  const finding = {
    dispatchId: dispatch.id,
    expectedExecutionVersion: claimed.snapshot.action.execution.version,
    expectedRecoveryVersion: claimed.snapshot.recovery.version,
    owner: 'resolver-1',
    leaseToken: 'recovery-lease-1',
    findingMutationId: 'finding-missing-1',
    finding: 'missing',
    resultCode: 'receipt_missing',
    observedAtMs: BASE_TIME + 1_110,
    retryAtMs: BASE_TIME + 1_200,
  };
  const deferred = await context.recoveryRepository.recordFinding(finding);
  assert.equal(deferred.recovery.status, 'armed');
  assert.equal(deferred.recovery.findingCount, 1);
  assert.deepEqual(
    await context.recoveryRepository.recordFinding(finding),
    deferred,
  );
  assert.equal(
    (
      await claimRecovery(context.recoveryRepository, dispatch.id, {
        nowMs: BASE_TIME + 1_199,
      })
    ).status,
    'not_due',
  );
  const second = await claimRecovery(context.recoveryRepository, dispatch.id, {
    owner: 'resolver-2',
    leaseToken: 'recovery-lease-2',
    nowMs: BASE_TIME + 1_200,
  });
  assert.equal(second.status, 'claimed');
  const manual = await context.recoveryRepository.recordFinding({
    dispatchId: dispatch.id,
    expectedExecutionVersion: second.snapshot.action.execution.version,
    expectedRecoveryVersion: second.snapshot.recovery.version,
    owner: 'resolver-2',
    leaseToken: 'recovery-lease-2',
    findingMutationId: 'finding-unsupported-1',
    finding: 'unsupported',
    resultCode: 'automatic_recovery_unsupported',
    observedAtMs: BASE_TIME + 1_210,
  });
  assert.equal(manual.recovery.status, 'manual_required');
  assert.equal(manual.recovery.nextScanAtMs, null);
  assert.equal(
    (
      await context.recoveryRepository.listDue({
        nowMs: BASE_TIME + 10_000,
        limit: 64,
      })
    ).recoveries.length,
    0,
  );
});

test('verified evidence resolves atomically and exact mutation replay returns the same resolution', async (t) => {
  const context = await setup(t);
  const dispatch = await prepareDispatch(context.approvalService, 'verified');
  await startAction(context.actionRepository, dispatch);
  const claimed = await claimRecovery(context.recoveryRepository, dispatch.id);
  const command = {
    dispatchId: dispatch.id,
    expectedExecutionVersion: claimed.snapshot.action.execution.version,
    expectedRecoveryVersion: claimed.snapshot.recovery.version,
    owner: 'resolver-1',
    leaseToken: 'recovery-lease-1',
    mutationId: 'resolution-verified-1',
    source: 'automatic_evidence',
    decision: 'confirm_succeeded',
    evidenceDigest: 'e'.repeat(64),
    reasonCode: 'provider_receipt_verified',
    resolvedAtMs: BASE_TIME + 1_120,
  };
  const resolved = await context.recoveryRepository.resolve(command);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.snapshot.action.execution.status, 'succeeded');
  assert.equal(resolved.snapshot.recovery.status, 'resolved');
  assert.equal(resolved.snapshot.resolution.source, 'automatic_evidence');
  assert.equal(resolved.snapshot.resolution.evidenceDigest, 'e'.repeat(64));
  assert.deepEqual(await context.recoveryRepository.resolve(command), resolved);
});

test('manual resolution cannot preempt a live execution and never resets it for retry', async (t) => {
  const context = await setup(t);
  const dispatch = await prepareDispatch(context.approvalService, 'manual');
  const execution = await startAction(context.actionRepository, dispatch, {
    leaseDurationMs: 500,
  });
  const armed = await context.recoveryRepository.findById(dispatch.id);
  const commandAt = (resolvedAtMs) => {
    const command = {
      dispatchId: dispatch.id,
      expectedExecutionVersion: armed.action.execution.version,
      expectedRecoveryVersion: armed.recovery.version,
      mutationId: 'resolution-manual-1',
      source: 'human',
      decision: 'abandon_unknown',
      reasonCode: 'operator_abandoned_unknown',
      resolvedBy: OWNER,
      resolvedAtMs,
    };
    return {
      ...command,
      authorizationFact: createApprovedActionRecoveryAuthorizationFact({
        dispatchId: dispatch.id,
        projectId: PROJECT_ID,
        mutationId: command.mutationId,
        resolvedBy: OWNER,
        authenticationId: 'mfa-session-1',
        assurance: 'multi_factor',
        authenticatedAtMs: resolvedAtMs - 100,
        projectVersion: 1,
        bindingVersion: 1,
        authorizedAtMs: resolvedAtMs,
      }),
    };
  };
  await assert.rejects(
    context.recoveryRepository.resolve(
      commandAt(execution.leaseExpiresAtMs - 1),
    ),
    ApprovedActionRecoveryFenceRejectedError,
  );
  const resolved = await context.recoveryRepository.resolve(
    commandAt(execution.leaseExpiresAtMs),
  );
  assert.equal(resolved.snapshot.action.execution.status, 'blocked');
  assert.equal(resolved.snapshot.resolution.decision, 'abandon_unknown');
  assert.equal(resolved.snapshot.resolution.resolvedBy.type, 'user');
  assert.equal(resolved.snapshot.action.execution.eligibleAtMs, null);
});

test('late completion and recovery resolution have one durable terminal winner', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ql-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const storage = path.join(directory, 'database.sqlite');
  const first = await setup(t, storage);
  const dispatch = await prepareDispatch(first.approvalService, 'race');
  const execution = await startAction(first.actionRepository, dispatch);
  const secondDatabase = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
  t.after(() => secondDatabase.close());
  const secondRecovery = new LegacySequelizeApprovedActionRecoveryRepository(
    secondDatabase,
  );
  const claimed = await claimRecovery(secondRecovery, dispatch.id);
  const recoveryCommand = {
    dispatchId: dispatch.id,
    expectedExecutionVersion: claimed.snapshot.action.execution.version,
    expectedRecoveryVersion: claimed.snapshot.recovery.version,
    owner: 'resolver-1',
    leaseToken: 'recovery-lease-1',
    mutationId: 'resolution-race-1',
    source: 'automatic_evidence',
    decision: 'confirm_failed',
    evidenceDigest: 'd'.repeat(64),
    reasonCode: 'provider_failed',
    resolvedAtMs: BASE_TIME + 1_120,
  };
  await Promise.allSettled([
    first.actionRepository.complete({
      dispatchId: dispatch.id,
      owner: execution.owner,
      leaseToken: execution.leaseToken,
      expectedVersion: execution.started.execution.version,
      resultMutationId: 'normal-race-1',
      outcome: 'succeeded',
      resultCode: 'ok',
      completedAtMs: BASE_TIME + 1_120,
    }),
    secondRecovery.resolve(recoveryCommand),
  ]);
  const final = await secondRecovery.findById(dispatch.id);
  assert.ok(['succeeded', 'failed'].includes(final.action.execution.status));
  assert.equal(final.recovery.status, 'resolved');
  assert.equal(
    final.recovery.resolutionMutationId,
    final.action.execution.resultMutationId,
  );
  if (final.resolution) {
    assert.equal(final.resolution.mutationId, 'resolution-race-1');
    assert.equal(final.action.execution.status, 'failed');
  } else {
    assert.equal(final.action.execution.resultMutationId, 'normal-race-1');
    assert.equal(final.action.execution.status, 'succeeded');
  }
});
