require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { test } = require('node:test');
const legacyDomain = require('../../back/runtime/domain/projectPolicy');
const {
  ProjectPolicyEngine: LegacyProjectPolicyEngine,
} = require('../../back/runtime/application/projectPolicyEngine');
const runtimeDomain = require('../../packages/ql3-runtime-core/src/security/project-policy/projectPolicy');
const {
  SECURITY_SUBJECT_TYPES,
} = require('../../packages/ql3-runtime-core/src/security/security');

const PROJECT = Object.freeze({
  id: 'default',
  name: 'Default',
  slug: 'default',
  status: 'active',
  version: 2,
  createdAtMs: 0,
  updatedAtMs: 1,
});

function binding(subject, role = 'operator', state = 'active') {
  return {
    projectId: 'default',
    subject,
    version: 3,
    state,
    ...(state === 'active' ? { role } : {}),
    mutationId: 'mutation-3',
    changedBy: { type: 'user', id: 'usr_owner' },
    createdAtMs: 1,
  };
}

function repository(snapshot) {
  return {
    async resolve() {
      return snapshot;
    },
    async append() {
      throw new Error('not used');
    },
  };
}

test('runtime-core preserves the legacy Project Policy vocabulary with explicit 3.0 extensions', () => {
  assert.deepEqual(
    [...SECURITY_SUBJECT_TYPES],
    [...legacyDomain.POLICY_SUBJECT_TYPES],
  );
  assert.deepEqual(
    [...runtimeDomain.PROJECT_STATUSES],
    [...legacyDomain.PROJECT_STATUSES],
  );
  assert.deepEqual(
    [...runtimeDomain.PROJECT_ROLES],
    [...legacyDomain.PROJECT_ROLES],
  );
  assert.deepEqual(
    [...runtimeDomain.PROJECT_ROLE_BINDING_STATES],
    [...legacyDomain.PROJECT_ROLE_BINDING_STATES],
  );
  const runtimeOnlyPermissions =
    runtimeDomain.STATIC_PROJECT_PERMISSIONS.filter(
      (permission) =>
        !legacyDomain.STATIC_PROJECT_PERMISSIONS.includes(permission),
    );
  assert.deepEqual(runtimeOnlyPermissions, [
    'trigger.read',
    'trigger.create',
    'trigger.update',
    'model.invoke',
    'approval.read',
    'package.manage',
  ]);
  const runtimeOnlyPermissionSet = new Set(runtimeOnlyPermissions);
  assert.deepEqual(
    runtimeDomain.STATIC_PROJECT_PERMISSIONS.filter(
      (permission) => !runtimeOnlyPermissionSet.has(permission),
    ),
    [...legacyDomain.STATIC_PROJECT_PERMISSIONS],
  );
});

test('runtime-core and legacy engines return identical effect, reasons and fence', async () => {
  const cases = [
    {
      snapshot: null,
      subject: { type: 'user', id: 'usr_primary' },
      permission: 'run.read',
    },
    {
      snapshot: { project: PROJECT },
      subject: { type: 'api_app', id: 'app_reader' },
      permission: 'run.read',
    },
    {
      subject: { type: 'user', id: 'usr_primary' },
      permission: 'run.start',
      snapshot: {
        project: PROJECT,
        binding: binding({ type: 'user', id: 'usr_primary' }),
      },
    },
    {
      subject: { type: 'user', id: 'usr_viewer' },
      permission: 'run.start',
      snapshot: {
        project: PROJECT,
        binding: binding({ type: 'user', id: 'usr_viewer' }, 'viewer'),
      },
    },
    {
      subject: { type: 'agent', id: 'agent_planner' },
      permission: 'run.start',
      snapshot: {
        project: PROJECT,
        binding: binding({ type: 'agent', id: 'agent_planner' }),
      },
    },
    {
      subject: { type: 'user', id: 'usr_owner' },
      permission: 'run.start',
      snapshot: {
        project: { ...PROJECT, status: 'archived' },
        binding: binding({ type: 'user', id: 'usr_owner' }, 'owner'),
      },
    },
  ];

  for (const candidate of cases) {
    const request = {
      subject: candidate.subject,
      projectId: 'default',
      permission: candidate.permission,
    };
    const legacy = await new LegacyProjectPolicyEngine(
      repository(candidate.snapshot),
    ).decideWithFence(request);
    const runtime = await new runtimeDomain.ProjectPolicyEngine(
      repository(candidate.snapshot),
    ).decide(request);
    assert.deepEqual(runtime, {
      effect: legacy.decision.effect,
      reasons: legacy.decision.reasons,
      fence: legacy.fence,
    });
  }
});
