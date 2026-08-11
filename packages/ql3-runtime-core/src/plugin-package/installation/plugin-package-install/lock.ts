import { createHash } from 'node:crypto';

import {
  PLUGIN_PACKAGE_ARCHITECTURES,
  PLUGIN_PACKAGE_DEPLOYMENT_PROFILES,
  type PluginPackageArchitecture,
  type PluginPackageDeploymentProfile,
  type PluginPackageInstallEnvironment,
  type PluginPackageInstallPlan,
  type PluginPackageManifest,
  type PluginPackagePlanOperation,
  type PluginPackageRisk,
  normalizePluginPackageManifest,
  normalizePluginPackageInstallEnvironment,
  planPluginPackageInstall,
} from '../../pluginPackage';
import {
  SECURITY_SUBJECT_TYPES,
  type SecurityPolicyFence,
  type SecuritySubject,
} from '../../../security/security';
import {
  createPluginPackageResourceGenerationFromReferences,
  normalizePluginPackageResourceReferences,
  pluginPackageResourceReferencesFromContents,
  type PluginPackageResourceReference,
} from '../../pluginPackageResourceGeneration';
import { semver } from '../../../versioning/pinnedSemver';

import {
  PLUGIN_PACKAGE_LOCK_SCHEMA,
  PLUGIN_PACKAGE_INSTALL_ACTION_SCHEMA,
  MAX_PLUGIN_PACKAGE_SOURCE_BYTES,
  MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
  PLUGIN_PACKAGE_SOURCE_KINDS,
  InvalidPluginPackageLockError,
  type PluginPackageSourceKind,
  type PluginPackageSourceLock,
  type PluginPackageApprovalLock,
  type CreatePluginPackageLockInput,
  type PluginPackageInstallActionInput,
  type PluginPackageLock,
} from './contracts';
import {
  PACKAGE_NAME_PATTERN,
  OCI_LOCATOR_PATTERN,
  OCI_REGISTRY_PATTERN,
  OFFLINE_LOCATOR_PATTERN,
  PLAN_RISKS,
  PLAN_OPERATIONS,
  PLAN_FINDING_CODES,
  exactKeys,
  lockObject,
  identifier,
  boundedText,
  digest,
  timestamp,
  positiveInteger,
  nonNegativeInteger,
  canonicalJson,
  contentDigest,
} from './codec';

export function serializePluginPackageManifest(
  value: PluginPackageManifest,
): string {
  return canonicalJson(normalizePluginPackageManifest(value));
}

export function pluginPackageManifestDigest(
  value: PluginPackageManifest,
): string {
  return createHash('sha256')
    .update(serializePluginPackageManifest(value), 'utf8')
    .digest('hex');
}

export function normalizeSource(value: unknown): Readonly<PluginPackageSourceLock> {
  const source = lockObject(value, 'source');
  exactKeys(
    source,
    ['kind', 'locator', 'artifactDigest', 'artifactBytes', 'contentDigest'],
    [],
    'source',
    InvalidPluginPackageLockError,
  );
  if (
    !PLUGIN_PACKAGE_SOURCE_KINDS.includes(
      source.kind as PluginPackageSourceKind,
    )
  ) {
    throw new InvalidPluginPackageLockError('source kind is invalid');
  }
  const kind = source.kind as PluginPackageSourceKind;
  const locator = boundedText(
    source.locator,
    'source locator',
    512,
    InvalidPluginPackageLockError,
  );
  const artifactDigest = digest(
    source.artifactDigest,
    'source artifact digest',
    InvalidPluginPackageLockError,
  );
  const locatorMatch =
    kind === 'oci'
      ? locator.match(OCI_LOCATOR_PATTERN)
      : locator.match(OFFLINE_LOCATOR_PATTERN);
  if (!locatorMatch) {
    throw new InvalidPluginPackageLockError('source locator is not immutable');
  }
  if (kind === 'oci') {
    const registryMatch = locatorMatch[1]?.match(OCI_REGISTRY_PATTERN);
    if (
      !registryMatch ||
      Buffer.byteLength(registryMatch[1]!, 'utf8') > 253 ||
      (registryMatch[2] !== undefined && Number(registryMatch[2]) > 65_535)
    ) {
      throw new InvalidPluginPackageLockError(
        'source OCI registry is not canonical',
      );
    }
  } else if (locatorMatch.at(-1) !== artifactDigest) {
    throw new InvalidPluginPackageLockError(
      'offline source locator does not match its artifact digest',
    );
  }
  return Object.freeze({
    kind,
    locator,
    artifactDigest,
    artifactBytes: positiveInteger(
      source.artifactBytes,
      'source artifact bytes',
      MAX_PLUGIN_PACKAGE_SOURCE_BYTES,
      InvalidPluginPackageLockError,
    ),
    contentDigest: digest(
      source.contentDigest,
      'source content digest',
      InvalidPluginPackageLockError,
    ),
  });
}

