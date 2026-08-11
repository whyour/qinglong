'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TOOL_RESULT_KEY_CATALOG_SCHEMA,
  ToolResultKeyCatalogUnavailableError,
  ToolResultKeyLostError,
  createToolResultKeyCatalogBootstrapCommand,
  createToolResultKeyLostCommand,
  createToolResultKeyRestoreCommand,
  createToolResultKeyRetirementCommand,
  createToolResultKeyRotationCommand,
  findToolResultKeyCatalogEntry,
  normalizeToolResultKeyCatalogCommand,
  normalizeToolResultKeyCatalogRecord,
  requireActiveToolResultKey,
  requireDecryptableToolResultKey,
  toolResultKeyMaterialProof,
} = require('../dist/tool-execution/toolResultKeyCatalog.js');

function committed(command, committedAtMs = 1_000) {
  return normalizeToolResultKeyCatalogRecord({
    ...command.next,
    committedAtMs,
  });
}

function bootstrap() {
  const key = Buffer.alloc(32, 1);
  const proof = toolResultKeyMaterialProof('result-key-001', key);
  const command = createToolResultKeyCatalogBootstrapCommand({
    keyId: 'result-key-001',
    materialProof: proof,
    mutationId: 'result-key-bootstrap-001',
  });
  return { key, proof, command, catalog: committed(command) };
}

test('bootstraps one digest-bound active result key without retaining material', () => {
  const value = bootstrap();

  assert.equal(value.command.next.schema, TOOL_RESULT_KEY_CATALOG_SCHEMA);
  assert.equal(value.command.expectedGeneration, 0);
  assert.equal(value.command.expectedCatalogDigest, null);
  assert.equal(value.catalog.generation, 1);
  assert.equal(value.catalog.activeKeyId, 'result-key-001');
  assert.equal(
    requireActiveToolResultKey(value.catalog).materialProof,
    value.proof,
  );
  assert.equal(
    value.key.every((byte) => byte === 1),
    true,
  );
  assert.match(value.proof, /^[0-9a-f]{64}$/);
  assert.notEqual(
    toolResultKeyMaterialProof('result-key-002', value.key),
    value.proof,
  );
  assert.equal(
    JSON.stringify(value.catalog).includes(value.key.toString('base64url')),
    false,
  );
});

test('rotates with exact generation fencing and preserves historical decryption', () => {
  const first = bootstrap();
  const secondKey = Buffer.alloc(32, 2);
  const rotation = createToolResultKeyRotationCommand(first.catalog, {
    keyId: 'result-key-002',
    materialProof: toolResultKeyMaterialProof('result-key-002', secondKey),
    mutationId: 'result-key-rotate-002',
  });
  const second = committed(rotation, 2_000);

  assert.equal(rotation.expectedGeneration, 1);
  assert.equal(rotation.expectedCatalogDigest, first.catalog.catalogDigest);
  assert.equal(second.generation, 2);
  assert.equal(second.activeKeyId, 'result-key-002');
  assert.equal(
    findToolResultKeyCatalogEntry(second, 'result-key-001').state,
    'decrypt_only',
  );
  assert.equal(requireActiveToolResultKey(second).keyId, 'result-key-002');
  assert.equal(
    requireDecryptableToolResultKey(second, 'result-key-001').keyId,
    'result-key-001',
  );
  assert.throws(
    () =>
      createToolResultKeyRotationCommand(second, {
        keyId: 'result-key-001',
        materialProof: first.proof,
        mutationId: 'result-key-reuse-003',
      }),
    TypeError,
  );
});

test('canonicalizes reverse-lexical key rotation before hashing', () => {
  const first = committed(
    createToolResultKeyCatalogBootstrapCommand({
      keyId: 'result-key-z',
      materialProof: toolResultKeyMaterialProof(
        'result-key-z',
        Buffer.alloc(32, 1),
      ),
      mutationId: 'result-key-bootstrap-z',
    }),
    1_000,
  );
  const rotated = createToolResultKeyRotationCommand(first, {
    keyId: 'result-key-a',
    materialProof: toolResultKeyMaterialProof(
      'result-key-a',
      Buffer.alloc(32, 2),
    ),
    mutationId: 'result-key-rotate-a',
  });
  assert.deepEqual(
    rotated.next.keys.map((entry) => entry.keyId),
    ['result-key-a', 'result-key-z'],
  );
});

