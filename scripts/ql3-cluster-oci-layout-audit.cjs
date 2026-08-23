#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  createClusterImageSbom,
  resolveImageProfile,
} = require('./ql3-cluster-image-sbom.cjs');
const { readReleaseIdentity } = require('./lib/ql3-release-identity.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const QL3_VERSION = readReleaseIdentity(DEFAULT_ROOT).version;
const OCI_INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG_MEDIA_TYPE = 'application/vnd.oci.image.config.v1+json';
const OCI_EMPTY_CONFIG_MEDIA_TYPE = 'application/vnd.oci.empty.v1+json';
const OCI_LAYER_MEDIA_TYPE = 'application/vnd.oci.image.layer.v1.tar+gzip';
const IN_TOTO_MEDIA_TYPE = 'application/vnd.in-toto+json';
const SPDX_PREDICATE_TYPE = 'https://spdx.dev/Document';
const SLSA_PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
const EXPECTED_PLATFORMS = Object.freeze(['linux/amd64', 'linux/arm64']);
const MAX_BLOBS = 128;
const MAX_TOTAL_BLOB_BYTES = 1024 * 1024 * 1024;
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_ATTESTATION_BYTES = 16 * 1024 * 1024;
const MAX_LAYER_BYTES = 256 * 1024 * 1024;

function readBoundedJson(filePath, maximumBytes) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.size < 2 || stat.size > maximumBytes) {
    throw new Error(`invalid bounded JSON file: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory()) {
    throw new Error(`OCI path must be a directory: ${directory}`);
  }
}

function normalizeDescriptor(descriptor, expectedMediaType, maximumBytes) {
  if (
    !descriptor ||
    descriptor.mediaType !== expectedMediaType ||
    !/^sha256:[0-9a-f]{64}$/.test(descriptor.digest || '') ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size < 1 ||
    descriptor.size > maximumBytes
  ) {
    throw new Error(`invalid OCI descriptor for ${expectedMediaType}`);
  }
  return descriptor;
}

function createBlobReader(layoutRoot) {
  const blobDirectory = path.join(layoutRoot, 'blobs', 'sha256');
  assertDirectory(blobDirectory);
  const verified = new Map();
  let totalBytes = 0;

  function read(descriptor, maximumBytes, collect = true) {
    const existing = verified.get(descriptor.digest);
    if (existing) {
      if (existing.size !== descriptor.size) {
        throw new Error(`OCI descriptor size drift: ${descriptor.digest}`);
      }
      if (collect && !existing.content) {
        throw new Error(`OCI blob was not retained: ${descriptor.digest}`);
      }
      return existing.content;
    }
    if (verified.size >= MAX_BLOBS) {
      throw new Error('OCI layout exceeds the bounded blob count');
    }

    const digestHex = descriptor.digest.slice('sha256:'.length);
    const filePath = path.join(blobDirectory, digestHex);
    const descriptorStat = fs.lstatSync(filePath);
    if (
      !descriptorStat.isFile() ||
      descriptorStat.size !== descriptor.size ||
      descriptorStat.size > maximumBytes
    ) {
      throw new Error(`OCI blob size or type mismatch: ${descriptor.digest}`);
    }

    totalBytes += descriptorStat.size;
    if (totalBytes > MAX_TOTAL_BLOB_BYTES) {
      throw new Error('OCI layout exceeds the bounded total blob size');
    }

    const fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    const hash = crypto.createHash('sha256');
    const chunks = collect ? [] : undefined;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    try {
      const openedStat = fs.fstatSync(fd);
      if (!openedStat.isFile() || openedStat.size !== descriptor.size) {
        throw new Error(`OCI blob changed while opening: ${descriptor.digest}`);
      }
      while (offset < openedStat.size) {
        const bytesRead = fs.readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, openedStat.size - offset),
          offset,
        );
        if (bytesRead < 1) {
          throw new Error(`OCI blob ended early: ${descriptor.digest}`);
        }
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (chunks) {
          chunks.push(Buffer.from(chunk));
        }
        offset += bytesRead;
      }
    } finally {
      fs.closeSync(fd);
    }

    if (hash.digest('hex') !== digestHex) {
      throw new Error(`OCI blob digest mismatch: ${descriptor.digest}`);
    }
    const content = chunks ? Buffer.concat(chunks) : undefined;
    verified.set(descriptor.digest, {
      size: descriptor.size,
      content,
    });
    return content;
  }

  function readJson(descriptor, expectedMediaType, maximumBytes) {
    normalizeDescriptor(descriptor, expectedMediaType, maximumBytes);
    const content = read(descriptor, maximumBytes, true);
    return JSON.parse(content.toString('utf8'));
  }

  function verifyNoUnreferencedBlobs() {
    const actual = fs
      .readdirSync(blobDirectory, { withFileTypes: true })
      .map((entry) => {
        if (!entry.isFile() || !/^[0-9a-f]{64}$/.test(entry.name)) {
          throw new Error(`invalid OCI blob entry: ${entry.name}`);
        }
        return `sha256:${entry.name}`;
      })
      .sort();
    const expected = [...verified.keys()].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('OCI layout contains missing or unreferenced blobs');
    }
  }

  return {
    read,
    readJson,
    report: () => ({ blobs: verified.size, totalBytes }),
    verifyNoUnreferencedBlobs,
  };
}

function expectedImageConfig(architecture, revision, image) {
  if (image === 'worker') {
    return {
      architecture,
      os: 'linux',
      config: {
        User: '65532:65532',
        Env: [
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          'NODE_VERSION=24.18.0',
          'YARN_VERSION=1.22.22',
          'NODE_ENV=production',
        ],
        Entrypoint: [
          'node',
          '/opt/qinglong/node_modules/@qinglong/worker-runtime/dist/process/workerProcessCli.js',
        ],
        WorkingDir: '/opt/qinglong',
        Labels: {
          'io.qinglong.profile': 'worker',
          'io.qinglong.worker.capacity-profiles': 'edge,node',
          'org.opencontainers.image.description':
            'QingLong 3.0 headless Remote Worker runtime',
          'org.opencontainers.image.licenses': 'Apache-2.0',
          'org.opencontainers.image.revision': revision,
          'org.opencontainers.image.source':
            'https://github.com/whyour/qinglong',
          'org.opencontainers.image.title': 'QingLong 3.0 Worker',
          'org.opencontainers.image.version': QL3_VERSION,
        },
      },
    };
  }
  if (image === 'local') {
    return {
      architecture,
      os: 'linux',
      config: {
        User: '65532:65532',
        Env: [
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          'NODE_VERSION=24.18.0',
          'YARN_VERSION=1.22.22',
          'NODE_ENV=production',
        ],
        Entrypoint: [
          'node',
          '/opt/qinglong/node_modules/@qinglong/local-application/dist/cli.js',
        ],
        WorkingDir: '/opt/qinglong',
        Labels: {
          'io.qinglong.ai': 'excluded',
          'io.qinglong.local.application-config': '2,3,4',
          'io.qinglong.local.compose-selection': '1',
          'io.qinglong.local.sqlite-contract-max': '51',
          'io.qinglong.local.sqlite-contract-min': '51',
          'io.qinglong.local.sqlite-write-contract': '51',
          'io.qinglong.profile': 'edge,standalone',
          'org.opencontainers.image.description':
            'QingLong 3.0 AI-excluded Edge and Standalone runtime',
          'org.opencontainers.image.licenses': 'Apache-2.0',
          'org.opencontainers.image.revision': revision,
          'org.opencontainers.image.source':
            'https://github.com/whyour/qinglong',
          'org.opencontainers.image.title': 'QingLong 3.0 Local Application',
          'org.opencontainers.image.version': QL3_VERSION,
        },
      },
    };
  }
  const isControl = image === 'control' || image === 'control-ai';
  const isControlAi = image === 'control-ai';
  return {
    architecture,
    os: 'linux',
    config: {
      User: '10001:10001',
      ...(isControl
        ? {
            ExposedPorts: {
              '5800/tcp': {},
            },
          }
        : {}),
      Env: [
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'NODE_VERSION=24.18.0',
        'YARN_VERSION=1.22.22',
        'NODE_ENV=production',
      ],
      Entrypoint: [
        'node',
        isControl
          ? isControlAi
            ? '/opt/qinglong/node_modules/@qinglong/cluster-control/dist/aiCli.js'
            : '/opt/qinglong/node_modules/@qinglong/cluster-control/dist/cli.js'
          : '/opt/qinglong/node_modules/@qinglong/cluster-admin/dist/product-cli/cli.js',
      ],
      WorkingDir: '/opt/qinglong',
      Labels: {
        'org.opencontainers.image.description': isControl
          ? isControlAi
            ? 'Optional QingLong 3.0 AI-enabled cluster control plane'
            : 'QingLong 3.0 PostgreSQL-backed cluster control plane'
          : 'QingLong 3.0 cluster operations and bounded Copilot surfaces',
        'org.opencontainers.image.licenses': 'Apache-2.0',
        'org.opencontainers.image.revision': revision,
        'org.opencontainers.image.source': 'https://github.com/whyour/qinglong',
        'org.opencontainers.image.title': isControl
          ? isControlAi
            ? 'QingLong 3.0 Cluster Control AI'
            : 'QingLong 3.0 Cluster Control'
          : 'QingLong 3.0 Cluster Admin',
        'org.opencontainers.image.version': QL3_VERSION,
      },
    },
  };
}

function assertImageConfig(config, platform, revision, image) {
  const expected = expectedImageConfig(platform.architecture, revision, image);
  if (
    config.architecture !== expected.architecture ||
    config.os !== expected.os ||
    JSON.stringify(config.config) !== JSON.stringify(expected.config)
  ) {
    throw new Error(
      `OCI image config differs for ${platform.os}/${platform.architecture}`,
    );
  }
  if (
    !Array.isArray(config.rootfs?.diff_ids) ||
    config.rootfs.diff_ids.length < 1 ||
    config.rootfs.diff_ids.length > 32 ||
    config.rootfs.diff_ids.some(
      (digest) => !/^sha256:[0-9a-f]{64}$/.test(digest),
    )
  ) {
    throw new Error(
      `OCI rootfs diff IDs are invalid for ${platform.architecture}`,
    );
  }
}

function applicationPackageRefs(statement) {
  if (
    statement?._type !== 'https://in-toto.io/Statement/v1' ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 0 ||
    statement.predicateType !== SPDX_PREDICATE_TYPE ||
    statement.predicate?.spdxVersion !== 'SPDX-2.3' ||
    !Array.isArray(statement.predicate.packages)
  ) {
    throw new Error('invalid BuildKit SPDX attestation statement');
  }
  const refs = [];
  for (const packageRecord of statement.predicate.packages) {
    if (
      typeof packageRecord.sourceInfo !== 'string' ||
      !packageRecord.sourceInfo.includes('/opt/qinglong/node_modules/')
    ) {
      continue;
    }
    const purls = (packageRecord.externalRefs || [])
      .filter((reference) => reference.referenceType === 'purl')
      .map((reference) => reference.referenceLocator);
    if (purls.length !== 1 || !purls[0].startsWith('pkg:npm/')) {
      throw new Error(
        `application SPDX package has no unique npm purl: ${packageRecord.name}`,
      );
    }
    refs.push(purls[0]);
  }
  refs.sort();
  if (new Set(refs).size !== refs.length) {
    throw new Error('application SPDX package purls must be unique');
  }
  return refs;
}

function inspectBuildArguments(value, findings = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      inspectBuildArguments(entry, findings);
    }
    return findings;
  }
  if (!value || typeof value !== 'object') {
    return findings;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('build-arg:')) {
      findings.push([key.slice('build-arg:'.length), child]);
    }
    inspectBuildArguments(child, findings);
  }
  return findings;
}

function assertProvenance(statement, expectedRevision) {
  if (
    statement?._type !== 'https://in-toto.io/Statement/v1' ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 0 ||
    statement.predicateType !== SLSA_PREDICATE_TYPE ||
    statement.predicate?.buildDefinition?.buildType !==
      'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md' ||
    statement.predicate.buildDefinition.externalParameters?.request
      ?.frontend !== 'dockerfile.v0' ||
    typeof statement.predicate.runDetails?.builder?.id !== 'string'
  ) {
    throw new Error('invalid BuildKit SLSA provenance statement');
  }

  const buildArguments = inspectBuildArguments(statement);
  const revisionArguments = buildArguments.filter(
    ([name]) => name === 'SOURCE_REVISION',
  );
  if (
    revisionArguments.length < 1 ||
    revisionArguments.some(([, value]) => value !== expectedRevision)
  ) {
    throw new Error(
      'SLSA provenance does not bind the expected source revision',
    );
  }
  for (const [name, value] of buildArguments) {
    if (
      !['SOURCE_REVISION', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].includes(
        name,
      )
    ) {
      throw new Error(`unexpected provenance build argument: ${name}`);
    }
    if (
      /(?:secret|token|password|credential|private.?key)/i.test(name) ||
      typeof value !== 'string'
    ) {
      throw new Error(`unsafe provenance build argument: ${name}`);
    }
    if (['HTTP_PROXY', 'HTTPS_PROXY'].includes(name) && value) {
      const proxy = new URL(value);
      if (proxy.username || proxy.password || proxy.search || proxy.hash) {
        throw new Error(
          `credential-bearing proxy leaked into provenance: ${name}`,
        );
      }
    } else if (name === 'NO_PROXY' && /[@\u0000-\u001f\u007f]/.test(value)) {
      throw new Error('unsafe NO_PROXY value leaked into provenance');
    }
  }
}

function auditAttestation(
  descriptor,
  imageDescriptor,
  blobReader,
  expectedApplicationRefs,
  expectedRevision,
) {
  if (
    descriptor.platform?.os !== 'unknown' ||
    descriptor.platform?.architecture !== 'unknown' ||
    descriptor.annotations?.['vnd.docker.reference.type'] !==
      'attestation-manifest' ||
    descriptor.annotations?.['vnd.docker.reference.digest'] !==
      imageDescriptor.digest
  ) {
    throw new Error(
      `OCI attestation is not bound to ${imageDescriptor.digest}`,
    );
  }
  const manifest = blobReader.readJson(
    descriptor,
    OCI_MANIFEST_MEDIA_TYPE,
    MAX_INDEX_BYTES,
  );
  if (manifest.config?.mediaType === OCI_EMPTY_CONFIG_MEDIA_TYPE) {
    normalizeDescriptor(
      manifest.config,
      OCI_EMPTY_CONFIG_MEDIA_TYPE,
      MAX_CONFIG_BYTES,
    );
    const emptyConfig = blobReader.read(
      manifest.config,
      MAX_CONFIG_BYTES,
      true,
    );
    if (emptyConfig.toString('utf8') !== '{}') {
      throw new Error('OCI attestation empty config must be canonical');
    }
  } else {
    const config = blobReader.readJson(
      manifest.config,
      OCI_CONFIG_MEDIA_TYPE,
      MAX_CONFIG_BYTES,
    );
    if (
      config.architecture !== 'unknown' ||
      config.os !== 'unknown' ||
      JSON.stringify(config.config) !== JSON.stringify({}) ||
      !Array.isArray(config.rootfs?.diff_ids) ||
      !Array.isArray(manifest.layers) ||
      JSON.stringify(config.rootfs.diff_ids) !==
        JSON.stringify(manifest.layers.map((layer) => layer.digest))
    ) {
      throw new Error(
        'OCI attestation config must bind an empty unknown platform',
      );
    }
  }
  if (!Array.isArray(manifest.layers) || manifest.layers.length !== 2) {
    throw new Error('OCI attestation must contain exactly SBOM and provenance');
  }

  const statements = new Map();
  for (const layer of manifest.layers) {
    normalizeDescriptor(layer, IN_TOTO_MEDIA_TYPE, MAX_ATTESTATION_BYTES);
    const predicateType = layer.annotations?.['in-toto.io/predicate-type'];
    if (
      ![SPDX_PREDICATE_TYPE, SLSA_PREDICATE_TYPE].includes(predicateType) ||
      statements.has(predicateType)
    ) {
      throw new Error('OCI attestation predicate set is invalid');
    }
    statements.set(
      predicateType,
      JSON.parse(
        blobReader.read(layer, MAX_ATTESTATION_BYTES, true).toString('utf8'),
      ),
    );
  }

  const actualApplicationRefs = applicationPackageRefs(
    statements.get(SPDX_PREDICATE_TYPE),
  );
  if (
    JSON.stringify(actualApplicationRefs) !==
    JSON.stringify(expectedApplicationRefs)
  ) {
    throw new Error(
      `BuildKit SPDX application closure differs for ${imageDescriptor.digest}`,
    );
  }
  assertProvenance(statements.get(SLSA_PREDICATE_TYPE), expectedRevision);
  return {
    spdxApplicationPackages: actualApplicationRefs.length,
    predicates: [...statements.keys()].sort(),
  };
}

function auditClusterOciLayout(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const layoutRoot = path.resolve(options.layoutRoot || '');
  const expectedRevision = options.expectedRevision;
  const image = resolveImageProfile(options.image).id;
  const expectedPlatforms = options.expectedPlatforms || EXPECTED_PLATFORMS;
  const maximumPlatformBytes =
    image === 'local' ? 128 * 1024 * 1024 : 512 * 1024 * 1024;
  if (
    !path.isAbsolute(layoutRoot) ||
    typeof expectedRevision !== 'string' ||
    !/^[0-9A-Za-z._-]{1,128}$/.test(expectedRevision) ||
    !Array.isArray(expectedPlatforms) ||
    ![1, 2].includes(expectedPlatforms.length) ||
    expectedPlatforms.some(
      (platform) => !EXPECTED_PLATFORMS.includes(platform),
    ) ||
    new Set(expectedPlatforms).size !== expectedPlatforms.length
  ) {
    throw new Error(
      'absolute layout root, bounded revision and reviewed platforms are required',
    );
  }
  const reviewedPlatforms = [...expectedPlatforms].sort();
  assertDirectory(layoutRoot);
  const layout = readBoundedJson(
    path.join(layoutRoot, 'oci-layout'),
    MAX_CONFIG_BYTES,
  );
  if (
    JSON.stringify(layout) !== JSON.stringify({ imageLayoutVersion: '1.0.0' })
  ) {
    throw new Error('OCI layout version must be exactly 1.0.0');
  }

  const blobReader = createBlobReader(layoutRoot);
  const outerIndex = readBoundedJson(
    path.join(layoutRoot, 'index.json'),
    MAX_INDEX_BYTES,
  );
  if (
    outerIndex.schemaVersion !== 2 ||
    outerIndex.mediaType !== OCI_INDEX_MEDIA_TYPE ||
    !Array.isArray(outerIndex.manifests) ||
    outerIndex.manifests.length !== 1
  ) {
    throw new Error('OCI layout must contain one root image index');
  }
  const rootDescriptor = normalizeDescriptor(
    outerIndex.manifests[0],
    OCI_INDEX_MEDIA_TYPE,
    MAX_INDEX_BYTES,
  );
  const imageIndex = blobReader.readJson(
    rootDescriptor,
    OCI_INDEX_MEDIA_TYPE,
    MAX_INDEX_BYTES,
  );
  if (
    imageIndex.schemaVersion !== 2 ||
    imageIndex.mediaType !== OCI_INDEX_MEDIA_TYPE ||
    !Array.isArray(imageIndex.manifests) ||
    imageIndex.manifests.length !== reviewedPlatforms.length * 2
  ) {
    throw new Error(
      'OCI image index must contain one image and one attestation per reviewed platform',
    );
  }

  const imageDescriptors = imageIndex.manifests.filter(
    (descriptor) =>
      descriptor.platform?.os === 'linux' &&
      ['amd64', 'arm64'].includes(descriptor.platform?.architecture),
  );
  const attestationDescriptors = imageIndex.manifests.filter(
    (descriptor) =>
      descriptor.platform?.os === 'unknown' &&
      descriptor.platform?.architecture === 'unknown',
  );
  const platforms = imageDescriptors
    .map(
      (descriptor) =>
        `${descriptor.platform.os}/${descriptor.platform.architecture}`,
    )
    .sort();
  if (
    JSON.stringify(platforms) !== JSON.stringify(reviewedPlatforms) ||
    attestationDescriptors.length !== reviewedPlatforms.length
  ) {
    throw new Error(
      `OCI image index platform set must be ${reviewedPlatforms.join(' and ')}`,
    );
  }

  const expectedApplicationRefs = createClusterImageSbom({
    root,
    image,
  })
    .components.map((component) => component.purl)
    .sort();
  const platformReports = [];
  for (const imageDescriptor of imageDescriptors) {
    const manifest = blobReader.readJson(
      imageDescriptor,
      OCI_MANIFEST_MEDIA_TYPE,
      MAX_INDEX_BYTES,
    );
    if (
      manifest.schemaVersion !== 2 ||
      manifest.mediaType !== OCI_MANIFEST_MEDIA_TYPE ||
      !Array.isArray(manifest.layers) ||
      manifest.layers.length < 1 ||
      manifest.layers.length > 32
    ) {
      throw new Error(`invalid OCI image manifest: ${imageDescriptor.digest}`);
    }
    const config = blobReader.readJson(
      manifest.config,
      OCI_CONFIG_MEDIA_TYPE,
      MAX_CONFIG_BYTES,
    );
    assertImageConfig(
      config,
      imageDescriptor.platform,
      expectedRevision,
      image,
    );
    let compressedBytes = 0;
    for (const layer of manifest.layers) {
      normalizeDescriptor(layer, OCI_LAYER_MEDIA_TYPE, MAX_LAYER_BYTES);
      blobReader.read(layer, MAX_LAYER_BYTES, false);
      compressedBytes += layer.size;
      if (compressedBytes > maximumPlatformBytes) {
        throw new Error(
          `OCI platform layers exceed the bounded size: ${imageDescriptor.digest}`,
        );
      }
    }

    const matchingAttestations = attestationDescriptors.filter(
      (descriptor) =>
        descriptor.annotations?.['vnd.docker.reference.digest'] ===
        imageDescriptor.digest,
    );
    if (matchingAttestations.length !== 1) {
      throw new Error(
        `OCI image must have one bound attestation: ${imageDescriptor.digest}`,
      );
    }
    const attestation = auditAttestation(
      matchingAttestations[0],
      imageDescriptor,
      blobReader,
      expectedApplicationRefs,
      expectedRevision,
    );
    platformReports.push({
      platform: `${imageDescriptor.platform.os}/${imageDescriptor.platform.architecture}`,
      manifestDigest: imageDescriptor.digest,
      configDigest: manifest.config.digest,
      compressedLayerBytes: compressedBytes,
      ...attestation,
    });
  }

  blobReader.verifyNoUnreferencedBlobs();
  const blobReport = blobReader.report();
  return {
    image,
    rootIndexDigest: rootDescriptor.digest,
    platforms: platformReports.sort((left, right) =>
      left.platform.localeCompare(right.platform, 'en'),
    ),
    blobs: blobReport.blobs,
    totalBlobBytes: blobReport.totalBytes,
    maximumPlatformBytes,
  };
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument.startsWith('--layout=')) {
      options.layoutRoot = path.resolve(argument.slice('--layout='.length));
    } else if (argument.startsWith('--expected-revision=')) {
      options.expectedRevision = argument.slice('--expected-revision='.length);
    } else if (argument.startsWith('--root=')) {
      options.root = path.resolve(argument.slice('--root='.length));
    } else if (argument.startsWith('--image=')) {
      options.image = argument.slice('--image='.length);
    } else if (argument.startsWith('--platform=')) {
      options.expectedPlatforms = [argument.slice('--platform='.length)];
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  const report = auditClusterOciLayout(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ ok: true, ...report })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  auditClusterOciLayout,
};
