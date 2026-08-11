const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  createPluginPackageManagementService,
  PluginPackageManagementAuthorizationError,
  PluginPackageManagementQuotaExceededError,
} = require('@qinglong/runtime-core/plugin-package-management');
const {
  ProjectPolicyEngine,
} = require('@qinglong/runtime-core/project-policy');

const REQUESTER = Object.freeze({ type: 'user', id: 'usr_requester' });
const REVIEWER = Object.freeze({ type: 'user', id: 'usr_reviewer' });
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });

function actionInput() {
  const manifest = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'management-test',
      displayName: 'Management Test',
      version: '1.0.0',
      description: 'Management facade contract',
      license: 'Apache-2.0',
    },
    spec: {
      compatibility: {
        qinglong: '>=3.0.0-0 <4.0.0',
        architectures: ['arm64'],
        deploymentProfiles: ['cluster-control'],
      },
      runtimes: [],
      resources: {
        memory: { recommended: '16Mi' },
        disk: { install: '4Mi', working: '8Mi' },
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
    deploymentProfile: 'cluster-control',
    runtimes: [],
    availableMemoryBytes: 512 * 1024 * 1024,
    availableDiskBytes: 1024 * 1024 * 1024,
  };
  return {
    lockId: 'management-test-lock-v1',
    projectId: 'default',
    manifest,
    plan: planPluginPackageInstall(manifest, environment),
    environment,
    source: {
      kind: 'oci',
      locator: `oci://registry.example/qinglong/management-test@sha256:${'a'.repeat(
        64,
      )}`,
      artifactDigest: 'b'.repeat(64),
      artifactBytes: 4_096,
      contentDigest: 'c'.repeat(64),
    },
    architecture: 'arm64',
    deploymentProfile: 'cluster-control',
    targetGeneration: 1,
  };
}

function principal(subject, assurance, now) {
  return {
    subject,
    authenticationId: `auth-${subject.id}-${assurance}`,
    authenticatedAtMs: now - 10,
    expiresAtMs: now + 10_000,
    assurance,
  };
}

class MemoryProposalRepository {
  proposal = null;
  command = null;

  async findProposalByActionRef(actionRef) {
    return this.proposal?.actionRef === actionRef ? this.proposal : null;
  }

  async createProposal(command) {
    this.command = command;
    this.proposal = command.proposal;
    return { status: 'created', proposal: this.proposal };
  }
}

class MemoryApprovalRepository {
  request = null;
  dispatch = null;
  audits = [];

  async findById(id) {
    return this.request?.id === id ? this.request : null;
  }

  async findDispatchById(id) {
    return this.dispatch?.id === id ? this.dispatch : null;
  }

  async create(command) {
    this.request = command.request;
    this.audits.push(command.audit);
    return { status: 'created', request: this.request };
  }

  async decide(command) {
    const { requestId: _requestId, audit, ...domainCommand } = command;
    this.request = decideApprovalRequest(this.request, domainCommand);
    this.audits.push(audit);
    return { status: 'decided', request: this.request };
  }

  async consume(command) {
    const { requestId: _requestId, audit, ...domainCommand } = command;
    const result = consumeApprovalRequest(this.request, domainCommand);
    this.request = result.request;
    this.dispatch = result.dispatch;
    this.audits.push(audit);
    return { status: 'consumed', ...result };
  }
}

