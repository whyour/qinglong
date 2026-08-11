const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  WorkerCredentialMutationConflictError,
} = require('@qinglong/runtime-core/worker-credential');
const {
  workerCredentialSecretDigest,
} = require('@qinglong/runtime-core/worker-credential-token');
const {
  createWorkerCredentialAdministrationService,
} = require('../dist/worker-credential/workerCredentialAdministration');

const NOW = 1_000;
const PEPPER = Buffer.alloc(32, 1).toString('base64url');
const PRINCIPAL = {
  subject: { type: 'user', id: 'usr_admin' },
  authenticationId: 'session:admin:1',
  authenticatedAtMs: 900,
  expiresAtMs: 2_000,
  assurance: 'multi_factor',
};

function request(overrides = {}) {
  return {
    mutationId: '123e4567-e89b-42d3-a456-426614174501',
    requestId: 'request-worker-issue-1',
    expectedCurrentVersion: 0,
    credentialId: 'worker_primary',
    workerId: 'edge-router-1',
    principal: PRINCIPAL,
    notBeforeAtMs: NOW,
    expiresAtMs: 2_000,
    ...overrides,
  };
}

function repository() {
  let mutation = null;
  const commands = [];
  return {
    commands,
    port: {
      async resolveMutation() { return mutation; },
      async append(command) {
        commands.push(command);
        mutation = {
          credential: command.credential,
          mutation: command.mutation,
          audit: command.audit,
        };
        return {
          status: 'created',
          credential: command.credential,
          mutation: command.mutation,
        };
      },
    },
    setMutation(value) { mutation = value; },
  };
}

test('issues a one-time ql3w token and stores only its Worker-domain digest', async () => {
  const store = repository();
  const generated = Buffer.alloc(32, 7);
  const secret = generated.toString('base64url');
  const service = createWorkerCredentialAdministrationService(
    store.port,
    PEPPER,
    { now: () => NOW, randomBytes: () => generated },
  );
  const result = await service.issue(request());
  assert.equal(result.status, 'created');
  assert.equal(result.token, `ql3w_worker_primary_${secret}`);
  assert.equal(
    store.commands[0].credential.secretDigest,
    workerCredentialSecretDigest(PEPPER, 'worker_primary', secret),
  );
  assert.equal(store.commands[0].credential.workerId, 'edge-router-1');
  assert.equal(store.commands[0].audit.operationId, 'worker_credential.issue');
  assert.equal(generated.every((byte) => byte === 0), true);
});

test('accepts an approved activation time before delayed execution', async () => {
  const store = repository();
  const service = createWorkerCredentialAdministrationService(
    store.port,
    PEPPER,
    { now: () => 1_500, randomBytes: () => Buffer.alloc(32, 7) },
  );
  const result = await service.issue(request());
  assert.equal(result.status, 'created');
  assert.equal(result.credential.createdAtMs, 1_500);
  assert.equal(result.credential.notBeforeAtMs, NOW);
  assert.equal(result.credential.expiresAtMs, 2_000);
});

test('semantic replay returns no secret and conflicting replay fails closed', async () => {
  const store = repository();
  let randomCalls = 0;
  const service = createWorkerCredentialAdministrationService(
    store.port,
    PEPPER,
    {
      now: () => NOW,
      randomBytes() { randomCalls += 1; return Buffer.alloc(32, randomCalls); },
    },
  );
  assert.ok((await service.issue(request())).token);
  const replay = await service.issue(request());
  assert.equal(replay.status, 'existing');
  assert.equal(replay.token, null);
  assert.equal(randomCalls, 1);
  await assert.rejects(
    service.issue(request({ workerId: 'other-worker' })),
    WorkerCredentialMutationConflictError,
  );
});

test('rejects widened requests, weak principals and operation/version confusion', async () => {
  const store = repository();
  const service = createWorkerCredentialAdministrationService(
    store.port,
    PEPPER,
    { now: () => NOW, randomBytes: () => Buffer.alloc(32, 1) },
  );
  await assert.rejects(service.issue(request({ debug: true })), /shape is invalid/);
  await assert.rejects(
    service.issue(request({ principal: { ...PRINCIPAL, assurance: 'single_factor' } })),
    /strong principal/,
  );
  await assert.rejects(
    service.issue(request({ expectedCurrentVersion: 1 })),
    /operation fence is invalid/,
  );
  const { notBeforeAtMs, expiresAtMs, ...revoke } = request({
    mutationId: '123e4567-e89b-42d3-a456-426614174502',
  });
  assert.equal(notBeforeAtMs, NOW);
  assert.equal(expiresAtMs, 2_000);
  await assert.rejects(service.revoke(revoke), /operation fence is invalid/);
  assert.equal(store.commands.length, 0);
});
