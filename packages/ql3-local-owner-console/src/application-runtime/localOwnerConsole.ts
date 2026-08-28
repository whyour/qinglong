import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  createLocalOwnerBootstrapService,
  type ClaimLocalOwnerRequest,
  type IssueLocalOwnerBootstrapRequest,
  type LocalOwnerBootstrapSecretDeliveryAcknowledgement,
  type LocalOwnerBootstrapService,
  type ProvisionLocalIdentityRequest,
} from '../bootstrap';
import {
  createLocalOwnerCredentialRecoveryService,
  type CompleteLocalOwnerCredentialRecoveryRequest,
  type IssueLocalOwnerCredentialRecoveryRequest,
  type LocalOwnerCredentialRecoveryDeliveryAcknowledgement,
  type LocalOwnerCredentialRecoveryDeliveryRecord,
  type LocalOwnerCredentialRecoveryService,
} from '../credential-recovery';
import {
  openLocalSqliteBootstrapDatabase,
  type LocalSqliteProfile,
  type LocalSqliteReadinessEvidence,
} from '@qinglong/local-sqlite/bootstrap';
import { assertApiCredentialPepper } from '@qinglong/runtime-core/api-credential-token';
import {
  LEGACY_API_CREDENTIAL_PEPPER_KEY_ID,
  assertApiCredentialPepperKeyId,
} from '@qinglong/runtime-core/api-credential';
import { LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT } from '@qinglong/runtime-core/local-owner-bootstrap';
import {
  normalizeSecurityPrincipal,
  type SecurityPrincipal,
} from '@qinglong/runtime-core/security';
import {
  FileLocalOwnerBootstrapSecretDelivery,
  type ClaimLocalOwnerFromDeliveriesRequest,
  type LocalOwnerSecretRecoverySummary,
  type LocalOwnerSecretDeliverySummary,
} from '../delivery/secretDelivery';

export {
  FileLocalOwnerBootstrapSecretDelivery,
  LocalOwnerSecretDeliveryError,
  type ClaimLocalOwnerFromDeliveriesRequest,
  type LocalOwnerSecretDeliverySummary,
  type LocalOwnerSecretRecoverySummary,
} from '../delivery/secretDelivery';
export {
  LocalOwnerCredentialPresentationInstallError,
  installLocalOwnerCredentialPresentation,
  type InstallLocalOwnerCredentialPresentationOptions,
  type LocalOwnerCredentialPresentationInstallSummary,
} from '../delivery/credentialPresentationInstaller';
export {
  LocalOwnerPepperConfigurationError,
  LocalOwnerPepperConflictError,
  LocalOwnerPepperUnavailableError,
  backupLocalOwnerPepper,
  inspectLocalOwnerPepper,
  provisionLocalOwnerPepper,
  restoreLocalOwnerPepper,
  type BackupLocalOwnerPepperOptions,
  type LocalOwnerPepperPathOptions,
  type LocalOwnerPepperSummary,
  type ProvisionLocalOwnerPepperOptions,
  type RestoreLocalOwnerPepperOptions,
  LocalOwnerPepperKeyringFileProvider,
  backupLocalOwnerPepperKey,
  localOwnerPepperKeyPath,
  provisionLocalOwnerPepperKey,
  restoreLocalOwnerPepperKey,
  type BackupLocalOwnerPepperKeyOptions,
  type LocalOwnerPepperKeyMaterial,
  type LocalOwnerPepperKeyringSummary,
  type ProvisionLocalOwnerPepperKeyOptions,
  type RestoreLocalOwnerPepperKeyOptions,
} from '../pepper-custody';

const MAX_PATH_BYTES = 4096;
const MAX_PEPPER_BYTES = 256;
const AUTHORITY_TTL_MS = 60_000;

interface PathIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: number;
  readonly mode: number;
  readonly kind: 'directory' | 'file';
}

export interface OpenLocalOwnerConsoleOptions {
  readonly deploymentRoot: string;
  readonly databasePath: string;
  readonly pepperPath: string;
  readonly pepperKeyId?: string;
  readonly secretDeliveryDirectory: string;
  readonly profile: LocalSqliteProfile;
  readonly busyTimeoutMs?: number;
}

