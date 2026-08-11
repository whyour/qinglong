const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { test } = require('node:test');

const {
  PluginPackagePromptOutputExternalCustodyUntrustedError,
  createPluginPackagePromptOutputExternalCustodyReceipt,
  normalizePluginPackagePromptOutputExternalCustodyReceipt,
  verifyPluginPackagePromptOutputExternalCustodyReceipt,
  verifyPluginPackagePromptOutputRecoveredMaterial,
  verifyPluginPackagePromptOutputWrappedBackup,
} = require('../dist/prompt-output/custody/pluginPackagePromptOutputExternalCustody.js');
const {
  createPluginPackagePromptOutputArtifact,
} = require('../dist/prompt-output/pluginPackagePromptOutputArtifact.js');
const {
  pluginPackagePromptOutputKeyRotationMaterialProof,
} = require('../dist/prompt-output/key-management/pluginPackagePromptOutputKeyRotation.js');

const MATERIAL = Buffer.alloc(32, 0x5a);
const WRAPPED = Buffer.from('kms-wrapped-prompt-output-key-material');
const CATALOG_DIGEST = '1'.repeat(64);
const WRAPPING_KEY_REF_DIGEST = '2'.repeat(64);
const { publicKey, privateKey } = generateKeyPairSync('ed25519');

function receipt(overrides = {}) {
  return createPluginPackagePromptOutputExternalCustodyReceipt(
    {
      custodyId: 'custody-001',
      keyId: 'prompt-key-001',
      materialProof: pluginPackagePromptOutputKeyRotationMaterialProof(
        'prompt-key-001',
        MATERIAL,
      ),
      sourceGeneration: 4,
      sourceCatalogDigest: CATALOG_DIGEST,
      wrappingProvider: 'vault-transit',
      wrappingKeyRefDigest: WRAPPING_KEY_REF_DIGEST,
      wrappedMaterialDigest: createHash('sha256').update(WRAPPED).digest('hex'),
      wrappedMaterialBytes: WRAPPED.length,
      createdAtMs: 1_700_000_000_000,
      ...overrides,
    },
    {
      publicKey,
      sign: (digest) => sign(null, digest, privateKey),
    },
  );
}

function artifact(overrides = {}) {
  return createPluginPackagePromptOutputArtifact(
    {
      projectId: 'project-a',
      runId: 'run-a',
      stepRunId: 'step-a',
      invocationId: 'invocation-a',
      requestedBy: { type: 'user', id: 'user-a' },
      result: {
        provider: 'openai-compatible',
        model: 'bounded-model',
        text: 'private recovered answer',
        finishReason: 'stop',
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          totalTokens: 8,
          costMicros: 11,
        },
      },
      retentionPolicy: {
        revision: 'retention-v1',
        retentionMs: 86_400_000,
      },
      keyId: 'prompt-key-001',
      key: Buffer.from(MATERIAL),
      sealedAtMs: 1_700_000_000_000,
      ...overrides,
    },
    () => Buffer.alloc(12, 0x33),
  );
}

test('binds a signed content-free custody receipt to exact wrapped bytes', () => {
  const value = receipt();
  assert.deepEqual(
    normalizePluginPackagePromptOutputExternalCustodyReceipt(value),
    value,
  );
  assert.deepEqual(
    verifyPluginPackagePromptOutputExternalCustodyReceipt(value, publicKey),
    value,
  );
  const verified = verifyPluginPackagePromptOutputWrappedBackup(
    value,
    publicKey,
    WRAPPED,
  );
  assert.equal(verified.custodyId, 'custody-001');
  assert.equal(verified.wrappedMaterialBytes, WRAPPED.length);
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(MATERIAL.toString('base64url')), false);
  assert.equal(serialized.includes(WRAPPED.toString('base64url')), false);
  assert.equal(serialized.includes('kms-wrapped-prompt'), false);
});

test('verifies recovered material against durable fact and opens an Artifact', () => {
  const custody = receipt();
  const encrypted = artifact();
  const proof = verifyPluginPackagePromptOutputRecoveredMaterial({
    recoveryId: 'recovery-001',
    requestId: 'request-001',
    receipt: custody,
    trustedPublicKey: publicKey,
    durableKeyFact: {
      keyId: custody.keyId,
      materialProof: custody.materialProof,
      catalogDigest: custody.sourceCatalogDigest,
    },
    material: MATERIAL,
    artifact: encrypted,
    verifiedAtMs: 1_700_000_001_000,
  });
  assert.equal(proof.artifactId, encrypted.artifactId);
  assert.equal(proof.artifactDigest, encrypted.artifactDigest);
  assert.equal(proof.contentDigest, encrypted.contentDigest);
  assert.equal(proof.keyId, custody.keyId);
  assert.equal(proof.proofDigest.length, 64);
  const serialized = JSON.stringify(proof);
  assert.equal(serialized.includes('private recovered answer'), false);
  assert.equal(serialized.includes(MATERIAL.toString('base64url')), false);
});

test('rejects untrusted receipt, wrapped bytes, durable fact and material drift', () => {
  const custody = receipt();
  const otherKeys = generateKeyPairSync('ed25519');
  assert.throws(
    () =>
      verifyPluginPackagePromptOutputExternalCustodyReceipt(
        custody,
        otherKeys.publicKey,
      ),
    PluginPackagePromptOutputExternalCustodyUntrustedError,
  );
  assert.throws(
    () =>
      verifyPluginPackagePromptOutputWrappedBackup(
        custody,
        publicKey,
        Buffer.from('different wrapped material'),
      ),
    PluginPackagePromptOutputExternalCustodyUntrustedError,
  );
  for (const candidate of [
    {
      durableKeyFact: {
        keyId: custody.keyId,
        materialProof: '3'.repeat(64),
        catalogDigest: custody.sourceCatalogDigest,
      },
      material: MATERIAL,
    },
    {
      durableKeyFact: {
        keyId: custody.keyId,
        materialProof: custody.materialProof,
        catalogDigest: custody.sourceCatalogDigest,
      },
      material: Buffer.alloc(32, 0x5b),
    },
  ]) {
    assert.throws(
      () =>
        verifyPluginPackagePromptOutputRecoveredMaterial({
          recoveryId: 'recovery-001',
          requestId: 'request-001',
          receipt: custody,
          trustedPublicKey: publicKey,
          durableKeyFact: candidate.durableKeyFact,
          material: candidate.material,
          artifact: artifact(),
          verifiedAtMs: 1_700_000_001_000,
        }),
      PluginPackagePromptOutputExternalCustodyUntrustedError,
    );
  }
});

test('rejects a custody receipt with a tampered signature', () => {
  const custody = receipt();
  const signature = Buffer.from(custody.signature, 'base64url');
  signature[0] ^= 0x01;

  assert.throws(
    () =>
      verifyPluginPackagePromptOutputExternalCustodyReceipt(
        {
          ...custody,
          signature: signature.toString('base64url'),
        },
        publicKey,
      ),
    PluginPackagePromptOutputExternalCustodyUntrustedError,
  );
});
