// Cluster Plugin Package recovery boundary; keep process composition explicit.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import type {
  OpenPostgresDatabase,
  PostgresPool,
} from '@qinglong/runtime-core';
import { MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE } from '@qinglong/runtime-core/plugin-package-install';
import {
  PluginPackagePublisherTrustRegistry,
  type PluginPackagePublisherKeyDefinition,
} from '@qinglong/runtime-core/plugin-package-bundle';
import {
  createPluginPackagePublisherTrustSnapshot,
  createPluginPackagePublisherEffectiveTrustRegistry,
  type PluginPackagePublisherTrustSnapshot,
} from '@qinglong/runtime-core/plugin-package-publisher-trust';
import {
  MAX_PLUGIN_PACKAGE_RECOVERY_PAGES,
  type PluginPackageRecoveryCycleResult,
} from '@qinglong/runtime-core/plugin-package-recovery';
import type { PluginPackageAutomationPublicationRecoveryCycleResult } from '@qinglong/runtime-core/plugin-package-automation-publication';
import type { PluginPackageResourceByteSource } from '@qinglong/runtime-core/plugin-package-resource-materialization';
import type { PluginPackageTaskPublicationRecoveryCycleResult } from '@qinglong/runtime-core/plugin-package-task-publication';
import type { ProjectToolDefinitionSnapshotRecoveryCycleResult } from '@qinglong/runtime-core/project-tool-definition-snapshot';
import {
  createPostgresDatabaseOpener,
  isPostgresTlsDnsServername,
  loadPostgresCertificateAuthorityFile,
  loadPostgresConnectionEnvironment,
  PostgresPluginPackagePublisherTrustAuthorityRepository,
  type PostgresConnectionOptions,
  type PostgresPoolOptions,
} from '@qinglong/cluster-postgres/package-executor';

import {
  recoverClusterPluginPackages,
  type ClusterPluginPackageRecoveryResult,
} from './pluginPackageRecovery';
import type { ClusterPluginPackagePublisherProvenanceRecoveryResult } from '../publisher/pluginPackagePublisherProvenanceRecovery';
import {
  ClusterPluginPackageOciStageAuthority,
  type ClusterPluginPackageOciFetch,
  type ClusterPluginPackageRegistryCredentialProvider,
  type ClusterPluginPackageStageAuthority,
} from './pluginPackageOciStage';
import type { PluginPackageKubernetesConfigMapApi } from './pluginPackageKubernetesActivation';

export type ClusterPluginPackageRecoveryProcessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface ClusterPluginPackageRecoveryProcessConfig {
  readonly clusterIdentity: string;
  readonly namespace: string;
  readonly allowedRegistries: readonly string[];
  readonly publisherTrustFile: string;
  readonly publisherTrustAuthorityId: string;
  readonly registryCredentialFile?: string;
  readonly requestTimeoutMs: number;
  readonly pageSize: number;
  readonly maxPages: number;
  readonly database: Readonly<{
    connection: PostgresConnectionOptions;
    pool: PostgresPoolOptions;
  }>;
}

export interface ClusterPluginPackageRecoveryProcessEvent {
  readonly schemaVersion: 1;
  readonly component: 'qinglong3-plugin-package-recovery';
  readonly event: 'recovery_started' | 'recovery_completed';
  readonly clusterIdentity: string;
  readonly provenanceRecovery?: Readonly<ClusterPluginPackagePublisherProvenanceRecoveryResult>;
  readonly recovery?: Readonly<PluginPackageRecoveryCycleResult>;
  readonly taskPublicationRecovery?: Readonly<PluginPackageTaskPublicationRecoveryCycleResult>;
  readonly automationPublicationRecovery?: Readonly<PluginPackageAutomationPublicationRecoveryCycleResult>;
  readonly toolSnapshotRecovery?: Readonly<ProjectToolDefinitionSnapshotRecoveryCycleResult>;
}

