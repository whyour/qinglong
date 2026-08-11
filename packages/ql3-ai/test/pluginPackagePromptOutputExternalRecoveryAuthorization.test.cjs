const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { test } = require('node:test');

const {
  PluginPackagePromptOutputRecoveryAuthorizationUntrustedError,
  createPluginPackagePromptOutputExternalRecoveryAuthorization,
  normalizePluginPackagePromptOutputExternalRecoveryAuthorization,
  verifyAuthorizedPluginPackagePromptOutputRecoveredMaterial,
  verifyPluginPackagePromptOutputExternalRecoveryAuthorization,
} = require('../dist/prompt-output/custody/pluginPackagePromptOutputExternalRecoveryAuthorization.js');
const {
  createPluginPackagePromptOutputExternalCustodyReceipt,
} = require('../dist/prompt-output/custody/pluginPackagePromptOutputExternalCustody.js');
const {
  createPluginPackagePromptOutputArtifact,
} = require('../dist/prompt-output/pluginPackagePromptOutputArtifact.js');
const {
  pluginPackagePromptOutputKeyRotationMaterialProof,
} = require('../dist/prompt-output/key-management/pluginPackagePromptOutputKeyRotation.js');

const NOW = 1_700_000_000_000;
const MATERIAL = Buffer.alloc(32, 0x4a);
const WRAPPED = Buffer.from('external-kms-wrapped-material');
const CATALOG_DIGEST = '1'.repeat(64);
const POLICY_DIGEST = '2'.repeat(64);
const WRAPPING_KEY_REF_DIGEST = '3'.repeat(64);
const custodyKeys = generateKeyPairSync('ed25519');
const approverAKeys = generateKeyPairSync('ed25519');
const approverBKeys = generateKeyPairSync('ed25519');

function artifact() {
  return createPluginPackagePromptOutputArtifact(
    {
      projectId: 'project-recovery',
      runId: 'run-recovery',
      stepRunId: 'step-recovery',
      invocationId: 'invocation-recovery',
      requestedBy: { type: 'user', id: 'requester-user' },
      result: {
        provider: 'openai-compatible',
        model: 'bounded-model',
        text: 'historical private answer',
        finishReason: 'stop',
        usage: {
          inputTokens: 5,
          outputTokens: 4,
          totalTokens: 9,
          costMicros: 12,
        },
      },
      retentionPolicy: {
        revision: 'recovery-retention-v1',
        retentionMs: 86_400_000,
      },
      keyId: 'prompt-key-recovery',
      key: Buffer.from(MATERIAL),
      sealedAtMs: NOW - 60_000,
    },
    () => Buffer.alloc(12, 0x31),
  );
}

function receipt() {
  return createPluginPackagePromptOutputExternalCustodyReceipt(
    {
      custodyId: 'custody-recovery',
      keyId: 'prompt-key-recovery',
      materialProof: pluginPackagePromptOutputKeyRotationMaterialProof(
        'prompt-key-recovery',
        MATERIAL,
      ),
      sourceGeneration: 7,
      sourceCatalogDigest: CATALOG_DIGEST,
      wrappingProvider: 'external-kms',
      wrappingKeyRefDigest: WRAPPING_KEY_REF_DIGEST,
      wrappedMaterialDigest: createHash('sha256').update(WRAPPED).digest('hex'),
      wrappedMaterialBytes: WRAPPED.length,
      createdAtMs: NOW - 120_000,
    },
    {
      publicKey: custodyKeys.publicKey,
      sign: (message) => sign(null, message, custodyKeys.privateKey),
    },
  );
}

function signer(userId, authenticationId, keys, approvedAtMs) {
  return {
    userId,
    authenticationId,
    authenticatedAtMs: approvedAtMs - 1_000,
    approvedAtMs,
    publicKey: keys.publicKey,
    sign: (message) => sign(null, message, keys.privateKey),
  };
}

function authorization(encrypted, custody, overrides = {}) {
  return createPluginPackagePromptOutputExternalRecoveryAuthorization(
    {
      recoveryId: 'recovery-001',
      requestId: 'request-001',
      custodyId: custody.custodyId,
      custodyReceiptDigest: custody.receiptDigest,
      keyId: custody.keyId,
      artifactId: encrypted.artifactId,
      artifactDigest: encrypted.artifactDigest,
      policyDigest: POLICY_DIGEST,
      requestedBy: {
        userId: 'requester-user',
        authenticationId: 'requester-auth-001',
        authenticatedAtMs: NOW - 5_000,
      },
      requestedAtMs: NOW,
      expiresAtMs: NOW + 10 * 60_000,
      ...overrides,
    },
    [
      signer('reviewer-b', 'reviewer-b-auth', approverBKeys, NOW + 2_000),
      signer('reviewer-a', 'reviewer-a-auth', approverAKeys, NOW + 1_000),
    ],
  );
}

function trustedApprovers() {
  return [
    { userId: 'reviewer-a', publicKey: approverAKeys.publicKey },
    { userId: 'reviewer-b', publicKey: approverBKeys.publicKey },
  ];
}

