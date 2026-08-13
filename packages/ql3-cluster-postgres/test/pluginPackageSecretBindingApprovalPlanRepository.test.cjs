'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  approvalRequestDigest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  PLUGIN_PACKAGE_API_VERSION,
  PLUGIN_PACKAGE_KIND,
  planPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package');
const {
  createPluginPackageInstall,
  createPluginPackageLock,
  pluginPackageActivationIntentDigest,
  pluginPackageInstallActionDigest,
  pluginPackageInstallPlanDigest,
  transitionPluginPackageInstall,
} = require('@qinglong/runtime-core/plugin-package-install');
const {
  createPluginPackageInstallProposal,
} = require('@qinglong/runtime-core/plugin-package-proposal');
const {
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  createPluginPackageSecretBindingPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-plan');
const {
  PluginPackageSecretBindingApprovalPlanConflictError,
  PluginPackageSecretBindingApprovalPlanUnavailableError,
  createPluginPackageSecretBindingApprovalPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-approval-plan');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  PostgresPluginPackageSecretBindingApprovalPlanReader,
  PostgresPluginPackageSecretBindingApprovalPlanRepository,
} = require('../dist/plugin-package/secret-binding/pluginPackageSecretBindingApprovalPlanRepository');

function fixture() {
  const manifest = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.0.0',
      description: 'PostgreSQL Secret binding plan fixture',
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
        memory: { recommended: '32Mi' },
        disk: { install: '4Mi', working: '8Mi' },
      },
      permissions: {
        network: { allowedHosts: [] },
        secrets: [{ name: 'TOKEN', required: true }],
        tools: ['secret.use'],
      },
      contents: { tasks: [], workflows: [], prompts: [], tools: [] },
    },
  };
  const environment = {
    qinglongVersion: '3.0.0-alpha.0',
    architecture: 'arm64',
    deploymentProfile: 'cluster-control',
    runtimes: [],
    availableMemoryBytes: 128 * 1024 * 1024,
    availableDiskBytes: 256 * 1024 * 1024,
  };
  const installPlan = planPluginPackageInstall(manifest, environment);
  const actionInput = {
    lockId: 'lock-secret-binding-1',
    projectId: 'project-1',
    manifest,
    plan: installPlan,
    environment,
    source: {
      kind: 'offline',
      locator: `offline:sha256:${'a'.repeat(64)}`,
      artifactDigest: 'a'.repeat(64),
      artifactBytes: 2048,
      contentDigest: 'b'.repeat(64),
    },
    architecture: 'arm64',
    deploymentProfile: 'cluster-control',
    targetGeneration: 1,
  };
  const proposal = createPluginPackageInstallProposal({
    actionRef: 'proposal:secret-binding-install-v1',
    actionInput,
    proposedBy: { type: 'user', id: 'cluster-owner' },
    proposalFence: { projectVersion: 1, bindingVersion: 1 },
    createdAtMs: 90,
  });
  const lock = createPluginPackageLock({
    ...actionInput,
    approval: {
      requestId: 'approval-secret-binding-install-v1',
      requestVersion: 1,
      dispatchId: 'dispatch-secret-binding-install-v1',
      actionDigest: pluginPackageInstallActionDigest(actionInput),
      previewDigest: pluginPackageInstallPlanDigest(installPlan),
      approvedBy: { type: 'user', id: 'install-reviewer' },
      approvedAtMs: 100,
      expiresAtMs: 1_000,
      fence: { projectVersion: 1, bindingVersion: 1 },
    },
    createdAtMs: 200,
  });
  const queued = createPluginPackageInstall(lock, {
    installationId: 'install-secret-binding-1',
    mutationId: 'mutation-secret-binding-create',
    occurredAtMs: 201,
  });
  const staged = transitionPluginPackageInstall(lock, queued, {
    type: 'stage_completed',
    mutationId: 'mutation-secret-binding-stage',
    occurredAtMs: 202,
    stageRef: 'stage-secret-binding-1',
    artifactDigest: lock.source.artifactDigest,
    manifestDigest: lock.manifestDigest,
    contentDigest: lock.source.contentDigest,
    evidenceDigest: 'c'.repeat(64),
  });
  const activating = transitionPluginPackageInstall(lock, staged, {
    type: 'activation_started',
    mutationId: 'mutation-secret-binding-activate',
    occurredAtMs: 203,
  });
  const record = transitionPluginPackageInstall(lock, activating, {
    type: 'activation_committed',
    mutationId: 'mutation-secret-binding-commit',
    occurredAtMs: 204,
    activationRef: 'activation-secret-binding-1',
    intentDigest: pluginPackageActivationIntentDigest(lock, activating),
    generation: 1,
    contentDigest: lock.source.contentDigest,
  });
  const generation = createPluginPackageResourceGeneration({
    installationId: record.installationId,
    projectId: record.projectId,
    packageName: record.packageName,
    lockDigest: record.lockDigest,
    generation: record.targetGeneration,
    previousActiveLockDigest: record.previousActiveLockDigest,
    contentDigest: lock.source.contentDigest,
    contents: manifest.spec.contents,
  });
  const bindingPlan = createPluginPackageSecretBindingPlan({
    generation,
    manifest,
    assignments: [
      {
        name: 'TOKEN',
        secretRef: createSecretRef({
          projectId: 'project-1',
          name: 'runtime-token',
          version: 2,
        }),
      },
    ],
    plannedAtMs: 300,
  });
  const approvalPlan = createPluginPackageSecretBindingApprovalPlan({
    actionRef: 'secret-binding:example-monitor-v1',
    bindingPlan,
    requestedBy: { type: 'user', id: 'cluster-owner' },
    expiresAtMs: 900,
  });
  return { approvalPlan, lock, proposal, record };
}

