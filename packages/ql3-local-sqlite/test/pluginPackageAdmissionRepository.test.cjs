const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');

const {
  ApprovalPolicyFenceConflictError,
  createApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  PLUGIN_PACKAGE_INSTALL_ACTION_TYPE,
  PluginPackageAdmissionBindingConflictError,
  PluginPackageAdmissionReceiptConflictError,
} = require('@qinglong/runtime-core/plugin-package-admission');
const {
  createPluginPackageInstallProposal,
  resolvePluginPackageInstallProposal,
} = require('@qinglong/runtime-core/plugin-package-proposal');
const {
  pluginPackageInstallActionDigest,
  pluginPackageInstallPlanDigest,
} = require('@qinglong/runtime-core/plugin-package-install');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  LocalSqliteApprovalRequestRepository,
} = require('@qinglong/local-sqlite/approved-action');
const {
  LocalSqliteApprovedActionExecutionRepository,
} = require('@qinglong/local-sqlite/approved-action-execution');
const {
  migrateLocalSqliteDatabase,
} = require('@qinglong/local-sqlite/migration');
const {
  LocalSqlitePluginPackageInstallRepository,
} = require('@qinglong/local-sqlite/plugin-package-install');
const {
  LocalSqlitePluginPackageInstallProposalRepository,
} = require('@qinglong/local-sqlite/plugin-package-proposal');

const REQUESTER = Object.freeze({ type: 'user', id: 'usr_owner' });
const SYSTEM = Object.freeze({ type: 'system', id: 'package_dispatcher' });
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });

function packageAction() {
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
  const plan = planPluginPackageInstall(manifest, environment);
  return {
    input: {
      lockId: 'proposal-monitor-v1',
      projectId: 'default',
      manifest,
      plan,
      environment,
      source: {
        kind: 'offline',
        locator: `offline:sha256:${'a'.repeat(64)}`,
        artifactDigest: 'a'.repeat(64),
        artifactBytes: 2048,
        contentDigest: 'b'.repeat(64),
      },
      architecture: 'arm64',
      deploymentProfile: 'edge',
      targetGeneration: 1,
    },
    plan,
  };
}

function audit(
  eventId,
  requestId,
  operationId,
  subject,
  authenticationId,
  outcome,
  reasons,
  occurredAtMs,
) {
  return {
    eventId,
    requestId,
    operationId,
    projectId: 'default',
    subject,
    authenticationId,
    outcome,
    reasons,
    fence: FENCE,
    occurredAtMs,
  };
}

async function fixture(
  t,
  { admittedAtMs = Date.now(), leaseDurationMs = 60_000 } = {},
) {
  const proposedAtMs = admittedAtMs - 40;
  const requestedAtMs = admittedAtMs - 30;
  const decidedAtMs = admittedAtMs - 20;
  const consumedAtMs = admittedAtMs - 10;
  const claimedAtMs = admittedAtMs - 5;
  const expiresAtMs = admittedAtMs + 60_000;
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

  const action = packageAction();
  const binding = {
    permission: 'package.manage',
    actionType: PLUGIN_PACKAGE_INSTALL_ACTION_TYPE,
    actionRef: 'proposal:monitor-v1',
    actionDigest: pluginPackageInstallActionDigest(action.input),
    previewDigest: pluginPackageInstallPlanDigest(action.plan),
  };
  const proposal = createPluginPackageInstallProposal({
    actionRef: binding.actionRef,
    actionInput: action.input,
    proposedBy: REQUESTER,
    proposalFence: FENCE,
    createdAtMs: proposedAtMs,
  });
  await new LocalSqlitePluginPackageInstallProposalRepository(
    client,
  ).createProposal({
    proposal,
    audit: audit(
      '10000000-0000-4000-8000-000000000100',
      binding.actionRef,
      'plugin_package.propose',
      REQUESTER,
      'auth-owner',
      'allowed',
      ['package_proposal'],
      proposedAtMs,
    ),
  });
  const approval = new LocalSqliteApprovalRequestRepository(client);
  await approval.create({
    request: createApprovalRequest({
      id: 'approval-monitor-v1',
      projectId: 'default',
      action: binding,
      risk: 'high',
      decisionMode: 'human_confirmation',
      requestedBy: REQUESTER,
      requestedAtMs,
      expiresAtMs,
      requestFence: FENCE,
    }),
    audit: audit(
      '10000000-0000-4000-8000-000000000101',
      'http-request-1',
      'approval.request',
      REQUESTER,
      'auth-owner',
      'approval_required',
      ['package_review'],
      requestedAtMs,
    ),
  });
  await approval.decide({
    requestId: 'approval-monitor-v1',
    expectedVersion: 1,
    decisionId: 'decision-monitor-v1',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: REQUESTER,
      authenticationId: 'auth-owner-step-up',
      authenticatedAtMs: requestedAtMs,
      expiresAtMs,
      assurance: 'local_console',
    },
    decidedAtMs,
    authorizationFence: FENCE,
    audit: audit(
      '10000000-0000-4000-8000-000000000102',
      'http-request-1',
      'approval.decide',
      REQUESTER,
      'auth-owner-step-up',
      'allowed',
      ['role_grant'],
      decidedAtMs,
    ),
  });
  const consumed = await approval.consume({
    requestId: 'approval-monitor-v1',
    expectedVersion: 2,
    consumptionId: 'consume-monitor-v1',
    dispatchId: 'dispatch-monitor-v1',
    action: binding,
    requestedBy: REQUESTER,
    consumedBy: SYSTEM,
    consumedAtMs,
    authorizationFence: FENCE,
    audit: audit(
      '10000000-0000-4000-8000-000000000103',
      'dispatch-cycle-1',
      'approval.consume',
      SYSTEM,
      'auth-package-dispatcher',
      'allowed',
      ['role_grant'],
      consumedAtMs,
    ),
  });
  const executions = new LocalSqliteApprovedActionExecutionRepository(client);
  const claimed = await executions.claimExecution({
    dispatchId: consumed.dispatch.id,
    owner: 'package_dispatcher',
    leaseToken: 'lease-monitor-v1',
    nowMs: claimedAtMs,
    leaseDurationMs,
  });
  assert.equal(claimed.status, 'claimed');
  const started = await executions.startExecution({
    dispatchId: consumed.dispatch.id,
    approvalRequestId: consumed.dispatch.approvalRequestId,
    actionDigest: consumed.dispatch.action.actionDigest,
    owner: 'package_dispatcher',
    leaseToken: 'lease-monitor-v1',
    expectedVersion: claimed.snapshot.execution.version,
    startedAtMs: admittedAtMs,
  });
  const lock = resolvePluginPackageInstallProposal(
    proposal,
    consumed.dispatch,
    admittedAtMs,
  );
  return {
    client,
    executions,
    repository: new LocalSqlitePluginPackageInstallRepository(client),
    request: {
      lock,
      proposalDigest: proposal.proposalDigest,
      execution: started.execution,
      installationId: 'install-monitor-v1',
      mutationId: 'admit-monitor-v1',
      admittedAtMs,
      audit: audit(
        '10000000-0000-4000-8000-000000000104',
        consumed.dispatch.id,
        'plugin_package.admit',
        SYSTEM,
        'auth-package-dispatcher',
        'allowed',
        ['approved_action'],
        admittedAtMs,
      ),
    },
  };
}

