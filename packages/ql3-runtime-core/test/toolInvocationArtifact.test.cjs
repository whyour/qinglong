const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');

const {
  InvalidToolInvocationArtifactError,
  TOOL_INVOCATION_ARTIFACT_ALGORITHM,
  TOOL_INVOCATION_INPUT_ARTIFACT_SCHEMA,
  TOOL_INVOCATION_PREVIEW_ARTIFACT_SCHEMA,
  ToolInvocationArtifactUnavailableError,
  createToolInvocationInputArtifact,
  createToolInvocationPreviewArtifact,
  normalizeToolInvocationInputArtifact,
  normalizeToolInvocationPreviewArtifact,
  openToolInvocationInputArtifact,
  toolInvocationInputArtifactReference,
  toolInvocationPreviewArtifactReference,
} = require('../dist/tool-execution/toolInvocationArtifact');
const {
  ToolDefinitionRegistry,
} = require('../dist/tool-execution/tool-registry/toolRegistry');

const KEY = Buffer.alloc(32, 7);
const WRONG_KEY = Buffer.alloc(32, 8);
const NONCE = Buffer.alloc(12, 9);
const ACTION_DIGEST = 'a'.repeat(64);
const REDACTION_DIGEST = 'b'.repeat(64);

function registry() {
  return new ToolDefinitionRegistry([
    {
      name: 'demo.compare',
      version: '1.0.0',
      description: 'Compare one bounded Run projection',
      inputSchema: {
        type: 'object',
        properties: {
          runId: { type: 'string', minLength: 1, maxLength: 64 },
          token: { type: 'string', minLength: 1, maxLength: 128 },
        },
        required: ['runId', 'token'],
        additionalProperties: false,
      },
      effect: 'read',
      risk: 'low',
      requiredPermissions: ['run.read'],
      timeoutSeconds: 30,
    },
  ]);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function inputArtifact(overrides = {}) {
  const input = { runId: 'run-001', token: 'secret-value' };
  return createToolInvocationInputArtifact(
    {
      artifactId: 'artifact-input-001',
      projectId: 'project-001',
      actionRef: 'tool-plan:run-001',
      requestedBy: { type: 'user', id: 'usr-owner' },
      tool: { name: 'demo.compare', version: '1.0.0' },
      input,
      inputDigest: digest(input),
      invocationActionDigest: ACTION_DIGEST,
      keyId: 'tool-key-2026-07',
      key: KEY,
      sealedAtMs: 1_000,
      ...overrides,
    },
    () => NONCE,
  );
}

test('seals bounded Tool input as an opaque authenticated Artifact', () => {
  const artifact = inputArtifact();
  assert.equal(artifact.schema, TOOL_INVOCATION_INPUT_ARTIFACT_SCHEMA);
  assert.equal(artifact.algorithm, TOOL_INVOCATION_ARTIFACT_ALGORITHM);
  assert.equal(JSON.stringify(artifact).includes('secret-value'), false);
  assert.deepEqual(normalizeToolInvocationInputArtifact(artifact), artifact);
  assert.deepEqual(openToolInvocationInputArtifact(artifact, KEY, registry()), {
    runId: 'run-001',
    token: 'secret-value',
  });
  assert.deepEqual(toolInvocationInputArtifactReference(artifact), {
    artifactId: artifact.artifactId,
    artifactDigest: artifact.artifactDigest,
    inputDigest: artifact.inputDigest,
    keyId: artifact.keyId,
    algorithm: TOOL_INVOCATION_ARTIFACT_ALGORITHM,
    plaintextBytes: artifact.plaintextBytes,
  });
});

test('fails closed for Artifact drift, the wrong key and schema drift', () => {
  const artifact = inputArtifact();
  assert.throws(
    () =>
      normalizeToolInvocationInputArtifact({
        ...artifact,
        ciphertext: `${artifact.ciphertext.slice(0, -1)}A`,
      }),
    InvalidToolInvocationArtifactError,
  );
  assert.throws(
    () => openToolInvocationInputArtifact(artifact, WRONG_KEY, registry()),
    ToolInvocationArtifactUnavailableError,
  );
  assert.throws(
    () =>
      inputArtifact({
        input: { runId: 'run-001', token: 'secret-value', extra: true },
      }),
    InvalidToolInvocationArtifactError,
  );
});

test('publishes the redacted preview as a separately digest-bound Artifact', () => {
  const preview = {
    title: 'Compare Run',
    summary: 'Reads one Run projection',
    fields: [
      { kind: 'identifier', label: 'Run', value: 'run-001' },
      { kind: 'redacted', label: 'Credential', value: null },
    ],
    warnings: [],
  };
  const artifact = createToolInvocationPreviewArtifact({
    artifactId: 'artifact-preview-001',
    projectId: 'project-001',
    actionRef: 'tool-plan:run-001',
    actionDigest: ACTION_DIGEST,
    redactionContractDigest: REDACTION_DIGEST,
    preview,
    sealedAtMs: 1_000,
  });
  assert.equal(artifact.schema, TOOL_INVOCATION_PREVIEW_ARTIFACT_SCHEMA);
  assert.equal(JSON.stringify(artifact).includes('secret-value'), false);
  assert.deepEqual(normalizeToolInvocationPreviewArtifact(artifact), artifact);
  assert.deepEqual(toolInvocationPreviewArtifactReference(artifact), {
    artifactId: artifact.artifactId,
    artifactDigest: artifact.artifactDigest,
    actionDigest: ACTION_DIGEST,
    previewDigest: artifact.previewDigest,
    redactionContractDigest: REDACTION_DIGEST,
    byteLength: artifact.byteLength,
  });
});

test('publishes the contract through root and the explicit Artifact subpath', () => {
  const root = require('../dist');
  const subpath = require('@qinglong/runtime-core/tool-invocation-artifact');
  assert.equal(
    root.TOOL_INVOCATION_INPUT_ARTIFACT_SCHEMA,
    TOOL_INVOCATION_INPUT_ARTIFACT_SCHEMA,
  );
  assert.equal(
    subpath.TOOL_INVOCATION_PREVIEW_ARTIFACT_SCHEMA,
    TOOL_INVOCATION_PREVIEW_ARTIFACT_SCHEMA,
  );
});
