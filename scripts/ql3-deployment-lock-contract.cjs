#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { inspectReleaseSet } = require('./ql3-release-set-contract.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const LOCAL_SELECTION_SCHEMA = 'qinglong/local-compose-release-image@v1';
const KUBERNETES_LOCK_SCHEMA = 'qinglong/kubernetes-deployment-lock@v1';
const MAX_RELEASE_SET_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_RESOURCE_COUNT = 2048;
const MAX_STRUCTURE_DEPTH = 64;
const ROLE_ORDER = Object.freeze(['control', 'control-ai', 'admin', 'worker']);
const IMAGE_NAMES = Object.freeze({
  control: 'qinglong3-cluster-control',
  'control-ai': 'qinglong3-cluster-control-ai',
  admin: 'qinglong3-cluster-admin',
  worker: 'qinglong3-worker',
});
const EXPECTED_SOURCE_SURFACES = Object.freeze({
  control: 2,
  'control-ai': 1,
  admin: 26,
  worker: 2,
});
const ADMISSION_CONFIG_NAME = 'ql3-plugin-package-secret-action-admission';

class QingLong3DeploymentLockError extends Error {
  constructor(message) {
    super(`QingLong 3 deployment lock failed: ${message}`);
    this.name = 'QingLong3DeploymentLockError';
  }
}

function fail(message) {
  throw new QingLong3DeploymentLockError(message);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function resolveCanonicalAbsolute(input, label) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    fail(`${label} path must be absolute`);
  }
  const resolved = path.resolve(input);
  if (resolved !== input) fail(`${label} path must be normalized`);
  return resolved;
}

function readBoundedFile(filePath, label, maximumBytes) {
  const resolved = resolveCanonicalAbsolute(filePath, label);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail(`${label} is unavailable`);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > maximumBytes ||
    fs.realpathSync(resolved) !== resolved ||
    fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)
  ) {
    fail(`${label} must be one bounded canonical regular file`);
  }
  const buffer = fs.readFileSync(resolved);
  const contents = buffer.toString('utf8');
  if (!Buffer.from(contents, 'utf8').equals(buffer)) {
    fail(`${label} must contain valid UTF-8`);
  }
  return Object.freeze({
    path: resolved,
    contents,
  });
}

function parseCanonicalJson(contents, label) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    fail(`${label} must contain valid JSON`);
  }
  if (canonicalJson(value) !== contents) {
    fail(`${label} must use exact canonical JSON encoding`);
  }
  return value;
}

function readCanonicalJson(filePath, label, maximumBytes) {
  const file = readBoundedFile(filePath, label, maximumBytes);
  return Object.freeze({
    ...file,
    value: parseCanonicalJson(file.contents, label),
  });
}

function preflightOutput(filePath, label) {
  const resolved = resolveCanonicalAbsolute(filePath, label);
  if (
    fs.existsSync(resolved) ||
    fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)
  ) {
    fail(`${label} must be unused in one canonical directory`);
  }
  return resolved;
}

function writeNoReplace(filePath, contents) {
  fs.writeFileSync(filePath, contents, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

function inspectInputReleaseSet(releaseSet, options) {
  return inspectReleaseSet(releaseSet, {
    version: options.version,
    sourceRevision: options.sourceRevision,
    sourceRef: options.sourceRef,
    releaseScope: options.releaseScope,
    repositoryOwner: options.repositoryOwner,
  });
}

function imageByName(releaseSet, name) {
  const matches = releaseSet.images.filter((entry) => entry.name === name);
  if (matches.length !== 1) fail(`release image is unavailable: ${name}`);
  return matches[0];
}

function createLocalSelection(releaseSet, options) {
  const inspection = inspectInputReleaseSet(releaseSet, options);
  if (!['local', 'all'].includes(options.releaseScope)) {
    fail('local selection requires a local or all release set');
  }
  if (options.allowRootService !== true && options.allowRootService !== false) {
    fail('allow-root-service must be an explicit boolean');
  }
  const local = imageByName(releaseSet, 'local');
  const unsigned = {
    schemaVersion: 1,
    schema: LOCAL_SELECTION_SCHEMA,
    release: { ...releaseSet.release },
    releaseSetDigest: releaseSet.releaseSetDigest,
    deploymentFamily: 'local',
    service: {
      kind: 'compose',
      image: local.reference,
      allowRootService: options.allowRootService,
    },
    verification: {
      releaseSet: inspection.verification,
      sourceRecordsReplayed: inspection.sourceRecordsReplayed,
      networkAccess: false,
      deploymentMutation: false,
    },
  };
  return Object.freeze({
    ...unsigned,
    selectionDigest: sha256(JSON.stringify(unsigned)),
  });
}

function auditLocalSelection(actual, releaseSet, options) {
  const expected = createLocalSelection(releaseSet, options);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('local selection differs from the verified release set');
  }
  return Object.freeze({
    compatible: true,
    deploymentFamily: 'local',
    releaseSetDigest: actual.releaseSetDigest,
    selectionDigest: actual.selectionDigest,
    image: actual.service.image,
    networkAccess: false,
    deploymentMutation: false,
  });
}

function parseRequiredImages(value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('required images must be explicit');
  }
  const names = value.split(',');
  const ordered = ROLE_ORDER.filter((name) => names.includes(name));
  if (
    names.some((name) => !ROLE_ORDER.includes(name)) ||
    new Set(names).size !== names.length ||
    JSON.stringify(names) !== JSON.stringify(ordered)
  ) {
    fail('required images must be unique and use release order');
  }
  return Object.freeze(names);
}

