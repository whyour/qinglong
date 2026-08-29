const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  createLocalPresenceProofManager,
} = require('../dist/authentication/localPresenceProof.js');
const {
  createLocalApiSecretListRoute,
  createLocalApiSecretPutRoute,
} = require('../dist/secret/secretRoutes.js');

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

function uuidFactory() {
  let sequence = 400;
  return () => {
    sequence += 1;
    return `019f9200-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  };
}

function body(overrides = {}) {
  return Object.freeze({
    name: 'github-token',
    plaintext: 'never-return-this-value',
    mutationId: '019f9200-0000-4000-8000-000000000101',
    expectedCurrentVersion: 0,
    ...overrides,
  });
}

function fixture(t) {
  const deploymentRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-secret-put-'),
  );
  fs.chmodSync(deploymentRoot, 0o700);
  t.after(() => fs.rmSync(deploymentRoot, { recursive: true, force: true }));
  const calls = [];
  const presenceProof = createLocalPresenceProofManager({
    deploymentRoot,
    profile: 'edge',
    now: () => 10_000,
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
  const route = createLocalApiSecretPutRoute({
    projectPolicy,
    async secretAdministrationForCredential(fence) {
      calls.push(['credential-fence', fence]);
      return {
        async resolveLocalSecretAdministrationMutation() {
          return null;
        },
        async appendAuthorizedLocalSecretEnvelope(command) {
          calls.push(['mutation', command]);
          return {
            status: 'inserted',
            envelope: command.envelope,
            audit: command.audit,
          };
        },
        async record() {
          throw new Error('not used');
        },
      };
    },
    securityAudit: {
      async record(record) {
        calls.push(['audit', record]);
      },
    },
    secretKeys: {
      async active() {
        calls.push(['active-key']);
        return { keyId: 'active-key', key: Buffer.alloc(32, 23) };
      },
      async resolve() {
        return null;
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

function request(state, requestBody, overrides = {}) {
  return Object.freeze({
    requestId: 'local:019f9200-0000-4000-8000-000000000301',
    projectId: 'default',
    body: requestBody,
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

test('lists bounded Secret metadata without storage or mutation material', async () => {
  const route = createLocalApiSecretListRoute({
    async listLocalSecretMetadata(options) {
      assert.deepEqual(options, { projectId: 'default', limit: 1 });
      return {
        secrets: [
          {
            projectId: 'default',
            name: 'github-token',
            currentVersion: 2,
            createdAtMs: 10_000,
          },
        ],
        truncated: true,
        next: { name: 'github-token' },
      };
    },
  });
  const result = await route.handle({ projectId: 'default', limit: 1 });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(result.body.secrets[0]).sort(), [
    'createdAtMs',
    'currentVersion',
    'name',
    'secretRef',
  ]);
  assert.equal(
    result.body.secrets[0].secretRef.startsWith('qlsecret:v1:'),
    true,
  );
  assert.equal(result.body.next.after, 'Z2l0aHViLXRva2Vu');
  assert.doesNotMatch(
    JSON.stringify(result.body),
    /cipher|plaintext|mutation|keyId/u,
  );
});

test('fails closed on widened, cross-Project and over-budget metadata', async () => {
  for (const page of [
    {
      secrets: [
        {
          projectId: 'other',
          name: 'github-token',
          currentVersion: 2,
          createdAtMs: 10_000,
        },
      ],
      truncated: false,
    },
    {
      secrets: [
        {
          projectId: 'default',
          name: 'github-token',
          currentVersion: 2,
          createdAtMs: 10_000,
          ciphertext: 'forbidden',
        },
      ],
      truncated: false,
    },
    {
      secrets: [
        {
          projectId: 'default',
          name: 'first',
          currentVersion: 1,
          createdAtMs: 10_000,
        },
        {
          projectId: 'default',
          name: 'second',
          currentVersion: 1,
          createdAtMs: 10_001,
        },
      ],
      truncated: true,
      next: { name: 'second' },
    },
  ]) {
    const route = createLocalApiSecretListRoute({
      async listLocalSecretMetadata() {
        return page;
      },
    });
    assert.deepEqual(await route.handle({ projectId: 'default', limit: 1 }), {
      statusCode: 503,
      body: { code: 'secret_query_unavailable' },
    });
  }
});

test('requires exact local presence and returns no Secret plaintext', async (t) => {
  const state = fixture(t);
  const command = body();
  const challenge = await state.route.handle(request(state, command));
  assert.equal(challenge.statusCode, 428);
  const result = await state.route.handle(
    request(state, command, { presence: readProof(state, challenge) }),
  );
  assert.equal(result.statusCode, 201);
  assert.deepEqual(result.body, {
    status: 'inserted',
    secret: {
      name: 'github-token',
      currentVersion: 1,
      secretRef: result.body.secret.secretRef,
    },
  });
  assert.equal(JSON.stringify(result).includes(command.plaintext), false);
  const mutation = state.calls.find(([kind]) => kind === 'mutation')[1];
  assert.equal(
    Buffer.from(mutation.envelope.ciphertext, 'base64url').includes(
      Buffer.from(command.plaintext),
    ),
    false,
  );
  assert.deepEqual(
    state.calls
      .filter(([kind]) => kind === 'audit')
      .map(([, audit]) => [audit.operationId, audit.outcome, audit.reasons[0]]),
    [['secret.create', 'approval_required', 'local_presence_required']],
  );
});

test('binds proof to exact plaintext digest and rejects widened bodies', async (t) => {
  const state = fixture(t);
  assert.deepEqual(
    await state.route.handle(request(state, { ...body(), extra: true })),
    { statusCode: 400, body: { code: 'invalid_secret' } },
  );
  const command = body();
  const challenge = await state.route.handle(request(state, command));
  const proof = readProof(state, challenge);
  assert.deepEqual(
    await state.route.handle(
      request(state, body({ plaintext: 'changed-value' }), { presence: proof }),
    ),
    { statusCode: 401, body: { code: 'local_presence_rejected' } },
  );
  assert.equal(state.calls.filter(([kind]) => kind === 'mutation').length, 0);
});
