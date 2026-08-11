import { semver } from '../versioning/pinnedSemver';

export const PLUGIN_PACKAGE_API_VERSION = 'qinglong.io/v1alpha1';
export const PLUGIN_PACKAGE_KIND = 'Package';
export const MAX_PLUGIN_PACKAGE_MANIFEST_BYTES = 64 * 1024;
export const MAX_PLUGIN_PACKAGE_RUNTIMES = 8;
export const MAX_PLUGIN_PACKAGE_NETWORK_HOSTS = 32;
export const MAX_PLUGIN_PACKAGE_SECRETS = 64;
export const MAX_PLUGIN_PACKAGE_TOOL_PERMISSIONS = 64;
export const MAX_PLUGIN_PACKAGE_CONTENT_ENTRIES = 256;
export const MAX_PLUGIN_PACKAGE_CONTENT_PATH_BYTES = 255;
export const MAX_PLUGIN_PACKAGE_RESOURCE_BYTES = 1024 ** 4;

export const PLUGIN_PACKAGE_ARCHITECTURES = [
  'amd64',
  'arm64',
  'arm/v7',
  'ppc64le',
  's390x',
] as const;

export const PLUGIN_PACKAGE_DEPLOYMENT_PROFILES = [
  'edge',
  'standalone',
  'cluster-control',
  'worker',
] as const;

export const PLUGIN_PACKAGE_TOOL_PERMISSIONS = [
  'artifact.read',
  'dependency.install',
  'filesystem.read',
  'filesystem.write',
  'mcp.tool.call',
  'model.invoke',
  'network.connect',
  'notification.send',
  'run.read',
  'run.start',
  'run.stop',
  'run.retry',
  'secret.use',
  'system.command',
  'task.read',
  'task.update',
  'background.service',
] as const;

export type PluginPackageArchitecture =
  (typeof PLUGIN_PACKAGE_ARCHITECTURES)[number];
export type PluginPackageDeploymentProfile =
  (typeof PLUGIN_PACKAGE_DEPLOYMENT_PROFILES)[number];
export type PluginPackageToolPermission =
  (typeof PLUGIN_PACKAGE_TOOL_PERMISSIONS)[number];
export type PluginPackageRisk = 'low' | 'medium' | 'high';
export type PluginPackagePlanOperation =
  | 'install'
  | 'reinstall'
  | 'upgrade'
  | 'rollback';
export type PluginPackageFindingSeverity = 'warning' | 'error';

export interface PluginPackageManifestMetadata {
  readonly name: string;
  readonly displayName: string;
  readonly version: string;
  readonly description: string;
  readonly license: string;
}

export interface PluginPackageRuntimeRequirement {
  readonly name: string;
  readonly version: string;
}

export interface PluginPackageSecretRequirement {
  readonly name: string;
  readonly required: boolean;
}

export interface PluginPackageContents {
  readonly tasks: readonly string[];
  readonly workflows: readonly string[];
  readonly prompts: readonly string[];
  readonly tools: readonly string[];
}

export interface PluginPackageManifest {
  readonly apiVersion: typeof PLUGIN_PACKAGE_API_VERSION;
  readonly kind: typeof PLUGIN_PACKAGE_KIND;
  readonly metadata: Readonly<PluginPackageManifestMetadata>;
  readonly spec: Readonly<{
    compatibility: Readonly<{
      qinglong: string;
      architectures: readonly PluginPackageArchitecture[];
      deploymentProfiles: readonly PluginPackageDeploymentProfile[];
    }>;
    runtimes: readonly Readonly<PluginPackageRuntimeRequirement>[];
    resources: Readonly<{
      memory: Readonly<{ recommended: string }>;
      disk: Readonly<{ install: string; working: string }>;
    }>;
    permissions: Readonly<{
      network: Readonly<{ allowedHosts: readonly string[] }>;
      secrets: readonly Readonly<PluginPackageSecretRequirement>[];
      tools: readonly PluginPackageToolPermission[];
    }>;
    contents: Readonly<PluginPackageContents>;
  }>;
}

export interface PluginPackageRuntimeEnvironment {
  readonly name: string;
  readonly version: string;
}

export interface PluginPackageInstallEnvironment {
  readonly qinglongVersion: string;
  readonly architecture: PluginPackageArchitecture;
  readonly deploymentProfile: PluginPackageDeploymentProfile;
  readonly runtimes: readonly Readonly<PluginPackageRuntimeEnvironment>[];
  readonly availableMemoryBytes: number;
  readonly availableDiskBytes: number;
}