function normalizePlain(value, seen = new WeakSet(), depth = 0) {
  if (depth > MAX_STRUCTURE_DEPTH) fail('manifest structure is too deep');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== 'object') fail('manifest contains unsupported data');
  if (seen.has(value)) fail('manifest aliases and cycles are not allowed');
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => normalizePlain(entry, seen, depth + 1));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail('manifest contains a non-plain object');
  }
  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== 'string' || key.length === 0) {
      fail('manifest key is invalid');
    }
    normalized[key] = normalizePlain(entry, seen, depth + 1);
  }
  return normalized;
}

function parseManifest(contents) {
  const resources = [];
  try {
    yaml.loadAll(contents, (document) => {
      if (document !== undefined && document !== null) resources.push(document);
    });
  } catch {
    fail('input manifest must be valid duplicate-free YAML');
  }
  if (resources.length === 0 || resources.length > MAX_RESOURCE_COUNT) {
    fail('input manifest resource count is invalid');
  }
  return resources.map((resource) => {
    const normalized = normalizePlain(resource);
    if (
      normalized === null ||
      typeof normalized !== 'object' ||
      Array.isArray(normalized)
    ) {
      fail('each manifest resource must be one mapping');
    }
    return normalized;
  });
}

function renderManifest(resources) {
  return resources
    .map((resource) =>
      yaml.dump(resource, {
        noCompatMode: true,
        noRefs: true,
        lineWidth: -1,
        sortKeys: false,
      }),
    )
    .join('---\n');
}

function roleFromImage(value) {
  if (typeof value !== 'string') return null;
  for (const role of ROLE_ORDER) {
    const imageName = IMAGE_NAMES[role];
    if (
      new RegExp(
        `^(?:[A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]+)?/)*${imageName}(?::[^@\\s]+|@sha256:[a-f0-9]{64})$`,
        'u',
      ).test(value)
    ) {
      return role;
    }
  }
  return null;
}

function mentionsRoleImageName(value) {
  return (
    typeof value === 'string' &&
    ROLE_ORDER.some((role) => value.includes(IMAGE_NAMES[role]))
  );
}

function podSpecFor(resource) {
  const kind = resource.kind;
  if (kind === 'Pod') return resource.spec;
  if (['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(kind)) {
    return resource.spec?.template?.spec;
  }
  if (kind === 'Job') return resource.spec?.template?.spec;
  if (kind === 'CronJob')
    return resource.spec?.jobTemplate?.spec?.template?.spec;
  return undefined;
}

function ensureAnnotations(target, releaseSet) {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    fail('rewritten resource metadata is invalid');
  }
  const metadata = target.metadata ?? {};
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    (metadata.annotations !== undefined &&
      (metadata.annotations === null ||
        typeof metadata.annotations !== 'object' ||
        Array.isArray(metadata.annotations)))
  ) {
    fail('rewritten resource annotations are invalid');
  }
  metadata.annotations = {
    ...(metadata.annotations ?? {}),
    'qinglong.io/release-set-digest': releaseSet.releaseSetDigest,
    'qinglong.io/release-source-revision': releaseSet.release.sourceRevision,
    'qinglong.io/release-version': releaseSet.release.version,
  };
  target.metadata = metadata;
}

