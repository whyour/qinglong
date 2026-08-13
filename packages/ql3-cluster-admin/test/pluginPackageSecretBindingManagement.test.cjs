'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

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
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  PluginPackageManagementAuthorizationError,
  PluginPackageManagementConflictError,
} = require('@qinglong/runtime-core/plugin-package-management');
const {
  createClusterPluginPackageSecretBindingManagementService,
} = require('@qinglong/cluster-admin/plugin-package-secret-binding-management');

const REQUESTER = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'cluster-owner' }),
  authenticationId: 'auth-cluster-owner',
  authenticatedAtMs: 100,
  expiresAtMs: 10_000,
  assurance: 'multi_factor',
});
const REVIEWER = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'security-reviewer' }),
  authenticationId: 'auth-security-reviewer',
  authenticatedAtMs: 100,
  expiresAtMs: 10_000,
  assurance: 'hardware',
});

function installFixture() {
  const manifest = {
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.0.0',
      description: 'Secret binding management fixture',
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
    proposedBy: REQUESTER.subject,
    proposalFence: { projectVersion: 3, bindingVersion: 4 },
    createdAtMs: 90,
  });
  const lock = createPluginPackageLock({
    ...actionInput,
    approval: {
      requestId: 'approval-install-v1',
      requestVersion: 1,
      dispatchId: 'dispatch-install-v1',
      actionDigest: pluginPackageInstallActionDigest(actionInput),
      previewDigest: pluginPackageInstallPlanDigest(installPlan),
      approvedBy: { type: 'user', id: 'install-reviewer' },
      approvedAtMs: 100,
      expiresAtMs: 2_000,
      fence: { projectVersion: 3, bindingVersion: 4 },
    },
    createdAtMs: 101,
  });
  const queued = createPluginPackageInstall(lock, {
    installationId: 'install-secret-binding-1',
    mutationId: 'mutation-create',
    occurredAtMs: 102,
  });
  const staged = transitionPluginPackageInstall(lock, queued, {
    type: 'stage_completed',
    mutationId: 'mutation-stage',
    occurredAtMs: 103,
    stageRef: 'stage-secret-binding-1',
    artifactDigest: lock.source.artifactDigest,
    manifestDigest: lock.manifestDigest,
    contentDigest: lock.source.contentDigest,
    evidenceDigest: 'c'.repeat(64),
  });
  const activating = transitionPluginPackageInstall(lock, staged, {
    type: 'activation_started',
    mutationId: 'mutation-activate',
    occurredAtMs: 104,
  });
  const record = transitionPluginPackageInstall(lock, activating, {
    type: 'activation_committed',
    mutationId: 'mutation-commit',
    occurredAtMs: 105,
    activationRef: 'activation-secret-binding-1',
    intentDigest: pluginPackageActivationIntentDigest(lock, activating),
    generation: 1,
    contentDigest: lock.source.contentDigest,
  });
  return { lock, manifest, proposal, record };
}

function policyRow(subjectId, role) {
  return {
    projectId: 'project-1',
    projectName: 'Project 1',
    projectSlug: 'project-1',
    projectStatus: 'active',
    projectVersion: 3,
    projectCreatedAtMs: 1,
    projectUpdatedAtMs: 2,
    bindingProjectId: 'project-1',
    bindingSubjectType: 'user',
    bindingSubjectId: subjectId,
    bindingVersion: 4,
    bindingState: 'active',
    bindingRole: role,
    bindingMutationId: `binding-${subjectId}-v4`,
    bindingChangedByType: 'user',
    bindingChangedById: 'root-owner',
    bindingCreatedAtMs: 2,
  };
}

function fixture() {
  const install = installFixture();
  const plans = new Map();
  const approvals = new Map();
  const audits = new Map();
  const pool = {
    async query(text, values) {
      if (text.includes('FROM "ql3"."projects" AS project')) {
        const role = values[2] === 'cluster-owner' ? 'owner' : 'admin';
        return { rows: [policyRow(values[2], role)] };
      }
      if (text.includes('plugin_package_secret_binding_planning_snapshot')) {
        return {
          rows: [{
            recordJson: install.record,
            lockJson: install.lock,
            proposalJson: install.proposal,
            observedAtMs: 200,
          }],
        };
      }
      if (text.includes('create_plugin_package_secret_binding_approval_plan')) {
        const plan = JSON.parse(values[0]);
        if (plans.has(plan.actionRef)) return { rows: [{ status: 'existing' }] };
        plans.set(plan.actionRef, plan);
        return { rows: [{ status: 'created' }] };
      }
      if (text.includes('FROM "ql3"."plugin_package_secret_binding_approval_plans"')) {
        const plan = plans.get(values[0]);
        return { rows: plan ? [{ planJson: plan }] : [] };
      }
      if (text.includes('FROM "ql3"."approval_requests"')) {
        const request = approvals.get(values[0]);
        return {
          rows: request
            ? [{ requestJson: request, requestDigest: require('@qinglong/runtime-core/approved-action').approvalRequestDigest(request) }]
            : [],
        };
      }
      throw new Error(`unexpected pool query: ${text}`);
    },
    async connect() {
      const client = {
        async query(text, values) {
          if (
            text === 'BEGIN ISOLATION LEVEL SERIALIZABLE' ||
            text === 'COMMIT' ||
            text === 'ROLLBACK' ||
            text.includes('set_config')
          ) return { rows: [] };
          if (text.includes('lock_approval_policy_fence')) {
            return { rows: [{ matches: true }] };
          }
          if (text.includes('FROM "ql3"."approval_requests"')) {
            const request = approvals.get(values[0]);
            return { rows: request ? [{ requestJson: request, requestDigest: require('@qinglong/runtime-core/approved-action').approvalRequestDigest(request) }] : [] };
          }
          if (text.includes('FROM "ql3"."security_audit_events"')) {
            const audit = audits.get(values[0]);
            return { rows: audit ? [audit] : [] };
          }
          if (text.includes('INSERT INTO "ql3"."approval_requests"')) {
            approvals.set(values[0], JSON.parse(values[14]));
            return { rows: [], rowCount: 1 };
          }
          if (text.includes('UPDATE "ql3"."approval_requests"')) {
            approvals.set(values[8], JSON.parse(values[5]));
            return { rows: [], rowCount: 1 };
          }
          if (text.includes('INSERT INTO "ql3"."security_audit_events"')) {
            audits.set(values[0], {
              eventId: values[0], requestId: values[1], operationId: values[2],
              projectId: values[3], subjectType: values[4], subjectId: values[5],
              authenticationId: values[6], outcome: values[7],
              reasonsJson: JSON.parse(values[8]), fenceProjectVersion: values[9],
              fenceBindingVersion: values[10], occurredAtMs: values[11],
            });
            return { rows: [], rowCount: 1 };
          }
          throw new Error(`unexpected transaction query: ${text}`);
        },
        release() {},
      };
      return client;
    },
  };
  return { approvals, plans, pool };
}