export interface RunClusterPluginPackageRecoveryProcessOptions {
  readonly environment: ClusterPluginPackageRecoveryProcessEnvironment;
  readonly emit?: (
    event: ClusterPluginPackageRecoveryProcessEvent,
  ) => void | Promise<void>;
  readonly openDatabase?: OpenPostgresDatabase;
  readonly api?: PluginPackageKubernetesConfigMapApi;
  readonly stageAuthority?: ClusterPluginPackageStageAuthority;
  readonly resourceByteSource?: PluginPackageResourceByteSource;
  readonly trust?: PluginPackagePublisherTrustRegistry;
  readonly fetch?: ClusterPluginPackageOciFetch;
}

export interface ClusterPluginPackageRegistryCredentialFile
  extends ClusterPluginPackageRegistryCredentialProvider {
  dispose(): void;
}

export interface ClusterPluginPackagePublisherTrustFileEvidence {
  readonly registry: PluginPackagePublisherTrustRegistry;
  readonly snapshot: Readonly<PluginPackagePublisherTrustSnapshot>;
  readonly definitions: readonly Readonly<PluginPackagePublisherKeyDefinition>[];
}

export class ClusterPluginPackageRecoveryProcessConfigError extends TypeError {
  readonly code = 'QL3_PLUGIN_PACKAGE_RECOVERY_PROCESS_CONFIG_INVALID';

  constructor(message: string) {
    super(
      `Plugin Package recovery process configuration is invalid: ${message}`,
    );
    this.name = 'ClusterPluginPackageRecoveryProcessConfigError';
  }
}

const TRUST_SCHEMA = 'qinglong/plugin-package-publisher-trust@v1';
const REGISTRY_CREDENTIAL_SCHEMA =
  'qinglong/plugin-package-registry-credentials@v1';
const MAX_TRUST_FILE_BYTES = 256 * 1024;
const MAX_REGISTRY_CREDENTIAL_FILE_BYTES = 256 * 1024;
const MAX_REGISTRY_CREDENTIALS = 32;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const REGISTRY =
  /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::([1-9][0-9]{0,4}))?$/;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+={0,2}$/;

class LoadedClusterPluginPackageRegistryCredentialFile
  implements ClusterPluginPackageRegistryCredentialFile
{
  readonly #authorizations: Map<string, Buffer>;

  constructor(authorizations: Map<string, Buffer>) {
    this.#authorizations = authorizations;
  }

  authorizationFor(registry: string): string | undefined {
    if (typeof registry !== 'string' || !REGISTRY.test(registry)) {
      return undefined;
    }
    return this.#authorizations.get(registry)?.toString('ascii');
  }

  dispose(): void {
    for (const authorization of this.#authorizations.values()) {
      authorization.fill(0);
    }
    this.#authorizations.clear();
  }
}

function boundedValue(
  environment: ClusterPluginPackageRecoveryProcessEnvironment,
  name: string,
  maximumLength: number,
  required = false,
): string | undefined {
  const value = environment[name];
  if (value === undefined || value === '') {
    if (required) {
      throw new ClusterPluginPackageRecoveryProcessConfigError(
        `${name} is required`,
      );
    }
    return undefined;
  }
  if (value.length > maximumLength || /[\0\r\n]/.test(value)) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      `${name} is invalid`,
    );
  }
  return value;
}

function booleanValue(
  environment: ClusterPluginPackageRecoveryProcessEnvironment,
  name: string,
): boolean {
  const value = environment[name];
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ClusterPluginPackageRecoveryProcessConfigError(
    `${name} must be true or false`,
  );
}