function rewriteContainerList(list, references, counts, handledAuthorities) {
  if (list === undefined) return 0;
  if (!Array.isArray(list)) fail('container list is invalid');
  let rewritten = 0;
  for (const container of list) {
    if (
      container === null ||
      typeof container !== 'object' ||
      Array.isArray(container)
    ) {
      fail('container is invalid');
    }
    const role = roleFromImage(container.image);
    if (!role) {
      if (mentionsRoleImageName(container.image))
        fail('container image is malformed');
      continue;
    }
    container.image = references[role];
    handledAuthorities.add(container);
    counts[role] += 1;
    rewritten += 1;
  }
  return rewritten;
}

function scanForUnhandledRoleImages(
  value,
  references,
  handledAuthorities,
  pathSegments = [],
  parent,
  parentKey,
) {
  if (typeof value === 'string') {
    const role = roleFromImage(value);
    if (
      role &&
      (value !== references[role] ||
        parentKey !== 'image' ||
        !handledAuthorities.has(parent))
    ) {
      fail(`unhandled QingLong image authority: ${pathSegments.join('.')}`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanForUnhandledRoleImages(
        entry,
        references,
        handledAuthorities,
        [...pathSegments, String(index)],
        value,
        String(index),
      ),
    );
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    scanForUnhandledRoleImages(
      entry,
      references,
      handledAuthorities,
      [...pathSegments, key],
      value,
      key,
    );
  }
}

function rewriteKubernetesResources(resources, releaseSet, requiredImages) {
  const references = Object.fromEntries(
    ROLE_ORDER.map((role) => [role, imageByName(releaseSet, role).reference]),
  );
  const counts = Object.fromEntries(ROLE_ORDER.map((role) => [role, 0]));
  const handledAuthorities = new WeakSet();
  let changedResources = 0;
  let admissionAuthorityCount = 0;
  for (const resource of resources) {
    let changed = 0;
    const podSpec = podSpecFor(resource);
    if (podSpec !== undefined) {
      if (
        podSpec === null ||
        typeof podSpec !== 'object' ||
        Array.isArray(podSpec)
      ) {
        fail('pod spec is invalid');
      }
      for (const key of [
        'initContainers',
        'containers',
        'ephemeralContainers',
      ]) {
        changed += rewriteContainerList(
          podSpec[key],
          references,
          counts,
          handledAuthorities,
        );
      }
    }
    if (
      resource.apiVersion === 'v1' &&
      resource.kind === 'ConfigMap' &&
      resource.metadata?.name === ADMISSION_CONFIG_NAME
    ) {
      if (
        resource.data === null ||
        typeof resource.data !== 'object' ||
        Array.isArray(resource.data) ||
        roleFromImage(resource.data.image) !== 'admin'
      ) {
        fail('plugin-package admission image authority is invalid');
      }
      resource.data.image = references.admin;
      handledAuthorities.add(resource.data);
      counts.admin += 1;
      admissionAuthorityCount += 1;
      changed += 1;
    }
    if (changed > 0) {
      ensureAnnotations(resource, releaseSet);
      const template =
        resource.kind === 'CronJob'
          ? resource.spec?.jobTemplate?.spec?.template
          : resource.kind === 'Job'
          ? resource.spec?.template
          : ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(
              resource.kind,
            )
          ? resource.spec?.template
          : undefined;
      if (template) ensureAnnotations(template, releaseSet);
      changedResources += 1;
    }
  }
  for (const resource of resources) {
    scanForUnhandledRoleImages(resource, references, handledAuthorities);
  }
  for (const role of requiredImages) {
    if (counts[role] < 1) fail(`required image was not rendered: ${role}`);
  }
  if (Object.values(counts).every((count) => count === 0)) {
    fail('manifest contains no QingLong deployment image');
  }
  return Object.freeze({
    resources,
    counts: Object.freeze({ ...counts }),
    changedResources,
    admissionAuthorityCount,
  });
}

function createKubernetesLock(releaseSet, manifestContents, options) {
  const inspection = inspectInputReleaseSet(releaseSet, options);
  if (!['cluster', 'all'].includes(options.releaseScope)) {
    fail('Kubernetes materialization requires a cluster or all release set');
  }
  const requiredImages = parseRequiredImages(options.requiredImages);
  const parsed = parseManifest(manifestContents);
  const rewritten = rewriteKubernetesResources(
    parsed,
    releaseSet,
    requiredImages,
  );
  const outputManifest = renderManifest(rewritten.resources);
  if (Buffer.byteLength(outputManifest, 'utf8') > MAX_MANIFEST_BYTES) {
    fail('output manifest exceeds the bounded size');
  }
  const unsigned = {
    schemaVersion: 1,
    schema: KUBERNETES_LOCK_SCHEMA,
    release: { ...releaseSet.release },
    releaseSetDigest: releaseSet.releaseSetDigest,
    deploymentFamily: 'cluster',
    requiredImages: [...requiredImages],
    imageOccurrences: ROLE_ORDER.map((name) => ({
      name,
      reference: imageByName(releaseSet, name).reference,
      count: rewritten.counts[name],
    })),
    manifest: {
      inputDigest: sha256(manifestContents),
      outputDigest: sha256(outputManifest),
      resources: parsed.length,
      changedResources: rewritten.changedResources,
      admissionAuthorityCount: rewritten.admissionAuthorityCount,
    },
    verification: {
      releaseSet: inspection.verification,
      sourceRecordsReplayed: inspection.sourceRecordsReplayed,
      unknownImageAuthorities: 0,
      mutableQingLongImages: 0,
      networkAccess: false,
      kubernetesMutation: false,
    },
  };
  const report = Object.freeze({
    ...unsigned,
    lockDigest: sha256(JSON.stringify(unsigned)),
  });
  return Object.freeze({ outputManifest, report });
}

function auditKubernetesLock(
  actualManifest,
  actualReport,
  releaseSet,
  sourceManifest,
  options,
) {
  const expected = createKubernetesLock(releaseSet, sourceManifest, options);
  if (
    actualManifest !== expected.outputManifest ||
    JSON.stringify(actualReport) !== JSON.stringify(expected.report)
  ) {
    fail('Kubernetes deployment lock differs from the verified release set');
  }
  return Object.freeze({
    compatible: true,
    deploymentFamily: 'cluster',
    releaseSetDigest: actualReport.releaseSetDigest,
    lockDigest: actualReport.lockDigest,
    outputManifestDigest: actualReport.manifest.outputDigest,
    requiredImages: Object.freeze([...actualReport.requiredImages]),
    networkAccess: false,
    kubernetesMutation: false,
  });
}

function listYamlFiles(root) {
  const files = [];
  const visit = (directory) => {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('deployment source directory is invalid');
    }
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const child = fs.lstatSync(target);
      if (child.isSymbolicLink()) fail('deployment source symlink is invalid');
      if (child.isDirectory()) visit(target);
      else if (child.isFile() && /\.ya?ml$/u.test(name)) files.push(target);
    }
  };
  visit(root);
  return files;
}

