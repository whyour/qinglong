#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ARCHITECTURES,
  ROLES,
  auditClusterAlphaBundle,
  sha256File,
} = require('./ql3-cluster-alpha-bundle.cjs');
const { readReleaseIdentity } = require('./lib/ql3-release-identity.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const SCHEMA = 'qinglong/alpha-cluster-milestone@v1';
const SUBJECTS = Object.freeze(
  Object.keys(ROLES).flatMap((role) =>
    ARCHITECTURES.map((architecture) => `${role}-${architecture}`),
  ),
);
const FILES = Object.freeze({
  readme: 'README.md',
  manifest: 'manifest.json',
  checksums: 'SHA256SUMS',
});
const WORKFLOW_IDENTITY = Object.freeze({
  repository: 'whyour/qinglong',
  workflowRef: 'whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next',
  event: 'workflow_dispatch',
  job: 'cluster-alpha-milestone',
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

function checksumContents(root, checkedNames) {
  return `${checkedNames
    .map((name) => `${sha256File(path.join(root, name)).slice(7)}  ${name}`)
    .join('\n')}\n`;
}

function artifactName(sourceRevision, role, architecture) {
  return `ql3-alpha-${sourceRevision}-${role}-${architecture}`;
}

function splitSubject(subject) {
  const architecture = ARCHITECTURES.find((value) =>
    subject.endsWith(`-${value}`),
  );
  if (!architecture) fail(`milestone subject is invalid: ${subject}`);
  return Object.freeze({
    role: subject.slice(0, -(architecture.length + 1)),
    architecture,
  });
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
    fail('Cluster milestone workflow identity is invalid');
  }
}

function validateFinalizeOptions(options) {
  validateIdentity(options);
  const root = fs.realpathSync(path.resolve(options.root || DEFAULT_ROOT));
  const outputRoot = path.resolve(options.outputRoot || '');
  const parent = path.dirname(outputRoot);
  if (
    !path.isAbsolute(outputRoot) ||
    fs.existsSync(outputRoot) ||
    fs.realpathSync(parent) !== parent
  ) {
    fail('Cluster milestone output is invalid');
  }
  const bundles = {};
  for (const subject of SUBJECTS) {
    const bundleRoot = fs.realpathSync(
      path.resolve(options.bundles?.[subject] || ''),
    );
    if (!fs.lstatSync(bundleRoot).isDirectory()) {
      fail(`${subject} bundle root is invalid`);
    }
    bundles[subject] = bundleRoot;
  }
  if (new Set(Object.values(bundles)).size !== SUBJECTS.length) {
    fail('Cluster milestone subjects must use distinct bundles');
  }
  return Object.freeze({
    root,
    outputRoot,
    bundles: Object.freeze(bundles),
    readme: assertCanonicalFile(
      options.readme,
      MAX_README_BYTES,
      'Cluster milestone README',
    ),
    sourceRevision: options.sourceRevision,
    repository: options.repository,
    workflowRef: options.workflowRef,
    workflowSha: options.workflowSha,
    eventName: options.eventName,
    runId: options.runId,
    runAttempt: options.runAttempt,
  });
}

function bundleRecord(options, subject) {
  const { role, architecture } = splitSubject(subject);
  const bundleRoot = options.bundles[subject];
  const report = auditClusterAlphaBundle({ bundleRoot });
  if (
    report.compatible !== true ||
    report.role !== role ||
    report.architecture !== architecture ||
    report.sourceRevision !== options.sourceRevision ||
    report.workflowRunId !== options.runId ||
    report.workflowRunAttempt !== options.runAttempt
  ) {
    fail(`${subject} bundle is detached from the Cluster milestone run`);
  }
  return Object.freeze({
    artifactName: artifactName(options.sourceRevision, role, architecture),
    role,
    architecture,
    bundleManifest: fileRecord(
      path.join(bundleRoot, 'manifest.json'),
      'manifest.json',
    ),
    archiveSha256: report.archiveSha256,
    imageId: report.imageId,
    verificationSha256: report.verificationSha256,
  });
}

function validateArtifactRecord(record, subject, manifest) {
  const { role, architecture } = splitSubject(subject);
  if (
    !exactKeys(record, [
      'artifactName',
      'role',
      'architecture',
      'bundleManifest',
      'archiveSha256',
      'imageId',
      'verificationSha256',
    ]) ||
    record.artifactName !==
      artifactName(manifest.sourceRevision, role, architecture) ||
    record.role !== role ||
    record.architecture !== architecture ||
    !exactKeys(record.bundleManifest, ['file', 'sha256', 'bytes']) ||
    record.bundleManifest.file !== 'manifest.json' ||
    !SHA256_PATTERN.test(record.bundleManifest.sha256 || '') ||
    !Number.isSafeInteger(record.bundleManifest.bytes) ||
    record.bundleManifest.bytes < 2 ||
    !SHA256_PATTERN.test(record.archiveSha256 || '') ||
    !SHA256_PATTERN.test(record.imageId || '') ||
    !SHA256_PATTERN.test(record.verificationSha256 || '')
  ) {
    fail(`${subject} milestone artifact record is incompatible`);
  }
}

function validateWorkflow(document, sourceRevision) {
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
    !DECIMAL_ID_PATTERN.test(document.runId || '') ||
    !ATTEMPT_PATTERN.test(document.runAttempt || '')
  ) {
    fail('Cluster milestone manifest workflow identity is incompatible');
  }
}

function auditClusterAlphaMilestone(options) {
  const milestoneRoot = fs.realpathSync(
    path.resolve(options.milestoneRoot || ''),
  );
  if (!fs.lstatSync(milestoneRoot).isDirectory()) {
    fail('Cluster milestone root must be a canonical directory');
  }
  const expectedFiles = Object.values(FILES).sort();
  const actualFiles = fs
    .readdirSync(milestoneRoot, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail(`Cluster milestone contains a non-regular entry: ${entry.name}`);
      }
      return entry.name;
    })
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail('Cluster milestone file set is not closed');
  }
  const manifest = readBoundedJson(
    path.join(milestoneRoot, FILES.manifest),
    'Cluster milestone manifest',
  );
  if (
    !exactKeys(manifest, [
      'schemaVersion',
      'schema',
      'maturity',
      'product',
      'version',
      'sourceRevision',
      'workflow',
      'artifacts',
      'readme',
    ]) ||
    manifest.schemaVersion !== 1 ||
    manifest.schema !== SCHEMA ||
    manifest.maturity !== 'cluster_integration_candidate_not_public_release' ||
    manifest.product !== 'cluster' ||
    typeof manifest.version !== 'string' ||
    manifest.version.length < 3 ||
    manifest.version.length > 64 ||
    !REVISION_PATTERN.test(manifest.sourceRevision || '') ||
    !exactKeys(manifest.artifacts, SUBJECTS) ||
    !exactKeys(manifest.readme, ['file', 'sha256', 'bytes']) ||
    manifest.readme.file !== FILES.readme ||
    !SHA256_PATTERN.test(manifest.readme.sha256 || '') ||
    !Number.isSafeInteger(manifest.readme.bytes) ||
    manifest.readme.bytes < 2
  ) {
    fail('Cluster milestone manifest identity or shape is incompatible');
  }
  validateWorkflow(manifest.workflow, manifest.sourceRevision);
  for (const subject of SUBJECTS) {
    validateArtifactRecord(manifest.artifacts[subject], subject, manifest);
  }
  const records = SUBJECTS.map((subject) => manifest.artifacts[subject]);
  for (const field of ['imageId', 'archiveSha256', 'verificationSha256']) {
    if (
      new Set(records.map((record) => record[field])).size !== SUBJECTS.length
    ) {
      fail(`Cluster milestone ${field} subjects are not distinct`);
    }
  }
  const actualReadme = fileRecord(
    path.join(milestoneRoot, FILES.readme),
    FILES.readme,
  );
  if (
    actualReadme.sha256 !== manifest.readme.sha256 ||
    actualReadme.bytes !== manifest.readme.bytes
  ) {
    fail('Cluster milestone README differs from manifest');
  }
  const expectedChecksums = checksumContents(milestoneRoot, [
    FILES.readme,
    FILES.manifest,
  ]);
  if (
    fs.readFileSync(path.join(milestoneRoot, FILES.checksums), 'utf8') !==
    expectedChecksums
  ) {
    fail('Cluster milestone SHA256SUMS differs from the closed file set');
  }
  return Object.freeze({
    schemaVersion: 1,
    schema: 'qinglong/alpha-cluster-milestone-audit@v1',
    sourceRevision: manifest.sourceRevision,
    version: manifest.version,
    workflowRunId: manifest.workflow.runId,
    workflowRunAttempt: manifest.workflow.runAttempt,
    subjects: [...SUBJECTS],
    compatible: true,
  });
}

