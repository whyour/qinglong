#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  auditLocalAlphaTrialKit,
  sha256File,
  VARIANTS,
} = require('./ql3-local-alpha-trial-kit-bundle.cjs');
const { readReleaseIdentity } = require('./lib/ql3-release-identity.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const SCHEMA = 'qinglong/alpha-local-milestone@v6';
const ARCHITECTURES = Object.freeze(['amd64', 'arm64']);
const FILES = Object.freeze({
  readme: 'README.md',
  manifest: 'manifest.json',
  checksums: 'SHA256SUMS',
});
const WORKFLOW_IDENTITY = Object.freeze({
  repository: 'whyour/qinglong',
  workflowRef: 'whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next',
  event: 'workflow_dispatch',
  job: 'local-alpha-milestone',
});
const REQUIRED_WORKFLOW_NEEDS = Object.freeze([
  'backend',
  'service-manager-bridge',
  'linux-resource-envelopes',
  'linux-resource-release-evidence',
  'supply-chain',
  'local-image',
  'cluster-image',
  'cluster-console-capacity-release-evidence',
  'image-oci',
  'worker-runtime',
  'local-profiles',
  'cluster-postgres',
  'cluster-postgres-ha',
  'cluster-cloudnativepg-live',
  'cluster-provider-credential-test-kubernetes-live',
  'cluster-secret-binding-mounted-provider-kubernetes-live',
  'cluster-vault-kv-worker-secret-live',
  'cluster-plugin-package-kubernetes-live',
  'cluster-plugin-package-recovery-e2e',
]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const ATTEMPT_PATTERN = /^[1-9][0-9]{0,5}$/u;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_README_BYTES = 512 * 1024;

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
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    fail(`${label} must contain valid JSON`);
  }
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

function fileRecord(filePath, name) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2) {
    fail(`milestone file is invalid: ${name}`);
  }
  return Object.freeze({
    file: name,
    sha256: sha256File(filePath),
    bytes: stat.size,
  });
}

function checksumContents(root, names) {
  return `${names
    .map((name) => `${sha256File(path.join(root, name)).slice(7)}  ${name}`)
    .join('\n')}\n`;
}

function artifactName(sourceRevision, architecture, variant = 'headless') {
  return `ql3-alpha-${sourceRevision}-local-${variant}-${architecture}`;
}

function validateIdentity(options) {
  if (
    !REVISION_PATTERN.test(options.sourceRevision || '') ||
    options.repository !== WORKFLOW_IDENTITY.repository ||
    options.workflowRef !== WORKFLOW_IDENTITY.workflowRef ||
    options.workflowSha !== options.sourceRevision ||
    options.eventName !== WORKFLOW_IDENTITY.event ||
    !DECIMAL_ID_PATTERN.test(options.runId || '') ||
    !ATTEMPT_PATTERN.test(options.runAttempt || '')
  ) {
    fail('milestone workflow identity is invalid');
  }
}

function validateFinalizeOptions(options) {
  validateIdentity(options);
  const root = fs.realpathSync(path.resolve(options.root || DEFAULT_ROOT));
  const outputRoot = path.resolve(options.outputRoot || '');
  const parent = path.dirname(outputRoot);
  if (
    !VARIANTS.includes(options.variant) ||
    !path.isAbsolute(outputRoot) ||
    fs.existsSync(outputRoot) ||
    fs.realpathSync(parent) !== parent
  ) {
    fail('milestone output is invalid');
  }
  const bundles = {};
  for (const architecture of ARCHITECTURES) {
    const bundleRoot = fs.realpathSync(
      path.resolve(options.bundles?.[architecture] || ''),
    );
    if (!fs.lstatSync(bundleRoot).isDirectory()) {
      fail(`${architecture} bundle root is invalid`);
    }
    bundles[architecture] = bundleRoot;
  }
  if (bundles.amd64 === bundles.arm64) {
    fail('milestone architectures must use distinct bundles');
  }
  return Object.freeze({
    root,
    outputRoot,
    bundles: Object.freeze(bundles),
    readme: assertCanonicalFile(
      options.readme,
      MAX_README_BYTES,
      'milestone README',
    ),
    sourceRevision: options.sourceRevision,
    variant: options.variant,
    repository: options.repository,
    workflowRef: options.workflowRef,
    workflowSha: options.workflowSha,
    eventName: options.eventName,
    runId: options.runId,
    runAttempt: options.runAttempt,
  });
}