test('requires a rekey receipt before retirement and prunes retired history later', () => {
  const first = bootstrap();
  const rotated = committed(
    createToolResultKeyRotationCommand(first.catalog, {
      keyId: 'result-key-002',
      materialProof: toolResultKeyMaterialProof(
        'result-key-002',
        Buffer.alloc(32, 2),
      ),
      mutationId: 'result-key-rotate-002',
    }),
  );
  assert.throws(
    () =>
      createToolResultKeyRetirementCommand(rotated, {
        keyId: 'result-key-002',
        retirementReceiptDigest: 'a'.repeat(64),
        mutationId: 'result-key-retire-active-003',
      }),
    TypeError,
  );

  const retirement = createToolResultKeyRetirementCommand(rotated, {
    keyId: 'result-key-001',
    retirementReceiptDigest: 'b'.repeat(64),
    mutationId: 'result-key-retire-003',
  });
  const retired = committed(retirement);
  assert.equal(
    findToolResultKeyCatalogEntry(retired, 'result-key-001').state,
    'retired',
  );
  assert.throws(
    () => requireDecryptableToolResultKey(retired, 'result-key-001'),
    ToolResultKeyCatalogUnavailableError,
  );

  const next = committed(
    createToolResultKeyRotationCommand(retired, {
      keyId: 'result-key-003',
      materialProof: toolResultKeyMaterialProof(
        'result-key-003',
        Buffer.alloc(32, 3),
      ),
      mutationId: 'result-key-rotate-004',
    }),
  );
  assert.equal(findToolResultKeyCatalogEntry(next, 'result-key-001'), null);
  assert.equal(
    findToolResultKeyCatalogEntry(next, 'result-key-002').state,
    'decrypt_only',
  );
});

test('marks missing material lost and restores only the exact proof', () => {
  const first = bootstrap();
  const lost = committed(
    createToolResultKeyLostCommand(first.catalog, {
      keyId: 'result-key-001',
      mutationId: 'result-key-lost-002',
    }),
  );
  assert.equal(lost.activeKeyId, null);
  assert.throws(
    () => requireActiveToolResultKey(lost),
    ToolResultKeyCatalogUnavailableError,
  );
  assert.throws(
    () => requireDecryptableToolResultKey(lost, 'result-key-001'),
    ToolResultKeyLostError,
  );
  assert.throws(
    () =>
      createToolResultKeyRestoreCommand(lost, {
        keyId: 'result-key-001',
        materialProof: 'c'.repeat(64),
        mutationId: 'result-key-bad-restore-003',
      }),
    TypeError,
  );

  const restored = committed(
    createToolResultKeyRestoreCommand(lost, {
      keyId: 'result-key-001',
      materialProof: first.proof,
      mutationId: 'result-key-restore-003',
    }),
  );
  assert.equal(restored.activeKeyId, null);
  assert.equal(
    findToolResultKeyCatalogEntry(restored, 'result-key-001').state,
    'decrypt_only',
  );
  assert.throws(
    () => requireActiveToolResultKey(restored),
    ToolResultKeyCatalogUnavailableError,
  );
});

test('rejects command drift and exposes authority only through its subpath', () => {
  const value = bootstrap();
  assert.throws(
    () =>
      normalizeToolResultKeyCatalogCommand({
        ...value.command,
        expectedGeneration: 1,
      }),
    TypeError,
  );

  const root = require('../dist');
  const authority = require('@qinglong/runtime-core/tool-result-key-catalog');
  assert.equal(root.createToolResultKeyCatalogBootstrapCommand, undefined);
  assert.equal(
    authority.createToolResultKeyCatalogBootstrapCommand,
    createToolResultKeyCatalogBootstrapCommand,
  );
});
