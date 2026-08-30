#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { auditClusterImageSbom } = require('./ql3-cluster-image-sbom.cjs');
const { readReleaseIdentity } = require('./lib/ql3-release-identity.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const SCHEMA = 'qinglong/alpha-local-trial-kit@v8';
const VERIFICATION_SCHEMA = 'qinglong/alpha-local-trial-kit-verification@v6';
const QUICKSTART_TEMPLATE = path.join(
  DEFAULT_ROOT,
  'scripts/templates/ql3-local-alpha-quickstart.sh',
);
const UPGRADE_READINESS_TEMPLATE = path.join(
  DEFAULT_ROOT,
  'scripts/templates/ql3-local-alpha-upgrade-readiness.sh',
);
const UPGRADE_REHEARSAL_TEMPLATE = path.join(
  DEFAULT_ROOT,
  'scripts/templates/ql3-local-alpha-upgrade-rehearsal.sh',
);
const UPGRADE_CUTOVER_REHEARSAL_TEMPLATE = path.join(
  DEFAULT_ROOT,
  'scripts/templates/ql3-local-alpha-upgrade-cutover-rehearsal.sh',
);
const ARCHITECTURES = Object.freeze(['amd64', 'arm64']);
const VARIANTS = Object.freeze(['headless', 'console']);
const ARCHIVE_MIN_BYTES = 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_README_BYTES = 512 * 1024;
const MAX_QUICKSTART_BYTES = 256 * 1024;
const MAX_UPGRADE_READINESS_BYTES = 256 * 1024;
const MAX_UPGRADE_REHEARSAL_BYTES = 256 * 1024;
const MAX_UPGRADE_CUTOVER_REHEARSAL_BYTES = 512 * 1024;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const FILES = Object.freeze({
  applicationSbom: 'qinglong3-local-application.cdx.json',
  operatorSbom: 'qinglong3-local-operator.cdx.json',
  verificationEvidence: 'verification-evidence.json',
  quickstart: 'quickstart.sh',
  upgradeReadiness: 'upgrade-readiness.sh',
  upgradeRehearsal: 'upgrade-rehearsal.sh',
  upgradeCutoverRehearsal: 'upgrade-cutover-rehearsal.sh',
  readme: 'README.md',
  manifest: 'manifest.json',
  checksums: 'SHA256SUMS',
});
const VERIFICATION = Object.freeze({
  osVulnerabilityPolicy: 'passed',
  sbomInventoryReconciliation: 'passed',
  router128MiBEntrypoint: 'passed',
  operator128MiBEntrypoint: 'passed',
  operatorPackageInventory: 'passed',
  freshOwnerJourney: 'passed',
  ownerCredentialPresentation: 'passed',
  edgeFreshLifecycle: 'passed',
  standaloneFreshLifecycle: 'passed',
  localApiCancellation: 'passed',
  legacyUpgradeReadiness: 'passed',
  legacyUpgradeStage: 'passed',
  legacyUpgradeCutover: 'passed',
});

function verificationGates(variant) {
  return Object.freeze({
    ...VERIFICATION,
    legacyUpgradeCutover: variant === 'headless' ? 'passed' : 'not_applicable',
    consoleLiveJourney: variant === 'console' ? 'passed' : 'not_applicable',
    firstAutomationJourney: variant === 'console' ? 'passed' : 'not_applicable',
  });
}
const WORKFLOW_IDENTITY = Object.freeze({
  repository: 'whyour/qinglong',
  workflowRef: 'whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next',
  event: 'workflow_dispatch',
  job: 'local-image',
});
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
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    fail(`${label} must contain valid JSON`);
  }
  return parsed;
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

function saveDockerImages(images, archivePath) {
  childProcess.execFileSync(
    'docker',
    ['image', 'save', '--output', archivePath, ...images],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
}

function validateImageReference(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/u.test(value)
  ) {
    fail(`${label} image reference is invalid`);
  }
  return value;
}