export interface PluginPackagePlanFinding {
  readonly code:
    | 'architecture_unsupported'
    | 'deployment_profile_unsupported'
    | 'disk_insufficient'
    | 'memory_below_recommendation'
    | 'qinglong_version_unsupported'
    | 'runtime_missing'
    | 'runtime_version_unsupported';
  readonly severity: PluginPackageFindingSeverity;
  readonly subject: string;
}

export interface PluginPackageInstallPlan {
  readonly package: Readonly<{
    name: string;
    fromVersion?: string;
    toVersion: string;
  }>;
  readonly operation: PluginPackagePlanOperation;
  readonly compatible: boolean;
  readonly risk: PluginPackageRisk;
  readonly approvalRequired: true;
  readonly permissionReapprovalRequired: boolean;
  readonly permissionDelta: Readonly<{
    added: readonly string[];
    removed: readonly string[];
  }>;
  readonly resources: Readonly<{
    memoryRecommendedBytes: number;
    diskInstallBytes: number;
    diskWorkingBytes: number;
  }>;
  readonly contents: Readonly<{
    tasks: number;
    workflows: number;
    prompts: number;
    tools: number;
  }>;
  readonly findings: readonly Readonly<PluginPackagePlanFinding>[];
}

export class InvalidPluginPackageManifestError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_MANIFEST_INVALID';

  constructor(message: string) {
    super(`Plugin Package manifest is invalid: ${message}`);
    this.name = 'InvalidPluginPackageManifestError';
  }
}

export class InvalidPluginPackageInstallEnvironmentError extends TypeError {
  readonly code = 'PLUGIN_PACKAGE_INSTALL_ENVIRONMENT_INVALID';

  constructor(message: string) {
    super(`Plugin Package install environment is invalid: ${message}`);
    this.name = 'InvalidPluginPackageInstallEnvironmentError';
  }
}

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RUNTIME_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const RESOURCE_PATTERN = /^([1-9][0-9]{0,6})(Ki|Mi|Gi)$/;
const HOST_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:(?:[a-z0-9-]{0,61})?[a-z0-9])?(?:\.[a-z0-9](?:(?:[a-z0-9-]{0,61})?[a-z0-9])?)*$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidPluginPackageManifestError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidPluginPackageManifestError(`${label} shape is invalid`);
  }
}

function boundedText(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    CONTROL_PATTERN.test(value) ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  ) {
    throw new InvalidPluginPackageManifestError(`${label} is invalid`);
  }
  return value;
}

function canonicalVersion(value: unknown, label: string): string {
  const version = boundedText(value, label, 128);
  if (semver().valid(version) !== version) {
    throw new InvalidPluginPackageManifestError(`${label} is invalid`);
  }
  return version;
}

function versionRange(value: unknown, label: string): string {
  const range = boundedText(value, label, 256);
  if (!semver().validRange(range)) {
    throw new InvalidPluginPackageManifestError(`${label} is invalid`);
  }
  return range;
}

function uniqueSortedAllowed<T extends string>(
  value: unknown,
  allowed: readonly T[],
  maximum: number,
  label: string,
  allowEmpty = false,
): readonly T[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    (!allowEmpty && value.length === 0)
  ) {
    throw new InvalidPluginPackageManifestError(`${label} is invalid`);
  }
  const entries = new Set<T>();
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      !allowed.includes(item as T) ||
      entries.has(item as T)
    ) {
      throw new InvalidPluginPackageManifestError(
        `${label} contains an invalid or duplicate value`,
      );
    }
    entries.add(item as T);
  }
  return Object.freeze([...entries].sort());
}

function normalizeRuntimes(
  value: unknown,
): readonly Readonly<PluginPackageRuntimeRequirement>[] {
  if (!Array.isArray(value) || value.length > MAX_PLUGIN_PACKAGE_RUNTIMES) {
    throw new InvalidPluginPackageManifestError('runtimes are invalid');
  }
  const names = new Set<string>();
  const runtimes = value.map((item) => {
    const runtime = record(item, 'runtime');
    exactKeys(runtime, ['name', 'version'], 'runtime');
    const name = boundedText(runtime.name, 'runtime name', 32);
    if (!RUNTIME_NAME_PATTERN.test(name) || names.has(name)) {
      throw new InvalidPluginPackageManifestError(
        'runtime name is invalid or duplicated',
      );
    }
    names.add(name);
    return Object.freeze({
      name,
      version: versionRange(runtime.version, 'runtime version range'),
    });
  });
  runtimes.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze(runtimes);
}

