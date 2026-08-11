import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import { MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE } from '@qinglong/runtime-core/plugin-package-install';
import {
  MAX_PLUGIN_PACKAGE_RECOVERY_PAGES,
} from '@qinglong/runtime-core/plugin-package-recovery';
import {
  MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGES,
  MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGE_SIZE,
} from '@qinglong/runtime-core/plugin-package-task-publication';

import type { LocalApplicationProfile } from '../application-runtime/contract';

export const LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA =
  'qinglong/local-application-process@v1' as const;
export const LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V2 =
  'qinglong/local-application-process@v2' as const;
export const LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V3 =
  'qinglong/local-application-process@v3' as const;

const MAX_PATH_BYTES = 4_096;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface LocalApplicationProcessAdoptedStorageConfig {
  readonly mode?: 'adopted';
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly recoveryPath: string;
  readonly manifestPath: string;
  readonly activationPath: string;
  readonly expectedActivationDigest: string;
  readonly busyTimeoutMs?: number;
}

export interface LocalApplicationProcessFreshStorageConfig {
  readonly mode: 'fresh';
  readonly databasePath: string;
  readonly busyTimeoutMs?: number;
}

export type LocalApplicationProcessStorageConfig =
  | LocalApplicationProcessAdoptedStorageConfig
  | LocalApplicationProcessFreshStorageConfig;

export interface LocalApplicationProcessRuntimeConfig {
  readonly receiptRoot: string;
  readonly artifactRoot: string;
  readonly secretKeyringPath: string;
}

export interface LocalApplicationProcessCutoverConfig {
  readonly cutoverId: string;
  readonly commitmentPath: string;
  readonly expectedCommitmentDigest: string;
}

export type LocalApplicationProcessPluginPackageRecoverySourceConfig =
  | Readonly<{ mode: 'disabled' }>
  | Readonly<{
      mode: 'materialized_catalog';
      catalogRoot: string;
      bundleRoot: string;
      publisherTrustFilePath: string;
    }>;

export interface LocalApplicationProcessPluginPackageConfig {
  readonly stagingRoot: string;
  readonly activationRoot: string;
  readonly recoverySource: LocalApplicationProcessPluginPackageRecoverySourceConfig;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly taskPublicationPageSize?: number;
  readonly taskPublicationMaxPages?: number;
}

export type LocalApplicationProcessAiConfig =
  | Readonly<{ deployment: 'excluded' }>
  | Readonly<{
      deployment: 'installed';
      maxConcurrent?: number;
      recoveryLimit?: number;
      drainTimeoutMs?: number;
      drainPollMs?: number;
    }>;

export interface LocalApplicationProcessConfig {
  readonly schema:
    | typeof LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA
    | typeof LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V2
    | typeof LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V3;
  readonly instanceId: string;
  readonly profile: LocalApplicationProfile;
  readonly storage: Readonly<LocalApplicationProcessStorageConfig>;
  readonly runtime: Readonly<LocalApplicationProcessRuntimeConfig>;
  readonly pluginPackages: Readonly<LocalApplicationProcessPluginPackageConfig>;
  readonly ai: LocalApplicationProcessAiConfig;
  readonly cutover?: Readonly<LocalApplicationProcessCutoverConfig>;
}

export class LocalApplicationProcessConfigError extends TypeError {
  readonly code = 'QL3_LOCAL_APPLICATION_PROCESS_CONFIG_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`Local application process configuration is invalid: ${message}`, options);
    this.name = 'LocalApplicationProcessConfigError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new LocalApplicationProcessConfigError(`${label} must be an object`);
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
    throw new LocalApplicationProcessConfigError(`${label} shape is invalid`);
  }
}

function absolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value
  ) {
    throw new LocalApplicationProcessConfigError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function optionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new LocalApplicationProcessConfigError(`${label} is invalid`);
  }
  return value as number;
}

