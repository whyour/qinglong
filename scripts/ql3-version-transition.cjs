#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');
const {
  RELEASE_IDENTITY_PATH,
  RELEASE_IDENTITY_SCHEMA,
  VERSION_PATTERN,
  readReleaseIdentity,
} = require('./lib/ql3-release-identity.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const PLAN_SCHEMA = 'qinglong/version-transition-plan@v1';
const REPORT_SCHEMA = 'qinglong/version-transition-report@v1';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const MAX_GOVERNED_FILES = 512;
const CONTAINER_ROOTS = Object.freeze([
  'deploy/containers/ql3-cluster-control',
  'deploy/containers/ql3-cluster-admin',
  'deploy/containers/ql3-local-application',
  'deploy/containers/ql3-worker',
]);
const DEPLOYMENT_ROOTS = Object.freeze([
  'deploy/kubernetes/ql3-cluster',
  'deploy/kubernetes/ql3-worker',
]);
const DEPLOYMENT_FILES = Object.freeze([
  'deploy/console/ql3-cluster-copilot/README.md',
]);
const CONTAINER_FILES = Object.freeze([
  'Dockerfile',
  'package.json',
  'package-lock.json',
  'runtime-dependencies/package.json',
  'runtime-dependencies/package-lock.json',
]);
const TEXT_EXTENSIONS = new Set(['.json', '.md', '.yaml', '.yml']);
const IMAGE_TAG_PATTERN =
  /qinglong3-(?:cluster-control-ai|cluster-control|cluster-admin|local-application|worker):([0-9A-Za-z.-]+)/gu;
const SOURCE_TAG_PATTERN = /refs\/tags\/v(3\.[0-9A-Za-z.-]+)/gu;

class QingLong3VersionTransitionError extends Error {
  constructor(message) {
    super(`QingLong 3 version transition failed: ${message}`);
    this.name = 'QingLong3VersionTransitionError';
  }
}

function fail(message) {
  throw new QingLong3VersionTransitionError(message);
}

function sha256(contents) {
  return `sha256:${crypto.createHash('sha256').update(contents).digest('hex')}`;
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected)
  );
}

function resolveRoot(root) {
  return fs.realpathSync(path.resolve(root || DEFAULT_ROOT));
}

function resolveGovernedPath(root, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length < 1 ||
    relativePath.length > 512 ||
    path.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.includes('\\') ||
    relativePath.split('/').includes('..')
  ) {
    fail('governed path must be one canonical repository-relative path');
  }
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    fail('governed path escapes the repository');
  }
  return resolved;
}

function readRegularFile(root, relativePath, maximumBytes = MAX_FILE_BYTES) {
  const filePath = resolveGovernedPath(root, relativePath);
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > maximumBytes ||
    fs.realpathSync(filePath) !== filePath ||
    fs.realpathSync(path.dirname(filePath)) !== path.dirname(filePath)
  ) {
    fail(`invalid governed regular file: ${relativePath}`);
  }
  return Object.freeze({
    filePath,
    contents: fs.readFileSync(filePath, 'utf8'),
    mode: stat.mode & 0o777,
  });
}

function readJson(root, relativePath) {
  const file = readRegularFile(root, relativePath);
  try {
    return Object.freeze({ ...file, value: JSON.parse(file.contents) });
  } catch {
    fail(`governed JSON is invalid: ${relativePath}`);
  }
}

function walkTextFiles(root, relativeDirectory, output = []) {
  const directory = resolveGovernedPath(root, relativeDirectory);
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(directory) !== directory
  ) {
    fail(`invalid governed directory: ${relativeDirectory}`);
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink())
      fail(`symbolic link in governed tree: ${relativePath}`);
    if (entry.isDirectory()) {
      walkTextFiles(root, relativePath, output);
      continue;
    }
    if (!entry.isFile())
      fail(`unsupported entry in governed tree: ${relativePath}`);
    if (TEXT_EXTENSIONS.has(path.extname(entry.name)))
      output.push(relativePath);
    if (output.length > MAX_GOVERNED_FILES)
      fail('governed file ceiling exceeded');
  }
  return output;
}

function workspaceManifestPaths(root) {
  const packagesRoot = resolveGovernedPath(root, 'packages');
  const entries = fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('ql3-'))
    .map((entry) => `packages/${entry.name}/package.json`)
    .sort();
  return Object.freeze(entries);
}

