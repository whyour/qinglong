import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import { assertProjectPolicyProjectId } from '@qinglong/runtime-core/project-policy';

export const LOCAL_MCP_SERVER_CONFIG_SCHEMA =
  'qinglong/local-mcp-server@v2' as const;

const MAX_PATH_BYTES = 4_096;

export interface LocalMcpServerConfig {
  readonly schema: typeof LOCAL_MCP_SERVER_CONFIG_SCHEMA;
  readonly profile: 'edge' | 'standalone';
  readonly projectId: string;
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly busyTimeoutMs?: number;
}

export class LocalMcpServerConfigError extends TypeError {
  readonly code = 'LOCAL_MCP_SERVER_CONFIG_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`Local MCP server configuration is invalid: ${message}`, options);
    this.name = 'LocalMcpServerConfigError';
  }
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new LocalMcpServerConfigError('configuration must be an object');
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'artifactRoot',
    'credentialFilePath',
    'databasePath',
    'deploymentRoot',
    'ownerPepperKeyringDirectory',
    'profile',
    'projectId',
    'schema',
    ...(Object.hasOwn(record, 'busyTimeoutMs') ? ['busyTimeoutMs'] : []),
  ].sort();
  const actual = Object.keys(record).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new LocalMcpServerConfigError('configuration shape is invalid');
  }
  return record;
}

function absolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value
  ) {
    throw new LocalMcpServerConfigError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function descendant(root: string, value: string, label: string): void {
  const relative = path.relative(root, value);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new LocalMcpServerConfigError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

export function normalizeLocalMcpServerConfig(
  value: unknown,
): Readonly<LocalMcpServerConfig> {
  const record = exactRecord(value);
  if (record.schema !== LOCAL_MCP_SERVER_CONFIG_SCHEMA) {
    throw new LocalMcpServerConfigError('schema is unsupported');
  }
  if (record.profile !== 'edge' && record.profile !== 'standalone') {
    throw new LocalMcpServerConfigError('profile is invalid');
  }
  try {
    assertProjectPolicyProjectId(record.projectId as string);
  } catch (error) {
    throw new LocalMcpServerConfigError('projectId is invalid', { cause: error });
  }
  const deploymentRoot = absolutePath(
    record.deploymentRoot,
    'deploymentRoot',
  );
  const databasePath = absolutePath(record.databasePath, 'databasePath');
  const artifactRoot = absolutePath(record.artifactRoot, 'artifactRoot');
  const ownerPepperKeyringDirectory = absolutePath(
    record.ownerPepperKeyringDirectory,
    'ownerPepperKeyringDirectory',
  );
  const credentialFilePath = absolutePath(
    record.credentialFilePath,
    'credentialFilePath',
  );
  descendant(deploymentRoot, databasePath, 'databasePath');
  descendant(deploymentRoot, artifactRoot, 'artifactRoot');
  descendant(
    deploymentRoot,
    ownerPepperKeyringDirectory,
    'ownerPepperKeyringDirectory',
  );
  descendant(deploymentRoot, credentialFilePath, 'credentialFilePath');
  if (
    new Set([
      databasePath,
      artifactRoot,
      ownerPepperKeyringDirectory,
      credentialFilePath,
    ]).size !== 4
  ) {
    throw new LocalMcpServerConfigError('authority paths must be distinct');
  }
  const busyTimeoutMs = record.busyTimeoutMs;
  if (
    busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(busyTimeoutMs) ||
      (busyTimeoutMs as number) < 100 ||
      (busyTimeoutMs as number) > 30_000)
  ) {
    throw new LocalMcpServerConfigError('busyTimeoutMs is invalid');
  }
  return Object.freeze({
    schema: LOCAL_MCP_SERVER_CONFIG_SCHEMA,
    profile: record.profile,
    projectId: record.projectId as string,
    deploymentRoot,
    databasePath,
    artifactRoot,
    ownerPepperKeyringDirectory,
    credentialFilePath,
    ...(busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: busyTimeoutMs as number }),
  });
}

export function readLocalMcpServerConfig(
  configFilePath: string,
): Readonly<LocalMcpServerConfig> {
  try {
    return normalizeLocalMcpServerConfig(
      readPrivateLocalCommandFile(configFilePath),
    );
  } catch (error) {
    if (error instanceof LocalMcpServerConfigError) throw error;
    throw new LocalMcpServerConfigError('private config cannot be read', {
      cause: error,
    });
  }
}
