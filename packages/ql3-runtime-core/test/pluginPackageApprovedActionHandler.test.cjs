const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  claimApprovedActionExecution,
  createApprovedActionExecution,
  startApprovedActionExecution,
} = require('@qinglong/runtime-core/approved-action-execution');
const {
  PluginPackageAdmissionBindingConflictError,
  bindPluginPackageAdmission,
} = require('@qinglong/runtime-core/plugin-package-admission');
const {
  PluginPackageApprovedActionHandler,
} = require('@qinglong/runtime-core/plugin-package-approved-action');
const {
  createPluginPackageInstallProposal,
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

const REQUESTER = Object.freeze({ type: 'user', id: 'usr_owner' });
const CONSUMER = Object.freeze({ type: 'system', id: 'package_dispatcher' });
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });

function actionInput() {
  const manifest = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'handler-monitor',
      displayName: 'Handler Monitor',
      version: '1.0.0',
      description: 'One deterministic handler package',
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
    lockId: 'proposal-handler-v1',
    projectId: 'default',
    manifest,
    plan,
    environment,
    source: {
      kind: 'offline',
      locator: `offline:sha256:${'a'.repeat(64)}`,
      artifactDigest: 'a'.repeat(64),
      artifactBytes: 1024,
      contentDigest: 'b'.repeat(64),
    },
    architecture: 'arm64',
    deploymentProfile: 'edge',
    targetGeneration: 1,
  };
}

function fixture() {
  const input = actionInput();
  const action = {
    permission: 'package.manage',
    actionType: 'plugin_package.install',
    actionRef: 'proposal:handler-v1',
    actionDigest: pluginPackageInstallActionDigest(input),
    previewDigest: pluginPackageInstallPlanDigest(input.plan),
  };
  const pending = createApprovalRequest({
    id: 'approval-handler-v1',
    projectId: 'default',
    action,
    risk: 'high',
    decisionMode: 'human_confirmation',
    requestedBy: REQUESTER,
    requestedAtMs: 10,
    expiresAtMs: 10_000,
    requestFence: FENCE,
  });
  const approved = decideApprovalRequest(pending, {
    expectedVersion: 1,
    decisionId: 'decision-handler-v1',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: REQUESTER,
      authenticationId: 'auth-owner',
      authenticatedAtMs: 15,
      expiresAtMs: 5_000,
      assurance: 'local_console',
    },
    decidedAtMs: 20,
    authorizationFence: FENCE,
  });
  const dispatch = consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consume-handler-v1',
    dispatchId: 'dispatch-handler-v1',
    action,
    requestedBy: REQUESTER,
    consumedBy: CONSUMER,
    consumedAtMs: 30,
    authorizationFence: FENCE,
  }).dispatch;
  const proposal = createPluginPackageInstallProposal({
    actionRef: action.actionRef,
    actionInput: input,
    proposedBy: REQUESTER,
    proposalFence: FENCE,
    createdAtMs: 5,
  });
  const claimed = claimApprovedActionExecution(
    createApprovedActionExecution(dispatch),
    {
      owner: 'dispatcher_instance_1',
      leaseToken: 'lease-handler-v1',
      nowMs: 35,
      leaseDurationMs: 1_000,
    },
  );
  const execution = startApprovedActionExecution(
    { dispatch, execution: claimed },
    {
      dispatchId: dispatch.id,
      approvalRequestId: dispatch.approvalRequestId,
      actionDigest: dispatch.action.actionDigest,
      owner: 'dispatcher_instance_1',
      leaseToken: 'lease-handler-v1',
      expectedVersion: claimed.version,
      startedAtMs: 40,
    },
  );
  return {
    dispatch,
    proposal,
    execution,
    context: {
      dispatch,
      execution,
      idempotencyKey: dispatch.id,
      fence: {
        owner: execution.leaseOwner,
        leaseToken: execution.leaseToken,
        version: execution.version,
      },
    },
  };
}

class ProposalAuthority {
  constructor(proposal, mode = 'found') {
    this.proposal = proposal;
    this.mode = mode;
  }