function auditDeploymentImageSurfaces(root = DEFAULT_ROOT) {
  const deploymentRoots = [
    path.join(root, 'deploy/kubernetes/ql3-cluster'),
    path.join(root, 'deploy/kubernetes/ql3-worker'),
  ];
  const files = deploymentRoots.flatMap((directory) =>
    listYamlFiles(directory),
  );
  const counts = Object.fromEntries(ROLE_ORDER.map((role) => [role, 0]));
  let admissionAuthorityCount = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const role of ROLE_ORDER) {
      const matches = source.match(
        new RegExp(`${IMAGE_NAMES[role]}(?=[:@])`, 'gu'),
      );
      counts[role] += matches?.length ?? 0;
    }
    admissionAuthorityCount +=
      source.match(
        /image:\s+[^\n]*qinglong3-cluster-admin@sha256:[a-f0-9]{64}/gu,
      )?.length ?? 0;
  }
  if (
    JSON.stringify(counts) !== JSON.stringify(EXPECTED_SOURCE_SURFACES) ||
    admissionAuthorityCount !== 2
  ) {
    fail('deployment image surfaces differ from the reviewed post-renderer');
  }
  return Object.freeze({
    schemaVersion: 1,
    deploymentYamlFiles: files.length,
    imageOccurrences: Object.freeze({ ...counts }),
    admissionAuthorityCount,
    materialization: 'offline_post_render',
    networkAccess: false,
    kubernetesMutation: false,
    compatible: true,
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
  if (values.mode === 'surfaces-audit') {
    if (Object.keys(values).length !== 1) fail('arguments are invalid');
    return Object.freeze({ mode: values.mode });
  }
  const identity = [
    'mode',
    'release-scope',
    'repository-owner',
    'source-ref',
    'source-revision',
    'version',
    'release-set',
  ];
  const expected =
    values.mode === 'local-create'
      ? [...identity, 'allow-root-service', 'output']
      : values.mode === 'local-audit'
      ? [...identity, 'allow-root-service', 'selection']
      : values.mode === 'kubernetes-create'
      ? [
          ...identity,
          'manifest',
          'output-manifest',
          'output-report',
          'required-images',
        ]
      : values.mode === 'kubernetes-audit'
      ? [
          ...identity,
          'locked-manifest',
          'manifest',
          'report',
          'required-images',
        ]
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
    releaseSet: values['release-set'],
    ...(values['allow-root-service']
      ? {
          allowRootService:
            values['allow-root-service'] === 'true'
              ? true
              : values['allow-root-service'] === 'false'
              ? false
              : fail('allow-root-service must be true or false'),
        }
      : {}),
    ...(values.output ? { output: values.output } : {}),
    ...(values.selection ? { selection: values.selection } : {}),
    ...(values.manifest ? { manifest: values.manifest } : {}),
    ...(values['locked-manifest']
      ? { lockedManifest: values['locked-manifest'] }
      : {}),
    ...(values['output-manifest']
      ? { outputManifest: values['output-manifest'] }
      : {}),
    ...(values['output-report']
      ? { outputReport: values['output-report'] }
      : {}),
    ...(values.report ? { report: values.report } : {}),
    ...(values['required-images']
      ? { requiredImages: values['required-images'] }
      : {}),
  });
}

