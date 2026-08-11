'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  auditPublishedManifest,
} = require('../../scripts/ql3-cluster-remote-manifest-audit.cjs');

const image = 'ghcr.io/whyour/qinglong3-cluster-control';
const digest = `sha256:${'f'.repeat(64)}`;
const descriptorDigest = (character) => `sha256:${character.repeat(64)}`;

function createManifest() {
  const amd64Digest = descriptorDigest('a');
  const arm64Digest = descriptorDigest('b');
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: amd64Digest,
        size: 2048,
        platform: {
          architecture: 'amd64',
          os: 'linux',
        },
      },
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: descriptorDigest('c'),
        size: 1024,
        annotations: {
          'vnd.docker.reference.digest': amd64Digest,
          'vnd.docker.reference.type': 'attestation-manifest',
        },
        platform: {
          architecture: 'unknown',
          os: 'unknown',
        },
      },
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: arm64Digest,
        size: 2048,
        platform: {
          architecture: 'arm64',
          os: 'linux',
        },
      },
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: descriptorDigest('d'),
        size: 1024,
        annotations: {
          'vnd.docker.reference.digest': arm64Digest,
          'vnd.docker.reference.type': 'attestation-manifest',
        },
        platform: {
          architecture: 'unknown',
          os: 'unknown',
        },
      },
    ],
  };
}

test('accepts the exact published dual-architecture manifest contract', () => {
  assert.deepEqual(
    auditPublishedManifest(createManifest(), {
      expectedImage: image,
      expectedDigest: digest,
    }),
    {
      reference: `${image}@${digest}`,
      platforms: [
        {
          platform: 'linux/amd64',
          digest: descriptorDigest('a'),
        },
        {
          platform: 'linux/arm64',
          digest: descriptorDigest('b'),
        },
      ],
      attestationBindings: [descriptorDigest('a'), descriptorDigest('b')],
    },
  );
});

test('rejects a published manifest without arm64', () => {
  const manifest = createManifest();
  manifest.manifests[2].platform.architecture = 'amd64';
  assert.throws(
    () =>
      auditPublishedManifest(manifest, {
        expectedImage: image,
        expectedDigest: digest,
      }),
    /unexpected published runnable platform/,
  );
});

test('rejects an unreviewed runnable platform', () => {
  const manifest = createManifest();
  manifest.manifests[2].platform.architecture = 's390x';
  assert.throws(
    () =>
      auditPublishedManifest(manifest, {
        expectedImage: image,
        expectedDigest: digest,
      }),
    /unexpected published runnable platform/,
  );
});

test('rejects an attestation bound to the wrong image', () => {
  const manifest = createManifest();
  manifest.manifests[3].annotations['vnd.docker.reference.digest'] =
    descriptorDigest('a');
  assert.throws(
    () =>
      auditPublishedManifest(manifest, {
        expectedImage: image,
        expectedDigest: digest,
      }),
    /not bound one-to-one/,
  );
});

test('rejects a tag reference in place of an immutable digest', () => {
  assert.throws(
    () =>
      auditPublishedManifest(createManifest(), {
        expectedImage: image,
        expectedDigest: 'latest',
      }),
    /immutable SHA-256/,
  );
});
