const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ClusterControlAdmissionSecurityError,
  createClusterControlAdmissionPipeline,
  createClusterControlProjectPolicyAuthorizer,
} = require('@qinglong/cluster-control/admission');
const {
  createClusterControlRouteRegistry,
} = require('@qinglong/cluster-control/routes');

const NOW = 10_000;
const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'usr_primary' }),
  authenticationId: 'session:abc123',
  authenticatedAtMs: 9_000,
  expiresAtMs: 11_000,
  assurance: 'multi_factor',
});
const METADATA = Object.freeze({
  requestId: 'request-1',
  method: 'POST',
  path: '/api/v3/projects/prj_default/runs',
  query: Object.freeze({}),
  headers: Object.freeze({ authorization: 'Bearer opaque' }),
  signal: new AbortController().signal,
});

function options(overrides = {}) {
  const events = overrides.events ?? [];
  return {
    routes: createClusterControlRouteRegistry([
      {
        method: 'POST',
        path: '/api/v3/projects/{projectId}/runs',
        operationId: 'run.create',
        permission: 'run.start',
        projectParameter: 'projectId',
        handle(input, parameters) {
          events.push(
            `handle:${parameters.projectId}:${input.request.body.taskId}`,
          );
          return { statusCode: 202, body: { accepted: true } };
        },
      },
    ]),
    authenticator: {
      authenticate() {
        events.push('authenticate');
        return PRINCIPAL;
      },
    },
    policy: {
      authorize(request) {
        events.push(`authorize:${request.permission}`);
        return {
          effect: 'allow',
          reasons: ['role_grant'],
          fence: { projectVersion: 2, bindingVersion: 3 },
        };
      },
    },
    audit: {
      record(record) {
        events.push(`audit:${record.outcome}`);
      },
    },
    now: () => NOW,
    ...overrides,
  };
}

test('authenticates, authorizes and audits before accepting a body', async () => {
  const events = [];
  const pipeline = createClusterControlAdmissionPipeline(options({ events }));
  const prepared = await pipeline.prepare(METADATA);
  assert.deepEqual(events, [
    'authenticate',
    'authorize:run.start',
    'audit:allowed',
  ]);
  assert.deepEqual(await prepared.handle({ taskId: 'task-1' }), {
    statusCode: 202,
    body: { accepted: true },
  });
  assert.deepEqual(events.slice(-1), ['handle:prj_default:task-1']);
});

test('requires a reviewed route registry and rejects unknown routes before authentication', async () => {
  assert.throws(
    () =>
      createClusterControlAdmissionPipeline(
        options({
          routes: {
            contractVersion: 1,
            size: 1,
            resolve() {
              return null;
            },
          },
        }),
      ),
    /options are invalid/,
  );

  const events = [];
  const pipeline = createClusterControlAdmissionPipeline(options({ events }));
  await assert.rejects(
    pipeline.prepare({
      ...METADATA,
      path: '/api/v3/projects/prj_default/tasks',
    }),
    (error) =>
      error instanceof ClusterControlAdmissionSecurityError &&
      error.statusCode === 404 &&
      error.code === 'route_not_found',
  );
  assert.deepEqual(events, []);
});

test('rejects missing authentication before policy and handler execution', async () => {
  const events = [];
  const pipeline = createClusterControlAdmissionPipeline(
    options({
      events,
      authenticator: {
        authenticate() {
          events.push('authenticate');
          return null;
        },
      },
    }),
  );
  await assert.rejects(
    pipeline.prepare(METADATA),
    (error) =>
      error instanceof ClusterControlAdmissionSecurityError &&
      error.statusCode === 401 &&
      error.code === 'authentication_required',
  );
  assert.equal(events.includes('authorize:run.start'), false);
  assert.equal(
    events.some((event) => event.startsWith('handle:')),
    false,
  );
  assert.equal(events.includes('audit:authentication_rejected'), true);
});

test('maps policy decisions to low-sensitive deny and approval responses', async () => {
  for (const [effect, code, outcome] of [
    ['deny', 'forbidden', 'denied'],
    ['require_approval', 'approval_required', 'approval_required'],
  ]) {
    const events = [];
    const pipeline = createClusterControlAdmissionPipeline(
      options({
        events,
        policy: {
          authorize() {
            return { effect, reasons: ['policy_decision'], fence: null };
          },
        },
      }),
    );
    await assert.rejects(
      pipeline.prepare(METADATA),
      (error) =>
        error instanceof ClusterControlAdmissionSecurityError &&
        error.statusCode === 403 &&
        error.code === code &&
        !error.message.includes('policy_decision'),
    );
    assert.equal(events.includes(`audit:${outcome}`), true);
  }
});

test('fails closed when authentication, policy or security audit is unavailable', async () => {
  const scenarios = [
    {
      override: {
        authenticator: {
          authenticate() {
            throw new Error('identity database detail');
          },
        },
      },
      code: 'authentication_unavailable',
    },
    {
      override: {
        policy: {
          authorize() {
            throw new Error('policy database detail');
          },
        },
      },
      code: 'authorization_unavailable',
    },
    {
      override: {
        audit: {
          record() {
            throw new Error('audit store detail');
          },
        },
      },
      code: 'security_audit_unavailable',
    },
  ];
  for (const scenario of scenarios) {
    const pipeline = createClusterControlAdmissionPipeline(
      options(scenario.override),
    );
    await assert.rejects(
      pipeline.prepare(METADATA),
      (error) =>
        error instanceof ClusterControlAdmissionSecurityError &&
        error.statusCode === 503 &&
        error.code === scenario.code &&
        !error.message.includes('database detail') &&
        !error.message.includes('store detail'),
    );
  }
});

test('adapts the shared fenced Project Policy engine without an allow-all seam', async () => {
  const policy = createClusterControlProjectPolicyAuthorizer({
    async resolve(projectId, subject) {
      assert.equal(projectId, 'prj_default');
      return {
        project: {
          id: projectId,
          name: 'Default',
          slug: 'default',
          status: 'active',
          version: 4,
          createdAtMs: 0,
          updatedAtMs: 1,
        },
        binding: {
          projectId,
          subject,
          version: 7,
          state: 'active',
          role: 'operator',
          mutationId: 'grant-7',
          changedBy: { type: 'user', id: 'usr_owner' },
          createdAtMs: 1,
        },
      };
    },
    async append() {
      throw new Error('not used');
    },
  });
  assert.deepEqual(
    await policy.authorize({
      principal: PRINCIPAL,
      operationId: 'run.create',
      permission: 'run.start',
      projectId: 'prj_default',
      signal: METADATA.signal,
    }),
    {
      effect: 'allow',
      reasons: ['role_grant'],
      fence: { projectVersion: 4, bindingVersion: 7 },
    },
  );
  assert.equal(
    (
      await policy.authorize({
        principal: PRINCIPAL,
        operationId: 'project.update',
        permission: 'project.manage',
        projectId: null,
        signal: METADATA.signal,
      })
    ).effect,
    'deny',
  );
});