function normalizeImageInspection(inspection, options) {
  const { architecture, reference, revision, role, variant, version } = options;
  const labels = inspection?.Config?.Labels;
  const expectedTitle =
    role === 'application'
      ? variant === 'console'
        ? 'QingLong 3.0 Local Console Application'
        : 'QingLong 3.0 Local Application'
      : 'QingLong 3.0 Local Operator';
  if (
    !SHA256_PATTERN.test(inspection?.Id || '') ||
    inspection?.Os !== 'linux' ||
    inspection?.Architecture !== architecture ||
    inspection?.Config?.User !== '65532:65532' ||
    labels?.['org.opencontainers.image.title'] !== expectedTitle ||
    labels?.['org.opencontainers.image.source'] !==
      'https://github.com/whyour/qinglong' ||
    labels?.['org.opencontainers.image.revision'] !== revision ||
    labels?.['org.opencontainers.image.version'] !== version
  ) {
    fail(`${role} image identity is incompatible`);
  }
  if (
    role === 'application' &&
    (labels?.['io.qinglong.profile'] !==
      (variant === 'console'
        ? 'edge-application-api,standalone-application-api'
        : 'edge,standalone') ||
      labels?.['io.qinglong.ai'] !== 'excluded' ||
      (variant === 'console'
        ? labels?.['io.qinglong.local.console'] !== 'offline-loopback'
        : labels?.['io.qinglong.local.console'] !== undefined))
  ) {
    fail('application image profile is incompatible');
  }
  if (
    role === 'operator' &&
    (labels?.['io.qinglong.lifecycle'] !== 'short-lived' ||
      labels?.['io.qinglong.authority'] !== 'local-owner-management' ||
      labels?.['io.qinglong.network'] !== 'none-by-default')
  ) {
    fail('operator image authority is incompatible');
  }
  return {
    reference,
    id: inspection.Id,
    os: 'linux',
    architecture,
    user: '65532:65532',
  };
}

function validateSbom(document, options) {
  auditClusterImageSbom(document, {
    root: options.root,
    image: options.profile,
  });
  const properties = Object.fromEntries(
    (document.metadata?.properties || []).map((entry) => [
      entry.name,
      entry.value,
    ]),
  );
  if (
    document.metadata?.component?.version !== options.version ||
    properties['qinglong:image-profile'] !== options.profile
  ) {
    fail(`${options.profile} SBOM identity is incompatible`);
  }
}

function validateOfflineSbom(document, profile, version) {
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
    document.metadata?.component?.version !== version ||
    properties['qinglong:image-profile'] !== profile
  ) {
    fail(`${profile} offline SBOM identity is incompatible`);
  }
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
      'architecture',
      'variant',
      'applicationImageId',
      'operatorImageId',
    ]) ||
    document.subject.version !== expected.version ||
    document.subject.sourceRevision !== expected.sourceRevision ||
    document.subject.architecture !== expected.architecture ||
    document.subject.variant !== expected.variant ||
    document.subject.applicationImageId !== expected.applicationImageId ||
    document.subject.operatorImageId !== expected.operatorImageId ||
    document.subject.applicationImageId === document.subject.operatorImageId ||
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
    !exactKeys(
      document.gates,
      Object.keys(verificationGates(expected.variant)),
    ) ||
    JSON.stringify(document.gates) !==
      JSON.stringify(verificationGates(expected.variant))
  ) {
    fail('trial kit verification evidence is incompatible');
  }
  return document;
}

function validateVerificationOptions(options) {
  const root = fs.realpathSync(path.resolve(options.root || DEFAULT_ROOT));
  const output = path.resolve(options.output || '');
  const parent = path.dirname(output);
  if (
    !ARCHITECTURES.includes(options.architecture) ||
    !VARIANTS.includes(options.variant) ||
    !REVISION_PATTERN.test(options.sourceRevision || '') ||
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
    fail('verification evidence identity or output is invalid');
  }
  return {
    root,
    output,
    architecture: options.architecture,
    variant: options.variant,
    sourceRevision: options.sourceRevision,
    applicationImage: validateImageReference(
      options.applicationImage,
      'application',
    ),
    operatorImage: validateImageReference(options.operatorImage, 'operator'),
    repository: options.repository,
    workflowRef: options.workflowRef,
    workflowSha: options.workflowSha,
    eventName: options.eventName,
    job: options.job,
    runId: options.runId,
    runAttempt: options.runAttempt,
  };
}

