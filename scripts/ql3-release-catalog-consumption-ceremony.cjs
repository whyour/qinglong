#!/usr/bin/env node

'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');

const {
  ARTIFACT_TYPE,
  createCatalogPlan,
  createCatalogReceipt,
} = require('./ql3-release-catalog-contract.cjs');
const {
  RELEASE_SET_SCHEMA,
  inspectReleaseSet,
} = require('./ql3-release-set-contract.cjs');
const { VERSION_PATTERN } = require('./lib/ql3-release-identity.cjs');

const SCHEMA = 'qinglong/release-catalog-consumption-ceremony@v1';
const WORKFLOW = '.github/workflows/ql3-image-release.yml';
const RELEASE_SCOPES = Object.freeze(['local', 'cluster', 'all']);
const TOOL_NAMES = Object.freeze(['regctl', 'cosign', 'gh']);
const MAX_TOOL_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u;
const REPOSITORY_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/u;

class QingLong3ReleaseCatalogConsumptionError extends Error {
  constructor(message) {
    super(`QingLong 3 release catalog consumption failed: ${message}`);
    this.name = 'QingLong3ReleaseCatalogConsumptionError';
  }
}

function fail(message) {
  throw new QingLong3ReleaseCatalogConsumptionError(message);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
  );
}

function resolveCanonicalAbsolute(value, label) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.length > 4096 ||
    CONTROL.test(value) ||
    path.resolve(value) !== value
  ) {
    fail(`${label} must be one canonical absolute path`);
  }
  return value;
}

function currentUid() {
  if (typeof process.getuid !== 'function') {
    fail('workstation owner identity is unavailable');
  }
  return process.getuid();
}

function canonicalPrivateDirectory(directoryPath, label) {
  const resolved = resolveCanonicalAbsolute(directoryPath, label);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail(`${label} must exist`);
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(resolved) !== resolved ||
    stat.uid !== currentUid() ||
    (stat.mode & 0o077) !== 0
  ) {
    fail(`${label} must be one owner-private canonical directory`);
  }
  return Object.freeze({
    path: resolved,
    dev: stat.dev,
    ino: stat.ino,
  });
}

function preflightOutputDirectory(directoryPath) {
  const resolved = resolveCanonicalAbsolute(directoryPath, 'output directory');
  if (fs.existsSync(resolved)) {
    fail('output directory must not already exist');
  }
  const parent = canonicalPrivateDirectory(
    path.dirname(resolved),
    'output parent',
  );
  return Object.freeze({ path: resolved, parent });
}

function executable(filePath, expectedName) {
  const resolved = resolveCanonicalAbsolute(filePath, expectedName);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail(`${expectedName} executable is unavailable`);
  }
  if (
    path.basename(resolved) !== expectedName ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > MAX_TOOL_BYTES ||
    fs.realpathSync(resolved) !== resolved ||
    (stat.mode & 0o111) === 0 ||
    (stat.mode & 0o022) !== 0
  ) {
    fail(`${expectedName} must be one immutable canonical executable`);
  }
  return Object.freeze({
    name: expectedName,
    path: resolved,
    dev: stat.dev,
    ino: stat.ino,
    sizeBytes: stat.size,
    sha256: sha256(fs.readFileSync(resolved)),
  });
}

function verifyExecutable(tool) {
  const current = executable(tool.path, tool.name);
  if (
    current.dev !== tool.dev ||
    current.ino !== tool.ino ||
    current.sizeBytes !== tool.sizeBytes ||
    current.sha256 !== tool.sha256
  ) {
    fail(`${tool.name} executable changed during the ceremony`);
  }
}

