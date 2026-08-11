const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  createLocalPluginPackageManagementService,
} = require('@qinglong/local-admin/package-management');
const {
  LocalSqliteOperationAuthority,
} = require('@qinglong/local-sqlite/operation-authority');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('@qinglong/local-sqlite/plugin-package-install');
const {
  migrateLocalSqliteDatabase,
} = require('@qinglong/local-sqlite/migration');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');

const OWNER = Object.freeze({ type: 'user', id: 'usr_owner' });
const CONSUMER = Object.freeze({
  subject: { type: 'system', id: 'local_package_dispatcher' },
  authenticationId: 'local-package-dispatcher-auth',
});

function actionInput() {
  const manifest = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.2.0',
      description: 'One bounded package',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: ['edge'],
      },
      runtimes: [],
      resources: {
        memory: { recommended: '16Mi' },
        disk: { install: '4Mi', working: '16Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [],
        tools: [],
      },
      contents: { tasks: [], workflows: [], prompts: [], tools: [] },
    },
  };
  const environment = {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'edge',
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
  return {
    lockId: 'proposal-monitor-v1',
    projectId: 'default',
    manifest,
    plan: planPluginPackageInstall(manifest, environment),
    environment,
    source: {
      kind: 'offline',
      locator: `offline:sha256:${'a'.repeat(64)}`,
      artifactDigest: 'a'.repeat(64),
      artifactBytes: 2_048,
      contentDigest: 'b'.repeat(64),
    },
    architecture: 'arm64',
    deploymentProfile: 'edge',
    targetGeneration: 1,
  };
}

function principal(now, assurance = 'single_factor') {
  return {
    subject: OWNER,
    authenticationId: `auth-owner-${assurance}`,
    authenticatedAtMs: now - 100,
    expiresAtMs: now + 100_000,
    assurance,
  };
}

test('runs authenticated local proposal, self-confirmation, consumption and admission end to end', async (t) => {
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
  const authority = new LocalSqliteOperationAuthority(client);
  let now = Date.now();
  const requestedAtMs = now;
  let generatedId = 0;
  const service = createLocalPluginPackageManagementService({
    authority,
    profile: 'edge',
    consumer: CONSUMER,
    dispatcher: {
      owner: 'local_package_dispatcher_1',
      clock: () => now,
      createId: () => `dispatcher-id-${++generatedId}`,
    },
    now: () => now,
  });
  const proposalRequest = {
    actionRef: 'proposal:monitor-v1',
    approvalRequestId: 'approval-monitor-v1',
    proposalAuditEventId: '10000000-0000-4000-8000-000000000001',
    approvalAuditEventId: '10000000-0000-4000-8000-000000000002',
    requestedAtMs,
    actionInput: actionInput(),
    principal: principal(now),
  };
  const proposed = await service.propose(proposalRequest);
  assert.equal(proposed.proposalStatus, 'created');
  assert.equal(proposed.approvalStatus, 'created');
  assert.equal(proposed.approvalRequest.decisionMode, 'human_confirmation');
  const replayed = await service.propose(proposalRequest);
  assert.equal(replayed.proposalStatus, 'existing');
  assert.equal(replayed.approvalStatus, 'existing');

  now = Date.now();
  const decided = await service.decide({
    approvalRequestId: 'approval-monitor-v1',
    expectedVersion: 1,
    decisionId: 'decision-monitor-v1',
    auditEventId: '10000000-0000-4000-8000-000000000003',
    decision: 'approved',
    reasonCode: 'reviewed',
    decidedAtMs: now,
    principal: principal(now, 'local_console'),
  });
  assert.equal(decided.request.state, 'approved');

  now = Date.now();
  const consumed = await service.consume({
    approvalRequestId: 'approval-monitor-v1',
    expectedVersion: 2,
    consumptionId: 'consume-monitor-v1',
    dispatchId: 'dispatch-monitor-v1',
    auditEventId: '10000000-0000-4000-8000-000000000004',
    consumedAtMs: now,
  });
  assert.equal(consumed.request.state, 'consumed');

  now = Date.now();
  const dispatched = await service.dispatch();
  assert.equal(dispatched.scanned, 1);
  assert.equal(dispatched.started, 1);
  assert.equal(dispatched.succeeded, 1);
  const installation = await new LocalSqlitePluginPackageInstallRepository(
    authority,
  ).find('default', 'example-monitor');
  assert.equal(installation.state, 'queued');
  assert.equal(installation.targetGeneration, 1);

  const inspected = await service.inspect(
    'proposal:monitor-v1',
    'approval-monitor-v1',
  );
  assert.equal(inspected.proposal.actionRef, 'proposal:monitor-v1');
  assert.equal(inspected.approvalRequest.state, 'consumed');
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count
         FROM "QingLong3SecurityAuditEvents"
         WHERE "operation_id" IN (
           'plugin_package.propose',
           'approval.request',
           'approval.decide',
           'approval.consume',
           'plugin_package.admit'
         )`,
      )
      .get().count,
    5,
  );
  assert.equal(
    require('..').createLocalPluginPackageManagementService,
    undefined,
  );
});

test('rejects weak decisions and expired management commands before mutation', async (t) => {
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
  const authority = new LocalSqliteOperationAuthority(client);
  let now = Date.now();
  const requestedAtMs = now;
  const service = createLocalPluginPackageManagementService({
    authority,
    profile: 'edge',
    consumer: CONSUMER,
    dispatcher: {
      owner: 'local_package_dispatcher_2',
      clock: () => now,
      createId: () => 'dispatcher-id-fixed',
    },
    approvalLifetimeMs: 1_000,
    now: () => now,
  });
  await service.propose({
    actionRef: 'proposal:monitor-weak-v1',
    approvalRequestId: 'approval-monitor-weak-v1',
    proposalAuditEventId: '20000000-0000-4000-8000-000000000001',
    approvalAuditEventId: '20000000-0000-4000-8000-000000000002',
    requestedAtMs,
    actionInput: actionInput(),
    principal: principal(now),
  });
  now = requestedAtMs + 100;
  await assert.rejects(
    service.decide({
      approvalRequestId: 'approval-monitor-weak-v1',
      expectedVersion: 1,
      decisionId: 'decision-monitor-weak-v1',
      auditEventId: '20000000-0000-4000-8000-000000000003',
      decision: 'approved',
      reasonCode: 'reviewed',
      decidedAtMs: now,
      principal: principal(now),
    }),
    { code: 'APPROVAL_HUMAN_DECISION_REQUIRED' },
  );
  now = requestedAtMs + 1_000;
  await assert.rejects(
    service.propose({
      actionRef: 'proposal:expired-v1',
      approvalRequestId: 'approval-expired-v1',
      proposalAuditEventId: '20000000-0000-4000-8000-000000000004',
      approvalAuditEventId: '20000000-0000-4000-8000-000000000005',
      requestedAtMs,
      actionInput: actionInput(),
      principal: principal(now),
    }),
    { code: 'PLUGIN_PACKAGE_MANAGEMENT_REQUEST_INVALID' },
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count
         FROM "QingLong3SecurityAuditEvents"
         WHERE "operation_id" = 'approval.decide'`,
      )
      .get().count,
    0,
  );
});