export interface LocalOwnerConsole {
  readonly profile: LocalSqliteProfile;
  readonly readiness: LocalSqliteReadinessEvidence;
  readonly recovery: Readonly<LocalOwnerSecretRecoverySummary>;
  readonly service: LocalOwnerBootstrapService;
  readonly credentialRecovery: LocalOwnerCredentialRecoveryService;
  credentialDeliveryPath(mutationId: string): string;
  challengeDeliveryPath(mutationId: string): string;
  inspectCredentialDelivery(
    mutationId: string,
  ): Readonly<LocalOwnerSecretDeliverySummary>;
  inspectChallengeDelivery(
    mutationId: string,
  ): Readonly<LocalOwnerSecretDeliverySummary>;
  claimOwnerFromDeliveries(
    request: ClaimLocalOwnerFromDeliveriesRequest,
  ): ReturnType<LocalOwnerBootstrapService['claim']>;
  acknowledgeCredentialDelivery(
    mutationId: string,
    expectedDeliveryDigest: string,
  ): Promise<Readonly<LocalOwnerBootstrapSecretDeliveryAcknowledgement>>;
  acknowledgeCredentialRecoveryDelivery(
    mutationId: string,
    expectedDeliveryDigest: string,
  ): Promise<Readonly<LocalOwnerCredentialRecoveryDeliveryAcknowledgement>>;
  acknowledgeChallengeDelivery(
    mutationId: string,
    expectedDeliveryDigest: string,
  ): Promise<Readonly<LocalOwnerBootstrapSecretDeliveryAcknowledgement>>;
  close(): Promise<void>;
}

export class LocalOwnerConsoleConfigurationError extends Error {
  readonly code = 'LOCAL_OWNER_CONSOLE_CONFIGURATION_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local Owner console configuration is invalid: ${message}`);
    this.name = 'LocalOwnerConsoleConfigurationError';
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

function boundedAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    Buffer.byteLength(value) < 1 ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    value.includes('\0') ||
    path.normalize(value) !== value
  ) {
    throw new LocalOwnerConsoleConfigurationError(
      `${label} must be a normalized bounded absolute path`,
    );
  }
  return value;
}

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function'
  ) {
    throw new LocalOwnerConsoleConfigurationError(
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
    throw new LocalOwnerConsoleConfigurationError(
      'real and effective POSIX users must match',
    );
  }
  return uid;
}

function identity(
  targetPath: string,
  uid: number,
  kind: PathIdentity['kind'],
): PathIdentity {
  const stat = fs.lstatSync(targetPath, { bigint: true });
  const expectedKind =
    kind === 'directory' ? stat.isDirectory() : stat.isFile();
  if (
    !expectedKind ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    (Number(stat.mode) & 0o777) !== (kind === 'directory' ? 0o700 : 0o600)
  ) {
    throw new LocalOwnerConsoleConfigurationError(
      `${kind} ownership or private mode is invalid`,
    );
  }
  return Object.freeze({
    path: targetPath,
    device: stat.dev,
    inode: stat.ino,
    uid,
    mode: Number(stat.mode) & 0o777,
    kind,
  });
}

function descendants(
  deploymentRoot: string,
  targetPath: string,
): readonly string[] {
  const relative = path.relative(deploymentRoot, targetPath);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new LocalOwnerConsoleConfigurationError(
      'authority files must be descendants of deploymentRoot',
    );
  }
  const parts = relative.split(path.sep);
  const directories: string[] = [];
  let current = deploymentRoot;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    directories.push(current);
  }
  return directories;
}

