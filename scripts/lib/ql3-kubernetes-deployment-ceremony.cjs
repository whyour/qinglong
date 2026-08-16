'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const COMMAND_SCHEMA = 'qinglong/kubernetes-deployment-command@v1';
const LOCK_SCHEMA = 'qinglong/kubernetes-deployment-lock@v2';
const CATALOG_SCHEMA = 'qinglong/release-catalog-consumption-ceremony@v1';
const PREFLIGHT_SCHEMA = 'qinglong/kubernetes-deployment-preflight@v1';
const RECEIPT_SCHEMA = 'qinglong/kubernetes-deployment-receipt@v1';
const FIELD_MANAGER = 'qinglong3-catalog-lock';
const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_KUBECONFIG_BYTES = 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_RESOURCE_COUNT = 2048;
const MAX_STRUCTURE_DEPTH = 64;
const PROCESS_TIMEOUT_MS = 60_000;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const VERSION_PATTERN =
  /^3\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const CONTEXT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$/u;
const REPOSITORY_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/u;
const ROLE_ORDER = Object.freeze(['control', 'control-ai', 'admin', 'worker']);
const IMAGE_NAMES = Object.freeze({
  control: 'qinglong3-cluster-control',
  'control-ai': 'qinglong3-cluster-control-ai',
  admin: 'qinglong3-cluster-admin',
  worker: 'qinglong3-worker',
});
const ANNOTATION_KEYS = Object.freeze({
  releaseSet: 'qinglong.io/release-set-digest',
  catalogManifest: 'qinglong.io/release-catalog-manifest-digest',
  catalogReport: 'qinglong.io/release-catalog-report-digest',
  sourceRevision: 'qinglong.io/release-source-revision',
  version: 'qinglong.io/release-version',
});

class QingLong3KubernetesDeploymentCeremonyError extends Error {
  constructor(message) {
    super(`QingLong 3 Kubernetes deployment ceremony failed: ${message}`);
    this.name = 'QingLong3KubernetesDeploymentCeremonyError';
    this.code = 'QL3_KUBERNETES_DEPLOYMENT_CEREMONY_FAILED';
  }
}

function fail(message) {
  throw new QingLong3KubernetesDeploymentCeremonyError(message);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  return (
    isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

function resolveCanonicalAbsolute(input, label) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    fail(`${label} path must be absolute`);
  }
  const resolved = path.resolve(input);
  if (resolved !== input) fail(`${label} path must be normalized`);
  return resolved;
}

function validatePrivateParent(filePath, label, uid = process.getuid()) {
  const parent = path.dirname(filePath);
  let status;
  try {
    status = fs.lstatSync(parent);
  } catch {
    fail(`${label} parent is unavailable`);
  }
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== uid ||
    (status.mode & 0o777) !== 0o700 ||
    fs.realpathSync(parent) !== parent
  ) {
    fail(`${label} parent must be one current-owner canonical 0700 directory`);
  }
  return parent;
}

function descriptorIdentity(status) {
  return Object.freeze({
    dev: status.dev,
    ino: status.ino,
    size: status.size,
    mtimeMs: status.mtimeMs,
    ctimeMs: status.ctimeMs,
  });
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readStableFile(
  input,
  label,
  maximumBytes,
  { privateFile = true, executable = false } = {},
) {
  const target = resolveCanonicalAbsolute(input, label);
  if (privateFile) validatePrivateParent(target, label);
  let lexical;
  try {
    lexical = fs.lstatSync(target);
  } catch {
    fail(`${label} is unavailable`);
  }
  const uid = process.getuid();
  const allowedOwner = privateFile
    ? lexical.uid === uid
    : lexical.uid === uid || lexical.uid === 0;
  const validMode = privateFile
    ? (lexical.mode & 0o777) === 0o600
    : (lexical.mode & 0o022) === 0 && (lexical.mode & 0o111) !== 0;
  if (
    !lexical.isFile() ||
    lexical.isSymbolicLink() ||
    lexical.nlink !== 1 ||
    !allowedOwner ||
    !validMode ||
    lexical.size < 1 ||
    lexical.size > maximumBytes ||
    fs.realpathSync(target) !== target ||
    (executable && (lexical.mode & 0o111) === 0)
  ) {
    fail(`${label} file authority is invalid`);
  }
  const flags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_CLOEXEC ?? 0);
  let descriptor;
  try {
    descriptor = fs.openSync(target, flags);
  } catch {
    fail(`${label} cannot be opened safely`);
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.dev !== lexical.dev ||
      before.ino !== lexical.ino ||
      before.size !== lexical.size
    ) {
      fail(`${label} descriptor identity is invalid`);
    }
    const chunks = [];
    const hash = crypto.createHash('sha256');
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > maximumBytes) fail(`${label} exceeds its byte limit`);
      const actual = chunk.subarray(0, read);
      hash.update(actual);
      if (!executable) chunks.push(actual);
    }
    const after = fs.fstatSync(descriptor);
    if (!sameIdentity(descriptorIdentity(before), descriptorIdentity(after))) {
      fail(`${label} changed while it was read`);
    }
    const contents = executable ? undefined : Buffer.concat(chunks);
    return Object.freeze({
      path: target,
      identity: descriptorIdentity(after),
      bytes: total,
      digest: `sha256:${hash.digest('hex')}`,
      ...(contents === undefined ? {} : { contents }),
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function utf8(file, label) {
  const contents = file.contents.toString('utf8');
  if (!Buffer.from(contents, 'utf8').equals(file.contents)) {
    fail(`${label} must contain valid UTF-8`);
  }
  return contents;
}

function parseCanonicalJson(contents, label) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail(`${label} must contain valid JSON`);
  }
  if (canonicalJson(parsed) !== contents) {
    fail(`${label} must use canonical JSON encoding`);
  }
  return parsed;
}

function readCanonicalJson(input, label, maximumBytes) {
  const file = readStableFile(input, label, maximumBytes);
  return Object.freeze({
    ...file,
    value: parseCanonicalJson(utf8(file, label), label),
  });
}

