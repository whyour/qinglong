'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const {
  BUILTIN_RUN_READ_TOOL,
  BUILTIN_RUN_READ_TOOL_DEFINITION,
} = require('../dist/tool-execution/builtin-run-read/builtInRunReadTool');
const {
  TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
} = require('../dist/tool-execution/trustedToolExecution');
const {
  TOOL_EXECUTION_RESULT_KEY_BINDING_SCHEMA,
  createToolExecutionResultArtifact,
  normalizeToolExecutionResultKeyBinding,
} = require('../dist/tool-execution/toolExecutionCompletion');
const {
  createToolResultKeyCatalogBootstrapCommand,
  createToolResultKeyRotationCommand,
  normalizeToolResultKeyCatalogRecord,
  requireActiveToolResultKey,
  toolResultKeyCatalogFence,
  toolResultKeyMaterialProof,
} = require('../dist/tool-execution/toolResultKeyCatalog');
const {
  TOOL_EXECUTION_RESULT_REKEY_OVERLAY_SCHEMA,
  InvalidToolExecutionResultRekeyError,
  ToolResultKeyRetirementCoverageBuilder,
  ToolExecutionResultRekeyConflictError,
  ToolExecutionResultRekeyUnavailableError,
  createToolExecutionResultRekeyCommand,
  createToolResultKeyRetirementReceipt,
  createToolResultKeyRetirementReceiptCommand,
  normalizeToolExecutionResultRekeyCommand,
  normalizeToolResultKeyRetirementReceiptCommand,
  normalizeToolResultKeyRetirementReceipt,
  openToolExecutionResultRekeyOverlay,
} = require('../dist/tool-execution/toolResultRekey');
const {
  ToolDefinitionRegistry,
} = require('../dist/tool-execution/tool-registry/toolRegistry');

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);
const KEY_C = Buffer.alloc(32, 3);
const OUTPUT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-output-digest@v1\0',
  'utf8',
);
const RESULT_DIGEST_DOMAIN = Buffer.from(
  'qinglong/trusted-tool-execution-result-digest@v1\0',
  'utf8',
);
const BINDING_DIGEST_DOMAIN = Buffer.from(
  'qinglong/tool-execution-result-key-binding-digest@v1\0',
  'utf8',
);

function hash(domain, value) {
  return createHash('sha256')
    .update(domain)
    .update(JSON.stringify(value))
    .digest('hex');
}

function registry() {
  return new ToolDefinitionRegistry([BUILTIN_RUN_READ_TOOL_DEFINITION]);
}

function output() {
  return {
    createdAtMs: 1_000,
    eventSequence: 3,
    executionOrigin: 'manual',
    executionOwner: 'runtime',
    found: true,
    id: 'run-rekey-001',
    priority: 10,
    queuedAtMs: 1_100,
    startedAtMs: 1_200,
    status: 'succeeded',
    taskId: 'task-rekey-001',
    taskRevision: 'task-rekey-001@1',
    version: 2,
  };
}

function executionResult() {
  const value = output();
  const unsigned = Object.freeze({
    schema: TRUSTED_TOOL_EXECUTION_RESULT_SCHEMA,
    startId: 'tool-start-rekey-001',
    barrierDigest: 'a'.repeat(64),
    adapterDigest: 'b'.repeat(64),
    output: value,
    outputDigest: hash(OUTPUT_DIGEST_DOMAIN, value),
    completedAtMs: 1_500,
  });
  return Object.freeze({
    ...unsigned,
    resultDigest: hash(RESULT_DIGEST_DOMAIN, unsigned),
  });
}

function artifact() {
  return createToolExecutionResultArtifact(
    {
      artifactId: 'artifact-result-rekey-001',
      projectId: 'project-rekey-001',
      runId: 'run-host-rekey-001',
      stepRunId: 'step-run-rekey-001',
      tool: BUILTIN_RUN_READ_TOOL,
      executionResult: executionResult(),
      keyId: 'result-key-a',
      key: KEY_A,
    },
    registry(),
    () => Buffer.alloc(12, 4),
  );
}

function binding(source) {
  const unsigned = Object.freeze({
    schema: TOOL_EXECUTION_RESULT_KEY_BINDING_SCHEMA,
    startId: source.startId,
    artifactId: source.artifactId,
    artifactDigest: source.artifactDigest,
    catalogGeneration: 1,
    catalogDigest: 'c'.repeat(64),
    keyId: source.keyId,
    materialProof: toolResultKeyMaterialProof(source.keyId, KEY_A),
  });
  return normalizeToolExecutionResultKeyBinding({
    ...unsigned,
    bindingDigest: hash(BINDING_DIGEST_DOMAIN, unsigned),
  });
}

function committed(command, committedAtMs) {
  return normalizeToolResultKeyCatalogRecord({
    ...command.next,
    committedAtMs,
  });
}