function readPrivateToken(filePath) {
  const resolved = resolveCanonicalAbsolute(filePath, 'GitHub token file');
  let before;
  try {
    before = fs.lstatSync(resolved);
  } catch {
    fail('GitHub token file is unavailable');
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 8 ||
    before.size > 4096 ||
    before.uid !== currentUid() ||
    (before.mode & 0o077) !== 0 ||
    fs.realpathSync(resolved) !== resolved
  ) {
    fail('GitHub token file must be one owner-private canonical file');
  }
  let descriptor = -1;
  let bytes;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY |
        (fs.constants.O_CLOEXEC ?? 0) |
        (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.mode !== before.mode ||
      opened.uid !== before.uid ||
      opened.size !== before.size
    ) {
      fail('GitHub token file changed while opening');
    }
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) fail('GitHub token file read was incomplete');
      offset += count;
    }
    const token = bytes.toString('utf8');
    if (
      token.trim() !== token ||
      token.length < 8 ||
      CONTROL.test(token) ||
      /\s/u.test(token)
    ) {
      fail('GitHub token file is malformed');
    }
    return Object.freeze({
      bytes,
      token,
      dev: opened.dev,
      ino: opened.ino,
    });
  } catch (error) {
    if (bytes) bytes.fill(0);
    if (error instanceof QingLong3ReleaseCatalogConsumptionError) throw error;
    fail('GitHub token file could not be read safely');
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function validateIdentity(options) {
  if (
    typeof options.version !== 'string' ||
    !VERSION_PATTERN.test(options.version) ||
    semver.valid(options.version) !== options.version ||
    !/^[a-f0-9]{40}$/u.test(options.sourceRevision || '') ||
    options.sourceRef !== `refs/tags/v${options.version}` ||
    !RELEASE_SCOPES.includes(options.releaseScope) ||
    !OWNER_PATTERN.test(options.repositoryOwner || '') ||
    !REPOSITORY_PATTERN.test(options.sourceRepository || '') ||
    !options.sourceRepository.startsWith(`${options.repositoryOwner}/`)
  ) {
    fail('release identity is invalid');
  }
  return Object.freeze({
    version: options.version,
    sourceRevision: options.sourceRevision,
    sourceRef: options.sourceRef,
    releaseScope: options.releaseScope,
    repositoryOwner: options.repositoryOwner,
    sourceRepository: options.sourceRepository,
  });
}

function releaseSetFileName(identity) {
  return `qinglong3-release-set-${identity.version}-${identity.releaseScope}.json`;
}

function manifestFileName(identity) {
  return `qinglong3-release-catalog-manifest-${identity.version}-${identity.releaseScope}.json`;
}

function reportFileName(identity) {
  return `qinglong3-release-catalog-consumption-${identity.version}-${identity.releaseScope}.json`;
}

function catalogIdentity(identity) {
  const repository = `ghcr.io/${identity.repositoryOwner}/qinglong3-release-catalog`;
  return Object.freeze({
    repository,
    discovery: `${repository}:v${identity.version}-${identity.releaseScope}`,
    workflow: `${identity.sourceRepository}/${WORKFLOW}`,
    workflowIdentity: `https://github.com/${identity.sourceRepository}/${WORKFLOW}@${identity.sourceRef}`,
  });
}

function argvDigest(args) {
  return sha256(Buffer.from(JSON.stringify(args), 'utf8'));
}

function runStep(tool, name, args, env, timeoutMs) {
  verifyExecutable(tool);
  const result = spawnSync(tool.path, args, {
    encoding: 'buffer',
    env,
    timeout: timeoutMs,
    maxBuffer: MAX_TRANSCRIPT_BYTES,
    windowsHide: true,
  });
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr
    : Buffer.alloc(0);
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    stdout.length > MAX_TRANSCRIPT_BYTES ||
    stderr.length > MAX_TRANSCRIPT_BYTES
  ) {
    stdout.fill(0);
    stderr.fill(0);
    fail(`${name} did not complete successfully`);
  }
  return Object.freeze({
    record: Object.freeze({
      sequence: 0,
      name,
      tool: tool.name,
      executableSha256: tool.sha256,
      argvSha256: argvDigest(args),
      stdoutBytes: stdout.length,
      stdoutSha256: sha256(stdout),
      stderrBytes: stderr.length,
      stderrSha256: sha256(stderr),
      exitCode: 0,
    }),
    stdout,
    stderr,
  });
}

function parseDigestOutput(bytes) {
  const text = bytes.toString('utf8');
  const digest = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (
    !DIGEST_PATTERN.test(digest) ||
    (text !== digest && text !== `${digest}\n`)
  ) {
    fail('catalog discovery did not resolve to one exact digest');
  }
  return digest;
}

