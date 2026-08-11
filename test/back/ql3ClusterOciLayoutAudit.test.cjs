'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  auditClusterOciLayout,
} = require('../../scripts/ql3-cluster-oci-layout-audit.cjs');
const {
  mergeNativeLayouts,
  nativeEvidenceRecord,
} = require('../../scripts/ql3-image-release-bundle.cjs');
const {
  createClusterImageSbom,
} = require('../../scripts/ql3-cluster-image-sbom.cjs');

const root = path.resolve(__dirname, '../..');
const revision = 'fixture-revision';

function createFixture(t, options = {}) {
  const image = options.image || 'control';
  const isControl = image === 'control' || image === 'control-ai';
  const isControlAi = image === 'control-ai';
  const isLocal = image === 'local';
  const layoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-oci-layout-'));
  t.after(() => fs.rmSync(layoutRoot, { recursive: true, force: true }));
  const blobDirectory = path.join(layoutRoot, 'blobs', 'sha256');
  fs.mkdirSync(blobDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(layoutRoot, 'oci-layout'),
    JSON.stringify({ imageLayoutVersion: '1.0.0' }),
  );

  function blob(value, mediaType) {
    const content = Buffer.isBuffer(value)
      ? value
      : Buffer.from(JSON.stringify(value));
    const digest = `sha256:${crypto
      .createHash('sha256')
      .update(content)
      .digest('hex')}`;
    fs.writeFileSync(
      path.join(blobDirectory, digest.slice('sha256:'.length)),
      content,
    );
    return { mediaType, digest, size: content.length };
  }

  const expectedComponents = createClusterImageSbom({
    root,
    image,
  }).components;
  const applicationPackages = expectedComponents.map((component) => ({
    name: component.name,
    versionInfo: component.version,
    sourceInfo: `acquired package info from installed node module manifest file: /opt/qinglong/node_modules/${component.name}/package.json`,
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: component.purl,
      },
    ],
  }));
  if (options.addDevelopmentPackage) {
    applicationPackages.push({
      name: '@types/node',
      versionInfo: '24.13.3',
      sourceInfo:
        'acquired package info from installed node module manifest file: /opt/qinglong/node_modules/@types/node/package.json',
      externalRefs: [
        {
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: 'pkg:npm/%40types/node@24.13.3',
        },
      ],
    });
  }

  const descriptors = [];
  const imageDescriptors = [];
  for (const architecture of options.onlyArchitecture
    ? [options.onlyArchitecture]
    : options.omitArm64
    ? ['amd64']
    : ['amd64', 'arm64']) {
    const config = blob(
      {
        architecture,
        os: 'linux',
        config: {
          User:
            options.rootArm64 && architecture === 'arm64'
              ? '0:0'
              : isLocal
              ? '65532:65532'
              : '10001:10001',
          ...(isControl ? { ExposedPorts: { '5800/tcp': {} } } : {}),
          Env: [
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'NODE_VERSION=24.18.0',
            'YARN_VERSION=1.22.22',
            'NODE_ENV=production',
          ],
          Entrypoint: [
            'node',
            isLocal
              ? '/opt/qinglong/node_modules/@qinglong/local-application/dist/cli.js'
              : isControl
              ? isControlAi
                ? '/opt/qinglong/node_modules/@qinglong/cluster-control/dist/aiCli.js'
                : '/opt/qinglong/node_modules/@qinglong/cluster-control/dist/cli.js'
              : '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/plugin-package/recovery/pluginPackageRecoveryCli.js',
          ],
          WorkingDir: '/opt/qinglong',
          Labels: {
            ...(isLocal
              ? {
                  'io.qinglong.ai': 'excluded',
                  'io.qinglong.local.application-config': '2',
                  'io.qinglong.local.compose-selection': '1',
                  'io.qinglong.local.sqlite-contract-max': '41',
                  'io.qinglong.local.sqlite-contract-min': '41',
                  'io.qinglong.local.sqlite-write-contract': '41',
                  'io.qinglong.profile': 'edge,standalone',
                }
              : {}),
            'org.opencontainers.image.description': isLocal
              ? 'QingLong 3.0 AI-excluded Edge and Standalone runtime'
              : isControl
              ? isControlAi
                ? 'Optional QingLong 3.0 AI-enabled cluster control plane'
                : 'QingLong 3.0 PostgreSQL-backed cluster control plane'
              : 'QingLong 3.0 short-lived cluster administration jobs',
            'org.opencontainers.image.licenses': 'Apache-2.0',
            'org.opencontainers.image.revision': revision,
            'org.opencontainers.image.source':
              'https://github.com/whyour/qinglong',
            'org.opencontainers.image.title': isLocal
              ? 'QingLong 3.0 Local Application'
              : isControl
              ? isControlAi
                ? 'QingLong 3.0 Cluster Control AI'
                : 'QingLong 3.0 Cluster Control'
              : 'QingLong 3.0 Cluster Admin',
            ...(isLocal
              ? {
                  'org.opencontainers.image.version': '3.0.0-alpha.0',
                }
              : {}),
          },
        },
        rootfs: {
          type: 'layers',
          diff_ids: [
            `sha256:${(architecture === 'amd64' ? 'a' : 'b').repeat(64)}`,
          ],
        },
      },
      'application/vnd.oci.image.config.v1+json',
    );
    const layer = blob(
      Buffer.from(`fixture-${architecture}`),
      'application/vnd.oci.image.layer.v1.tar+gzip',
    );
    const manifest = blob(
      {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config,
        layers: [layer],
      },
      'application/vnd.oci.image.manifest.v1+json',
    );
    const descriptor = {
      ...manifest,
      platform: { architecture, os: 'linux' },
    };
    imageDescriptors.push(descriptor);
    descriptors.push(descriptor);
  }

  for (const imageDescriptor of imageDescriptors) {
    const spdx = blob(
      {
        _type: 'https://in-toto.io/Statement/v1',
        subject: [],
        predicateType: 'https://spdx.dev/Document',
        predicate: {
          spdxVersion: 'SPDX-2.3',
          packages: applicationPackages,
        },
      },
      'application/vnd.in-toto+json',
    );
    spdx.annotations = {
      'in-toto.io/predicate-type': 'https://spdx.dev/Document',
    };
    const provenance = blob(
      {
        _type: 'https://in-toto.io/Statement/v1',
        subject: [],
        predicateType: 'https://slsa.dev/provenance/v1',
        predicate: {
          buildDefinition: {
            buildType:
              'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md',
            externalParameters: {
              request: {
                frontend: 'dockerfile.v0',
                args: {
                  'build-arg:SOURCE_REVISION': revision,
                },
              },
            },
          },
          runDetails: { builder: { id: '' } },
        },
      },
      'application/vnd.in-toto+json',
    );
    provenance.annotations = {
      'in-toto.io/predicate-type': 'https://slsa.dev/provenance/v1',
    };
    const attestationLayers = options.omitProvenance
      ? [spdx]
      : [spdx, provenance];
    const attestationConfig = blob(
      {
        architecture: 'unknown',
        os: 'unknown',
        config: {},
        rootfs: {
          type: 'layers',
          diff_ids: attestationLayers.map((layer) => layer.digest),
        },
      },
      'application/vnd.oci.image.config.v1+json',
    );
    const attestationManifest = blob(
      {
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: attestationConfig,
        layers: attestationLayers,
      },
      'application/vnd.oci.image.manifest.v1+json',
    );
    descriptors.push({
      ...attestationManifest,
      annotations: {
        'vnd.docker.reference.digest': options.unboundAttestation
          ? `sha256:${'f'.repeat(64)}`
          : imageDescriptor.digest,
        'vnd.docker.reference.type': 'attestation-manifest',
      },
      platform: { architecture: 'unknown', os: 'unknown' },
    });
  }

  if (!options.onlyArchitecture) {
    while (descriptors.length < 4) {
      descriptors.push({
        ...descriptors[descriptors.length - 1],
        digest: `sha256:${'0'.repeat(64)}`,
      });
    }
  }
  const imageIndex = blob(
    {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: descriptors,
    },
    'application/vnd.oci.image.index.v1+json',
  );
  fs.writeFileSync(
    path.join(layoutRoot, 'index.json'),
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [imageIndex],
    }),
  );
  return layoutRoot;
}