test('admits one approved Package atomically and exactly replays its receipt', async (t) => {
  const { client, repository, request } = await fixture(t);
  const admitted = await repository.admit(request);
  assert.equal(admitted.status, 'admitted');
  assert.equal(admitted.record.state, 'queued');
  assert.equal(admitted.receipt.dispatchId, 'dispatch-monitor-v1');
  assert.deepEqual(
    await repository.findAdmissionReceipt('dispatch-monitor-v1'),
    admitted.receipt,
  );
  const replay = await repository.admit(request);
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay, { ...admitted, status: 'existing' });
  assert.deepEqual(
    {
      ...client
        .prepare(
        `SELECT
           (SELECT count(*) FROM "QingLong3PluginPackageInstalls") AS installs,
           (SELECT count(*) FROM "QingLong3PluginPackageInstallMutations") AS mutations,
           (SELECT count(*) FROM "QingLong3PluginPackageAdmissionReceipts") AS receipts,
           (SELECT count(*) FROM "QingLong3SecurityAuditEvents"
             WHERE "operation_id" = 'plugin_package.admit') AS audits`,
        )
        .get(),
    },
    { installs: 1, mutations: 1, receipts: 1, audits: 1 },
  );
  await assert.rejects(
    repository.admit({
      ...request,
      audit: { ...request.audit, authenticationId: 'auth-drift' },
    }),
    PluginPackageAdmissionReceiptConflictError,
  );
});

test('rejects proposal and execution fence drift before admission', async (t) => {
  const { client, executions, repository, request } = await fixture(t);
  await assert.rejects(
    repository.admit({
      ...request,
      proposalDigest: 'f'.repeat(64),
    }),
    PluginPackageAdmissionBindingConflictError,
  );
  await executions.renewExecution({
    dispatchId: request.execution.dispatchId,
    owner: request.execution.leaseOwner,
    leaseToken: request.execution.leaseToken,
    expectedVersion: request.execution.version,
    nowMs: request.admittedAtMs + 5,
    leaseDurationMs: 60_000,
  });
  await assert.rejects(
    repository.admit(request),
    PluginPackageAdmissionBindingConflictError,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count
         FROM "QingLong3PluginPackageAdmissionReceipts"`,
      )
      .get().count,
    0,
  );
});

test('rejects an admission observed after its durable execution lease expired', async (t) => {
  const { client, repository, request } = await fixture(t, {
    admittedAtMs: Date.now() - 100,
    leaseDurationMs: 20,
  });
  await assert.rejects(
    repository.admit(request),
    PluginPackageAdmissionBindingConflictError,
  );
  assert.equal(
    client
      .prepare(
        `SELECT count(*) AS count
         FROM "QingLong3PluginPackageAdmissionReceipts"`,
      )
      .get().count,
    0,
  );
});

test('rolls the full admission back when the requester Policy fence changed', async (t) => {
  const { client, repository, request } = await fixture(t);
  client
    .prepare(
      `INSERT INTO "QingLong3ProjectRoleBindings"
       ("project_id","subject_type","subject_id","version","state","role",
        "mutation_id","changed_by_type","changed_by_id","created_at_ms")
       VALUES ('default','user','usr_owner',2,'revoked',NULL,
               'revoke-owner-1','user','usr_owner',?)`,
    )
    .run(request.admittedAtMs + 5);
  await assert.rejects(
    repository.admit(request),
    ApprovalPolicyFenceConflictError,
  );
  assert.deepEqual(
    {
      ...client
        .prepare(
        `SELECT
           (SELECT count(*) FROM "QingLong3PluginPackageInstalls") AS installs,
           (SELECT count(*) FROM "QingLong3PluginPackageAdmissionReceipts") AS receipts,
           (SELECT count(*) FROM "QingLong3SecurityAuditEvents"
             WHERE "operation_id" = 'plugin_package.admit') AS audits`,
        )
        .get(),
    },
    { installs: 0, receipts: 0, audits: 0 },
  );
});
