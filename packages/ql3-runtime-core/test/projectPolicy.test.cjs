const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidProjectPolicyValueError,
  ProjectPolicyEngine,
  ProjectPolicyUnavailableError,
  normalizeProjectPermission,
  normalizeProjectPolicySnapshot,
  normalizeProjectRoleBinding,
} = require('@qinglong/runtime-core/project-policy');

const PROJECT = Object.freeze({
  id: 'default',
  name: 'Default',
  slug: 'default',
  status: 'active',
  version: 2,
  createdAtMs: 0,
  updatedAtMs: 1,
});

function binding(overrides = {}) {
  return {
    projectId: 'default',
    subject: { type: 'user', id: 'usr_primary' },
    version: 3,
    state: 'active',
    role: 'operator',
    mutationId: 'grant-1',
    changedBy: { type: 'user', id: 'usr_owner' },
    createdAtMs: 2,
    ...overrides,
  };
}

function engine(snapshot) {
  return new ProjectPolicyEngine({
    async resolve() {
      if (snapshot instanceof Error) throw snapshot;
      return snapshot;
    },
    async append() {
      throw new Error('not used');
    },
  });
}

test('normalizes active and revoked bindings with exact state/role shape', () => {
  assert.equal(normalizeProjectRoleBinding(binding()).role, 'operator');
  const revoked = binding({ state: 'revoked' });
  delete revoked.role;
  assert.deepEqual(normalizeProjectRoleBinding(revoked), {
    projectId: 'default',
    subject: { type: 'user', id: 'usr_primary' },
    version: 3,
    state: 'revoked',
    mutationId: 'grant-1',
    changedBy: { type: 'user', id: 'usr_owner' },
    createdAtMs: 2,
  });
  assert.throws(
    () => normalizeProjectRoleBinding(binding({ state: 'revoked' })),
    InvalidProjectPolicyValueError,
  );
});

test('evaluates role matrix, archived state and immutable policy fences', async () => {
  const policy = engine({ project: PROJECT, binding: binding() });
  assert.deepEqual(
    await policy.decide({
      subject: { type: 'user', id: 'usr_primary' },
      projectId: 'default',
      permission: 'run.start',
    }),
    {
      effect: 'allow',
      reasons: ['role_grant'],
      fence: { projectVersion: 2, bindingVersion: 3 },
    },
  );
  assert.equal(
    (
      await policy.decide({
        subject: { type: 'user', id: 'usr_primary' },
        projectId: 'default',
        permission: 'project.manage',
      })
    ).effect,
    'deny',
  );
  const archived = engine({
    project: { ...PROJECT, status: 'archived' },
    binding: binding({ role: 'owner' }),
  });
  assert.equal(
    (
      await archived.decide({
        subject: { type: 'user', id: 'usr_primary' },
        projectId: 'default',
        permission: 'run.start',
      })
    ).reasons[0],
    'project_archived',
  );
});

test('requires approval for an authorized agent write', async () => {
  const policy = engine({
    project: PROJECT,
    binding: binding({
      subject: { type: 'agent', id: 'agent_planner' },
      role: 'operator',
    }),
  });
  const decision = await policy.decide({
    subject: { type: 'agent', id: 'agent_planner' },
    projectId: 'default',
    permission: 'run.start',
  });
  assert.equal(decision.effect, 'require_approval');
  assert.deepEqual(decision.reasons, ['agent_action_requires_approval']);
});

test('treats approval discovery as read-only without granting decisions', async () => {
  assert.equal(normalizeProjectPermission('approval.read'), 'approval.read');
  for (const [role, expected] of [
    ['owner', 'allow'],
    ['admin', 'allow'],
    ['operator', 'allow'],
    ['viewer', 'allow'],
  ]) {
    const subject = { type: 'agent', id: `agent_${role}` };
    const decision = await engine({
      project: PROJECT,
      binding: binding({ subject, role }),
    }).decide({ subject, projectId: 'default', permission: 'approval.read' });
    assert.equal(decision.effect, expected, role);
  }
  const decision = await engine({
    project: PROJECT,
    binding: binding({
      subject: { type: 'agent', id: 'agent_operator' },
      role: 'operator',
    }),
  }).decide({
    subject: { type: 'agent', id: 'agent_operator' },
    projectId: 'default',
    permission: 'approval.decide',
  });
  assert.equal(decision.effect, 'deny');
});

test('grants model invocation only to cost-bearing roles and approval-fences agents', async () => {
  assert.equal(normalizeProjectPermission('model.invoke'), 'model.invoke');
  for (const [role, subjectType, expected] of [
    ['owner', 'user', 'allow'],
    ['admin', 'user', 'allow'],
    ['operator', 'user', 'allow'],
    ['viewer', 'user', 'deny'],
    ['operator', 'agent', 'require_approval'],
  ]) {
    const subject = { type: subjectType, id: `${subjectType}_${role}` };
    const decision = await engine({
      project: PROJECT,
      binding: binding({ subject, role }),
    }).decide({
      subject,
      projectId: 'default',
      permission: 'model.invoke',
    });
    assert.equal(decision.effect, expected, `${subjectType}/${role}`);
  }
});

test('limits package administration to admin/owner and approval-fences agents', async () => {
  assert.equal(normalizeProjectPermission('package.manage'), 'package.manage');
  assert.throws(
    () => normalizeProjectPermission('package.install'),
    InvalidProjectPolicyValueError,
  );
  for (const [role, subjectType, expected] of [
    ['owner', 'user', 'allow'],
    ['admin', 'user', 'allow'],
    ['operator', 'user', 'deny'],
    ['viewer', 'user', 'deny'],
    ['admin', 'agent', 'require_approval'],
  ]) {
    const decision = await engine({
      project: PROJECT,
      binding: binding({
        subject: { type: subjectType, id: `${subjectType}_${role}` },
        role,
      }),
    }).decide({
      subject: { type: subjectType, id: `${subjectType}_${role}` },
      projectId: 'default',
      permission: 'package.manage',
    });
    assert.equal(decision.effect, expected, `${subjectType}/${role}`);
  }
});

test('denies missing bindings and fails closed on corrupt or unavailable storage', async () => {
  assert.equal(
    (
      await engine({ project: PROJECT }).decide({
        subject: { type: 'api_app', id: 'app_reader' },
        projectId: 'default',
        permission: 'run.read',
      })
    ).reasons[0],
    'subject_unbound',
  );
  await assert.rejects(
    engine(new Error('driver detail')).decide({
      subject: { type: 'user', id: 'usr_primary' },
      projectId: 'default',
      permission: 'run.read',
    }),
    ProjectPolicyUnavailableError,
  );
  assert.throws(
    () =>
      normalizeProjectPolicySnapshot({
        project: PROJECT,
        binding: binding({ projectId: 'other' }),
      }),
    InvalidProjectPolicyValueError,
  );
});