function fixture(decisionMode = 'separation_of_duty', quota) {
  const policyRepository = {
    async resolve(projectId, subject) {
      if (projectId !== 'default') return null;
      const role =
        subject.id === REQUESTER.id
          ? 'owner'
          : subject.id === REVIEWER.id
          ? 'admin'
          : subject.id === 'usr_operator'
          ? 'operator'
          : null;
      return {
        project: {
          id: 'default',
          name: 'Default',
          slug: 'default',
          status: 'active',
          version: 1,
          createdAtMs: 0,
          updatedAtMs: 0,
        },
        ...(role
          ? {
              binding: {
                projectId: 'default',
                subject,
                version: 1,
                state: 'active',
                role,
                mutationId: `grant-${subject.id}`,
                changedBy: REQUESTER,
                createdAtMs: 0,
              },
            }
          : {}),
      };
    },
    async append() {
      throw new Error('management facade must not mutate Project Policy');
    },
  };
  const proposals = new MemoryProposalRepository();
  const approvals = new MemoryApprovalRepository();
  const dispatchCalls = [];
  let now = 1_000;
  const service = createPluginPackageManagementService(
    new ProjectPolicyEngine(policyRepository),
    proposals,
    approvals,
    {
      async dispatchBatch(options) {
        dispatchCalls.push(options);
        return {
          scanned: 0,
          claimed: 0,
          started: 0,
          succeeded: 0,
          failed: 0,
          blocked: 0,
          retrying: 0,
          deferred: 0,
          recoveryRequired: 0,
          alreadyTerminal: 0,
          unavailable: 0,
          truncated: false,
        };
      },
    },
    {
      decisionMode,
      consumer: {
        subject: { type: 'system', id: 'package_dispatcher' },
        authenticationId: 'package-dispatcher-auth',
      },
      now: () => now,
      ...(quota ? { quota } : {}),
    },
  );
  return {
    service,
    proposals,
    approvals,
    dispatchCalls,
    setNow(value) {
      now = value;
    },
  };
}

test('orchestrates one separation-of-duty Package approval without transport authority', async () => {
  const value = fixture();
  const proposed = await value.service.propose({
    actionRef: 'proposal:management-test-v1',
    approvalRequestId: 'approval-management-test-v1',
    proposalAuditEventId: '30000000-0000-4000-8000-000000000001',
    approvalAuditEventId: '30000000-0000-4000-8000-000000000002',
    requestedAtMs: 1_000,
    actionInput: actionInput(),
    principal: principal(REQUESTER, 'single_factor', 1_000),
  });
  assert.equal(proposed.approvalRequest.decisionMode, 'separation_of_duty');
  assert.equal(
    value.proposals.command.audit.operationId,
    'plugin_package.propose',
  );
  assert.equal(value.approvals.audits[0].operationId, 'approval.request');

  value.setNow(1_100);
  await assert.rejects(
    value.service.decide({
      approvalRequestId: 'approval-management-test-v1',
      expectedVersion: 1,
      decisionId: 'decision-self-v1',
      auditEventId: '30000000-0000-4000-8000-000000000003',
      decision: 'approved',
      reasonCode: 'reviewed',
      decidedAtMs: 1_100,
      principal: principal(REQUESTER, 'hardware', 1_100),
    }),
    { code: 'APPROVAL_SEPARATION_OF_DUTY_REQUIRED' },
  );
  const decided = await value.service.decide({
    approvalRequestId: 'approval-management-test-v1',
    expectedVersion: 1,
    decisionId: 'decision-reviewer-v1',
    auditEventId: '30000000-0000-4000-8000-000000000004',
    decision: 'approved',
    reasonCode: 'reviewed',
    decidedAtMs: 1_100,
    principal: principal(REVIEWER, 'hardware', 1_100),
  });
  assert.equal(decided.request.decidedBy.id, REVIEWER.id);

  value.setNow(1_200);
  const consumed = await value.service.consume({
    approvalRequestId: 'approval-management-test-v1',
    expectedVersion: 2,
    consumptionId: 'consume-management-test-v1',
    dispatchId: 'dispatch-management-test-v1',
    auditEventId: '30000000-0000-4000-8000-000000000005',
    consumedAtMs: 1_200,
  });
  assert.equal(consumed.dispatch.consumedBy.type, 'system');
  assert.equal(consumed.dispatch.consumedBy.id, 'package_dispatcher');

  assert.equal((await value.service.dispatch(16)).scanned, 0);
  assert.deepEqual(value.dispatchCalls, [{ limit: 16 }]);
  assert.equal(
    require('../dist').createPluginPackageManagementService,
    undefined,
  );
});