function containsPath(container: string, target: string): boolean {
  const relative = path.relative(container, target);
  return (
    relative.length === 0 ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function sameIdentity(expected: PathIdentity): void {
  const current = identity(expected.path, expected.uid, expected.kind);
  if (
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.mode !== expected.mode
  ) {
    throw new LocalOwnerConsoleConfigurationError(
      `${expected.kind} identity changed during console activation`,
    );
  }
}

function readPepper(expected: PathIdentity): {
  readonly value: string;
  readonly digest: string;
} {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(
    expected.path,
    fs.constants.O_RDONLY | noFollow,
  );
  let material: Buffer | undefined;
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (
      !stat.isFile() ||
      stat.dev !== expected.device ||
      stat.ino !== expected.inode ||
      stat.size < 32n ||
      stat.size > BigInt(MAX_PEPPER_BYTES)
    ) {
      throw new LocalOwnerConsoleConfigurationError(
        'pepper file identity or size is invalid',
      );
    }
    material = fs.readFileSync(descriptor);
    const pepper = material.toString('utf8');
    if (!/^[A-Za-z0-9_-]+$/.test(pepper)) {
      throw new LocalOwnerConsoleConfigurationError(
        'pepper file must contain one base64url value without whitespace',
      );
    }
    assertApiCredentialPepper(pepper);
    return Object.freeze({
      value: pepper,
      digest: createHash('sha256')
        .update('qinglong.local-owner-pepper.summary.v1\0', 'utf8')
        .update(material)
        .digest('hex'),
    });
  } catch (error) {
    if (error instanceof LocalOwnerConsoleConfigurationError) throw error;
    throw new LocalOwnerConsoleConfigurationError(
      'pepper file is invalid',
      error,
    );
  } finally {
    material?.fill(0);
    fs.closeSync(descriptor);
  }
}

function proof(options: OpenLocalOwnerConsoleOptions): {
  readonly authority: Readonly<SecurityPrincipal>;
  readonly pepper: string;
  readonly pepperDigest: string;
  readonly pepperKeyId: string;
  verify(): void;
} {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, [
      'deploymentRoot',
      'databasePath',
      'pepperPath',
      ...(options.pepperKeyId === undefined ? [] : ['pepperKeyId']),
      'secretDeliveryDirectory',
      'profile',
      ...(options.busyTimeoutMs === undefined ? [] : ['busyTimeoutMs']),
    ]) ||
    (options.profile !== 'edge' && options.profile !== 'standalone')
  ) {
    throw new LocalOwnerConsoleConfigurationError('options shape is invalid');
  }
  const deploymentRoot = boundedAbsolutePath(
    options.deploymentRoot,
    'deploymentRoot',
  );
  const databasePath = boundedAbsolutePath(
    options.databasePath,
    'databasePath',
  );
  const pepperPath = boundedAbsolutePath(options.pepperPath, 'pepperPath');
  const pepperKeyId =
    options.pepperKeyId ?? LEGACY_API_CREDENTIAL_PEPPER_KEY_ID;
  try {
    assertApiCredentialPepperKeyId(pepperKeyId);
  } catch {
    throw new LocalOwnerConsoleConfigurationError('pepperKeyId is invalid');
  }
  const secretDeliveryDirectory = boundedAbsolutePath(
    options.secretDeliveryDirectory,
    'secretDeliveryDirectory',
  );
  if (
    databasePath === pepperPath ||
    containsPath(secretDeliveryDirectory, databasePath) ||
    containsPath(secretDeliveryDirectory, pepperPath)
  ) {
    throw new LocalOwnerConsoleConfigurationError(
      'database, pepper, and the dedicated delivery directory must be distinct',
    );
  }
  const uid = currentUid();
  const root = identity(deploymentRoot, uid, 'directory');
  const nestedDirectories = [
    ...descendants(deploymentRoot, databasePath),
    ...descendants(deploymentRoot, pepperPath),
    ...descendants(deploymentRoot, secretDeliveryDirectory),
  ].map((directory) => identity(directory, uid, 'directory'));
  const database = identity(databasePath, uid, 'file');
  const pepperFile = identity(pepperPath, uid, 'file');
  const secretDelivery = identity(secretDeliveryDirectory, uid, 'directory');
  if (
    database.device === pepperFile.device &&
    database.inode === pepperFile.inode
  ) {
    throw new LocalOwnerConsoleConfigurationError(
      'database and pepper files must not share an inode',
    );
  }
  const pepper = readPepper(pepperFile);
  const authenticatedAtMs = Date.now();
  const proofDigest = createHash('sha256')
    .update('qinglong.local-owner-console.proof.v1\0', 'utf8')
    .update(process.platform, 'utf8')
    .update('\0', 'utf8')
    .update(String(uid), 'utf8')
    .update('\0', 'utf8')
    .update(root.device.toString(), 'utf8')
    .update('\0', 'utf8')
    .update(root.inode.toString(), 'utf8')
    .digest('hex');
  const authority = normalizeSecurityPrincipal(
    {
      subject: LOCAL_OWNER_BOOTSTRAP_SYSTEM_SUBJECT,
      authenticationId: `local-console:${proofDigest}`,
      authenticatedAtMs,
      expiresAtMs: authenticatedAtMs + AUTHORITY_TTL_MS,
      assurance: 'local_console',
    },
    authenticatedAtMs,
  );
  const identities = Object.freeze([
    root,
    ...nestedDirectories,
    database,
    pepperFile,
    secretDelivery,
  ]);
  return Object.freeze({
    authority,
    pepper: pepper.value,
    pepperDigest: pepper.digest,
    pepperKeyId,
    verify() {
      if (currentUid() !== uid) {
        throw new LocalOwnerConsoleConfigurationError(
          'POSIX user changed during console activation',
        );
      }
      for (const expected of identities) sameIdentity(expected);
    },
  });
}