function planRequest(overrides = {}) {
  return {
    actionRef: 'secret-binding:example-monitor-v1',
    projectId: 'project-1',
    packageName: 'example-monitor',
    assignments: [{
      name: 'TOKEN',
      secretRef: createSecretRef({
        projectId: 'project-1',
        name: 'runtime-token',
        version: 2,
      }),
    }],
    principal: REQUESTER,
    ...overrides,
  };
}

test('plans, proposes and independently decides one exact Secret binding', async () => {
  const state = fixture();
  let clock = 210;
  const service = createClusterPluginPackageSecretBindingManagementService({
    pool: state.pool,
    now: () => clock,
    planLifetimeMs: 1_000,
    approvalLifetimeMs: 1_000,
  });
  const created = await service.plan(planRequest());
  clock = 300;
  const replay = await service.plan(planRequest());
  assert.equal(created.status, 'created');
  assert.equal(replay.status, 'existing');
  assert.deepEqual(replay.plan, created.plan);
  assert.equal(created.plan.bindingPlan.plannedAtMs, 200);
  assert.equal(created.plan.expiresAtMs, 1_200);
  assert.deepEqual(created.plan.bindingPlan.entries, [{
    name: 'TOKEN',
    required: true,
    secretRef: planRequest().assignments[0].secretRef,
  }]);

  const proposed = await service.propose({
    actionRef: created.plan.actionRef,
    approvalRequestId: 'approval-secret-binding-1',
    approvalAuditEventId: '123e4567-e89b-42d3-a456-426614175201',
    principal: REQUESTER,
  });
  assert.equal(proposed.approvalStatus, 'created');
  assert.equal(proposed.approvalRequest.decisionMode, 'separation_of_duty');
  assert.equal(proposed.approvalRequest.risk, 'high');
  assert.equal(proposed.approvalRequest.action.permission, 'secret.manage');

  clock = 350;
  const decided = await service.decide({
    actionRef: created.plan.actionRef,
    approvalRequestId: proposed.approvalRequest.id,
    expectedVersion: 1,
    decisionId: 'decision-secret-binding-1',
    auditEventId: '123e4567-e89b-42d3-a456-426614175202',
    decision: 'approved',
    reasonCode: 'reviewed',
    principal: REVIEWER,
  });
  assert.equal(decided.status, 'decided');
  assert.equal(decided.request.state, 'approved');
  assert.deepEqual(decided.request.decidedBy, REVIEWER.subject);
});

test('rejects weak requester, self-decision and semantic actionRef replay drift', async () => {
  const state = fixture();
  const service = createClusterPluginPackageSecretBindingManagementService({
    pool: state.pool,
    now: () => 210,
    planLifetimeMs: 1_000,
  });
  await assert.rejects(
    service.plan(planRequest({
      principal: { ...REQUESTER, assurance: 'single_factor' },
    })),
    PluginPackageManagementAuthorizationError,
  );
  const created = await service.plan(planRequest());
  await assert.rejects(
    service.plan(planRequest({
      assignments: [{
        name: 'TOKEN',
        secretRef: createSecretRef({
          projectId: 'project-1',
          name: 'another-token',
          version: 2,
        }),
      }],
    })),
    PluginPackageManagementConflictError,
  );
  const proposed = await service.propose({
    actionRef: created.plan.actionRef,
    approvalRequestId: 'approval-secret-binding-1',
    approvalAuditEventId: '123e4567-e89b-42d3-a456-426614175201',
    principal: REQUESTER,
  });
  await assert.rejects(
    service.decide({
      actionRef: created.plan.actionRef,
      approvalRequestId: proposed.approvalRequest.id,
      expectedVersion: 1,
      decisionId: 'decision-secret-binding-self',
      auditEventId: '123e4567-e89b-42d3-a456-426614175203',
      decision: 'approved',
      reasonCode: 'reviewed',
      principal: REQUESTER,
    }),
    (error) => error?.name === 'ApprovalSeparationOfDutyError',
  );
});
