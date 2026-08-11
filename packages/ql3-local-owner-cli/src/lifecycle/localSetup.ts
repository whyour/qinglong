// Local lifecycle owns first-run storage and key-material setup.
import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalCommandFile } from '@qinglong/local-command-file';
import {
  LocalOwnerPepperKeyringFileProvider,
  backupLocalOwnerPepperKey,
  provisionLocalOwnerPepperKey,
} from '@qinglong/local-owner-console/pepper-custody';
import {
  LocalSecretKeyringFileProvider,
  provisionLocalSecretKeyring,
} from '@qinglong/local-secret';
import { openLocalSqliteBootstrapDatabase } from '@qinglong/local-sqlite/bootstrap';
import { migrateLocalSqlitePath } from '@qinglong/local-sqlite/migration';

const MAX_PATH_BYTES = 4_096;

export interface LocalSetupCommand {
  readonly schemaVersion: 1;
  readonly operation: 'local.setup.prepare';
  readonly options: Readonly<{
    deploymentRoot: string;
    databasePath: string;
    profile: 'edge' | 'standalone';
    ownerPepperKeyringDirectory: string;
    ownerPepperBackupDirectory: string;
    ownerPepperKeyId: string;
    localSecretKeyringPath: string;
    busyTimeoutMs?: number;
  }>;
  readonly request: Readonly<{
    registerMutationId: string;
    activateMutationId: string;
    registeredAtMs: number;
    activatedAtMs: number;
  }>;
}

export interface LocalSetupResult {
  readonly schemaVersion: 1;
  readonly status: 'prepared' | 'existing';
  readonly profile: 'edge' | 'standalone';
  readonly storage: Readonly<{
    contractName: string;
    contractVersion: number;
    migrationCount: number;
  }>;
  readonly ownerPepper: Readonly<{
    registerStatus: 'inserted' | 'existing';
    activateStatus: 'inserted' | 'existing';
    generation: number;
  }>;
  readonly envelopeKeyring: Readonly<{
    version: 1;
    keyCount: number;
  }>;
}

export class LocalSetupConfigurationError extends TypeError {
  readonly code = 'QL3_LOCAL_SETUP_CONFIGURATION_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`Local setup configuration is invalid: ${message}`, options);
    this.name = 'LocalSetupConfigurationError';
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new LocalSetupConfigurationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new LocalSetupConfigurationError(`${label} shape is invalid`);
  }
}

function absolute(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LocalSetupConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== process.geteuid()
  ) {
    throw new LocalSetupConfigurationError(
      'real and effective POSIX users must match',
    );
  }
  return process.getuid();
}

function privateDirectory(value: unknown, label: string): string {
  const directory = absolute(value, label);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    throw new LocalSetupConfigurationError(`${label} is unavailable`, {
      cause: error,
    });
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== currentUid() ||
    (stat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(directory) !== directory
  ) {
    throw new LocalSetupConfigurationError(
      `${label} must be a canonical current-UID 0700 directory`,
    );
  }
  return directory;
}

function child(root: string, value: unknown, label: string): string {
  const candidate = absolute(value, label);
  const relative = path.relative(root, candidate);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new LocalSetupConfigurationError(
      `${label} must be a distinct child of deploymentRoot`,
    );
  }
  return candidate;
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new LocalSetupConfigurationError(`${label} is invalid`);
  }
  return value as number;
}