function parseCanonicalReleaseSet(bytes, identity) {
  if (bytes.length < 2 || bytes.length > MAX_ARTIFACT_BYTES) {
    fail('release set exceeds the bounded artifact size');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    fail('release set must be valid UTF-8');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('release set must contain valid JSON');
  }
  if (canonicalJson(value) !== text) {
    fail('release set must use exact canonical JSON encoding');
  }
  const inspection = inspectReleaseSet(value, identity);
  return Object.freeze({ value, inspection });
}

function parseManifest(bytes, manifestDigest, plan) {
  if (bytes.length < 2 || bytes.length > MAX_ARTIFACT_BYTES) {
    fail('catalog manifest exceeds the bounded artifact size');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    fail('catalog manifest must be valid UTF-8');
  }
  const receipt = createCatalogReceipt(plan, text, manifestDigest);
  return Object.freeze({ text, receipt });
}

function withSequence(records) {
  return records.map((record, index) =>
    Object.freeze({ ...record, sequence: index + 1 }),
  );
}

function expectedArguments(identity, catalog, immutable, fileName) {
  return Object.freeze([
    Object.freeze(['image', 'digest', catalog.discovery]),
    Object.freeze([
      'verify',
      '--certificate-identity',
      catalog.workflowIdentity,
      '--certificate-oidc-issuer',
      'https://token.actions.githubusercontent.com',
      immutable,
    ]),
    Object.freeze([
      'attestation',
      'verify',
      `oci://${immutable}`,
      '--repo',
      identity.sourceRepository,
      '--signer-workflow',
      catalog.workflow,
      '--source-digest',
      identity.sourceRevision,
      '--source-ref',
      identity.sourceRef,
      '--deny-self-hosted-runners',
      '--bundle-from-oci',
    ]),
    Object.freeze(['artifact', 'get', '--file', fileName, immutable]),
    Object.freeze(['manifest', 'get', immutable, '--format', 'raw-body']),
    Object.freeze(['image', 'digest', catalog.discovery]),
  ]);
}

function createReport({
  identity,
  catalog,
  manifestDigest,
  plan,
  receipt,
  releaseSet,
  releaseSetBytes,
  manifestBytes,
  tools,
  steps,
  observedAt,
}) {
  const unsigned = {
    schemaVersion: 1,
    schema: SCHEMA,
    observedAt,
    release: {
      version: identity.version,
      sourceRevision: identity.sourceRevision,
      sourceRef: identity.sourceRef,
      scope: identity.releaseScope,
    },
    sourceRepository: identity.sourceRepository,
    workflowIdentity: catalog.workflowIdentity,
    discovery: {
      reference: catalog.discovery,
      authority: 'none',
      initialDigest: manifestDigest,
      finalDigest: manifestDigest,
      stableDuringCeremony: true,
    },
    catalog: {
      repository: 'qinglong3-release-catalog',
      immutableReference: `${catalog.repository}@${manifestDigest}`,
      manifestDigest,
      artifactType: ARTIFACT_TYPE,
      planDigest: plan.planDigest,
      reconstructedReceiptDigest: receipt.receiptDigest,
    },
    releaseSet: {
      schema: RELEASE_SET_SCHEMA,
      releaseSetDigest: releaseSet.value.releaseSetDigest,
      fileName: releaseSetFileName(identity),
      contentDigest: sha256(releaseSetBytes),
      bytes: releaseSetBytes.length,
      imageCount: releaseSet.inspection.imageCount,
      images: [...releaseSet.inspection.images],
      references: [...releaseSet.inspection.references],
    },
    files: {
      releaseSet: {
        name: releaseSetFileName(identity),
        bytes: releaseSetBytes.length,
        sha256: sha256(releaseSetBytes),
      },
      catalogManifest: {
        name: manifestFileName(identity),
        bytes: manifestBytes.length,
        sha256: sha256(manifestBytes),
      },
    },
    tools: TOOL_NAMES.map((name) => ({
      name,
      sizeBytes: tools[name].sizeBytes,
      sha256: tools[name].sha256,
    })),
    verification: {
      discoveryResolvedTwice: true,
      discoveryStable: true,
      keylessSignature: 'exact_workflow_identity',
      githubProvenance: 'source_tag_and_revision_bound',
      releaseSetInspection: 'standalone_structure_identity_and_self_digest',
      remoteManifestStructure: 'exact',
      catalogReceiptReconstructed: true,
      outputBytes: 'exact_downloaded_bytes',
    },
    steps,
    claims: {
      externalToolResults: 'exit_zero_with_digest_only_transcript',
      offlineAudit: 'structure_identity_manifest_and_self_digest',
      networkAccess: 'registry_and_github_verification_only',
      workstationFileWrites: 'private_temporary_only_plus_final_bundle',
      registryMutation: false,
      githubMutation: false,
      deploymentMutation: false,
      credentialsIncluded: false,
      discoveryTagAuthority: 'none',
      actionAuthority: 'none',
    },
  };
  return Object.freeze({
    ...unsigned,
    contentDigest: sha256(JSON.stringify(unsigned)),
  });
}

