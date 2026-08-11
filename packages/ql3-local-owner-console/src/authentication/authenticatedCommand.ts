import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  createLocalIdentityKeyringAuthenticator,
  type LocalIdentityAuthentication,
} from './identityAuthentication';
import { LocalOwnerPepperKeyringFileProvider } from '../pepper-custody';
import type { LocalSqliteAuthenticatedUserCredentialFence } from '@qinglong/local-sqlite/package-management';
import type { ApiCredentialRepository } from '@qinglong/runtime-core/api-credential';
import type { LocalOwnerPepperRepository } from '@qinglong/runtime-core/local-owner-pepper';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';

const MAX_PATH_BYTES = 4096;
const MAX_CREDENTIAL_FILE_BYTES = 1024;
const LOCAL_COMMAND_PRINCIPAL_TTL_MS = 60_000;

interface PathIdentity {
  readonly path: string;
  readonly kind: 'directory' | 'file';
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNs: bigint;
  readonly changedAtNs: bigint;
  readonly uid: number;
  readonly mode: number;
}

interface CredentialFence extends LocalSqliteAuthenticatedUserCredentialFence {
  readonly authenticationId: string;
}

export interface AuthenticatedLocalCommandDatabase {
  readonly apiCredentials: ApiCredentialRepository;
  readonly ownerPepper: Pick<LocalOwnerPepperRepository, 'resolveKey'>;
}

export interface EstablishAuthenticatedLocalCommandOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly ownerPepperKeyringDirectory: string;
  readonly credentialFilePath: string;
  readonly authenticationNamespace: string;
  readonly now?: () => number;
}

export interface AuthenticatedLocalCommand {
  readonly principal: Readonly<SecurityPrincipal>;
  readonly databaseFence: Readonly<LocalSqliteAuthenticatedUserCredentialFence>;
  confirm(): Promise<void>;
}

export class AuthenticatedLocalCommandConfigurationError extends TypeError {
  readonly code = 'AUTHENTICATED_LOCAL_COMMAND_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Authenticated local command configuration is invalid: ${message}`);
    this.name = 'AuthenticatedLocalCommandConfigurationError';
  }
}

export class AuthenticatedLocalCommandAuthenticationError extends Error {
  readonly code = 'AUTHENTICATED_LOCAL_COMMAND_AUTHENTICATION_FAILED';

  constructor(message: string, readonly cause?: unknown) {
    super(`Authenticated local command failed: ${message}`);
    this.name = 'AuthenticatedLocalCommandAuthenticationError';
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new AuthenticatedLocalCommandConfigurationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function'
  ) {
    throw new AuthenticatedLocalCommandConfigurationError(
      'POSIX user identity is unavailable',
    );
  }
  const uid = process.getuid();
  const effectiveUid = process.geteuid();
  if (
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    !Number.isSafeInteger(effectiveUid) ||
    effectiveUid < 0 ||
    uid !== effectiveUid
  ) {
    throw new AuthenticatedLocalCommandConfigurationError(
      'real and effective POSIX users must match',
    );
  }
  return uid;
}

function identity(
  targetPath: string,
  kind: PathIdentity['kind'],
  uid: number,
): PathIdentity {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(targetPath, { bigint: true });
  } catch (error) {
    throw new AuthenticatedLocalCommandConfigurationError(
      `${kind} is unavailable`,
      error,
    );
  }
  const expectedKind =
    kind === 'directory' ? stat.isDirectory() : stat.isFile();
  const mode = Number(stat.mode) & 0o777;
  if (
    !expectedKind ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    mode !== (kind === 'directory' ? 0o700 : 0o600)
  ) {
    throw new AuthenticatedLocalCommandConfigurationError(
      `${kind} ownership or private mode is invalid`,
    );
  }
  return Object.freeze({
    path: targetPath,
    kind,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAtNs: stat.mtimeNs,
    changedAtNs: stat.ctimeNs,
    uid,
    mode,
  });
}

