const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  buildApplicationStartReport,
  collectArtifactIdentity,
  normalizeApplicationStartManifest,
  normalizeSession,
  parseArguments,
  parseEventLines,
  preflightArtifactMetadata,
  validateApplicationStartReport,
  validateArtifactAgainstManifest,
  validateBootObservation,
} = require('../../scripts/ql3-physical-edge-application-start.cjs');
const {
  canonicalDigest,
} = require('../../scripts/ql3-physical-edge-evidence.cjs');
const {
  readReleaseIdentity,
} = require('../../scripts/lib/ql3-release-identity.cjs');

const version = readReleaseIdentity(path.resolve(__dirname, '../..')).version;

const packages = [
  '@qinglong/local-admin',
  '@qinglong/local-application',
  '@qinglong/local-command-file',
  '@qinglong/local-execution',
  '@qinglong/local-process',
  '@qinglong/local-secret',
  '@qinglong/local-sqlite',
  '@qinglong/runtime-core',
  'croner',
  'semver',
];

function writePrivate(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
}

function artifactFixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ql3-application-artifact-')),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const packageName of packages) {
    const packageRoot = path.join(
      root,
      'node_modules',
      ...packageName.split('/'),
    );
    const manifest =
      packageName === '@qinglong/local-application'
        ? {
            name: packageName,
            version,
            engines: { node: '>=24.18.0 <25' },
            bin: { 'ql3-local-application': 'dist/cli.js' },
          }
        : { name: packageName, version: '1.0.0' };
    writePrivate(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify(manifest)}\n`,
    );
    writePrivate(path.join(packageRoot, 'dist', 'index.js'), `'use strict';\n`);
  }
  writePrivate(
    path.join(
      root,
      'node_modules',
      '@qinglong',
      'local-application',
      'dist',
      'cli.js',
    ),
    `#!/usr/bin/env node\n'use strict';\n`,
  );
  return { root, identity: collectArtifactIdentity(root) };
}

function manifest(artifact, overrides = {}) {
  return normalizeApplicationStartManifest({
    schemaVersion: 1,
    evidenceClass: 'physical_edge_application_start_candidate',
    profile: 'edge',
    deviceId: 'router-a1',
    expectedArchitecture: 'arm64',
    expectedFilesystem: 'ext4',
    expectedArtifactSha256: artifact.artifactSha256,
    expectedArtifactFiles: artifact.artifactFiles,
    expectedArtifactBytes: artifact.artifactBytes,
    expectedNodeSha256: 'b'.repeat(64),
    maximumBootAgeMs: 180_000,
    maximumFirstActiveMs: 30_000,
    maximumSampledRssBytes: 256 * 1024 * 1024,
    sampleIntervalMs: 10,
    ...overrides,
  });
}

function boot(bootId, bootAgeMs = 1000, overrides = {}) {
  return {
    platform: 'linux',
    architecture: 'arm64',
    bootId,
    dataFilesystem: 'ext4',
    nodeExecutable: '/usr/bin/node',
    nodeSha256: 'b'.repeat(64),
    nodeVersion: 'v24.18.0',
    bootAgeMs,
    ...overrides,
  };
}

function sessionFixture(artifact) {
  const sessionId = '019f0000-0000-4000-8000-000000000010';
  const dataPath = '/mnt/ql3-evidence';
  const deploymentRoot = path.join(
    dataPath,
    `.ql3-application-start-${sessionId}`,
  );
  const artifactRoot = '/opt/qinglong3-release';
  const body = {
    schemaVersion: 1,
    evidenceClass: 'physical_edge_application_start_session',
    sessionId,
    manifestDigest: canonicalDigest(manifest(artifact)),
    uid: 1000,
    preparedAt: '2026-07-29T00:00:00.000Z',
    artifact,
    environment: boot('019f0000-0000-4000-8000-000000000001', 50_000),
    paths: {
      dataPath,
      deploymentRoot,
      artifactRoot,
      applicationEntrypoint: path.join(
        artifactRoot,
        'node_modules',
        '@qinglong',
        'local-application',
        'dist',
        'cli.js',
      ),
      applicationConfig: path.join(deploymentRoot, 'local-application.json'),
    },
  };
  return { ...body, sha256: canonicalDigest(body) };
}