export function normalizeLocalSetupCommand(
  value: unknown,
): Readonly<LocalSetupCommand> {
  const command = object(value, 'command');
  exact(command, ['operation', 'options', 'request', 'schemaVersion'], 'command');
  if (
    command.schemaVersion !== 1 ||
    command.operation !== 'local.setup.prepare'
  ) {
    throw new LocalSetupConfigurationError(
      'schemaVersion or operation is invalid',
    );
  }
  const rawOptions = object(command.options, 'options');
  const optionalKeys = Object.hasOwn(rawOptions, 'busyTimeoutMs')
    ? ['busyTimeoutMs']
    : [];
  exact(
    rawOptions,
    [
      'databasePath',
      'deploymentRoot',
      'localSecretKeyringPath',
      'ownerPepperBackupDirectory',
      'ownerPepperKeyId',
      'ownerPepperKeyringDirectory',
      'profile',
      ...optionalKeys,
    ],
    'options',
  );
  const deploymentRoot = privateDirectory(
    rawOptions.deploymentRoot,
    'deploymentRoot',
  );
  const databasePath = child(
    deploymentRoot,
    rawOptions.databasePath,
    'databasePath',
  );
  const localSecretKeyringPath = child(
    deploymentRoot,
    rawOptions.localSecretKeyringPath,
    'localSecretKeyringPath',
  );
  const ownerPepperKeyringDirectory = privateDirectory(
    child(
      deploymentRoot,
      rawOptions.ownerPepperKeyringDirectory,
      'ownerPepperKeyringDirectory',
    ),
    'ownerPepperKeyringDirectory',
  );
  const ownerPepperBackupDirectory = privateDirectory(
    child(
      deploymentRoot,
      rawOptions.ownerPepperBackupDirectory,
      'ownerPepperBackupDirectory',
    ),
    'ownerPepperBackupDirectory',
  );
  if (
    new Set([
      databasePath,
      localSecretKeyringPath,
      ownerPepperKeyringDirectory,
      ownerPepperBackupDirectory,
    ]).size !== 4
  ) {
    throw new LocalSetupConfigurationError(
      'setup authority paths must be distinct',
    );
  }
  if (
    rawOptions.profile !== 'edge' &&
    rawOptions.profile !== 'standalone'
  ) {
    throw new LocalSetupConfigurationError('profile is invalid');
  }
  if (
    typeof rawOptions.ownerPepperKeyId !== 'string' ||
    rawOptions.ownerPepperKeyId.length < 1 ||
    rawOptions.ownerPepperKeyId.length > 128
  ) {
    throw new LocalSetupConfigurationError('ownerPepperKeyId is invalid');
  }
  const request = object(command.request, 'request');
  exact(
    request,
    [
      'activateMutationId',
      'activatedAtMs',
      'registerMutationId',
      'registeredAtMs',
    ],
    'request',
  );
  if (
    typeof request.registerMutationId !== 'string' ||
    typeof request.activateMutationId !== 'string'
  ) {
    throw new LocalSetupConfigurationError('mutation identity is invalid');
  }
  const registeredAtMs = safeInteger(
    request.registeredAtMs,
    0,
    Number.MAX_SAFE_INTEGER,
    'registeredAtMs',
  );
  const activatedAtMs = safeInteger(
    request.activatedAtMs,
    registeredAtMs,
    Number.MAX_SAFE_INTEGER,
    'activatedAtMs',
  );
  const busyTimeoutMs =
    rawOptions.busyTimeoutMs === undefined
      ? undefined
      : safeInteger(rawOptions.busyTimeoutMs, 100, 30_000, 'busyTimeoutMs');
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: 'local.setup.prepare' as const,
    options: Object.freeze({
      deploymentRoot,
      databasePath,
      profile: rawOptions.profile,
      ownerPepperKeyringDirectory,
      ownerPepperBackupDirectory,
      ownerPepperKeyId: rawOptions.ownerPepperKeyId,
      localSecretKeyringPath,
      ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
    }),
    request: Object.freeze({
      registerMutationId: request.registerMutationId,
      activateMutationId: request.activateMutationId,
      registeredAtMs,
      activatedAtMs,
    }),
  });
}

function existingOrProvisionPepper(
  command: Readonly<LocalSetupCommand>,
): Readonly<{ digest: string; created: boolean }> {
  const provider = new LocalOwnerPepperKeyringFileProvider(
    command.options.ownerPepperKeyringDirectory,
  );
  const inspected = provider.inspect();
  if (inspected.keyIds.length === 0) {
    const created = provisionLocalOwnerPepperKey({
      keyringDirectory: command.options.ownerPepperKeyringDirectory,
      pepperKeyId: command.options.ownerPepperKeyId,
    });
    return Object.freeze({ digest: created.digest, created: true });
  }
  if (
    inspected.keyIds.length !== 1 ||
    inspected.keyIds[0] !== command.options.ownerPepperKeyId
  ) {
    throw new LocalSetupConfigurationError(
      'Owner pepper keyring is not an exact setup replay',
    );
  }
  const material = provider.resolve(command.options.ownerPepperKeyId);
  if (!material) {
    throw new LocalSetupConfigurationError(
      'Owner pepper material is unavailable',
    );
  }
  return Object.freeze({
    digest: material.summary.digest,
    created: false,
  });
}