function targetCatalogs() {
  const first = committed(
    createToolResultKeyCatalogBootstrapCommand({
      keyId: 'result-key-b',
      materialProof: toolResultKeyMaterialProof('result-key-b', KEY_B),
      mutationId: 'result-key-bootstrap-b',
    }),
    1_600,
  );
  const second = committed(
    createToolResultKeyRotationCommand(first, {
      keyId: 'result-key-c',
      materialProof: toolResultKeyMaterialProof('result-key-c', KEY_C),
      mutationId: 'result-key-rotate-c',
    }),
    1_800,
  );
  return { first, second };
}

test('creates an immutable rekey head without rewriting the source Artifact', () => {
  const source = artifact();
  const sourceJson = JSON.stringify(source);
  const sourceBinding = binding(source);
  const { first } = targetCatalogs();
  const command = createToolExecutionResultRekeyCommand({
    artifact: source,
    binding: sourceBinding,
    previousOverlay: null,
    overlayId: 'result-rekey-overlay-001',
    mutationId: 'result-rekey-mutation-001',
    targetCatalogFence: toolResultKeyCatalogFence(
      first,
      requireActiveToolResultKey(first),
    ),
    targetKey: KEY_B,
    output: output(),
    rekeyedAtMs: 1_700,
    registry: registry(),
    nonceFactory: () => Buffer.alloc(12, 5),
  });

  assert.equal(command.expectedRevision, 0);
  assert.equal(command.expectedOverlayDigest, null);
  assert.equal(
    command.overlay.schema,
    TOOL_EXECUTION_RESULT_REKEY_OVERLAY_SCHEMA,
  );
  assert.equal(command.overlay.revision, 1);
  assert.equal(command.overlay.fromKeyId, 'result-key-a');
  assert.equal(command.overlay.targetCatalogFence.keyId, 'result-key-b');
  assert.equal(
    JSON.stringify(command.overlay).includes('run-rekey-001'),
    false,
  );
  assert.equal(JSON.stringify(source), sourceJson);
  assert.deepEqual(
    openToolExecutionResultRekeyOverlay(
      command.overlay,
      KEY_B,
      registry(),
      source,
    ),
    output(),
  );
  assert.throws(
    () =>
      openToolExecutionResultRekeyOverlay(
        command.overlay,
        KEY_C,
        registry(),
        source,
      ),
    ToolExecutionResultRekeyUnavailableError,
  );
});

test('chains rekey revisions with an exact head fence', () => {
  const source = artifact();
  const sourceBinding = binding(source);
  const { first, second } = targetCatalogs();
  const firstCommand = createToolExecutionResultRekeyCommand({
    artifact: source,
    binding: sourceBinding,
    previousOverlay: null,
    overlayId: 'result-rekey-overlay-001',
    mutationId: 'result-rekey-mutation-001',
    targetCatalogFence: toolResultKeyCatalogFence(
      first,
      requireActiveToolResultKey(first),
    ),
    targetKey: KEY_B,
    output: output(),
    rekeyedAtMs: 1_700,
    registry: registry(),
    nonceFactory: () => Buffer.alloc(12, 5),
  });
  const secondCommand = createToolExecutionResultRekeyCommand({
    artifact: source,
    binding: sourceBinding,
    previousOverlay: firstCommand.overlay,
    overlayId: 'result-rekey-overlay-002',
    mutationId: 'result-rekey-mutation-002',
    targetCatalogFence: toolResultKeyCatalogFence(
      second,
      requireActiveToolResultKey(second),
    ),
    targetKey: KEY_C,
    output: output(),
    rekeyedAtMs: 1_900,
    registry: registry(),
    nonceFactory: () => Buffer.alloc(12, 6),
  });

  assert.equal(secondCommand.expectedRevision, 1);
  assert.equal(
    secondCommand.expectedOverlayDigest,
    firstCommand.overlay.overlayDigest,
  );
  assert.equal(secondCommand.overlay.revision, 2);
  assert.equal(secondCommand.overlay.fromKeyId, 'result-key-b');
  assert.deepEqual(
    openToolExecutionResultRekeyOverlay(
      secondCommand.overlay,
      KEY_C,
      registry(),
      source,
    ),
    output(),
  );
  assert.throws(
    () =>
      normalizeToolExecutionResultRekeyCommand({
        ...secondCommand,
        expectedRevision: 0,
      }),
    InvalidToolExecutionResultRekeyError,
  );
  assert.throws(
    () =>
      createToolExecutionResultRekeyCommand({
        artifact: { ...source, artifactId: 'artifact-result-rekey-other' },
        binding: sourceBinding,
        previousOverlay: firstCommand.overlay,
        overlayId: 'result-rekey-overlay-bad',
        mutationId: 'result-rekey-mutation-bad',
        targetCatalogFence: toolResultKeyCatalogFence(
          second,
          requireActiveToolResultKey(second),
        ),
        targetKey: KEY_C,
        output: output(),
        rekeyedAtMs: 1_900,
        registry: registry(),
      }),
    TypeError,
  );
  assert.throws(
    () =>
      createToolExecutionResultRekeyCommand({
        artifact: source,
        binding: { ...sourceBinding, artifactId: 'artifact-result-other' },
        previousOverlay: firstCommand.overlay,
        overlayId: 'result-rekey-overlay-bad',
        mutationId: 'result-rekey-mutation-bad',
        targetCatalogFence: toolResultKeyCatalogFence(
          second,
          requireActiveToolResultKey(second),
        ),
        targetKey: KEY_C,
        output: output(),
        rekeyedAtMs: 1_900,
        registry: registry(),
      }),
    TypeError,
  );
});

