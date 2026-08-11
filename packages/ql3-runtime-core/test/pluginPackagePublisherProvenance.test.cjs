const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  MAX_PLUGIN_PACKAGE_PUBLISHER_REVOCATION_IMPACT_ITEMS,
  InvalidPluginPackagePublisherProvenanceError,
  createPluginPackagePublisherProvenance,
  createPluginPackagePublisherRevocationImpact,
  createPluginPackagePublisherRevocationReceipt,
  normalizePluginPackagePublisherProvenance,
  normalizePluginPackagePublisherRevocationImpact,
  normalizePluginPackagePublisherRevocationReceipt,
} = require('@qinglong/runtime-core/plugin-package-publisher-provenance');

const digest = (value) => value.repeat(64);

function provenance(installationId = 'install-1') {
  return createPluginPackagePublisherProvenance({
    projectId: 'project-1',
    packageName: 'package-one',
    installationId,
    lockDigest: digest('1'),
    artifactDigest: digest('2'),
    manifestDigest: digest('3'),
    contentDigest: digest('4'),
    stageEvidenceDigest: digest('5'),
    signature: {
      publisher: 'packages.example.test',
      keyId: 'publisher-key-1',
      signatureDigest: digest('6'),
      keyNotBeforeMs: 1_000,
      keyNotAfterMs: 10_000,
      verifiedAtMs: 2_000,
    },
  });
}

function receipt() {
  return createPluginPackagePublisherRevocationReceipt({
    mutationId: 'revoke-publisher-key-1',
    publisher: 'packages.example.test',
    keyId: 'publisher-key-1',
    previousTrustDigest: digest('7'),
    currentTrustDigest: digest('8'),
    proposer: { type: 'user', id: 'owner-a' },
    confirmer: { type: 'user', id: 'owner-b' },
    authorizationMode: 'dual_control',
    reasonCode: 'confirmed_key_compromise',
    revokedAtMs: 3_000,
  });
}

test('binds immutable publisher evidence to one staged installation', () => {
  const value = provenance();
  assert.deepEqual(normalizePluginPackagePublisherProvenance(value), value);
  assert.equal(value.publisher, 'packages.example.test');
  assert.equal(value.keyId, 'publisher-key-1');
  assert.match(value.provenanceDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(value), true);
});

test('binds dual-control revocation to one immutable trust transition', () => {
  const value = receipt();
  assert.deepEqual(
    normalizePluginPackagePublisherRevocationReceipt(value),
    value,
  );
  assert.match(value.receiptDigest, /^[0-9a-f]{64}$/);
  assert.throws(
    () =>
      createPluginPackagePublisherRevocationReceipt({
        ...value,
        previousTrustDigest: value.currentTrustDigest,
        receiptDigest: undefined,
        schema: undefined,
      }),
    InvalidPluginPackagePublisherProvenanceError,
  );
});

test('sorts and bounds one stable revocation impact snapshot', () => {
  const revoked = receipt();
  const first = provenance('install-a');
  const second = {
    ...provenance('install-b'),
    projectId: 'project-2',
  };
  const impact = createPluginPackagePublisherRevocationImpact({
    revocationReceiptDigest: revoked.receiptDigest,
    items: [
      {
        projectId: second.projectId,
        packageName: second.packageName,
        installationId: second.installationId,
        lockDigest: second.lockDigest,
        provenanceDigest: second.provenanceDigest,
      },
      {
        projectId: first.projectId,
        packageName: first.packageName,
        installationId: first.installationId,
        lockDigest: first.lockDigest,
        provenanceDigest: first.provenanceDigest,
      },
    ],
    generatedAtMs: 3_001,
  });
  assert.deepEqual(
    impact.items.map(({ projectId }) => projectId),
    ['project-1', 'project-2'],
  );
  assert.deepEqual(
    normalizePluginPackagePublisherRevocationImpact(impact),
    impact,
  );
  assert.throws(
    () =>
      createPluginPackagePublisherRevocationImpact({
        revocationReceiptDigest: revoked.receiptDigest,
        items: new Array(
          MAX_PLUGIN_PACKAGE_PUBLISHER_REVOCATION_IMPACT_ITEMS + 1,
        ).fill(impact.items[0]),
        generatedAtMs: 3_001,
      }),
    InvalidPluginPackagePublisherProvenanceError,
  );
});
