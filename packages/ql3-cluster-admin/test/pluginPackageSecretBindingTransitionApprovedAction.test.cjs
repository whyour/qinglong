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
  createPluginPackageSecretBinding,
} = require('@qinglong/runtime-core/plugin-package-secret-binding');
const {
  createPluginPackageSecretBindingTransitionApprovalPlan,
  pluginPackageSecretBindingTransitionApprovedAction,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-transition-approval-plan');
const {
  createPluginPackageSecretBindingTransitionPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-transition-plan');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  ClusterPluginPackageSecretBindingTransitionApprovedActionHandler,
} = require('@qinglong/cluster-admin/plugin-package-secret-binding-transition-approved-action');

const REQUESTER = Object.freeze({ type: 'user', id: 'cluster-owner' });
const REVIEWER = Object.freeze({ type: 'user', id: 'security-reviewer' });
const CONSUMER = Object.freeze({
  type: 'system',
  id: 'cluster_package_executor',
});
const FENCE = Object.freeze({ projectVersion: 3, bindingVersion: 4 });

function manifest(version) {
  return {
    apiVersion: 'qinglong.io/v1alpha1',
    kind: 'Package',
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version,
      description: 'Secret transition handler fixture',
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
}

function approvalPlan() {
  const previousManifest = manifest('1.0.0');
  const previousGeneration = createPluginPackageResourceGeneration({
    installationId: 'install-secret-transition-v1',
    projectId: 'project-1',
    packageName: 'example-monitor',
    lockDigest: 'a'.repeat(64),
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: 'b'.repeat(64),
    contents: previousManifest.spec.contents,
  });
  const previousBinding = createPluginPackageSecretBinding({
    generation: previousGeneration,
    manifest: previousManifest,
    assignments: [{
      name: 'TOKEN',
      secretRef: createSecretRef({
        projectId: 'project-1',
        name: 'runtime-token',
        version: 1,
      }),
    }],
    authority: {
      kind: 'approved-action-execution',
      evidenceDigest: 'c'.repeat(64),
    },
    boundAtMs: 80,
  });
  const nextManifest = manifest('2.0.0');
  const transitionPlan = createPluginPackageSecretBindingTransitionPlan({
    previousTarget: previousBinding.target,
    previousBinding,
    previousAttemptGeneration: 1,
    nextGeneration: createPluginPackageResourceGeneration({
      installationId: 'install-secret-transition-v2',
      projectId: 'project-1',
      packageName: 'example-monitor',
      lockDigest: 'd'.repeat(64),
      generation: 2,
      previousActiveLockDigest: 'a'.repeat(64),
      contentDigest: 'e'.repeat(64),
      contents: nextManifest.spec.contents,
    }),
    nextManifest,
    assignments: [{
      name: 'TOKEN',
      secretRef: createSecretRef({
        projectId: 'project-1',
        name: 'runtime-token',
        version: 2,
      }),
    }],
    plannedAtMs: 100,
  });
  return createPluginPackageSecretBindingTransitionApprovalPlan({
    actionRef: 'secret-transition:example-monitor-v2',
    transitionPlan,
    requestedBy: REQUESTER,
    plannedAtMs: 100,
    expiresAtMs: 1_000,
  });
}

function dispatch(plan) {
  const action = pluginPackageSecretBindingTransitionApprovedAction(plan);
  const pending = createApprovalRequest({
    id: 'approval-secret-transition-1',
    projectId: 'project-1',
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
    decisionId: 'decision-secret-transition-1',
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
    consumptionId: 'consume-secret-transition-1',
    dispatchId: 'dispatch-secret-transition-1',
    action,
    requestedBy: REQUESTER,
    consumedBy: CONSUMER,
    consumedAtMs: 130,
    authorizationFence: FENCE,
  }).dispatch;
}

function execution(approvedDispatch, startedAtMs = 140) {
  const claimed = claimApprovedActionExecution(
    createApprovedActionExecution(approvedDispatch, 5),
    {
      owner: 'secret-transition-executor',
      leaseToken: 'lease-secret-transition-1',
      nowMs: 131,
      leaseDurationMs: 2_000,
    },
  );
  return startApprovedActionExecution(
    { dispatch: approvedDispatch, execution: claimed },
    {
      dispatchId: approvedDispatch.id,
      approvalRequestId: approvedDispatch.approvalRequestId,
      actionDigest: approvedDispatch.action.actionDigest,
      owner: claimed.leaseOwner,
      leaseToken: claimed.leaseToken,
      expectedVersion: claimed.version,
      startedAtMs,
    },
  );
}

test('commits exactly one approved transition and verifies projected references', async () => {
  const plan = approvalPlan();
  const approvedDispatch = dispatch(plan);
  const started = execution(approvedDispatch);
  const applied = [];
  const inspected = [];
  const subject = new ClusterPluginPackageSecretBindingTransitionApprovedActionHandler(
    { async findByActionRef() { return plan; } },
    {
      async apply(input) {
        applied.push(input);
        return {
          status: 'created',
          receipt: { receiptDigest: 'f'.repeat(64) },
        };
      },
    },
    { async assertExists(refs) { inspected.push(...refs); } },
  );
  assert.deepEqual(await subject.inspect(approvedDispatch), {
    status: 'ready',
    actionDigest: plan.approvalPlanDigest,
  });
  const result = await subject.execute({
    dispatch: approvedDispatch,
    execution: started,
    idempotencyKey: approvedDispatch.id,
    fence: {
      owner: started.leaseOwner,
      leaseToken: started.leaseToken,
      version: started.version,
    },
  });
  assert.deepEqual(result, {
    outcome: 'succeeded',
    resultCode: 'package_secret_transition_committed',
    resultDigest: 'f'.repeat(64),
  });
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0], {
    transitionPlan: plan.transitionPlan,
    evidenceDigest: plan.approvalPlanDigest,
    committedAtMs: 140,
  });
  assert.deepEqual(inspected, [
    plan.transitionPlan.nextBindingPlan.entries[0].secretRef,
    plan.transitionPlan.nextBindingPlan.entries[0].secretRef,
  ]);
});

test('blocks plan drift and execution that starts after plan expiry', async () => {
  const plan = approvalPlan();
  const approvedDispatch = dispatch(plan);
  const applied = [];
  const subject = new ClusterPluginPackageSecretBindingTransitionApprovedActionHandler(
    { async findByActionRef() { return plan; } },
    { async apply(input) { applied.push(input); throw new Error('must not apply'); } },
    { async assertExists() {} },
  );
  const late = execution(approvedDispatch, 1_001);
  assert.deepEqual(
    await subject.execute({
      dispatch: approvedDispatch,
      execution: late,
      idempotencyKey: approvedDispatch.id,
      fence: {
        owner: late.leaseOwner,
        leaseToken: late.leaseToken,
        version: late.version,
      },
    }),
    {
      outcome: 'failed',
      resultCode: 'package_secret_transition_plan_rejected',
    },
  );
  assert.equal(applied.length, 0);
  const drifted = { ...plan, approvalPlanDigest: '9'.repeat(64) };
  const driftedSubject = new ClusterPluginPackageSecretBindingTransitionApprovedActionHandler(
    { async findByActionRef() { return drifted; } },
    { async apply() { throw new Error('must not apply'); } },
    { async assertExists() {} },
  );
  assert.deepEqual(await driftedSubject.inspect(approvedDispatch), {
    status: 'blocked',
    resultCode: 'package_secret_transition_plan_rejected',
  });
});