function resourceBytes(value: unknown, label: string): number {
  const quantity = boundedText(value, label, 16);
  const match = RESOURCE_PATTERN.exec(quantity);
  if (!match) {
    throw new InvalidPluginPackageManifestError(`${label} is invalid`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === 'Ki' ? 1024 : unit === 'Mi' ? 1024 ** 2 : 1024 ** 3;
  const bytes = amount * multiplier;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes > MAX_PLUGIN_PACKAGE_RESOURCE_BYTES
  ) {
    throw new InvalidPluginPackageManifestError(`${label} is out of range`);
  }
  return bytes;
}

function normalizeResourceQuantity(value: unknown, label: string): string {
  const quantity = boundedText(value, label, 16);
  resourceBytes(quantity, label);
  return quantity;
}

function normalizeHosts(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_PLUGIN_PACKAGE_NETWORK_HOSTS
  ) {
    throw new InvalidPluginPackageManifestError(
      'network allowedHosts are invalid',
    );
  }
  const hosts = new Set<string>();
  for (const item of value) {
    const host = boundedText(item, 'network host', 253);
    if (!HOST_PATTERN.test(host) || host.includes('*') || hosts.has(host)) {
      throw new InvalidPluginPackageManifestError(
        'network host is invalid or duplicated',
      );
    }
    hosts.add(host);
  }
  return Object.freeze([...hosts].sort());
}

function normalizeSecrets(
  value: unknown,
): readonly Readonly<PluginPackageSecretRequirement>[] {
  if (!Array.isArray(value) || value.length > MAX_PLUGIN_PACKAGE_SECRETS) {
    throw new InvalidPluginPackageManifestError(
      'secret requirements are invalid',
    );
  }
  const names = new Set<string>();
  const secrets = value.map((item) => {
    const secret = record(item, 'secret requirement');
    exactKeys(secret, ['name', 'required'], 'secret requirement');
    const name = boundedText(secret.name, 'secret name', 128);
    if (
      !SECRET_NAME_PATTERN.test(name) ||
      names.has(name) ||
      typeof secret.required !== 'boolean'
    ) {
      throw new InvalidPluginPackageManifestError(
        'secret requirement is invalid or duplicated',
      );
    }
    names.add(name);
    return Object.freeze({ name, required: secret.required });
  });
  secrets.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze(secrets);
}

function normalizeContentPath(value: unknown, directory: string): string {
  const path = boundedText(
    value,
    `${directory} content path`,
    MAX_PLUGIN_PACKAGE_CONTENT_PATH_BYTES,
  );
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    segments.length < 2 ||
    segments[0] !== directory ||
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    throw new InvalidPluginPackageManifestError(
      `${directory} content path is invalid`,
    );
  }
  return path;
}

function normalizeContents(value: unknown): Readonly<PluginPackageContents> {
  const contents = record(value, 'contents');
  exactKeys(contents, ['prompts', 'tasks', 'tools', 'workflows'], 'contents');
  const seen = new Set<string>();
  let total = 0;
  const normalize = (
    directory: string,
    entries: unknown,
  ): readonly string[] => {
    if (
      !Array.isArray(entries) ||
      entries.length > MAX_PLUGIN_PACKAGE_CONTENT_ENTRIES
    ) {
      throw new InvalidPluginPackageManifestError(
        `${directory} contents are invalid`,
      );
    }
    total += entries.length;
    if (total > MAX_PLUGIN_PACKAGE_CONTENT_ENTRIES) {
      throw new InvalidPluginPackageManifestError(
        'content entry budget exceeded',
      );
    }
    const paths = entries.map((entry) => {
      const path = normalizeContentPath(entry, directory);
      if (seen.has(path)) {
        throw new InvalidPluginPackageManifestError(
          'content path is duplicated',
        );
      }
      seen.add(path);
      return path;
    });
    paths.sort();
    return Object.freeze(paths);
  };
  return Object.freeze({
    tasks: normalize('tasks', contents.tasks),
    workflows: normalize('workflows', contents.workflows),
    prompts: normalize('prompts', contents.prompts),
    tools: normalize('tools', contents.tools),
  });
}