function artifact(value, label) {
  if (
    !exactKeys(value, ['path', 'expectedDigest']) ||
    typeof value.path !== 'string' ||
    !DIGEST_PATTERN.test(value.expectedDigest || '')
  ) {
    fail(`${label} authority is invalid`);
  }
  return Object.freeze({
    path: resolveCanonicalAbsolute(value.path, label),
    expectedDigest: value.expectedDigest,
  });
}

function verifyExpected(file, expectedDigest, label) {
  if (file.digest !== expectedDigest) fail(`${label} digest changed`);
  return file;
}

function outputTarget(input, label) {
  const target = resolveCanonicalAbsolute(input, label);
  validatePrivateParent(target, label);
  if (fs.existsSync(target)) fail(`${label} must be unused`);
  return target;
}

function writeNoReplace(target, value) {
  fs.writeFileSync(target, canonicalJson(value), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

function parseCommand(value) {
  if (
    !exactKeys(value, ['schemaVersion', 'schema', 'operation', 'request']) ||
    value.schemaVersion !== 1 ||
    value.schema !== COMMAND_SCHEMA
  ) {
    fail('command shape is invalid');
  }
  const request = value.request;
  if (value.operation === 'cluster.deployment.preflight') {
    if (
      !exactKeys(request, [
        'preflightId',
        'lockedManifest',
        'lockReport',
        'kubectl',
        'kubeconfig',
        'context',
        'expectedClusterUid',
        'output',
      ]) ||
      !UUID_PATTERN.test(request.preflightId || '') ||
      !CONTEXT_PATTERN.test(request.context || '') ||
      !UUID_PATTERN.test(request.expectedClusterUid || '') ||
      typeof request.output !== 'string'
    ) {
      fail('preflight command is invalid');
    }
    return Object.freeze({
      schemaVersion: 1,
      schema: COMMAND_SCHEMA,
      operation: value.operation,
      request: Object.freeze({
        preflightId: request.preflightId,
        lockedManifest: artifact(request.lockedManifest, 'locked manifest'),
        lockReport: artifact(request.lockReport, 'lock report'),
        kubectl: artifact(request.kubectl, 'kubectl'),
        kubeconfig: artifact(request.kubeconfig, 'kubeconfig'),
        context: request.context,
        expectedClusterUid: request.expectedClusterUid,
        output: resolveCanonicalAbsolute(request.output, 'preflight output'),
      }),
    });
  }
  if (value.operation === 'cluster.deployment.apply') {
    if (
      !exactKeys(request, [
        'mutationId',
        'preflight',
        'lockedManifest',
        'lockReport',
        'kubectl',
        'kubeconfig',
        'context',
        'expectedClusterUid',
        'output',
      ]) ||
      !UUID_PATTERN.test(request.mutationId || '') ||
      !CONTEXT_PATTERN.test(request.context || '') ||
      !UUID_PATTERN.test(request.expectedClusterUid || '') ||
      typeof request.output !== 'string'
    ) {
      fail('apply command is invalid');
    }
    return Object.freeze({
      schemaVersion: 1,
      schema: COMMAND_SCHEMA,
      operation: value.operation,
      request: Object.freeze({
        mutationId: request.mutationId,
        preflight: artifact(request.preflight, 'preflight report'),
        lockedManifest: artifact(request.lockedManifest, 'locked manifest'),
        lockReport: artifact(request.lockReport, 'lock report'),
        kubectl: artifact(request.kubectl, 'kubectl'),
        kubeconfig: artifact(request.kubeconfig, 'kubeconfig'),
        context: request.context,
        expectedClusterUid: request.expectedClusterUid,
        output: resolveCanonicalAbsolute(
          request.output,
          'apply receipt output',
        ),
      }),
    });
  }
  if (value.operation === 'cluster.deployment.receipt.audit') {
    if (!exactKeys(request, ['applyCommand', 'receipt'])) {
      fail('receipt audit command is invalid');
    }
    return Object.freeze({
      schemaVersion: 1,
      schema: COMMAND_SCHEMA,
      operation: value.operation,
      request: Object.freeze({
        applyCommand: artifact(request.applyCommand, 'apply command'),
        receipt: artifact(request.receipt, 'deployment receipt'),
      }),
    });
  }
  fail('command operation is invalid');
}

function readCommand(input) {
  const commandFile = readCanonicalJson(
    input,
    'deployment command',
    MAX_COMMAND_BYTES,
  );
  return Object.freeze({
    file: commandFile,
    command: parseCommand(commandFile.value),
    commandDigest: commandFile.digest,
  });
}

function validateRelease(release) {
  if (
    !exactKeys(release, ['version', 'sourceRevision', 'sourceRef', 'scope']) ||
    !VERSION_PATTERN.test(release.version || '') ||
    !/^[a-f0-9]{40}$/u.test(release.sourceRevision || '') ||
    release.sourceRef !== `refs/tags/v${release.version}` ||
    !['cluster', 'all'].includes(release.scope)
  ) {
    fail('deployment lock release identity is invalid');
  }
}

function validateCatalog(catalog, release, releaseSetDigest) {
  if (
    !exactKeys(catalog, [
      'schema',
      'sourceRepository',
      'workflowIdentity',
      'immutableReference',
      'manifestDigest',
      'consumptionReportDigest',
      'releaseSetDigest',
      'discoveryTagAuthority',
    ]) ||
    catalog.schema !== CATALOG_SCHEMA ||
    !REPOSITORY_PATTERN.test(catalog.sourceRepository || '') ||
    catalog.workflowIdentity !==
      `https://github.com/${catalog.sourceRepository}/.github/workflows/ql3-image-release.yml@${release.sourceRef}` ||
    !DIGEST_PATTERN.test(catalog.manifestDigest || '') ||
    !DIGEST_PATTERN.test(catalog.consumptionReportDigest || '') ||
    catalog.releaseSetDigest !== releaseSetDigest ||
    catalog.discoveryTagAuthority !== 'none'
  ) {
    fail('deployment lock catalog authority is invalid');
  }
  const match = new RegExp(
    `^ghcr\\.io/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)/qinglong3-release-catalog@${catalog.manifestDigest}$`,
    'u',
  ).exec(catalog.immutableReference || '');
  if (!match) fail('deployment lock catalog reference is invalid');
  return match[1];
}

function validateLockReport(report) {
  if (
    !exactKeys(report, [
      'schemaVersion',
      'schema',
      'release',
      'releaseSetDigest',
      'catalog',
      'deploymentFamily',
      'requiredImages',
      'imageOccurrences',
      'manifest',
      'verification',
      'lockDigest',
    ]) ||
    report.schemaVersion !== 1 ||
    report.schema !== LOCK_SCHEMA ||
    report.deploymentFamily !== 'cluster' ||
    !DIGEST_PATTERN.test(report.releaseSetDigest || '') ||
    !DIGEST_PATTERN.test(report.lockDigest || '')
  ) {
    fail('deployment lock report shape is invalid');
  }
  validateRelease(report.release);
  const repositoryOwner = validateCatalog(
    report.catalog,
    report.release,
    report.releaseSetDigest,
  );
  if (
    !Array.isArray(report.requiredImages) ||
    report.requiredImages.length < 1 ||
    JSON.stringify(report.requiredImages) !==
      JSON.stringify(
        ROLE_ORDER.filter((role) => report.requiredImages.includes(role)),
      ) ||
    !Array.isArray(report.imageOccurrences) ||
    report.imageOccurrences.length !== ROLE_ORDER.length
  ) {
    fail('deployment lock role closure is invalid');
  }
  const references = {};
  const counts = {};
  for (let index = 0; index < ROLE_ORDER.length; index += 1) {
    const role = ROLE_ORDER[index];
    const occurrence = report.imageOccurrences[index];
    const repository = IMAGE_NAMES[role];
    if (
      !exactKeys(occurrence, ['name', 'reference', 'count']) ||
      occurrence.name !== role ||
      !new RegExp(
        `^ghcr\\.io/${repositoryOwner}/${repository}@sha256:[a-f0-9]{64}$`,
        'u',
      ).test(occurrence.reference || '') ||
      !Number.isSafeInteger(occurrence.count) ||
      occurrence.count < 0 ||
      occurrence.count > MAX_RESOURCE_COUNT * 16 ||
      (report.requiredImages.includes(role) && occurrence.count < 1)
    ) {
      fail(`deployment lock image occurrence is invalid: ${role}`);
    }
    references[role] = occurrence.reference;
    counts[role] = occurrence.count;
  }
  if (
    !exactKeys(report.manifest, [
      'inputDigest',
      'outputDigest',
      'resources',
      'changedResources',
      'admissionAuthorityCount',
    ]) ||
    !DIGEST_PATTERN.test(report.manifest.inputDigest || '') ||
    !DIGEST_PATTERN.test(report.manifest.outputDigest || '') ||
    !Number.isSafeInteger(report.manifest.resources) ||
    report.manifest.resources < 1 ||
    report.manifest.resources > MAX_RESOURCE_COUNT ||
    !Number.isSafeInteger(report.manifest.changedResources) ||
    report.manifest.changedResources < 1 ||
    report.manifest.changedResources > report.manifest.resources ||
    !Number.isSafeInteger(report.manifest.admissionAuthorityCount) ||
    report.manifest.admissionAuthorityCount < 0 ||
    report.manifest.admissionAuthorityCount > report.manifest.resources ||
    !exactKeys(report.verification, [
      'releaseSet',
      'sourceRecordsReplayed',
      'catalogConsumption',
      'externalToolResultsReplayed',
      'unknownImageAuthorities',
      'mutableQingLongImages',
      'networkAccess',
      'kubernetesMutation',
    ]) ||
    JSON.stringify(report.verification) !==
      JSON.stringify({
        releaseSet: 'standalone_structure_identity_and_self_digest',
        sourceRecordsReplayed: false,
        catalogConsumption: 'offline_reconstructed',
        externalToolResultsReplayed: false,
        unknownImageAuthorities: 0,
        mutableQingLongImages: 0,
        networkAccess: false,
        kubernetesMutation: false,
      })
  ) {
    fail('deployment lock verification is invalid');
  }
  const { lockDigest, ...unsigned } = report;
  if (lockDigest !== sha256(JSON.stringify(unsigned))) {
    fail('deployment lock self digest is invalid');
  }
  return Object.freeze({
    report,
    repositoryOwner,
    references: Object.freeze(references),
    counts: Object.freeze(counts),
  });
}

function validateStructure(value, state, depth = 0) {
  if (depth > MAX_STRUCTURE_DEPTH) fail('locked manifest is too deep');
  if (value === null || typeof value !== 'object') return;
  if (state.seen.has(value)) fail('locked manifest aliases are not allowed');
  state.seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) validateStructure(entry, state, depth + 1);
    return;
  }
  if (!isPlainObject(value)) fail('locked manifest value is invalid');
  for (const [key, entry] of Object.entries(value)) {
    if (!key || /[\u0000-\u001f\u007f]/u.test(key)) {
      fail('locked manifest key is invalid');
    }
    validateStructure(entry, state, depth + 1);
  }
}

