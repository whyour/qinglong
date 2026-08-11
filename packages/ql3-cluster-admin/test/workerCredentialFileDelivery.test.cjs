const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  WorkerCredentialDeliveryConflictError,
  WorkerCredentialDeliveryUnavailableError,
  workerCredentialDeliveryTokenDigest,
} = require('@qinglong/runtime-core/worker-credential-delivery');
const {
  formatWorkerCredentialToken,
} = require('@qinglong/runtime-core/worker-credential-token');
const {
  MAX_WORKER_CREDENTIAL_FILE_STAGES,
  WorkerCredentialFileDeliveryAdapter,
} = require('@qinglong/cluster-admin/worker-credential-file-delivery');
const {
  createRecoverableWorkerCredentialIssuer,
} = require('../dist/worker-credential/workerCredentialDelivery');

const DELIVERY_ID = '123e4567-e89b-42d3-a456-426614174901';
const CREDENTIAL_ID = 'worker_generation_2';
const PREVIOUS_CREDENTIAL_ID = 'worker_generation_1';
const PEPPER = Buffer.alloc(32, 7).toString('base64url');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-worker-delivery-'));
  const stages = path.join(root, 'stages');
  const target = path.join(root, 'target');
  fs.mkdirSync(stages, { mode: 0o700 });
  fs.mkdirSync(target, { mode: 0o700 });
  const targetTokenFile = path.join(target, 'credential.token');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const adapter = new WorkerCredentialFileDeliveryAdapter({
    stageDirectory: stages,
    targetTokenFile,
  });
  return { root, stages, target, targetTokenFile, adapter };
}

function token(credentialId, fill) {
  return Buffer.from(formatWorkerCredentialToken(
    credentialId,
    Buffer.alloc(32, fill).toString('base64url'),
  ));
}

function intent(adapter, value, overrides = {}) {
  return {
    deliveryId: DELIVERY_ID,
    workerId: 'edge-router-1',
    credentialId: CREDENTIAL_ID,
    credentialVersion: 1,
    previousCredentialId: PREVIOUS_CREDENTIAL_ID,
    secretDigest: 'a'.repeat(64),
    tokenDigest: workerCredentialDeliveryTokenDigest(value),
    deploymentTargetDigest: adapter.deploymentTargetDigest,
    deploymentGeneration: 'secret-generation-2',
    stagedAtMs: 1_000,
    ...overrides,
  };
}

function committed(candidate, overrides = {}) {
  return {
    ...candidate,
    version: 1,
    state: 'credential_committed',
    credentialCommittedAtMs: 1_000,
    publishedAtMs: null,
    publicationDigest: null,
    observedAtMs: null,
    observedSessionId: null,
    observedSessionVersion: null,
    previousRevokedAtMs: null,
    ...overrides,
  };
}

function deliveryAuthority() {
  let resolved = null;
  return {
    port: {
      async resolveMutation() { return resolved; },
      async append() { throw new Error('raw append is forbidden'); },
      async resolveDelivery() { return resolved?.delivery ?? null; },
      async resolveDelivered() { return resolved; },
      async commitDelivered(command) {
        resolved = {
          credential: command.credential.credential,
          mutation: command.credential.mutation,
          audit: command.credential.audit,
          delivery: command.delivery,
        };
        return {
          status: 'created',
          credential: resolved.credential,
          mutation: resolved.mutation,
        };
      },
      async markPublished(command) {
        resolved = {
          ...resolved,
          delivery: {
            ...resolved.delivery,
            version: 2,
            state: 'published',
            publishedAtMs: command.publishedAtMs,
            publicationDigest: command.publicationDigest,
          },
        };
        return resolved.delivery;
      },
      async listRecoveryPage() { throw new Error('not used'); },
      async revokePreviousDelivered() { throw new Error('not used'); },
      async authorizeStageDiscard() { throw new Error('not used'); },
      async markStageDiscarded() { throw new Error('not used'); },
      async listStageDiscardRecoveryPage() { throw new Error('not used'); },
    },
    current: () => resolved,
  };
}