export function normalizeSubject(value: unknown): Readonly<SecuritySubject> {
  const subject = lockObject(value, 'approval subject');
  exactKeys(
    subject,
    ['type', 'id'],
    [],
    'approval subject',
    InvalidPluginPackageLockError,
  );
  if (
    !SECURITY_SUBJECT_TYPES.includes(subject.type as SecuritySubject['type'])
  ) {
    throw new InvalidPluginPackageLockError('approval subject type is invalid');
  }
  return Object.freeze({
    type: subject.type as SecuritySubject['type'],
    id: boundedText(
      subject.id,
      'approval subject id',
      255,
      InvalidPluginPackageLockError,
    ),
  });
}

export function normalizeFence(value: unknown): Readonly<SecurityPolicyFence> {
  const fence = lockObject(value, 'approval fence');
  exactKeys(
    fence,
    ['projectVersion', 'bindingVersion'],
    [],
    'approval fence',
    InvalidPluginPackageLockError,
  );
  return Object.freeze({
    projectVersion: positiveInteger(
      fence.projectVersion,
      'approval project version',
      MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
      InvalidPluginPackageLockError,
    ),
    bindingVersion:
      fence.bindingVersion === null
        ? null
        : positiveInteger(
            fence.bindingVersion,
            'approval binding version',
            MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
            InvalidPluginPackageLockError,
          ),
  });
}

export function normalizeApproval(
  value: unknown,
  createdAtMs: number,
): Readonly<PluginPackageApprovalLock> {
  const approval = lockObject(value, 'approval');
  exactKeys(
    approval,
    [
      'requestId',
      'requestVersion',
      'dispatchId',
      'actionDigest',
      'previewDigest',
      'approvedBy',
      'approvedAtMs',
      'expiresAtMs',
      'fence',
    ],
    [],
    'approval',
    InvalidPluginPackageLockError,
  );
  const approvedAtMs = timestamp(
    approval.approvedAtMs,
    'approval time',
    InvalidPluginPackageLockError,
  );
  const expiresAtMs = timestamp(
    approval.expiresAtMs,
    'approval expiry',
    InvalidPluginPackageLockError,
  );
  if (approvedAtMs > createdAtMs || expiresAtMs <= createdAtMs) {
    throw new InvalidPluginPackageLockError(
      'approval is not active when the lock is created',
    );
  }
  const approvedBy = normalizeSubject(approval.approvedBy);
  if (approvedBy.type !== 'user') {
    throw new InvalidPluginPackageLockError(
      'package installation requires a human approval',
    );
  }
  return Object.freeze({
    requestId: identifier(
      approval.requestId,
      'approval request id',
      InvalidPluginPackageLockError,
    ),
    requestVersion: positiveInteger(
      approval.requestVersion,
      'approval request version',
      MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
      InvalidPluginPackageLockError,
    ),
    dispatchId: identifier(
      approval.dispatchId,
      'approval dispatch id',
      InvalidPluginPackageLockError,
    ),
    actionDigest: digest(
      approval.actionDigest,
      'approval action digest',
      InvalidPluginPackageLockError,
    ),
    previewDigest: digest(
      approval.previewDigest,
      'approval preview digest',
      InvalidPluginPackageLockError,
    ),
    approvedBy,
    approvedAtMs,
    expiresAtMs,
    fence: normalizeFence(approval.fence),
  });
}