function parseManifest(contents) {
  const resources = [];
  try {
    yaml.loadAll(
      contents,
      (resource) => {
        if (resource !== undefined && resource !== null)
          resources.push(resource);
      },
      { json: false },
    );
  } catch {
    fail('locked manifest must be duplicate-free YAML');
  }
  if (resources.length < 1 || resources.length > MAX_RESOURCE_COUNT) {
    fail('locked manifest resource count is invalid');
  }
  const state = { seen: new WeakSet() };
  for (const resource of resources) {
    if (!isPlainObject(resource)) fail('locked manifest resource is invalid');
    validateStructure(resource, state);
    if (
      typeof resource.apiVersion !== 'string' ||
      typeof resource.kind !== 'string' ||
      !isPlainObject(resource.metadata) ||
      typeof resource.metadata.name !== 'string'
    ) {
      fail('locked manifest resource identity is invalid');
    }
  }
  return resources;
}

function roleFromImage(value) {
  if (typeof value !== 'string') return null;
  for (const role of ROLE_ORDER) {
    if (
      new RegExp(
        `^(?:[A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]+)?/)*${IMAGE_NAMES[role]}(?::[^@\\s]+|@sha256:[a-f0-9]{64})$`,
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

function podTemplateFor(resource) {
  if (
    ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(
      resource.kind,
    )
  ) {
    return resource.spec?.template;
  }
  if (resource.kind === 'Job') return resource.spec?.template;
  if (resource.kind === 'CronJob') {
    return resource.spec?.jobTemplate?.spec?.template;
  }
  return undefined;
}

function podSpecFor(resource) {
  if (resource.kind === 'Pod') return resource.spec;
  return podTemplateFor(resource)?.spec;
}

function expectedAnnotations(report) {
  return Object.freeze({
    [ANNOTATION_KEYS.releaseSet]: report.releaseSetDigest,
    [ANNOTATION_KEYS.catalogManifest]: report.catalog.manifestDigest,
    [ANNOTATION_KEYS.catalogReport]: report.catalog.consumptionReportDigest,
    [ANNOTATION_KEYS.sourceRevision]: report.release.sourceRevision,
    [ANNOTATION_KEYS.version]: report.release.version,
  });
}

function assertAnnotations(target, expected, label) {
  const annotations = target?.metadata?.annotations;
  if (!isPlainObject(annotations)) fail(`${label} annotations are invalid`);
  for (const [key, value] of Object.entries(expected)) {
    if (annotations[key] !== value) fail(`${label} annotations drifted`);
  }
}

function inspectContainerList(list, authority, handled, counters) {
  if (list === undefined) return 0;
  if (!Array.isArray(list)) fail('locked manifest container list is invalid');
  let matched = 0;
  for (const container of list) {
    if (!isPlainObject(container)) fail('locked manifest container is invalid');
    const role = roleFromImage(container.image);
    if (role === null) {
      if (mentionsRoleImageName(container.image)) {
        fail('locked manifest container image is malformed');
      }
      continue;
    }
    if (container.image !== authority.references[role]) {
      fail(`locked manifest image authority drifted: ${role}`);
    }
    handled.add(container);
    counters[role] += 1;
    matched += 1;
  }
  return matched;
}

function scanUnhandled(value, authority, handled, parent, parentKey) {
  if (typeof value === 'string') {
    const role = roleFromImage(value);
    if (
      role !== null &&
      (value !== authority.references[role] ||
        parentKey !== 'image' ||
        !handled.has(parent))
    ) {
      fail('locked manifest contains an unhandled QingLong image authority');
    }
    if (role === null && mentionsRoleImageName(value)) {
      fail('locked manifest contains a malformed QingLong image authority');
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      scanUnhandled(value[index], authority, handled, value, String(index));
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    scanUnhandled(entry, authority, handled, value, key);
  }
}

function inspectResourceAuthorities(resources, authority, label) {
  const report = authority.report;
  const counters = Object.fromEntries(ROLE_ORDER.map((role) => [role, 0]));
  const handled = new WeakSet();
  const annotations = expectedAnnotations(report);
  let changedResources = 0;
  let admissionAuthorityCount = 0;
  for (const resource of resources) {
    const podSpec = podSpecFor(resource);
    let matched = 0;
    if (podSpec !== undefined) {
      if (!isPlainObject(podSpec)) fail(`${label} Pod spec is invalid`);
      for (const key of [
        'initContainers',
        'containers',
        'ephemeralContainers',
      ]) {
        matched += inspectContainerList(
          podSpec[key],
          authority,
          handled,
          counters,
        );
      }
    }
    if (
      resource.kind === 'ConfigMap' &&
      resource.metadata.name === 'ql3-plugin-package-secret-action-admission'
    ) {
      const role = roleFromImage(resource.data?.image);
      if (
        role !== 'admin' ||
        resource.data.image !== authority.references.admin
      ) {
        fail('locked manifest admission authority is invalid');
      }
      handled.add(resource.data);
      counters.admin += 1;
      matched += 1;
      admissionAuthorityCount += 1;
    }
    if (matched > 0) {
      if (
        typeof resource.metadata.namespace !== 'string' ||
        !CONTEXT_PATTERN.test(resource.metadata.namespace)
      ) {
        fail(`${label} resource namespace must be explicit`);
      }
      assertAnnotations(resource, annotations, `${label} resource`);
      const template = podTemplateFor(resource);
      if (template !== undefined) {
        assertAnnotations(template, annotations, `${label} Pod template`);
      }
      changedResources += 1;
    }
  }
  for (const resource of resources) {
    scanUnhandled(resource, authority, handled, undefined, undefined);
  }
  if (
    JSON.stringify(counters) !== JSON.stringify(authority.counts) ||
    changedResources !== report.manifest.changedResources ||
    admissionAuthorityCount !== report.manifest.admissionAuthorityCount
  ) {
    fail('locked manifest authority counts changed');
  }
  return Object.freeze({
    resourceCount: resources.length,
    changedResources,
    admissionAuthorityCount,
    counts: Object.freeze({ ...counters }),
  });
}

function inspectLockedManifest(contents, authority) {
  const report = authority.report;
  if (sha256(Buffer.from(contents, 'utf8')) !== report.manifest.outputDigest) {
    fail('locked manifest digest changed');
  }
  const resources = parseManifest(contents);
  if (resources.length !== report.manifest.resources) {
    fail('locked manifest resource count changed');
  }
  inspectResourceAuthorities(resources, authority, 'locked manifest');
  return Object.freeze({ resources: Object.freeze(resources) });
}

function resourceIdentity(resource) {
  const namespace = resource.metadata?.namespace ?? '';
  return `${resource.apiVersion}\u0000${resource.kind}\u0000${namespace}\u0000${
    resource.metadata?.name ?? ''
  }`;
}

function containsQingLongAuthority(value, references) {
  if (typeof value === 'string') {
    const role = roleFromImage(value);
    return role !== null && value === references[role];
  }
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsQingLongAuthority(entry, references));
  }
  return Object.values(value).some((entry) =>
    containsQingLongAuthority(entry, references),
  );
}

function assertDesiredSubset(desired, actual, depth = 0) {
  if (depth > MAX_STRUCTURE_DEPTH) fail('live Kubernetes object is too deep');
  if (desired === null || typeof desired !== 'object') {
    if (desired !== actual) fail('live Kubernetes object drifted');
    return;
  }
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual) || actual.length !== desired.length) {
      fail('live Kubernetes array drifted');
    }
    for (let index = 0; index < desired.length; index += 1) {
      assertDesiredSubset(desired[index], actual[index], depth + 1);
    }
    return;
  }
  if (!isPlainObject(actual)) fail('live Kubernetes object is invalid');
  for (const [key, value] of Object.entries(desired)) {
    if (!Object.hasOwn(actual, key)) fail('live Kubernetes field is missing');
    assertDesiredSubset(value, actual[key], depth + 1);
  }
}

