const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  createTaskDefinitionRecord,
} = require('@qinglong/runtime-core/task-definition');
const {
  createLocalPresenceProofManager,
} = require('../dist/authentication/localPresenceProof.js');
const {
  createLocalApiTaskAuthoringRoute,
} = require('../dist/task/taskAuthoringRoute.js');

const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'owner' }),
  authenticationId: 'local_credential:owner-console:1',
  authenticatedAtMs: 9_000,
  expiresAtMs: 1_000_000,
  assurance: 'single_factor',
});

const FENCE = Object.freeze({
  credentialId: 'owner-console',
  credentialVersion: 1,
  pepperKeyId: 'owner-v1',
  materialDigest: 'a'.repeat(64),
  subjectType: 'user',
  subjectId: 'owner',
  secretDigest: 'b'.repeat(64),
  notBeforeAtMs: 1,
  expiresAtMs: 1_000_000,
});

function uuidFactory() {
  let sequence = 400;
  return () => {
    sequence += 1;
    return `019fa000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  };
}

function definition(revision = 3) {
  const first = createTaskDefinitionRecord(
    {
      projectId: 'default',
      taskId: 'task-console',
      expectedRevision: null,
      mutationId: '019fa000-0000-4000-8000-000000000101',
      name: 'Editable Task',
      description: 'Full definition stays behind strong authoring read',
      kind: 'command',
      spec: Object.freeze({
        schema: 'qinglong/command@v1',
        config: Object.freeze({
          command: Object.freeze({
            kind: 'argv',
            file: '/bin/echo',
            args: Object.freeze(['before']),
          }),
        }),
      }),
      labels: Object.freeze({ 'qinglong.source': 'local-console' }),
      enabled: true,
      occurredAtMs: 10_000,
    },
    10_000,
  );
  return Object.freeze({ ...first, revision });
}

function fixture(t, overrides = {}) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-task-authoring-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  let now = 10_000;
  let current = definition();
  const calls = [];
  const presenceProof = createLocalPresenceProofManager({
    deploymentRoot,
    profile: 'edge',
    now: () => now,
    randomUuid: uuidFactory(),
    randomSecret: () => Buffer.alloc(32, 17),
  });
  t.after(() => presenceProof.close());
  const projectPolicy = {
    async resolve(projectId, subject) {
      calls.push(['policy', projectId, subject]);
      return {
        project: {
          id: projectId,
          name: 'Default',
          slug: 'default',
          status: 'active',
          version: 3,
          createdAtMs: 1,
          updatedAtMs: 2,
        },
        binding: {
          projectId,
          subject,
          version: 5,
          state: 'active',
          role: 'owner',
          mutationId: 'owner-binding',
          changedBy: { type: 'user', id: 'bootstrap-owner' },
          createdAtMs: 2,
        },
      };
    },
    async append() {
      throw new Error('not used');
    },
  };
  const route = createLocalApiTaskAuthoringRoute({
    profile: 'edge',
    projectPolicy,
    taskDefinitions: {
      async findCurrentTaskDefinition() {
        calls.push(['read']);
        return current;
      },
    },
    securityAudit: {
      async record(record) {
        calls.push(['audit', record]);
      },
    },
    presenceProof,
    now: () => now,
    randomUuid: uuidFactory(),
    randomSecret: () => Buffer.alloc(32, 19),
    ...overrides,
  });
  t.after(() => route.close());
  const authenticated = Object.freeze({
    principal: PRINCIPAL,
    credentialFence: FENCE,
    async confirm() {
      calls.push(['confirm']);
    },
  });
  return {
    route,
    calls,
    deploymentRoot,
    authenticated,
    current: () => current,
    setCurrent(value) {
      current = value;
    },
    setNow(value) {
      now = value;
    },
  };
}

function request(state, overrides = {}) {
  return Object.freeze({
    requestId: 'local:019fa000-0000-4000-8000-000000000301',
    projectId: 'default',
    taskId: 'task-console',
    presence: null,
    authenticated: state.authenticated,
    signal: new AbortController().signal,
    ...overrides,
  });
}

function proof(state, challenge) {
  return JSON.parse(
    fs.readFileSync(
      path.join(
        state.deploymentRoot,
        'console-presence',
        challenge.body.proofFileName,
      ),
      'utf8',
    ),
  ).proof;
}

function leaseBinding(state, overrides = {}) {
  const task = state.current();
  return Object.freeze({
    projectId: 'default',
    taskId: 'task-console',
    revision: task.revision,
    contentDigest: task.contentDigest,
    credentialId: FENCE.credentialId,
    credentialVersion: FENCE.credentialVersion,
    subjectType: 'user',
    subjectId: FENCE.subjectId,
    ...overrides,
  });
}

async function openAuthoring(state) {
  const challenge = await state.route.handle(request(state));
  assert.equal(challenge.statusCode, 428);
  return state.route.handle(
    request(state, { presence: proof(state, challenge) }),
  );
}

test('returns the full exact definition only after local presence and issues one credential-bound lease', async (t) => {
  const state = fixture(t);
  const value = await openAuthoring(state);
  assert.equal(value.statusCode, 200);
  assert.deepEqual(value.body.task.spec, state.current().spec);
  assert.deepEqual(value.body.task.labels, state.current().labels);
  assert.equal(value.body.task.description, state.current().description);
  assert.equal(value.body.authoring.revision, state.current().revision);
  assert.equal(
    value.body.authoring.contentDigest,
    state.current().contentDigest,
  );
  assert.match(value.body.authoring.lease, /^ql3a_[A-Za-z0-9_-]+$/);
  assert.equal(state.calls.filter(([kind]) => kind === 'confirm').length, 2);
  assert.deepEqual(
    state.calls
      .filter(([kind]) => kind === 'audit')
      .map(([, record]) => [
        record.operationId,
        record.outcome,
        record.reasons[0],
      ]),
    [
      ['task.authoring.read', 'approval_required', 'local_presence_required'],
      ['task.authoring.read', 'allowed', 'role_grant'],
    ],
  );
  assert.equal(
    state.route.leases.inspect(value.body.authoring.lease, leaseBinding(state)),
    true,
  );
  assert.equal(
    state.route.leases.inspect(
      value.body.authoring.lease,
      leaseBinding(state, { credentialVersion: 2 }),
    ),
    false,
  );
  assert.equal(
    state.route.leases.consume(value.body.authoring.lease, leaseBinding(state)),
    true,
  );
  assert.equal(
    state.route.leases.consume(value.body.authoring.lease, leaseBinding(state)),
    false,
  );
});

test('binds a lease to the exact revision/content and expires it without a timer', async (t) => {
  const state = fixture(t);
  const value = await openAuthoring(state);
  const lease = value.body.authoring.lease;
  assert.equal(
    state.route.leases.inspect(
      lease,
      leaseBinding(state, { contentDigest: 'f'.repeat(64) }),
    ),
    false,
  );
  state.setNow(value.body.authoring.expiresAtMs);
  assert.equal(state.route.leases.inspect(lease, leaseBinding(state)), false);
});

test('rejects non-User and unauthorized requests before publishing a proof', async (t) => {
  const state = fixture(t, {
    projectPolicy: {
      async resolve(projectId, subject) {
        return {
          project: {
            id: projectId,
            name: 'Default',
            slug: 'default',
            status: 'active',
            version: 3,
            createdAtMs: 1,
            updatedAtMs: 2,
          },
          binding: {
            projectId,
            subject,
            version: 5,
            state: 'active',
            role: 'viewer',
            mutationId: 'viewer-binding',
            changedBy: { type: 'user', id: 'bootstrap-owner' },
            createdAtMs: 2,
          },
        };
      },
      async append() {
        throw new Error('not used');
      },
    },
  });
  assert.deepEqual(await state.route.handle(request(state)), {
    statusCode: 403,
    body: { code: 'forbidden' },
  });
  assert.deepEqual(
    fs.readdirSync(path.join(state.deploymentRoot, 'console-presence')),
    [],
  );

  const system = Object.freeze({
    ...state.authenticated,
    principal: Object.freeze({
      ...PRINCIPAL,
      subject: Object.freeze({ type: 'system', id: 'runtime' }),
      assurance: 'service',
    }),
    credentialFence: Object.freeze({
      ...FENCE,
      subjectType: 'system',
      subjectId: 'runtime',
    }),
  });
  assert.deepEqual(
    await state.route.handle(request(state, { authenticated: system })),
    { statusCode: 403, body: { code: 'forbidden' } },
  );
});

test('bounds Edge authoring leases to eight and clears them on close', async (t) => {
  const state = fixture(t);
  const leases = [];
  for (let index = 0; index < 8; index += 1) {
    const value = await openAuthoring(state);
    assert.equal(value.statusCode, 200);
    leases.push(value.body.authoring.lease);
  }
  const exhausted = await state.route.handle(request(state));
  assert.deepEqual(exhausted, {
    statusCode: 503,
    body: { code: 'task_authoring_unavailable' },
  });
  state.route.close();
  assert.equal(
    state.route.leases.inspect(leases[0], leaseBinding(state)),
    false,
  );
  assert.deepEqual(await state.route.handle(request(state)), {
    statusCode: 503,
    body: { code: 'request_unavailable' },
  });
});