function createLocalAlphaTrialKitVerificationEvidence(options, adapters = {}) {
  const normalized = validateVerificationOptions(options);
  const release = readReleaseIdentity(normalized.root);
  const inspectImage = adapters.inspectImage || inspectDockerImage;
  const application = normalizeImageInspection(
    inspectImage(normalized.applicationImage),
    {
      architecture: normalized.architecture,
      reference: normalized.applicationImage,
      revision: normalized.sourceRevision,
      role: 'application',
      variant: normalized.variant,
      version: release.version,
    },
  );
  const operator = normalizeImageInspection(
    inspectImage(normalized.operatorImage),
    {
      architecture: normalized.architecture,
      reference: normalized.operatorImage,
      revision: normalized.sourceRevision,
      role: 'operator',
      variant: normalized.variant,
      version: release.version,
    },
  );
  if (application.id === operator.id) fail('trial kit images must be distinct');
  const evidence = {
    schemaVersion: 1,
    schema: VERIFICATION_SCHEMA,
    subject: {
      version: release.version,
      sourceRevision: normalized.sourceRevision,
      architecture: normalized.architecture,
      variant: normalized.variant,
      applicationImageId: application.id,
      operatorImageId: operator.id,
    },
    workflow: {
      repository: normalized.repository,
      workflowRef: normalized.workflowRef,
      workflowSha: normalized.workflowSha,
      event: normalized.eventName,
      job: normalized.job,
      runId: normalized.runId,
      runAttempt: normalized.runAttempt,
    },
    gates: { ...verificationGates(normalized.variant) },
  };
  validateVerificationEvidence(evidence, evidence.subject);
  writeExclusive(normalized.output, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

function archiveName(architecture, variant = 'headless') {
  return variant === 'console'
    ? `qinglong3-local-console-trial-kit-${architecture}.docker.tar`
    : `qinglong3-local-trial-kit-${architecture}.docker.tar`;
}

function renderQuickstart(identity) {
  const template = fs.readFileSync(
    assertCanonicalFile(
      QUICKSTART_TEMPLATE,
      MAX_QUICKSTART_BYTES,
      'quickstart template',
    ),
    'utf8',
  );
  const replacements = Object.freeze({
    '@@APPLICATION_IMAGE@@': identity.images.application.reference,
    '@@APPLICATION_ID@@': identity.images.application.id,
    '@@OPERATOR_IMAGE@@': identity.images.operator.reference,
    '@@OPERATOR_ID@@': identity.images.operator.id,
    '@@ARCHITECTURE@@': identity.architecture,
    '@@SOURCE_REVISION@@': identity.sourceRevision,
    '@@ARCHIVE@@': identity.archive.file,
    '@@VARIANT@@': identity.variant,
  });
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(token, value);
  }
  if (/@@[A-Z_]+@@/u.test(rendered)) {
    fail('quickstart template contains an unresolved token');
  }
  return rendered;
}

function renderUpgradeReadiness(identity) {
  const template = fs.readFileSync(
    assertCanonicalFile(
      UPGRADE_READINESS_TEMPLATE,
      MAX_UPGRADE_READINESS_BYTES,
      'upgrade readiness template',
    ),
    'utf8',
  );
  const replacements = Object.freeze({
    '@@OPERATOR_IMAGE@@': identity.images.operator.reference,
    '@@OPERATOR_ID@@': identity.images.operator.id,
    '@@ARCHITECTURE@@': identity.architecture,
    '@@SOURCE_REVISION@@': identity.sourceRevision,
    '@@ARCHIVE@@': identity.archive.file,
  });
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(token, value);
  }
  if (/@@[A-Z_]+@@/u.test(rendered)) {
    fail('upgrade readiness template contains an unresolved token');
  }
  return rendered;
}

function renderUpgradeRehearsal(identity) {
  const template = fs.readFileSync(
    assertCanonicalFile(
      UPGRADE_REHEARSAL_TEMPLATE,
      MAX_UPGRADE_REHEARSAL_BYTES,
      'upgrade rehearsal template',
    ),
    'utf8',
  );
  const replacements = Object.freeze({
    '@@OPERATOR_IMAGE@@': identity.images.operator.reference,
    '@@OPERATOR_ID@@': identity.images.operator.id,
    '@@ARCHITECTURE@@': identity.architecture,
    '@@SOURCE_REVISION@@': identity.sourceRevision,
    '@@ARCHIVE@@': identity.archive.file,
  });
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(token, value);
  }
  if (/@@[A-Z_]+@@/u.test(rendered)) {
    fail('upgrade rehearsal template contains an unresolved token');
  }
  return rendered;
}