function writeNoReplace(filePath, bytes) {
  let descriptor = -1;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_CLOEXEC ?? 0) |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count < 1) fail('evidence file write was incomplete');
      offset += count;
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof QingLong3ReleaseCatalogConsumptionError) throw error;
    fail('evidence file could not be created without replacement');
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function publishBundle(
  output,
  identity,
  releaseSetBytes,
  manifestBytes,
  report,
) {
  const parent = canonicalPrivateDirectory(output.parent.path, 'output parent');
  if (
    parent.dev !== output.parent.dev ||
    parent.ino !== output.parent.ino ||
    fs.existsSync(output.path)
  ) {
    fail('output directory changed before publication');
  }
  try {
    fs.mkdirSync(output.path, { mode: 0o700 });
  } catch {
    fail('output directory could not be created without replacement');
  }
  writeNoReplace(
    path.join(output.path, releaseSetFileName(identity)),
    releaseSetBytes,
  );
  writeNoReplace(
    path.join(output.path, manifestFileName(identity)),
    manifestBytes,
  );
  writeNoReplace(
    path.join(output.path, reportFileName(identity)),
    Buffer.from(canonicalJson(report), 'utf8'),
  );
  const descriptor = fs.openSync(output.path, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readBundleFile(directory, name, maximumBytes, requireCanonical) {
  const filePath = path.join(directory, name);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail(`bundle file is missing: ${name}`);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > maximumBytes ||
    stat.uid !== currentUid() ||
    (stat.mode & 0o077) !== 0 ||
    fs.realpathSync(filePath) !== filePath
  ) {
    fail(`bundle file is not one owner-private canonical file: ${name}`);
  }
  const bytes = fs.readFileSync(filePath);
  if (requireCanonical) {
    const text = bytes.toString('utf8');
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      fail(`bundle file must contain valid JSON: ${name}`);
    }
    if (canonicalJson(value) !== text) {
      fail(`bundle file must use canonical JSON: ${name}`);
    }
    return Object.freeze({ bytes, value });
  }
  return Object.freeze({ bytes });
}

