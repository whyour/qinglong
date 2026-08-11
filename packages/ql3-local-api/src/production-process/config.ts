import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';

export const LOCAL_API_PROCESS_CONFIG_SCHEMA =
  'qinglong/local-api-process@v1' as const;

const MAX_PATH_BYTES = 4_096;
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1'] as const);

export interface LocalApiListenerConfig {
  readonly host: (typeof LOOPBACK_HOSTS)[number];
  readonly port: number;
}

export interface LocalApiProcessConfig {
  readonly schema: typeof LOCAL_API_PROCESS_CONFIG_SCHEMA;
  readonly deploymentRoot: string;
  readonly applicationConfigFilePath: string;
  readonly ownerPepperKeyringDirectory: string;
  readonly listener: Readonly<LocalApiListenerConfig>;
}

export class LocalApiProcessConfigError extends TypeError {
  readonly code = 'QL3_LOCAL_API_PROCESS_CONFIG_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`Local API process configuration is invalid: ${message}`, options);
    this.name = 'LocalApiProcessConfigError';
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
    throw new LocalApiProcessConfigError(`${label} must be an object`);
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
    throw new LocalApiProcessConfigError(`${label} shape is invalid`);
  }
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
    throw new LocalApiProcessConfigError(
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
    throw new LocalApiProcessConfigError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

function listener(value: unknown): Readonly<LocalApiListenerConfig> {
  const candidate = record(value, 'listener');
  exactKeys(candidate, ['host', 'port'], 'listener');
  if (
    !LOOPBACK_HOSTS.includes(
      candidate.host as (typeof LOOPBACK_HOSTS)[number],
    )
  ) {
    throw new LocalApiProcessConfigError('listener host must be loopback');
  }
  if (
    !Number.isSafeInteger(candidate.port) ||
    (candidate.port as number) < 1_024 ||
    (candidate.port as number) > 65_535
  ) {
    throw new LocalApiProcessConfigError('listener port is invalid');
  }
  return Object.freeze({
    host: candidate.host as LocalApiListenerConfig['host'],
    port: candidate.port as number,
  });
}

export function normalizeLocalApiProcessConfig(
  value: unknown,
): Readonly<LocalApiProcessConfig> {
  const candidate = record(value, 'configuration');
  exactKeys(
    candidate,
    [
      'applicationConfigFilePath',
      'deploymentRoot',
      'listener',
      'ownerPepperKeyringDirectory',
      'schema',
    ],
    'configuration',
  );
  if (candidate.schema !== LOCAL_API_PROCESS_CONFIG_SCHEMA) {
    throw new LocalApiProcessConfigError('schema is unsupported');
  }
  const deploymentRoot = absolutePath(
    candidate.deploymentRoot,
    'deploymentRoot',
  );
  const applicationConfigFilePath = absolutePath(
    candidate.applicationConfigFilePath,
    'applicationConfigFilePath',
  );
  const ownerPepperKeyringDirectory = absolutePath(
    candidate.ownerPepperKeyringDirectory,
    'ownerPepperKeyringDirectory',
  );
  descendant(
    deploymentRoot,
    applicationConfigFilePath,
    'applicationConfigFilePath',
  );
  descendant(
    deploymentRoot,
    ownerPepperKeyringDirectory,
    'ownerPepperKeyringDirectory',
  );
  if (applicationConfigFilePath === ownerPepperKeyringDirectory) {
    throw new LocalApiProcessConfigError('authority paths must be distinct');
  }
  return Object.freeze({
    schema: LOCAL_API_PROCESS_CONFIG_SCHEMA,
    deploymentRoot,
    applicationConfigFilePath,
    ownerPepperKeyringDirectory,
    listener: listener(candidate.listener),
  });
}

export function readLocalApiProcessConfig(
  configFilePath: string,
): Readonly<LocalApiProcessConfig> {
  try {
    return normalizeLocalApiProcessConfig(
      readPrivateLocalCommandFile(configFilePath),
    );
  } catch (error) {
    if (error instanceof LocalApiProcessConfigError) throw error;
    throw new LocalApiProcessConfigError('private config cannot be read', {
      cause: error,
    });
  }
}