function fixedContainerPaths() {
  return Object.freeze(
    CONTAINER_ROOTS.flatMap((root) =>
      CONTAINER_FILES.map((file) => `${root}/${file}`),
    ).sort(),
  );
}

function deploymentTextPaths(root) {
  return Object.freeze(
    [
      ...DEPLOYMENT_ROOTS.flatMap((directory) =>
        walkTextFiles(root, directory),
      ),
      ...DEPLOYMENT_FILES,
    ].sort(),
  );
}

function versionOccurrences(contents, version) {
  return contents.split(version).length - 1;
}

function taggedVersions(contents) {
  return Object.freeze([
    ...[...contents.matchAll(IMAGE_TAG_PATTERN)].map((match) => match[1]),
    ...[...contents.matchAll(SOURCE_TAG_PATTERN)].map((match) => match[1]),
  ]);
}

function auditReleaseVersionContract(rootInput = DEFAULT_ROOT) {
  const root = resolveRoot(rootInput);
  const identity = readReleaseIdentity(root);
  const legacyRoot = readJson(root, 'package.json').value;
  if (
    typeof legacyRoot.version !== 'string' ||
    !/^2\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/u.test(
      legacyRoot.version,
    ) ||
    legacyRoot.version === identity.version
  ) {
    fail('legacy root package must remain outside the 3.0 release identity');
  }

  const workspacePaths = workspaceManifestPaths(root);
  if (workspacePaths.length !== identity.workspacePackageCount) {
    fail('workspace package count differs from the release identity');
  }
  for (const relativePath of workspacePaths) {
    const manifest = readJson(root, relativePath).value;
    if (
      typeof manifest.name !== 'string' ||
      !manifest.name.startsWith('@qinglong/') ||
      manifest.version !== identity.version ||
      manifest.engines?.node !== identity.node.engine
    ) {
      fail(`workspace package release identity drifted: ${relativePath}`);
    }
  }

  for (const containerRoot of CONTAINER_ROOTS) {
    const buildManifest = readJson(root, `${containerRoot}/package.json`).value;
    const buildLock = readJson(
      root,
      `${containerRoot}/package-lock.json`,
    ).value;
    const runtimeManifest = readJson(
      root,
      `${containerRoot}/runtime-dependencies/package.json`,
    ).value;
    const runtimeLock = readJson(
      root,
      `${containerRoot}/runtime-dependencies/package-lock.json`,
    ).value;
    if (
      buildManifest.version !== identity.version ||
      runtimeManifest.version !== identity.version ||
      buildManifest.engines?.node !== identity.node.engine ||
      runtimeManifest.engines?.node !== identity.node.engine ||
      buildLock.version !== identity.version ||
      buildLock.packages?.['']?.version !== identity.version ||
      runtimeLock.version !== identity.version ||
      runtimeLock.packages?.['']?.version !== identity.version
    ) {
      fail(
        `container manifest or lock release identity drifted: ${containerRoot}`,
      );
    }
    const dockerfile = readRegularFile(
      root,
      `${containerRoot}/Dockerfile`,
    ).contents;
    if (
      !dockerfile.includes(
        `node:${identity.node.version}-bookworm-slim@sha256:`,
      ) ||
      versionOccurrences(
        dockerfile,
        `org.opencontainers.image.version=\"${identity.version}\"`,
      ) !== 1
    ) {
      fail(`container Dockerfile release identity drifted: ${containerRoot}`);
    }
  }

  let deploymentVersionOccurrences = 0;
  let deploymentImageReferences = 0;
  const deploymentFiles = deploymentTextPaths(root);
  for (const relativePath of deploymentFiles) {
    const contents = readRegularFile(root, relativePath).contents;
    const versions = taggedVersions(contents);
    if (versions.some((version) => version !== identity.version)) {
      fail(`deployment release identity drifted: ${relativePath}`);
    }
    deploymentImageReferences += [...contents.matchAll(IMAGE_TAG_PATTERN)]
      .length;
    deploymentVersionOccurrences += versionOccurrences(
      contents,
      identity.version,
    );
  }
  if (deploymentImageReferences < 4 || deploymentVersionOccurrences < 4) {
    fail('deployment release identity coverage is incomplete');
  }

  return Object.freeze({
    schemaVersion: identity.schemaVersion,
    schema: RELEASE_IDENTITY_SCHEMA,
    version: identity.version,
    nodeVersion: identity.node.version,
    nodeEngine: identity.node.engine,
    architectureSupport: Object.freeze({
      tier1: Object.freeze([...identity.architectureSupport.tier1]),
      candidates: Object.freeze([...identity.architectureSupport.candidates]),
      experimentalBlocked: Object.freeze([
        ...identity.architectureSupport.experimentalBlocked,
      ]),
      legacyOnly: Object.freeze([...identity.architectureSupport.legacyOnly]),
      legacyLine: identity.architectureSupport.legacyLine,
    }),
    legacyRootPackageVersion: legacyRoot.version,
    legacyRootExcluded: true,
    workspacePackageCount: workspacePaths.length,
    containerRootCount: CONTAINER_ROOTS.length,
    deploymentFileCount: deploymentFiles.length,
    deploymentImageReferences,
    deploymentVersionOccurrences,
    compatible: true,
  });
}