  async findProposalByActionRef() {
    if (this.mode === 'unavailable') throw new Error('proposal unavailable');
    return this.mode === 'missing' ? null : this.proposal;
  }

  async createProposal() {
    throw new Error('handler is read-only over proposal authority');
  }
}

class AdmissionAuthority {
  constructor(value, options = {}) {
    this.value = value;
    this.loseResponse = options.loseResponse === true;
    this.reject = options.reject === true;
    this.requests = [];
    this.receipt = null;
    this.record = null;
  }

  async admit(request) {
    this.requests.push(request);
    if (this.reject) throw new PluginPackageAdmissionBindingConflictError();
    const bound = bindPluginPackageAdmission(
      this.value.dispatch,
      this.value.proposal,
      this.value.execution,
      request,
      null,
      this.value.execution.startedAtMs,
    );
    this.receipt = bound.receipt;
    this.record = bound.create.record;
    if (this.loseResponse) throw new Error('commit response lost');
    return {
      status: 'admitted',
      receipt: this.receipt,
      record: this.record,
    };
  }

  async findAdmissionReceipt(dispatchId) {
    return this.receipt?.dispatchId === dispatchId ? this.receipt : null;
  }

  async find(projectId, packageName) {
    return this.record?.projectId === projectId &&
      this.record?.packageName === packageName
      ? this.record
      : null;
  }
}

test('inspects the immutable proposal and emits one deterministic admission', async () => {
  const value = fixture();
  const admissions = new AdmissionAuthority(value);
  const handler = new PluginPackageApprovedActionHandler(
    new ProposalAuthority(value.proposal),
    admissions,
  );
  assert.deepEqual(await handler.inspect(value.dispatch), {
    status: 'ready',
    actionDigest: value.dispatch.action.actionDigest,
  });
  const first = await handler.execute(value.context);
  const second = await handler.execute(value.context);
  assert.deepEqual(first, second);
  assert.equal(first.outcome, 'succeeded');
  assert.equal(first.resultDigest, admissions.receipt.receiptDigest);
  assert.equal(admissions.requests.length, 2);
  assert.equal(
    admissions.requests[0].installationId,
    admissions.requests[1].installationId,
  );
  assert.equal(
    admissions.requests[0].mutationId,
    admissions.requests[1].mutationId,
  );
  assert.equal(
    admissions.requests[0].audit.eventId,
    admissions.requests[1].audit.eventId,
  );
  assert.match(
    admissions.requests[0].audit.eventId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('converges an admission commit response loss from the durable receipt', async () => {
  const value = fixture();
  const admissions = new AdmissionAuthority(value, { loseResponse: true });
  const result = await new PluginPackageApprovedActionHandler(
    new ProposalAuthority(value.proposal),
    admissions,
  ).execute(value.context);
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.resultCode, 'package_admitted');
  assert.equal(result.resultDigest, admissions.receipt.receiptDigest);
  assert.equal(admissions.requests.length, 1);
});

test('classifies proposal and admission failures without widening authority', async () => {
  const value = fixture();
  const missing = new PluginPackageApprovedActionHandler(
    new ProposalAuthority(value.proposal, 'missing'),
    new AdmissionAuthority(value),
  );
  assert.deepEqual(await missing.inspect(value.dispatch), {
    status: 'blocked',
    resultCode: 'package_proposal_missing',
  });
  const unavailable = new PluginPackageApprovedActionHandler(
    new ProposalAuthority(value.proposal, 'unavailable'),
    new AdmissionAuthority(value),
  );
  assert.deepEqual(await unavailable.inspect(value.dispatch), {
    status: 'retry',
    resultCode: 'package_proposal_unavailable',
  });
  const rejected = await new PluginPackageApprovedActionHandler(
    new ProposalAuthority(value.proposal),
    new AdmissionAuthority(value, { reject: true }),
  ).execute(value.context);
  assert.deepEqual(rejected, {
    outcome: 'failed',
    resultCode: 'package_admission_rejected',
  });
});
