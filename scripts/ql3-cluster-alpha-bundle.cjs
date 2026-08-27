#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { auditClusterImageSbom } = require('./ql3-cluster-image-sbom.cjs');
const { readReleaseIdentity } = require('./lib/ql3-release-identity.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const SCHEMA = 'qinglong/alpha-cluster-image@v1';
const VERIFICATION_SCHEMA = 'qinglong/alpha-cluster-image-verification@v1';
const ARCHITECTURES = Object.freeze(['amd64', 'arm64']);
const ROLES = Object.freeze({
  control: Object.freeze({
    repository: 'qinglong3-cluster-control',
    title: 'QingLong 3.0 Cluster Control',
    user: '10001:10001',
  }),
  'control-ai': Object.freeze({
    repository: 'qinglong3-cluster-control-ai',
    title: 'QingLong 3.0 Cluster Control AI',
    user: '10001:10001',
  }),
  admin: Object.freeze({
    repository: 'qinglong3-cluster-admin',
    title: 'QingLong 3.0 Cluster Admin',
    user: '10001:10001',
  }),
  worker: Object.freeze({
    repository: 'qinglong3-worker',
    title: 'QingLong 3.0 Worker',
    user: '65532:65532',
  }),
});
const WORKFLOW_IDENTITY = Object.freeze({
  repository: 'whyour/qinglong',
  workflowRef: 'whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next',
  event: 'workflow_dispatch',
  job: 'cluster-image',
});
const ARCHIVE_MIN_BYTES = 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_README_BYTES = 512 * 1024;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const ATTEMPT_PATTERN = /^[1-9][0-9]{0,5}$/u;

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
  );
}

function roleConfig(role) {
  const config = ROLES[role];
  if (!config) fail('Cluster image role is invalid');
  return config;
}

function names(role, architecture) {
  const repository = roleConfig(role).repository;
  return Object.freeze({
    archive: `${repository}-${architecture}.docker.tar`,
    sbom: `${repository}.cdx.json`,
    verification: 'verification-evidence.json',
    readme: 'README.md',
    manifest: 'manifest.json',
    checksums: 'SHA256SUMS',
  });
}

function assertCanonicalFile(filePath, maximumBytes, label) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > maximumBytes ||
    fs.realpathSync(resolved) !== resolved
  ) {
    fail(`${label} must be one bounded canonical regular file`);
  }
  return resolved;
}

function readBoundedJson(filePath, label) {
  const resolved = assertCanonicalFile(filePath, MAX_JSON_BYTES, label);
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    fail(`${label} must contain valid JSON`);
  }
}