function validateDynamicReport(report, identity, catalog, manifestDigest) {
  if (
    !exactKeys(report, [
      'schemaVersion',
      'schema',
      'observedAt',
      'release',
      'sourceRepository',
      'workflowIdentity',
      'discovery',
      'catalog',
      'releaseSet',
      'files',
      'tools',
      'verification',
      'steps',
      'claims',
      'contentDigest',
    ]) ||
    report.schemaVersion !== 1 ||
    report.schema !== SCHEMA ||
    typeof report.observedAt !== 'string' ||
    Number.isNaN(Date.parse(report.observedAt)) ||
    new Date(report.observedAt).toISOString() !== report.observedAt ||
    !Array.isArray(report.tools) ||
    report.tools.length !== TOOL_NAMES.length ||
    !Array.isArray(report.steps) ||
    report.steps.length !== 6 ||
    !DIGEST_PATTERN.test(report.contentDigest || '')
  ) {
    fail('consumption report shape is invalid');
  }
  const tools = {};
  for (let index = 0; index < TOOL_NAMES.length; index += 1) {
    const tool = report.tools[index];
    const name = TOOL_NAMES[index];
    if (
      !exactKeys(tool, ['name', 'sizeBytes', 'sha256']) ||
      tool.name !== name ||
      !Number.isSafeInteger(tool.sizeBytes) ||
      tool.sizeBytes < 2 ||
      tool.sizeBytes > MAX_TOOL_BYTES ||
      !DIGEST_PATTERN.test(tool.sha256 || '')
    ) {
      fail('consumption report tool evidence is invalid');
    }
    tools[name] = tool;
  }
  const immutable = `${catalog.repository}@${manifestDigest}`;
  const arguments_ = expectedArguments(
    identity,
    catalog,
    immutable,
    releaseSetFileName(identity),
  );
  const names = [
    'discovery_digest_before',
    'keyless_signature',
    'catalog_provenance',
    'release_set_download',
    'catalog_manifest_download',
    'discovery_digest_after',
  ];
  const toolNames = ['regctl', 'cosign', 'gh', 'regctl', 'regctl', 'regctl'];
  for (let index = 0; index < report.steps.length; index += 1) {
    const step = report.steps[index];
    const tool = tools[toolNames[index]];
    if (
      !exactKeys(step, [
        'sequence',
        'name',
        'tool',
        'executableSha256',
        'argvSha256',
        'stdoutBytes',
        'stdoutSha256',
        'stderrBytes',
        'stderrSha256',
        'exitCode',
      ]) ||
      step.sequence !== index + 1 ||
      step.name !== names[index] ||
      step.tool !== toolNames[index] ||
      step.executableSha256 !== tool.sha256 ||
      step.argvSha256 !== argvDigest(arguments_[index]) ||
      !Number.isSafeInteger(step.stdoutBytes) ||
      step.stdoutBytes < 0 ||
      step.stdoutBytes > MAX_TRANSCRIPT_BYTES ||
      !DIGEST_PATTERN.test(step.stdoutSha256 || '') ||
      !Number.isSafeInteger(step.stderrBytes) ||
      step.stderrBytes < 0 ||
      step.stderrBytes > MAX_TRANSCRIPT_BYTES ||
      !DIGEST_PATTERN.test(step.stderrSha256 || '') ||
      (step.stdoutBytes === 0 &&
        step.stdoutSha256 !== sha256(Buffer.alloc(0))) ||
      (step.stderrBytes === 0 &&
        step.stderrSha256 !== sha256(Buffer.alloc(0))) ||
      step.exitCode !== 0
    ) {
      fail('consumption report step evidence is invalid');
    }
  }
  const digestOutputs = [
    Buffer.from(manifestDigest, 'utf8'),
    Buffer.from(`${manifestDigest}\n`, 'utf8'),
  ];
  for (const index of [0, 5]) {
    if (
      !digestOutputs.some(
        (bytes) =>
          report.steps[index].stdoutBytes === bytes.length &&
          report.steps[index].stdoutSha256 === sha256(bytes),
      )
    ) {
      fail('discovery digest transcript is invalid');
    }
  }
  return Object.freeze({ tools, steps: report.steps });
}