test('accepts two exact images with bound SBOM and provenance', (t) => {
  const report = auditClusterOciLayout({
    root,
    layoutRoot: createFixture(t),
    expectedRevision: revision,
  });
  assert.equal(report.platforms.length, 2);
  assert.deepEqual(
    report.platforms.map((entry) => entry.platform),
    ['linux/amd64', 'linux/arm64'],
  );
  assert.deepEqual(
    report.platforms.map((entry) => entry.spdxApplicationPackages),
    [46, 46],
  );
});

test('accepts the independent cluster-admin image and attestation closure', (t) => {
  const report = auditClusterOciLayout({
    root,
    layoutRoot: createFixture(t, { image: 'admin' }),
    expectedRevision: revision,
    image: 'admin',
  });
  assert.equal(report.image, 'admin');
  assert.deepEqual(
    report.platforms.map((entry) => entry.spdxApplicationPackages),
    [88, 88],
  );
});

test('accepts the optional Cluster AI image and attestation closure', (t) => {
  const report = auditClusterOciLayout({
    root,
    layoutRoot: createFixture(t, { image: 'control-ai' }),
    expectedRevision: revision,
    image: 'control-ai',
  });
  assert.equal(report.image, 'control-ai');
  assert.deepEqual(
    report.platforms.map((entry) => entry.spdxApplicationPackages),
    [47, 47],
  );
});