function governedTransitionPaths(root, version) {
  const deploymentPaths = deploymentTextPaths(root).filter((relativePath) =>
    readRegularFile(root, relativePath).contents.includes(version),
  );
  return Object.freeze(
    [
      RELEASE_IDENTITY_PATH,
      ...workspaceManifestPaths(root),
      ...fixedContainerPaths(),
      ...deploymentPaths,
    ].sort(),
  );
}

function validateVersionTransition(sourceVersion, targetVersion) {
  if (
    typeof sourceVersion !== 'string' ||
    typeof targetVersion !== 'string' ||
    !VERSION_PATTERN.test(sourceVersion) ||
    !VERSION_PATTERN.test(targetVersion) ||
    semver.valid(sourceVersion) !== sourceVersion ||
    semver.valid(targetVersion) !== targetVersion ||
    !semver.gt(targetVersion, sourceVersion)
  ) {
    fail('target must be one exact monotonically newer QingLong 3 SemVer');
  }
}

function createVersionTransitionPlan(options = {}) {
  const root = resolveRoot(options.root || DEFAULT_ROOT);
  validateVersionTransition(options.sourceVersion, options.targetVersion);
  const audit = auditReleaseVersionContract(root);
  if (audit.version !== options.sourceVersion) {
    fail('source version differs from the current release identity');
  }
  const paths = governedTransitionPaths(root, options.sourceVersion);
  const entries = paths.map((relativePath) => {
    const file = readRegularFile(root, relativePath);
    const replacementCount = versionOccurrences(
      file.contents,
      options.sourceVersion,
    );
    if (replacementCount < 1) {
      fail(`governed transition target has no source version: ${relativePath}`);
    }
    const next = file.contents
      .split(options.sourceVersion)
      .join(options.targetVersion);
    return Object.freeze({
      path: relativePath,
      mode: file.mode,
      replacementCount,
      beforeBytes: Buffer.byteLength(file.contents),
      afterBytes: Buffer.byteLength(next),
      beforeDigest: sha256(file.contents),
      afterDigest: sha256(next),
    });
  });
  const unsigned = {
    schemaVersion: 1,
    schema: PLAN_SCHEMA,
    sourceVersion: options.sourceVersion,
    targetVersion: options.targetVersion,
    legacyRootPackageVersion: audit.legacyRootPackageVersion,
    legacyRootExcluded: true,
    fileCount: entries.length,
    replacementCount: entries.reduce(
      (total, entry) => total + entry.replacementCount,
      0,
    ),
    entries,
  };
  return Object.freeze({
    ...unsigned,
    planDigest: sha256(JSON.stringify(unsigned)),
  });
}

