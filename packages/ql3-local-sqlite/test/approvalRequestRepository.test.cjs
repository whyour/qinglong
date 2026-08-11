const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  ApprovalMutationConflictError,
  ApprovalPolicyFenceConflictError,
  ApprovalUnavailableError,
  createApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  LocalSqliteApprovalRequestRepository,
} = require('@qinglong/local-sqlite/approved-action');
const {
  migrateLocalSqliteDatabase,
} = require('@qinglong/local-sqlite/migration');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const REQUESTER = Object.freeze({ type: 'user', id: 'usr_owner' });
const SYSTEM = Object.freeze({ type: 'system', id: 'approved-dispatcher' });
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });

function action(overrides = {}) {
  return {
    permission: 'package.manage',
    actionType: 'plugin_package.install',
    actionRef: 'proposal:pkg-demo-v1',
    actionDigest: DIGEST_A,
    previewDigest: DIGEST_B,
    ...overrides,
  };
}

function request(id = 'approval-1') {
  return createApprovalRequest({
    id,
    projectId: 'default',
    action: action(),
    risk: 'high',
    decisionMode: 'human_confirmation',
    requestedBy: REQUESTER,
    requestedAtMs: 1_000,
    expiresAtMs: 61_000,
    requestFence: FENCE,
  });
}

function audit(eventId, operationId, subject, authenticationId, outcome, atMs) {
  return {
    eventId,
    requestId: 'request-http-1',
    operationId,
    projectId: 'default',
    subject,
    authenticationId,
    outcome,
    reasons: [outcome === 'approval_required' ? 'package_review' : 'role_grant'],
    fence: FENCE,
    occurredAtMs: atMs,
  };
}

function createCommand(overrides = {}) {
  return {
    request: request(),
    audit: audit(
      '10000000-0000-4000-8000-000000000001',
      'approval.request',
      REQUESTER,
      'auth-requester-1',
      'approval_required',
      1_000,
    ),
    ...overrides,
  };
}

function decideCommand(overrides = {}) {
  return {
    requestId: 'approval-1',
    expectedVersion: 1,
    decisionId: 'decision-1',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: REQUESTER,
      authenticationId: 'auth-step-up-1',
      authenticatedAtMs: 1_500,
      expiresAtMs: 10_000,
      assurance: 'local_console',
    },
    decidedAtMs: 2_000,
    authorizationFence: FENCE,
    audit: audit(
      '10000000-0000-4000-8000-000000000002',
      'approval.decide',
      REQUESTER,
      'auth-step-up-1',
      'allowed',
      2_000,
    ),
    ...overrides,
  };
}

function consumeCommand(overrides = {}) {
  return {
    requestId: 'approval-1',
    expectedVersion: 2,
    consumptionId: 'consume-1',
    dispatchId: 'dispatch-1',
    action: action(),
    requestedBy: REQUESTER,
    consumedBy: SYSTEM,
    consumedAtMs: 3_000,
    authorizationFence: FENCE,
    audit: audit(
      '10000000-0000-4000-8000-000000000003',
      'approval.consume',
      SYSTEM,
      'auth-dispatcher-1',
      'allowed',
      3_000,
    ),
    ...overrides,
  };
}

async function fixture(t) {
  const client = new DatabaseSync(':memory:');
  t.after(() => client.close());
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  client
    .prepare(
      `INSERT INTO "QingLong3ProjectRoleBindings"
       ("project_id","subject_type","subject_id","version","state","role",
        "mutation_id","changed_by_type","changed_by_id","created_at_ms")
       VALUES ('default','user','usr_owner',1,'active','owner',
               'grant-owner-1','user','usr_owner',0)`,
    )
    .run();
  return {
    client,
    repository: new LocalSqliteApprovalRequestRepository(client),
  };
}