test('binds two distinct strong approvers to one exact recovery request', () => {
  const encrypted = artifact();
  const custody = receipt();
  const value = authorization(encrypted, custody);
  assert.deepEqual(
    normalizePluginPackagePromptOutputExternalRecoveryAuthorization(value),
    value,
  );
  assert.deepEqual(
    verifyPluginPackagePromptOutputExternalRecoveryAuthorization(
      value,
      trustedApprovers(),
      NOW + 3_000,
    ),
    value,
  );
  assert.deepEqual(
    value.approvals.map(({ userId }) => userId),
    ['reviewer-a', 'reviewer-b'],
  );
  assert.equal(value.permission, 'artifact.read');
  assert.equal(value.purpose, 'lost-key-recovery-verification');
});

test('returns only an authorization-bound content-free recovery proof', () => {
  const encrypted = artifact();
  const custody = receipt();
  const proof = verifyAuthorizedPluginPackagePromptOutputRecoveredMaterial({
    authorization: authorization(encrypted, custody),
    trustedApprovers: trustedApprovers(),
    receipt: custody,
    trustedCustodyPublicKey: custodyKeys.publicKey,
    wrappedMaterial: WRAPPED,
    durableKeyFact: {
      keyId: custody.keyId,
      materialProof: custody.materialProof,
      catalogDigest: custody.sourceCatalogDigest,
    },
    material: MATERIAL,
    artifact: encrypted,
    verifiedAtMs: NOW + 3_000,
  });
  assert.equal(proof.artifactId, encrypted.artifactId);
  assert.equal(proof.authorizationDigest.length, 64);
  assert.equal(proof.recoveryProofDigest.length, 64);
  assert.equal(proof.proofDigest.length, 64);
  const serialized = JSON.stringify(proof);
  assert.equal(serialized.includes('historical private answer'), false);
  assert.equal(serialized.includes(MATERIAL.toString('base64url')), false);
  assert.equal(serialized.includes(WRAPPED.toString('base64url')), false);
});

test('rejects requester self-approval, duplicate identity and stale authentication', () => {
  const encrypted = artifact();
  const custody = receipt();
  for (const signers of [
    [
      signer(
        'requester-user',
        'requester-review-auth',
        approverAKeys,
        NOW + 1_000,
      ),
      signer('reviewer-b', 'reviewer-b-auth', approverBKeys, NOW + 2_000),
    ],
    [
      signer('reviewer-a', 'same-auth', approverAKeys, NOW + 1_000),
      signer('reviewer-b', 'same-auth', approverBKeys, NOW + 2_000),
    ],
    [
      {
        ...signer('reviewer-a', 'reviewer-a-auth', approverAKeys, NOW + 1_000),
        authenticatedAtMs: NOW - 10 * 60_000,
      },
      signer('reviewer-b', 'reviewer-b-auth', approverBKeys, NOW + 2_000),
    ],
  ]) {
    assert.throws(() =>
      createPluginPackagePromptOutputExternalRecoveryAuthorization(
        {
          recoveryId: 'recovery-001',
          requestId: 'request-001',
          custodyId: custody.custodyId,
          custodyReceiptDigest: custody.receiptDigest,
          keyId: custody.keyId,
          artifactId: encrypted.artifactId,
          artifactDigest: encrypted.artifactDigest,
          policyDigest: POLICY_DIGEST,
          requestedBy: {
            userId: 'requester-user',
            authenticationId: 'requester-auth-001',
            authenticatedAtMs: NOW - 5_000,
          },
          requestedAtMs: NOW,
          expiresAtMs: NOW + 10 * 60_000,
        },
        signers,
      ),
    );
  }
});

test('rejects signature, trusted approver, expiry and exact fact drift', () => {
  const encrypted = artifact();
  const custody = receipt();
  const approved = authorization(encrypted, custody);
  const signature = Buffer.from(approved.approvals[0].signature, 'base64url');
  signature[0] ^= 1;
  assert.throws(
    () =>
      verifyPluginPackagePromptOutputExternalRecoveryAuthorization(
        {
          ...approved,
          approvals: [
            {
              ...approved.approvals[0],
              signature: signature.toString('base64url'),
            },
            approved.approvals[1],
          ],
        },
        trustedApprovers(),
        NOW + 3_000,
      ),
    PluginPackagePromptOutputRecoveryAuthorizationUntrustedError,
  );
  assert.throws(
    () =>
      verifyPluginPackagePromptOutputExternalRecoveryAuthorization(
        approved,
        [
          trustedApprovers()[0],
          {
            userId: 'reviewer-b',
            publicKey: generateKeyPairSync('ed25519').publicKey,
          },
        ],
        NOW + 3_000,
      ),
    PluginPackagePromptOutputRecoveryAuthorizationUntrustedError,
  );
  assert.throws(
    () =>
      verifyPluginPackagePromptOutputExternalRecoveryAuthorization(
        approved,
        trustedApprovers(),
        NOW + 11 * 60_000,
      ),
    PluginPackagePromptOutputRecoveryAuthorizationUntrustedError,
  );
  assert.throws(
    () =>
      verifyAuthorizedPluginPackagePromptOutputRecoveredMaterial({
        authorization: approved,
        trustedApprovers: trustedApprovers(),
        receipt: custody,
        trustedCustodyPublicKey: custodyKeys.publicKey,
        wrappedMaterial: WRAPPED,
        durableKeyFact: {
          keyId: custody.keyId,
          materialProof: custody.materialProof,
          catalogDigest: custody.sourceCatalogDigest,
        },
        material: MATERIAL,
        artifact: { ...encrypted, artifactDigest: '4'.repeat(64) },
        verifiedAtMs: NOW + 3_000,
      }),
    PluginPackagePromptOutputRecoveryAuthorizationUntrustedError,
  );
});
