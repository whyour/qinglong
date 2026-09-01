#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { auditLocalAlphaMilestone } = require('./ql3-local-alpha-milestone.cjs');
const {
  auditClusterAlphaMilestone,
} = require('./ql3-cluster-alpha-milestone.cjs');
const { sha256File } = require('./ql3-local-alpha-trial-kit-bundle.cjs');
const { readReleaseIdentity } = require('./lib/ql3-release-identity.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const SCHEMA = 'qinglong/alpha-stage-index@v2';
const FILES = Object.freeze({
  readme: 'README.md',
  manifest: 'manifest.json',
  checksums: 'SHA256SUMS',
});
const ARCHITECTURES = Object.freeze(['amd64', 'arm64']);
const WORKFLOW_IDENTITY = Object.freeze({
  repository: 'whyour/qinglong',
  workflowRef: 'whyour/qinglong/.github/workflows/ql3-ci.yml@refs/heads/next',
  event: 'workflow_dispatch',
  job: 'alpha-stage-index',
});
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
  const resolved = path.resolve(filePath || '');
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

function assertCanonicalDirectory(directory, label) {
  const resolved = fs.realpathSync(path.resolve(directory || ''));
  if (!fs.lstatSync(resolved).isDirectory()) {
    fail(`${label} must be a canonical directory`);
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
    fail(`stage index file is invalid: ${name}`);
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

function stageArtifactName(sourceRevision) {
  return `ql3-alpha-${sourceRevision}-stage-index`;
}

function milestoneArtifactName(sourceRevision, product, variant) {
  return product === 'local'
    ? `ql3-alpha-${sourceRevision}-local-${variant}-milestone`
    : `ql3-alpha-${sourceRevision}-cluster-milestone`;
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
    fail('stage index workflow identity is incompatible');
  }
}

function readMilestones(localMilestoneRoot, clusterMilestoneRoot) {
  const localRoot = assertCanonicalDirectory(
    localMilestoneRoot,
    'Local milestone root',
  );
  const clusterRoot = assertCanonicalDirectory(
    clusterMilestoneRoot,
    'Cluster milestone root',
  );
  if (localRoot === clusterRoot) {
    fail('Local and Cluster milestone roots must be distinct');
  }
  const localReport = auditLocalAlphaMilestone({ milestoneRoot: localRoot });
  const clusterReport = auditClusterAlphaMilestone({
    milestoneRoot: clusterRoot,
  });
  const local = readBoundedJson(
    path.join(localRoot, 'manifest.json'),
    'Local milestone manifest',
  );
  const cluster = readBoundedJson(
    path.join(clusterRoot, 'manifest.json'),
    'Cluster milestone manifest',
  );
  const identityFields = ['version', 'sourceRevision'];
  if (
    identityFields.some((field) => local[field] !== cluster[field]) ||
    local.workflow.repository !== cluster.workflow.repository ||
    local.workflow.workflowRef !== cluster.workflow.workflowRef ||
    local.workflow.workflowSha !== cluster.workflow.workflowSha ||
    local.workflow.event !== cluster.workflow.event ||
    local.workflow.runId !== cluster.workflow.runId ||
    local.workflow.runAttempt !== cluster.workflow.runAttempt ||
    localReport.compatible !== true ||
    clusterReport.compatible !== true
  ) {
    fail('Local and Cluster milestones do not belong to one workflow run');
  }
  return Object.freeze({ localRoot, clusterRoot, local, cluster });
}

function expectedSelections(local, cluster) {
  return {
    local: {
      variant: local.variant,
      profiles:
        local.variant === 'console'
          ? ['edge-application-api', 'standalone-application-api']
          : ['edge', 'standalone'],
      intent:
        local.variant === 'console'
          ? 'fresh_loopback_console_non_production_trial'
          : 'fresh_non_production_trial',
      architectures: Object.fromEntries(
        ARCHITECTURES.map((architecture) => [
          architecture,
          {
            requiredArtifacts: [local.artifacts[architecture].artifactName],
            steadyStateRoles: ['application'],
            transientRoles: ['operator'],
          },
        ]),
      ),
    },
    cluster: {
      profiles: ['cluster'],
      intent: 'isolated_registry_non_production_integration',
      architectures: Object.fromEntries(
        ARCHITECTURES.map((architecture) => [
          architecture,
          {
            requiredArtifacts: [
              cluster.artifacts[`control-${architecture}`].artifactName,
              cluster.artifacts[`admin-${architecture}`].artifactName,
              cluster.artifacts[`worker-${architecture}`].artifactName,
            ],
            optionalArtifacts: [
              cluster.artifacts[`control-ai-${architecture}`].artifactName,
            ],
          },
        ]),
      ),
    },
  };
}

function validateMilestoneRecord(record, product, sourceRevision, variant) {
  const expectedMaturity =
    product === 'local'
      ? 'alpha_candidate_not_public_release'
      : 'cluster_integration_candidate_not_public_release';
  const expectedSchema =
    product === 'local'
      ? 'qinglong/alpha-local-milestone@v7'
      : 'qinglong/alpha-cluster-milestone@v1';
  if (
    !exactKeys(record, ['artifactName', 'schema', 'maturity', 'manifest']) ||
    record.artifactName !==
      milestoneArtifactName(sourceRevision, product, variant) ||
    record.schema !== expectedSchema ||
    record.maturity !== expectedMaturity ||
    !exactKeys(record.manifest, ['file', 'sha256', 'bytes']) ||
    record.manifest.file !== 'manifest.json' ||
    !SHA256_PATTERN.test(record.manifest.sha256 || '') ||
    !Number.isSafeInteger(record.manifest.bytes) ||
    record.manifest.bytes < 2
  ) {
    fail(`${product} stage milestone record is incompatible`);
  }
}

function validateSelections(selections, local, cluster) {
  if (
    JSON.stringify(selections) !==
    JSON.stringify(expectedSelections(local, cluster))
  ) {
    fail('stage index deployment selections are incompatible');
  }
}

function auditAlphaStageIndex(options) {
  const stageRoot = assertCanonicalDirectory(options.stageRoot, 'stage root');
  const milestones = readMilestones(
    options.localMilestoneRoot,
    options.clusterMilestoneRoot,
  );
  const expectedFiles = Object.values(FILES).sort();
  const actualFiles = fs
    .readdirSync(stageRoot, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail(`stage index contains a non-regular entry: ${entry.name}`);
      }
      return entry.name;
    })
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail('stage index file set is not closed');
  }
  const manifest = readBoundedJson(
    path.join(stageRoot, FILES.manifest),
    'stage index manifest',
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
      'milestones',
      'deploymentSelections',
      'readme',
    ]) ||
    manifest.schemaVersion !== 2 ||
    manifest.schema !== SCHEMA ||
    manifest.maturity !== 'alpha_stage_delivery_not_public_release' ||
    manifest.product !== 'qinglong3' ||
    manifest.version !== milestones.local.version ||
    !REVISION_PATTERN.test(manifest.sourceRevision || '') ||
    manifest.sourceRevision !== milestones.local.sourceRevision ||
    !exactKeys(manifest.milestones, ['local', 'cluster']) ||
    !exactKeys(manifest.deploymentSelections, ['local', 'cluster']) ||
    !exactKeys(manifest.readme, ['file', 'sha256', 'bytes']) ||
    manifest.readme.file !== FILES.readme ||
    !SHA256_PATTERN.test(manifest.readme.sha256 || '') ||
    !Number.isSafeInteger(manifest.readme.bytes) ||
    manifest.readme.bytes < 2
  ) {
    fail('stage index manifest identity or shape is incompatible');
  }
  validateWorkflow(manifest.workflow, manifest.sourceRevision);
  if (
    manifest.workflow.runId !== milestones.local.workflow.runId ||
    manifest.workflow.runAttempt !== milestones.local.workflow.runAttempt
  ) {
    fail('stage index is detached from the milestone workflow run');
  }
  validateMilestoneRecord(
    manifest.milestones.local,
    'local',
    manifest.sourceRevision,
    milestones.local.variant,
  );
  validateMilestoneRecord(
    manifest.milestones.cluster,
    'cluster',
    manifest.sourceRevision,
    undefined,
  );
  const milestoneManifests = {
    local: fileRecord(
      path.join(milestones.localRoot, 'manifest.json'),
      'manifest.json',
    ),
    cluster: fileRecord(
      path.join(milestones.clusterRoot, 'manifest.json'),
      'manifest.json',
    ),
  };
  for (const product of ['local', 'cluster']) {
    if (
      JSON.stringify(manifest.milestones[product].manifest) !==
      JSON.stringify(milestoneManifests[product])
    ) {
      fail(`${product} milestone manifest differs from stage index`);
    }
  }
  validateSelections(
    manifest.deploymentSelections,
    milestones.local,
    milestones.cluster,
  );
  const actualReadme = fileRecord(
    path.join(stageRoot, FILES.readme),
    FILES.readme,
  );
  if (JSON.stringify(actualReadme) !== JSON.stringify(manifest.readme)) {
    fail('stage index README differs from manifest');
  }
  if (
    fs.readFileSync(path.join(stageRoot, FILES.checksums), 'utf8') !==
    checksumContents(stageRoot, [FILES.readme, FILES.manifest])
  ) {
    fail('stage index SHA256SUMS differs from the closed file set');
  }
  return Object.freeze({
    schemaVersion: 1,
    schema: 'qinglong/alpha-stage-index-audit@v2',
    version: manifest.version,
    sourceRevision: manifest.sourceRevision,
    workflowRunId: manifest.workflow.runId,
    workflowRunAttempt: manifest.workflow.runAttempt,
    profiles: [...manifest.deploymentSelections.local.profiles, 'cluster'],
    artifactCount: 10,
    compatible: true,
  });
}

