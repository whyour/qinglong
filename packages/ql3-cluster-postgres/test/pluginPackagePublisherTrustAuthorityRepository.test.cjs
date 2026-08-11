const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { test } = require('node:test');

const {
  createPluginPackagePublisherTrustSnapshot,
} = require('@qinglong/runtime-core/plugin-package-publisher-trust');
const {
  PostgresPluginPackagePublisherTrustAuthorityRepository,
} = require('../dist/plugin-package/publisher/pluginPackagePublisherTrustAuthorityRepository');

function snapshot(publisher, keyId) {
  const { publicKey } = generateKeyPairSync('ed25519');
  return createPluginPackagePublisherTrustSnapshot([
    {
      publisher,
      keyId,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      notBeforeMs: 1,
      notAfterMs: 10_000,
    },
  ]);
}

function fixture() {
  const snapshots = new Map();
  let head = null;
  const queries = [];
  const query = async (text, values = []) => {
    queries.push({ text, values });
    if (
      text.includes(
        'INSERT INTO "ql3"."plugin_package_publisher_trust_snapshots"',
      )
    ) {
      snapshots.set(values[0], JSON.parse(values[4]));
      return { rows: [], rowCount: 1 };
    }
    if (
      text.includes(
        'FROM "ql3"."plugin_package_publisher_trust_heads" AS head',
      )
    ) {
      if (!head || head.authorityId !== values[0]) return { rows: [] };
      const effective = snapshots.get(head.effectiveTrustDigest);
      return {
        rows: [
          {
            headJson: head,
            headDigest: head.headDigest,
            snapshotJson: effective,
            snapshotDigest: effective.snapshotDigest,
          },
        ],
      };
    }
    if (
      text.includes(
        'INSERT INTO "ql3"."plugin_package_publisher_trust_heads"',
      )
    ) {
      if (head && head.authorityId === values[0]) {
        return { rows: [], rowCount: 0 };
      }
      head = JSON.parse(values[6]);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = {
    query,
    release() {},
  };
  const repository =
    new PostgresPluginPackagePublisherTrustAuthorityRepository({
      query,
      async connect() {
        return client;
      },
    });
  return { repository, queries, head: () => head };
}

test('observes one base snapshot and returns the durable effective head', async () => {
  const value = fixture();
  const base = snapshot('publisher-a.example', 'key-a');
  const created = await value.repository.observeSnapshot({
    authorityId: 'cluster',
    snapshot: base,
    observedBy: 'package-manager-1',
    observedAtMs: 100,
  });
  assert.equal(created.status, 'created');
  assert.equal(created.head.generation, 1);
  assert.equal(created.head.baseSnapshotDigest, base.snapshotDigest);
  assert.equal(
    created.head.effectiveTrustDigest,
    base.snapshotDigest,
  );

  const replay = await value.repository.observeSnapshot({
    authorityId: 'cluster',
    snapshot: base,
    observedBy: 'package-manager-2',
    observedAtMs: 200,
  });
  assert.equal(replay.status, 'existing');
  assert.deepEqual(
    await value.repository.findAuthority('cluster'),
    {
      head: value.head(),
      effectiveSnapshot: base,
    },
  );
  assert.equal(
    value.queries.filter(({ text }) =>
      text.includes(
        'INSERT INTO "ql3"."plugin_package_publisher_trust_heads"',
      ),
    ).length,
    2,
  );
});

test('observes changed material as a candidate without advancing the head', async () => {
  const value = fixture();
  const base = snapshot('publisher-a.example', 'key-a');
  await value.repository.observeSnapshot({
    authorityId: 'cluster',
    snapshot: base,
    observedBy: 'package-manager-1',
    observedAtMs: 100,
  });
  const candidate = snapshot('publisher-b.example', 'key-b');
  const observed = await value.repository.observeSnapshot({
    authorityId: 'cluster',
    snapshot: candidate,
    observedBy: 'package-manager-1',
    observedAtMs: 200,
  });
  assert.equal(observed.status, 'candidate');
  assert.equal(observed.head.generation, 1);
  assert.equal(observed.head.baseSnapshotDigest, base.snapshotDigest);
  assert.equal(observed.head.effectiveTrustDigest, base.snapshotDigest);
  assert.deepEqual(observed.effectiveSnapshot, base);
});