test('binds retirement evidence to an exact catalog and zero uncovered heads', () => {
  const coverage = new ToolResultKeyRetirementCoverageBuilder({
    catalogGeneration: 2,
    catalogDigest: 'd'.repeat(64),
    keyId: 'result-key-a',
    decryptableKeyIds: ['result-key-b'],
  });
  coverage.add({
    artifactId: 'artifact-result-rekey-001',
    bindingDigest: 'f'.repeat(64),
    bindingKeyId: 'result-key-a',
    headOverlayDigest: '1'.repeat(64),
    headTargetKeyId: 'result-key-b',
    headTargetCatalogGeneration: 2,
    headTargetCatalogDigest: 'd'.repeat(64),
  });
  const coverageResult = coverage.finish();
  assert.deepEqual(
    {
      bindingCount: coverageResult.bindingCount,
      overlayHeadCount: coverageResult.overlayHeadCount,
      uncoveredBindingCount: coverageResult.uncoveredBindingCount,
      uncoveredOverlayHeadCount: coverageResult.uncoveredOverlayHeadCount,
    },
    {
      bindingCount: 1,
      overlayHeadCount: 1,
      uncoveredBindingCount: 0,
      uncoveredOverlayHeadCount: 0,
    },
  );
  const receipt = createToolResultKeyRetirementReceipt({
    catalogGeneration: 2,
    catalogDigest: 'd'.repeat(64),
    keyId: 'result-key-a',
    materialProof: toolResultKeyMaterialProof('result-key-a', KEY_A),
    mutationId: 'result-key-retirement-receipt-001',
    bindingCount: coverageResult.bindingCount,
    overlayHeadCount: coverageResult.overlayHeadCount,
    coverageDigest: coverageResult.coverageDigest,
    createdAtMs: 2_000,
  });

  assert.equal(receipt.uncoveredBindingCount, 0);
  assert.equal(receipt.uncoveredOverlayHeadCount, 0);
  assert.throws(
    () =>
      normalizeToolResultKeyRetirementReceipt({
        ...receipt,
        uncoveredBindingCount: 1,
      }),
    InvalidToolExecutionResultRekeyError,
  );

  const command = createToolResultKeyRetirementReceiptCommand({
    expectedCatalogGeneration: 2,
    expectedCatalogDigest: 'd'.repeat(64),
    keyId: 'result-key-a',
    mutationId: 'result-key-retirement-receipt-001',
  });
  assert.throws(
    () =>
      normalizeToolResultKeyRetirementReceiptCommand({
        ...command,
        expectedCatalogGeneration: 3,
      }),
    InvalidToolExecutionResultRekeyError,
  );
});

test('retirement coverage rejects missing and self-key heads', () => {
  const missing = new ToolResultKeyRetirementCoverageBuilder({
    catalogGeneration: 2,
    catalogDigest: 'd'.repeat(64),
    keyId: 'result-key-a',
    decryptableKeyIds: ['result-key-b'],
  });
  missing.add({
    artifactId: 'artifact-result-rekey-001',
    bindingDigest: 'f'.repeat(64),
    bindingKeyId: 'result-key-a',
    headOverlayDigest: null,
    headTargetKeyId: null,
    headTargetCatalogGeneration: null,
    headTargetCatalogDigest: null,
  });
  assert.equal(missing.finish().uncoveredBindingCount, 1);

  const self = new ToolResultKeyRetirementCoverageBuilder({
    catalogGeneration: 2,
    catalogDigest: 'd'.repeat(64),
    keyId: 'result-key-a',
    decryptableKeyIds: ['result-key-b'],
  });
  self.add({
    artifactId: 'artifact-result-rekey-002',
    bindingDigest: '2'.repeat(64),
    bindingKeyId: 'result-key-b',
    headOverlayDigest: '3'.repeat(64),
    headTargetKeyId: 'result-key-a',
    headTargetCatalogGeneration: 1,
    headTargetCatalogDigest: 'c'.repeat(64),
  });
  assert.equal(self.finish().uncoveredOverlayHeadCount, 1);
});

test('exposes rekey only from its explicit subpath', () => {
  const root = require('../dist');
  const authority = require('@qinglong/runtime-core/tool-result-rekey');

  assert.equal(root.createToolExecutionResultRekeyCommand, undefined);
  assert.equal(
    authority.createToolExecutionResultRekeyCommand,
    createToolExecutionResultRekeyCommand,
  );
  assert.equal(
    authority.ToolExecutionResultRekeyConflictError,
    ToolExecutionResultRekeyConflictError,
  );
});