function inspectConvergenceOutput(contents, inputs) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    fail('Kubernetes convergence response is invalid');
  }
  const items = value?.kind === 'List' ? value.items : undefined;
  if (
    !Array.isArray(items) ||
    items.length !== inputs.authority.report.manifest.resources ||
    items.some((item) => !isPlainObject(item))
  ) {
    fail('Kubernetes convergence resource count changed');
  }
  const liveByIdentity = new Map();
  for (const item of items) {
    const identity = resourceIdentity(item);
    if (liveByIdentity.has(identity)) {
      fail('Kubernetes convergence identity is duplicated');
    }
    liveByIdentity.set(identity, item);
  }
  const desiredResources = inspectLockedManifest(
    inputs.manifestContents,
    inputs.authority,
  ).resources;
  for (const desired of desiredResources) {
    const live = liveByIdentity.get(resourceIdentity(desired));
    if (
      live === undefined ||
      typeof live.metadata?.uid !== 'string' ||
      typeof live.metadata?.resourceVersion !== 'string'
    ) {
      fail('Kubernetes convergence identity is unavailable');
    }
    if (
      containsQingLongAuthority(desired, inputs.authority.references) &&
      (!Array.isArray(live.metadata.managedFields) ||
        !live.metadata.managedFields.some(
          (entry) =>
            entry?.manager === FIELD_MANAGER && entry?.operation === 'Apply',
        ))
    ) {
      fail('Kubernetes convergence field authority is unavailable');
    }
    assertDesiredSubset(desired, live);
  }
  inspectResourceAuthorities(items, inputs.authority, 'live Kubernetes');
}