export function normalizePluginPackageManifest(
  value: unknown,
): Readonly<PluginPackageManifest> {
  const manifest = record(value, 'manifest');
  exactKeys(manifest, ['apiVersion', 'kind', 'metadata', 'spec'], 'manifest');
  if (
    manifest.apiVersion !== PLUGIN_PACKAGE_API_VERSION ||
    manifest.kind !== PLUGIN_PACKAGE_KIND
  ) {
    throw new InvalidPluginPackageManifestError(
      'apiVersion or kind is unsupported',
    );
  }

  const metadata = record(manifest.metadata, 'metadata');
  exactKeys(
    metadata,
    ['description', 'displayName', 'license', 'name', 'version'],
    'metadata',
  );
  const name = boundedText(metadata.name, 'metadata name', 63);
  if (!PACKAGE_NAME_PATTERN.test(name)) {
    throw new InvalidPluginPackageManifestError(
      'metadata name must be a lowercase DNS label',
    );
  }

  const spec = record(manifest.spec, 'spec');
  exactKeys(
    spec,
    ['compatibility', 'contents', 'permissions', 'resources', 'runtimes'],
    'spec',
  );
  const compatibility = record(spec.compatibility, 'compatibility');
  exactKeys(
    compatibility,
    ['architectures', 'deploymentProfiles', 'qinglong'],
    'compatibility',
  );
  const resources = record(spec.resources, 'resources');
  exactKeys(resources, ['disk', 'memory'], 'resources');
  const memory = record(resources.memory, 'memory resources');
  exactKeys(memory, ['recommended'], 'memory resources');
  const disk = record(resources.disk, 'disk resources');
  exactKeys(disk, ['install', 'working'], 'disk resources');
  const permissions = record(spec.permissions, 'permissions');
  exactKeys(permissions, ['network', 'secrets', 'tools'], 'permissions');
  const network = record(permissions.network, 'network permissions');
  exactKeys(network, ['allowedHosts'], 'network permissions');

  const normalized: PluginPackageManifest = Object.freeze({
    apiVersion: PLUGIN_PACKAGE_API_VERSION,
    kind: PLUGIN_PACKAGE_KIND,
    metadata: Object.freeze({
      name,
      displayName: boundedText(metadata.displayName, 'displayName', 128),
      version: canonicalVersion(metadata.version, 'metadata version'),
      description: boundedText(metadata.description, 'description', 4096),
      license: boundedText(metadata.license, 'license', 128),
    }),
    spec: Object.freeze({
      compatibility: Object.freeze({
        qinglong: versionRange(
          compatibility.qinglong,
          'QingLong compatibility range',
        ),
        architectures: uniqueSortedAllowed(
          compatibility.architectures,
          PLUGIN_PACKAGE_ARCHITECTURES,
          PLUGIN_PACKAGE_ARCHITECTURES.length,
          'architectures',
        ),
        deploymentProfiles: uniqueSortedAllowed(
          compatibility.deploymentProfiles,
          PLUGIN_PACKAGE_DEPLOYMENT_PROFILES,
          PLUGIN_PACKAGE_DEPLOYMENT_PROFILES.length,
          'deployment profiles',
        ),
      }),
      runtimes: normalizeRuntimes(spec.runtimes),
      resources: Object.freeze({
        memory: Object.freeze({
          recommended: normalizeResourceQuantity(
            memory.recommended,
            'recommended memory',
          ),
        }),
        disk: Object.freeze({
          install: normalizeResourceQuantity(disk.install, 'install disk'),
          working: normalizeResourceQuantity(disk.working, 'working disk'),
        }),
      }),
      permissions: Object.freeze({
        network: Object.freeze({
          allowedHosts: normalizeHosts(network.allowedHosts),
        }),
        secrets: normalizeSecrets(permissions.secrets),
        tools: uniqueSortedAllowed(
          permissions.tools,
          PLUGIN_PACKAGE_TOOL_PERMISSIONS,
          MAX_PLUGIN_PACKAGE_TOOL_PERMISSIONS,
          'tool permissions',
          true,
        ),
      }),
      contents: normalizeContents(spec.contents),
    }),
  });

  if (
    Buffer.byteLength(JSON.stringify(normalized), 'utf8') >
    MAX_PLUGIN_PACKAGE_MANIFEST_BYTES
  ) {
    throw new InvalidPluginPackageManifestError(
      'canonical manifest byte budget exceeded',
    );
  }
  return normalized;
}

