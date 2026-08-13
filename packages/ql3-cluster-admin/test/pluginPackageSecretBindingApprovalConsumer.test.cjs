'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  createApprovalRequest,
  decideApprovalRequest,
  approvalRequestDigest,
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
const { createSecretRef } = require('@qinglong/runtime-core/secret-reference');
const {
  consumeClusterPluginPackageSecretBindingApprovals,
} = require('@qinglong/cluster-admin/plugin-package-secret-binding-approval-consumer');

const REQUESTER = Object.freeze({ type: 'user', id: 'cluster-owner' });
const REVIEWER = Object.freeze({ type: 'user', id: 'security-reviewer' });
const FENCE = Object.freeze({ projectVersion: 3, bindingVersion: 4 });

function plan() {
  const manifest = {
    apiVersion: 'qinglong.io/v1alpha1',
    kind: 'Package',
    metadata: {
      name: 'example-monitor',
      displayName: 'Example Monitor',
      version: '1.0.0',
      description: 'Secret binding consumer fixture',
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
  return createPluginPackageSecretBindingApprovalPlan({
    actionRef: 'secret-binding:example-monitor-v1',
    bindingPlan: createPluginPackageSecretBindingPlan({
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
    }),
    requestedBy: REQUESTER,
    expiresAtMs: 1_000,
  });
}

function approvedRequest(candidate) {
  return decideApprovalRequest(
    createApprovalRequest({
      id: 'approval-secret-binding-1',
      projectId: 'project-1',
      action: pluginPackageSecretBindingApprovedAction(candidate),
      risk: 'high',
      decisionMode: 'separation_of_duty',
      requestedBy: REQUESTER,
      requestedAtMs: 110,
      expiresAtMs: 900,
      requestFence: FENCE,
    }),
    {
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
    },
  );
}

function pool(candidate, request, policyEffect = 'allow') {
  const dispatches = new Map();
  return {
    dispatches,
    async query(text, values) {
      if (text.includes('JOIN "ql3"."plugin_package_secret_binding_approval_plans"')) {
        return {
          rows: [{
            requestJson: request,
            requestDigest: approvalRequestDigest(request),
          }],
        };
      }
      if (text.includes('FROM "ql3"."plugin_package_secret_binding_approval_plans"')) {
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
      ) {
        return { rows: [] };
      }
      if (text.includes("SELECT set_config(")) return { rows: [{}] };
      if (text.includes('lock_approval_policy_fence')) {
        return { rows: [{ matches: true }] };
      }
      if (text.includes('FROM "ql3"."approval_requests"')) {
        return { rows: [{ requestJson: request, requestDigest: approvalRequestDigest(request) }] };
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

test('consumes one exact approved Secret binding request under a current requester fence', async () => {
  const candidate = plan();
  const request = approvedRequest(candidate);
  const database = pool(candidate, request);
  const summary = await consumeClusterPluginPackageSecretBindingApprovals({
    pool: database,
    now: () => 130,
    limit: 4,
  });
  assert.deepEqual(summary, {
    scanned: 1,
    consumed: 1,
    existing: 0,
    expired: 0,
    blocked: 0,
  });
  assert.equal(database.dispatches.size, 1);
});

test('does not consume expired or no-longer-authorized approvals', async () => {
  const candidate = plan();
  const request = approvedRequest(candidate);
  assert.deepEqual(
    await consumeClusterPluginPackageSecretBindingApprovals({
      pool: pool(candidate, request),
      now: () => 901,
      limit: 4,
    }),
    { scanned: 1, consumed: 0, existing: 0, expired: 1, blocked: 0 },
  );
  assert.deepEqual(
    await consumeClusterPluginPackageSecretBindingApprovals({
      pool: pool(candidate, request, 'deny'),
      now: () => 130,
      limit: 4,
    }),
    { scanned: 1, consumed: 0, existing: 0, expired: 0, blocked: 1 },
  );
});