test('persists request, strong decision, dispatch and audit with exact replay', async (t) => {
  const { client, repository } = await fixture(t);
  assert.equal((await repository.create(createCommand())).status, 'created');
  assert.equal((await repository.create(createCommand())).status, 'existing');

  const decided = await repository.decide(decideCommand());
  assert.equal(decided.status, 'decided');
  assert.equal(decided.request.state, 'approved');
  assert.equal((await repository.decide(decideCommand())).status, 'existing');

  const consumed = await repository.consume(consumeCommand());
  assert.equal(consumed.status, 'consumed');
  assert.equal(consumed.request.state, 'consumed');
  assert.equal(consumed.dispatch.approvedBy.id, 'usr_owner');
  assert.equal(
    (await repository.consume(consumeCommand())).status,
    'existing',
  );
  assert.deepEqual(
    await repository.findDispatchById('dispatch-1'),
    consumed.dispatch,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count FROM "QingLong3SecurityAuditEvents"
         WHERE "operation_id" LIKE 'approval.%'`,
      )
      .get().count,
    3,
  );
});

test('rejects replay drift and rolls request plus audit back together', async (t) => {
  const { client, repository } = await fixture(t);
  await repository.create(createCommand());
  await assert.rejects(
    repository.create(
      createCommand({
        audit: {
          ...createCommand().audit,
          reasons: ['changed'],
        },
      }),
    ),
    ApprovalMutationConflictError,
  );
  await assert.rejects(
    repository.decide(
      decideCommand({
        audit: {
          ...decideCommand().audit,
          operationId: 'approval.consume',
        },
      }),
    ),
    ApprovalMutationConflictError,
  );
  assert.equal((await repository.findById('approval-1')).state, 'pending');
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count FROM "QingLong3SecurityAuditEvents"
         WHERE "operation_id" = 'approval.decide'`,
      )
      .get().count,
    0,
  );
});

test('fences a role change before decision without partial audit', async (t) => {
  const { client, repository } = await fixture(t);
  await repository.create(createCommand());
  client
    .prepare(
      `INSERT INTO "QingLong3ProjectRoleBindings"
       ("project_id","subject_type","subject_id","version","state","role",
        "mutation_id","changed_by_type","changed_by_id","created_at_ms")
       VALUES ('default','user','usr_owner',2,'active','owner',
               'grant-owner-2','user','usr_owner',1500)`,
    )
    .run();
  await assert.rejects(
    repository.decide(decideCommand()),
    ApprovalPolicyFenceConflictError,
  );
  assert.equal((await repository.findById('approval-1')).state, 'pending');
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count FROM "QingLong3SecurityAuditEvents"
         WHERE "event_id" = '10000000-0000-4000-8000-000000000002'`,
      )
      .get().count,
    0,
  );
});

test('fails closed when stored canonical request or dispatch JSON drifts', async (t) => {
  const { client, repository } = await fixture(t);
  await repository.create(createCommand());
  client
    .prepare(
      `UPDATE "QingLong3ApprovalRequests"
       SET "request_json" = json_set("request_json", '$.risk', 'low')
       WHERE "request_id" = 'approval-1'`,
    )
    .run();
  await assert.rejects(
    repository.findById('approval-1'),
    ApprovalUnavailableError,
  );
});

test('runs an optional authentication guard inside every mutation transaction', async (t) => {
  const client = new DatabaseSync(':memory:');
  t.after(() => client.close());
  client.exec('PRAGMA foreign_keys = ON');
  await migrateLocalSqliteDatabase(client);
  client
    .prepare(
      `INSERT INTO "QingLong3ProjectRoleBindings"
       ("project_id","subject_type","subject_id","version","state","role",
        "mutation_id","changed_by_type","changed_by_id","created_at_ms")
       VALUES ('default','user','usr_owner',1,'active','owner',
               '10000000-0000-4000-8000-000000000099','user','usr_owner',1)`
    )
    .run();
  let admitted = false;
  let guardCalls = 0;
  const repository = new LocalSqliteApprovalRequestRepository(client, () => {
    guardCalls += 1;
    if (!admitted) throw new Error('credential fence rejected');
  });
  await assert.rejects(
    repository.create(createCommand()),
    ApprovalUnavailableError,
  );
  assert.equal(guardCalls, 1);
  assert.equal(await repository.findById('approval-1'), null);
  admitted = true;
  await repository.create(createCommand());
  await repository.decide(decideCommand());
  await repository.consume(consumeCommand());
  assert.equal(guardCalls, 4);
});

test('exports the authority only through the approved-action subpath', () => {
  const root = require('@qinglong/local-sqlite');
  const subpath = require('@qinglong/local-sqlite/approved-action');
  assert.equal(root.LocalSqliteApprovalRequestRepository, undefined);
  assert.equal(
    subpath.LocalSqliteApprovalRequestRepository,
    LocalSqliteApprovalRequestRepository,
  );
});