function integerValue(
  environment: ClusterPluginPackageRecoveryProcessEnvironment,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = environment[name];
  if (value === undefined || value === '') return defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      `${name} must be an integer`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function loadConnection(
  environment: ClusterPluginPackageRecoveryProcessEnvironment,
): Readonly<{
  connection: PostgresConnectionOptions;
  pool: PostgresPoolOptions;
}> {
  let connection: PostgresConnectionOptions;
  try {
    connection = loadPostgresConnectionEnvironment(environment, {
      connectionString: 'QL3_POSTGRES_PACKAGE_EXECUTOR_URL',
      host: 'QL3_POSTGRES_PACKAGE_EXECUTOR_HOST',
      port: 'QL3_POSTGRES_PACKAGE_EXECUTOR_PORT',
      database: 'QL3_POSTGRES_PACKAGE_EXECUTOR_DATABASE',
      user: 'QL3_POSTGRES_PACKAGE_EXECUTOR_USER',
      password: 'QL3_POSTGRES_PACKAGE_EXECUTOR_PASSWORD',
    });
  } catch (error) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      error instanceof Error
        ? error.message
        : 'PostgreSQL Package executor connection is invalid',
    );
  }
  const mode = environment.QL3_POSTGRES_TLS_MODE ?? 'verify-full';
  if (mode !== 'verify-full' && mode !== 'disable') {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'QL3_POSTGRES_TLS_MODE must be verify-full or disable',
    );
  }
  if (
    mode === 'disable' &&
    !booleanValue(environment, 'QL3_POSTGRES_ALLOW_INSECURE')
  ) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'disabling PostgreSQL TLS requires QL3_POSTGRES_ALLOW_INSECURE=true',
    );
  }
  const servername = boundedValue(
    environment,
    'QL3_POSTGRES_TLS_SERVERNAME',
    253,
  );
  if (mode === 'verify-full' && !isPostgresTlsDnsServername(servername)) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'QL3_POSTGRES_TLS_SERVERNAME must be an explicit DNS name for verify-full',
    );
  }
  const certificateAuthorityFile = boundedValue(
    environment,
    'QL3_POSTGRES_TLS_CA_FILE',
    4096,
  );
  if (mode === 'disable' && certificateAuthorityFile !== undefined) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'QL3_POSTGRES_TLS_CA_FILE cannot be used when TLS is disabled',
    );
  }
  let certificateAuthority: string | undefined;
  if (certificateAuthorityFile !== undefined) {
    try {
      certificateAuthority = loadPostgresCertificateAuthorityFile(
        certificateAuthorityFile,
      );
    } catch {
      throw new ClusterPluginPackageRecoveryProcessConfigError(
        'QL3_POSTGRES_TLS_CA_FILE must contain a bounded trusted CA bundle',
      );
    }
  }
  const applicationName =
    boundedValue(environment, 'QL3_POSTGRES_APPLICATION_NAME', 63) ??
    'qinglong3-plugin-package-recovery';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$/.test(applicationName)) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'QL3_POSTGRES_APPLICATION_NAME is invalid',
    );
  }
  return Object.freeze({
    connection: Object.freeze({
      ...connection,
      tls:
        mode === 'disable'
          ? Object.freeze({ mode: 'disable' as const })
          : Object.freeze({
              mode: 'verify-full' as const,
              ...(certificateAuthority === undefined
                ? {}
                : { ca: certificateAuthority }),
              servername: servername!,
            }),
    }),
    pool: Object.freeze({
      applicationName,
      maxConnections: 1,
      connectionTimeoutMs: 15_000,
    }),
  });
}

