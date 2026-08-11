const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  FileLocalCredentialAdministrationDelivery,
  LocalCredentialAdministrationDeliveryError,
} = require('@qinglong/local-owner-console/credential-administration-delivery');

const MUTATION_ID = '81000000-0000-4000-8000-000000000001';
const RECOVERY_MUTATION_ID = '81000000-0000-4000-8000-000000000002';
const SECRET = Buffer.alloc(32, 81).toString('base64url');

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'ql3-managed-credential-'),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'qinglong3-local-managed-credential-delivery',
    mutationId: MUTATION_ID,
    requestId: 'managed-credential-issue',
    projectId: 'default',
    subject: { type: 'agent', id: 'agent-planner' },
    credentialId: 'agent-planner-primary',
    secret: SECRET,
    notBeforeAtMs: 1_000,
    expiresAtMs: 61_000,
    ...overrides,
  };
}

test('stages, replays, publishes and acknowledges one private credential', (t) => {
  const directory = fixture(t);
  const delivery = new FileLocalCredentialAdministrationDelivery(directory);
  const first = delivery.prepare(record());
  const digest = delivery.digest(first);

  const replay = delivery.prepare(
    record({
      secret: Buffer.alloc(32, 82).toString('base64url'),
      notBeforeAtMs: 11_000,
      expiresAtMs: 71_000,
    }),
  );
  assert.equal(replay.secret, SECRET);
  assert.equal(replay.notBeforeAtMs, 1_000);
  assert.equal(delivery.digest(replay), digest);

  const published = delivery.publish(replay, digest);
  assert.equal(
    path.basename(published.path),
    `managed-credential-${MUTATION_ID}.ready.json`,
  );
  assert.equal(fs.statSync(published.path).mode & 0o777, 0o600);
  assert.equal(delivery.inspect(MUTATION_ID).deliveryDigest, digest);
  const presentation = JSON.parse(fs.readFileSync(published.path, 'utf8'));
  assert.equal(
    presentation.kind,
    'qinglong3-local-identity-credential-presentation',
  );
  assert.match(presentation.token, /^ql3c_agent-planner-primary_/);

  assert.equal(delivery.removeAcknowledged(MUTATION_ID, digest), 'removed');
  assert.equal(delivery.removeAcknowledged(MUTATION_ID, digest), 'absent');

  const recovery = delivery.prepare(
    record({
      mutationId: RECOVERY_MUTATION_ID,
      requestId: 'managed-credential-cleanup-recovery',
    }),
  );
  const recoveryDigest = delivery.digest(recovery);
  const recoveryReady = delivery.publish(recovery, recoveryDigest);
  fs.unlinkSync(recoveryReady.path);
  assert.equal(
    delivery.removeAcknowledged(RECOVERY_MUTATION_ID, recoveryDigest),
    'removed',
  );
});

test('rejects semantic replay drift and a symlinked delivery directory', (t) => {
  const directory = fixture(t);
  const delivery = new FileLocalCredentialAdministrationDelivery(directory);
  delivery.prepare(record());
  assert.throws(
    () => delivery.prepare(record({ expiresAtMs: 62_000 })),
    LocalCredentialAdministrationDeliveryError,
  );

  const link = `${directory}-link`;
  fs.symlinkSync(directory, link);
  t.after(() => fs.rmSync(link, { force: true }));
  assert.throws(
    () => new FileLocalCredentialAdministrationDelivery(link),
    LocalCredentialAdministrationDeliveryError,
  );
});