export function normalizeStringArray(
  value: unknown,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new InvalidPluginPackageLockError(`${label} is invalid`);
  }
  const normalized = value.map((entry) =>
    boundedText(entry, label, 512, InvalidPluginPackageLockError),
  );
  if (
    new Set(normalized).size !== normalized.length ||
    normalized.some(
      (entry, index) => index > 0 && normalized[index - 1]! > entry,
    )
  ) {
    throw new InvalidPluginPackageLockError(
      `${label} must be unique and sorted`,
    );
  }
  return Object.freeze(normalized);
}

export function normalizePlan(value: unknown): Readonly<PluginPackageInstallPlan> {
  const plan = lockObject(value, 'install plan');
  exactKeys(
    plan,
    [
      'package',
      'operation',
      'compatible',
      'risk',
      'approvalRequired',
      'permissionReapprovalRequired',
      'permissionDelta',
      'resources',
      'contents',
      'findings',
    ],
    [],
    'install plan',
    InvalidPluginPackageLockError,
  );
  if (
    plan.compatible !== true ||
    plan.approvalRequired !== true ||
    typeof plan.permissionReapprovalRequired !== 'boolean' ||
    !PLAN_RISKS.includes(plan.risk as PluginPackageRisk) ||
    !PLAN_OPERATIONS.includes(plan.operation as PluginPackagePlanOperation)
  ) {
    throw new InvalidPluginPackageLockError(
      'install plan is not compatible or has invalid policy fields',
    );
  }
  const packageValue = lockObject(plan.package, 'install plan package');
  exactKeys(
    packageValue,
    ['name', 'toVersion'],
    ['fromVersion'],
    'install plan package',
    InvalidPluginPackageLockError,
  );
  const packageName = boundedText(
    packageValue.name,
    'install plan package name',
    64,
    InvalidPluginPackageLockError,
  );
  if (!PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new InvalidPluginPackageLockError(
      'install plan package name is invalid',
    );
  }
  const toVersion = boundedText(
    packageValue.toVersion,
    'install plan target version',
    128,
    InvalidPluginPackageLockError,
  );
  if (semver().valid(toVersion) !== toVersion) {
    throw new InvalidPluginPackageLockError(
      'install plan target version is invalid',
    );
  }
  const operation = plan.operation as PluginPackagePlanOperation;
  const fromVersion =
    packageValue.fromVersion === undefined
      ? undefined
      : boundedText(
          packageValue.fromVersion,
          'install plan source version',
          128,
          InvalidPluginPackageLockError,
        );
  if (
    fromVersion !== undefined &&
    semver().valid(fromVersion) !== fromVersion
  ) {
    throw new InvalidPluginPackageLockError(
      'install plan source version is invalid',
    );
  }
  if (
    (operation === 'install' && fromVersion !== undefined) ||
    (operation !== 'install' && fromVersion === undefined)
  ) {
    throw new InvalidPluginPackageLockError(
      'install plan operation does not match its package versions',
    );
  }

  const delta = lockObject(plan.permissionDelta, 'permission delta');
  exactKeys(
    delta,
    ['added', 'removed'],
    [],
    'permission delta',
    InvalidPluginPackageLockError,
  );
  const resources = lockObject(plan.resources, 'install resources');
  exactKeys(
    resources,
    ['memoryRecommendedBytes', 'diskInstallBytes', 'diskWorkingBytes'],
    [],
    'install resources',
    InvalidPluginPackageLockError,
  );
  const contents = lockObject(plan.contents, 'install contents');
  exactKeys(
    contents,
    ['tasks', 'workflows', 'prompts', 'tools'],
    [],
    'install contents',
    InvalidPluginPackageLockError,
  );
  if (!Array.isArray(plan.findings) || plan.findings.length > 32) {
    throw new InvalidPluginPackageLockError('install findings are invalid');
  }
  const findings = plan.findings.map((entry) => {
    const finding = lockObject(entry, 'install finding');
    exactKeys(
      finding,
      ['code', 'severity', 'subject'],
      [],
      'install finding',
      InvalidPluginPackageLockError,
    );
    if (
      !PLAN_FINDING_CODES.has(finding.code as string) ||
      finding.severity !== 'warning'
    ) {
      throw new InvalidPluginPackageLockError(
        'compatible install plan contains an invalid finding',
      );
    }
    return Object.freeze({
      code: finding.code as PluginPackageInstallPlan['findings'][number]['code'],
      severity: 'warning' as const,
      subject: boundedText(
        finding.subject,
        'install finding subject',
        512,
        InvalidPluginPackageLockError,
      ),
    });
  });
  return Object.freeze({
    package: Object.freeze({
      name: packageName,
      ...(fromVersion === undefined ? {} : { fromVersion }),
      toVersion,
    }),
    operation,
    compatible: true,
    risk: plan.risk as PluginPackageRisk,
    approvalRequired: true,
    permissionReapprovalRequired: plan.permissionReapprovalRequired as boolean,
    permissionDelta: Object.freeze({
      added: normalizeStringArray(delta.added, 'added permission'),
      removed: normalizeStringArray(delta.removed, 'removed permission'),
    }),
    resources: Object.freeze({
      memoryRecommendedBytes: positiveInteger(
        resources.memoryRecommendedBytes,
        'recommended memory bytes',
        MAX_PLUGIN_PACKAGE_SOURCE_BYTES,
        InvalidPluginPackageLockError,
      ),
      diskInstallBytes: positiveInteger(
        resources.diskInstallBytes,
        'install disk bytes',
        MAX_PLUGIN_PACKAGE_SOURCE_BYTES,
        InvalidPluginPackageLockError,
      ),
      diskWorkingBytes: positiveInteger(
        resources.diskWorkingBytes,
        'working disk bytes',
        MAX_PLUGIN_PACKAGE_SOURCE_BYTES,
        InvalidPluginPackageLockError,
      ),
    }),
    contents: Object.freeze({
      tasks: nonNegativeInteger(
        contents.tasks,
        'task count',
        256,
        InvalidPluginPackageLockError,
      ),
      workflows: nonNegativeInteger(
        contents.workflows,
        'workflow count',
        256,
        InvalidPluginPackageLockError,
      ),
      prompts: nonNegativeInteger(
        contents.prompts,
        'prompt count',
        256,
        InvalidPluginPackageLockError,
      ),
      tools: nonNegativeInteger(
        contents.tools,
        'tool count',
        256,
        InvalidPluginPackageLockError,
      ),
    }),
    findings: Object.freeze(findings),
  });
}