function storageConfig(
  value: unknown,
  schema:
    | typeof LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA
    | typeof LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V2
    | typeof LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V3,
): Readonly<LocalApplicationProcessStorageConfig> {
  const storage = record(value, 'storage');
  if (schema !== LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA) {
    if (storage.mode === 'fresh') {
      const optionalKeys = Object.hasOwn(storage, 'busyTimeoutMs')
        ? ['busyTimeoutMs']
        : [];
      exactKeys(
        storage,
        ['databasePath', 'mode', ...optionalKeys],
        'fresh storage',
      );
      const busyTimeoutMs = optionalInteger(
        storage.busyTimeoutMs,
        100,
        30_000,
        'busyTimeoutMs',
      );
      return Object.freeze({
        mode: 'fresh' as const,
        databasePath: absolutePath(storage.databasePath, 'databasePath'),
        ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
      });
    }
    if (storage.mode !== 'adopted') {
      throw new LocalApplicationProcessConfigError(
        'storage mode must be fresh or adopted',
      );
    }
  }
  const optionalKeys = Object.hasOwn(storage, 'busyTimeoutMs')
    ? ['busyTimeoutMs']
    : [];
  exactKeys(
    storage,
    [
      'activationPath',
      'expectedActivationDigest',
      'manifestPath',
      'recoveryPath',
      'sourcePath',
      'targetPath',
      ...(schema !== LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA
        ? ['mode']
        : []),
      ...optionalKeys,
    ],
    'storage',
  );
  const expectedActivationDigest = storage.expectedActivationDigest;
  if (
    typeof expectedActivationDigest !== 'string' ||
    !DIGEST_PATTERN.test(expectedActivationDigest)
  ) {
    throw new LocalApplicationProcessConfigError(
      'expectedActivationDigest is invalid',
    );
  }
  const busyTimeoutMs = optionalInteger(
    storage.busyTimeoutMs,
    100,
    30_000,
    'busyTimeoutMs',
  );
  const result: LocalApplicationProcessStorageConfig = {
    ...(schema !== LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA
      ? { mode: 'adopted' as const }
      : {}),
    sourcePath: absolutePath(storage.sourcePath, 'sourcePath'),
    targetPath: absolutePath(storage.targetPath, 'targetPath'),
    recoveryPath: absolutePath(storage.recoveryPath, 'recoveryPath'),
    manifestPath: absolutePath(storage.manifestPath, 'manifestPath'),
    activationPath: absolutePath(storage.activationPath, 'activationPath'),
    expectedActivationDigest,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
  };
  const authorityPaths = [
    result.sourcePath,
    result.targetPath,
    result.recoveryPath,
    result.manifestPath,
    result.activationPath,
  ];
  if (new Set(authorityPaths).size !== authorityPaths.length) {
    throw new LocalApplicationProcessConfigError(
      'storage authority paths must be distinct',
    );
  }
  return Object.freeze(result);
}

function cutoverConfig(
  value: unknown,
): Readonly<LocalApplicationProcessCutoverConfig> {
  const cutover = record(value, 'cutover');
  exactKeys(
    cutover,
    ['commitmentPath', 'cutoverId', 'expectedCommitmentDigest'],
    'cutover',
  );
  if (
    typeof cutover.cutoverId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(cutover.cutoverId)
  ) {
    throw new LocalApplicationProcessConfigError('cutoverId is invalid');
  }
  if (
    typeof cutover.expectedCommitmentDigest !== 'string' ||
    !DIGEST_PATTERN.test(cutover.expectedCommitmentDigest)
  ) {
    throw new LocalApplicationProcessConfigError(
      'expectedCommitmentDigest is invalid',
    );
  }
  return Object.freeze({
    cutoverId: cutover.cutoverId,
    commitmentPath: absolutePath(cutover.commitmentPath, 'commitmentPath'),
    expectedCommitmentDigest: cutover.expectedCommitmentDigest,
  });
}

function runtimeConfig(
  value: unknown,
): Readonly<LocalApplicationProcessRuntimeConfig> {
  const runtime = record(value, 'runtime');
  exactKeys(
    runtime,
    ['artifactRoot', 'receiptRoot', 'secretKeyringPath'],
    'runtime',
  );
  const result = {
    receiptRoot: absolutePath(runtime.receiptRoot, 'receiptRoot'),
    artifactRoot: absolutePath(runtime.artifactRoot, 'artifactRoot'),
    secretKeyringPath: absolutePath(
      runtime.secretKeyringPath,
      'secretKeyringPath',
    ),
  };
  if (new Set(Object.values(result)).size !== Object.keys(result).length) {
    throw new LocalApplicationProcessConfigError(
      'runtime authority paths must be distinct',
    );
  }
  return Object.freeze(result);
}