function bundleRecord(options, architecture) {
  const bundleRoot = options.bundles[architecture];
  const report = auditLocalAlphaTrialKit({ bundleRoot });
  if (
    report.compatible !== true ||
    report.architecture !== architecture ||
    report.sourceRevision !== options.sourceRevision ||
    report.workflowRunId !== options.runId ||
    report.workflowRunAttempt !== options.runAttempt ||
    report.variant !== options.variant
  ) {
    fail(`${architecture} trial kit is detached from the milestone run`);
  }
  return Object.freeze({
    artifactName: artifactName(
      options.sourceRevision,
      architecture,
      options.variant,
    ),
    architecture,
    bundleManifest: fileRecord(
      path.join(bundleRoot, 'manifest.json'),
      'manifest.json',
    ),
    archiveSha256: report.archiveSha256,
    applicationImageId: report.applicationImageId,
    operatorImageId: report.operatorImageId,
    verificationSha256: report.verificationSha256,
    upgradeReadinessSha256: report.upgradeReadinessSha256,
    upgradeRehearsalSha256: report.upgradeRehearsalSha256,
    upgradeCutoverRehearsalSha256: report.upgradeCutoverRehearsalSha256,
    upgradeReconciliationRehearsalSha256:
      report.upgradeReconciliationRehearsalSha256,
  });
}

function validateArtifactRecord(record, architecture, manifest) {
  if (
    !exactKeys(record, [
      'artifactName',
      'architecture',
      'bundleManifest',
      'archiveSha256',
      'applicationImageId',
      'operatorImageId',
      'verificationSha256',
      'upgradeReadinessSha256',
      'upgradeRehearsalSha256',
      'upgradeCutoverRehearsalSha256',
      'upgradeReconciliationRehearsalSha256',
    ]) ||
    record.artifactName !==
      artifactName(manifest.sourceRevision, architecture, manifest.variant) ||
    record.architecture !== architecture ||
    !exactKeys(record.bundleManifest, ['file', 'sha256', 'bytes']) ||
    record.bundleManifest.file !== 'manifest.json' ||
    !SHA256_PATTERN.test(record.bundleManifest.sha256 || '') ||
    !Number.isSafeInteger(record.bundleManifest.bytes) ||
    record.bundleManifest.bytes < 2 ||
    !SHA256_PATTERN.test(record.archiveSha256 || '') ||
    !SHA256_PATTERN.test(record.applicationImageId || '') ||
    !SHA256_PATTERN.test(record.operatorImageId || '') ||
    !SHA256_PATTERN.test(record.verificationSha256 || '') ||
    !SHA256_PATTERN.test(record.upgradeReadinessSha256 || '') ||
    !SHA256_PATTERN.test(record.upgradeRehearsalSha256 || '') ||
    !SHA256_PATTERN.test(record.upgradeCutoverRehearsalSha256 || '') ||
    !SHA256_PATTERN.test(record.upgradeReconciliationRehearsalSha256 || '') ||
    record.applicationImageId === record.operatorImageId
  ) {
    fail(`${architecture} milestone artifact record is incompatible`);
  }
}

function validateWorkflow(document, sourceRevision, runId, runAttempt) {
  if (
    !exactKeys(document, [
      'repository',
      'workflowRef',
      'workflowSha',
      'event',
      'job',
      'runId',
      'runAttempt',
    ]) ||
    document.repository !== WORKFLOW_IDENTITY.repository ||
    document.workflowRef !== WORKFLOW_IDENTITY.workflowRef ||
    document.workflowSha !== sourceRevision ||
    document.event !== WORKFLOW_IDENTITY.event ||
    document.job !== WORKFLOW_IDENTITY.job ||
    document.runId !== runId ||
    document.runAttempt !== runAttempt ||
    !DECIMAL_ID_PATTERN.test(document.runId || '') ||
    !ATTEMPT_PATTERN.test(document.runAttempt || '')
  ) {
    fail('milestone manifest workflow identity is incompatible');
  }
}

