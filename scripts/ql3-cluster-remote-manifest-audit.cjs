#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OCI_INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const ATTESTATION_REFERENCE_DIGEST = 'vnd.docker.reference.digest';
const ATTESTATION_REFERENCE_TYPE = 'vnd.docker.reference.type';
const ATTESTATION_MANIFEST_TYPE = 'attestation-manifest';
const EXPECTED_PLATFORMS = Object.freeze(['linux/amd64', 'linux/arm64']);
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_DESCRIPTOR_BYTES = 64 * 1024 * 1024;

function readBoundedManifest(filePath) {
  const resolvedPath = path.resolve(filePath);
  const stat = fs.lstatSync(resolvedPath);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error(`invalid bounded remote manifest: ${resolvedPath}`);
  }

  const fd = fs.openSync(
    resolvedPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const openedStat = fs.fstatSync(fd);
    if (
      !openedStat.isFile() ||
      openedStat.size !== stat.size ||
      openedStat.size > MAX_MANIFEST_BYTES
    ) {
      throw new Error(`remote manifest changed while opening: ${resolvedPath}`);
    }
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeDescriptor(descriptor) {
  if (
    !descriptor ||
    descriptor.mediaType !== OCI_MANIFEST_MEDIA_TYPE ||
    !/^sha256:[0-9a-f]{64}$/.test(descriptor.digest || '') ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size < 1 ||
    descriptor.size > MAX_DESCRIPTOR_BYTES ||
    !descriptor.platform ||
    typeof descriptor.platform !== 'object'
  ) {
    throw new Error('invalid published OCI manifest descriptor');
  }
  return descriptor;
}

function normalizeExpectedReference(expectedImage, expectedDigest) {
  if (
    typeof expectedImage !== 'string' ||
    !/^ghcr\.io\/[a-z0-9](?:[a-z0-9._-]*\/)+[a-z0-9][a-z0-9._-]*$/.test(
      expectedImage,
    )
  ) {
    throw new Error(
      'expected image must be a fully qualified lowercase GHCR name',
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedDigest || '')) {
    throw new Error('expected image digest must be immutable SHA-256');
  }
  return `${expectedImage}@${expectedDigest}`;
}

function auditPublishedManifest(manifest, { expectedImage, expectedDigest }) {
  const reference = normalizeExpectedReference(expectedImage, expectedDigest);
  if (
    !manifest ||
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== OCI_INDEX_MEDIA_TYPE ||
    !Array.isArray(manifest.manifests) ||
    manifest.manifests.length !== 4
  ) {
    throw new Error(
      'published image must be one bounded OCI index with two images and two attestations',
    );
  }

  const descriptors = manifest.manifests.map(normalizeDescriptor);
  const digests = descriptors.map((descriptor) => descriptor.digest);
  if (new Set(digests).size !== digests.length) {
    throw new Error(
      'published OCI index contains duplicate descriptor digests',
    );
  }

  const images = new Map();
  const attestations = [];
  for (const descriptor of descriptors) {
    const { architecture, os } = descriptor.platform;
    const platform = `${os}/${architecture}`;
    if (platform === 'unknown/unknown') {
      attestations.push(descriptor);
      continue;
    }
    if (
      !EXPECTED_PLATFORMS.includes(platform) ||
      Object.keys(descriptor.platform).some(
        (key) => !['architecture', 'os'].includes(key),
      ) ||
      images.has(platform)
    ) {
      throw new Error(`unexpected published runnable platform: ${platform}`);
    }
    images.set(platform, descriptor);
  }

  if (
    images.size !== EXPECTED_PLATFORMS.length ||
    EXPECTED_PLATFORMS.some((platform) => !images.has(platform)) ||
    attestations.length !== EXPECTED_PLATFORMS.length
  ) {
    throw new Error(
      'published OCI index must contain exactly amd64/arm64 and one attestation per image',
    );
  }

  const imageDigests = new Set(
    [...images.values()].map((descriptor) => descriptor.digest),
  );
  const boundDigests = new Set();
  for (const descriptor of attestations) {
    if (
      Object.keys(descriptor.platform).some(
        (key) => !['architecture', 'os'].includes(key),
      ) ||
      descriptor.annotations?.[ATTESTATION_REFERENCE_TYPE] !==
        ATTESTATION_MANIFEST_TYPE
    ) {
      throw new Error('published OCI attestation descriptor is malformed');
    }
    const boundDigest = descriptor.annotations?.[ATTESTATION_REFERENCE_DIGEST];
    if (!imageDigests.has(boundDigest) || boundDigests.has(boundDigest)) {
      throw new Error(
        'published OCI attestation is not bound one-to-one to an image manifest',
      );
    }
    boundDigests.add(boundDigest);
  }

  return {
    reference,
    platforms: EXPECTED_PLATFORMS.map((platform) => ({
      platform,
      digest: images.get(platform).digest,
    })),
    attestationBindings: [...boundDigests].sort(),
  };
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument.startsWith('--manifest=')) {
      options.manifestPath = argument.slice('--manifest='.length);
    } else if (argument.startsWith('--expected-image=')) {
      options.expectedImage = argument.slice('--expected-image='.length);
    } else if (argument.startsWith('--expected-digest=')) {
      options.expectedDigest = argument.slice('--expected-digest='.length);
    } else {
      throw new Error(
        `unsupported remote manifest audit argument: ${argument}`,
      );
    }
  }
  if (
    !options.manifestPath ||
    !options.expectedImage ||
    !options.expectedDigest
  ) {
    throw new Error(
      'remote manifest audit requires --manifest, --expected-image and --expected-digest',
    );
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = auditPublishedManifest(
    readBoundedManifest(options.manifestPath),
    options,
  );
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
  auditPublishedManifest,
  readBoundedManifest,
};