function pluginPackageConfig(
  value: unknown,
): Readonly<LocalApplicationProcessPluginPackageConfig> {
  const pluginPackages = record(value, 'pluginPackages');
  const optionalKeys = [
    'maxPages',
    'pageSize',
    'taskPublicationMaxPages',
    'taskPublicationPageSize',
  ].filter((key) => Object.hasOwn(pluginPackages, key));
  exactKeys(
    pluginPackages,
    ['activationRoot', 'recoverySource', 'stagingRoot', ...optionalKeys],
    'pluginPackages',
  );
  const stagingRoot = absolutePath(pluginPackages.stagingRoot, 'stagingRoot');
  const activationRoot = absolutePath(
    pluginPackages.activationRoot,
    'activationRoot',
  );
  if (stagingRoot === activationRoot) {
    throw new LocalApplicationProcessConfigError(
      'Plugin Package authority roots must be distinct',
    );
  }
  const recoverySourceValue = record(
    pluginPackages.recoverySource,
    'Plugin Package recovery source',
  );
  let recoverySource: LocalApplicationProcessPluginPackageRecoverySourceConfig;
  if (recoverySourceValue.mode === 'disabled') {
    exactKeys(
      recoverySourceValue,
      ['mode'],
      'disabled Plugin Package recovery source',
    );
    recoverySource = Object.freeze({ mode: 'disabled' as const });
  } else if (recoverySourceValue.mode === 'materialized_catalog') {
    exactKeys(
      recoverySourceValue,
      ['bundleRoot', 'catalogRoot', 'mode', 'publisherTrustFilePath'],
      'materialized Plugin Package recovery source',
    );
    const catalogRoot = absolutePath(
      recoverySourceValue.catalogRoot,
      'Plugin Package catalogRoot',
    );
    const publisherTrustFilePath = absolutePath(
      recoverySourceValue.publisherTrustFilePath,
      'Plugin Package publisherTrustFilePath',
    );
    const bundleRoot = absolutePath(
      recoverySourceValue.bundleRoot,
      'Plugin Package bundleRoot',
    );
    if (
      new Set([
        stagingRoot,
        activationRoot,
        catalogRoot,
        bundleRoot,
        publisherTrustFilePath,
      ]).size !== 5
    ) {
      throw new LocalApplicationProcessConfigError(
        'Plugin Package recovery authorities must be distinct',
      );
    }
    recoverySource = Object.freeze({
      mode: 'materialized_catalog' as const,
      catalogRoot,
      bundleRoot,
      publisherTrustFilePath,
    });
  } else {
    throw new LocalApplicationProcessConfigError(
      'Plugin Package recovery source mode is invalid',
    );
  }
  const pageSize = optionalInteger(
    pluginPackages.pageSize,
    1,
    MAX_PLUGIN_PACKAGE_INSTALL_RECOVERY_PAGE_SIZE,
    'Plugin Package recovery pageSize',
  );
  const maxPages = optionalInteger(
    pluginPackages.maxPages,
    1,
    MAX_PLUGIN_PACKAGE_RECOVERY_PAGES,
    'Plugin Package recovery maxPages',
  );
  const taskPublicationPageSize = optionalInteger(
    pluginPackages.taskPublicationPageSize,
    1,
    MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGE_SIZE,
    'Plugin Package Task publication pageSize',
  );
  const taskPublicationMaxPages = optionalInteger(
    pluginPackages.taskPublicationMaxPages,
    1,
    MAX_PLUGIN_PACKAGE_TASK_PUBLICATION_RECOVERY_PAGES,
    'Plugin Package Task publication maxPages',
  );
  return Object.freeze({
    stagingRoot,
    activationRoot,
    recoverySource,
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(maxPages === undefined ? {} : { maxPages }),
    ...(taskPublicationPageSize === undefined
      ? {}
      : { taskPublicationPageSize }),
    ...(taskPublicationMaxPages === undefined
      ? {}
      : { taskPublicationMaxPages }),
  });
}