function validateKubeconfig(contents, context) {
  let config;
  try {
    config = yaml.load(contents, { json: false });
  } catch {
    fail('kubeconfig is invalid');
  }
  if (
    !isPlainObject(config) ||
    !Array.isArray(config.contexts) ||
    !config.contexts.some(
      (entry) =>
        isPlainObject(entry) &&
        entry.name === context &&
        isPlainObject(entry.context) &&
        typeof entry.context.cluster === 'string',
    ) ||
    !Array.isArray(config.users)
  ) {
    fail('kubeconfig context is unavailable');
  }
  for (const entry of config.users) {
    const user = entry?.user;
    if (
      !isPlainObject(entry) ||
      !isPlainObject(user) ||
      Object.hasOwn(user, 'exec') ||
      Object.hasOwn(user, 'auth-provider')
    ) {
      fail('kubeconfig executable authentication is forbidden');
    }
  }
}

function inspectInputs(request) {
  const manifest = verifyExpected(
    readStableFile(
      request.lockedManifest.path,
      'locked manifest',
      MAX_MANIFEST_BYTES,
    ),
    request.lockedManifest.expectedDigest,
    'locked manifest',
  );
  const reportFile = readCanonicalJson(
    request.lockReport.path,
    'lock report',
    MAX_REPORT_BYTES,
  );
  const authority = validateLockReport(reportFile.value);
  if (authority.report.lockDigest !== request.lockReport.expectedDigest) {
    fail('lock report digest changed');
  }
  const manifestContents = utf8(manifest, 'locked manifest');
  inspectLockedManifest(manifestContents, authority);
  if (manifest.digest !== authority.report.manifest.outputDigest) {
    fail('locked manifest and report digest differ');
  }
  const executable = verifyExpected(
    readStableFile(request.kubectl.path, 'kubectl', MAX_EXECUTABLE_BYTES, {
      privateFile: false,
      executable: true,
    }),
    request.kubectl.expectedDigest,
    'kubectl',
  );
  const kubeconfig = verifyExpected(
    readStableFile(request.kubeconfig.path, 'kubeconfig', MAX_KUBECONFIG_BYTES),
    request.kubeconfig.expectedDigest,
    'kubeconfig',
  );
  validateKubeconfig(utf8(kubeconfig, 'kubeconfig'), request.context);
  return Object.freeze({
    manifest,
    manifestContents,
    reportFile,
    authority,
    executable,
    kubeconfig,
  });
}

function defaultRunProcess(executable, args, input) {
  const privateHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ql3-kubectl-home-'),
  );
  fs.chmodSync(privateHome, 0o700);
  try {
    return spawnSync(executable, args, {
      input,
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
      env: Object.freeze({
        HOME: privateHome,
        XDG_CACHE_HOME: privateHome,
        TMPDIR: privateHome,
        LANG: 'C',
        LC_ALL: 'C',
        NO_COLOR: '1',
      }),
    });
  } finally {
    fs.rmSync(privateHome, { recursive: true, force: true });
  }
}

function runStep(inputs, request, name, argumentsAfterTarget, runner) {
  const args = [
    `--kubeconfig=${inputs.kubeconfig.path}`,
    `--context=${request.context}`,
    '--request-timeout=60s',
    ...argumentsAfterTarget,
  ];
  const result = runner(inputs.executable.path, args, inputs.manifestContents);
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (
    result.error ||
    !Number.isInteger(result.status) ||
    Buffer.byteLength(stdout, 'utf8') > MAX_PROCESS_OUTPUT_BYTES ||
    Buffer.byteLength(stderr, 'utf8') > MAX_PROCESS_OUTPUT_BYTES
  ) {
    fail(`kubectl ${name} could not complete safely`);
  }
  return Object.freeze({
    name,
    status: result.status,
    argvDigest: sha256(Buffer.from(JSON.stringify(args), 'utf8')),
    stdoutDigest: sha256(Buffer.from(stdout, 'utf8')),
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrDigest: sha256(Buffer.from(stderr, 'utf8')),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    stdout,
  });
}