test('accepts the AI-excluded local image and attestation closure', (t) => {
  const report = auditClusterOciLayout({
    root,
    layoutRoot: createFixture(t, { image: 'local' }),
    expectedRevision: revision,
    image: 'local',
  });
  assert.equal(report.image, 'local');
  assert.equal(report.maximumPlatformBytes, 128 * 1024 * 1024);
  assert.deepEqual(
    report.platforms.map((entry) => entry.spdxApplicationPackages),
    [10, 10],
  );
});

test('rejects cluster-control config presented as cluster-admin evidence', (t) => {
  assert.throws(
    () =>
      auditClusterOciLayout({
        root,
        layoutRoot: createFixture(t),
        expectedRevision: revision,
        image: 'admin',
      }),
    /SPDX application closure differs|image config differs/,
  );
});

test('rejects an absent arm64 image', (t) => {
  assert.throws(
    () =>
      auditClusterOciLayout({
        root,
        layoutRoot: createFixture(t, { omitArm64: true }),
        expectedRevision: revision,
      }),
    /platform set/,
  );
});

test('rejects a root runtime config on either architecture', (t) => {
  assert.throws(
    () =>
      auditClusterOciLayout({
        root,
        layoutRoot: createFixture(t, { rootArm64: true }),
        expectedRevision: revision,
      }),
    /image config differs/,
  );
});

test('rejects an attestation that is not bound to its image digest', (t) => {
  assert.throws(
    () =>
      auditClusterOciLayout({
        root,
        layoutRoot: createFixture(t, { unboundAttestation: true }),
        expectedRevision: revision,
      }),
    /one bound attestation/,
  );
});

test('rejects an incomplete predicate set', (t) => {
  assert.throws(
    () =>
      auditClusterOciLayout({
        root,
        layoutRoot: createFixture(t, { omitProvenance: true }),
        expectedRevision: revision,
      }),
    /exactly SBOM and provenance/,
  );
});

test('rejects a development package in the image SBOM closure', (t) => {
  assert.throws(
    () =>
      auditClusterOciLayout({
        root,
        layoutRoot: createFixture(t, { addDevelopmentPackage: true }),
        expectedRevision: revision,
      }),
    /SPDX application closure differs/,
  );
});

