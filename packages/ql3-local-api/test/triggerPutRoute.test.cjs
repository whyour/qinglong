const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { createTriggerRecord } = require('@qinglong/runtime-core/trigger');
const {
  createLocalPresenceProofManager,
} = require('../dist/authentication/localPresenceProof.js');
const {
  createLocalApiTriggerPutRoute,
} = require('../dist/trigger/triggerPutRoute.js');

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

function triggerBody(overrides = {}) {
  return Object.freeze({
    expectedRevision: null,
    mutationId: '019f9100-0000-4000-8000-000000000101',
    taskId: 'task-a',
    taskRevision: 2,
    taskContentDigest: 'c'.repeat(64),
    spec: Object.freeze({
      schema: 'qinglong/cron@v1',
      config: Object.freeze({
        expression: '0 * * * *',
        timezone: 'UTC',
        misfirePolicy: 'skip',
      }),
    }),
    enabled: true,
    occurredAtMs: 10_000,
    ...overrides,
  });
}

function uuidFactory() {
  let sequence = 200;
  return () => {
    sequence += 1;
    return `019f9100-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  };
}

function fixture(t) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-trigger-put-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const calls = [];
  const presenceProof = createLocalPresenceProofManager({
    deploymentRoot,
    profile: 'edge',
    now: () => 10_000,
    randomUuid: uuidFactory(),
    randomSecret: () => Buffer.alloc(32, 14),
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
  const triggers = {
    async findCurrentTrigger() {
      return null;
    },
    async findTriggerRevision() {
      return null;
    },
    async listTriggers() {
      return { triggers: [], truncated: false };
    },
  };
  const route = createLocalApiTriggerPutRoute({
    projectPolicy,
    triggers,
    async triggerAdministrationForCredential(fence) {
      calls.push(['credential-fence', fence]);
      return {
        async appendAuthorizedTriggerRevision(mutation) {
          calls.push(['mutation', mutation]);
          return {
            status: 'created',
            trigger: createTriggerRecord(mutation.command, 10_000),
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
    now: () => 10_000,
    randomUuid: uuidFactory(),
  });
  const authenticated = Object.freeze({
    principal: PRINCIPAL,
    credentialFence: FENCE,
    async confirm() {
      calls.push(['confirm']);
    },
  });
  return { route, calls, deploymentRoot, authenticated };
}

function request(state, body, overrides = {}) {
  return Object.freeze({
    requestId: 'local:019f9100-0000-4000-8000-000000000301',
    projectId: 'default',
    triggerId: 'cron:task-a',
    body,
    presence: null,
    authenticated: state.authenticated,
    signal: new AbortController().signal,
    ...overrides,
  });
}

function readProof(state, challenge) {
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

test('requires exact local presence and commits Trigger audit plus mutation through one credential fence', async (t) => {
  const state = fixture(t);
  const body = triggerBody();
  const challenge = await state.route.handle(request(state, body));
  assert.equal(challenge.statusCode, 428);
  assert.equal(challenge.body.code, 'local_presence_required');
  const created = await state.route.handle(
    request(state, body, { presence: readProof(state, challenge) }),
  );
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.status, 'created');
  assert.equal(created.body.trigger.triggerId, 'cron:task-a');
  const mutation = state.calls.find(([kind]) => kind === 'mutation')[1];
  assert.deepEqual(mutation.actor, { type: 'user', id: 'owner' });
  assert.deepEqual(mutation.fence, {
    projectVersion: 3,
    bindingVersion: 5,
  });
  assert.equal(mutation.audit.operationId, 'trigger.create');
  assert.equal(mutation.audit.outcome, 'allowed');
  assert.equal(
    mutation.audit.authenticationId.startsWith('local_presence:'),
    true,
  );
  assert.deepEqual(
    state.calls
      .filter(([kind]) => kind === 'audit')
      .map(([, audit]) => [audit.operationId, audit.outcome, audit.reasons[0]]),
    [['trigger.create', 'approval_required', 'local_presence_required']],
  );
});

test('binds the proof to exact Trigger content and rejects malformed requests', async (t) => {
  const state = fixture(t);
  assert.deepEqual(
    await state.route.handle(request(state, { enabled: true })),
    { statusCode: 400, body: { code: 'invalid_trigger' } },
  );
  const body = triggerBody();
  const challenge = await state.route.handle(request(state, body));
  const proof = readProof(state, challenge);
  assert.deepEqual(
    await state.route.handle(
      request(state, triggerBody({ enabled: false }), { presence: proof }),
    ),
    { statusCode: 401, body: { code: 'local_presence_rejected' } },
  );
  assert.equal(state.calls.filter(([kind]) => kind === 'mutation').length, 0);
});
