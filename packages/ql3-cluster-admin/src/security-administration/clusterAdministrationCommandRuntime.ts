import { randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  normalize,
  parse,
  resolve,
} from 'node:path';

import { assertApiCredentialPepper } from '@qinglong/runtime-core/api-credential-token';
import {
  PostgresApiCredentialAdministrationRepository,
  PostgresIdentityAdministrationRepository,
  PostgresSecurityAuditQueryRepository,
  assertPostgresAdminSchemaReady,
  createPostgresDatabaseOpener,
  isPostgresTlsDnsServername,
  loadPostgresCertificateAuthorityFile,
  loadPostgresConnectionEnvironment,
  type QingLongPostgresDatabaseResource,
} from '@qinglong/cluster-postgres/admin';

import { createClusterSecurityAdministrationIdentityKeysetFile } from '../management-support/pluginPackageIdentityKeyset';
import { createClusterAdministrationService } from './clusterAdministration';
import type {
  ClusterAdministrationCommandAuthority,
  ClusterAdministrationCommandDependencies,
  ClusterAdministrationCommandPaths,
} from './clusterAdministrationCommand';

const MAX_DELIVERY_BYTES = 32 * 1024;

export class ClusterAdministrationCommandError extends TypeError {
  readonly code = 'QL3_CLUSTER_ADMINISTRATION_COMMAND_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Cluster administration command is invalid: ${message}`);
    this.name = 'ClusterAdministrationCommandError';
  }
}

export function boundedClusterAdministrationFile(
  value: unknown,
  label: string,
): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    parse(value).root === value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4_096
  ) {
    throw new ClusterAdministrationCommandError(
      `${label} must be a normalized absolute non-root path`,
    );
  }
  return value;
}

function sameFileState(
  left: Readonly<{
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  }>,
  right: Readonly<{
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  }>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readStableFile(
  candidatePath: string,
  maximumBytes: number,
  privateMaterial: boolean,
): Buffer {
  const filePath = boundedClusterAdministrationFile(
    candidatePath,
    'input file',
  );
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > maximumBytes ||
      (before.mode & (privateMaterial ? 0o077 : 0o022)) !== 0
    ) {
      throw new ClusterAdministrationCommandError(
        'input file authority is invalid',
      );
    }
    bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (offset !== before.size || !sameFileState(before, after)) {
      throw new ClusterAdministrationCommandError(
        'input file changed while being read',
      );
    }
    return bytes.subarray(0, offset);
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof ClusterAdministrationCommandError) throw error;
    throw new ClusterAdministrationCommandError(
      'input file cannot be read',
      error,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function booleanEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean {
  const value = environment[name];
  if (value === 'true') return true;
  if (value === undefined || value === '' || value === 'false') return false;
  throw new ClusterAdministrationCommandError(`${name} must be true or false`);
}

function defaultDatabaseOpener(
  environment: Readonly<Record<string, string | undefined>>,
): () => Promise<QingLongPostgresDatabaseResource> {
  let connection;
  try {
    connection = loadPostgresConnectionEnvironment(environment, {
      connectionString: 'QL3_POSTGRES_ADMIN_URL',
      host: 'QL3_POSTGRES_ADMIN_HOST',
      port: 'QL3_POSTGRES_ADMIN_PORT',
      database: 'QL3_POSTGRES_ADMIN_DATABASE',
      user: 'QL3_POSTGRES_ADMIN_USER',
      password: 'QL3_POSTGRES_ADMIN_PASSWORD',
    });
  } catch (error) {
    throw new ClusterAdministrationCommandError(
      'PostgreSQL admin connection is invalid',
      error,
    );
  }
  const mode = environment.QL3_POSTGRES_ADMIN_TLS_MODE ?? 'verify-full';
  if (mode !== 'verify-full' && mode !== 'disable') {
    throw new ClusterAdministrationCommandError(
      'QL3_POSTGRES_ADMIN_TLS_MODE must be verify-full or disable',
    );
  }
  if (
    mode === 'disable' &&
    !booleanEnvironment(environment, 'QL3_POSTGRES_ADMIN_ALLOW_INSECURE')
  ) {
    throw new ClusterAdministrationCommandError(
      'disabling PostgreSQL admin TLS requires explicit opt-in',
    );
  }
  const servername = environment.QL3_POSTGRES_ADMIN_TLS_SERVERNAME;
  if (mode === 'verify-full' && !isPostgresTlsDnsServername(servername)) {
    throw new ClusterAdministrationCommandError(
      'QL3_POSTGRES_ADMIN_TLS_SERVERNAME must be an explicit DNS name',
    );
  }
  const caFile = environment.QL3_POSTGRES_ADMIN_TLS_CA_FILE;
  if (mode === 'disable' && caFile) {
    throw new ClusterAdministrationCommandError(
      'PostgreSQL admin CA cannot be used when TLS is disabled',
    );
  }
  let ca: string | undefined;
  if (caFile) {
    try {
      ca = loadPostgresCertificateAuthorityFile(
        boundedClusterAdministrationFile(caFile, 'PostgreSQL admin CA file'),
      );
    } catch (error) {
      throw new ClusterAdministrationCommandError(
        'PostgreSQL admin CA file is invalid',
        error,
      );
    }
  }
  return createPostgresDatabaseOpener({
    role: 'admin',
    connection: Object.freeze({
      ...connection,
      tls:
        mode === 'disable'
          ? Object.freeze({ mode: 'disable' as const })
          : Object.freeze({
              mode: 'verify-full' as const,
              servername: servername!,
              ...(ca === undefined ? {} : { ca }),
            }),
    }),
    pool: Object.freeze({
      applicationName: 'qinglong3-security-admin',
      maxConnections: 1,
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 1_000,
      maxLifetimeSeconds: 60,
    }),
    onPoolError() {},
  });
}

async function openDefaultAuthority(
  environment: Readonly<Record<string, string | undefined>>,
  pepper: string,
): Promise<Readonly<ClusterAdministrationCommandAuthority>> {
  assertApiCredentialPepper(pepper);
  const database = await defaultDatabaseOpener(environment)();
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= database.close();
    return closePromise;
  };
  try {
    await assertPostgresAdminSchemaReady(database.pool);
    return Object.freeze({
      administration: createClusterAdministrationService(
        new PostgresIdentityAdministrationRepository(database.pool),
        new PostgresApiCredentialAdministrationRepository(database.pool),
        pepper,
      ),
      audit: new PostgresSecurityAuditQueryRepository(database.pool),
      close,
    });
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

async function authenticateDefault(keysetFile: string, assertion: string) {
  const identities = createClusterSecurityAdministrationIdentityKeysetFile({
    filePath: boundedClusterAdministrationFile(
      keysetFile,
      'identity keyset file',
    ),
  });
  return identities.bind(assertion).authenticate();
}

export function publishClusterAdministrationCredentialDelivery(
  filePathValue: string,
  bytes: Buffer,
): void {
  const filePath = boundedClusterAdministrationFile(
    filePathValue,
    'delivery file',
  );
  if (bytes.length < 1 || bytes.length > MAX_DELIVERY_BYTES) {
    throw new ClusterAdministrationCommandError(
      'credential delivery is oversized',
    );
  }
  const parent = dirname(filePath);
  const parentStatus = lstatSync(parent, { throwIfNoEntry: false });
  if (
    parentStatus === undefined ||
    !parentStatus.isDirectory() ||
    parentStatus.isSymbolicLink() ||
    (parentStatus.mode & 0o077) !== 0
  ) {
    throw new ClusterAdministrationCommandError(
      'credential delivery directory authority is invalid',
    );
  }
  const temporary = resolve(
    parent,
    `.${basename(filePath)}.${process.pid}.${nodeRandomBytes(12).toString(
      'hex',
    )}.tmp`,
  );
  let descriptor: number | undefined;
  let linked = false;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
    }
    fsyncSync(descriptor);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.size !== bytes.length ||
      (status.mode & 0o077) !== 0
    ) {
      throw new ClusterAdministrationCommandError(
        'credential delivery file authority is invalid',
      );
    }
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, filePath);
    linked = true;
    unlinkSync(temporary);
    const parentDescriptor = openSync(
      parent,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original delivery failure.
    }
    if (error instanceof ClusterAdministrationCommandError) throw error;
    throw new ClusterAdministrationCommandError(
      linked
        ? 'credential delivery directory could not be synchronized'
        : 'credential delivery could not be published',
      error,
    );
  }
}