function auditCeremonyBundle(options) {
  const identity = validateIdentity(options);
  const catalog = catalogIdentity(identity);
  const directory = canonicalPrivateDirectory(
    resolveCanonicalAbsolute(options.outputDirectory, 'output directory'),
    'output directory',
  );
  const expectedNames = [
    manifestFileName(identity),
    reportFileName(identity),
    releaseSetFileName(identity),
  ].sort();
  if (
    JSON.stringify(fs.readdirSync(directory.path).sort()) !==
    JSON.stringify(expectedNames)
  ) {
    fail('consumption bundle must contain the exact three evidence files');
  }
  const releaseFile = readBundleFile(
    directory.path,
    releaseSetFileName(identity),
    MAX_ARTIFACT_BYTES,
    true,
  );
  const manifestFile = readBundleFile(
    directory.path,
    manifestFileName(identity),
    MAX_ARTIFACT_BYTES,
    false,
  );
  const reportFile = readBundleFile(
    directory.path,
    reportFileName(identity),
    MAX_REPORT_BYTES,
    true,
  );
  const releaseSet = parseCanonicalReleaseSet(releaseFile.bytes, identity);
  const manifestDigest = sha256(manifestFile.bytes);
  const plan = createCatalogPlan(releaseSet.value, identity);
  const manifest = parseManifest(manifestFile.bytes, manifestDigest, plan);
  const dynamic = validateDynamicReport(
    reportFile.value,
    identity,
    catalog,
    manifestDigest,
  );
  const downloadStep = reportFile.value.steps[3];
  const manifestStep = reportFile.value.steps[4];
  if (
    downloadStep.stdoutBytes !== releaseFile.bytes.length ||
    downloadStep.stdoutSha256 !== sha256(releaseFile.bytes) ||
    manifestStep.stdoutBytes !== manifestFile.bytes.length ||
    manifestStep.stdoutSha256 !== manifestDigest
  ) {
    fail('download transcripts differ from the durable bundle bytes');
  }
  const expected = createReport({
    identity,
    catalog,
    manifestDigest,
    plan,
    receipt: manifest.receipt,
    releaseSet,
    releaseSetBytes: releaseFile.bytes,
    manifestBytes: manifestFile.bytes,
    tools: dynamic.tools,
    steps: dynamic.steps,
    observedAt: reportFile.value.observedAt,
  });
  if (JSON.stringify(reportFile.value) !== JSON.stringify(expected)) {
    fail('consumption report differs from the verified bundle');
  }
  return Object.freeze({
    compatible: true,
    releaseScope: identity.releaseScope,
    sourceRepository: identity.sourceRepository,
    workflowIdentity: catalog.workflowIdentity,
    releaseSetDigest: releaseSet.value.releaseSetDigest,
    catalogManifestDigest: manifestDigest,
    immutableReference: `${catalog.repository}@${manifestDigest}`,
    imageCount: releaseSet.inspection.imageCount,
    discoveryTagAuthority: 'none',
    externalToolResultsReplayed: false,
    deploymentMutation: false,
    contentDigest: expected.contentDigest,
    releaseSet: releaseSet.value,
  });
}