export function lockActionPayload(
  input: Readonly<{
    lockId: string;
    projectId: string;
    packageName: string;
    packageVersion: string;
    operation: PluginPackagePlanOperation;
    source: Readonly<PluginPackageSourceLock>;
    manifestDigest: string;
    resources: readonly Readonly<PluginPackageResourceReference>[];
    planDigest: string;
    environmentDigest: string;
    architecture: PluginPackageArchitecture;
    deploymentProfile: PluginPackageDeploymentProfile;
    targetGeneration: number;
    previousLockDigest?: string;
  }>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema: PLUGIN_PACKAGE_INSTALL_ACTION_SCHEMA,
    lockId: input.lockId,
    projectId: input.projectId,
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    operation: input.operation,
    source: input.source,
    manifestDigest: input.manifestDigest,
    resources: input.resources,
    planDigest: input.planDigest,
    environmentDigest: input.environmentDigest,
    architecture: input.architecture,
    deploymentProfile: input.deploymentProfile,
    targetGeneration: input.targetGeneration,
    ...(input.previousLockDigest === undefined
      ? {}
      : { previousLockDigest: input.previousLockDigest }),
  });
}

export function pluginPackageInstallActionDigest(
  input: Omit<CreatePluginPackageLockInput, 'approval' | 'createdAtMs'>,
): string {
  const value = lockObject(input, 'install action input');
  exactKeys(
    value,
    [
      'lockId',
      'projectId',
      'manifest',
      'plan',
      'environment',
      'source',
      'architecture',
      'deploymentProfile',
      'targetGeneration',
    ],
    ['previousLockDigest', 'previousManifest'],
    'install action input',
    InvalidPluginPackageLockError,
  );
  const prepared = prepareLockFields({
    ...input,
    createdAtMs: 0,
  });
  return contentDigest(lockActionPayload(prepared));
}