test('reads and creates one exact approval plan only through the narrow database function', async () => {
  const { approvalPlan } = fixture();
  const calls = [];
  const repository =
    new PostgresPluginPackageSecretBindingApprovalPlanRepository({
      async query(text, parameters) {
        calls.push({ text, parameters });
        if (
          text.includes('create_plugin_package_secret_binding_approval_plan')
        ) {
          return { rows: [{ status: 'created' }] };
        }
        return { rows: [{ planJson: approvalPlan }] };
      },
    });

  const result = await repository.create(approvalPlan);
  assert.deepEqual(result, { status: 'created', plan: approvalPlan });
  assert.equal(calls.length, 2);
  assert.match(
    calls[0].text,
    /create_plugin_package_secret_binding_approval_plan/,
  );
  assert.deepEqual(calls[0].parameters, [JSON.stringify(approvalPlan)]);
  assert.doesNotMatch(calls[0].text, /INSERT INTO/);
  assert.match(calls[1].text, /WHERE action_ref = \$1/);
});

test('loads one current unbound generation snapshot and rejects provenance drift', async () => {
  const { lock, proposal, record } = fixture();
  const pool = {
    async query(text, parameters) {
      assert.match(text, /plugin_package_secret_binding_planning_snapshot/);
      assert.deepEqual(parameters, ['project-1', 'example-monitor']);
      return {
        rows: [
          {
            recordJson: record,
            lockJson: lock,
            proposalJson: proposal,
            observedAtMs: '500',
          },
        ],
      };
    },
  };
  const reader = new PostgresPluginPackageSecretBindingApprovalPlanReader(pool);
  assert.deepEqual(
    await reader.loadPlanningSnapshot('project-1', 'example-monitor'),
    { record, lock, proposal, observedAtMs: 500 },
  );

  const drifted = new PostgresPluginPackageSecretBindingApprovalPlanReader({
    async query() {
      return {
        rows: [
          {
            recordJson: record,
            lockJson: lock,
            proposalJson: { ...proposal, previewDigest: 'f'.repeat(64) },
            observedAtMs: 500,
          },
        ],
      };
    },
  });
  await assert.rejects(
    drifted.loadPlanningSnapshot('project-1', 'example-monitor'),
    PluginPackageSecretBindingApprovalPlanUnavailableError,
  );
});

