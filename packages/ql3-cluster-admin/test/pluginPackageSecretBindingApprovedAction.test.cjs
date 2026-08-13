'use strict';

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
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  createPluginPackageSecretBindingApprovalPlan,
  pluginPackageSecretBindingApprovedAction,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-approval-plan');
const {
  createPluginPackageSecretBindingPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-plan');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  ClusterPluginPackageSecretBindingApprovedActionHandler,
} = require('@qinglong/cluster-admin/plugin-package-secret-binding-approved-action');

const REQUESTER = Object.freeze({ type: 'user', id: 'cluster-owner' });
const REVIEWER = Object.freeze({ type: 'user', id: 'security-reviewer' });
const CONSUMER = Object.freeze({
  type: 'system',
  id: 'cluster_package_executor',
});
const FENCE = Object.freeze({ projectVersion: 3, bindingVersion: 4 });

function approvalPlan() {
  const manifest = {
    apiVersion: 'qinglong.io/v1alpha1',
    kind: 'Package',
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.0.0',
      description: 'Secret binding handler fixture',
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
  const generation = createPluginPackageResourceGeneration({
    installationId: 'install-secret-binding-1',
    projectId: 'project-1',
    packageName: 'example-monitor',
    lockDigest: 'a'.repeat(64),
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: 'b'.repeat(64),
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
    plannedAtMs: 100,
  });
  return createPluginPackageSecretBindingApprovalPlan({
    actionRef: 'secret-binding:example-monitor-v1',
    bindingPlan,
    requestedBy: REQUESTER,
    expiresAtMs: 1_000,
  });
}

function dispatch(plan) {
  const action = pluginPackageSecretBindingApprovedAction(plan);
  const pending = createApprovalRequest({
    id: 'approval-secret-binding-1',
    projectId: plan.bindingPlan.target.projectId,
    action,
    risk: 'high',
    decisionMode: 'separation_of_duty',
    requestedBy: REQUESTER,
    requestedAtMs: 110,
    expiresAtMs: 900,
    requestFence: FENCE,
  });
  const approved = decideApprovalRequest(pending, {
    expectedVersion: 1,
    decisionId: 'decision-secret-binding-1',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: {
      subject: REVIEWER,
      authenticationId: 'auth-reviewer',
      authenticatedAtMs: 100,
      expiresAtMs: 800,
      assurance: 'multi_factor',
    },
    decidedAtMs: 120,
    authorizationFence: FENCE,
  });
  return consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consume-secret-binding-1',
    dispatchId: 'dispatch-secret-binding-1',
    action,
    requestedBy: REQUESTER,
    consumedBy: CONSUMER,
    consumedAtMs: 130,
    authorizationFence: FENCE,
  }).dispatch;
}

function execution(approvedDispatch) {
  const claimed = claimApprovedActionExecution(
    createApprovedActionExecution(approvedDispatch, 5),
    {
      owner: 'secret-binding-executor',
      leaseToken: 'lease-secret-binding-1',
      nowMs: 131,
      leaseDurationMs: 500,
    },
  );
  assert.equal(claimed.status, 'leased');
  return startApprovedActionExecution(
    { dispatch: approvedDispatch, execution: claimed },
    {
      dispatchId: approvedDispatch.id,
      approvalRequestId: approvedDispatch.approvalRequestId,
      actionDigest: approvedDispatch.action.actionDigest,
      owner: claimed.leaseOwner,
      leaseToken: claimed.leaseToken,
      expectedVersion: claimed.version,
      startedAtMs: 140,
    },
  );
}

function handler(plan, stored = new Map()) {
  return new ClusterPluginPackageSecretBindingApprovedActionHandler(
    {
      async findByActionRef(actionRef) {
        return actionRef === plan?.actionRef ? plan : null;
      },
    },
    {
      async find(generationDigest) {
        return stored.get(generationDigest) ?? null;
      },
      async publish(binding) {
        const key = binding.target.generationDigest;
        const existing = stored.get(key);
        if (existing) return { status: 'existing', binding: existing };
        stored.set(key, binding);
        return { status: 'created', binding };
      },
    },
    {
      async assertExists() {},
    },
  );
}

test('publishes exactly the approved content-free binding and replays it', async () => {
  const plan = approvalPlan();
  const approvedDispatch = dispatch(plan);
  const started = execution(approvedDispatch);
  const stored = new Map();
  const subject = handler(plan, stored);
  assert.deepEqual(await subject.inspect(approvedDispatch), {
    status: 'ready',
    actionDigest: plan.approvalPlanDigest,
  });
  const context = {
    dispatch: approvedDispatch,
    execution: started,
    idempotencyKey: approvedDispatch.id,
    fence: {
      owner: started.leaseOwner,
      leaseToken: started.leaseToken,
      version: started.version,
    },
  };
  const created = await subject.execute(context);
  const replay = await subject.execute(context);
  assert.equal(created.outcome, 'succeeded');
  assert.equal(created.resultCode, 'package_secret_binding_published');
  assert.equal(replay.resultCode, 'package_secret_binding_existing');
  assert.equal(replay.resultDigest, created.resultDigest);
  const binding = stored.get(plan.bindingPlan.target.generationDigest);
  assert.equal(binding.authority.kind, 'approved-action-execution');
  assert.equal(binding.authority.evidenceDigest, plan.approvalPlanDigest);
  assert.deepEqual(binding.entries, plan.bindingPlan.entries);
  assert.doesNotMatch(JSON.stringify(binding), /secret-value/);
});

test('blocks missing/drifted plans and rejects a stale execution fence', async () => {
  const plan = approvalPlan();
  const approvedDispatch = dispatch(plan);
  assert.deepEqual(await handler(null).inspect(approvedDispatch), {
    status: 'blocked',
    resultCode: 'package_secret_binding_plan_missing',
  });
  const drifted = { ...plan, approvalPlanDigest: 'f'.repeat(64) };
  assert.deepEqual(await handler(drifted).inspect(approvedDispatch), {
    status: 'blocked',
    resultCode: 'package_secret_binding_plan_rejected',
  });
  const started = execution(approvedDispatch);
  assert.deepEqual(
    await handler(plan).execute({
      dispatch: approvedDispatch,
      execution: started,
      idempotencyKey: approvedDispatch.id,
      fence: {
        owner: started.leaseOwner,
        leaseToken: started.leaseToken,
        version: started.version + 1,
      },
    }),
    {
      outcome: 'failed',
      resultCode: 'package_secret_binding_execution_rejected',
    },
  );
});