export function pluginPackageInstallPlanDigest(
  value: PluginPackageInstallPlan,
): string {
  return contentDigest(normalizePlan(value));
}

export function normalizePluginPackageInstallActionInput(
  input: PluginPackageInstallActionInput,
): Readonly<PluginPackageInstallActionInput> {
  const value = lockObject(input, 'install action input');
  exactKeys(
    value,
    [
      'lockId',
      'projectId',
      'manifest',
      'plan',
      'environment',
      'source',
      'architecture',
      'deploymentProfile',
      'targetGeneration',
    ],
    ['previousLockDigest', 'previousManifest'],
    'install action input',
    InvalidPluginPackageLockError,
  );
  const prepared = prepareLockFields({
    ...input,
    createdAtMs: 0,
  });
  const previousManifest =
    input.previousManifest === undefined
      ? undefined
      : normalizePluginPackageManifest(input.previousManifest);
  return Object.freeze({
    lockId: prepared.lockId,
    projectId: prepared.projectId,
    manifest: normalizePluginPackageManifest(input.manifest),
    plan: normalizePlan(input.plan),
    environment: normalizePluginPackageInstallEnvironment(input.environment),
    ...(previousManifest === undefined ? {} : { previousManifest }),
    source: prepared.source,
    architecture: prepared.architecture,
    deploymentProfile: prepared.deploymentProfile,
    targetGeneration: prepared.targetGeneration,
    ...(prepared.previousLockDigest === undefined
      ? {}
      : { previousLockDigest: prepared.previousLockDigest }),
  });
}