function identityStep(inputs, request, runner, name) {
  const step = runStep(
    inputs,
    request,
    name,
    ['get', 'namespace', 'kube-system', '-o=jsonpath={.metadata.uid}'],
    runner,
  );
  if (step.status !== 0 || step.stdout.trim() !== request.expectedClusterUid) {
    fail('Kubernetes cluster identity changed');
  }
  const { stdout, ...record } = step;
  return Object.freeze(record);
}

function dryRunStep(inputs, request, runner, name = 'server_side_dry_run') {
  const step = runStep(
    inputs,
    request,
    name,
    [
      'apply',
      '--server-side',
      '--dry-run=server',
      `--field-manager=${FIELD_MANAGER}`,
      '--validate=strict',
      '-f=-',
      '-o=name',
    ],
    runner,
  );
  if (step.status !== 0) fail('Kubernetes server-side dry-run was rejected');
  const { stdout, ...record } = step;
  return Object.freeze(record);
}

function convergenceReadStep(inputs, request, runner) {
  const step = runStep(
    inputs,
    request,
    'server_side_convergence_read',
    ['get', '-f=-', '-o=json', '--show-managed-fields=true'],
    runner,
  );
  if (step.status !== 0) fail('Kubernetes convergence read failed');
  inspectConvergenceOutput(step.stdout, inputs);
  const { stdout, ...record } = step;
  return Object.freeze(record);
}

function revalidateStableInputs(inputs, request) {
  for (const [label, previous, maximumBytes, options] of [
    ['locked manifest', inputs.manifest, MAX_MANIFEST_BYTES, {}],
    ['lock report', inputs.reportFile, MAX_REPORT_BYTES, {}],
    [
      'kubectl',
      inputs.executable,
      MAX_EXECUTABLE_BYTES,
      { privateFile: false, executable: true },
    ],
    ['kubeconfig', inputs.kubeconfig, MAX_KUBECONFIG_BYTES, {}],
  ]) {
    const current = readStableFile(previous.path, label, maximumBytes, options);
    if (
      current.digest !== previous.digest ||
      !sameIdentity(current.identity, previous.identity)
    ) {
      fail(`${label} changed during the ceremony`);
    }
  }
  if (
    inputs.manifest.digest !== request.lockedManifest.expectedDigest ||
    inputs.authority.report.lockDigest !== request.lockReport.expectedDigest ||
    inputs.executable.digest !== request.kubectl.expectedDigest ||
    inputs.kubeconfig.digest !== request.kubeconfig.expectedDigest
  ) {
    fail('deployment input authority changed');
  }
}

function lockSummary(inputs) {
  const report = inputs.authority.report;
  return Object.freeze({
    lockDigest: report.lockDigest,
    manifestDigest: inputs.manifest.digest,
    lockReportDigest: inputs.reportFile.digest,
    releaseSetDigest: report.releaseSetDigest,
    catalogManifestDigest: report.catalog.manifestDigest,
    catalogReportDigest: report.catalog.consumptionReportDigest,
    catalogImmutableReference: report.catalog.immutableReference,
    release: Object.freeze({ ...report.release }),
    requiredImages: Object.freeze([...report.requiredImages]),
  });
}

function targetSummary(inputs, request) {
  return Object.freeze({
    context: request.context,
    clusterUid: request.expectedClusterUid,
    kubeconfigDigest: inputs.kubeconfig.digest,
    fieldManager: FIELD_MANAGER,
  });
}

function toolSummary(inputs) {
  return Object.freeze({
    name: 'kubectl',
    executableDigest: inputs.executable.digest,
  });
}

function validatePreflight(value) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'schema',
      'preflightId',
      'commandDigest',
      'lock',
      'target',
      'tool',
      'steps',
      'verification',
      'preflightDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.schema !== PREFLIGHT_SCHEMA ||
    !UUID_PATTERN.test(value.preflightId || '') ||
    !DIGEST_PATTERN.test(value.commandDigest || '') ||
    !DIGEST_PATTERN.test(value.preflightDigest || '') ||
    !Array.isArray(value.steps) ||
    value.steps.length !== 2 ||
    value.steps[0]?.name !== 'cluster_identity_before' ||
    value.steps[1]?.name !== 'server_side_dry_run' ||
    !exactKeys(value.verification, [
      'catalogBoundLock',
      'clusterIdentityBound',
      'serverSideDryRun',
      'networkAccess',
      'kubernetesMutation',
      'externalResultsReplayed',
      'ambientHome',
      'ephemeralCache',
    ]) ||
    JSON.stringify(value.verification) !==
      JSON.stringify({
        catalogBoundLock: true,
        clusterIdentityBound: true,
        serverSideDryRun: true,
        networkAccess: true,
        kubernetesMutation: false,
        externalResultsReplayed: false,
        ambientHome: false,
        ephemeralCache: true,
      })
  ) {
    fail('deployment preflight report is invalid');
  }
  validateLockSummary(value.lock);
  validateTargetSummary(value.target);
  validateToolSummary(value.tool);
  for (const step of value.steps) validateStepRecord(step);
  if (value.steps.some((step) => step.status !== 0)) {
    fail('deployment preflight contains a failed step');
  }
  const { preflightDigest, ...unsigned } = value;
  if (
    preflightDigest !== sha256(Buffer.from(JSON.stringify(unsigned), 'utf8'))
  ) {
    fail('deployment preflight self digest is invalid');
  }
  return value;
}

function validateLockSummary(value) {
  if (
    !exactKeys(value, [
      'lockDigest',
      'manifestDigest',
      'lockReportDigest',
      'releaseSetDigest',
      'catalogManifestDigest',
      'catalogReportDigest',
      'catalogImmutableReference',
      'release',
      'requiredImages',
    ]) ||
    !DIGEST_PATTERN.test(value.lockDigest || '') ||
    !DIGEST_PATTERN.test(value.manifestDigest || '') ||
    !DIGEST_PATTERN.test(value.lockReportDigest || '') ||
    !DIGEST_PATTERN.test(value.releaseSetDigest || '') ||
    !DIGEST_PATTERN.test(value.catalogManifestDigest || '') ||
    !DIGEST_PATTERN.test(value.catalogReportDigest || '') ||
    !Array.isArray(value.requiredImages) ||
    value.requiredImages.length < 1 ||
    JSON.stringify(value.requiredImages) !==
      JSON.stringify(
        ROLE_ORDER.filter((role) => value.requiredImages.includes(role)),
      )
  ) {
    fail('deployment lock summary is invalid');
  }
  validateRelease(value.release);
  if (
    !new RegExp(
      `^ghcr\\.io/[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?/qinglong3-release-catalog@${value.catalogManifestDigest}$`,
      'u',
    ).test(value.catalogImmutableReference || '')
  ) {
    fail('deployment lock summary catalog reference is invalid');
  }
}

