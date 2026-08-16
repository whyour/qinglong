#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { auditPackageBoundaries } = require('./ql3-package-boundary-audit.cjs');
const {
  VERSION_PATTERN,
  readReleaseIdentity,
} = require('./lib/ql3-release-identity.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const SCHEMA = 'qinglong/release-candidate-contract@v1';
const PREDICATE_TYPE =
  'https://qinglong.dev/attestations/release-candidate-contract/v1';
const MAX_REPORT_BYTES = 1024 * 1024;
const RELEASE_SCOPES = Object.freeze(['all', 'cluster', 'local']);
const LOCAL_IMAGES = Object.freeze([
  Object.freeze({
    image: 'local',
    repository: 'qinglong3-local-application',
    dockerfile: 'deploy/containers/ql3-local-application/Dockerfile',
    target: 'runtime',
    runtime_root:
      'deploy/containers/ql3-local-application/runtime-dependencies',
  }),
]);
const CLUSTER_IMAGES = Object.freeze([
  Object.freeze({
    image: 'control',
    repository: 'qinglong3-cluster-control',
    dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
    target: 'runtime',
    runtime_root: 'deploy/containers/ql3-cluster-control/runtime-dependencies',
  }),
  Object.freeze({
    image: 'control-ai',
    repository: 'qinglong3-cluster-control-ai',
    dockerfile: 'deploy/containers/ql3-cluster-control/Dockerfile',
    target: 'runtime-ai',
    runtime_root: 'deploy/containers/ql3-cluster-control/runtime-dependencies',
  }),
  Object.freeze({
    image: 'admin',
    repository: 'qinglong3-cluster-admin',
    dockerfile: 'deploy/containers/ql3-cluster-admin/Dockerfile',
    target: 'runtime',
    runtime_root: 'deploy/containers/ql3-cluster-admin/runtime-dependencies',
  }),
  Object.freeze({
    image: 'worker',
    repository: 'qinglong3-worker',
    dockerfile: 'deploy/containers/ql3-worker/Dockerfile',
    target: 'runtime',
    runtime_root: 'deploy/containers/ql3-worker/runtime-dependencies',
  }),
]);

class ReleaseCandidateContractError extends Error {
  constructor(message) {
    super(`QingLong release candidate contract failed: ${message}`);
    this.name = 'ReleaseCandidateContractError';
  }
}

function fail(message) {
  throw new ReleaseCandidateContractError(message);
}

function readJson(filePath, maximumBytes = MAX_REPORT_BYTES) {
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > maximumBytes
  ) {
    fail(`invalid bounded JSON file: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function selectedImages(scope) {
  if (scope === 'local') return [...LOCAL_IMAGES];
  if (scope === 'cluster') return [...CLUSTER_IMAGES];
  return [...CLUSTER_IMAGES, ...LOCAL_IMAGES];
}

function validateIdentity(options) {
  if (
    typeof options.version !== 'string' ||
    !VERSION_PATTERN.test(options.version)
  ) {
    fail('version must be an exact QingLong 3 SemVer');
  }
  if (!/^[a-f0-9]{40}$/u.test(options.sourceRevision || '')) {
    fail('source revision must be an exact Git SHA-1 commit');
  }
  if (options.sourceRef !== `refs/tags/v${options.version}`) {
    fail('source ref must be the exact version tag');
  }
  if (!RELEASE_SCOPES.includes(options.releaseScope)) {
    fail('release scope must be all, cluster or local');
  }
}

function createReleaseCandidateContract(options) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  validateIdentity(options);
  const releaseIdentity = readReleaseIdentity(root);
  if (options.version !== releaseIdentity.version) {
    fail('requested version differs from the repository release identity');
  }
  const boundaries = auditPackageBoundaries(root);
  if (
    !boundaries.compatible ||
    boundaries.workspacePackageCount !==
      releaseIdentity.workspacePackageCount ||
    boundaries.workspacePackageHardCap !==
      releaseIdentity.workspacePackageCount ||
    boundaries.singleSourcePackages.length !== 0 ||
    boundaries.shallowSourcePackages.length !== 0
  ) {
    fail('workspace package boundary is incompatible');
  }
  const workspacePackages = boundaries.packages
    .map((entry) => {
      const manifest = readJson(path.join(root, entry.path, 'package.json'));
      if (
        manifest.name !== entry.name ||
        manifest.version !== options.version ||
        manifest.engines?.node !== releaseIdentity.node.engine
      ) {
        fail(`workspace release identity differs: ${entry.path}`);
      }
      return Object.freeze({
        name: manifest.name,
        path: entry.path,
        version: manifest.version,
      });
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const images = selectedImages(options.releaseScope);
  const imageManifests = images.map((image) => {
    const manifest = readJson(
      path.join(root, image.runtime_root, 'package.json'),
    );
    if (
      manifest.version !== options.version ||
      manifest.engines?.node !== releaseIdentity.node.engine
    ) {
      fail(`image release identity differs: ${image.runtime_root}`);
    }
    const dockerfile = fs.readFileSync(
      path.join(root, image.dockerfile),
      'utf8',
    );
    if (
      !dockerfile.includes(
        `node:${releaseIdentity.node.version}-bookworm-slim@sha256:`,
      ) ||
      !dockerfile.includes(
        `org.opencontainers.image.version=\"${options.version}\"`,
      )
    ) {
      fail(`image Dockerfile release identity differs: ${image.dockerfile}`);
    }
    return Object.freeze({
      image: image.image,
      repository: image.repository,
      dockerfile: image.dockerfile,
      target: image.target,
      runtimeRoot: image.runtime_root,
      manifestName: manifest.name,
      version: manifest.version,
    });
  });
  const publishMatrix = images.map(({ dockerfile, target, ...image }) => image);
  const osMatrix = images.flatMap((image) => [
    {
      image: image.image,
      runner: 'ubuntu-24.04',
      node_arch: 'x64',
      image_arch: 'amd64',
      dockerfile: image.dockerfile,
      target: image.target,
    },
    {
      image: image.image,
      runner: 'ubuntu-24.04-arm',
      node_arch: 'arm64',
      image_arch: 'arm64',
      dockerfile: image.dockerfile,
      target: image.target,
    },
  ]);
  const unsigned = {
    schemaVersion: 1,
    schema: SCHEMA,
    release: {
      version: options.version,
      sourceRevision: options.sourceRevision,
      sourceRef: options.sourceRef,
      scope: options.releaseScope,
    },
    compatibility: {
      legacyRootPackageVersion: readJson(path.join(root, 'package.json'))
        .version,
      legacyRootExcludedFromReleaseIdentity:
        releaseIdentity.legacyRootPackageExcluded,
      releaseIdentitySchema: releaseIdentity.schema,
      releaseIdentityDigest: sha256(
        Buffer.from(JSON.stringify(releaseIdentity)),
      ),
      nodeVersion: releaseIdentity.node.version,
      nodeEngine: releaseIdentity.node.engine,
      platforms: ['linux/amd64', 'linux/arm64'],
    },
    workspace: {
      packageCount: workspacePackages.length,
      packageHardCap: boundaries.workspacePackageHardCap,
      packages: workspacePackages,
    },
    deploymentFamilies: {
      local: {
        selected: options.releaseScope !== 'cluster',
        profiles: ['edge', 'standalone'],
        requiresClusterPrivateEvidence: false,
      },
      cluster: {
        selected: options.releaseScope !== 'local',
        profiles: ['cluster', 'worker-edge', 'worker-node'],
        requiresClusterPrivateEvidence: true,
      },
    },
    images: imageManifests,
    releasePlan: {
      clusterEvidenceRequired: options.releaseScope !== 'local',
      osMatrix,
      publishMatrix,
    },
    requiredGates: [
      'package-boundary',
      'source-tag-version-identity',
      'native-os-vulnerability',
      'multiarch-oci-layout',
      'production-dependency-audit',
      'digest-signature-and-attestations',
      ...(options.releaseScope !== 'cluster'
        ? ['edge-and-standalone-rollout']
        : []),
      ...(options.releaseScope !== 'local'
        ? [
            'worker-management-production-evidence',
            'cloudnativepg-disaster-recovery-evidence',
          ]
        : []),
    ],
  };
  return Object.freeze({
    ...unsigned,
    contractDigest: sha256(Buffer.from(JSON.stringify(unsigned))),
  });
}