test('accepts one native layout with one bound attestation', (t) => {
  const report = auditClusterOciLayout({
    root,
    layoutRoot: createFixture(t, { onlyArchitecture: 'arm64' }),
    expectedRevision: revision,
    expectedPlatforms: ['linux/arm64'],
  });
  assert.deepEqual(
    report.platforms.map((entry) => entry.platform),
    ['linux/arm64'],
  );
});

test('merges two scanned native layouts into the exact audited multiarch digest', (t) => {
  const amd64Layout = createFixture(t, { onlyArchitecture: 'amd64' });
  const arm64Layout = createFixture(t, { onlyArchitecture: 'arm64' });
  const outputParent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-release-bundle-')),
  );
  t.after(() => fs.rmSync(outputParent, { recursive: true, force: true }));
  const amd64Evidence = path.join(outputParent, 'amd64-evidence.json');
  const arm64Evidence = path.join(outputParent, 'arm64-evidence.json');
  fs.writeFileSync(
    amd64Evidence,
    JSON.stringify(
      nativeEvidenceRecord({
        root,
        layoutRoot: amd64Layout,
        expectedRevision: revision,
        image: 'control',
        platform: 'linux/amd64',
      }),
    ),
  );
  fs.writeFileSync(
    arm64Evidence,
    JSON.stringify(
      nativeEvidenceRecord({
        root,
        layoutRoot: arm64Layout,
        expectedRevision: revision,
        image: 'control',
        platform: 'linux/arm64',
      }),
    ),
  );
  const outputRoot = path.join(outputParent, 'merged');
  const predicatePath = path.join(outputParent, 'predicate.json');
  const reportPath = path.join(outputParent, 'report.json');
  const report = mergeNativeLayouts({
    root,
    image: 'control',
    expectedRevision: revision,
    amd64Layout,
    amd64Evidence,
    arm64Layout,
    arm64Evidence,
    outputRoot,
    predicatePath,
    reportPath,
  });
  assert.match(report.rootIndexDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    JSON.parse(fs.readFileSync(predicatePath, 'utf8')).subjectDigest,
    report.rootIndexDigest,
  );
  assert.equal(
    auditClusterOciLayout({
      root,
      layoutRoot: outputRoot,
      expectedRevision: revision,
      image: 'control',
    }).rootIndexDigest,
    report.rootIndexDigest,
  );
});

test('rejects native evidence that does not exactly describe its OCI layout', (t) => {
  const amd64Layout = createFixture(t, { onlyArchitecture: 'amd64' });
  const arm64Layout = createFixture(t, { onlyArchitecture: 'arm64' });
  const outputParent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-release-bundle-mismatch-')),
  );
  t.after(() => fs.rmSync(outputParent, { recursive: true, force: true }));
  const amd64Evidence = path.join(outputParent, 'amd64-evidence.json');
  const arm64Evidence = path.join(outputParent, 'arm64-evidence.json');
  const amd64Record = nativeEvidenceRecord({
    root,
    layoutRoot: amd64Layout,
    expectedRevision: revision,
    image: 'control',
    platform: 'linux/amd64',
  });
  fs.writeFileSync(
    amd64Evidence,
    JSON.stringify({ ...amd64Record, sourceRevision: 'different' }),
  );
  fs.writeFileSync(
    arm64Evidence,
    JSON.stringify(
      nativeEvidenceRecord({
        root,
        layoutRoot: arm64Layout,
        expectedRevision: revision,
        image: 'control',
        platform: 'linux/arm64',
      }),
    ),
  );
  assert.throws(
    () =>
      mergeNativeLayouts({
        root,
        image: 'control',
        expectedRevision: revision,
        amd64Layout,
        amd64Evidence,
        arm64Layout,
        arm64Evidence,
        outputRoot: path.join(outputParent, 'merged'),
        predicatePath: path.join(outputParent, 'predicate.json'),
        reportPath: path.join(outputParent, 'report.json'),
      }),
    /native vulnerability evidence differs for linux\/amd64/,
  );
});
