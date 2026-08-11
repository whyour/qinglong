const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  PLUGIN_PACKAGE_ADMISSION_RECEIPT_SCHEMA,
  PLUGIN_PACKAGE_INSTALL_ACTION_TYPE,
  PluginPackageAdmissionBindingConflictError,
  InvalidPluginPackageAdmissionError,
  assertPluginPackageAdmissionReplay,
  bindPluginPackageAdmission,
  normalizePluginPackageAdmissionReceipt,
} = require('@qinglong/runtime-core/plugin-package-admission');
const {
  claimApprovedActionExecution,
  createApprovedActionExecution,
  startApprovedActionExecution,
} = require('@qinglong/runtime-core/approved-action-execution');
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

const REQUESTER = Object.freeze({ type: 'user', id: 'usr_owner' });
const SYSTEM = Object.freeze({ type: 'system', id: 'package_dispatcher' });
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });

function lockAction() {
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

function fixture() {
  const action = lockAction();
  const binding = {
    permission: 'package.manage',
    actionType: PLUGIN_PACKAGE_INSTALL_ACTION_TYPE,
    actionRef: 'proposal:monitor-v1',
    actionDigest: pluginPackageInstallActionDigest(action.input),
    previewDigest: pluginPackageInstallPlanDigest(action.plan),
  };
  const pending = createApprovalRequest({
    id: 'approval-monitor-v1',
    projectId: 'default',
    action: binding,
    risk: 'high',
    decisionMode: 'human_confirmation',
    requestedBy: REQUESTER,
    requestedAtMs: 10,
    expiresAtMs: 1_000,
    requestFence: FENCE,
  });
  const approved = decideApprovalRequest(pending, {
    expectedVersion: 1,
    decisionId: 'decision-monitor-v1',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: REQUESTER,
      authenticationId: 'auth-owner-step-up',
      authenticatedAtMs: 15,
      expiresAtMs: 500,
      assurance: 'local_console',
    },
    decidedAtMs: 20,
    authorizationFence: FENCE,
  });
  const consumed = consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consume-monitor-v1',
    dispatchId: 'dispatch-monitor-v1',
    action: binding,
    requestedBy: REQUESTER,
    consumedBy: SYSTEM,
    consumedAtMs: 30,
    authorizationFence: FENCE,
  });
  const proposal = createPluginPackageInstallProposal({
    actionRef: binding.actionRef,
    actionInput: action.input,
    proposedBy: REQUESTER,
    proposalFence: FENCE,
    createdAtMs: 5,
  });
  const claimedExecution = claimApprovedActionExecution(
    createApprovedActionExecution(consumed.dispatch),
    {
      owner: 'package_dispatcher',
      leaseToken: 'lease-monitor-v1',
      nowMs: 35,
      leaseDurationMs: 100,
    },
  );
  const execution = startApprovedActionExecution(
    { dispatch: consumed.dispatch, execution: claimedExecution },
    {
      dispatchId: consumed.dispatch.id,
      approvalRequestId: consumed.dispatch.approvalRequestId,
      actionDigest: consumed.dispatch.action.actionDigest,
      owner: 'package_dispatcher',
      leaseToken: 'lease-monitor-v1',
      expectedVersion: claimedExecution.version,
      startedAtMs: 40,
    },
  );
  const lock = resolvePluginPackageInstallProposal(
    proposal,
    consumed.dispatch,
    40,
  );
  const request = {
    lock,
    proposalDigest: proposal.proposalDigest,
    execution,
    installationId: 'install-monitor-v1',
    mutationId: 'admit-monitor-v1',
    admittedAtMs: 50,
    audit: {
      eventId: '10000000-0000-4000-8000-000000000010',
      requestId: consumed.dispatch.id,
      operationId: 'plugin_package.admit',
      projectId: 'default',
      subject: SYSTEM,
      authenticationId: 'auth-package-dispatcher',
      outcome: 'allowed',
      reasons: ['approved_action'],
      fence: FENCE,
      occurredAtMs: 50,
    },
  };
  return { dispatch: consumed.dispatch, proposal, execution, request };
}

test('binds one approved dispatch to a queued install and immutable receipt', () => {
  const { dispatch, proposal, execution, request } = fixture();
  const bound = bindPluginPackageAdmission(
    dispatch,
    proposal,
    execution,
    request,
    null,
    50,
  );
  assert.equal(bound.create.record.state, 'queued');
  assert.equal(bound.receipt.schema, PLUGIN_PACKAGE_ADMISSION_RECEIPT_SCHEMA);
  assert.equal(bound.receipt.dispatchId, dispatch.id);
  assert.equal(bound.receipt.installationId, request.installationId);
  assert.equal(bound.receipt.recordDigest, bound.create.record.recordDigest);
  assert.deepEqual(
    normalizePluginPackageAdmissionReceipt(bound.receipt),
    bound.receipt,
  );
  assert.doesNotThrow(() =>
    assertPluginPackageAdmissionReplay(
      dispatch,
      proposal,
      request,
      bound.receipt,
      bound.create.record,
    ),
  );
});

test('rejects dispatch, approval, audit and lifetime drift', () => {
  const { dispatch, proposal, execution, request } = fixture();
  for (const candidate of [
    {
      dispatch: {
        ...dispatch,
        action: { ...dispatch.action, actionType: 'task.run' },
      },
      request,
      ErrorType: PluginPackageAdmissionBindingConflictError,
    },
    {
      dispatch,
      request: {
        ...request,
        lock: {
          ...request.lock,
          approval: { ...request.lock.approval, requestVersion: 2 },
        },
      },
      ErrorType: TypeError,
    },
    {
      dispatch,
      request: {
        ...request,
        audit: { ...request.audit, reasons: ['role_grant'] },
      },
      ErrorType: PluginPackageAdmissionBindingConflictError,
    },
    {
      dispatch,
      request: { ...request, admittedAtMs: 1_000 },
      ErrorType: PluginPackageAdmissionBindingConflictError,
    },
  ]) {
    assert.throws(
      () =>
        bindPluginPackageAdmission(
          candidate.dispatch,
          proposal,
          execution,
          candidate.request,
          null,
          50,
        ),
      candidate.ErrorType,
    );
  }
});

test('rejects receipt digest drift', () => {
  const { dispatch, proposal, execution, request } = fixture();
  const bound = bindPluginPackageAdmission(
    dispatch,
    proposal,
    execution,
    request,
    null,
    50,
  );
  assert.throws(
    () =>
      normalizePluginPackageAdmissionReceipt({
        ...bound.receipt,
        admittedAtMs: 51,
      }),
    InvalidPluginPackageAdmissionError,
  );
});