function finalizeClusterAlphaMilestone(options) {
  const normalized = validateFinalizeOptions(options);
  const artifacts = Object.fromEntries(
    SUBJECTS.map((subject) => [subject, bundleRecord(normalized, subject)]),
  );
  const versions = new Set(
    SUBJECTS.map(
      (subject) =>
        readBoundedJson(
          path.join(normalized.bundles[subject], 'manifest.json'),
          `${subject} bundle manifest`,
        ).version,
    ),
  );
  const release = readReleaseIdentity(normalized.root);
  if (versions.size !== 1 || !versions.has(release.version)) {
    fail('Cluster milestone bundles must have one release version');
  }
  for (const field of ['imageId', 'archiveSha256', 'verificationSha256']) {
    if (
      new Set(SUBJECTS.map((subject) => artifacts[subject][field])).size !==
      SUBJECTS.length
    ) {
      fail(`Cluster milestone ${field} subjects must be distinct`);
    }
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
      schemaVersion: 1,
      schema: SCHEMA,
      maturity: 'cluster_integration_candidate_not_public_release',
      product: 'cluster',
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
    auditClusterAlphaMilestone({ milestoneRoot: normalized.outputRoot });
    return Object.freeze(manifest);
  } catch (error) {
    if (created)
      fs.rmSync(normalized.outputRoot, { recursive: true, force: true });
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

function auditClusterAlphaMilestoneWorkflow(root = DEFAULT_ROOT) {
  const workflow = fs.readFileSync(
    path.join(
      fs.realpathSync(path.resolve(root)),
      '.github/workflows/ql3-ci.yml',
    ),
    'utf8',
  );
  const findings = [];
  const clusterCondition =
    "github.event_name == 'workflow_dispatch' && inputs.produce_alpha_artifacts && (inputs.alpha_artifact_scope == 'cluster' || inputs.alpha_artifact_scope == 'all')";
  if (
    countOccurrences(workflow, clusterCondition) !== 3 ||
    !workflow.includes("github.run_id || 'validation'") ||
    !workflow.includes(
      "cancel-in-progress: ${{ !(github.event_name == 'workflow_dispatch' && inputs.produce_alpha_artifacts) }}",
    )
  ) {
    findings.push('CLUSTER_MILESTONE_SCOPE_OR_CONCURRENCY_DRIFT');
  }
  const milestone = jobBlock(workflow, 'cluster-alpha-milestone');
  const tokens = [
    'name: Finalize the Cluster Alpha integration milestone',
    'pnpm/action-setup@v6',
    'cache-dependency-path: pnpm-lock.yaml',
    'pnpm install --frozen-lockfile --ignore-scripts',
    'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
    'scripts/ql3-cluster-alpha-milestone.cjs',
    '--mode=finalize',
    '--mode=audit',
    `name: ql3-alpha-${'${{ github.sha }}'}-cluster-milestone`,
    'retention-days: 30',
    'overwrite: false',
  ];
  if (
    !milestone ||
    tokens.some((token) => !milestone.includes(token)) ||
    SUBJECTS.some(
      (subject) =>
        !milestone.includes(
          `name: ql3-alpha-${'${{ github.sha }}'}-${subject}`,
        ),
    ) ||
    REQUIRED_WORKFLOW_NEEDS.some(
      (job) => !milestone.includes(`      - ${job}\n`),
    )
  ) {
    findings.push('CLUSTER_MILESTONE_FINALIZER_CONTRACT_DRIFT');
  }
  const dependencyInstallIndex = milestone.indexOf(
    'pnpm install --frozen-lockfile --ignore-scripts',
  );
  const finalizerIndex = milestone.indexOf('--mode=finalize');
  const auditIndex = milestone.indexOf('--mode=audit');
  const uploadIndex = milestone.indexOf('actions/upload-artifact@');
  if (
    dependencyInstallIndex < 0 ||
    finalizerIndex <= dependencyInstallIndex ||
    auditIndex <= finalizerIndex ||
    uploadIndex <= auditIndex
  ) {
    findings.push('CLUSTER_MILESTONE_GATE_ORDER_DRIFT');
  }
  return Object.freeze({
    schemaVersion: 1,
    schema: 'qinglong/alpha-cluster-milestone-workflow-audit@v1',
    requiredNeeds: [...REQUIRED_WORKFLOW_NEEDS],
    subjects: [...SUBJECTS],
    findings: Object.freeze(findings),
    compatible: findings.length === 0,
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
      JSON.stringify(['milestone', 'mode'])
    ) {
      fail('audit arguments are invalid');
    }
    return { mode: values.mode, milestoneRoot: path.resolve(values.milestone) };
  }
  if (values.mode === 'audit-workflow') {
    if (
      JSON.stringify(Object.keys(values).sort()) !==
      JSON.stringify(['mode', 'root'])
    ) {
      fail('workflow audit arguments are invalid');
    }
    return { mode: values.mode, root: path.resolve(values.root) };
  }
  const bundleArguments = SUBJECTS.map((subject) => `${subject}-bundle`);
  const expected = [
    ...bundleArguments,
    'event',
    'mode',
    'output',
    'readme',
    'repository',
    'run-attempt',
    'run-id',
    'source-revision',
    'workflow-ref',
    'workflow-sha',
  ].sort();
  if (
    values.mode !== 'finalize' ||
    JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expected)
  ) {
    fail('finalize arguments are invalid');
  }
  return {
    mode: values.mode,
    outputRoot: path.resolve(values.output),
    bundles: Object.fromEntries(
      SUBJECTS.map((subject) => [
        subject,
        path.resolve(values[`${subject}-bundle`]),
      ]),
    ),
    readme: path.resolve(values.readme),
    sourceRevision: values['source-revision'],
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
    report = finalizeClusterAlphaMilestone(options);
  } else if (options.mode === 'audit-workflow') {
    report = auditClusterAlphaMilestoneWorkflow(options.root);
    if (!report.compatible) fail(JSON.stringify(report));
  } else {
    report = auditClusterAlphaMilestone(options);
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
        error instanceof Error
          ? error.message
          : 'Cluster Alpha milestone failed'
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  FILES,
  REQUIRED_WORKFLOW_NEEDS,
  SCHEMA,
  SUBJECTS,
  artifactName,
  auditClusterAlphaMilestone,
  auditClusterAlphaMilestoneWorkflow,
  finalizeClusterAlphaMilestone,
  parseArguments,
  runCli,
});