test('stages one private no-replace secret and inspects only its intent', async (t) => {
  const { adapter, stages } = fixture(t);
  const material = token(CREDENTIAL_ID, 2);
  const candidate = intent(adapter, material);
  await adapter.stage(candidate, material);
  material.fill(0);
  assert.deepEqual(await adapter.inspect(DELIVERY_ID), candidate);
  const stagePath = path.join(stages, `${DELIVERY_ID}.stage`);
  assert.equal(fs.statSync(stagePath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(stages), [`${DELIVERY_ID}.stage`]);

  const replay = token(CREDENTIAL_ID, 2);
  await adapter.stage(candidate, replay);
  await assert.rejects(
    adapter.stage({ ...candidate, deploymentGeneration: 'other-generation' }, replay),
    WorkerCredentialDeliveryConflictError,
  );
  replay.fill(0);
  assert.equal((await adapter.inspect(DELIVERY_ID)).deploymentGeneration,
    'secret-generation-2');
});

test('atomically replaces only the expected previous credential and replays publication', async (t) => {
  const { adapter, targetTokenFile, stages, target } = fixture(t);
  const previous = token(PREVIOUS_CREDENTIAL_ID, 1);
  fs.writeFileSync(targetTokenFile, previous, { mode: 0o600 });
  previous.fill(0);
  const material = token(CREDENTIAL_ID, 2);
  const candidate = intent(adapter, material);
  await adapter.stage(candidate, material);
  const publication = await adapter.publish(committed(candidate));
  assert.match(publication.publicationDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(fs.readFileSync(targetTokenFile), material);
  assert.equal(fs.statSync(targetTokenFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(target), ['credential.token']);
  assert.deepEqual(fs.readdirSync(stages), [`${DELIVERY_ID}.stage`]);

  const restarted = new WorkerCredentialFileDeliveryAdapter({
    stageDirectory: stages,
    targetTokenFile,
  });
  assert.deepEqual(
    await restarted.publish(committed(candidate)),
    publication,
  );
  material.fill(0);
});

test('completes stage-before-commit issuance through the concrete file adapter', async (t) => {
  const { adapter, targetTokenFile } = fixture(t);
  const authority = deliveryAuthority();
  const generated = Buffer.alloc(32, 9);
  const service = createRecoverableWorkerCredentialIssuer(
    authority.port,
    adapter,
    PEPPER,
    { now: () => 1_000, randomBytes: () => generated },
  );
  const result = await service.issue({
    mutationId: DELIVERY_ID,
    requestId: 'request-file-delivery-1',
    expectedCurrentVersion: 0,
    credentialId: CREDENTIAL_ID,
    workerId: 'edge-router-1',
    principal: {
      subject: { type: 'user', id: 'usr_admin' },
      authenticationId: 'session:admin:1',
      authenticatedAtMs: 900,
      expiresAtMs: 2_000,
      assurance: 'multi_factor',
    },
    notBeforeAtMs: 1_000,
    expiresAtMs: 2_000,
    previousCredentialId: null,
    deploymentTargetDigest: adapter.deploymentTargetDigest,
    deploymentGeneration: 'secret-generation-2',
  });
  assert.equal(result.status, 'published');
  assert.equal(result.delivery.state, 'published');
  assert.match(fs.readFileSync(targetTokenFile, 'ascii'),
    /^ql3w_worker_generation_2_[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(authority.current()).includes('ql3w_'), false);
  assert.equal(generated.every((byte) => byte === 0), true);
});

test('fails closed instead of overwriting an unexpected target generation', async (t) => {
  const { adapter, targetTokenFile } = fixture(t);
  const unexpected = token('worker_generation_other', 3);
  fs.writeFileSync(targetTokenFile, unexpected, { mode: 0o600 });
  const material = token(CREDENTIAL_ID, 2);
  const candidate = intent(adapter, material);
  await adapter.stage(candidate, material);
  await assert.rejects(
    adapter.publish(committed(candidate)),
    WorkerCredentialDeliveryConflictError,
  );
  assert.deepEqual(fs.readFileSync(targetTokenFile), unexpected);
  unexpected.fill(0);
  material.fill(0);
});

test('discards only an unpublished exact orphan stage', async (t) => {
  const { adapter, targetTokenFile } = fixture(t);
  const material = token(CREDENTIAL_ID, 2);
  const candidate = intent(adapter, material);
  await adapter.stage(candidate, material);
  await adapter.discard(candidate);
  assert.equal(await adapter.inspect(DELIVERY_ID), null);
  await adapter.discard(candidate);

  await adapter.stage(candidate, material);
  fs.writeFileSync(targetTokenFile, material, { mode: 0o600 });
  await assert.rejects(
    adapter.discard(candidate),
    WorkerCredentialDeliveryConflictError,
  );
  assert.deepEqual(await adapter.inspect(DELIVERY_ID), candidate);
  material.fill(0);
});

test('uses a durable target lock and leaves the old token untouched on contention', async (t) => {
  const { adapter, target, targetTokenFile } = fixture(t);
  const previous = token(PREVIOUS_CREDENTIAL_ID, 1);
  fs.writeFileSync(targetTokenFile, previous, { mode: 0o600 });
  fs.writeFileSync(
    path.join(target, '.ql3-worker-credential-delivery.lock'),
    `${JSON.stringify({ deliveryId: randomUUID() })}\n`,
    { mode: 0o600 },
  );
  const material = token(CREDENTIAL_ID, 2);
  const candidate = intent(adapter, material);
  await adapter.stage(candidate, material);
  await assert.rejects(
    adapter.publish(committed(candidate)),
    WorkerCredentialDeliveryUnavailableError,
  );
  assert.deepEqual(fs.readFileSync(targetTokenFile), previous);
  previous.fill(0);
  material.fill(0);
});

test('lists only bounded ordered low-sensitive stage intents', async (t) => {
  const { adapter, stages } = fixture(t);
  const firstToken = token(CREDENTIAL_ID, 2);
  const secondToken = token(CREDENTIAL_ID, 3);
  const first = intent(adapter, firstToken);
  const second = intent(adapter, secondToken, {
    deliveryId: '123e4567-e89b-42d3-a456-426614174902',
    tokenDigest: workerCredentialDeliveryTokenDigest(secondToken),
    deploymentGeneration: 'secret-generation-3',
  });
  await adapter.stage(second, secondToken);
  await adapter.stage(first, firstToken);
  assert.deepEqual(await adapter.listStaged({ limit: 1 }), {
    stages: [first],
    truncated: true,
    nextCursor: first.deliveryId,
  });
  assert.deepEqual(await adapter.listStaged({
    afterDeliveryId: first.deliveryId,
    limit: 1,
  }), {
    stages: [second],
    truncated: false,
  });
  fs.writeFileSync(
    path.join(stages, `.${DELIVERY_ID}.${randomUUID()}.tmp`),
    'uncertain',
    { mode: 0o600 },
  );
  await assert.rejects(
    adapter.listStaged(),
    WorkerCredentialDeliveryUnavailableError,
  );
  firstToken.fill(0);
  secondToken.fill(0);
});

test('enforces stage capacity, dedicated roots and live POSIX permissions', async (t) => {
  const { adapter, stages, target, targetTokenFile } = fixture(t);
  const material = token(CREDENTIAL_ID, 2);
  const candidate = intent(adapter, material);
  for (let index = 0; index < MAX_WORKER_CREDENTIAL_FILE_STAGES; index += 1) {
    fs.writeFileSync(
      path.join(stages, `${randomUUID()}.stage`),
      'bounded',
      { mode: 0o600 },
    );
  }
  await assert.rejects(
    adapter.stage(candidate, material),
    WorkerCredentialDeliveryUnavailableError,
  );
  fs.rmSync(stages, { recursive: true });
  fs.mkdirSync(stages, { mode: 0o700 });
  const changed = new WorkerCredentialFileDeliveryAdapter({
    stageDirectory: stages,
    targetTokenFile,
  });
  const changedCandidate = intent(changed, material);
  await changed.stage(changedCandidate, material);
  fs.chmodSync(target, 0o755);
  await assert.rejects(
    changed.publish(committed(changedCandidate)),
    WorkerCredentialDeliveryUnavailableError,
  );
  fs.chmodSync(target, 0o700);
  assert.throws(() => new WorkerCredentialFileDeliveryAdapter({
    stageDirectory: target,
    targetTokenFile,
  }));
  material.fill(0);
});