export function prepareLockFields(
  input: Omit<CreatePluginPackageLockInput, 'approval'>,
): Readonly<{
  lockId: string;
  projectId: string;
  packageName: string;
  packageVersion: string;
  operation: PluginPackagePlanOperation;
  source: Readonly<PluginPackageSourceLock>;
  manifestDigest: string;
  resources: readonly Readonly<PluginPackageResourceReference>[];
  planDigest: string;
  environmentDigest: string;
  architecture: PluginPackageArchitecture;
  deploymentProfile: PluginPackageDeploymentProfile;
  targetGeneration: number;
  previousLockDigest?: string;
  createdAtMs: number;
}> {
  const manifest = normalizePluginPackageManifest(input.manifest);
  const environment = normalizePluginPackageInstallEnvironment(
    input.environment,
  );
  const previousManifest =
    input.previousManifest === undefined
      ? undefined
      : normalizePluginPackageManifest(input.previousManifest);
  const plan = normalizePlan(input.plan);
  const expectedPlan = normalizePlan(
    planPluginPackageInstall(manifest, environment, previousManifest),
  );
  if (
    manifest.metadata.name !== plan.package.name ||
    manifest.metadata.version !== plan.package.toVersion ||
    contentDigest(plan) !== contentDigest(expectedPlan)
  ) {
    throw new InvalidPluginPackageLockError(
      'manifest, environment or previous manifest does not match the install plan',
    );
  }
  if (!PLUGIN_PACKAGE_ARCHITECTURES.includes(input.architecture)) {
    throw new InvalidPluginPackageLockError('target architecture is invalid');
  }
  if (!PLUGIN_PACKAGE_DEPLOYMENT_PROFILES.includes(input.deploymentProfile)) {
    throw new InvalidPluginPackageLockError(
      'target deployment profile is invalid',
    );
  }
  if (
    input.architecture !== environment.architecture ||
    input.deploymentProfile !== environment.deploymentProfile
  ) {
    throw new InvalidPluginPackageLockError(
      'target architecture or profile does not match the install environment',
    );
  }
  const targetGeneration = positiveInteger(
    input.targetGeneration,
    'target generation',
    MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
    InvalidPluginPackageLockError,
  );
  const previousLockDigest =
    input.previousLockDigest === undefined
      ? undefined
      : digest(
          input.previousLockDigest,
          'previous lock digest',
          InvalidPluginPackageLockError,
        );
  if (
    (plan.operation === 'install' &&
      (targetGeneration !== 1 || previousLockDigest !== undefined)) ||
    (plan.operation !== 'install' &&
      (targetGeneration < 2 || previousLockDigest === undefined))
  ) {
    throw new InvalidPluginPackageLockError(
      'operation does not match the target generation or previous lock',
    );
  }
  return Object.freeze({
    lockId: identifier(input.lockId, 'lock id', InvalidPluginPackageLockError),
    projectId: boundedText(
      input.projectId,
      'project id',
      128,
      InvalidPluginPackageLockError,
    ),
    packageName: manifest.metadata.name,
    packageVersion: manifest.metadata.version,
    operation: plan.operation,
    source: normalizeSource(input.source),
    manifestDigest: pluginPackageManifestDigest(manifest),
    resources: pluginPackageResourceReferencesFromContents(
      manifest.spec.contents,
    ),
    planDigest: contentDigest(plan),
    environmentDigest: contentDigest(environment),
    architecture: input.architecture,
    deploymentProfile: input.deploymentProfile,
    targetGeneration,
    ...(previousLockDigest === undefined ? {} : { previousLockDigest }),
    createdAtMs: timestamp(
      input.createdAtMs,
      'lock creation time',
      InvalidPluginPackageLockError,
    ),
  });
}

export function createPluginPackageLock(
  input: CreatePluginPackageLockInput,
): Readonly<PluginPackageLock> {
  const value = lockObject(input, 'lock input');
  exactKeys(
    value,
    [
      'lockId',
      'projectId',
      'manifest',
      'plan',
      'environment',
      'source',
      'approval',
      'architecture',
      'deploymentProfile',
      'targetGeneration',
      'createdAtMs',
    ],
    ['previousLockDigest', 'previousManifest'],
    'lock input',
    InvalidPluginPackageLockError,
  );
  const fields = prepareLockFields(input);
  const actionDigest = contentDigest(lockActionPayload(fields));
  const approval = normalizeApproval(input.approval, fields.createdAtMs);
  if (
    approval.actionDigest !== actionDigest ||
    approval.previewDigest !== fields.planDigest
  ) {
    throw new InvalidPluginPackageLockError(
      'approval is not bound to this action and preview',
    );
  }
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_LOCK_SCHEMA,
    ...fields,
    actionDigest,
    approval,
  });
  return Object.freeze({
    ...unsigned,
    lockDigest: contentDigest(unsigned),
  });
}

