const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { test } = require('node:test');

const {
  InvalidPluginPackagePublisherTrustSnapshotError,
  createPluginPackagePublisherEffectiveTrustRegistry,
  createPluginPackagePublisherTrustOverlapAdditionSnapshot,
  createPluginPackagePublisherTrustRetirementSnapshot,
  createPluginPackagePublisherTrustSnapshot,
  normalizePluginPackagePublisherTrustSnapshot,
  pluginPackagePublisherTrustRevokedDigest,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust');

function definition(publisher, keyId) {
  const { publicKey } = generateKeyPairSync('ed25519');
  return {
    publisher,
    keyId,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    notBeforeMs: 1_000,
    notAfterMs: 10_000,
  };
}

test('creates a canonical low-sensitive snapshot from reviewed publisher keys', () => {
  const snapshot = createPluginPackagePublisherTrustSnapshot([
    definition('publisher-b.example', 'key-b'),
    definition('publisher-a.example', 'key-a'),
  ]);
  assert.deepEqual(
    snapshot.keys.map(({ publisher }) => publisher),
    ['publisher-a.example', 'publisher-b.example'],
  );
  assert.equal('publicKeyPem' in snapshot.keys[0], false);
  assert.match(snapshot.snapshotDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    normalizePluginPackagePublisherTrustSnapshot(snapshot),
    snapshot,
  );
});

test('binds mounted key material to the durable effective snapshot', () => {
  const established = definition('publisher-a.example', 'key-a');
  const candidate = definition('publisher-a.example', 'key-b');
  const effective = createPluginPackagePublisherTrustSnapshot([
    established,
  ]);
  const registry = createPluginPackagePublisherEffectiveTrustRegistry(
    [candidate, established],
    effective,
  );
  assert.equal(registry.size, 1);

  const replacementMaterial = definition(
    'publisher-a.example',
    'key-a',
  );
  assert.throws(
    () =>
      createPluginPackagePublisherEffectiveTrustRegistry(
        [replacementMaterial, candidate],
        effective,
      ),
    /not backed by mounted key material/,
  );
});

test('derives exact one-key overlap addition and same-publisher retirement', () => {
  const oldKey = definition('publisher-a.example', 'key-a');
  const newKey = definition('publisher-a.example', 'key-b');
  const unrelated = definition('publisher-b.example', 'key-c');
  const current = createPluginPackagePublisherTrustSnapshot([
    oldKey,
    unrelated,
  ]);
  const overlap = createPluginPackagePublisherTrustSnapshot([
    oldKey,
    newKey,
    unrelated,
  ]);
  assert.deepEqual(
    createPluginPackagePublisherTrustOverlapAdditionSnapshot(
      current,
      overlap,
      'publisher-a.example',
      'key-b',
      2_000,
    ),
    overlap,
  );
  const retired = createPluginPackagePublisherTrustRetirementSnapshot(
    overlap,
    'publisher-a.example',
    'key-a',
    2_000,
  );
  assert.deepEqual(
    retired.keys.map(({ keyId }) => keyId),
    ['key-b', 'key-c'],
  );
});

test('rejects rewritten overlap and retirement without a live successor', () => {
  const oldKey = definition('publisher-a.example', 'key-a');
  const newKey = definition('publisher-a.example', 'key-b');
  const current = createPluginPackagePublisherTrustSnapshot([oldKey]);
  assert.throws(
    () =>
      createPluginPackagePublisherTrustOverlapAdditionSnapshot(
        current,
        createPluginPackagePublisherTrustSnapshot([
          { ...oldKey, notAfterMs: 20_000 },
          newKey,
        ]),
        'publisher-a.example',
        'key-b',
        2_000,
      ),
    /must preserve every key/,
  );
  assert.throws(
    () =>
      createPluginPackagePublisherTrustRetirementSnapshot(
        createPluginPackagePublisherTrustSnapshot([
          oldKey,
          definition('publisher-b.example', 'key-c'),
        ]),
        'publisher-a.example',
        'key-a',
        2_000,
      ),
    /retain an active publisher key/,
  );
});

test('derives the effective trust digest only for a key in the snapshot', () => {
  const snapshot = createPluginPackagePublisherTrustSnapshot([
    definition('publisher-a.example', 'key-a'),
    definition('publisher-b.example', 'key-b'),
  ]);
  const revoked = pluginPackagePublisherTrustRevokedDigest(
    snapshot,
    'publisher-a.example',
    'key-a',
  );
  assert.match(revoked, /^[0-9a-f]{64}$/);
  assert.notEqual(revoked, snapshot.snapshotDigest);
  assert.throws(
    () =>
      pluginPackagePublisherTrustRevokedDigest(
        snapshot,
        'publisher-c.example',
        'key-c',
      ),
    InvalidPluginPackagePublisherTrustSnapshotError,
  );
});

test('rejects duplicate, non-Ed25519 and tampered trust snapshots', () => {
  const key = definition('publisher-a.example', 'key-a');
  assert.throws(
    () => createPluginPackagePublisherTrustSnapshot([key, key]),
    InvalidPluginPackagePublisherTrustSnapshotError,
  );
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  assert.throws(
    () =>
      createPluginPackagePublisherTrustSnapshot([
        {
          ...key,
          publicKeyPem: publicKey.export({
            type: 'spki',
            format: 'pem',
          }),
        },
      ]),
    InvalidPluginPackagePublisherTrustSnapshotError,
  );
  const snapshot = createPluginPackagePublisherTrustSnapshot([key]);
  assert.throws(
    () =>
      normalizePluginPackagePublisherTrustSnapshot({
        ...snapshot,
        snapshotDigest: '0'.repeat(64),
      }),
    InvalidPluginPackagePublisherTrustSnapshotError,
  );
});
