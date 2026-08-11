const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  InvalidLocalOwnerBootstrapValueError,
  localOwnerBootstrapDigestMatches,
  localOwnerBootstrapTokenDigest,
  normalizeClaimLocalOwnerCommand,
  normalizeLocalOwnerSecretDeliveryAcknowledgementRecord,
} = require('../dist/local-owner/localOwnerBootstrap');

const NOW = 1_760_000_000_000;
const TOKEN = Buffer.alloc(32, 7).toString('base64url');
const CHALLENGE_ID = Buffer.alloc(16, 8).toString('base64url');

function claim(overrides = {}) {
  const principal = {
    subject: { type: 'user', id: 'user-1' },
    authenticationId: 'local_credential:owner:1',
    authenticatedAtMs: NOW,
    expiresAtMs: NOW + 60_000,
    assurance: 'single_factor',
  };
  return {
    projectId: 'default',
    mutationId: '00000000-0000-4000-8000-000000000201',
    requestId: 'claim-201',
    challengeId: CHALLENGE_ID,
    tokenDigest: localOwnerBootstrapTokenDigest('default', CHALLENGE_ID, TOKEN),
    principal,
    credentialId: 'owner',
    credentialVersion: 1,
    claimedAtMs: NOW,
    audit: {
      eventId: '00000000-0000-4000-8000-000000000201',
      requestId: 'claim-201',
      operationId: 'project.owner_bootstrap_claim',
      projectId: 'default',
      subject: principal.subject,
      authenticationId: principal.authenticationId,
      outcome: 'allowed',
      reasons: ['owner_bootstrap_claim'],
      fence: { projectVersion: 1, bindingVersion: 1 },
      occurredAtMs: NOW,
    },
    ...overrides,
  };
}

test('challenge digest is domain-bound and timing-safe comparable', () => {
  const digest = localOwnerBootstrapTokenDigest('default', CHALLENGE_ID, TOKEN);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(localOwnerBootstrapDigestMatches(digest, digest), true);
  assert.notEqual(
    digest,
    localOwnerBootstrapTokenDigest('other', CHALLENGE_ID, TOKEN),
  );
});

test('claim only accepts single-factor authenticated User credentials', () => {
  assert.equal(
    normalizeClaimLocalOwnerCommand(claim()).principal.assurance,
    'single_factor',
  );
  const invalid = claim();
  assert.throws(
    () =>
      normalizeClaimLocalOwnerCommand({
        ...invalid,
        principal: { ...invalid.principal, assurance: 'local_console' },
      }),
    InvalidLocalOwnerBootstrapValueError,
  );
});

test('claim rejects widened transport-controlled identity shape', () => {
  assert.throws(
    () => normalizeClaimLocalOwnerCommand({ ...claim(), userId: 'forged' }),
    InvalidLocalOwnerBootstrapValueError,
  );
});

test('normalizes exact secret-free delivery acknowledgement records', () => {
  const credential = normalizeLocalOwnerSecretDeliveryAcknowledgementRecord({
    kind: 'credential',
    mutationId: '00000000-0000-4000-8000-000000000202',
    requestId: 'provision-202',
    subjectId: `usr_${Buffer.alloc(16, 9).toString('base64url')}`,
    credentialId: `own_${Buffer.alloc(16, 10).toString('base64url')}`,
    factDigest: 'a'.repeat(64),
    ttlMs: 86_400_000,
    deliveryDigest: 'b'.repeat(64),
    acknowledgedAtMs: NOW,
  });
  assert.equal(credential.kind, 'credential');
  assert.equal('secret' in credential, false);

  const challenge = normalizeLocalOwnerSecretDeliveryAcknowledgementRecord({
    kind: 'challenge',
    projectId: 'default',
    mutationId: '00000000-0000-4000-8000-000000000203',
    requestId: 'issue-203',
    challengeId: CHALLENGE_ID,
    factDigest: 'c'.repeat(64),
    ttlMs: 600_000,
    deliveryDigest: 'd'.repeat(64),
    acknowledgedAtMs: NOW,
  });
  assert.equal(challenge.kind, 'challenge');
});

test('rejects widened or malformed delivery acknowledgements', () => {
  assert.throws(
    () =>
      normalizeLocalOwnerSecretDeliveryAcknowledgementRecord({
        kind: 'challenge',
        projectId: 'default',
        mutationId: '00000000-0000-4000-8000-000000000204',
        requestId: 'issue-204',
        challengeId: CHALLENGE_ID,
        factDigest: 'c'.repeat(64),
        ttlMs: 600_000,
        deliveryDigest: 'd'.repeat(64),
        acknowledgedAtMs: NOW,
        secret: TOKEN,
      }),
    InvalidLocalOwnerBootstrapValueError,
  );
});