function renderUpgradeCutoverRehearsal(identity) {
  const template = fs.readFileSync(
    assertCanonicalFile(
      UPGRADE_CUTOVER_REHEARSAL_TEMPLATE,
      MAX_UPGRADE_CUTOVER_REHEARSAL_BYTES,
      'upgrade cutover rehearsal template',
    ),
    'utf8',
  );
  const replacements = Object.freeze({
    '@@APPLICATION_IMAGE@@': identity.images.application.reference,
    '@@APPLICATION_ID@@': identity.images.application.id,
    '@@OPERATOR_IMAGE@@': identity.images.operator.reference,
    '@@OPERATOR_ID@@': identity.images.operator.id,
    '@@ARCHITECTURE@@': identity.architecture,
    '@@SOURCE_REVISION@@': identity.sourceRevision,
    '@@ARCHIVE@@': identity.archive.file,
    '@@VARIANT@@': identity.variant,
  });
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(token, value);
  }
  if (/@@[A-Z_]+@@/u.test(rendered)) {
    fail('upgrade cutover rehearsal template contains an unresolved token');
  }
  return rendered;
}

function fileRecord(bundleRoot, name) {
  const filePath = path.join(bundleRoot, name);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2) {
    fail(`bundle file is invalid: ${name}`);
  }
  return {
    file: name,
    sha256: sha256File(filePath),
    bytes: stat.size,
  };
}

function checksumContents(bundleRoot, names) {
  return `${names
    .map(
      (name) => `${sha256File(path.join(bundleRoot, name)).slice(7)}  ${name}`,
    )
    .join('\n')}\n`;
}

function validateCreateOptions(options) {
  const root = fs.realpathSync(path.resolve(options.root || DEFAULT_ROOT));
  const outputRoot = path.resolve(options.outputRoot || '');
  const parent = path.dirname(outputRoot);
  if (
    !ARCHITECTURES.includes(options.architecture) ||
    !VARIANTS.includes(options.variant) ||
    !REVISION_PATTERN.test(options.sourceRevision || '') ||
    !path.isAbsolute(outputRoot) ||
    fs.existsSync(outputRoot) ||
    fs.realpathSync(parent) !== parent
  ) {
    fail('create identity or output is invalid');
  }
  return {
    root,
    outputRoot,
    architecture: options.architecture,
    variant: options.variant,
    sourceRevision: options.sourceRevision,
    applicationImage: validateImageReference(
      options.applicationImage,
      'application',
    ),
    operatorImage: validateImageReference(options.operatorImage, 'operator'),
    applicationSbom: assertCanonicalFile(
      options.applicationSbom,
      MAX_JSON_BYTES,
      'application SBOM',
    ),
    operatorSbom: assertCanonicalFile(
      options.operatorSbom,
      MAX_JSON_BYTES,
      'operator SBOM',
    ),
    verificationEvidence: assertCanonicalFile(
      options.verificationEvidence,
      MAX_JSON_BYTES,
      'trial kit verification evidence',
    ),
    readme: assertCanonicalFile(
      options.readme,
      MAX_README_BYTES,
      'trial kit README',
    ),
  };
}

