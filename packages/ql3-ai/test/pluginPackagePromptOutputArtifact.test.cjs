const assert = require('node:assert/strict');
const test = require('node:test');

const {
  InvalidPluginPackagePromptOutputArtifactError,
  PluginPackagePromptOutputArtifactUnavailableError,
  createPluginPackagePromptOutputArtifact,
  normalizePluginPackagePromptOutputArtifact,
  normalizePluginPackagePromptOutputArtifactReference,
  openPluginPackagePromptOutputArtifact,
  pluginPackagePromptOutputArtifactIdentity,
  pluginPackagePromptOutputArtifactReference,
  pluginPackagePromptOutputArtifactRetentionPolicyDigest,
} = require('../dist/prompt-output/pluginPackagePromptOutputArtifact.js');

const KEY = Buffer.alloc(32, 7);
const NONCE = Buffer.alloc(12, 9);
const RETENTION = Object.freeze({
  revision: 'edge-default-v1',
  retentionMs: 86_400_000,
});
const RESULT = Object.freeze({
  provider: 'openai-compatible',
  model: 'bounded-model',
  text: 'private durable answer: ql3-artifact-secret',
  finishReason: 'stop',
  usage: Object.freeze({
    inputTokens: 12,
    outputTokens: 7,
    totalTokens: 19,
    costMicros: 42,
  }),
});

function create(overrides = {}) {
  return createPluginPackagePromptOutputArtifact(
    {
      projectId: 'project-a',
      runId: 'run-a',
      stepRunId: 'step-a',
      invocationId: 'invocation-a',
      requestedBy: { type: 'user', id: 'user-a' },
      result: RESULT,
      retentionPolicy: RETENTION,
      keyId: 'prompt-key-1',
      key: Buffer.from(KEY),
      sealedAtMs: 1_700_000_000_000,
      ...overrides,
    },
    () => Buffer.from(NONCE),
  );
}

test('Prompt output Artifact encrypts bounded result and opens exact content', () => {
  const artifact = create();
  const serialized = JSON.stringify(artifact);

  assert.equal(
    artifact.artifactId,
    pluginPackagePromptOutputArtifactIdentity('invocation-a'),
  );
  assert.equal(
    artifact.retentionPolicyDigest,
    pluginPackagePromptOutputArtifactRetentionPolicyDigest(RETENTION),
  );
  assert.equal(artifact.retentionEligibleAtMs, 1_700_086_400_000);
  assert.equal(artifact.outputBytes, Buffer.byteLength(RESULT.text, 'utf8'));
  assert.equal(serialized.includes(RESULT.text), false);
  assert.equal(serialized.includes('ql3-artifact-secret'), false);
  assert.deepEqual(
    openPluginPackagePromptOutputArtifact(artifact, Buffer.from(KEY)),
    RESULT,
  );
  assert.deepEqual(
    normalizePluginPackagePromptOutputArtifact(artifact),
    artifact,
  );
});

test('Prompt output Artifact reference is content-free and identity-bound', () => {
  const artifact = create();
  const reference = pluginPackagePromptOutputArtifactReference(artifact);

  assert.deepEqual(
    normalizePluginPackagePromptOutputArtifactReference(reference),
    reference,
  );
  assert.equal(JSON.stringify(reference).includes(RESULT.text), false);
  assert.equal(reference.artifactDigest, artifact.artifactDigest);
  assert.equal(reference.contentDigest, artifact.contentDigest);
  assert.equal(reference.keyId, artifact.keyId);
  assert.equal(reference.retentionPolicyDigest, artifact.retentionPolicyDigest);

  assert.throws(
    () =>
      normalizePluginPackagePromptOutputArtifactReference({
        ...reference,
        invocationId: 'invocation-b',
      }),
    InvalidPluginPackagePromptOutputArtifactError,
  );
});

test('Prompt output Artifact rejects metadata and ciphertext tampering', () => {
  const artifact = create();
  assert.throws(
    () =>
      normalizePluginPackagePromptOutputArtifact({
        ...artifact,
        projectId: 'project-b',
      }),
    InvalidPluginPackagePromptOutputArtifactError,
  );

  const ciphertext = Buffer.from(artifact.ciphertext, 'base64url');
  ciphertext[0] ^= 1;
  const tampered = {
    ...artifact,
    ciphertext: ciphertext.toString('base64url'),
  };
  assert.throws(
    () => normalizePluginPackagePromptOutputArtifact(tampered),
    InvalidPluginPackagePromptOutputArtifactError,
  );

  const wrongKeyArtifact = create();
  assert.throws(
    () =>
      openPluginPackagePromptOutputArtifact(
        wrongKeyArtifact,
        Buffer.alloc(32, 8),
      ),
    PluginPackagePromptOutputArtifactUnavailableError,
  );
});

test('Prompt output Artifact rejects unsafe retention and key material', () => {
  assert.throws(
    () =>
      create({
        retentionPolicy: { revision: 'bad', retentionMs: 1 },
      }),
    InvalidPluginPackagePromptOutputArtifactError,
  );
  assert.throws(
    () => create({ key: Buffer.alloc(31) }),
    PluginPackagePromptOutputArtifactUnavailableError,
  );
  assert.throws(
    () => create({ sealedAtMs: Number.MAX_SAFE_INTEGER }),
    InvalidPluginPackagePromptOutputArtifactError,
  );
});