function runCli(argv, root = DEFAULT_ROOT, output = process.stdout) {
  const options = parseArguments(argv);
  if (options.mode === 'surfaces-audit') {
    const audit = auditDeploymentImageSurfaces(root);
    output.write(canonicalJson(audit));
    return audit;
  }
  const releaseSet = readCanonicalJson(
    options.releaseSet,
    'release set',
    MAX_RELEASE_SET_BYTES,
  ).value;
  if (options.mode === 'local-create') {
    const selection = createLocalSelection(releaseSet, options);
    const target = preflightOutput(options.output, 'output');
    writeNoReplace(target, canonicalJson(selection));
    output.write(canonicalJson(selection));
    return selection;
  }
  if (options.mode === 'local-audit') {
    const selection = readCanonicalJson(
      options.selection,
      'local selection',
      MAX_RELEASE_SET_BYTES,
    ).value;
    const audit = auditLocalSelection(selection, releaseSet, options);
    output.write(canonicalJson(audit));
    return audit;
  }
  const sourceManifest = readBoundedFile(
    options.manifest,
    'input manifest',
    MAX_MANIFEST_BYTES,
  ).contents;
  if (options.mode === 'kubernetes-create') {
    const manifestTarget = preflightOutput(
      options.outputManifest,
      'output manifest',
    );
    const reportTarget = preflightOutput(options.outputReport, 'output report');
    if (manifestTarget === reportTarget) {
      fail('output manifest and report paths must differ');
    }
    const created = createKubernetesLock(releaseSet, sourceManifest, options);
    writeNoReplace(manifestTarget, created.outputManifest);
    writeNoReplace(reportTarget, canonicalJson(created.report));
    output.write(canonicalJson(created.report));
    return created;
  }
  const lockedManifest = readBoundedFile(
    options.lockedManifest,
    'locked manifest',
    MAX_MANIFEST_BYTES,
  ).contents;
  const report = readCanonicalJson(
    options.report,
    'deployment lock report',
    MAX_RELEASE_SET_BYTES,
  ).value;
  const audit = auditKubernetesLock(
    lockedManifest,
    report,
    releaseSet,
    sourceManifest,
    options,
  );
  output.write(canonicalJson(audit));
  return audit;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'deployment lock failed'}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  KUBERNETES_LOCK_SCHEMA,
  LOCAL_SELECTION_SCHEMA,
  QingLong3DeploymentLockError,
  auditDeploymentImageSurfaces,
  auditKubernetesLock,
  auditLocalSelection,
  createKubernetesLock,
  createLocalSelection,
  parseArguments,
  runCli,
});