test('consumes durable quota only after Project authorization and before mutation', async () => {
  assert.throws(
    () => new PluginPackageManagementQuotaExceededError(0),
    TypeError,
  );
  assert.throws(
    () => new PluginPackageManagementQuotaExceededError(300_001),
    TypeError,
  );
  const quotaCalls = [];
  const value = fixture('separation_of_duty', {
    async consume(command) {
      quotaCalls.push(command);
      return { remaining: 9, resetAtMs: 60_000, observedAtMs: 1_000 };
    },
  });
  await value.service.propose({
    actionRef: 'proposal:quota-v1',
    approvalRequestId: 'approval-quota-v1',
    proposalAuditEventId: '50000000-0000-4000-8000-000000000001',
    approvalAuditEventId: '50000000-0000-4000-8000-000000000002',
    requestedAtMs: 1_000,
    actionInput: actionInput(),
    principal: principal(REQUESTER, 'multi_factor', 1_000),
  });
  assert.deepEqual(quotaCalls, [
    {
      projectId: 'default',
      subject: REQUESTER,
      operation: 'plugin-package.propose',
      idempotencyKey: 'proposal:quota-v1',
    },
  ]);

  value.setNow(1_100);
  await value.service.decide({
    approvalRequestId: 'approval-quota-v1',
    expectedVersion: 1,
    decisionId: 'decision-quota-v1',
    auditEventId: '50000000-0000-4000-8000-000000000003',
    decision: 'approved',
    reasonCode: 'reviewed',
    decidedAtMs: 1_100,
    principal: principal(REVIEWER, 'hardware', 1_100),
  });
  assert.deepEqual(quotaCalls[1], {
    projectId: 'default',
    subject: REVIEWER,
    operation: 'plugin-package.decide',
    idempotencyKey: 'decision-quota-v1',
  });

  const deniedCalls = [];
  const denied = fixture('human_confirmation', {
    async consume(command) {
      deniedCalls.push(command);
      throw new PluginPackageManagementQuotaExceededError(5_000);
    },
  });
  await assert.rejects(
    denied.service.propose({
      actionRef: 'proposal:quota-denied-v1',
      approvalRequestId: 'approval-quota-denied-v1',
      proposalAuditEventId: '50000000-0000-4000-8000-000000000004',
      approvalAuditEventId: '50000000-0000-4000-8000-000000000005',
      requestedAtMs: 1_000,
      actionInput: actionInput(),
      principal: principal(REQUESTER, 'multi_factor', 1_000),
    }),
    PluginPackageManagementQuotaExceededError,
  );
  assert.equal(deniedCalls.length, 1);
  assert.equal(denied.proposals.proposal, null);
  assert.equal(denied.approvals.request, null);

  const unauthorized = fixture('human_confirmation', {
    async consume(command) {
      deniedCalls.push(command);
      throw new Error('must not run');
    },
  });
  await assert.rejects(
    unauthorized.service.propose({
      actionRef: 'proposal:quota-unauthorized-v1',
      approvalRequestId: 'approval-quota-unauthorized-v1',
      proposalAuditEventId: '50000000-0000-4000-8000-000000000006',
      approvalAuditEventId: '50000000-0000-4000-8000-000000000007',
      requestedAtMs: 1_000,
      actionInput: actionInput(),
      principal: principal(
        { type: 'user', id: 'usr_operator' },
        'multi_factor',
        1_000,
      ),
    }),
    PluginPackageManagementAuthorizationError,
  );
  assert.equal(deniedCalls.length, 1);
});

test('denies operator Package proposals before proposal or Approval mutation', async () => {
  const value = fixture('human_confirmation');
  await assert.rejects(
    value.service.propose({
      actionRef: 'proposal:operator-v1',
      approvalRequestId: 'approval-operator-v1',
      proposalAuditEventId: '40000000-0000-4000-8000-000000000001',
      approvalAuditEventId: '40000000-0000-4000-8000-000000000002',
      requestedAtMs: 1_000,
      actionInput: actionInput(),
      principal: principal(
        { type: 'user', id: 'usr_operator' },
        'single_factor',
        1_000,
      ),
    }),
    PluginPackageManagementAuthorizationError,
  );
  assert.equal(value.proposals.proposal, null);
  assert.equal(value.approvals.request, null);
});
