'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  approvalRequestDigest,
  createApprovalRequest,
  decideApprovalRequest,
} = require('@qinglong/runtime-core/approved-action');
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
  consumeClusterPluginPackageSecretBindingTransitionApprovals,
} = require('@qinglong/cluster-admin/plugin-package-secret-binding-transition-approval-consumer');

const REQUESTER = Object.freeze({ type: 'user', id: 'cluster-owner' });
const REVIEWER = Object.freeze({ type: 'user', id: 'security-reviewer' });
const FENCE = Object.freeze({ projectVersion: 3, bindingVersion: 4 });

function manifest(version) {
  return {
    apiVersion: 'qinglong.io/v1alpha1',
    kind: 'Package',
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version,
      description: 'Secret transition consumer fixture',
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

function plan() {
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

function approvedRequest(candidate) {
  return decideApprovalRequest(
    createApprovalRequest({
      id: 'approval-secret-transition-1',
      projectId: 'project-1',
      action: pluginPackageSecretBindingTransitionApprovedAction(candidate),
      risk: 'high',
      decisionMode: 'separation_of_duty',
      requestedBy: REQUESTER,
      requestedAtMs: 110,
      expiresAtMs: 900,
      requestFence: FENCE,
    }),
    {
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
    },
  );
}

function pool(candidate, request, policyEffect = 'allow') {
  const dispatches = new Map();
  return {
    dispatches,
    async query(text, values) {
      if (text.includes('JOIN "ql3"."plugin_package_secret_binding_transition_approval_plans"')) {
        return {
          rows: [{
            requestJson: request,
            requestDigest: approvalRequestDigest(request),
          }],
        };
      }
      if (text.includes('FROM "ql3"."plugin_package_secret_binding_transition_approval_plans"')) {
        return { rows: [{ planJson: candidate }] };
      }
      if (text.includes('FROM "ql3"."projects" AS project')) {
        return policyEffect === 'deny'
          ? { rows: [] }
          : {
              rows: [{
                projectId: 'project-1',
                projectName: 'Project 1',
                projectSlug: 'project-1',
                projectStatus: 'active',
                projectVersion: 3,
                projectCreatedAtMs: 1,
                projectUpdatedAtMs: 2,
                bindingProjectId: 'project-1',
                bindingSubjectType: 'user',
                bindingSubjectId: 'cluster-owner',
                bindingVersion: 4,
                bindingState: 'active',
                bindingRole: 'admin',
                bindingMutationId: 'binding-owner-v4',
                bindingChangedByType: 'user',
                bindingChangedById: 'root-owner',
                bindingCreatedAtMs: 2,
              }],
            };
      }
      if (
        text === 'BEGIN ISOLATION LEVEL SERIALIZABLE' ||
        text === 'COMMIT' ||
        text === 'ROLLBACK'
      ) return { rows: [] };
      if (text.includes('SELECT set_config(')) return { rows: [{}] };
      if (text.includes('lock_approval_policy_fence')) {
        return { rows: [{ matches: true }] };
      }
      if (text.includes('FROM "ql3"."approval_requests"')) {
        return {
          rows: [{
            requestJson: request,
            requestDigest: approvalRequestDigest(request),
          }],
        };
      }
      if (text.includes('INSERT INTO "ql3"."approved_action_dispatches"')) {
        dispatches.set(values[0], values);
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('INSERT INTO "ql3"."approved_action_executions"')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('UPDATE "ql3"."approval_requests"')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('INSERT INTO "ql3"."security_audit_events"')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    async connect() {
      return { query: this.query.bind(this), release() {} };
    },
  };
}

test('consumes one exact approved Secret transition under a current requester fence', async () => {
  const candidate = plan();
  const request = approvedRequest(candidate);
  const database = pool(candidate, request);
  assert.deepEqual(
    await consumeClusterPluginPackageSecretBindingTransitionApprovals({
      pool: database,
      now: () => 130,
      limit: 4,
    }),
    { scanned: 1, consumed: 1, existing: 0, expired: 0, blocked: 0 },
  );
  assert.equal(database.dispatches.size, 1);
});

test('does not consume expired or no-longer-authorized Secret transitions', async () => {
  const candidate = plan();
  const request = approvedRequest(candidate);
  assert.deepEqual(
    await consumeClusterPluginPackageSecretBindingTransitionApprovals({
      pool: pool(candidate, request),
      now: () => 901,
      limit: 4,
    }),
    { scanned: 1, consumed: 0, existing: 0, expired: 1, blocked: 0 },
  );
  assert.deepEqual(
    await consumeClusterPluginPackageSecretBindingTransitionApprovals({
      pool: pool(candidate, request, 'deny'),
      now: () => 130,
      limit: 4,
    }),
    { scanned: 1, consumed: 0, existing: 0, expired: 0, blocked: 1 },
  );
});
