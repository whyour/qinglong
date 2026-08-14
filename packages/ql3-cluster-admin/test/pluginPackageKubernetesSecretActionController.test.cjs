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
  completeApprovedActionExecution,
  createApprovedActionExecution,
  releaseApprovedActionExecutionBeforeStart,
  startApprovedActionExecution,
} = require('@qinglong/runtime-core/approved-action-execution');
const {
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  createPluginPackageSecretBindingFromApprovalPlan,
  createPluginPackageSecretBindingApprovalPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-approval-plan');
const {
  createPluginPackageSecretBindingPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-plan');
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
const {
  createPluginPackageSecretBindingFromTransitionPlan,
  createPluginPackageSecretBindingTransitionReceipt,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-transition-receipt');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  PluginPackageKubernetesSecretActionController,
  PluginPackageKubernetesSecretActionControllerConflictError,
} = require('@qinglong/cluster-admin/plugin-package-kubernetes-secret-action-controller');
const {
  createPluginPackageKubernetesSecretActionJob,
} = require('@qinglong/cluster-admin/plugin-package-kubernetes-secret-action-job');

const REQUESTER = Object.freeze({ type: 'user', id: 'cluster-owner' });
const REVIEWER = Object.freeze({ type: 'user', id: 'security-reviewer' });
const CONSUMER = Object.freeze({
  type: 'system',
  id: 'cluster_package_executor',
});
const FENCE = Object.freeze({ projectVersion: 3, bindingVersion: 4 });

function fixture() {
  const manifest = {
    apiVersion: 'qinglong.io/v1alpha1',
    kind: 'Package',
    metadata: {
      name: 'controller-fixture',
      displayName: 'Controller Fixture',
      version: '1.0.0',
      description: 'Secret action controller fixture',
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
    installationId: 'install-controller-1',
    projectId: 'project-1',
    packageName: 'controller-fixture',
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
  const plan = createPluginPackageSecretBindingApprovalPlan({
    actionRef: 'secret-binding:controller-fixture',
    bindingPlan,
    requestedBy: REQUESTER,
    expiresAtMs: 1_000,
  });
  const action =
    require('@qinglong/runtime-core/plugin-package-secret-binding-approval-plan').pluginPackageSecretBindingApprovedAction(
      plan,
    );
  const approved = decideApprovalRequest(
    createApprovalRequest({
      id: 'approval-controller-1',
      projectId: 'project-1',
      action,
      risk: 'high',
      decisionMode: 'separation_of_duty',
      requestedBy: REQUESTER,
      requestedAtMs: 110,
      expiresAtMs: 900,
      requestFence: FENCE,
    }),
    {
      expectedVersion: 1,
      decisionId: 'decision-controller-1',
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
    },
  );
  const dispatch = consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consume-controller-1',
    dispatchId: 'dispatch-controller-1',
    action,
    requestedBy: REQUESTER,
    consumedBy: CONSUMER,
    consumedAtMs: 130,
    authorizationFence: FENCE,
  }).dispatch;
  return {
    plan,
    snapshot: Object.freeze({
      dispatch,
      execution: createApprovedActionExecution(dispatch),
    }),
  };
}

function jobOptions() {
  return {
    namespace: 'qinglong3-system',
    serviceAccountName: 'ql3-plugin-package-secret-action',
    sourceSecretName: 'ql3-cluster-plugin-package-values',
    image:
      'registry.example.com/qinglong/qinglong3-cluster-admin@sha256:' +
      'c'.repeat(64),
    postgres: {
      connection: {
        mode: 'url',
        secretName: 'ql3-cluster-plugin-package-executor',
        urlKey: 'postgres-package-executor-url',
      },
      caSecretName: 'ql3-cluster-plugin-package-executor',
      caKey: 'postgres-ca.crt',
      servername: 'postgres.qinglong3-system.svc',
    },
  };
}

function transitionFixture() {
  const manifest = (version) => ({
    apiVersion: 'qinglong.io/v1alpha1',
    kind: 'Package',
    metadata: {
      name: 'controller-transition',
      displayName: 'Controller Transition',
      version,
      description: 'Secret action transition controller fixture',
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
  });
  const previousManifest = manifest('1.0.0');
  const previousGeneration = createPluginPackageResourceGeneration({
    installationId: 'install-controller-transition-v1',
    projectId: 'project-1',
    packageName: 'controller-transition',
    lockDigest: '1'.repeat(64),
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: '2'.repeat(64),
    contents: previousManifest.spec.contents,
  });
  const previousBinding = createPluginPackageSecretBinding({
    generation: previousGeneration,
    manifest: previousManifest,
    assignments: [
      {
        name: 'TOKEN',
        secretRef: createSecretRef({
          projectId: 'project-1',
          name: 'runtime-token',
          version: 1,
        }),
      },
    ],
    authority: {
      kind: 'approved-action-execution',
      evidenceDigest: '3'.repeat(64),
    },
    boundAtMs: 80,
  });
  const nextManifest = manifest('2.0.0');
  const transitionPlan = createPluginPackageSecretBindingTransitionPlan({
    previousTarget: previousBinding.target,
    previousBinding,
    previousAttemptGeneration: 1,
    nextGeneration: createPluginPackageResourceGeneration({
      installationId: 'install-controller-transition-v2',
      projectId: 'project-1',
      packageName: 'controller-transition',
      lockDigest: '4'.repeat(64),
      generation: 2,
      previousActiveLockDigest: '1'.repeat(64),
      contentDigest: '5'.repeat(64),
      contents: nextManifest.spec.contents,
    }),
    nextManifest,
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
  const plan = createPluginPackageSecretBindingTransitionApprovalPlan({
    actionRef: 'secret-transition:controller-v2',
    transitionPlan,
    requestedBy: REQUESTER,
    plannedAtMs: 100,
    expiresAtMs: 1_000,
  });
  const action = pluginPackageSecretBindingTransitionApprovedAction(plan);
  const approved = decideApprovalRequest(
    createApprovalRequest({
      id: 'approval-controller-transition',
      projectId: 'project-1',
      action,
      risk: 'high',
      decisionMode: 'separation_of_duty',
      requestedBy: REQUESTER,
      requestedAtMs: 110,
      expiresAtMs: 900,
      requestFence: FENCE,
    }),
    {
      expectedVersion: 1,
      decisionId: 'decision-controller-transition',
      decision: 'approved',
      reasonCode: 'reviewed',
      principal: {
        subject: REVIEWER,
        authenticationId: 'auth-transition-reviewer',
        authenticatedAtMs: 100,
        expiresAtMs: 800,
        assurance: 'multi_factor',
      },
      decidedAtMs: 120,
      authorizationFence: FENCE,
    },
  );
  const dispatch = consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consume-controller-transition',
    dispatchId: 'dispatch-controller-transition',
    action,
    requestedBy: REQUESTER,
    consumedBy: CONSUMER,
    consumedAtMs: 130,
    authorizationFence: FENCE,
  }).dispatch;
  return {
    plan,
    snapshot: Object.freeze({
      dispatch,
      execution: createApprovedActionExecution(dispatch),
    }),
  };
}

function apiError(code) {
  return Object.assign(new Error(`Kubernetes ${code}`), { code });
}

function executingSnapshot(snapshot, startedAtMs = 150) {
  const leased = claimApprovedActionExecution(snapshot.execution, {
    owner: 'secret-action-job',
    leaseToken: 'secret-action-lease',
    nowMs: 140,
    leaseDurationMs: 100,
  });
  return Object.freeze({
    dispatch: snapshot.dispatch,
    execution: startApprovedActionExecution(
      { dispatch: snapshot.dispatch, execution: leased },
      {
        dispatchId: snapshot.dispatch.id,
        approvalRequestId: snapshot.dispatch.approvalRequestId,
        actionDigest: snapshot.dispatch.action.actionDigest,
        owner: leased.leaseOwner,
        leaseToken: leased.leaseToken,
        expectedVersion: leased.version,
        startedAtMs,
      },
    ),
  });
}

function desiredJob(plan, snapshot) {
  return createPluginPackageKubernetesSecretActionJob({
    dispatch: snapshot.dispatch,
    approvalPlan: plan,
    options: jobOptions(),
  });
}

function controller({
  read,
  create,
  complete,
  findBinding,
  findTransitionReceipt,
  now = 200,
  plan: planOverride,
  snapshot: snapshotOverride,
}) {
  const { plan, snapshot } = fixture();
  const selectedPlan = planOverride ?? plan;
  return new PluginPackageKubernetesSecretActionController({
    executions: {
      async listReconciliableExecutions(query) {
        assert.deepEqual(query.actionTypes, [
          'plugin_package.secret_binding.bind',
          'plugin_package.secret_binding.transition',
        ]);
        return {
          executions: [snapshotOverride ?? snapshot],
          truncated: false,
        };
      },
      async completeExecution(command) {
        if (!complete) throw new Error('completion must not run');
        return complete(command, snapshotOverride ?? snapshot);
      },
      async claimExecution(command) {
        const current = snapshotOverride ?? snapshot;
        const execution = claimApprovedActionExecution(current.execution, {
          owner: command.owner,
          leaseToken: command.leaseToken,
          nowMs: command.nowMs,
          leaseDurationMs: command.leaseDurationMs,
        });
        return {
          status: 'claimed',
          snapshot: { dispatch: current.dispatch, execution },
        };
      },
      async releaseExecutionBeforeStart(command) {
        const current = snapshotOverride ?? snapshot;
        const claimed = claimApprovedActionExecution(current.execution, {
          owner: command.owner,
          leaseToken: command.leaseToken,
          nowMs: command.atMs,
          leaseDurationMs: 60_000,
        });
        return {
          dispatch: current.dispatch,
          execution: releaseApprovedActionExecutionBeforeStart(claimed, {
            owner: command.owner,
            leaseToken: command.leaseToken,
            expectedVersion: command.expectedVersion,
            resultMutationId: command.resultMutationId,
            resultCode: command.resultCode,
            atMs: command.atMs,
          }),
        };
      },
    },
    bindingPlans: {
      async findByActionRef(actionRef) {
        if (!('bindingPlan' in selectedPlan)) {
          throw new Error('binding reader must not run');
        }
        assert.equal(actionRef, selectedPlan.actionRef);
        return selectedPlan;
      },
    },
    transitionPlans: {
      async findByActionRef(actionRef) {
        if ('bindingPlan' in selectedPlan) {
          throw new Error('transition reader must not run');
        }
        assert.equal(actionRef, selectedPlan.actionRef);
        return selectedPlan;
      },
    },
    bindings: {
      async find(generationDigest) {
        return findBinding ? findBinding(generationDigest) : null;
      },
    },
    transitionReceipts: {
      async find(generationDigest) {
        return findTransitionReceipt
          ? findTransitionReceipt(generationDigest)
          : null;
      },
    },
    jobs: {
      readNamespacedJob: read,
      createNamespacedJob: create,
    },
    job: jobOptions(),
    now: () => now,
  });
}

test('creates one Strict deterministic Job without claiming the execution', async () => {
  const calls = [];
  const subject = controller({
    async read(request) {
      calls.push(['read', request]);
      throw apiError(404);
    },
    async create(request) {
      calls.push(['create', request]);
      return request.body;
    },
  });
  const result = await subject.reconcile({ limit: 4 });
  assert.equal(result.created, 1);
  assert.equal(result.recoveryRequired, 0);
  assert.equal(calls[0][0], 'read');
  assert.equal(calls[1][0], 'create');
  assert.equal(calls[1][1].fieldValidation, 'Strict');
  assert.equal(
    calls[1][1].fieldManager,
    'qinglong-plugin-package-secret-action-controller',
  );
  assert.match(
    calls[1][1].body.metadata.name,
    /^ql3-package-secret-[0-9a-f]{32}$/,
  );
});

test('converges a concurrent create through one exact get', async () => {
  let desired;
  let reads = 0;
  const subject = controller({
    async read() {
      reads += 1;
      if (reads === 1) throw apiError(404);
      return {
        ...desired,
        metadata: {
          ...desired.metadata,
          uid: 'server-owned-uid',
        },
        spec: {
          ...desired.spec,
          completionMode: 'NonIndexed',
        },
      };
    },
    async create(request) {
      desired = request.body;
      throw apiError(409);
    },
  });
  const result = await subject.reconcile();
  assert.equal(result.existing, 1);
  assert.equal(reads, 2);
});

test('converges a lost successful CREATE response through one exact get', async () => {
  let desired;
  let reads = 0;
  const subject = controller({
    async read() {
      reads += 1;
      if (reads === 1) throw apiError(404);
      return desired;
    },
    async create(request) {
      desired = request.body;
      throw apiError(503);
    },
  });
  const result = await subject.reconcile();
  assert.equal(result.existing, 1);
  assert.equal(result.unavailable, 0);
  assert.equal(reads, 2);
});

test('does not recreate a missing Job for an already executing action', async () => {
  const { snapshot } = fixture();
  let creates = 0;
  const subject = controller({
    snapshot: executingSnapshot(snapshot),
    async read() {
      throw apiError(404);
    },
    async create() {
      creates += 1;
      throw new Error('must not create');
    },
  });
  const result = await subject.reconcile();
  assert.equal(result.recoveryRequired, 1);
  assert.equal(creates, 0);
});

test('recovers a missing executing Job when its exact durable binding exists', async () => {
  const { plan, snapshot } = fixture();
  const executing = executingSnapshot(snapshot);
  const durable = createPluginPackageSecretBindingFromApprovalPlan(
    plan,
    executing.execution.startedAtMs,
  );
  const subject = controller({
    snapshot: executing,
    async read() {
      throw apiError(404);
    },
    async create() {
      throw new Error('must not create');
    },
    async findBinding() {
      return durable;
    },
    async complete(command) {
      assert.equal(command.outcome, 'succeeded');
      return {
        dispatch: executing.dispatch,
        execution: completeApprovedActionExecution(executing.execution, {
          owner: command.owner,
          leaseToken: command.leaseToken,
          expectedVersion: command.expectedVersion,
          resultMutationId: command.resultMutationId,
          outcome: command.outcome,
          resultCode: command.resultCode,
          resultDigest: command.resultDigest,
          completedAtMs: command.completedAtMs,
        }),
      };
    },
  });
  const result = await subject.reconcile();
  assert.equal(result.recoveredSucceeded, 1);
  assert.equal(result.recoveryRequired, 0);
});

test('blocks a missing Job after the approval plan expires before start', async () => {
  let creates = 0;
  const subject = controller({
    now: 1_001,
    async read() {
      throw apiError(404);
    },
    async create() {
      creates += 1;
      throw new Error('must not create');
    },
  });
  const result = await subject.reconcile();
  assert.equal(result.recoveredBlocked, 1);
  assert.equal(result.recoveryRequired, 0);
  assert.equal(creates, 0);
});

test('blocks a terminal Job before the execution start barrier', async () => {
  let desired;
  const subject = controller({
    async read() {
      if (!desired) throw apiError(404);
      return desired;
    },
    async create(request) {
      desired = {
        ...request.body,
        status: {
          conditions: [{ type: 'Failed', status: 'True' }],
        },
      };
      return desired;
    },
  });
  const result = await subject.reconcile();
  assert.equal(result.recoveredBlocked, 1);
  assert.equal(result.recoveryRequired, 0);
  assert.equal(result.created, 0);
});

test('recovers an executing terminal Job as succeeded from its exact durable binding', async () => {
  const { plan, snapshot } = fixture();
  const executing = executingSnapshot(snapshot);
  const desired = desiredJob(plan, executing);
  const durable = createPluginPackageSecretBindingFromApprovalPlan(
    plan,
    executing.execution.startedAtMs,
  );
  let completion;
  const subject = controller({
    snapshot: executing,
    async read() {
      return {
        ...desired,
        status: { conditions: [{ type: 'Complete', status: 'True' }] },
      };
    },
    async create() {
      throw new Error('must not create');
    },
    async findBinding(generationDigest) {
      assert.equal(generationDigest, plan.bindingPlan.target.generationDigest);
      return durable;
    },
    async complete(command) {
      completion = command;
      return {
        dispatch: executing.dispatch,
        execution: completeApprovedActionExecution(executing.execution, {
          owner: command.owner,
          leaseToken: command.leaseToken,
          expectedVersion: command.expectedVersion,
          resultMutationId: command.resultMutationId,
          outcome: command.outcome,
          resultCode: command.resultCode,
          resultDigest: command.resultDigest,
          completedAtMs: command.completedAtMs,
        }),
      };
    },
  });
  const result = await subject.reconcile();
  assert.equal(result.recoveredSucceeded, 1);
  assert.equal(result.recoveryRequired, 0);
  assert.equal(completion.outcome, 'succeeded');
  assert.equal(completion.resultDigest, durable.bindingDigest);
  assert.equal(completion.resultCode, 'package_secret_binding_job_recovered');
});

test('recovers a failed executing Job without a durable mutation as failed', async () => {
  const { plan, snapshot } = fixture();
  const executing = executingSnapshot(snapshot);
  const desired = desiredJob(plan, executing);
  const subject = controller({
    snapshot: executing,
    async read() {
      return {
        ...desired,
        status: { conditions: [{ type: 'Failed', status: 'True' }] },
      };
    },
    async create() {
      throw new Error('must not create');
    },
    async complete(command) {
      assert.equal(command.outcome, 'failed');
      return {
        dispatch: executing.dispatch,
        execution: completeApprovedActionExecution(executing.execution, {
          owner: command.owner,
          leaseToken: command.leaseToken,
          expectedVersion: command.expectedVersion,
          resultMutationId: command.resultMutationId,
          outcome: command.outcome,
          resultCode: command.resultCode,
          completedAtMs: command.completedAtMs,
        }),
      };
    },
  });
  const result = await subject.reconcile();
  assert.equal(result.recoveredFailed, 1);
  assert.equal(result.recoveryRequired, 0);
});

test('recovers a terminal transition Job from its exact durable receipt', async () => {
  const { plan, snapshot } = transitionFixture();
  const executing = executingSnapshot(snapshot);
  const desired = desiredJob(plan, executing);
  const binding = createPluginPackageSecretBindingFromTransitionPlan(
    plan.transitionPlan,
    'approved-action-execution',
    plan.approvalPlanDigest,
    executing.execution.startedAtMs,
  );
  const receipt = createPluginPackageSecretBindingTransitionReceipt({
    transitionPlan: plan.transitionPlan,
    authority: {
      kind: 'approved-action-execution',
      evidenceDigest: plan.approvalPlanDigest,
    },
    binding,
    committedAtMs: executing.execution.startedAtMs,
  });
  const subject = controller({
    plan,
    snapshot: executing,
    async read() {
      return {
        ...desired,
        status: { conditions: [{ type: 'Failed', status: 'True' }] },
      };
    },
    async create() {
      throw new Error('must not create');
    },
    async findTransitionReceipt(generationDigest) {
      assert.equal(
        generationDigest,
        plan.transitionPlan.nextTarget.generationDigest,
      );
      return receipt;
    },
    async complete(command) {
      assert.equal(command.outcome, 'succeeded');
      assert.equal(command.resultDigest, receipt.receiptDigest);
      return {
        dispatch: executing.dispatch,
        execution: completeApprovedActionExecution(executing.execution, {
          owner: command.owner,
          leaseToken: command.leaseToken,
          expectedVersion: command.expectedVersion,
          resultMutationId: command.resultMutationId,
          outcome: command.outcome,
          resultCode: command.resultCode,
          resultDigest: command.resultDigest,
          completedAtMs: command.completedAtMs,
        }),
      };
    },
  });
  const result = await subject.reconcile();
  assert.equal(result.recoveredSucceeded, 1);
  assert.equal(result.recoveryRequired, 0);
});

test('blocks a completed executing Job when its durable receipt is missing', async () => {
  const { plan, snapshot } = fixture();
  const executing = executingSnapshot(snapshot);
  const desired = desiredJob(plan, executing);
  const subject = controller({
    snapshot: executing,
    async read() {
      return {
        ...desired,
        status: { conditions: [{ type: 'Complete', status: 'True' }] },
      };
    },
    async create() {
      throw new Error('must not create');
    },
    async complete(command) {
      assert.equal(command.outcome, 'indeterminate');
      return {
        dispatch: executing.dispatch,
        execution: completeApprovedActionExecution(executing.execution, {
          owner: command.owner,
          leaseToken: command.leaseToken,
          expectedVersion: command.expectedVersion,
          resultMutationId: command.resultMutationId,
          outcome: command.outcome,
          resultCode: command.resultCode,
          completedAtMs: command.completedAtMs,
        }),
      };
    },
  });
  const result = await subject.reconcile();
  assert.equal(result.recoveredBlocked, 1);
  assert.equal(result.recoveryRequired, 0);
});

test('fails closed when the durable binding differs from the approved result', async () => {
  const { plan, snapshot } = fixture();
  const executing = executingSnapshot(snapshot);
  const desired = desiredJob(plan, executing);
  const durable = createPluginPackageSecretBindingFromApprovalPlan(
    plan,
    executing.execution.startedAtMs,
  );
  const subject = controller({
    snapshot: executing,
    async read() {
      return {
        ...desired,
        status: { conditions: [{ type: 'Complete', status: 'True' }] },
      };
    },
    async create() {
      throw new Error('must not create');
    },
    async findBinding() {
      return { ...durable, bindingDigest: 'f'.repeat(64) };
    },
  });
  await assert.rejects(
    () => subject.reconcile(),
    PluginPackageKubernetesSecretActionControllerConflictError,
  );
});

test('fails closed when a deterministic Job name contains another contract', async () => {
  const subject = controller({
    async read() {
      const error = apiError(404);
      throw error;
    },
    async create(request) {
      return {
        ...request.body,
        metadata: {
          ...request.body.metadata,
          annotations: {
            ...request.body.metadata.annotations,
            'qinglong.io/secret-action-job-digest': 'f'.repeat(64),
          },
        },
      };
    },
  });
  await assert.rejects(
    () => subject.reconcile(),
    PluginPackageKubernetesSecretActionControllerConflictError,
  );
});
