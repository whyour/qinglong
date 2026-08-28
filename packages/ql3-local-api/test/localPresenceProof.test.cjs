const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  LocalPresenceProofUnavailableError,
  createLocalPresenceProofManager,
} = require('../dist/authentication/localPresenceProof.js');

function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-presence-'));
  fs.chmodSync(value, 0o700);
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function binding(overrides = {}) {
  return Object.freeze({
    requestDigest: 'a'.repeat(64),
    credentialId: 'owner-console',
    credentialVersion: 1,
    subjectType: 'user',
    subjectId: 'owner',
    ...overrides,
  });
}

function uuidFactory() {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `019f9000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  };
}

test('publishes a private request-bound proof and consumes it exactly once', (t) => {
  const deploymentRoot = root(t);
  const manager = createLocalPresenceProofManager({
    deploymentRoot,
    profile: 'edge',
    now: () => 1_000,
    randomUuid: uuidFactory(),
    randomSecret: () => Buffer.alloc(32, 7),
  });
  t.after(() => manager.close());

  const challenge = manager.issue(binding());
  const directory = path.join(deploymentRoot, 'console-presence');
  const filePath = path.join(directory, challenge.proofFileName);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload.authorizationId, challenge.authorizationId);
  assert.equal(payload.requestDigest, challenge.requestDigest);
  assert.match(payload.proof, /^ql3p_/);
  assert.equal(JSON.stringify(payload).includes('owner-console'), false);
  assert.equal(JSON.stringify(payload).includes('owner'), false);

  const consumed = manager.consume(payload.proof, binding());
  assert.deepEqual(consumed, {
    authorizationId: challenge.authorizationId,
    authenticatedAtMs: 1_000,
    expiresAtMs: 121_000,
  });
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(manager.consume(payload.proof, binding()), null);
});

test('rejects wrong request, credential and proof without consuming the valid authorization', (t) => {
  const deploymentRoot = root(t);
  const manager = createLocalPresenceProofManager({
    deploymentRoot,
    profile: 'standalone',
    now: () => 2_000,
    randomUuid: uuidFactory(),
    randomSecret: () => Buffer.alloc(32, 9),
  });
  t.after(() => manager.close());
  const challenge = manager.issue(binding());
  const filePath = path.join(
    deploymentRoot,
    'console-presence',
    challenge.proofFileName,
  );
  const proof = JSON.parse(fs.readFileSync(filePath, 'utf8')).proof;
  assert.equal(
    manager.consume(proof, binding({ requestDigest: 'b'.repeat(64) })),
    null,
  );
  assert.equal(manager.consume(proof, binding({ credentialVersion: 2 })), null);
  assert.equal(manager.consume(`${proof.slice(0, -1)}A`, binding()), null);
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(
    manager.consume(proof, binding()).authorizationId,
    challenge.authorizationId,
  );
});

test('bounds pending Edge authorizations and lazily removes expired proof files', (t) => {
  const deploymentRoot = root(t);
  let now = 3_000;
  const manager = createLocalPresenceProofManager({
    deploymentRoot,
    profile: 'edge',
    now: () => now,
    randomUuid: uuidFactory(),
    randomSecret: () => Buffer.alloc(32, 11),
  });
  t.after(() => manager.close());
  for (let index = 0; index < 8; index += 1) {
    manager.issue(
      binding({ requestDigest: index.toString(16).padStart(64, '0') }),
    );
  }
  assert.throws(
    () => manager.issue(binding({ requestDigest: 'f'.repeat(64) })),
    LocalPresenceProofUnavailableError,
  );
  assert.equal(
    fs.readdirSync(path.join(deploymentRoot, 'console-presence')).length,
    8,
  );
  now += 120_000;
  manager.issue(binding({ requestDigest: 'f'.repeat(64) }));
  assert.equal(
    fs.readdirSync(path.join(deploymentRoot, 'console-presence')).length,
    1,
  );
  manager.close();
  assert.equal(
    fs.readdirSync(path.join(deploymentRoot, 'console-presence')).length,
    0,
  );
});