function auditLocalAlphaMilestone(options) {
  const milestoneRoot = fs.realpathSync(
    path.resolve(options.milestoneRoot || ''),
  );
  if (!fs.lstatSync(milestoneRoot).isDirectory()) {
    fail('milestone root must be a canonical directory');
  }
  const expectedFiles = Object.values(FILES).sort();
  const actualFiles = fs
    .readdirSync(milestoneRoot, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail(`milestone contains a non-regular entry: ${entry.name}`);
      }
      return entry.name;
    })
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail('milestone file set is not closed');
  }
  const manifest = readBoundedJson(
    path.join(milestoneRoot, FILES.manifest),
    'milestone manifest',
  );
  if (
    !exactKeys(manifest, [
      'schemaVersion',
      'schema',
      'maturity',
      'product',
      'variant',
      'version',
      'sourceRevision',
      'workflow',
      'artifacts',
      'readme',
    ]) ||
    manifest.schemaVersion !== 6 ||
    manifest.schema !== SCHEMA ||
    manifest.maturity !== 'alpha_candidate_not_public_release' ||
    manifest.product !== 'local' ||
    !VARIANTS.includes(manifest.variant) ||
    typeof manifest.version !== 'string' ||
    manifest.version.length < 3 ||
    manifest.version.length > 64 ||
    !REVISION_PATTERN.test(manifest.sourceRevision || '') ||
    !exactKeys(manifest.artifacts, ARCHITECTURES) ||
    !exactKeys(manifest.readme, ['file', 'sha256', 'bytes']) ||
    manifest.readme.file !== FILES.readme ||
    !SHA256_PATTERN.test(manifest.readme.sha256 || '') ||
    !Number.isSafeInteger(manifest.readme.bytes) ||
    manifest.readme.bytes < 2
  ) {
    fail('milestone manifest identity or shape is incompatible');
  }
  validateWorkflow(
    manifest.workflow,
    manifest.sourceRevision,
    manifest.workflow?.runId,
    manifest.workflow?.runAttempt,
  );
  for (const architecture of ARCHITECTURES) {
    validateArtifactRecord(
      manifest.artifacts[architecture],
      architecture,
      manifest,
    );
  }
  const records = ARCHITECTURES.map(
    (architecture) => manifest.artifacts[architecture],
  );
  const imageIds = records.flatMap((record) => [
    record.applicationImageId,
    record.operatorImageId,
  ]);
  if (
    new Set(imageIds).size !== imageIds.length ||
    new Set(records.map((record) => record.archiveSha256)).size !==
      ARCHITECTURES.length ||
    new Set(records.map((record) => record.verificationSha256)).size !==
      ARCHITECTURES.length ||
    new Set(records.map((record) => record.upgradeReadinessSha256)).size !==
      ARCHITECTURES.length ||
    new Set(records.map((record) => record.upgradeRehearsalSha256)).size !==
      ARCHITECTURES.length ||
    new Set(records.map((record) => record.upgradeCutoverRehearsalSha256))
      .size !== ARCHITECTURES.length ||
    new Set(
      records.map((record) => record.upgradeReconciliationRehearsalSha256),
    ).size !== ARCHITECTURES.length
  ) {
    fail('milestone architecture subjects are not distinct');
  }
  const actualReadme = fileRecord(
    path.join(milestoneRoot, FILES.readme),
    FILES.readme,
  );
  if (
    actualReadme.sha256 !== manifest.readme.sha256 ||
    actualReadme.bytes !== manifest.readme.bytes
  ) {
    fail('milestone README differs from manifest');
  }
  const expectedChecksums = checksumContents(milestoneRoot, [
    FILES.readme,
    FILES.manifest,
  ]);
  const actualChecksums = fs.readFileSync(
    path.join(milestoneRoot, FILES.checksums),
    'utf8',
  );
  if (actualChecksums !== expectedChecksums) {
    fail('milestone SHA256SUMS differs from the closed file set');
  }
  return Object.freeze({
    schemaVersion: 1,
    schema: 'qinglong/alpha-local-milestone-audit@v6',
    sourceRevision: manifest.sourceRevision,
    version: manifest.version,
    variant: manifest.variant,
    workflowRunId: manifest.workflow.runId,
    workflowRunAttempt: manifest.workflow.runAttempt,
    architectures: [...ARCHITECTURES],
    compatible: true,
  });
}