function auditReleaseCandidateContract(actual, options) {
  const expected = createReleaseCandidateContract(options);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('report differs from the source-derived contract');
  }
  return Object.freeze({
    compatible: true,
    contractDigest: actual.contractDigest,
    releaseScope: actual.release.scope,
    workspacePackageCount: actual.workspace.packageCount,
    images: Object.freeze(actual.images.map((entry) => entry.image)),
    clusterEvidenceRequired: actual.releasePlan.clusterEvidenceRequired,
  });
}

function writeNoReplace(filePath, value) {
  const resolved = path.resolve(filePath || '');
  if (
    !path.isAbsolute(filePath || '') ||
    fs.existsSync(resolved) ||
    fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)
  ) {
    fail('output must be unused in one canonical directory');
  }
  fs.writeFileSync(resolved, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || Object.hasOwn(values, match[1]))
      fail('arguments are invalid');
    values[match[1]] = match[2];
  }
  const common = [
    'mode',
    'release-scope',
    'source-ref',
    'source-revision',
    'version',
  ];
  const expected =
    values.mode === 'create'
      ? [...common, 'output']
      : values.mode === 'audit'
      ? [...common, 'report']
      : [];
  if (
    expected.length === 0 ||
    JSON.stringify(Object.keys(values).sort()) !==
      JSON.stringify(expected.sort())
  ) {
    fail('arguments are invalid');
  }
  return Object.freeze({
    mode: values.mode,
    version: values.version,
    sourceRevision: values['source-revision'],
    sourceRef: values['source-ref'],
    releaseScope: values['release-scope'],
    ...(values.output ? { output: values.output } : {}),
    ...(values.report ? { report: values.report } : {}),
  });
}

function runCli(argv, root = DEFAULT_ROOT, output = process.stdout) {
  const options = parseArguments(argv);
  if (options.mode === 'create') {
    const report = createReleaseCandidateContract({ ...options, root });
    writeNoReplace(options.output, report);
    output.write(`${JSON.stringify(report)}\n`);
    return report;
  }
  const report = readJson(path.resolve(options.report));
  const audit = auditReleaseCandidateContract(report, { ...options, root });
  output.write(`${JSON.stringify(audit)}\n`);
  return audit;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : 'release candidate contract failed'
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  CLUSTER_IMAGES,
  LOCAL_IMAGES,
  PREDICATE_TYPE,
  RELEASE_SCOPES,
  SCHEMA,
  ReleaseCandidateContractError,
  auditReleaseCandidateContract,
  createReleaseCandidateContract,
  parseArguments,
  runCli,
});