function aiConfig(value: unknown): LocalApplicationProcessAiConfig {
  const ai = record(value, 'ai');
  if (ai.deployment === 'excluded') {
    exactKeys(ai, ['deployment'], 'excluded AI deployment');
    return Object.freeze({ deployment: 'excluded' as const });
  }
  if (ai.deployment !== 'installed') {
    throw new LocalApplicationProcessConfigError(
      'AI deployment must be excluded or installed',
    );
  }
  const optionalKeys = [
    'drainPollMs',
    'drainTimeoutMs',
    'maxConcurrent',
    'recoveryLimit',
  ].filter((key) => Object.hasOwn(ai, key));
  exactKeys(ai, ['deployment', ...optionalKeys], 'installed AI deployment');
  const maxConcurrent = optionalInteger(
    ai.maxConcurrent,
    1,
    64,
    'AI maxConcurrent',
  );
  const recoveryLimit = optionalInteger(
    ai.recoveryLimit,
    1,
    128,
    'AI recoveryLimit',
  );
  const drainTimeoutMs = optionalInteger(
    ai.drainTimeoutMs,
    100,
    60_000,
    'AI drainTimeoutMs',
  );
  const drainPollMs = optionalInteger(
    ai.drainPollMs,
    10,
    1_000,
    'AI drainPollMs',
  );
  return Object.freeze({
    deployment: 'installed' as const,
    ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
    ...(recoveryLimit === undefined ? {} : { recoveryLimit }),
    ...(drainTimeoutMs === undefined ? {} : { drainTimeoutMs }),
    ...(drainPollMs === undefined ? {} : { drainPollMs }),
  });
}

export function normalizeLocalApplicationProcessConfig(
  value: unknown,
): Readonly<LocalApplicationProcessConfig> {
  const config = record(value, 'configuration');
  if (
    config.schema !== LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA &&
    config.schema !== LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V2 &&
    config.schema !== LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V3
  ) {
    throw new LocalApplicationProcessConfigError('schema is invalid');
  }
  exactKeys(
    config,
    [
      'ai',
      ...(config.schema === LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V3
        ? ['cutover']
        : []),
      'instanceId',
      'pluginPackages',
      'profile',
      'runtime',
      'schema',
      'storage',
    ],
    'configuration',
  );
  if (
    typeof config.instanceId !== 'string' ||
    !INSTANCE_ID_PATTERN.test(config.instanceId)
  ) {
    throw new LocalApplicationProcessConfigError('instanceId is invalid');
  }
  if (config.profile !== 'edge' && config.profile !== 'standalone') {
    throw new LocalApplicationProcessConfigError('profile is invalid');
  }
  if (
    config.schema === LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V3 &&
    record(config.storage, 'storage').mode !== 'adopted'
  ) {
    throw new LocalApplicationProcessConfigError(
      'v3 configuration requires adopted storage',
    );
  }
  const normalized = {
    schema: config.schema,
    instanceId: config.instanceId,
    profile: config.profile,
    storage: storageConfig(config.storage, config.schema),
    runtime: runtimeConfig(config.runtime),
    pluginPackages: pluginPackageConfig(config.pluginPackages),
    ai: aiConfig(config.ai),
    ...(config.schema === LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V3
      ? { cutover: cutoverConfig(config.cutover) }
      : {}),
  } as const;
  const authorityPaths = [
    ...(normalized.storage.mode === 'fresh'
      ? [normalized.storage.databasePath]
      : [
          normalized.storage.sourcePath,
          normalized.storage.targetPath,
          normalized.storage.recoveryPath,
          normalized.storage.manifestPath,
          normalized.storage.activationPath,
        ]),
    normalized.runtime.receiptRoot,
    normalized.runtime.artifactRoot,
    normalized.runtime.secretKeyringPath,
    normalized.pluginPackages.stagingRoot,
    normalized.pluginPackages.activationRoot,
    ...(normalized.cutover === undefined
      ? []
      : [normalized.cutover.commitmentPath]),
    ...(normalized.pluginPackages.recoverySource.mode ===
    'materialized_catalog'
      ? [
          normalized.pluginPackages.recoverySource.catalogRoot,
          normalized.pluginPackages.recoverySource.bundleRoot,
          normalized.pluginPackages.recoverySource.publisherTrustFilePath,
        ]
      : []),
  ];
  if (new Set(authorityPaths).size !== authorityPaths.length) {
    throw new LocalApplicationProcessConfigError(
      'process authority paths must be distinct',
    );
  }
  return Object.freeze(normalized);
}

export function loadLocalApplicationProcessConfig(
  configFilePath: string,
): Readonly<LocalApplicationProcessConfig> {
  return normalizeLocalApplicationProcessConfig(
    readPrivateLocalCommandFile(configFilePath),
  );
}