export function normalizePluginPackageLock(
  value: PluginPackageLock,
): Readonly<PluginPackageLock> {
  const lock = lockObject(value, 'lock');
  exactKeys(
    lock,
    [
      'schema',
      'lockId',
      'projectId',
      'packageName',
      'packageVersion',
      'operation',
      'source',
      'manifestDigest',
      'resources',
      'planDigest',
      'environmentDigest',
      'actionDigest',
      'approval',
      'architecture',
      'deploymentProfile',
      'targetGeneration',
      'createdAtMs',
      'lockDigest',
    ],
    ['previousLockDigest'],
    'lock',
    InvalidPluginPackageLockError,
  );
  if (
    lock.schema !== PLUGIN_PACKAGE_LOCK_SCHEMA ||
    !PLAN_OPERATIONS.includes(lock.operation as PluginPackagePlanOperation) ||
    !PLUGIN_PACKAGE_ARCHITECTURES.includes(
      lock.architecture as PluginPackageArchitecture,
    ) ||
    !PLUGIN_PACKAGE_DEPLOYMENT_PROFILES.includes(
      lock.deploymentProfile as PluginPackageDeploymentProfile,
    )
  ) {
    throw new InvalidPluginPackageLockError('lock vocabulary is invalid');
  }
  const targetGeneration = positiveInteger(
    lock.targetGeneration,
    'target generation',
    MAX_PLUGIN_PACKAGE_INSTALL_VERSION,
    InvalidPluginPackageLockError,
  );
  const previousLockDigest =
    lock.previousLockDigest === undefined
      ? undefined
      : digest(
          lock.previousLockDigest,
          'previous lock digest',
          InvalidPluginPackageLockError,
        );
  if (
    (lock.operation === 'install' &&
      (targetGeneration !== 1 || previousLockDigest !== undefined)) ||
    (lock.operation !== 'install' &&
      (targetGeneration < 2 || previousLockDigest === undefined))
  ) {
    throw new InvalidPluginPackageLockError(
      'operation does not match lock generation',
    );
  }
  const createdAtMs = timestamp(
    lock.createdAtMs,
    'lock creation time',
    InvalidPluginPackageLockError,
  );
  const unsigned = Object.freeze({
    schema: PLUGIN_PACKAGE_LOCK_SCHEMA,
    lockId: identifier(lock.lockId, 'lock id', InvalidPluginPackageLockError),
    projectId: boundedText(
      lock.projectId,
      'project id',
      128,
      InvalidPluginPackageLockError,
    ),
    packageName: boundedText(
      lock.packageName,
      'package name',
      64,
      InvalidPluginPackageLockError,
    ),
    packageVersion: boundedText(
      lock.packageVersion,
      'package version',
      128,
      InvalidPluginPackageLockError,
    ),
    operation: lock.operation as PluginPackagePlanOperation,
    source: normalizeSource(lock.source),
    manifestDigest: digest(
      lock.manifestDigest,
      'manifest digest',
      InvalidPluginPackageLockError,
    ),
    resources: normalizePluginPackageResourceReferences(lock.resources),
    planDigest: digest(
      lock.planDigest,
      'plan digest',
      InvalidPluginPackageLockError,
    ),
    environmentDigest: digest(
      lock.environmentDigest,
      'environment digest',
      InvalidPluginPackageLockError,
    ),
    actionDigest: digest(
      lock.actionDigest,
      'action digest',
      InvalidPluginPackageLockError,
    ),
    approval: normalizeApproval(lock.approval, createdAtMs),
    architecture: lock.architecture as PluginPackageArchitecture,
    deploymentProfile: lock.deploymentProfile as PluginPackageDeploymentProfile,
    targetGeneration,
    ...(previousLockDigest === undefined ? {} : { previousLockDigest }),
    createdAtMs,
  });
  if (
    !PACKAGE_NAME_PATTERN.test(unsigned.packageName) ||
    semver().valid(unsigned.packageVersion) !== unsigned.packageVersion ||
    unsigned.approval.approvedBy.type !== 'user'
  ) {
    throw new InvalidPluginPackageLockError(
      'lock package identity or human approval is invalid',
    );
  }
  if (
    unsigned.approval.actionDigest !== unsigned.actionDigest ||
    unsigned.approval.previewDigest !== unsigned.planDigest ||
    contentDigest(lockActionPayload(unsigned)) !== unsigned.actionDigest
  ) {
    throw new InvalidPluginPackageLockError('lock approval binding is invalid');
  }
  const lockDigest = digest(
    lock.lockDigest,
    'lock digest',
    InvalidPluginPackageLockError,
  );
  if (contentDigest(unsigned) !== lockDigest) {
    throw new InvalidPluginPackageLockError('lock digest does not match');
  }
  return Object.freeze({ ...unsigned, lockDigest });
}