function validatePlan(plan) {
  if (
    !exactKeys(plan, [
      'schemaVersion',
      'schema',
      'sourceVersion',
      'targetVersion',
      'legacyRootPackageVersion',
      'legacyRootExcluded',
      'fileCount',
      'replacementCount',
      'entries',
      'planDigest',
    ]) ||
    plan.schemaVersion !== 1 ||
    plan.schema !== PLAN_SCHEMA ||
    plan.legacyRootExcluded !== true ||
    !Array.isArray(plan.entries) ||
    plan.entries.length < 1 ||
    plan.entries.length > MAX_GOVERNED_FILES ||
    plan.fileCount !== plan.entries.length
  ) {
    fail('version transition plan shape is invalid');
  }
  validateVersionTransition(plan.sourceVersion, plan.targetVersion);
  let previousPath = '';
  let replacements = 0;
  for (const entry of plan.entries) {
    if (
      !exactKeys(entry, [
        'path',
        'mode',
        'replacementCount',
        'beforeBytes',
        'afterBytes',
        'beforeDigest',
        'afterDigest',
      ]) ||
      typeof entry.path !== 'string' ||
      entry.path <= previousPath ||
      !Number.isSafeInteger(entry.mode) ||
      entry.mode < 0o400 ||
      entry.mode > 0o777 ||
      !Number.isSafeInteger(entry.replacementCount) ||
      entry.replacementCount < 1 ||
      !Number.isSafeInteger(entry.beforeBytes) ||
      entry.beforeBytes < 1 ||
      entry.beforeBytes > MAX_FILE_BYTES ||
      !Number.isSafeInteger(entry.afterBytes) ||
      entry.afterBytes < 1 ||
      entry.afterBytes > MAX_FILE_BYTES ||
      !/^sha256:[a-f0-9]{64}$/u.test(entry.beforeDigest || '') ||
      !/^sha256:[a-f0-9]{64}$/u.test(entry.afterDigest || '') ||
      entry.beforeDigest === entry.afterDigest
    ) {
      fail('version transition plan entry is invalid');
    }
    previousPath = entry.path;
    replacements += entry.replacementCount;
  }
  if (plan.replacementCount !== replacements) {
    fail('version transition replacement count drifted');
  }
  const { planDigest, ...unsigned } = plan;
  if (planDigest !== sha256(JSON.stringify(unsigned))) {
    fail('version transition plan digest drifted');
  }
  return plan;
}

function readPlan(filePath) {
  const resolved = path.resolve(filePath || '');
  if (!path.isAbsolute(filePath || '')) fail('plan path must be absolute');
  const stat = fs.lstatSync(resolved);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 2 ||
    stat.size > MAX_PLAN_BYTES ||
    fs.realpathSync(resolved) !== resolved
  ) {
    fail('plan must be one bounded canonical regular file');
  }
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    fail('plan must contain valid JSON');
  }
  return validatePlan(plan);
}

function outputPathReady(filePath) {
  const resolved = path.resolve(filePath || '');
  if (
    !path.isAbsolute(filePath || '') ||
    fs.existsSync(resolved) ||
    fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)
  ) {
    fail('output must be unused in one canonical directory');
  }
  return resolved;
}