function reportFixture(artifact, overrides = {}) {
  const session = normalizeSession(sessionFixture(artifact));
  return buildApplicationStartReport({
    manifest: manifest(artifact),
    session,
    observed: {
      before: session.environment,
      after: boot('019f0000-0000-4000-8000-000000000002'),
      artifact,
    },
    measurements: {
      firstActiveMs: 1200,
      maximumSampledRssBytes: 80 * 1024 * 1024,
      processReadBytes: 4096,
      processWriteBytes: 8192,
      sampleCount: 20,
      eventCount: 5,
    },
    outcomes: {
      activeEventCount: 1,
      aiStatus: 'deployment_excluded',
      gracefulStop: true,
      exitCode: 0,
      exitSignal: null,
      stderrBytes: 0,
      sqliteContractVersion: 41,
    },
    generatedAt: '2026-07-29T00:01:00.000Z',
    ...overrides,
  });
}

test('normalizes exact Edge application start budgets', () => {
  const artifact = {
    artifactSha256: 'a'.repeat(64),
    artifactMetadataSha256: 'd'.repeat(64),
    artifactFiles: 100,
    artifactBytes: 2 * 1024 * 1024,
  };
  assert.equal(manifest(artifact).maximumBootAgeMs, 180_000);
  assert.throws(
    () => manifest(artifact, { maximumBootAgeMs: 601_000 }),
    /measurement budget/,
  );
  assert.throws(
    () => manifest(artifact, { maximumSampledRssBytes: 1 }),
    /measurement budget/,
  );
});

test('requires phase-specific absolute paths', () => {
  assert.deepEqual(
    parseArguments([
      'inspect',
      '--artifact-root=/opt/qinglong3-release',
      '--json',
    ]),
    {
      phase: 'inspect',
      artifactRoot: '/opt/qinglong3-release',
      json: true,
    },
  );
  assert.equal(
    parseArguments([
      'prepare',
      '--manifest=/mnt/data/manifest.json',
      '--data-path=/mnt/data',
      '--artifact-root=/opt/qinglong3-release',
      '--session=/mnt/data/session.json',
    ]).phase,
    'prepare',
  );
  assert.throws(
    () =>
      parseArguments([
        'resume',
        '--manifest=manifest.json',
        '--session=/data/session.json',
        '--output=/data/report.json',
      ]),
    /manifestPath must be absolute/,
  );
});

test('hashes one exact AI-excluded native release closure', (t) => {
  const fixture = artifactFixture(t);
  assert.deepEqual(fixture.identity.artifact.packages, packages);
  assert.match(fixture.identity.artifact.artifactSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    fixture.identity.applicationEntrypoint.endsWith('/dist/cli.js'),
    true,
  );
  assert.deepEqual(
    validateArtifactAgainstManifest(
      manifest(fixture.identity.artifact),
      fixture.identity.artifact,
      { nodeSha256: 'b'.repeat(64) },
    ),
    [],
  );
  writePrivate(
    path.join(fixture.root, 'node_modules', 'unexpected', 'package.json'),
    '{}\n',
  );
  assert.throws(
    () => collectArtifactIdentity(fixture.root),
    /package closure is invalid/,
  );
});

test('detects cross-boot artifact metadata drift without reading file content', (t) => {
  const fixture = artifactFixture(t);
  const entrypoint = fixture.identity.applicationEntrypoint;
  const before = preflightArtifactMetadata(fixture.root, entrypoint);
  assert.equal(
    before.artifactMetadataSha256,
    fixture.identity.artifact.artifactMetadataSha256,
  );
  fs.chmodSync(entrypoint, 0o400);
  const after = preflightArtifactMetadata(fixture.root, entrypoint);
  assert.notEqual(
    after.artifactMetadataSha256,
    fixture.identity.artifact.artifactMetadataSha256,
  );
});

