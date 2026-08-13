'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  consumeApprovalRequest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
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
const {
  secretProjectionFileName,
} = require('@qinglong/runtime-core/secret-projection');
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  InvalidPluginPackageKubernetesSecretActionJobError,
  createPluginPackageKubernetesSecretActionJob,
} = require('@qinglong/cluster-admin/plugin-package-kubernetes-secret-action-job');

const REQUESTER = Object.freeze({ type: 'user', id: 'cluster-owner' });
const REVIEWER = Object.freeze({ type: 'user', id: 'security-reviewer' });
const CONSUMER = Object.freeze({
  type: 'system',
  id: 'cluster_package_executor',
});
const FENCE = Object.freeze({ projectVersion: 3, bindingVersion: 4 });

function fixture({ withoutValues = false } = {}) {
  const manifest = {
    apiVersion: 'qinglong.io/v1alpha1',
    kind: 'Package',
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.0.0',
      description: 'Action-scoped Job fixture',
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
        secrets: [
          { name: 'TOKEN', required: !withoutValues },
          { name: 'TOKEN_ALIAS', required: !withoutValues },
        ],
        tools: ['secret.use'],
      },
      contents: { tasks: [], workflows: [], prompts: [], tools: [] },
    },
  };
  const generation = createPluginPackageResourceGeneration({
    installationId: 'install-secret-action-1',
    projectId: 'project-1',
    packageName: 'example-monitor',
    lockDigest: 'a'.repeat(64),
    generation: 1,
    previousActiveLockDigest: null,
    contentDigest: 'b'.repeat(64),
    contents: manifest.spec.contents,
  });
  const secretRef = createSecretRef({
    projectId: 'project-1',
    name: 'runtime-token',
    version: 2,
  });
  const bindingPlan = createPluginPackageSecretBindingPlan({
    generation,
    manifest,
    assignments: [
      { name: 'TOKEN', secretRef: withoutValues ? null : secretRef },
      { name: 'TOKEN_ALIAS', secretRef: withoutValues ? null : secretRef },
    ],
    plannedAtMs: 100,
  });
  const approvalPlan = createPluginPackageSecretBindingApprovalPlan({
    actionRef: 'secret-binding:example-monitor-v1',
    bindingPlan,
    requestedBy: REQUESTER,
    expiresAtMs: 1_000,
  });
  const action = pluginPackageSecretBindingApprovedAction(approvalPlan);
  const pending = createApprovalRequest({
    id: 'approval-secret-action-1',
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
    decisionId: 'decision-secret-action-1',
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
  const dispatch = consumeApprovalRequest(approved, {
    expectedVersion: 2,
    consumptionId: 'consume-secret-action-1',
    dispatchId: 'dispatch-secret-action-1',
    action,
    requestedBy: REQUESTER,
    consumedBy: CONSUMER,
    consumedAtMs: 130,
    authorizationFence: FENCE,
  }).dispatch;
  return { approvalPlan, dispatch, secretRef };
}

function options(overrides = {}) {
  return {
    namespace: 'qinglong3-system',
    serviceAccountName: 'ql3-plugin-package-secret-action',
    sourceSecretName: 'ql3-cluster-plugin-package-values',
    image:
      'registry.example.com/qinglong/qinglong3-cluster-admin@sha256:' +
      'c'.repeat(64),
    postgres: {
      connection: {
        mode: 'fields',
        authSecretName: 'ql3-postgres-package-executor-auth',
        host: 'ql3-postgres-rw.qinglong3-system.svc',
        port: 5432,
        database: 'qinglong',
        usernameKey: 'username',
        passwordKey: 'password',
      },
      caSecretName: 'ql3-postgres-ca',
      caKey: 'ca.crt',
      servername: 'ql3-postgres-rw.qinglong3-system.svc',
    },
    ...overrides,
  };
}

test('renders one deterministic exact-key Secret action Job', () => {
  const { approvalPlan, dispatch, secretRef } = fixture();
  const job = createPluginPackageKubernetesSecretActionJob({
    dispatch,
    approvalPlan,
    options: options(),
  });
  const replay = createPluginPackageKubernetesSecretActionJob({
    dispatch,
    approvalPlan,
    options: options(),
  });
  assert.deepEqual(replay, job);
  assert.match(job.metadata.name, /^ql3-package-secret-[0-9a-f]{32}$/);
  assert.equal(Object.isFrozen(job), true);
  assert.equal(Object.isFrozen(job.spec.template.spec.volumes), true);
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);

  const values = job.spec.template.spec.volumes.find(
    (volume) => volume.name === 'plugin-package-values',
  );
  assert.deepEqual(values.secret.items, [
    {
      key: secretProjectionFileName(secretRef),
      path: secretProjectionFileName(secretRef),
    },
  ]);
  assert.equal(values.secret.optional, false);
  assert.equal(values.secret.defaultMode, 0o440);

  const container = job.spec.template.spec.containers[0];
  assert.equal(
    container.env.find(
      (entry) => entry.name === 'QL3_PLUGIN_PACKAGE_EXECUTOR_DISPATCH_ID',
    ).value,
    dispatch.id,
  );
  assert.equal(container.resources.requests.memory, '48Mi');
  assert.equal(JSON.stringify(job).includes('qlsecret:'), false);
  assert.equal(JSON.stringify(job).includes('runtime-token'), false);
});

test('rejects a tag-only image and a dispatch bound to another plan', () => {
  const { approvalPlan, dispatch } = fixture();
  assert.throws(
    () =>
      createPluginPackageKubernetesSecretActionJob({
        dispatch,
        approvalPlan,
        options: options({ image: 'qinglong3-cluster-admin:latest' }),
      }),
    InvalidPluginPackageKubernetesSecretActionJobError,
  );
  assert.throws(
    () =>
      createPluginPackageKubernetesSecretActionJob({
        dispatch: { ...dispatch, id: 'dispatch-secret-action-drift' },
        approvalPlan: { ...approvalPlan, actionRef: 'other-action' },
        options: options(),
      }),
    TypeError,
  );
});

test('uses an empty directory for a reviewed action with no Secret values', () => {
  const { approvalPlan, dispatch } = fixture({ withoutValues: true });
  const job = createPluginPackageKubernetesSecretActionJob({
    dispatch,
    approvalPlan,
    options: options(),
  });
  const values = job.spec.template.spec.volumes.find(
    (volume) => volume.name === 'plugin-package-values',
  );
  assert.deepEqual(values, {
    name: 'plugin-package-values',
    emptyDir: { sizeLimit: '1Ki' },
  });
  assert.equal(values.secret, undefined);
});