function createLocalAlphaTrialKit(options, adapters = {}) {
  const normalized = validateCreateOptions(options);
  const release = readReleaseIdentity(normalized.root);
  const inspectImage = adapters.inspectImage || inspectDockerImage;
  const saveImages = adapters.saveImages || saveDockerImages;
  const applicationSbom = readBoundedJson(
    normalized.applicationSbom,
    'application SBOM',
  );
  const operatorSbom = readBoundedJson(
    normalized.operatorSbom,
    'operator SBOM',
  );
  const verificationEvidence = readBoundedJson(
    normalized.verificationEvidence,
    'trial kit verification evidence',
  );
  validateSbom(applicationSbom, {
    root: normalized.root,
    profile: normalized.variant === 'console' ? 'local-console' : 'local',
    version: release.version,
  });
  validateSbom(operatorSbom, {
    root: normalized.root,
    profile: 'local-operator',
    version: release.version,
  });
  const application = normalizeImageInspection(
    inspectImage(normalized.applicationImage),
    {
      architecture: normalized.architecture,
      reference: normalized.applicationImage,
      revision: normalized.sourceRevision,
      role: 'application',
      variant: normalized.variant,
      version: release.version,
    },
  );
  const operator = normalizeImageInspection(
    inspectImage(normalized.operatorImage),
    {
      architecture: normalized.architecture,
      reference: normalized.operatorImage,
      revision: normalized.sourceRevision,
      role: 'operator',
      variant: normalized.variant,
      version: release.version,
    },
  );
  if (application.id === operator.id) fail('trial kit images must be distinct');
  validateVerificationEvidence(verificationEvidence, {
    version: release.version,
    sourceRevision: normalized.sourceRevision,
    architecture: normalized.architecture,
    variant: normalized.variant,
    applicationImageId: application.id,
    operatorImageId: operator.id,
  });

  let created = false;
  try {
    fs.mkdirSync(normalized.outputRoot, { mode: 0o700 });
    created = true;
    const archive = archiveName(normalized.architecture, normalized.variant);
    const archivePath = path.join(normalized.outputRoot, archive);
    saveImages(
      [normalized.applicationImage, normalized.operatorImage],
      archivePath,
    );
    const archiveStat = fs.lstatSync(archivePath);
    if (
      !archiveStat.isFile() ||
      archiveStat.isSymbolicLink() ||
      archiveStat.size < ARCHIVE_MIN_BYTES
    ) {
      fail('Docker archive is invalid or unexpectedly small');
    }
    fs.chmodSync(archivePath, 0o600);
    copyExclusive(
      normalized.applicationSbom,
      path.join(normalized.outputRoot, FILES.applicationSbom),
    );
    copyExclusive(
      normalized.operatorSbom,
      path.join(normalized.outputRoot, FILES.operatorSbom),
    );
    copyExclusive(
      normalized.verificationEvidence,
      path.join(normalized.outputRoot, FILES.verificationEvidence),
    );
    copyExclusive(
      normalized.readme,
      path.join(normalized.outputRoot, FILES.readme),
    );
    const manifestIdentity = {
      sourceRevision: normalized.sourceRevision,
      architecture: normalized.architecture,
      variant: normalized.variant,
      archive: { file: archive },
      images: { application, operator },
    };
    writeExclusive(
      path.join(normalized.outputRoot, FILES.quickstart),
      renderQuickstart(manifestIdentity),
      0o700,
    );
    writeExclusive(
      path.join(normalized.outputRoot, FILES.upgradeReadiness),
      renderUpgradeReadiness(manifestIdentity),
      0o700,
    );
    writeExclusive(
      path.join(normalized.outputRoot, FILES.upgradeRehearsal),
      renderUpgradeRehearsal(manifestIdentity),
      0o700,
    );
    writeExclusive(
      path.join(normalized.outputRoot, FILES.upgradeCutoverRehearsal),
      renderUpgradeCutoverRehearsal(manifestIdentity),
      0o700,
    );
    const manifest = {
      schemaVersion: 9,
      schema: SCHEMA,
      maturity: 'alpha_candidate_not_public_release',
      product: 'local',
      version: release.version,
      sourceRevision: normalized.sourceRevision,
      architecture: normalized.architecture,
      variant: normalized.variant,
      archive: fileRecord(normalized.outputRoot, archive),
      images: { application, operator },
      sboms: {
        application: fileRecord(normalized.outputRoot, FILES.applicationSbom),
        operator: fileRecord(normalized.outputRoot, FILES.operatorSbom),
      },
      quickstart: fileRecord(normalized.outputRoot, FILES.quickstart),
      upgradeReadiness: fileRecord(
        normalized.outputRoot,
        FILES.upgradeReadiness,
      ),
      upgradeRehearsal: fileRecord(
        normalized.outputRoot,
        FILES.upgradeRehearsal,
      ),
      upgradeCutoverRehearsal: fileRecord(
        normalized.outputRoot,
        FILES.upgradeCutoverRehearsal,
      ),
      readme: fileRecord(normalized.outputRoot, FILES.readme),
      verification: fileRecord(
        normalized.outputRoot,
        FILES.verificationEvidence,
      ),
    };
    writeExclusive(
      path.join(normalized.outputRoot, FILES.manifest),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const checkedFiles = [
      archive,
      FILES.applicationSbom,
      FILES.operatorSbom,
      FILES.verificationEvidence,
      FILES.quickstart,
      FILES.upgradeReadiness,
      FILES.upgradeRehearsal,
      FILES.upgradeCutoverRehearsal,
      FILES.readme,
      FILES.manifest,
    ];
    writeExclusive(
      path.join(normalized.outputRoot, FILES.checksums),
      checksumContents(normalized.outputRoot, checkedFiles),
    );
    auditLocalAlphaTrialKit({ bundleRoot: normalized.outputRoot });
    return manifest;
  } catch (error) {
    if (created) {
      fs.rmSync(normalized.outputRoot, { recursive: true, force: true });
    }
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

function validateOfflineImage(image, role, manifest) {
  if (
    !exactKeys(image, ['reference', 'id', 'os', 'architecture', 'user']) ||
    validateImageReference(image.reference, role) !== image.reference ||
    !SHA256_PATTERN.test(image.id || '') ||
    image.os !== 'linux' ||
    image.architecture !== manifest.architecture ||
    image.user !== '65532:65532'
  ) {
    fail(`${role} manifest image identity is incompatible`);
  }
}

function auditLocalAlphaTrialKit(options) {
  const bundleRoot = fs.realpathSync(path.resolve(options.bundleRoot || ''));
  if (!fs.lstatSync(bundleRoot).isDirectory()) {
    fail('bundle root must be a canonical directory');
  }
  const manifest = readBoundedJson(
    path.join(bundleRoot, FILES.manifest),
    'trial kit manifest',
  );
  if (
    !exactKeys(manifest, [
      'schemaVersion',
      'schema',
      'maturity',
      'product',
      'version',
      'sourceRevision',
      'architecture',
      'variant',
      'archive',
      'images',
      'sboms',
      'quickstart',
      'upgradeReadiness',
      'upgradeRehearsal',
      'upgradeCutoverRehearsal',
      'readme',
      'verification',
    ]) ||
    manifest.schemaVersion !== 9 ||
    manifest.schema !== SCHEMA ||
    manifest.maturity !== 'alpha_candidate_not_public_release' ||
    manifest.product !== 'local' ||
    typeof manifest.version !== 'string' ||
    !REVISION_PATTERN.test(manifest.sourceRevision || '') ||
    !ARCHITECTURES.includes(manifest.architecture) ||
    !VARIANTS.includes(manifest.variant) ||
    !exactKeys(manifest.images, ['application', 'operator']) ||
    !exactKeys(manifest.sboms, ['application', 'operator'])
  ) {
    fail('trial kit manifest identity or shape is incompatible');
  }
  validateOfflineImage(manifest.images.application, 'application', manifest);
  validateOfflineImage(manifest.images.operator, 'operator', manifest);
  if (manifest.images.application.id === manifest.images.operator.id) {
    fail('trial kit images must be distinct');
  }
  const expectedArchive = archiveName(manifest.architecture, manifest.variant);
  validateFileRecord(manifest.archive, expectedArchive, bundleRoot);
  if (manifest.archive.bytes < ARCHIVE_MIN_BYTES) {
    fail('Docker archive is unexpectedly small');
  }
  validateFileRecord(
    manifest.sboms.application,
    FILES.applicationSbom,
    bundleRoot,
  );
  validateFileRecord(manifest.sboms.operator, FILES.operatorSbom, bundleRoot);
  validateFileRecord(
    manifest.verification,
    FILES.verificationEvidence,
    bundleRoot,
  );
  validateFileRecord(manifest.quickstart, FILES.quickstart, bundleRoot);
  const expectedQuickstart = renderQuickstart(manifest);
  const actualQuickstart = fs.readFileSync(
    assertCanonicalFile(
      path.join(bundleRoot, FILES.quickstart),
      MAX_QUICKSTART_BYTES,
      'quickstart',
    ),
    'utf8',
  );
  if (actualQuickstart !== expectedQuickstart) {
    fail('quickstart differs from the canonical deployment journey');
  }
  validateFileRecord(
    manifest.upgradeReadiness,
    FILES.upgradeReadiness,
    bundleRoot,
  );
  const expectedUpgradeReadiness = renderUpgradeReadiness(manifest);
  const actualUpgradeReadiness = fs.readFileSync(
    assertCanonicalFile(
      path.join(bundleRoot, FILES.upgradeReadiness),
      MAX_UPGRADE_READINESS_BYTES,
      'upgrade readiness',
    ),
    'utf8',
  );
  if (actualUpgradeReadiness !== expectedUpgradeReadiness) {
    fail('upgrade readiness differs from the canonical inspection journey');
  }
  validateFileRecord(
    manifest.upgradeRehearsal,
    FILES.upgradeRehearsal,
    bundleRoot,
  );
  const expectedUpgradeRehearsal = renderUpgradeRehearsal(manifest);
  const actualUpgradeRehearsal = fs.readFileSync(
    assertCanonicalFile(
      path.join(bundleRoot, FILES.upgradeRehearsal),
      MAX_UPGRADE_REHEARSAL_BYTES,
      'upgrade rehearsal',
    ),
    'utf8',
  );
  if (actualUpgradeRehearsal !== expectedUpgradeRehearsal) {
    fail('upgrade rehearsal differs from the canonical staging journey');
  }
  validateFileRecord(
    manifest.upgradeCutoverRehearsal,
    FILES.upgradeCutoverRehearsal,
    bundleRoot,
  );
  const expectedUpgradeCutoverRehearsal =
    renderUpgradeCutoverRehearsal(manifest);
  const actualUpgradeCutoverRehearsal = fs.readFileSync(
    assertCanonicalFile(
      path.join(bundleRoot, FILES.upgradeCutoverRehearsal),
      MAX_UPGRADE_CUTOVER_REHEARSAL_BYTES,
      'upgrade cutover rehearsal',
    ),
    'utf8',
  );
  if (actualUpgradeCutoverRehearsal !== expectedUpgradeCutoverRehearsal) {
    fail(
      'upgrade cutover rehearsal differs from the canonical cutover journey',
    );
  }
  validateFileRecord(manifest.readme, FILES.readme, bundleRoot);
  validateOfflineSbom(
    readBoundedJson(
      path.join(bundleRoot, FILES.applicationSbom),
      'application SBOM',
    ),
    manifest.variant === 'console' ? 'local-console' : 'local',
    manifest.version,
  );
  validateOfflineSbom(
    readBoundedJson(path.join(bundleRoot, FILES.operatorSbom), 'operator SBOM'),
    'local-operator',
    manifest.version,
  );
  const verificationEvidence = validateVerificationEvidence(
    readBoundedJson(
      path.join(bundleRoot, FILES.verificationEvidence),
      'trial kit verification evidence',
    ),
    {
      version: manifest.version,
      sourceRevision: manifest.sourceRevision,
      architecture: manifest.architecture,
      variant: manifest.variant,
      applicationImageId: manifest.images.application.id,
      operatorImageId: manifest.images.operator.id,
    },
  );
  const expectedFiles = [
    FILES.checksums,
    FILES.manifest,
    FILES.readme,
    FILES.applicationSbom,
    FILES.operatorSbom,
    FILES.verificationEvidence,
    FILES.quickstart,
    FILES.upgradeReadiness,
    FILES.upgradeRehearsal,
    FILES.upgradeCutoverRehearsal,
    expectedArchive,
  ].sort();
  const actualFiles = fs
    .readdirSync(bundleRoot, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail(`bundle contains a non-regular entry: ${entry.name}`);
      }
      return entry.name;
    })
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail('bundle file set is not closed');
  }
  const checkedFiles = [
    expectedArchive,
    FILES.applicationSbom,
    FILES.operatorSbom,
    FILES.verificationEvidence,
    FILES.quickstart,
    FILES.upgradeReadiness,
    FILES.upgradeRehearsal,
    FILES.upgradeCutoverRehearsal,
    FILES.readme,
    FILES.manifest,
  ];
  const expectedChecksums = checksumContents(bundleRoot, checkedFiles);
  const actualChecksums = fs.readFileSync(
    path.join(bundleRoot, FILES.checksums),
    'utf8',
  );
  if (actualChecksums !== expectedChecksums) {
    fail('SHA256SUMS differs from the closed bundle file set');
  }
  return Object.freeze({
    schemaVersion: 1,
    schema: 'qinglong/alpha-local-trial-kit-audit@v5',
    sourceRevision: manifest.sourceRevision,
    version: manifest.version,
    architecture: manifest.architecture,
    variant: manifest.variant,
    archiveSha256: manifest.archive.sha256,
    applicationImageId: manifest.images.application.id,
    operatorImageId: manifest.images.operator.id,
    quickstartSha256: manifest.quickstart.sha256,
    upgradeReadinessSha256: manifest.upgradeReadiness.sha256,
    upgradeRehearsalSha256: manifest.upgradeRehearsal.sha256,
    upgradeCutoverRehearsalSha256: manifest.upgradeCutoverRehearsal.sha256,
    verificationSha256: manifest.verification.sha256,
    workflowRunId: verificationEvidence.workflow.runId,
    workflowRunAttempt: verificationEvidence.workflow.runAttempt,
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
  if (values.mode === 'audit') {
    if (
      JSON.stringify(Object.keys(values).sort()) !==
      JSON.stringify(['bundle', 'mode'])
    ) {
      fail('audit arguments are invalid');
    }
    return { mode: 'audit', bundleRoot: path.resolve(values.bundle) };
  }
  if (values.mode === 'record-verification') {
    const expected = [
      'application-image',
      'architecture',
      'event',
      'job',
      'mode',
      'operator-image',
      'output',
      'repository',
      'run-attempt',
      'run-id',
      'source-revision',
      'variant',
      'workflow-ref',
      'workflow-sha',
    ];
    if (
      JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expected)
    ) {
      fail('record-verification arguments are invalid');
    }
    return {
      mode: 'record-verification',
      output: path.resolve(values.output),
      architecture: values.architecture,
      variant: values.variant,
      sourceRevision: values['source-revision'],
      applicationImage: values['application-image'],
      operatorImage: values['operator-image'],
      repository: values.repository,
      workflowRef: values['workflow-ref'],
      workflowSha: values['workflow-sha'],
      eventName: values.event,
      job: values.job,
      runId: values['run-id'],
      runAttempt: values['run-attempt'],
    };
  }
  if (values.mode === 'create') {
    const expected = [
      'application-image',
      'application-sbom',
      'architecture',
      'mode',
      'operator-image',
      'operator-sbom',
      'output',
      'readme',
      'source-revision',
      'variant',
      'verification-evidence',
    ];
    if (
      JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expected)
    ) {
      fail('create arguments are invalid');
    }
    return {
      mode: 'create',
      outputRoot: path.resolve(values.output),
      architecture: values.architecture,
      variant: values.variant,
      sourceRevision: values['source-revision'],
      applicationImage: values['application-image'],
      operatorImage: values['operator-image'],
      applicationSbom: path.resolve(values['application-sbom']),
      operatorSbom: path.resolve(values['operator-sbom']),
      verificationEvidence: path.resolve(values['verification-evidence']),
      readme: path.resolve(values.readme),
    };
  }
  fail('mode is invalid');
}

function runCli(argv) {
  const options = parseArguments(argv);
  let report;
  if (options.mode === 'record-verification') {
    report = createLocalAlphaTrialKitVerificationEvidence(options);
  } else if (options.mode === 'create') {
    report = createLocalAlphaTrialKit(options);
  } else {
    report = auditLocalAlphaTrialKit(options);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'trial kit bundle failed'}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  FILES,
  SCHEMA,
  VERIFICATION,
  VERIFICATION_SCHEMA,
  VARIANTS,
  archiveName,
  auditLocalAlphaTrialKit,
  createLocalAlphaTrialKit,
  createLocalAlphaTrialKitVerificationEvidence,
  parseArguments,
  runCli,
  sha256File,
});