export function normalizeClusterAdministrationCommandPaths(
  value: ClusterAdministrationCommandPaths,
  requiresDelivery: boolean,
): Readonly<ClusterAdministrationCommandPaths> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterAdministrationCommandError(
      'command paths must be an object',
    );
  }
  const expected = [
    'assertionFile',
    'commandFile',
    'keysetFile',
    'pepperFile',
    ...(requiresDelivery ? ['deliveryFile'] : []),
  ].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ClusterAdministrationCommandError(
      'command paths shape is invalid',
    );
  }
  return Object.freeze({
    commandFile: boundedClusterAdministrationFile(
      value.commandFile,
      'command file',
    ),
    assertionFile: boundedClusterAdministrationFile(
      value.assertionFile,
      'assertion file',
    ),
    keysetFile: boundedClusterAdministrationFile(
      value.keysetFile,
      'identity keyset file',
    ),
    pepperFile: boundedClusterAdministrationFile(
      value.pepperFile,
      'pepper file',
    ),
    ...(requiresDelivery
      ? {
          deliveryFile: boundedClusterAdministrationFile(
            value.deliveryFile,
            'delivery file',
          ),
        }
      : {}),
  });
}

export function clusterAdministrationCommandFileBeforeAdmission(
  value: unknown,
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClusterAdministrationCommandError(
      'command paths must be an object',
    );
  }
  const candidate = value as Record<string, unknown>;
  const required = ['assertionFile', 'commandFile', 'keysetFile', 'pepperFile'];
  if (
    required.some((key) => !Object.hasOwn(candidate, key)) ||
    Object.keys(candidate).some(
      (key) => !required.includes(key) && key !== 'deliveryFile',
    )
  ) {
    throw new ClusterAdministrationCommandError(
      'command paths shape is invalid',
    );
  }
  return boundedClusterAdministrationFile(
    candidate.commandFile,
    'command file',
  );
}

export const CLUSTER_ADMINISTRATION_COMMAND_RUNTIME_DEPENDENCIES: ClusterAdministrationCommandDependencies =
  Object.freeze({
    openAuthority: openDefaultAuthority,
    authenticate: authenticateDefault,
    readFile: readStableFile,
    publishDelivery: publishClusterAdministrationCredentialDelivery,
  });