test('binds the pre-reboot session to deterministic deployment paths', () => {
  const artifact = {
    artifactSha256: 'a'.repeat(64),
    artifactMetadataSha256: 'd'.repeat(64),
    artifactFiles: 100,
    artifactBytes: 2 * 1024 * 1024,
    entrypointSha256: 'c'.repeat(64),
    packages,
  };
  const session = normalizeSession(sessionFixture(artifact));
  assert.equal(session.environment.bootAgeMs, 50_000);
  const escaped = sessionFixture(artifact);
  escaped.paths.deploymentRoot = '/opt/qinglong3';
  const { sha256: ignored, ...body } = escaped;
  assert.throws(
    () => normalizeSession({ ...body, sha256: canonicalDigest(body) }),
    /session is invalid or drifted/,
  );
});

test('parses bounded production active events', () => {
  const events = [];
  const remaining = parseEventLines(
    `${JSON.stringify({
      schemaVersion: 1,
      component: 'qinglong3-local-application',
      level: 'info',
      event: 'active',
      instanceId: 'edge-a',
      profile: 'edge',
      aiStatus: 'deployment_excluded',
    })}\npartial`,
    events,
  );
  assert.equal(remaining, 'partial');
  assert.equal(events[0].event, 'active');
  assert.throws(
    () => parseEventLines(`${'x'.repeat(4097)}\n`, []),
    /event line exceeded/,
  );
});

test('accepts only different-boot bounded native application activation', () => {
  const artifact = {
    artifactSha256: 'a'.repeat(64),
    artifactMetadataSha256: 'd'.repeat(64),
    artifactFiles: 100,
    artifactBytes: 2 * 1024 * 1024,
    entrypointSha256: 'c'.repeat(64),
    packages,
  };
  const report = reportFixture(artifact);
  assert.equal(report.supported, false);
  assert.equal(report.qualification.passed, true);
  assert.ok(
    report.qualification.doesNotProve.includes(
      'cold_node_runtime_or_dynamic_linker_cache',
    ),
  );
  assert.deepEqual(
    validateApplicationStartReport(report, manifest(artifact), {
      bootId: report.observed.after.bootId,
      architecture: 'arm64',
      dataFilesystem: 'ext4',
      dataPath: '/mnt/ql3-evidence',
    }),
    [],
  );
  assert.deepEqual(
    validateBootObservation(
      manifest(artifact),
      report.observed.after,
      '/mnt/ql3-evidence',
    ),
    [],
  );
});

test('fails same boot, latency, sampled RSS and lifecycle drift', () => {
  const artifact = {
    artifactSha256: 'a'.repeat(64),
    artifactMetadataSha256: 'd'.repeat(64),
    artifactFiles: 100,
    artifactBytes: 2 * 1024 * 1024,
    entrypointSha256: 'c'.repeat(64),
    packages,
  };
  const session = normalizeSession(sessionFixture(artifact));
  const report = buildApplicationStartReport({
    manifest: manifest(artifact),
    session,
    observed: {
      before: session.environment,
      after: session.environment,
      artifact,
    },
    measurements: {
      firstActiveMs: 31_000,
      maximumSampledRssBytes: 300 * 1024 * 1024,
      processReadBytes: 0,
      processWriteBytes: 0,
      sampleCount: 1,
      eventCount: 1,
    },
    outcomes: {
      activeEventCount: 0,
      aiStatus: 'active',
      gracefulStop: false,
      exitCode: 1,
      exitSignal: null,
      stderrBytes: 1,
      sqliteContractVersion: 34,
    },
    generatedAt: '2026-07-29T00:01:00.000Z',
  });
  assert.equal(report.qualification.passed, false);
  assert.match(
    report.qualification.violations.join('; '),
    /reboot boundary.*measurement budget.*lifecycle outcome/,
  );
});