function validateTargetSummary(value) {
  if (
    !exactKeys(value, [
      'context',
      'clusterUid',
      'kubeconfigDigest',
      'fieldManager',
    ]) ||
    value.fieldManager !== FIELD_MANAGER ||
    !CONTEXT_PATTERN.test(value.context || '') ||
    !UUID_PATTERN.test(value.clusterUid || '') ||
    !DIGEST_PATTERN.test(value.kubeconfigDigest || '')
  ) {
    fail('deployment target summary is invalid');
  }
}

function validateToolSummary(value) {
  if (
    !exactKeys(value, ['name', 'executableDigest']) ||
    value.name !== 'kubectl' ||
    !DIGEST_PATTERN.test(value.executableDigest || '')
  ) {
    fail('deployment tool summary is invalid');
  }
}

function validateStepRecord(step) {
  if (
    !exactKeys(step, [
      'name',
      'status',
      'argvDigest',
      'stdoutDigest',
      'stdoutBytes',
      'stderrDigest',
      'stderrBytes',
    ]) ||
    typeof step.name !== 'string' ||
    !Number.isInteger(step.status) ||
    !DIGEST_PATTERN.test(step.argvDigest || '') ||
    !DIGEST_PATTERN.test(step.stdoutDigest || '') ||
    !Number.isSafeInteger(step.stdoutBytes) ||
    step.stdoutBytes < 0 ||
    step.stdoutBytes > MAX_PROCESS_OUTPUT_BYTES ||
    !DIGEST_PATTERN.test(step.stderrDigest || '') ||
    !Number.isSafeInteger(step.stderrBytes) ||
    step.stderrBytes < 0 ||
    step.stderrBytes > MAX_PROCESS_OUTPUT_BYTES
  ) {
    fail('deployment command step is invalid');
  }
}

function createPreflight(commandState, dependencies = {}) {
  const request = commandState.command.request;
  const output = outputTarget(request.output, 'preflight output');
  const inputs = inspectInputs(request);
  const runner = dependencies.runProcess ?? defaultRunProcess;
  const steps = [
    identityStep(inputs, request, runner, 'cluster_identity_before'),
    dryRunStep(inputs, request, runner),
  ];
  revalidateStableInputs(inputs, request);
  const unsigned = {
    schemaVersion: 1,
    schema: PREFLIGHT_SCHEMA,
    preflightId: request.preflightId,
    commandDigest: commandState.commandDigest,
    lock: lockSummary(inputs),
    target: targetSummary(inputs, request),
    tool: toolSummary(inputs),
    steps,
    verification: {
      catalogBoundLock: true,
      clusterIdentityBound: true,
      serverSideDryRun: true,
      networkAccess: true,
      kubernetesMutation: false,
      externalResultsReplayed: false,
      ambientHome: false,
      ephemeralCache: true,
    },
  };
  const result = Object.freeze({
    ...unsigned,
    preflightDigest: sha256(Buffer.from(JSON.stringify(unsigned), 'utf8')),
  });
  writeNoReplace(output, result);
  return result;
}

function readAndValidatePreflight(request, inputs) {
  const file = readCanonicalJson(
    request.preflight.path,
    'preflight report',
    MAX_REPORT_BYTES,
  );
  const report = validatePreflight(file.value);
  if (
    report.preflightDigest !== request.preflight.expectedDigest ||
    JSON.stringify(report.lock) !== JSON.stringify(lockSummary(inputs)) ||
    JSON.stringify(report.target) !==
      JSON.stringify(targetSummary(inputs, request)) ||
    JSON.stringify(report.tool) !== JSON.stringify(toolSummary(inputs))
  ) {
    fail('deployment preflight binding changed');
  }
  return Object.freeze({ file, report });
}

function validateReceipt(value, expectedCommandDigest) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'schema',
      'mutationId',
      'commandDigest',
      'preflightDigest',
      'lock',
      'target',
      'tool',
      'steps',
      'verification',
      'receiptDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.schema !== RECEIPT_SCHEMA ||
    !UUID_PATTERN.test(value.mutationId || '') ||
    value.commandDigest !== expectedCommandDigest ||
    !DIGEST_PATTERN.test(value.preflightDigest || '') ||
    !DIGEST_PATTERN.test(value.receiptDigest || '') ||
    !Array.isArray(value.steps) ||
    JSON.stringify(value.steps.map((step) => step.name)) !==
      JSON.stringify([
        'cluster_identity_before',
        'server_side_dry_run',
        'server_side_apply',
        'server_side_convergence_read',
        'cluster_identity_after',
      ]) ||
    !exactKeys(value.verification, [
      'catalogBoundLock',
      'clusterIdentityBound',
      'serverSideDryRun',
      'serverSideApply',
      'convergenceRead',
      'networkAccess',
      'kubernetesMutation',
      'crossResourceAtomicity',
      'externalResultsReplayed',
      'recovery',
      'ambientHome',
      'ephemeralCache',
    ]) ||
    JSON.stringify(value.verification) !==
      JSON.stringify({
        catalogBoundLock: true,
        clusterIdentityBound: true,
        serverSideDryRun: true,
        serverSideApply: true,
        convergenceRead: true,
        networkAccess: true,
        kubernetesMutation: true,
        crossResourceAtomicity: false,
        externalResultsReplayed: false,
        recovery: 'reapply_exact_lock_with_same_field_manager',
        ambientHome: false,
        ephemeralCache: true,
      })
  ) {
    fail('deployment receipt is invalid');
  }
  validateLockSummary(value.lock);
  validateTargetSummary(value.target);
  validateToolSummary(value.tool);
  for (const step of value.steps) validateStepRecord(step);
  if (value.steps.some((step) => step.status !== 0)) {
    fail('deployment receipt contains a failed step');
  }
  const { receiptDigest, ...unsigned } = value;
  if (receiptDigest !== sha256(Buffer.from(JSON.stringify(unsigned), 'utf8'))) {
    fail('deployment receipt self digest is invalid');
  }
  return value;
}

