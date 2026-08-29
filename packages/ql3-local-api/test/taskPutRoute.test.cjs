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
const { createLocalApiTaskPutRoute } = require('../dist/task/taskPutRoute.js');

const PRINCIPAL = Object.freeze({
  subject: Object.freeze({ type: 'user', id: 'owner' }),
  authenticationId: 'local_credential:owner-console:1',
  authenticatedAtMs: 9_000,
  expiresAtMs: 60_000,
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
  expiresAtMs: 60_000,
});

function taskBody(overrides = {}) {
  return Object.freeze({
    expectedRevision: null,
    mutationId: '019f9000-0000-4000-8000-000000000101',
    name: 'Presence-bound Task',
    description: 'Created from the Local Console mutation route',
    kind: 'command',
    spec: Object.freeze({
      schema: 'qinglong/command@v1',
      config: Object.freeze({
        command: Object.freeze({
          kind: 'argv',
          file: '/bin/echo',
          args: Object.freeze(['hello']),
        }),
      }),
    }),
    labels: Object.freeze({ 'qinglong.test': 'presence' }),
    enabled: true,
    occurredAtMs: 10_000,
    ...overrides,
  });
}

function uuidFactory() {
  let sequence = 200;
  return () => {
    sequence += 1;
    return `019f9000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  };
}

function fixture(t, overrides = {}) {
  const {
    currentDefinition: initialCurrentDefinition = null,
    ...routeOverrides
  } = overrides;
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-task-put-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  let now = 10_000;
  let currentDefinition = initialCurrentDefinition;
  const calls = [];
  const presenceProof = createLocalPresenceProofManager({
    deploymentRoot,
    profile: 'edge',
    now: () => now,
    randomUuid: uuidFactory(),
    randomSecret: () => Buffer.alloc(32, 13),
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
  const taskDefinitions = {
    async findCurrentTaskDefinition() {
      return currentDefinition;
    },
    async findTaskDefinitionRevision() {
      return null;
    },
    async listTaskDefinitions() {
      return { definitions: [], truncated: false };
    },
  };
  const route = createLocalApiTaskPutRoute({
    projectPolicy,
    taskDefinitions,
    async taskDefinitionAdministrationForCredential(fence) {
      calls.push(['credential-fence', fence]);
      return {
        async appendAuthorizedTaskDefinitionRevision(mutation) {
          calls.push(['mutation', mutation]);
          return {
            status:
              mutation.command.expectedRevision === null
                ? 'created'
                : 'updated',
            definition: createTaskDefinitionRecord(mutation.command, now),
          };
        },
      };
    },
    securityAudit: {
      async record(record) {
        calls.push(['audit', record]);
      },
    },
    presenceProof,
    taskAuthoringLeases: {
      inspect() {
        return true;
      },
      consume() {
        return true;
      },
    },
    now: () => now,
    randomUuid: uuidFactory(),
    ...routeOverrides,
  });
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
    setNow(value) {
      now = value;
    },
    setCurrentDefinition(value) {
      currentDefinition = value;
    },
  };
}

function request(state, body, overrides = {}) {
  return Object.freeze({
    requestId: 'local:019f9000-0000-4000-8000-000000000301',
    projectId: 'default',
    taskId: 'task-console',
    body,
    presence: null,
    authoringLease: null,
    authenticated: state.authenticated,
    signal: new AbortController().signal,
    ...overrides,
  });
}

function readProof(state, response) {
  const value = JSON.parse(
    fs.readFileSync(
      path.join(
        state.deploymentRoot,
        'console-presence',
        response.body.proofFileName,
      ),
      'utf8',
    ),
  );
  return value.proof;
}

test('requires local presence, re-confirms the credential and commits Policy/audit/mutation through a request fence', async (t) => {
  const state = fixture(t);
  const body = taskBody();
  const challenge = await state.route.handle(request(state, body));
  assert.equal(challenge.statusCode, 428);
  assert.equal(challenge.body.code, 'local_presence_required');
  assert.match(challenge.body.requestDigest, /^[a-f0-9]{64}$/);
  assert.match(challenge.body.proofFileName, /^[0-9a-f-]+\.json$/);

  const proof = readProof(state, challenge);
  const created = await state.route.handle(
    request(state, body, { presence: proof }),
  );
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.status, 'created');
  assert.equal(created.body.task.taskId, 'task-console');
  assert.equal(created.body.task.revision, 1);
  assert.equal(state.calls.filter(([kind]) => kind === 'confirm').length, 1);
  assert.equal(
    state.calls.filter(([kind]) => kind === 'credential-fence').length,
    1,
  );
  const mutation = state.calls.find(([kind]) => kind === 'mutation')[1];
  assert.equal(mutation.actor.type, 'user');
  assert.equal(mutation.actor.id, 'owner');
  assert.deepEqual(mutation.fence, {
    projectVersion: 3,
    bindingVersion: 5,
  });
  assert.equal(mutation.audit.outcome, 'allowed');
  assert.equal(
    mutation.audit.authenticationId.startsWith('local_presence:'),
    true,
  );
  assert.deepEqual(
    state.calls
      .filter(([kind]) => kind === 'audit')
      .map(([, audit]) => [audit.operationId, audit.outcome, audit.reasons[0]]),
    [['task.create', 'approval_required', 'local_presence_required']],
  );
});

test('binds the proof to exact Task content and leaves it usable only for the original request', async (t) => {
  const state = fixture(t);
  const body = taskBody();
  const challenge = await state.route.handle(request(state, body));
  const proof = readProof(state, challenge);
  const changed = await state.route.handle(
    request(state, taskBody({ name: 'Changed after challenge' }), {
      presence: proof,
    }),
  );
  assert.deepEqual(changed, {
    statusCode: 401,
    body: { code: 'local_presence_rejected' },
  });
  const created = await state.route.handle(
    request(state, body, { presence: proof }),
  );
  assert.equal(created.statusCode, 201);
  assert.equal(state.calls.filter(([kind]) => kind === 'mutation').length, 1);
});

test('fails closed for malformed bodies, non-User credentials and expired presence proofs', async (t) => {
  const state = fixture(t);
  assert.deepEqual(
    await state.route.handle(request(state, { name: 'partial' })),
    { statusCode: 400, body: { code: 'invalid_task_definition' } },
  );
  const serviceCredential = Object.freeze({
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
    await state.route.handle(
      request(state, taskBody(), { authenticated: serviceCredential }),
    ),
    { statusCode: 401, body: { code: 'strong_authentication_required' } },
  );
  const challenge = await state.route.handle(request(state, taskBody()));
  const proof = readProof(state, challenge);
  state.setNow(challenge.body.expiresAtMs);
  assert.deepEqual(
    await state.route.handle(request(state, taskBody(), { presence: proof })),
    { statusCode: 401, body: { code: 'local_presence_rejected' } },
  );
  assert.equal(state.calls.filter(([kind]) => kind === 'mutation').length, 0);
});

test('requires and consumes one exact authoring lease before an update mutation', async (t) => {
  const current = createTaskDefinitionRecord(
    { projectId: 'default', taskId: 'task-console', ...taskBody() },
    10_000,
  );
  let consumed = false;
  const state = fixture(t, {
    currentDefinition: current,
    taskAuthoringLeases: {
      inspect(value, binding) {
        state.calls.push(['lease-inspect', value, binding]);
        return value === 'ql3a_exact_lease' && !consumed;
      },
      consume(value, binding) {
        state.calls.push(['lease-consume', value, binding]);
        if (value !== 'ql3a_exact_lease' || consumed) return false;
        consumed = true;
        return true;
      },
    },
  });
  const update = taskBody({
    expectedRevision: current.revision,
    mutationId: '019f9000-0000-4000-8000-000000000102',
    name: 'Updated through an authoring lease',
  });
  assert.deepEqual(await state.route.handle(request(state, update)), {
    statusCode: 428,
    body: { code: 'task_authoring_lease_required' },
  });
  const challenge = await state.route.handle(
    request(state, update, { authoringLease: 'ql3a_exact_lease' }),
  );
  assert.equal(challenge.statusCode, 428);
  const updated = await state.route.handle(
    request(state, update, {
      authoringLease: 'ql3a_exact_lease',
      presence: readProof(state, challenge),
    }),
  );
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.status, 'updated');
  assert.equal(
    state.calls.filter(([kind]) => kind === 'lease-inspect').length,
    2,
  );
  assert.equal(
    state.calls.filter(([kind]) => kind === 'lease-consume').length,
    1,
  );
  assert.equal(state.calls.filter(([kind]) => kind === 'mutation').length, 1);
  assert.deepEqual(
    await state.route.handle(
      request(state, update, { authoringLease: 'ql3a_exact_lease' }),
    ),
    { statusCode: 409, body: { code: 'task_authoring_lease_rejected' } },
  );
});

test('rejects a stale authoring lease before issuing a second local proof', async (t) => {
  const current = createTaskDefinitionRecord(
    { projectId: 'default', taskId: 'task-console', ...taskBody() },
    10_000,
  );
  const state = fixture(t, {
    currentDefinition: current,
    taskAuthoringLeases: {
      inspect(_value, binding) {
        return binding.revision === current.revision;
      },
      consume() {
        return true;
      },
    },
  });
  const update = taskBody({
    expectedRevision: current.revision,
    mutationId: '019f9000-0000-4000-8000-000000000103',
  });
  state.setCurrentDefinition(Object.freeze({ ...current, revision: 2 }));
  assert.deepEqual(
    await state.route.handle(
      request(state, update, { authoringLease: 'ql3a_stale_lease' }),
    ),
    { statusCode: 409, body: { code: 'task_authoring_lease_rejected' } },
  );
  assert.deepEqual(
    fs.readdirSync(path.join(state.deploymentRoot, 'console-presence')),
    [],
  );
});