function writeNoReplace(filePath, value) {
  const resolved = outputPathReady(filePath);
  fs.writeFileSync(resolved, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

function validatePlanCoverage(root, plan) {
  const legacyVersion = readJson(root, 'package.json').value.version;
  if (legacyVersion !== plan.legacyRootPackageVersion) {
    fail('legacy root package changed after plan creation');
  }
  const expectedPaths = new Set([
    RELEASE_IDENTITY_PATH,
    ...workspaceManifestPaths(root),
    ...fixedContainerPaths(),
  ]);
  for (const relativePath of deploymentTextPaths(root)) {
    const contents = readRegularFile(root, relativePath).contents;
    const versions = taggedVersions(contents);
    if (
      versions.some(
        (version) =>
          version !== plan.sourceVersion && version !== plan.targetVersion,
      )
    ) {
      fail(`deployment version is outside the transition: ${relativePath}`);
    }
    if (
      contents.includes(plan.sourceVersion) ||
      contents.includes(plan.targetVersion)
    ) {
      expectedPaths.add(relativePath);
    }
  }
  const actualPaths = plan.entries.map((entry) => entry.path);
  if (
    JSON.stringify([...expectedPaths].sort()) !== JSON.stringify(actualPaths)
  ) {
    fail('version transition plan does not cover the exact governed file set');
  }
}

function temporaryPath(filePath, planDigest) {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.ql3-version-${planDigest.slice(7, 23)}.tmp`,
  );
}

function materializeTarget(file, entry, plan) {
  const next = file.contents.split(plan.sourceVersion).join(plan.targetVersion);
  if (
    versionOccurrences(file.contents, plan.sourceVersion) !==
      entry.replacementCount ||
    Buffer.byteLength(next) !== entry.afterBytes ||
    sha256(next) !== entry.afterDigest
  ) {
    fail(`source content no longer derives the planned target: ${entry.path}`);
  }
  return next;
}

function applyVersionTransitionPlan(planInput, options = {}) {
  const root = resolveRoot(options.root || DEFAULT_ROOT);
  const plan = validatePlan(planInput);
  outputPathReady(options.report);
  validatePlanCoverage(root, plan);

  const states = plan.entries.map((entry) => {
    const file = readRegularFile(root, entry.path);
    const digest = sha256(file.contents);
    const state =
      digest === entry.beforeDigest
        ? 'source'
        : digest === entry.afterDigest
        ? 'target'
        : null;
    if (!state || file.mode !== entry.mode) {
      fail(`governed file drifted after plan creation: ${entry.path}`);
    }
    const next =
      state === 'source' ? materializeTarget(file, entry, plan) : null;
    const tempPath = temporaryPath(file.filePath, plan.planDigest);
    if (fs.existsSync(tempPath)) {
      const temp = fs.lstatSync(tempPath);
      const tempContents =
        temp.isFile() && !temp.isSymbolicLink()
          ? fs.readFileSync(tempPath, 'utf8')
          : '';
      if (
        fs.realpathSync(tempPath) !== tempPath ||
        (temp.mode & 0o777) !== entry.mode ||
        sha256(tempContents) !== entry.afterDigest
      ) {
        fail(`deterministic recovery file drifted: ${entry.path}`);
      }
    }
    return Object.freeze({ entry, file, state, next, tempPath });
  });

  let changedFiles = 0;
  let alreadyCurrentFiles = 0;
  for (const state of states) {
    if (state.state === 'target') {
      alreadyCurrentFiles += 1;
      if (fs.existsSync(state.tempPath)) fs.unlinkSync(state.tempPath);
      continue;
    }
    if (!fs.existsSync(state.tempPath)) {
      const descriptor = fs.openSync(
        state.tempPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        state.entry.mode,
      );
      try {
        fs.writeFileSync(descriptor, state.next, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    fs.renameSync(state.tempPath, state.file.filePath);
    changedFiles += 1;
  }

  const audit = auditReleaseVersionContract(root);
  if (audit.version !== plan.targetVersion) {
    fail('post-transition release identity is incompatible');
  }
  const reportUnsigned = {
    schemaVersion: 1,
    schema: REPORT_SCHEMA,
    planDigest: plan.planDigest,
    sourceVersion: plan.sourceVersion,
    targetVersion: plan.targetVersion,
    fileCount: plan.fileCount,
    changedFiles,
    alreadyCurrentFiles,
    exactReplay: alreadyCurrentFiles === plan.fileCount,
    legacyRootPackageVersion: audit.legacyRootPackageVersion,
    legacyRootExcluded: true,
    compatible: true,
  };
  const report = Object.freeze({
    ...reportUnsigned,
    reportDigest: sha256(JSON.stringify(reportUnsigned)),
  });
  writeNoReplace(options.report, report);
  return report;
}

function parseArguments(argv) {
  const values = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || Object.hasOwn(values, match[1]))
      fail('arguments are invalid');
    values[match[1]] = match[2];
  }
  const expected =
    values.mode === 'audit'
      ? ['mode']
      : values.mode === 'plan'
      ? ['from', 'mode', 'output', 'to']
      : values.mode === 'apply'
      ? ['mode', 'plan', 'report']
      : [];
  if (
    expected.length === 0 ||
    JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expected)
  ) {
    fail('arguments are invalid');
  }
  return Object.freeze(values);
}

function runCli(argv, root = DEFAULT_ROOT, output = process.stdout) {
  const options = parseArguments(argv);
  if (options.mode === 'audit') {
    const audit = auditReleaseVersionContract(root);
    output.write(`${JSON.stringify(audit)}\n`);
    return audit;
  }
  if (options.mode === 'plan') {
    const plan = createVersionTransitionPlan({
      root,
      sourceVersion: options.from,
      targetVersion: options.to,
    });
    writeNoReplace(options.output, plan);
    output.write(`${JSON.stringify(plan)}\n`);
    return plan;
  }
  const plan = readPlan(options.plan);
  const report = applyVersionTransitionPlan(plan, {
    root,
    report: options.report,
  });
  output.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof Error ? error.message : 'version transition failed'
      }\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  CONTAINER_ROOTS,
  DEPLOYMENT_FILES,
  DEPLOYMENT_ROOTS,
  PLAN_SCHEMA,
  REPORT_SCHEMA,
  QingLong3VersionTransitionError,
  applyVersionTransitionPlan,
  auditReleaseVersionContract,
  createVersionTransitionPlan,
  parseArguments,
  readPlan,
  runCli,
  validatePlan,
});