export function normalizePluginPackageInstallEnvironment(
  value: PluginPackageInstallEnvironment,
): Readonly<PluginPackageInstallEnvironment> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidPluginPackageInstallEnvironmentError(
      'environment must be an object',
    );
  }
  const raw = value as unknown as Record<string, unknown>;
  const expected = [
    'architecture',
    'availableDiskBytes',
    'availableMemoryBytes',
    'deploymentProfile',
    'qinglongVersion',
    'runtimes',
  ];
  const actual = Object.keys(raw).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new InvalidPluginPackageInstallEnvironmentError(
      'environment shape is invalid',
    );
  }
  if (
    typeof value.qinglongVersion !== 'string' ||
    semver().valid(value.qinglongVersion) !== value.qinglongVersion ||
    !PLUGIN_PACKAGE_ARCHITECTURES.includes(value.architecture) ||
    !PLUGIN_PACKAGE_DEPLOYMENT_PROFILES.includes(value.deploymentProfile) ||
    !Number.isSafeInteger(value.availableMemoryBytes) ||
    value.availableMemoryBytes < 0 ||
    !Number.isSafeInteger(value.availableDiskBytes) ||
    value.availableDiskBytes < 0 ||
    !Array.isArray(value.runtimes) ||
    value.runtimes.length > MAX_PLUGIN_PACKAGE_RUNTIMES
  ) {
    throw new InvalidPluginPackageInstallEnvironmentError(
      'environment value is invalid',
    );
  }
  const names = new Set<string>();
  const runtimes = value.runtimes.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new InvalidPluginPackageInstallEnvironmentError(
        'runtime is invalid',
      );
    }
    const runtime = item as unknown as Record<string, unknown>;
    if (
      Object.keys(runtime).sort().join(',') !== 'name,version' ||
      typeof item.name !== 'string' ||
      !RUNTIME_NAME_PATTERN.test(item.name) ||
      names.has(item.name) ||
      typeof item.version !== 'string' ||
      semver().valid(item.version) !== item.version
    ) {
      throw new InvalidPluginPackageInstallEnvironmentError(
        'runtime is invalid or duplicated',
      );
    }
    names.add(item.name);
    return Object.freeze({ name: item.name, version: item.version });
  });
  runtimes.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({
    qinglongVersion: value.qinglongVersion,
    architecture: value.architecture,
    deploymentProfile: value.deploymentProfile,
    runtimes: Object.freeze(runtimes),
    availableMemoryBytes: value.availableMemoryBytes,
    availableDiskBytes: value.availableDiskBytes,
  });
}

function permissionSet(
  manifest: Readonly<PluginPackageManifest>,
): ReadonlySet<string> {
  const permissions = new Set<string>();
  for (const host of manifest.spec.permissions.network.allowedHosts) {
    permissions.add(`network:${host}`);
  }
  for (const secret of manifest.spec.permissions.secrets) {
    permissions.add(
      `secret:${secret.name}:${secret.required ? 'required' : 'optional'}`,
    );
  }
  for (const permission of manifest.spec.permissions.tools) {
    permissions.add(`tool:${permission}`);
  }
  return permissions;
}

function packageRisk(
  manifest: Readonly<PluginPackageManifest>,
): PluginPackageRisk {
  const tools = new Set(manifest.spec.permissions.tools);
  if (
    tools.has('background.service') ||
    tools.has('dependency.install') ||
    tools.has('system.command')
  ) {
    return 'high';
  }
  if (
    manifest.spec.permissions.network.allowedHosts.length > 0 ||
    manifest.spec.permissions.secrets.length > 0 ||
    tools.has('filesystem.write') ||
    tools.has('model.invoke') ||
    tools.has('mcp.tool.call') ||
    tools.has('run.start') ||
    tools.has('run.stop') ||
    tools.has('run.retry') ||
    tools.has('task.update')
  ) {
    return 'medium';
  }
  return 'low';
}