function validateFinalizeOptions(options) {
  const milestones = readMilestones(
    options.localMilestoneRoot,
    options.clusterMilestoneRoot,
  );
  const root = fs.realpathSync(path.resolve(options.root || DEFAULT_ROOT));
  const outputRoot = path.resolve(options.outputRoot || '');
  const parent = path.dirname(outputRoot);
  if (
    !path.isAbsolute(outputRoot) ||
    fs.existsSync(outputRoot) ||
    fs.realpathSync(parent) !== parent ||
    outputRoot === milestones.localRoot ||
    outputRoot === milestones.clusterRoot
  ) {
    fail('stage index output is invalid');
  }
  if (
    !REVISION_PATTERN.test(options.sourceRevision || '') ||
    options.sourceRevision !== milestones.local.sourceRevision ||
    options.repository !== WORKFLOW_IDENTITY.repository ||
    options.workflowRef !== WORKFLOW_IDENTITY.workflowRef ||
    options.workflowSha !== options.sourceRevision ||
    options.eventName !== WORKFLOW_IDENTITY.event ||
    options.runId !== milestones.local.workflow.runId ||
    options.runAttempt !== milestones.local.workflow.runAttempt ||
    !DECIMAL_ID_PATTERN.test(options.runId || '') ||
    !ATTEMPT_PATTERN.test(options.runAttempt || '')
  ) {
    fail('stage index workflow identity is invalid');
  }
  const release = readReleaseIdentity(root);
  if (release.version !== milestones.local.version) {
    fail('stage index milestones do not match the release version');
  }
  return Object.freeze({
    ...milestones,
    root,
    outputRoot,
    readme: assertCanonicalFile(
      options.readme,
      MAX_README_BYTES,
      'stage index README',
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

function finalizeAlphaStageIndex(options) {
  const normalized = validateFinalizeOptions(options);
  let created = false;
  try {
    fs.mkdirSync(normalized.outputRoot, { mode: 0o700 });
    created = true;
    copyExclusive(
      normalized.readme,
      path.join(normalized.outputRoot, FILES.readme),
    );
    const manifest = {
      schemaVersion: 2,
      schema: SCHEMA,
      maturity: 'alpha_stage_delivery_not_public_release',
      product: 'qinglong3',
      version: normalized.local.version,
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
      milestones: {
        local: {
          artifactName: milestoneArtifactName(
            normalized.sourceRevision,
            'local',
            normalized.local.variant,
          ),
          schema: normalized.local.schema,
          maturity: normalized.local.maturity,
          manifest: fileRecord(
            path.join(normalized.localRoot, 'manifest.json'),
            'manifest.json',
          ),
        },
        cluster: {
          artifactName: milestoneArtifactName(
            normalized.sourceRevision,
            'cluster',
            undefined,
          ),
          schema: normalized.cluster.schema,
          maturity: normalized.cluster.maturity,
          manifest: fileRecord(
            path.join(normalized.clusterRoot, 'manifest.json'),
            'manifest.json',
          ),
        },
      },
      deploymentSelections: expectedSelections(
        normalized.local,
        normalized.cluster,
      ),
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
    auditAlphaStageIndex({
      stageRoot: normalized.outputRoot,
      localMilestoneRoot: normalized.localRoot,
      clusterMilestoneRoot: normalized.clusterRoot,
    });
    return Object.freeze(manifest);
  } catch (error) {
    if (created) {
      fs.rmSync(normalized.outputRoot, { recursive: true, force: true });
    }
    throw error;
  }
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

function auditAlphaStageIndexWorkflow(root = DEFAULT_ROOT) {
  const workflow = fs.readFileSync(
    path.join(
      fs.realpathSync(path.resolve(root)),
      '.github/workflows/ql3-ci.yml',
    ),
    'utf8',
  );
  const findings = [];
  const stage = jobBlock(workflow, 'alpha-stage-index');
  const condition =
    "github.event_name == 'workflow_dispatch' && inputs.produce_alpha_artifacts && inputs.alpha_artifact_scope == 'all'";
  const tokens = [
    'name: Finalize the cross-profile Alpha stage index',
    `if: ${condition}`,
    '      - local-alpha-milestone\n',
    '      - cluster-alpha-milestone\n',
    'pnpm/action-setup@v6',
    'cache-dependency-path: pnpm-lock.yaml',
    'pnpm install --frozen-lockfile --ignore-scripts',
    `name: ql3-alpha-${'${{ github.sha }}'}-local-${'${{ inputs.local_alpha_variant }}'}-milestone`,
    `name: ql3-alpha-${'${{ github.sha }}'}-cluster-milestone`,
    'scripts/ql3-alpha-stage-index.cjs',
    '--mode=finalize',
    '--mode=audit',
    `name: ql3-alpha-${'${{ github.sha }}'}-stage-index`,
    'retention-days: 30',
    'overwrite: false',
  ];
  if (!stage || tokens.some((token) => !stage.includes(token))) {
    findings.push('ALPHA_STAGE_INDEX_FINALIZER_CONTRACT_DRIFT');
  }
  const dependencyInstallIndex = stage.indexOf(
    'pnpm install --frozen-lockfile --ignore-scripts',
  );
  const finalizeIndex = stage.indexOf('--mode=finalize');
  const auditIndex = stage.indexOf('--mode=audit');
  const uploadIndex = stage.indexOf('actions/upload-artifact@');
  if (
    dependencyInstallIndex < 0 ||
    finalizeIndex <= dependencyInstallIndex ||
    auditIndex <= finalizeIndex ||
    uploadIndex <= auditIndex
  ) {
    findings.push('ALPHA_STAGE_INDEX_GATE_ORDER_DRIFT');
  }
  return Object.freeze({
    schemaVersion: 1,
    schema: 'qinglong/alpha-stage-index-workflow-audit@v1',
    requiredNeeds: ['local-alpha-milestone', 'cluster-alpha-milestone'],
    requiredScope: 'all',
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
  if (values.mode === 'audit-workflow') {
    if (
      JSON.stringify(Object.keys(values).sort()) !==
      JSON.stringify(['mode', 'root'])
    ) {
      fail('workflow audit arguments are invalid');
    }
    return { mode: values.mode, root: path.resolve(values.root) };
  }
  if (values.mode === 'audit') {
    const expected = ['cluster-milestone', 'local-milestone', 'mode', 'stage'];
    if (
      JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expected)
    ) {
      fail('stage audit arguments are invalid');
    }
    return {
      mode: values.mode,
      stageRoot: path.resolve(values.stage),
      localMilestoneRoot: path.resolve(values['local-milestone']),
      clusterMilestoneRoot: path.resolve(values['cluster-milestone']),
    };
  }
  const expected = [
    'cluster-milestone',
    'event',
    'local-milestone',
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
    fail('stage finalization arguments are invalid');
  }
  return {
    mode: values.mode,
    outputRoot: path.resolve(values.output),
    localMilestoneRoot: path.resolve(values['local-milestone']),
    clusterMilestoneRoot: path.resolve(values['cluster-milestone']),
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
    report = finalizeAlphaStageIndex(options);
  } else if (options.mode === 'audit-workflow') {
    report = auditAlphaStageIndexWorkflow(options.root);
    if (!report.compatible) fail(JSON.stringify(report));
  } else {
    report = auditAlphaStageIndex(options);
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
        error instanceof Error ? error.message : 'Alpha stage index failed'
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  ARCHITECTURES,
  FILES,
  SCHEMA,
  auditAlphaStageIndex,
  auditAlphaStageIndexWorkflow,
  finalizeAlphaStageIndex,
  milestoneArtifactName,
  parseArguments,
  runCli,
  stageArtifactName,
});
