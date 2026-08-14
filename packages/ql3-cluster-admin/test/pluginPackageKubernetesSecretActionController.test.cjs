'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
const {
  createApprovedActionExecution,
} = require('@qinglong/runtime-core/approved-action-execution');
const {
  createPluginPackageResourceGeneration,
} = require('@qinglong/runtime-core/plugin-package-resource-generation');
const {
  createPluginPackageSecretBindingApprovalPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-approval-plan');
const {
  createPluginPackageSecretBindingPlan,
} = require('@qinglong/runtime-core/plugin-package-secret-binding-plan');
const {
  createSecretRef,
} = require('@qinglong/runtime-core/secret-reference');
const {
  PluginPackageKubernetesSecretActionController,
  PluginPackageKubernetesSecretActionControllerConflictError,
} = require('@qinglong/cluster-admin/plugin-package-kubernetes-secret-action-controller');

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
  const action = require('@qinglong/runtime-core/plugin-package-secret-binding-approval-plan')
    .pluginPackageSecretBindingApprovedAction(plan);
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

function apiError(code) {
  return Object.assign(new Error(`Kubernetes ${code}`), { code });
}

function controller({ read, create, now = 200, snapshot: snapshotOverride }) {
  const { plan, snapshot } = fixture();
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
    },
    bindingPlans: {
      async findByActionRef(actionRef) {
        assert.equal(actionRef, plan.actionRef);
        return plan;
      },
    },
    transitionPlans: {
      async findByActionRef() {
        throw new Error('transition reader must not run');
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
  assert.match(calls[1][1].body.metadata.name, /^ql3-package-secret-[0-9a-f]{32}$/);
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
    snapshot: {
      ...snapshot,
      execution: { ...snapshot.execution, status: 'executing' },
    },
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

test('does not create a missing Job after the approval plan expires', async () => {
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
  assert.equal(result.recoveryRequired, 1);
  assert.equal(creates, 0);
});

test('marks a terminal Job with a nonterminal execution as recovery required', async () => {
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
  assert.equal(result.recoveryRequired, 1);
  assert.equal(result.created, 0);
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