export function planPluginPackageInstall(
  manifestValue: unknown,
  environmentValue: PluginPackageInstallEnvironment,
  previousManifestValue?: unknown,
): Readonly<PluginPackageInstallPlan> {
  const manifest = normalizePluginPackageManifest(manifestValue);
  const environment =
    normalizePluginPackageInstallEnvironment(environmentValue);
  const previous =
    previousManifestValue === undefined
      ? undefined
      : normalizePluginPackageManifest(previousManifestValue);
  if (previous && previous.metadata.name !== manifest.metadata.name) {
    throw new InvalidPluginPackageManifestError(
      'previous and candidate package names differ',
    );
  }

  const findings: PluginPackagePlanFinding[] = [];
  const addFinding = (
    code: PluginPackagePlanFinding['code'],
    severity: PluginPackageFindingSeverity,
    subject: string,
  ): void => {
    findings.push(Object.freeze({ code, severity, subject }));
  };

  if (
    !semver().satisfies(
      environment.qinglongVersion,
      manifest.spec.compatibility.qinglong,
      { includePrerelease: true },
    )
  ) {
    addFinding(
      'qinglong_version_unsupported',
      'error',
      environment.qinglongVersion,
    );
  }
  if (
    !manifest.spec.compatibility.architectures.includes(
      environment.architecture,
    )
  ) {
    addFinding('architecture_unsupported', 'error', environment.architecture);
  }
  if (
    !manifest.spec.compatibility.deploymentProfiles.includes(
      environment.deploymentProfile,
    )
  ) {
    addFinding(
      'deployment_profile_unsupported',
      'error',
      environment.deploymentProfile,
    );
  }

  const availableRuntimes = new Map(
    environment.runtimes.map((runtime) => [runtime.name, runtime.version]),
  );
  for (const requirement of manifest.spec.runtimes) {
    const actual = availableRuntimes.get(requirement.name);
    if (!actual) {
      addFinding('runtime_missing', 'error', requirement.name);
    } else if (
      !semver().satisfies(actual, requirement.version, {
        includePrerelease: true,
      })
    ) {
      addFinding(
        'runtime_version_unsupported',
        'error',
        `${requirement.name}@${actual}`,
      );
    }
  }

  const memoryRecommendedBytes = resourceBytes(
    manifest.spec.resources.memory.recommended,
    'recommended memory',
  );
  const diskInstallBytes = resourceBytes(
    manifest.spec.resources.disk.install,
    'install disk',
  );
  const diskWorkingBytes = resourceBytes(
    manifest.spec.resources.disk.working,
    'working disk',
  );
  if (environment.availableMemoryBytes < memoryRecommendedBytes) {
    addFinding(
      'memory_below_recommendation',
      'warning',
      String(environment.availableMemoryBytes),
    );
  }
  if (environment.availableDiskBytes < diskInstallBytes + diskWorkingBytes) {
    addFinding(
      'disk_insufficient',
      'error',
      String(environment.availableDiskBytes),
    );
  }

  const candidatePermissions = permissionSet(manifest);
  const previousPermissions = previous
    ? permissionSet(previous)
    : new Set<string>();
  const added = [...candidatePermissions]
    .filter((permission) => !previousPermissions.has(permission))
    .sort();
  const removed = [...previousPermissions]
    .filter((permission) => !candidatePermissions.has(permission))
    .sort();

  let operation: PluginPackagePlanOperation = 'install';
  if (previous) {
    const comparison = semver().compare(
      manifest.metadata.version,
      previous.metadata.version,
    );
    operation =
      comparison > 0 ? 'upgrade' : comparison < 0 ? 'rollback' : 'reinstall';
  }
  findings.sort(
    (left, right) =>
      left.severity.localeCompare(right.severity) ||
      left.code.localeCompare(right.code) ||
      left.subject.localeCompare(right.subject),
  );

  return Object.freeze({
    package: Object.freeze({
      name: manifest.metadata.name,
      ...(previous ? { fromVersion: previous.metadata.version } : {}),
      toVersion: manifest.metadata.version,
    }),
    operation,
    compatible: findings.every((finding) => finding.severity !== 'error'),
    risk: packageRisk(manifest),
    approvalRequired: true,
    permissionReapprovalRequired: previous ? added.length > 0 : true,
    permissionDelta: Object.freeze({
      added: Object.freeze(added),
      removed: Object.freeze(removed),
    }),
    resources: Object.freeze({
      memoryRecommendedBytes,
      diskInstallBytes,
      diskWorkingBytes,
    }),
    contents: Object.freeze({
      tasks: manifest.spec.contents.tasks.length,
      workflows: manifest.spec.contents.workflows.length,
      prompts: manifest.spec.contents.prompts.length,
      tools: manifest.spec.contents.tools.length,
    }),
    findings: Object.freeze(findings),
  });
}