export async function openLocalOwnerConsole(
  options: OpenLocalOwnerConsoleOptions,
): Promise<LocalOwnerConsole> {
  const localProof = proof(options);
  const secretDelivery = new FileLocalOwnerBootstrapSecretDelivery(
    options.secretDeliveryDirectory,
  );
  let database: Awaited<
    ReturnType<typeof openLocalSqliteBootstrapDatabase>
  > | null = null;
  try {
    database = await openLocalSqliteBootstrapDatabase({
      databasePath: options.databasePath,
      profile: options.profile,
      ...(options.busyTimeoutMs === undefined
        ? {}
        : { busyTimeoutMs: options.busyTimeoutMs }),
    });
    localProof.verify();
    const activePepper = await database.ownerPepper.resolveActive();
    if (
      !activePepper ||
      activePepper.activePepperKeyId !== localProof.pepperKeyId ||
      activePepper.materialDigest !== localProof.pepperDigest
    ) {
      throw new LocalOwnerConsoleConfigurationError(
        'pepper file is not the database active key',
      );
    }
    const recovery = await secretDelivery.recover(
      database.ownerBootstrap,
      localProof.pepper,
      database.ownerCredentialRecovery,
    );
    localProof.verify();
    const service = createLocalOwnerBootstrapService(
      database.ownerBootstrap,
      database.apiCredentials,
      localProof.pepper,
      localProof.authority,
      { pepperKeyId: localProof.pepperKeyId, secretDelivery },
    );
    const guardedService: LocalOwnerBootstrapService = Object.freeze({
      provision(request: ProvisionLocalIdentityRequest) {
        localProof.verify();
        return service.provision(request);
      },
      issue(request: IssueLocalOwnerBootstrapRequest) {
        localProof.verify();
        return service.issue(request);
      },
      claim(request: ClaimLocalOwnerRequest) {
        localProof.verify();
        return service.claim(request);
      },
    });
    const credentialRecovery = createLocalOwnerCredentialRecoveryService(
      database.ownerCredentialRecovery,
      database.apiCredentials,
      localProof.pepper,
      {
        pepperKeyId: localProof.pepperKeyId,
        secretDelivery: Object.freeze({
          async prepare(
            candidate: Readonly<LocalOwnerCredentialRecoveryDeliveryRecord>,
          ) {
            const prepared = await secretDelivery.prepare(candidate);
            if (prepared.kind !== 'credential') {
              throw new LocalOwnerConsoleConfigurationError(
                'credential recovery delivery kind changed',
              );
            }
            return prepared;
          },
          publish(
            prepared: Readonly<LocalOwnerCredentialRecoveryDeliveryRecord>,
          ) {
            return secretDelivery.publish(prepared);
          },
        }),
      },
    );
    const guardedCredentialRecovery: LocalOwnerCredentialRecoveryService =
      Object.freeze({
        issue(request: IssueLocalOwnerCredentialRecoveryRequest) {
          localProof.verify();
          return credentialRecovery.issue(request);
        },
        complete(request: CompleteLocalOwnerCredentialRecoveryRequest) {
          localProof.verify();
          return credentialRecovery.complete(request);
        },
      });
    let closePromise: Promise<void> | undefined;
    const ownedDatabase = database;
    return Object.freeze({
      profile: ownedDatabase.profile,
      readiness: ownedDatabase.readiness,
      recovery,
      service: guardedService,
      credentialRecovery: guardedCredentialRecovery,
      credentialDeliveryPath(mutationId: string) {
        localProof.verify();
        return secretDelivery.readyPath('credential', mutationId);
      },
      challengeDeliveryPath(mutationId: string) {
        localProof.verify();
        return secretDelivery.readyPath('challenge', mutationId);
      },
      inspectCredentialDelivery(mutationId: string) {
        localProof.verify();
        return secretDelivery.inspectReady('credential', mutationId);
      },
      inspectChallengeDelivery(mutationId: string) {
        localProof.verify();
        return secretDelivery.inspectReady('challenge', mutationId);
      },
      claimOwnerFromDeliveries(request: ClaimLocalOwnerFromDeliveriesRequest) {
        localProof.verify();
        return secretDelivery.claimOwnerFromDeliveries(
          ownedDatabase.ownerBootstrap,
          guardedService,
          request,
        );
      },
      acknowledgeCredentialDelivery(
        mutationId: string,
        expectedDeliveryDigest: string,
      ) {
        localProof.verify();
        return secretDelivery.acknowledge(
          ownedDatabase.ownerBootstrap,
          localProof.pepper,
          'credential',
          mutationId,
          expectedDeliveryDigest,
        );
      },
      acknowledgeCredentialRecoveryDelivery(
        mutationId: string,
        expectedDeliveryDigest: string,
      ) {
        localProof.verify();
        return secretDelivery.acknowledgeRecovery(
          ownedDatabase.ownerCredentialRecovery,
          localProof.pepper,
          mutationId,
          expectedDeliveryDigest,
        );
      },
      acknowledgeChallengeDelivery(
        mutationId: string,
        expectedDeliveryDigest: string,
      ) {
        localProof.verify();
        return secretDelivery.acknowledge(
          ownedDatabase.ownerBootstrap,
          localProof.pepper,
          'challenge',
          mutationId,
          expectedDeliveryDigest,
        );
      },
      close() {
        if (closePromise) return closePromise;
        closePromise = ownedDatabase.close();
        return closePromise;
      },
    });
  } catch (error) {
    await database?.close().catch(() => undefined);
    throw error;
  }
}