function descendants(deploymentRoot: string, targetPath: string): string[] {
  const relative = path.relative(deploymentRoot, targetPath);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new AuthenticatedLocalCommandConfigurationError(
      'authority paths must be descendants of deploymentRoot',
    );
  }
  const directories: string[] = [];
  let current = deploymentRoot;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    directories.push(current);
  }
  return directories;
}

function sameIdentity(expected: PathIdentity, mutable: boolean): void {
  const actual = identity(expected.path, expected.kind, expected.uid);
  if (
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.mode !== expected.mode ||
    (expected.kind === 'file' &&
      !mutable &&
      (actual.size !== expected.size ||
        actual.modifiedAtNs !== expected.modifiedAtNs ||
        actual.changedAtNs !== expected.changedAtNs))
  ) {
    throw new AuthenticatedLocalCommandAuthenticationError(
      'authority path identity changed during command execution',
    );
  }
}

function readCredentialToken(filePath: string, expected: PathIdentity): string {
  let descriptor: number | undefined;
  let material: Buffer | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== expected.device ||
      opened.ino !== expected.inode ||
      opened.size !== expected.size ||
      opened.size < 1n ||
      opened.size > BigInt(MAX_CREDENTIAL_FILE_BYTES)
    ) {
      throw new AuthenticatedLocalCommandAuthenticationError(
        'credential file identity or size is invalid',
      );
    }
    material = fs.readFileSync(descriptor);
    const value = JSON.parse(material.toString('utf8')) as unknown;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !exactKeys(value, ['kind', 'schemaVersion', 'token'])
    ) {
      throw new AuthenticatedLocalCommandAuthenticationError(
        'credential presentation shape is invalid',
      );
    }
    const presentation = value as Record<string, unknown>;
    if (
      presentation.schemaVersion !== 1 ||
      presentation.kind !==
        'qinglong3-local-identity-credential-presentation' ||
      typeof presentation.token !== 'string' ||
      presentation.token.length > 256
    ) {
      throw new AuthenticatedLocalCommandAuthenticationError(
        'credential presentation is invalid',
      );
    }
    return presentation.token;
  } catch (error) {
    if (error instanceof AuthenticatedLocalCommandAuthenticationError) {
      throw error;
    }
    throw new AuthenticatedLocalCommandAuthenticationError(
      'credential presentation cannot be read',
      error,
    );
  } finally {
    material?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function commandProof(
  options: EstablishAuthenticatedLocalCommandOptions & {
    readonly now: () => number;
  },
): {
  readonly authenticatedAtMs: number;
  readonly expiresAtMs: number;
  readonly digest: string;
  readonly credentialFile: PathIdentity;
  verify(): void;
} {
  const uid = currentUid();
  const rootPath = boundedPath(options.deploymentRoot, 'deploymentRoot');
  const databasePath = boundedPath(options.databasePath, 'databasePath');
  const credentialFilePath = boundedPath(
    options.credentialFilePath,
    'credentialFilePath',
  );
  const keyringDirectory = boundedPath(
    options.ownerPepperKeyringDirectory,
    'ownerPepperKeyringDirectory',
  );
  const nestedDirectories = new Set<string>();
  for (const target of [databasePath, credentialFilePath, keyringDirectory]) {
    for (const directory of descendants(rootPath, target)) {
      nestedDirectories.add(directory);
    }
  }
  const root = identity(rootPath, 'directory', uid);
  const directories = [
    root,
    ...[...nestedDirectories]
      .filter(
        (candidate) => candidate !== rootPath && candidate !== keyringDirectory,
      )
      .map((candidate) => identity(candidate, 'directory', uid)),
    identity(keyringDirectory, 'directory', uid),
  ];
  const database = identity(databasePath, 'file', uid);
  const credentialFile = identity(credentialFilePath, 'file', uid);
  if (
    database.device === credentialFile.device &&
    database.inode === credentialFile.inode
  ) {
    throw new AuthenticatedLocalCommandConfigurationError(
      'database and credential files must not share an inode',
    );
  }
  const authenticatedAtMs = options.now();
  if (!Number.isSafeInteger(authenticatedAtMs) || authenticatedAtMs < 0) {
    throw new AuthenticatedLocalCommandConfigurationError('clock is invalid');
  }
  const digest = createHash('sha256')
    .update('qinglong3.authenticated-local-command-posix-proof.v1\0', 'utf8')
    .update(process.platform, 'utf8')
    .update('\0', 'utf8')
    .update(String(uid), 'utf8')
    .update('\0', 'utf8')
    .update(root.device.toString(), 'utf8')
    .update('\0', 'utf8')
    .update(root.inode.toString(), 'utf8')
    .digest('hex');
  return Object.freeze({
    authenticatedAtMs,
    expiresAtMs: authenticatedAtMs + LOCAL_COMMAND_PRINCIPAL_TTL_MS,
    digest,
    credentialFile,
    verify() {
      if (currentUid() !== uid) {
        throw new AuthenticatedLocalCommandAuthenticationError(
          'POSIX user changed during command execution',
        );
      }
      for (const expected of directories) sameIdentity(expected, false);
      sameIdentity(database, true);
      sameIdentity(credentialFile, false);
    },
  });
}

export async function establishAuthenticatedLocalCommand(
  database: AuthenticatedLocalCommandDatabase,
  candidateOptions: EstablishAuthenticatedLocalCommandOptions,
): Promise<Readonly<AuthenticatedLocalCommand>> {
  if (
    !database ||
    typeof database !== 'object' ||
    !database.apiCredentials ||
    typeof database.apiCredentials.resolve !== 'function' ||
    !database.ownerPepper ||
    typeof database.ownerPepper.resolveKey !== 'function'
  ) {
    throw new AuthenticatedLocalCommandConfigurationError(
      'database authority is invalid',
    );
  }
  if (
    !candidateOptions ||
    typeof candidateOptions !== 'object' ||
    Array.isArray(candidateOptions) ||
    !exactKeys(candidateOptions, [
      'deploymentRoot',
      'databasePath',
      'ownerPepperKeyringDirectory',
      'credentialFilePath',
      'authenticationNamespace',
      ...(candidateOptions.now === undefined ? [] : ['now']),
    ]) ||
    !/^[a-z][a-z0-9_]{0,31}$/.test(candidateOptions.authenticationNamespace) ||
    (candidateOptions.now !== undefined &&
      typeof candidateOptions.now !== 'function')
  ) {
    throw new AuthenticatedLocalCommandConfigurationError(
      'options shape is invalid',
    );
  }
  const options = Object.freeze({
    ...candidateOptions,
    now: candidateOptions.now ?? Date.now,
  });
  const proof = commandProof(options);
  proof.verify();
  const pepperProvider = new LocalOwnerPepperKeyringFileProvider(
    options.ownerPepperKeyringDirectory,
  );
  const authenticator = createLocalIdentityKeyringAuthenticator(
    database.apiCredentials,
    database.ownerPepper,
    pepperProvider,
    {
      principalTtlMs: LOCAL_COMMAND_PRINCIPAL_TTL_MS,
      now: options.now,
    },
  );
  const token = readCredentialToken(
    options.credentialFilePath,
    proof.credentialFile,
  );
  const authentication: Readonly<LocalIdentityAuthentication> | null =
    await authenticator.authenticateCredential(token);
  if (!authentication || authentication.principal.subject.type !== 'user') {
    throw new AuthenticatedLocalCommandAuthenticationError(
      'credential is not an active User identity',
    );
  }
  const credential = await database.apiCredentials.resolve(
    authentication.credentialId,
  );
  if (!credential || credential.version !== authentication.credentialVersion) {
    throw new AuthenticatedLocalCommandAuthenticationError(
      'credential fence is unavailable',
    );
  }
  const key = await database.ownerPepper.resolveKey(credential.pepperKeyId);
  const material = pepperProvider.resolve(credential.pepperKeyId);
  if (
    !key?.materialDigest ||
    !material ||
    material.summary.digest !== key.materialDigest
  ) {
    throw new AuthenticatedLocalCommandAuthenticationError(
      'credential pepper provenance is unavailable',
    );
  }
  const fence: CredentialFence = Object.freeze({
    credentialId: authentication.credentialId,
    credentialVersion: authentication.credentialVersion,
    pepperKeyId: credential.pepperKeyId,
    materialDigest: key.materialDigest,
    authenticationId: authentication.principal.authenticationId,
    subjectType: 'user',
    subjectId: credential.subject.id,
    secretDigest: credential.secretDigest,
    notBeforeAtMs: credential.notBeforeAtMs,
    expiresAtMs: credential.expiresAtMs,
  });
  const authenticatedAtMs = Math.max(
    proof.authenticatedAtMs,
    authentication.principal.authenticatedAtMs,
  );
  const expiresAtMs = Math.min(
    proof.expiresAtMs,
    authentication.principal.expiresAtMs,
  );
  const principal = normalizeSecurityPrincipal(
    {
      subject: authentication.principal.subject,
      authenticationId: `${options.authenticationNamespace}:${createHash(
        'sha256',
      )
        .update('qinglong3.authenticated-local-command-principal.v1\0', 'utf8')
        .update(fence.authenticationId, 'utf8')
        .update('\0', 'utf8')
        .update(proof.digest, 'utf8')
        .digest('hex')}`,
      authenticatedAtMs,
      expiresAtMs,
      assurance: 'local_console',
    },
    authenticatedAtMs,
  );
  return Object.freeze({
    principal,
    databaseFence: Object.freeze({
      credentialId: fence.credentialId,
      credentialVersion: fence.credentialVersion,
      pepperKeyId: fence.pepperKeyId,
      materialDigest: fence.materialDigest,
      subjectType: fence.subjectType,
      subjectId: fence.subjectId,
      secretDigest: fence.secretDigest,
      notBeforeAtMs: fence.notBeforeAtMs,
      expiresAtMs: fence.expiresAtMs,
    }),
    async confirm() {
      proof.verify();
      const nowMs = options.now();
      const currentAuthentication = await authenticator.authenticateCredential(
        readCredentialToken(options.credentialFilePath, proof.credentialFile),
      );
      const currentCredential = await database.apiCredentials.resolve(
        fence.credentialId,
      );
      const currentKey = await database.ownerPepper.resolveKey(
        fence.pepperKeyId,
      );
      const currentMaterial = pepperProvider.resolve(fence.pepperKeyId);
      if (
        !Number.isSafeInteger(nowMs) ||
        nowMs < principal.authenticatedAtMs ||
        nowMs >= principal.expiresAtMs ||
        !currentAuthentication ||
        currentAuthentication.credentialId !== fence.credentialId ||
        currentAuthentication.credentialVersion !== fence.credentialVersion ||
        !currentCredential ||
        currentCredential.version !== fence.credentialVersion ||
        currentCredential.state !== 'active' ||
        currentCredential.subjectStatus !== 'active' ||
        currentCredential.subject.type !== fence.subjectType ||
        currentCredential.subject.id !== fence.subjectId ||
        currentCredential.secretDigest !== fence.secretDigest ||
        currentCredential.notBeforeAtMs !== fence.notBeforeAtMs ||
        currentCredential.expiresAtMs !== fence.expiresAtMs ||
        currentCredential.notBeforeAtMs > nowMs ||
        currentCredential.expiresAtMs <= nowMs ||
        currentCredential.pepperKeyId !== fence.pepperKeyId ||
        !currentKey ||
        (currentKey.state !== 'active' && currentKey.state !== 'retired') ||
        currentKey.materialDigest !== fence.materialDigest ||
        !currentMaterial ||
        currentMaterial.summary.digest !== fence.materialDigest
      ) {
        throw new AuthenticatedLocalCommandAuthenticationError(
          'credential authority changed during command execution',
        );
      }
    },
  });
}