function finalizeLocalAlphaMilestone(options) {
  const normalized = validateFinalizeOptions(options);
  const artifacts = {
    amd64: bundleRecord(normalized, 'amd64'),
    arm64: bundleRecord(normalized, 'arm64'),
  };
  const versions = new Set(
    ARCHITECTURES.map((architecture) => {
      const manifest = readBoundedJson(
        path.join(normalized.bundles[architecture], 'manifest.json'),
        `${architecture} trial kit manifest`,
      );
      return manifest.version;
    }),
  );
  const release = readReleaseIdentity(normalized.root);
  if (versions.size !== 1 || !versions.has(release.version)) {
    fail('milestone trial kits must have one release version');
  }
  const allImageIds = ARCHITECTURES.flatMap((architecture) => [
    artifacts[architecture].applicationImageId,
    artifacts[architecture].operatorImageId,
  ]);
  if (
    new Set(allImageIds).size !== allImageIds.length ||
    artifacts.amd64.archiveSha256 === artifacts.arm64.archiveSha256 ||
    artifacts.amd64.verificationSha256 === artifacts.arm64.verificationSha256 ||
    artifacts.amd64.upgradeReadinessSha256 ===
      artifacts.arm64.upgradeReadinessSha256 ||
    artifacts.amd64.upgradeRehearsalSha256 ===
      artifacts.arm64.upgradeRehearsalSha256 ||
    artifacts.amd64.upgradeCutoverRehearsalSha256 ===
      artifacts.arm64.upgradeCutoverRehearsalSha256 ||
    artifacts.amd64.upgradeReconciliationRehearsalSha256 ===
      artifacts.arm64.upgradeReconciliationRehearsalSha256
  ) {
    fail('milestone architecture subjects must be distinct');
  }
  let created = false;
  try {
    fs.mkdirSync(normalized.outputRoot, { mode: 0o700 });
    created = true;
    copyExclusive(
      normalized.readme,
      path.join(normalized.outputRoot, FILES.readme),
    );
    const manifest = {
      schemaVersion: 6,
      schema: SCHEMA,
      maturity: 'alpha_candidate_not_public_release',
      product: 'local',
      variant: normalized.variant,
      version: [...versions][0],
      sourceRevision: normalized.sourceRevision,
      workflow: {
        repository: normalized.repository,
        workflowRef: normalized.workflowRef,
        workflowSha: normalized.workflowSha,
        event: normalized.eventName,
        job: WORKFLOW_IDENTITY.job,
        runId: normalized.runId,
        runAttempt: normalized.runAttempt,
      },
      artifacts,
      readme: fileRecord(
        path.join(normalized.outputRoot, FILES.readme),
        FILES.readme,
      ),
    };
    writeExclusive(
      path.join(normalized.outputRoot, FILES.manifest),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    writeExclusive(
      path.join(normalized.outputRoot, FILES.checksums),
      checksumContents(normalized.outputRoot, [FILES.readme, FILES.manifest]),
    );
    auditLocalAlphaMilestone({ milestoneRoot: normalized.outputRoot });
    return Object.freeze(manifest);
  } catch (error) {
    if (created) {
      fs.rmSync(normalized.outputRoot, { recursive: true, force: true });
    }
    throw error;
  }
}

function countOccurrences(contents, token) {
  return contents.split(token).length - 1;
}

function jobBlock(workflow, jobName) {
  const header = `\n  ${jobName}:\n`;
  const start = workflow.indexOf(header);
  if (start < 0) return '';
  const remaining = workflow.slice(start + header.length);
  const nextMatch = /\n  [a-z0-9-]+:\n/u.exec(remaining);
  const end = nextMatch
    ? start + header.length + nextMatch.index
    : workflow.length;
  return workflow.slice(start, end);
}

function auditLocalAlphaMilestoneWorkflow(root = DEFAULT_ROOT) {
  const workflowPath = path.join(
    fs.realpathSync(path.resolve(root)),
    '.github/workflows/ql3-ci.yml',
  );
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const findings = [];
  const milestoneStart = workflow.indexOf('\n  local-alpha-milestone:\n');
  const milestone = jobBlock(workflow, 'local-alpha-milestone');
  const requiredWorkflowTokens = [
    'alpha_artifact_scope:',
    'default: local',
    '- local',
    '- cluster',
    '- all',
    'local_alpha_variant:',
    'default: headless',
    '- headless',
    '- console',
    "github.run_id || 'validation'",
    "cancel-in-progress: ${{ !(github.event_name == 'workflow_dispatch' && inputs.produce_alpha_artifacts) }}",
  ];
  if (requiredWorkflowTokens.some((token) => !workflow.includes(token))) {
    findings.push('MILESTONE_DISPATCH_OR_CONCURRENCY_DRIFT');
  }
  const localScopeCondition =
    "github.event_name == 'workflow_dispatch' && inputs.produce_alpha_artifacts && (inputs.alpha_artifact_scope == 'local' || inputs.alpha_artifact_scope == 'all')";
  const clusterScopeCondition =
    "github.event_name == 'workflow_dispatch' && inputs.produce_alpha_artifacts && (inputs.alpha_artifact_scope == 'cluster' || inputs.alpha_artifact_scope == 'all')";
  if (
    countOccurrences(workflow, localScopeCondition) !== 3 ||
    countOccurrences(workflow, clusterScopeCondition) !== 3
  ) {
    findings.push('MILESTONE_SCOPE_CONTRACT_DRIFT');
  }
  const milestoneTokens = [
    '    name: Finalize the Local Alpha milestone',
    '    needs:',
    'pnpm/action-setup@v6',
    'cache-dependency-path: pnpm-lock.yaml',
    'pnpm install --frozen-lockfile --ignore-scripts',
    'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
    `name: ql3-alpha-${'${{ github.sha }}'}-local-${'${{ inputs.local_alpha_variant }}'}-amd64`,
    `name: ql3-alpha-${'${{ github.sha }}'}-local-${'${{ inputs.local_alpha_variant }}'}-arm64`,
    'scripts/ql3-local-alpha-milestone.cjs',
    '--mode=finalize',
    '--variant=${{ inputs.local_alpha_variant }}',
    '--mode=audit',
    `name: ql3-alpha-${'${{ github.sha }}'}-local-${'${{ inputs.local_alpha_variant }}'}-milestone`,
    'retention-days: 30',
    'overwrite: false',
  ];
  if (
    milestoneStart < 0 ||
    milestoneTokens.some((token) => !milestone.includes(token)) ||
    REQUIRED_WORKFLOW_NEEDS.some(
      (job) => !milestone.includes(`      - ${job}\n`),
    )
  ) {
    findings.push('MILESTONE_FINALIZER_CONTRACT_DRIFT');
  }
  const dependencyInstallIndex = milestone.indexOf(
    'pnpm install --frozen-lockfile --ignore-scripts',
  );
  const finalizerIndex = milestone.indexOf('--mode=finalize');
  const auditIndex = milestone.indexOf('--mode=audit');
  const uploadIndex = milestone.lastIndexOf('actions/upload-artifact@');
  if (
    dependencyInstallIndex < 0 ||
    finalizerIndex <= dependencyInstallIndex ||
    auditIndex <= finalizerIndex ||
    uploadIndex <= auditIndex
  ) {
    findings.push('MILESTONE_FINALIZER_GATE_ORDER_DRIFT');
  }
  return Object.freeze({
    schemaVersion: 1,
    schema: 'qinglong/alpha-local-milestone-workflow-audit@v1',
    requiredNeeds: [...REQUIRED_WORKFLOW_NEEDS],
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
  });
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) {
      fail('arguments are invalid');
    }
    values[match[1]] = match[2];
  }
  if (values.mode === 'audit') {
    if (
      JSON.stringify(Object.keys(values).sort()) !==
      JSON.stringify(['milestone', 'mode'])
    ) {
      fail('audit arguments are invalid');
    }
    return { mode: 'audit', milestoneRoot: path.resolve(values.milestone) };
  }
  if (values.mode === 'audit-workflow') {
    if (
      JSON.stringify(Object.keys(values).sort()) !==
      JSON.stringify(['mode', 'root'])
    ) {
      fail('workflow audit arguments are invalid');
    }
    return { mode: 'audit-workflow', root: path.resolve(values.root) };
  }
  const expected = [
    'amd64-bundle',
    'arm64-bundle',
    'event',
    'mode',
    'output',
    'readme',
    'repository',
    'run-attempt',
    'run-id',
    'source-revision',
    'variant',
    'workflow-ref',
    'workflow-sha',
  ];
  if (
    values.mode !== 'finalize' ||
    JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expected)
  ) {
    fail('finalize arguments are invalid');
  }
  return {
    mode: 'finalize',
    outputRoot: path.resolve(values.output),
    bundles: {
      amd64: path.resolve(values['amd64-bundle']),
      arm64: path.resolve(values['arm64-bundle']),
    },
    readme: path.resolve(values.readme),
    sourceRevision: values['source-revision'],
    variant: values.variant,
    repository: values.repository,
    workflowRef: values['workflow-ref'],
    workflowSha: values['workflow-sha'],
    eventName: values.event,
    runId: values['run-id'],
    runAttempt: values['run-attempt'],
  };
}

function runCli(argv) {
  const options = parseArguments(argv);
  let report;
  if (options.mode === 'finalize') {
    report = finalizeLocalAlphaMilestone(options);
  } else if (options.mode === 'audit-workflow') {
    report = auditLocalAlphaMilestoneWorkflow(options.root);
    if (!report.compatible) fail(JSON.stringify(report));
  } else {
    report = auditLocalAlphaMilestone(options);
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
        error instanceof Error ? error.message : 'Local Alpha milestone failed'
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  ARCHITECTURES,
  FILES,
  REQUIRED_WORKFLOW_NEEDS,
  SCHEMA,
  artifactName,
  auditLocalAlphaMilestone,
  auditLocalAlphaMilestoneWorkflow,
  finalizeLocalAlphaMilestone,
  parseArguments,
  runCli,
});
