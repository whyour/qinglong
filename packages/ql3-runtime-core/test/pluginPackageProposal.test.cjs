const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  createPluginPackageInstallProposal,
  normalizePluginPackageInstallProposal,
  resolvePluginPackageInstallProposal,
  PluginPackageInstallProposalBindingConflictError,
} = require('@qinglong/runtime-core/plugin-package-proposal');

const REQUESTER = Object.freeze({ type: 'user', id: 'usr_owner' });
const SYSTEM = Object.freeze({ type: 'system', id: 'package_dispatcher' });
const FENCE = Object.freeze({ projectVersion: 1, bindingVersion: 1 });

function proposal() {
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
  return createPluginPackageInstallProposal({
    actionRef: 'proposal:monitor-v1',
    actionInput: {
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
    },
    proposedBy: REQUESTER,
    proposalFence: FENCE,
    createdAtMs: 5,
  });
}

function dispatch(candidate) {
  const action = {
    permission: candidate.permission,
    actionType: candidate.actionType,
    actionRef: candidate.actionRef,
    actionDigest: candidate.actionDigest,
    previewDigest: candidate.previewDigest,
  };
  const pending = createApprovalRequest({
    id: 'approval-monitor-v1',
    projectId: candidate.projectId,
    action,
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
  return consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consume-monitor-v1',
    dispatchId: 'dispatch-monitor-v1',
    action,
    requestedBy: REQUESTER,
    consumedBy: SYSTEM,
    consumedAtMs: 30,
    authorizationFence: FENCE,
  }).dispatch;
}

test('freezes the complete install input before approval and resolves the exact lock', () => {
  const candidate = proposal();
  assert.deepEqual(normalizePluginPackageInstallProposal(candidate), candidate);
  const approvedDispatch = dispatch(candidate);
  const lock = resolvePluginPackageInstallProposal(
    candidate,
    approvedDispatch,
    40,
  );
  assert.equal(lock.actionDigest, candidate.actionDigest);
  assert.equal(lock.planDigest, candidate.previewDigest);
  assert.equal(lock.approval.dispatchId, approvedDispatch.id);
  assert.equal(lock.packageName, 'example-monitor');
});

test('rejects proposal content drift and dispatch substitution', () => {
  const candidate = proposal();
  assert.throws(
    () =>
      normalizePluginPackageInstallProposal({
        ...candidate,
        actionInput: {
          ...candidate.actionInput,
          source: {
            ...candidate.actionInput.source,
            contentDigest: 'c'.repeat(64),
          },
        },
      }),
    TypeError,
  );
  const approvedDispatch = dispatch(candidate);
  assert.throws(
    () =>
      resolvePluginPackageInstallProposal(
        candidate,
        {
          ...approvedDispatch,
          requestedBy: { type: 'user', id: 'usr_other' },
        },
        40,
      ),
    PluginPackageInstallProposalBindingConflictError,
  );
});