function runCeremony(options) {
  const identity = validateIdentity(options);
  const output = preflightOutputDirectory(options.outputDirectory);
  const tools = Object.freeze(
    Object.fromEntries(
      TOOL_NAMES.map((name) => [name, executable(options[name], name)]),
    ),
  );
  const identities = TOOL_NAMES.map(
    (name) => `${tools[name].dev}:${tools[name].ino}`,
  );
  if (new Set(identities).size !== identities.length) {
    fail('workstation tools must be three distinct executables');
  }
  const catalog = catalogIdentity(identity);
  const temporary = fs.mkdtempSync(
    path.join(output.parent.path, '.ql3-release-catalog-consumption-'),
  );
  const records = [];
  const transcripts = [];
  let token;
  const keep = (result) => {
    records.push(result.record);
    transcripts.push(result.stdout, result.stderr);
    return result;
  };
  try {
    fs.chmodSync(temporary, 0o700);
    const cacheDirectory = path.join(temporary, 'cache');
    const configDirectory = path.join(temporary, 'config');
    const temporaryDirectory = path.join(temporary, 'tmp');
    for (const directory of [
      cacheDirectory,
      configDirectory,
      temporaryDirectory,
    ]) {
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    token = readPrivateToken(options.githubTokenFile);
    if (
      TOOL_NAMES.some(
        (name) =>
          tools[name].dev === token.dev && tools[name].ino === token.ino,
      )
    ) {
      fail('GitHub token file cannot alias a workstation executable');
    }
    const publicEnv = Object.freeze({
      LANG: 'C',
      LC_ALL: 'C',
      NO_COLOR: '1',
      GH_PROMPT_DISABLED: '1',
      XDG_CACHE_HOME: cacheDirectory,
      XDG_CONFIG_HOME: configDirectory,
      TMPDIR: temporaryDirectory,
    });
    const githubEnv = Object.freeze({ ...publicEnv, GH_TOKEN: token.token });
    const before = keep(
      runStep(
        tools.regctl,
        'discovery_digest_before',
        ['image', 'digest', catalog.discovery],
        publicEnv,
        300_000,
      ),
    );
    const manifestDigest = parseDigestOutput(before.stdout);
    const immutable = `${catalog.repository}@${manifestDigest}`;
    keep(
      runStep(
        tools.cosign,
        'keyless_signature',
        [
          'verify',
          '--certificate-identity',
          catalog.workflowIdentity,
          '--certificate-oidc-issuer',
          'https://token.actions.githubusercontent.com',
          immutable,
        ],
        publicEnv,
        300_000,
      ),
    );
    keep(
      runStep(
        tools.gh,
        'catalog_provenance',
        [
          'attestation',
          'verify',
          `oci://${immutable}`,
          '--repo',
          identity.sourceRepository,
          '--signer-workflow',
          catalog.workflow,
          '--source-digest',
          identity.sourceRevision,
          '--source-ref',
          identity.sourceRef,
          '--deny-self-hosted-runners',
          '--bundle-from-oci',
        ],
        githubEnv,
        300_000,
      ),
    );
    const downloaded = keep(
      runStep(
        tools.regctl,
        'release_set_download',
        ['artifact', 'get', '--file', releaseSetFileName(identity), immutable],
        publicEnv,
        300_000,
      ),
    );
    const releaseSet = parseCanonicalReleaseSet(downloaded.stdout, identity);
    const plan = createCatalogPlan(releaseSet.value, identity);
    const rawManifest = keep(
      runStep(
        tools.regctl,
        'catalog_manifest_download',
        ['manifest', 'get', immutable, '--format', 'raw-body'],
        publicEnv,
        300_000,
      ),
    );
    const manifest = parseManifest(rawManifest.stdout, manifestDigest, plan);
    const after = keep(
      runStep(
        tools.regctl,
        'discovery_digest_after',
        ['image', 'digest', catalog.discovery],
        publicEnv,
        300_000,
      ),
    );
    if (parseDigestOutput(after.stdout) !== manifestDigest) {
      fail('catalog discovery changed during the ceremony');
    }
    for (const tool of Object.values(tools)) verifyExecutable(tool);
    const report = createReport({
      identity,
      catalog,
      manifestDigest,
      plan,
      receipt: manifest.receipt,
      releaseSet,
      releaseSetBytes: downloaded.stdout,
      manifestBytes: rawManifest.stdout,
      tools,
      steps: withSequence(records),
      observedAt: new Date().toISOString(),
    });
    publishBundle(
      output,
      identity,
      downloaded.stdout,
      rawManifest.stdout,
      report,
    );
    return report;
  } finally {
    if (token) token.bytes.fill(0);
    for (const transcript of transcripts) transcript.fill(0);
    try {
      fs.rmSync(temporary, { recursive: true, force: true });
    } catch {
      // Only a private ceremony scratch directory is eligible for cleanup.
    }
  }
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) {
      fail('arguments are invalid');
    }
    values[match[1]] = match[2];
  }
  const identity = [
    'mode',
    'output-directory',
    'release-scope',
    'repository-owner',
    'source-ref',
    'source-repository',
    'source-revision',
    'version',
  ];
  const expected =
    values.mode === 'create'
      ? [...identity, 'cosign', 'gh', 'github-token-file', 'regctl']
      : values.mode === 'audit'
      ? identity
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
    repositoryOwner: values['repository-owner'],
    sourceRepository: values['source-repository'],
    outputDirectory: values['output-directory'],
    ...(values.regctl ? { regctl: values.regctl } : {}),
    ...(values.cosign ? { cosign: values.cosign } : {}),
    ...(values.gh ? { gh: values.gh } : {}),
    ...(values['github-token-file']
      ? { githubTokenFile: values['github-token-file'] }
      : {}),
  });
}

function runCli(argv, output = process.stdout) {
  const options = parseArguments(argv);
  const result =
    options.mode === 'create'
      ? runCeremony(options)
      : auditCeremonyBundle(options);
  output.write(
    canonicalJson({
      schemaVersion: 1,
      component: 'qinglong3-release-catalog-consumption-ceremony',
      mode: options.mode,
      compatible: true,
      releaseScope: options.releaseScope,
      immutableReference:
        options.mode === 'create'
          ? result.catalog.immutableReference
          : result.immutableReference,
      contentDigest: result.contentDigest,
    }),
  );
  return result;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error
          ? error.message
          : 'release catalog consumption failed'
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  SCHEMA,
  QingLong3ReleaseCatalogConsumptionError,
  auditCeremonyBundle,
  catalogIdentity,
  parseArguments,
  runCeremony,
  runCli,
});