export function loadClusterPluginPackageRecoveryProcessConfig(
  environment: ClusterPluginPackageRecoveryProcessEnvironment,
): Readonly<ClusterPluginPackageRecoveryProcessConfig> {
  if (
    !environment ||
    typeof environment !== 'object' ||
    Array.isArray(environment)
  ) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'environment must be an object',
    );
  }
  const clusterIdentity = boundedValue(
    environment,
    'QL3_CLUSTER_IDENTITY',
    256,
    true,
  )!;
  const namespace = boundedValue(
    environment,
    'QL3_KUBERNETES_NAMESPACE',
    63,
    true,
  )!;
  const registryValue = boundedValue(
    environment,
    'QL3_PLUGIN_PACKAGE_OCI_REGISTRIES',
    4096,
    true,
  )!;
  const allowedRegistries = registryValue.split(',');
  const publisherTrustFile = boundedValue(
    environment,
    'QL3_PLUGIN_PACKAGE_PUBLISHER_TRUST_FILE',
    4096,
    true,
  )!;
  const registryCredentialFile = boundedValue(
    environment,
    'QL3_PLUGIN_PACKAGE_REGISTRY_CREDENTIAL_FILE',
    4096,
  );
  if (
    !SAFE_IDENTITY.test(clusterIdentity) ||
    !DNS_LABEL.test(namespace) ||
    allowedRegistries.length < 1 ||
    allowedRegistries.length > 32 ||
    allowedRegistries.some((registry) => !REGISTRY.test(registry)) ||
    new Set(allowedRegistries).size !== allowedRegistries.length ||
    !isAbsolute(publisherTrustFile) ||
    (registryCredentialFile !== undefined &&
      !isAbsolute(registryCredentialFile))
  ) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'cluster, namespace, registry or publisher trust binding is invalid',
    );
  }
  return Object.freeze({
    clusterIdentity,
    namespace,
    allowedRegistries: Object.freeze(allowedRegistries),
    publisherTrustFile,
    publisherTrustAuthorityId:
      boundedValue(
        environment,
        'QL3_PLUGIN_PACKAGE_TRUST_AUTHORITY_ID',
        128,
      ) ?? 'cluster',
    ...(registryCredentialFile === undefined ? {} : { registryCredentialFile }),
    requestTimeoutMs: integerValue(
      environment,
      'QL3_PLUGIN_PACKAGE_OCI_TIMEOUT_MS',
      15_000,
      1_000,
      60_000,
    ),
    pageSize: integerValue(
      environment,
      'QL3_PLUGIN_PACKAGE_RECOVERY_PAGE_SIZE',
      16,
      1,
      MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE,
    ),
    maxPages: integerValue(
      environment,
      'QL3_PLUGIN_PACKAGE_RECOVERY_MAX_PAGES',
      16,
      1,
      MAX_PLUGIN_PACKAGE_RECOVERY_PAGES,
    ),
    database: loadConnection(environment),
  });
}

function readClusterPluginPackageRegistryCredentialFile(
  filePath: string,
): Buffer {
  if (
    typeof filePath !== 'string' ||
    filePath.length < 1 ||
    filePath.length > 4096 ||
    /[\0\r\n]/.test(filePath) ||
    !isAbsolute(filePath)
  ) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'registry credential file path is invalid',
    );
  }
  let descriptor: number;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY);
  } catch {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'registry credential file is unavailable',
    );
  }
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      (stat.mode & 0o027) !== 0 ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 1 ||
      stat.size > MAX_REGISTRY_CREDENTIAL_FILE_BYTES
    ) {
      throw new ClusterPluginPackageRecoveryProcessConfigError(
        'registry credential file is not a bounded private regular file',
      );
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) {
      bytes.fill(0);
      throw new ClusterPluginPackageRecoveryProcessConfigError(
        'registry credential file changed while reading',
      );
    }
    return bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

function credentialRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      `${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function scrubCredentialSource(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const credentials = (value as { credentials?: unknown }).credentials;
  if (!Array.isArray(credentials)) return;
  for (const candidate of credentials) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record.password === 'string') record.password = '';
    if (typeof record.token === 'string') record.token = '';
  }
}

function zeroAuthorizations(authorizations: Map<string, Buffer>): void {
  for (const authorization of authorizations.values()) {
    authorization.fill(0);
  }
  authorizations.clear();
}

export function loadClusterPluginPackageRegistryCredentialFile(
  filePath: string,
  allowedRegistries: readonly string[],
): ClusterPluginPackageRegistryCredentialFile {
  if (
    !Array.isArray(allowedRegistries) ||
    allowedRegistries.length < 1 ||
    allowedRegistries.length > MAX_REGISTRY_CREDENTIALS ||
    allowedRegistries.some(
      (registry) => typeof registry !== 'string' || !REGISTRY.test(registry),
    ) ||
    new Set(allowedRegistries).size !== allowedRegistries.length
  ) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'registry credential allowlist is invalid',
    );
  }
  const bytes = readClusterPluginPackageRegistryCredentialFile(filePath);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'registry credential file is not valid JSON',
    );
  } finally {
    bytes.fill(0);
  }
  const authorizations = new Map<string, Buffer>();
  try {
    const root = credentialRecord(value, 'registry credential file');
    if (
      Object.keys(root).sort().join(',') !== 'credentials,schema' ||
      root.schema !== REGISTRY_CREDENTIAL_SCHEMA ||
      !Array.isArray(root.credentials) ||
      root.credentials.length < 1 ||
      root.credentials.length > MAX_REGISTRY_CREDENTIALS
    ) {
      throw new ClusterPluginPackageRecoveryProcessConfigError(
        'registry credential file shape is invalid',
      );
    }
    const allowed = new Set(allowedRegistries);
    for (const [index, candidate] of root.credentials.entries()) {
      const entry = credentialRecord(candidate, `registry credential ${index}`);
      const registry = entry.registry;
      const scheme = entry.scheme;
      if (
        typeof registry !== 'string' ||
        !REGISTRY.test(registry) ||
        !allowed.has(registry) ||
        authorizations.has(registry)
      ) {
        throw new ClusterPluginPackageRecoveryProcessConfigError(
          `registry credential ${index} binding is invalid`,
        );
      }
      let authorization: Buffer;
      if (scheme === 'basic') {
        if (
          Object.keys(entry).sort().join(',') !==
            'password,registry,scheme,username' ||
          typeof entry.username !== 'string' ||
          Buffer.byteLength(entry.username, 'utf8') < 1 ||
          Buffer.byteLength(entry.username, 'utf8') > 256 ||
          /[\0-\x1f\x7f:]/.test(entry.username) ||
          typeof entry.password !== 'string' ||
          Buffer.byteLength(entry.password, 'utf8') < 1 ||
          Buffer.byteLength(entry.password, 'utf8') > 4096 ||
          /[\0-\x1f\x7f]/.test(entry.password)
        ) {
          throw new ClusterPluginPackageRecoveryProcessConfigError(
            `registry credential ${index} basic value is invalid`,
          );
        }
        const userPassword = Buffer.from(
          `${entry.username}:${entry.password}`,
          'utf8',
        );
        try {
          authorization = Buffer.from(
            `Basic ${userPassword.toString('base64')}`,
            'ascii',
          );
        } finally {
          userPassword.fill(0);
        }
      } else if (scheme === 'bearer') {
        if (
          Object.keys(entry).sort().join(',') !== 'registry,scheme,token' ||
          typeof entry.token !== 'string' ||
          entry.token.length < 1 ||
          entry.token.length > 8192 ||
          !BEARER_TOKEN.test(entry.token)
        ) {
          throw new ClusterPluginPackageRecoveryProcessConfigError(
            `registry credential ${index} bearer value is invalid`,
          );
        }
        authorization = Buffer.from(`Bearer ${entry.token}`, 'ascii');
      } else {
        throw new ClusterPluginPackageRecoveryProcessConfigError(
          `registry credential ${index} scheme is invalid`,
        );
      }
      authorizations.set(registry, authorization);
    }
    return new LoadedClusterPluginPackageRegistryCredentialFile(authorizations);
  } catch (error) {
    zeroAuthorizations(authorizations);
    throw error;
  } finally {
    scrubCredentialSource(value);
  }
}

export function loadClusterPluginPackagePublisherTrustFileEvidence(
  filePath: string,
): Readonly<ClusterPluginPackagePublisherTrustFileEvidence> {
  if (
    typeof filePath !== 'string' ||
    filePath.length < 1 ||
    filePath.length > 4096 ||
    /[\0\r\n]/.test(filePath) ||
    !isAbsolute(filePath)
  ) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'publisher trust file path is invalid',
    );
  }
  let descriptor: number;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY);
  } catch {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'publisher trust file is unavailable',
    );
  }
  let bytes: Buffer;
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      (stat.mode & 0o022) !== 0 ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 1 ||
      stat.size > MAX_TRUST_FILE_BYTES
    ) {
      throw new ClusterPluginPackageRecoveryProcessConfigError(
        'publisher trust file is not a bounded read-only regular file',
      );
    }
    bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) {
      throw new ClusterPluginPackageRecoveryProcessConfigError(
        'publisher trust file changed while reading',
      );
    }
    bytes = bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'publisher trust file is not valid JSON',
    );
  } finally {
    bytes.fill(0);
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'keys,schema' ||
    (value as { schema?: unknown }).schema !== TRUST_SCHEMA ||
    !Array.isArray((value as { keys?: unknown }).keys)
  ) {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'publisher trust file shape is invalid',
    );
  }
  try {
    const definitions = (
      value as { keys: PluginPackagePublisherKeyDefinition[] }
    ).keys;
    const frozenDefinitions = Object.freeze(
      definitions.map((definition) => Object.freeze({ ...definition })),
    );
    return Object.freeze({
      registry: new PluginPackagePublisherTrustRegistry(frozenDefinitions),
      snapshot:
        createPluginPackagePublisherTrustSnapshot(frozenDefinitions),
      definitions: frozenDefinitions,
    });
  } catch {
    throw new ClusterPluginPackageRecoveryProcessConfigError(
      'publisher trust keys are invalid',
    );
  }
}

export function loadClusterPluginPackagePublisherTrustFile(
  filePath: string,
): PluginPackagePublisherTrustRegistry {
  return loadClusterPluginPackagePublisherTrustFileEvidence(filePath).registry;
}

async function productionKubernetesApi(): Promise<PluginPackageKubernetesConfigMapApi> {
  const kubernetes = await import('@kubernetes/client-node');
  const config = new kubernetes.KubeConfig();
  config.loadFromCluster();
  return config.makeApiClient(
    kubernetes.CoreV1Api,
  ) as unknown as PluginPackageKubernetesConfigMapApi;
}

function processEvent(
  config: Readonly<ClusterPluginPackageRecoveryProcessConfig>,
  event: ClusterPluginPackageRecoveryProcessEvent['event'],
  provenanceRecovery?: Readonly<ClusterPluginPackagePublisherProvenanceRecoveryResult>,
  recovery?: Readonly<PluginPackageRecoveryCycleResult>,
  taskPublicationRecovery?: Readonly<PluginPackageTaskPublicationRecoveryCycleResult>,
  automationPublicationRecovery?: Readonly<PluginPackageAutomationPublicationRecoveryCycleResult>,
  toolSnapshotRecovery?: Readonly<ProjectToolDefinitionSnapshotRecoveryCycleResult>,
): Readonly<ClusterPluginPackageRecoveryProcessEvent> {
  return Object.freeze({
    schemaVersion: 1,
    component: 'qinglong3-plugin-package-recovery',
    event,
    clusterIdentity: config.clusterIdentity,
    ...(provenanceRecovery === undefined ? {} : { provenanceRecovery }),
    ...(recovery === undefined ? {} : { recovery }),
    ...(taskPublicationRecovery === undefined
      ? {}
      : { taskPublicationRecovery }),
    ...(automationPublicationRecovery === undefined
      ? {}
      : { automationPublicationRecovery }),
    ...(toolSnapshotRecovery === undefined ? {} : { toolSnapshotRecovery }),
  });
}

async function emit(
  sink: RunClusterPluginPackageRecoveryProcessOptions['emit'],
  value: Readonly<ClusterPluginPackageRecoveryProcessEvent>,
): Promise<void> {
  if (!sink) return;
  try {
    await sink(value);
  } catch {
    // Diagnostics cannot replace recovery or database close outcomes.
  }
}

/** Runs exactly one admin recovery cycle and owns no resident authority. */
export async function runClusterPluginPackageRecoveryProcess(
  options: RunClusterPluginPackageRecoveryProcessOptions,
): Promise<Readonly<ClusterPluginPackageRecoveryResult>> {
  if (
    !options ||
    typeof options !== 'object' ||
    (options.emit !== undefined && typeof options.emit !== 'function') ||
    (options.openDatabase !== undefined &&
      typeof options.openDatabase !== 'function') ||
    (options.resourceByteSource !== undefined &&
      (!options.resourceByteSource ||
        typeof options.resourceByteSource.open !== 'function')) ||
    (options.fetch !== undefined && typeof options.fetch !== 'function')
  ) {
    throw new TypeError('Plugin Package recovery process options are invalid');
  }
  const config = loadClusterPluginPackageRecoveryProcessConfig(
    options.environment,
  );
  const trustEvidence =
    options.trust === undefined && options.stageAuthority === undefined
      ? loadClusterPluginPackagePublisherTrustFileEvidence(
          config.publisherTrustFile,
        )
      : undefined;
  const registryCredentials =
    options.stageAuthority !== undefined ||
    config.registryCredentialFile === undefined
      ? undefined
      : loadClusterPluginPackageRegistryCredentialFile(
          config.registryCredentialFile,
          config.allowedRegistries,
        );
  try {
    const api = options.api ?? (await productionKubernetesApi());
    const openDatabase =
      options.openDatabase ??
      createPostgresDatabaseOpener({
        role: 'package-executor',
        connection: config.database.connection,
        pool: config.database.pool,
        onPoolError() {
          // Awaited recovery queries and final close remain authoritative.
        },
      });
    await emit(options.emit, processEvent(config, 'recovery_started'));
    const result = await recoverClusterPluginPackages({
      openDatabase,
      api,
      ...(options.stageAuthority === undefined
        ? {
            stageAuthorityFactory: async (pool: PostgresPool) => {
              let effectiveTrust = options.trust;
              if (effectiveTrust === undefined && trustEvidence !== undefined) {
                const authority =
                  await new PostgresPluginPackagePublisherTrustAuthorityRepository(
                    pool,
                  ).findAuthority(config.publisherTrustAuthorityId);
                if (!authority) {
                  throw new ClusterPluginPackageRecoveryProcessConfigError(
                    'durable publisher trust authority is unavailable',
                  );
                }
                effectiveTrust =
                  createPluginPackagePublisherEffectiveTrustRegistry(
                    trustEvidence.definitions,
                    authority.effectiveSnapshot,
                  );
              }
              if (effectiveTrust === undefined) {
                throw new ClusterPluginPackageRecoveryProcessConfigError(
                  'publisher trust evidence is unavailable',
                );
              }
              return new ClusterPluginPackageOciStageAuthority({
                allowedRegistries: config.allowedRegistries,
                trust: effectiveTrust,
                ...(registryCredentials === undefined
                  ? {}
                  : { credentialProvider: registryCredentials }),
                ...(options.fetch === undefined
                  ? {}
                  : { fetch: options.fetch }),
                requestTimeoutMs: config.requestTimeoutMs,
              });
            },
          }
        : { stageAuthority: options.stageAuthority }),
      ...(options.resourceByteSource === undefined
        ? {}
        : { resourceByteSource: options.resourceByteSource }),
      trustAuthorityId: config.publisherTrustAuthorityId,
      clusterIdentity: config.clusterIdentity,
      namespace: config.namespace,
      now: Date.now,
      pageSize: config.pageSize,
      maxPages: config.maxPages,
    });
    await emit(
      options.emit,
      processEvent(
        config,
        'recovery_completed',
        result.provenanceRecovery,
        result.recovery,
        result.taskPublicationRecovery,
        result.automationPublicationRecovery,
        result.toolSnapshotRecovery,
      ),
    );
    return result;
  } finally {
    registryCredentials?.dispose();
  }
}