test('returns absence and fails closed on replay drift or storage conflict', async () => {
  const { approvalPlan } = fixture();
  const reader = new PostgresPluginPackageSecretBindingApprovalPlanReader({
    async query() {
      return { rows: [] };
    },
  });
  assert.equal(await reader.findByActionRef(approvalPlan.actionRef), null);

  const otherPlan = createPluginPackageSecretBindingApprovalPlan({
    actionRef: approvalPlan.actionRef,
    bindingPlan: approvalPlan.bindingPlan,
    requestedBy: { type: 'user', id: 'another-owner' },
    expiresAtMs: approvalPlan.expiresAtMs,
  });

  const drifted = new PostgresPluginPackageSecretBindingApprovalPlanRepository({
    async query(text) {
      return text.includes('create_plugin_package_secret_binding_approval_plan')
        ? { rows: [{ status: 'existing' }] }
        : { rows: [{ planJson: otherPlan }] };
    },
  });
  await assert.rejects(
    drifted.create(approvalPlan),
    PluginPackageSecretBindingApprovalPlanConflictError,
  );

  const conflict = new PostgresPluginPackageSecretBindingApprovalPlanRepository(
    {
      async query() {
        const error = new Error('unique violation');
        error.code = '23505';
        throw error;
      },
    },
  );
  await assert.rejects(
    conflict.create(approvalPlan),
    PluginPackageSecretBindingApprovalPlanConflictError,
  );
});

test('lists only a bounded digest-verified approved Secret binding queue', async () => {
  const { approvalPlan } = fixture();
  const pending = createApprovalRequest({
    id: 'approval-secret-binding-list-1',
    projectId: approvalPlan.bindingPlan.target.projectId,
    action: require('@qinglong/runtime-core/plugin-package-secret-binding-approval-plan')
      .pluginPackageSecretBindingApprovedAction(approvalPlan),
    risk: 'high',
    decisionMode: 'separation_of_duty',
    requestedBy: approvalPlan.requestedBy,
    requestedAtMs: 301,
    expiresAtMs: 800,
    requestFence: { projectVersion: 1, bindingVersion: 1 },
  });
  const approved = decideApprovalRequest(pending, {
    expectedVersion: 1,
    decisionId: 'decision-secret-binding-list-1',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: { type: 'user', id: 'security-reviewer' },
      authenticationId: 'auth-security-reviewer',
      authenticatedAtMs: 302,
      expiresAtMs: 700,
      assurance: 'multi_factor',
    },
    decidedAtMs: 303,
    authorizationFence: { projectVersion: 1, bindingVersion: 1 },
  });
  const calls = [];
  const reader = new PostgresPluginPackageSecretBindingApprovalPlanReader({
    async query(text, parameters) {
      calls.push({ text, parameters });
      return {
        rows: [{
          requestJson: approved,
          requestDigest: approvalRequestDigest(approved),
        }],
      };
    },
  });
  assert.deepEqual(await reader.listApprovedRequests(4), [approved]);
  assert.match(calls[0].text, /request\.state = 'approved'/);
  assert.match(calls[0].text, /plugin_package\.secret_binding\.bind/);
  assert.deepEqual(calls[0].parameters, [4]);
  await assert.rejects(reader.listApprovedRequests(65), TypeError);

  const corrupt = new PostgresPluginPackageSecretBindingApprovalPlanReader({
    async query() {
      return {
        rows: [{ requestJson: approved, requestDigest: 'f'.repeat(64) }],
      };
    },
  });
  await assert.rejects(
    corrupt.listApprovedRequests(4),
    PluginPackageSecretBindingApprovalPlanUnavailableError,
  );
});

test('exports plan creation only to the Package manager and readback to the executor', () => {
  const manager = require('@qinglong/cluster-postgres/package-manager');
  const executor = require('@qinglong/cluster-postgres/package-executor');
  assert.equal(
    manager.PostgresPluginPackageSecretBindingApprovalPlanRepository,
    PostgresPluginPackageSecretBindingApprovalPlanRepository,
  );
  assert.equal(
    executor.PostgresPluginPackageSecretBindingApprovalPlanRepository,
    undefined,
  );
  assert.equal(
    executor.PostgresPluginPackageSecretBindingApprovalPlanReader,
    PostgresPluginPackageSecretBindingApprovalPlanReader,
  );
});