function existingOrBackupPepper(
  command: Readonly<LocalSetupCommand>,
  expectedDigest: string,
): Readonly<{ digest: string; created: boolean }> {
  const provider = new LocalOwnerPepperKeyringFileProvider(
    command.options.ownerPepperBackupDirectory,
  );
  const inspected = provider.inspect();
  if (inspected.keyIds.length === 0) {
    const created = backupLocalOwnerPepperKey({
      keyringDirectory: command.options.ownerPepperKeyringDirectory,
      backupDirectory: command.options.ownerPepperBackupDirectory,
      pepperKeyId: command.options.ownerPepperKeyId,
    });
    if (created.digest !== expectedDigest) {
      throw new LocalSetupConfigurationError(
        'Owner pepper backup digest changed',
      );
    }
    return Object.freeze({ digest: created.digest, created: true });
  }
  if (
    inspected.keyIds.length !== 1 ||
    inspected.keyIds[0] !== command.options.ownerPepperKeyId
  ) {
    throw new LocalSetupConfigurationError(
      'Owner pepper backup is not an exact setup replay',
    );
  }
  const material = provider.resolve(command.options.ownerPepperKeyId);
  if (!material || material.summary.digest !== expectedDigest) {
    throw new LocalSetupConfigurationError(
      'Owner pepper backup does not match primary material',
    );
  }
  return Object.freeze({
    digest: material.summary.digest,
    created: false,
  });
}

async function existingOrProvisionEnvelopeKeyring(
  filePath: string,
): Promise<Readonly<{ version: 1; keyCount: number; created: boolean }>> {
  if (!fs.existsSync(filePath)) {
    const created = await provisionLocalSecretKeyring(filePath);
    return Object.freeze({
      version: 1,
      keyCount: created.keyIds.length,
      created: true,
    });
  }
  const existing = await new LocalSecretKeyringFileProvider(filePath).inspect();
  return Object.freeze({
    version: 1,
    keyCount: existing.keyIds.length,
    created: false,
  });
}

export async function executeLocalSetup(
  input: unknown,
): Promise<Readonly<LocalSetupResult>> {
  const command = normalizeLocalSetupCommand(input);
  const migration = await migrateLocalSqlitePath({
    databasePath: command.options.databasePath,
    profile: command.options.profile,
    ...(command.options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: command.options.busyTimeoutMs }),
  });
  const pepper = existingOrProvisionPepper(command);
  const backup = existingOrBackupPepper(command, pepper.digest);
  const database = await openLocalSqliteBootstrapDatabase({
    databasePath: command.options.databasePath,
    profile: command.options.profile,
    ...(command.options.busyTimeoutMs === undefined
      ? {}
      : { busyTimeoutMs: command.options.busyTimeoutMs }),
  });
  let registered;
  let activated;
  try {
    registered = await database.ownerPepper.register({
      mutationId: command.request.registerMutationId,
      pepperKeyId: command.options.ownerPepperKeyId,
      materialDigest: pepper.digest,
      backupDigest: backup.digest,
      registeredAtMs: command.request.registeredAtMs,
    });
    activated = await database.ownerPepper.activate({
      mutationId: command.request.activateMutationId,
      pepperKeyId: command.options.ownerPepperKeyId,
      expectedGeneration: 0,
      activatedAtMs: command.request.activatedAtMs,
    });
  } finally {
    await database.close();
  }
  const envelopeKeyring = await existingOrProvisionEnvelopeKeyring(
    command.options.localSecretKeyringPath,
  );
  const created =
    pepper.created ||
    backup.created ||
    registered.status === 'inserted' ||
    activated.status === 'inserted' ||
    envelopeKeyring.created;
  return Object.freeze({
    schemaVersion: 1 as const,
    status: created ? ('prepared' as const) : ('existing' as const),
    profile: command.options.profile,
    storage: Object.freeze({
      contractName: migration.readiness.contractName,
      contractVersion: migration.readiness.contractVersion,
      migrationCount: migration.readiness.migrationIds.length,
    }),
    ownerPepper: Object.freeze({
      registerStatus: registered.status,
      activateStatus: activated.status,
      generation: activated.activation.generation,
    }),
    envelopeKeyring: Object.freeze({
      version: 1 as const,
      keyCount: envelopeKeyring.keyCount,
    }),
  });
}

export function executeLocalSetupCommandFile(
  filePath: string,
): Promise<Readonly<LocalSetupResult>> {
  return executeLocalSetup(readPrivateLocalCommandFile(filePath));
}