function existingReceipt(request, commandDigest) {
  if (!fs.existsSync(request.output)) return null;
  const file = readCanonicalJson(
    request.output,
    'existing deployment receipt',
    MAX_REPORT_BYTES,
  );
  const receipt = validateReceipt(file.value, commandDigest);
  if (
    receipt.mutationId !== request.mutationId ||
    receipt.preflightDigest !== request.preflight.expectedDigest
  ) {
    fail('existing deployment receipt binding changed');
  }
  return receipt;
}

function applyDeployment(commandState, dependencies = {}) {
  const request = commandState.command.request;
  const resumed = existingReceipt(request, commandState.commandDigest);
  if (resumed !== null) {
    const inputs = inspectInputs(request);
    const preflight = readAndValidatePreflight(request, inputs);
    if (
      resumed.preflightDigest !== preflight.report.preflightDigest ||
      JSON.stringify(resumed.lock) !== JSON.stringify(lockSummary(inputs)) ||
      JSON.stringify(resumed.target) !==
        JSON.stringify(targetSummary(inputs, request)) ||
      JSON.stringify(resumed.tool) !== JSON.stringify(toolSummary(inputs))
    ) {
      fail('existing deployment receipt authority changed');
    }
    revalidateStableInputs(inputs, request);
    return resumed;
  }
  const output = outputTarget(request.output, 'apply receipt output');
  const inputs = inspectInputs(request);
  const preflight = readAndValidatePreflight(request, inputs);
  const runner = dependencies.runProcess ?? defaultRunProcess;
  const steps = [
    identityStep(inputs, request, runner, 'cluster_identity_before'),
    dryRunStep(inputs, request, runner),
  ];
  const applied = runStep(
    inputs,
    request,
    'server_side_apply',
    [
      'apply',
      '--server-side',
      `--field-manager=${FIELD_MANAGER}`,
      '--validate=strict',
      '-f=-',
      '-o=name',
    ],
    runner,
  );
  if (applied.status !== 0) fail('Kubernetes server-side apply failed');
  const { stdout: _appliedOutput, ...appliedRecord } = applied;
  steps.push(Object.freeze(appliedRecord));
  steps.push(convergenceReadStep(inputs, request, runner));
  steps.push(identityStep(inputs, request, runner, 'cluster_identity_after'));
  revalidateStableInputs(inputs, request);
  const unsigned = {
    schemaVersion: 1,
    schema: RECEIPT_SCHEMA,
    mutationId: request.mutationId,
    commandDigest: commandState.commandDigest,
    preflightDigest: preflight.report.preflightDigest,
    lock: lockSummary(inputs),
    target: targetSummary(inputs, request),
    tool: toolSummary(inputs),
    steps,
    verification: {
      catalogBoundLock: true,
      clusterIdentityBound: true,
      serverSideDryRun: true,
      serverSideApply: true,
      convergenceRead: true,
      networkAccess: true,
      kubernetesMutation: true,
      crossResourceAtomicity: false,
      externalResultsReplayed: false,
      recovery: 'reapply_exact_lock_with_same_field_manager',
      ambientHome: false,
      ephemeralCache: true,
    },
  };
  const receipt = Object.freeze({
    ...unsigned,
    receiptDigest: sha256(Buffer.from(JSON.stringify(unsigned), 'utf8')),
  });
  writeNoReplace(output, receipt);
  return receipt;
}

function auditReceipt(command) {
  const applyFile = verifyExpected(
    readCanonicalJson(
      command.request.applyCommand.path,
      'apply command',
      MAX_COMMAND_BYTES,
    ),
    command.request.applyCommand.expectedDigest,
    'apply command',
  );
  const applyCommand = parseCommand(applyFile.value);
  if (applyCommand.operation !== 'cluster.deployment.apply') {
    fail('receipt audit requires an apply command');
  }
  const receiptFile = readCanonicalJson(
    command.request.receipt.path,
    'deployment receipt',
    MAX_REPORT_BYTES,
  );
  const receipt = validateReceipt(receiptFile.value, applyFile.digest);
  if (
    receipt.receiptDigest !== command.request.receipt.expectedDigest ||
    receipt.mutationId !== applyCommand.request.mutationId ||
    receipt.preflightDigest !== applyCommand.request.preflight.expectedDigest ||
    applyCommand.request.output !== command.request.receipt.path
  ) {
    fail('deployment receipt command binding changed');
  }
  return Object.freeze({
    compatible: true,
    deploymentFamily: 'cluster',
    mutationId: receipt.mutationId,
    receiptDigest: receipt.receiptDigest,
    preflightDigest: receipt.preflightDigest,
    lockDigest: receipt.lock.lockDigest,
    manifestDigest: receipt.lock.manifestDigest,
    clusterUid: receipt.target.clusterUid,
    externalResultsReplayed: false,
    kubernetesMutation: false,
  });
}

function executeCommand(commandFile, dependencies = {}) {
  const commandState = readCommand(commandFile);
  if (commandState.command.operation === 'cluster.deployment.preflight') {
    return createPreflight(commandState, dependencies);
  }
  if (commandState.command.operation === 'cluster.deployment.apply') {
    return applyDeployment(commandState, dependencies);
  }
  return auditReceipt(commandState.command);
}

module.exports = Object.freeze({
  COMMAND_SCHEMA,
  FIELD_MANAGER,
  LOCK_SCHEMA,
  PREFLIGHT_SCHEMA,
  RECEIPT_SCHEMA,
  QingLong3KubernetesDeploymentCeremonyError,
  canonicalJson,
  executeCommand,
  parseCommand,
  validateLockReport,
  validatePreflight,
  validateReceipt,
});