function sha256File(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest('hex')}`;
}

function writeExclusive(filePath, contents, mode = 0o600) {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    mode,
  );
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function copyExclusive(source, destination) {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
}

function inspectDockerImage(image) {
  const output = childProcess.execFileSync(
    'docker',
    ['image', 'inspect', image],
    {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    fail(`docker returned an invalid inspection for ${image}`);
  }
  return parsed[0];
}

function saveDockerImage(image, archivePath) {
  childProcess.execFileSync(
    'docker',
    ['image', 'save', '--output', archivePath, image],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

function validateImageReference(value, role, architecture) {
  const expected = `${roleConfig(role).repository}:ci-${architecture}`;
  if (value !== expected) fail('Cluster image reference is incompatible');
  return value;
}

function normalizeImageInspection(inspection, options) {
  const config = roleConfig(options.role);
  const labels = inspection?.Config?.Labels;
  if (
    !SHA256_PATTERN.test(inspection?.Id || '') ||
    inspection?.Os !== 'linux' ||
    inspection?.Architecture !== options.architecture ||
    inspection?.Config?.User !== config.user ||
    labels?.['org.opencontainers.image.title'] !== config.title ||
    labels?.['org.opencontainers.image.source'] !==
      'https://github.com/whyour/qinglong' ||
    labels?.['org.opencontainers.image.revision'] !== options.sourceRevision ||
    labels?.['org.opencontainers.image.version'] !== options.version
  ) {
    fail('Cluster image identity is incompatible');
  }
  return Object.freeze({
    reference: options.reference,
    id: inspection.Id,
    os: 'linux',
    architecture: options.architecture,
    user: config.user,
  });
}

function validateSbom(document, options, offline = false) {
  if (!offline) {
    auditClusterImageSbom(document, {
      root: options.root,
      image: options.role,
    });
  }
  const properties = Object.fromEntries(
    (document?.metadata?.properties || []).map((entry) => [
      entry?.name,
      entry?.value,
    ]),
  );
  if (
    document?.bomFormat !== 'CycloneDX' ||
    document?.specVersion !== '1.5' ||
    document?.version !== 1 ||
    !Array.isArray(document.components) ||
    !Array.isArray(document.dependencies) ||
    document.metadata?.component?.version !== options.version ||
    properties['qinglong:image-profile'] !== options.role
  ) {
    fail('Cluster image SBOM identity is incompatible');
  }
}

function gates(role) {
  return Object.freeze({
    osVulnerabilityPolicy: 'passed',
    sbomInventoryReconciliation: 'passed',
    nonRootRuntimeIdentity: 'passed',
    clusterAdminProductFacade: role === 'admin' ? 'passed' : 'not_applicable',
  });
}

function validateVerificationEvidence(document, expected) {
  if (
    !exactKeys(document, [
      'schemaVersion',
      'schema',
      'subject',
      'workflow',
      'gates',
    ]) ||
    document.schemaVersion !== 1 ||
    document.schema !== VERIFICATION_SCHEMA ||
    !exactKeys(document.subject, [
      'version',
      'sourceRevision',
      'role',
      'architecture',
      'imageId',
    ]) ||
    document.subject.version !== expected.version ||
    document.subject.sourceRevision !== expected.sourceRevision ||
    document.subject.role !== expected.role ||
    document.subject.architecture !== expected.architecture ||
    document.subject.imageId !== expected.imageId ||
    !exactKeys(document.workflow, [
      'repository',
      'workflowRef',
      'workflowSha',
      'event',
      'job',
      'runId',
      'runAttempt',
    ]) ||
    document.workflow.repository !== WORKFLOW_IDENTITY.repository ||
    document.workflow.workflowRef !== WORKFLOW_IDENTITY.workflowRef ||
    document.workflow.workflowSha !== expected.sourceRevision ||
    document.workflow.event !== WORKFLOW_IDENTITY.event ||
    document.workflow.job !== WORKFLOW_IDENTITY.job ||
    !DECIMAL_ID_PATTERN.test(document.workflow.runId || '') ||
    !ATTEMPT_PATTERN.test(document.workflow.runAttempt || '') ||
    !exactKeys(document.gates, Object.keys(gates(expected.role))) ||
    JSON.stringify(document.gates) !== JSON.stringify(gates(expected.role))
  ) {
    fail('Cluster image verification evidence is incompatible');
  }
  return document;
}

function validateCommonIdentity(options) {
  if (
    !ARCHITECTURES.includes(options.architecture) ||
    !Object.hasOwn(ROLES, options.role) ||
    !REVISION_PATTERN.test(options.sourceRevision || '')
  ) {
    fail('Cluster image identity is invalid');
  }
}

function createClusterAlphaVerificationEvidence(options, adapters = {}) {
  validateCommonIdentity(options);
  const root = fs.realpathSync(path.resolve(options.root || DEFAULT_ROOT));
  const output = path.resolve(options.output || '');
  const parent = path.dirname(output);
  if (
    !path.isAbsolute(output) ||
    fs.existsSync(output) ||
    fs.realpathSync(parent) !== parent ||
    options.repository !== WORKFLOW_IDENTITY.repository ||
    options.workflowRef !== WORKFLOW_IDENTITY.workflowRef ||
    options.workflowSha !== options.sourceRevision ||
    options.eventName !== WORKFLOW_IDENTITY.event ||
    options.job !== WORKFLOW_IDENTITY.job ||
    !DECIMAL_ID_PATTERN.test(options.runId || '') ||
    !ATTEMPT_PATTERN.test(options.runAttempt || '')
  ) {
    fail('Cluster verification workflow identity or output is invalid');
  }
  const release = readReleaseIdentity(root);
  const reference = validateImageReference(
    options.image,
    options.role,
    options.architecture,
  );
  const inspectImage = adapters.inspectImage || inspectDockerImage;
  const image = normalizeImageInspection(inspectImage(reference), {
    reference,
    role: options.role,
    architecture: options.architecture,
    sourceRevision: options.sourceRevision,
    version: release.version,
  });
  const evidence = {
    schemaVersion: 1,
    schema: VERIFICATION_SCHEMA,
    subject: {
      version: release.version,
      sourceRevision: options.sourceRevision,
      role: options.role,
      architecture: options.architecture,
      imageId: image.id,
    },
    workflow: {
      repository: options.repository,
      workflowRef: options.workflowRef,
      workflowSha: options.workflowSha,
      event: options.eventName,
      job: options.job,
      runId: options.runId,
      runAttempt: options.runAttempt,
    },
    gates: { ...gates(options.role) },
  };
  validateVerificationEvidence(evidence, evidence.subject);
  writeExclusive(output, `${JSON.stringify(evidence, null, 2)}\n`);
  return Object.freeze(evidence);
}

function fileRecord(bundleRoot, name) {
  const filePath = path.join(bundleRoot, name);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2) {
    fail(`bundle file is invalid: ${name}`);
  }
  return Object.freeze({
    file: name,
    sha256: sha256File(filePath),
    bytes: stat.size,
  });
}

function checksumContents(bundleRoot, checkedNames) {
  return `${checkedNames
    .map(
      (name) => `${sha256File(path.join(bundleRoot, name)).slice(7)}  ${name}`,
    )
    .join('\n')}\n`;
}

function createClusterAlphaBundle(options, adapters = {}) {
  validateCommonIdentity(options);
  const root = fs.realpathSync(path.resolve(options.root || DEFAULT_ROOT));
  const outputRoot = path.resolve(options.outputRoot || '');
  const parent = path.dirname(outputRoot);
  if (
    !path.isAbsolute(outputRoot) ||
    fs.existsSync(outputRoot) ||
    fs.realpathSync(parent) !== parent
  ) {
    fail('Cluster bundle output is invalid');
  }
  const sbomPath = assertCanonicalFile(
    options.sbom,
    MAX_JSON_BYTES,
    'Cluster SBOM',
  );
  const evidencePath = assertCanonicalFile(
    options.verificationEvidence,
    MAX_JSON_BYTES,
    'Cluster verification evidence',
  );
  const readmePath = assertCanonicalFile(
    options.readme,
    MAX_README_BYTES,
    'Cluster README',
  );
  const release = readReleaseIdentity(root);
  const reference = validateImageReference(
    options.image,
    options.role,
    options.architecture,
  );
  const inspectImage = adapters.inspectImage || inspectDockerImage;
  const saveImage = adapters.saveImage || saveDockerImage;
  const image = normalizeImageInspection(inspectImage(reference), {
    reference,
    role: options.role,
    architecture: options.architecture,
    sourceRevision: options.sourceRevision,
    version: release.version,
  });
  const sbom = readBoundedJson(sbomPath, 'Cluster SBOM');
  validateSbom(sbom, { root, role: options.role, version: release.version });
  const evidence = readBoundedJson(
    evidencePath,
    'Cluster verification evidence',
  );
  validateVerificationEvidence(evidence, {
    version: release.version,
    sourceRevision: options.sourceRevision,
    role: options.role,
    architecture: options.architecture,
    imageId: image.id,
  });
  const bundleNames = names(options.role, options.architecture);
  let created = false;
  try {
    fs.mkdirSync(outputRoot, { mode: 0o700 });
    created = true;
    const archivePath = path.join(outputRoot, bundleNames.archive);
    saveImage(reference, archivePath);
    const archiveStat = fs.lstatSync(archivePath);
    if (
      !archiveStat.isFile() ||
      archiveStat.isSymbolicLink() ||
      archiveStat.size < ARCHIVE_MIN_BYTES
    ) {
      fail('Cluster Docker archive is invalid or unexpectedly small');
    }
    fs.chmodSync(archivePath, 0o600);
    copyExclusive(sbomPath, path.join(outputRoot, bundleNames.sbom));
    copyExclusive(
      evidencePath,
      path.join(outputRoot, bundleNames.verification),
    );
    copyExclusive(readmePath, path.join(outputRoot, bundleNames.readme));
    const manifest = {
      schemaVersion: 1,
      schema: SCHEMA,
      maturity: 'cluster_integration_candidate_not_public_release',
      product: 'cluster',
      role: options.role,
      version: release.version,
      sourceRevision: options.sourceRevision,
      architecture: options.architecture,
      image,
      archive: fileRecord(outputRoot, bundleNames.archive),
      sbom: fileRecord(outputRoot, bundleNames.sbom),
      readme: fileRecord(outputRoot, bundleNames.readme),
      verification: fileRecord(outputRoot, bundleNames.verification),
    };
    writeExclusive(
      path.join(outputRoot, bundleNames.manifest),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    writeExclusive(
      path.join(outputRoot, bundleNames.checksums),
      checksumContents(outputRoot, [
        bundleNames.archive,
        bundleNames.sbom,
        bundleNames.verification,
        bundleNames.readme,
        bundleNames.manifest,
      ]),
    );
    auditClusterAlphaBundle({ bundleRoot: outputRoot });
    return Object.freeze(manifest);
  } catch (error) {
    if (created) fs.rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

function validateFileRecord(record, expectedName, bundleRoot) {
  if (
    !exactKeys(record, ['file', 'sha256', 'bytes']) ||
    record.file !== expectedName ||
    !SHA256_PATTERN.test(record.sha256 || '') ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 2
  ) {
    fail(`manifest file record is invalid: ${expectedName}`);
  }
  const actual = fileRecord(bundleRoot, expectedName);
  if (actual.sha256 !== record.sha256 || actual.bytes !== record.bytes) {
    fail(`bundle file differs from manifest: ${expectedName}`);
  }
}

function auditClusterAlphaBundle(options) {
  const bundleRoot = fs.realpathSync(path.resolve(options.bundleRoot || ''));
  if (!fs.lstatSync(bundleRoot).isDirectory()) {
    fail('Cluster bundle root must be a canonical directory');
  }
  const manifest = readBoundedJson(
    path.join(bundleRoot, 'manifest.json'),
    'manifest',
  );
  if (
    !exactKeys(manifest, [
      'schemaVersion',
      'schema',
      'maturity',
      'product',
      'role',
      'version',
      'sourceRevision',
      'architecture',
      'image',
      'archive',
      'sbom',
      'readme',
      'verification',
    ]) ||
    manifest.schemaVersion !== 1 ||
    manifest.schema !== SCHEMA ||
    manifest.maturity !== 'cluster_integration_candidate_not_public_release' ||
    manifest.product !== 'cluster' ||
    !Object.hasOwn(ROLES, manifest.role) ||
    !ARCHITECTURES.includes(manifest.architecture) ||
    typeof manifest.version !== 'string' ||
    manifest.version.length < 3 ||
    manifest.version.length > 64 ||
    !REVISION_PATTERN.test(manifest.sourceRevision || '')
  ) {
    fail('Cluster bundle manifest identity or shape is incompatible');
  }
  const bundleNames = names(manifest.role, manifest.architecture);
  const expectedFiles = Object.values(bundleNames).sort();
  const actualFiles = fs
    .readdirSync(bundleRoot, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail(`Cluster bundle contains a non-regular entry: ${entry.name}`);
      }
      return entry.name;
    })
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail('Cluster bundle file set is not closed');
  }
  if (
    !exactKeys(manifest.image, [
      'reference',
      'id',
      'os',
      'architecture',
      'user',
    ]) ||
    manifest.image.reference !==
      `${roleConfig(manifest.role).repository}:ci-${manifest.architecture}` ||
    !SHA256_PATTERN.test(manifest.image.id || '') ||
    manifest.image.os !== 'linux' ||
    manifest.image.architecture !== manifest.architecture ||
    manifest.image.user !== roleConfig(manifest.role).user
  ) {
    fail('Cluster bundle image identity is incompatible');
  }
  validateFileRecord(manifest.archive, bundleNames.archive, bundleRoot);
  if (manifest.archive.bytes < ARCHIVE_MIN_BYTES) {
    fail('Cluster bundle archive is unexpectedly small');
  }
  validateFileRecord(manifest.sbom, bundleNames.sbom, bundleRoot);
  validateFileRecord(manifest.readme, bundleNames.readme, bundleRoot);
  validateFileRecord(
    manifest.verification,
    bundleNames.verification,
    bundleRoot,
  );
  const sbom = readBoundedJson(path.join(bundleRoot, bundleNames.sbom), 'SBOM');
  validateSbom(sbom, { role: manifest.role, version: manifest.version }, true);
  const evidence = readBoundedJson(
    path.join(bundleRoot, bundleNames.verification),
    'verification evidence',
  );
  validateVerificationEvidence(evidence, {
    version: manifest.version,
    sourceRevision: manifest.sourceRevision,
    role: manifest.role,
    architecture: manifest.architecture,
    imageId: manifest.image.id,
  });
  const expectedChecksums = checksumContents(bundleRoot, [
    bundleNames.archive,
    bundleNames.sbom,
    bundleNames.verification,
    bundleNames.readme,
    bundleNames.manifest,
  ]);
  if (
    fs.readFileSync(path.join(bundleRoot, bundleNames.checksums), 'utf8') !==
    expectedChecksums
  ) {
    fail('Cluster bundle SHA256SUMS differs from the closed file set');
  }
  return Object.freeze({
    schemaVersion: 1,
    schema: 'qinglong/alpha-cluster-image-audit@v1',
    role: manifest.role,
    architecture: manifest.architecture,
    sourceRevision: manifest.sourceRevision,
    version: manifest.version,
    workflowRunId: evidence.workflow.runId,
    workflowRunAttempt: evidence.workflow.runAttempt,
    imageId: manifest.image.id,
    archiveSha256: manifest.archive.sha256,
    verificationSha256: manifest.verification.sha256,
    compatible: true,
  });
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || Object.hasOwn(values, match[1]))
      fail('arguments are invalid');
    values[match[1]] = match[2];
  }
  if (values.mode === 'audit' || values.mode === 'offline-audit') {
    if (
      JSON.stringify(Object.keys(values).sort()) !==
      JSON.stringify(['bundle', 'mode'])
    ) {
      fail('audit arguments are invalid');
    }
    return { mode: values.mode, bundleRoot: path.resolve(values.bundle) };
  }
  const common = {
    architecture: values.architecture,
    image: values.image,
    role: values.role,
    sourceRevision: values['source-revision'],
  };
  if (values.mode === 'record-verification') {
    const expected = [
      'architecture',
      'event',
      'image',
      'job',
      'mode',
      'output',
      'repository',
      'role',
      'run-attempt',
      'run-id',
      'source-revision',
      'workflow-ref',
      'workflow-sha',
    ].sort();
    if (
      JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expected)
    ) {
      fail('verification arguments are invalid');
    }
    return {
      mode: values.mode,
      ...common,
      output: path.resolve(values.output),
      repository: values.repository,
      workflowRef: values['workflow-ref'],
      workflowSha: values['workflow-sha'],
      eventName: values.event,
      job: values.job,
      runId: values['run-id'],
      runAttempt: values['run-attempt'],
    };
  }
  const expected = [
    'architecture',
    'image',
    'mode',
    'output',
    'readme',
    'role',
    'sbom',
    'source-revision',
    'verification-evidence',
  ].sort();
  if (
    values.mode !== 'create' ||
    JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expected)
  ) {
    fail('create arguments are invalid');
  }
  return {
    mode: values.mode,
    ...common,
    outputRoot: path.resolve(values.output),
    sbom: path.resolve(values.sbom),
    verificationEvidence: path.resolve(values['verification-evidence']),
    readme: path.resolve(values.readme),
  };
}

function runCli(argv) {
  const options = parseArguments(argv);
  let report;
  if (options.mode === 'record-verification') {
    report = createClusterAlphaVerificationEvidence(options);
  } else if (options.mode === 'create') {
    report = createClusterAlphaBundle(options);
  } else {
    report = auditClusterAlphaBundle(options);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error ? error.message : 'Cluster Alpha bundle failed'
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  ARCHITECTURES,
  ROLES,
  SCHEMA,
  VERIFICATION_SCHEMA,
  auditClusterAlphaBundle,
  createClusterAlphaBundle,
  createClusterAlphaVerificationEvidence,
  names,
  parseArguments,
  runCli,
  sha256File,
});
