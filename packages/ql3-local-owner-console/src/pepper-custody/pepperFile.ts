import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertApiCredentialPepper } from '@qinglong/runtime-core/api-credential-token';

const MAX_PATH_BYTES = 4096;
const PEPPER_BYTES = 32;

type RandomBytesFactory = (size: number) => Buffer;

interface PathIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: number;
  readonly mode: number;
  readonly kind: 'directory' | 'file';
}

export interface LocalOwnerPepperSummary {
  readonly version: 1;
  readonly digest: string;
  readonly byteLength: number;
}

export interface LocalOwnerPepperPathOptions {
  readonly deploymentRoot: string;
  readonly pepperPath: string;
}

export interface ProvisionLocalOwnerPepperOptions
  extends LocalOwnerPepperPathOptions {
  readonly randomBytes?: RandomBytesFactory;
}

export interface BackupLocalOwnerPepperOptions
  extends LocalOwnerPepperPathOptions {
  readonly backupRoot: string;
  readonly backupPath: string;
}

export interface RestoreLocalOwnerPepperOptions {
  readonly deploymentRoot: string;
  readonly backupRoot: string;
  readonly backupPath: string;
  readonly pepperPath: string;
}

export class LocalOwnerPepperConfigurationError extends TypeError {
  readonly code = 'LOCAL_OWNER_PEPPER_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(`Local Owner pepper configuration is invalid: ${message}`);
    this.name = 'LocalOwnerPepperConfigurationError';
  }
}

export class LocalOwnerPepperConflictError extends Error {
  readonly code = 'LOCAL_OWNER_PEPPER_CONFLICT';

  constructor() {
    super('Local Owner pepper destination already exists');
    this.name = 'LocalOwnerPepperConflictError';
  }
}

export class LocalOwnerPepperUnavailableError extends Error {
  readonly code = 'LOCAL_OWNER_PEPPER_UNAVAILABLE';

  constructor(readonly cause?: unknown) {
    super('Local Owner pepper operation is unavailable');
    this.name = 'LocalOwnerPepperUnavailableError';
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
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value) < 1 ||
    Buffer.byteLength(value) > MAX_PATH_BYTES
  ) {
    throw new LocalOwnerPepperConfigurationError(
      `${label} must be a normalized bounded absolute path`,
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
    throw new LocalOwnerPepperConfigurationError(
      'real and effective POSIX users must match',
    );
  }
  return process.getuid();
}

function identity(
  targetPath: string,
  uid: number,
  kind: PathIdentity['kind'],
): PathIdentity {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(targetPath, { bigint: true });
  } catch (error) {
    throw new LocalOwnerPepperUnavailableError(error);
  }
  const expected = kind === 'directory' ? stat.isDirectory() : stat.isFile();
  const mode = Number(stat.mode) & 0o777;
  if (
    !expected ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    mode !== (kind === 'directory' ? 0o700 : 0o600)
  ) {
    throw new LocalOwnerPepperUnavailableError();
  }
  return Object.freeze({
    path: targetPath,
    device: stat.dev,
    inode: stat.ino,
    uid,
    mode,
    kind,
  });
}

function sameIdentity(expected: PathIdentity): void {
  const current = identity(expected.path, expected.uid, expected.kind);
  if (
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.mode !== expected.mode
  ) {
    throw new LocalOwnerPepperUnavailableError();
  }
}

function authority(
  deploymentRoot: string,
  targetPaths: readonly string[],
): { readonly uid: number; readonly identities: readonly PathIdentity[] } {
  const uid = currentUid();
  const root = identity(deploymentRoot, uid, 'directory');
  const identities: PathIdentity[] = [root];
  const seen = new Set([deploymentRoot]);
  for (const targetPath of targetPaths) {
    const relative = path.relative(deploymentRoot, targetPath);
    if (
      relative.length === 0 ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new LocalOwnerPepperConfigurationError(
        'pepper paths must be descendants of deploymentRoot',
      );
    }
    let current = deploymentRoot;
    for (const part of path.dirname(relative).split(path.sep)) {
      if (part === '.') continue;
      current = path.join(current, part);
      if (seen.has(current)) continue;
      identities.push(identity(current, uid, 'directory'));
      seen.add(current);
    }
  }
  return Object.freeze({ uid, identities: Object.freeze(identities) });
}

function verifyAuthority(identities: readonly PathIdentity[]): void {
  for (const expected of identities) sameIdentity(expected);
}

function summary(material: Buffer): Readonly<LocalOwnerPepperSummary> {
  return Object.freeze({
    version: 1,
    digest: createHash('sha256')
      .update('qinglong.local-owner-pepper.summary.v1\0', 'utf8')
      .update(material)
      .digest('hex'),
    byteLength: material.byteLength,
  });
}

function readPepper(
  pepperPath: string,
  uid: number,
): { readonly material: Buffer; readonly identity: PathIdentity } {
  const expected = identity(pepperPath, uid, 'file');
  let descriptor: number | undefined;
  let material: Buffer | undefined;
  try {
    descriptor = fs.openSync(
      pepperPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== expected.device ||
      opened.ino !== expected.inode ||
      opened.size < 32n ||
      opened.size > 256n
    ) {
      throw new LocalOwnerPepperUnavailableError();
    }
    material = fs.readFileSync(descriptor);
    const value = material.toString('utf8');
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new LocalOwnerPepperUnavailableError();
    }
    assertApiCredentialPepper(value);
    return Object.freeze({ material, identity: expected });
  } catch (error) {
    material?.fill(0);
    if (error instanceof LocalOwnerPepperUnavailableError) throw error;
    throw new LocalOwnerPepperUnavailableError(error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isConflict(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'EEXIST'
  );
}

function publishNoReplace(
  targetPath: string,
  material: Buffer,
  identities: readonly PathIdentity[],
): void {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.owner-pepper-${cryptoRandomBytes(12).toString('hex')}.tmp`,
  );
  let descriptor: number | undefined;
  let linked = false;
  try {
    verifyAuthority(identities);
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(descriptor, material);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryPath, targetPath);
    linked = true;
    syncDirectory(directory);
    verifyAuthority(identities);
    const published = readPepper(targetPath, currentUid());
    try {
      if (!published.material.equals(material)) {
        throw new LocalOwnerPepperUnavailableError();
      }
    } finally {
      published.material.fill(0);
    }
  } catch (error) {
    if (isConflict(error)) throw new LocalOwnerPepperConflictError();
    if (error instanceof LocalOwnerPepperConflictError) throw error;
    if (error instanceof LocalOwnerPepperUnavailableError) throw error;
    throw new LocalOwnerPepperUnavailableError(error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
      syncDirectory(directory);
    } catch {
      // A linked target is already durable; a bounded orphan is recoverable.
    }
    if (!linked) verifyAuthority(identities);
  }
}

function validatePathOptions(options: LocalOwnerPepperPathOptions): {
  readonly deploymentRoot: string;
  readonly pepperPath: string;
} {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, ['deploymentRoot', 'pepperPath'])
  ) {
    throw new LocalOwnerPepperConfigurationError('options shape is invalid');
  }
  return Object.freeze({
    deploymentRoot: boundedPath(options.deploymentRoot, 'deploymentRoot'),
    pepperPath: boundedPath(options.pepperPath, 'pepperPath'),
  });
}

export function provisionLocalOwnerPepper(
  options: ProvisionLocalOwnerPepperOptions,
): Readonly<LocalOwnerPepperSummary> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, [
      'deploymentRoot',
      'pepperPath',
      ...(options.randomBytes === undefined ? [] : ['randomBytes']),
    ]) ||
    (options.randomBytes !== undefined &&
      typeof options.randomBytes !== 'function')
  ) {
    throw new LocalOwnerPepperConfigurationError('options shape is invalid');
  }
  const deploymentRoot = boundedPath(options.deploymentRoot, 'deploymentRoot');
  const pepperPath = boundedPath(options.pepperPath, 'pepperPath');
  const proof = authority(deploymentRoot, [pepperPath]);
  let entropy: Buffer | undefined;
  let material: Buffer | undefined;
  try {
    entropy = (options.randomBytes ?? cryptoRandomBytes)(PEPPER_BYTES);
    if (!Buffer.isBuffer(entropy) || entropy.byteLength !== PEPPER_BYTES) {
      throw new LocalOwnerPepperConfigurationError(
        'randomBytes result is invalid',
      );
    }
    material = Buffer.from(entropy.toString('base64url'), 'utf8');
    publishNoReplace(pepperPath, material, proof.identities);
    return summary(material);
  } catch (error) {
    if (
      error instanceof LocalOwnerPepperConfigurationError ||
      error instanceof LocalOwnerPepperConflictError ||
      error instanceof LocalOwnerPepperUnavailableError
    ) {
      throw error;
    }
    throw new LocalOwnerPepperUnavailableError(error);
  } finally {
    entropy?.fill(0);
    material?.fill(0);
  }
}

export function inspectLocalOwnerPepper(
  options: LocalOwnerPepperPathOptions,
): Readonly<LocalOwnerPepperSummary> {
  const resolved = validatePathOptions(options);
  const proof = authority(resolved.deploymentRoot, [resolved.pepperPath]);
  const pepper = readPepper(resolved.pepperPath, proof.uid);
  try {
    verifyAuthority(proof.identities);
    sameIdentity(pepper.identity);
    return summary(pepper.material);
  } finally {
    pepper.material.fill(0);
  }
}

export function backupLocalOwnerPepper(
  options: BackupLocalOwnerPepperOptions,
): Readonly<LocalOwnerPepperSummary> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, [
      'backupPath',
      'backupRoot',
      'deploymentRoot',
      'pepperPath',
    ])
  ) {
    throw new LocalOwnerPepperConfigurationError('options shape is invalid');
  }
  const deploymentRoot = boundedPath(options.deploymentRoot, 'deploymentRoot');
  const pepperPath = boundedPath(options.pepperPath, 'pepperPath');
  const backupRoot = boundedPath(options.backupRoot, 'backupRoot');
  const backupPath = boundedPath(options.backupPath, 'backupPath');
  if (pepperPath === backupPath) {
    throw new LocalOwnerPepperConfigurationError(
      'pepper and backup paths must be distinct',
    );
  }
  const sourceProof = authority(deploymentRoot, [pepperPath]);
  const backupProof = authority(backupRoot, [backupPath]);
  const pepper = readPepper(pepperPath, sourceProof.uid);
  try {
    publishNoReplace(backupPath, pepper.material, backupProof.identities);
    sameIdentity(pepper.identity);
    verifyAuthority(sourceProof.identities);
    return summary(pepper.material);
  } finally {
    pepper.material.fill(0);
  }
}

export function restoreLocalOwnerPepper(
  options: RestoreLocalOwnerPepperOptions,
): Readonly<LocalOwnerPepperSummary> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, [
      'backupPath',
      'backupRoot',
      'deploymentRoot',
      'pepperPath',
    ])
  ) {
    throw new LocalOwnerPepperConfigurationError('options shape is invalid');
  }
  const deploymentRoot = boundedPath(options.deploymentRoot, 'deploymentRoot');
  const backupRoot = boundedPath(options.backupRoot, 'backupRoot');
  const backupPath = boundedPath(options.backupPath, 'backupPath');
  const pepperPath = boundedPath(options.pepperPath, 'pepperPath');
  if (pepperPath === backupPath) {
    throw new LocalOwnerPepperConfigurationError(
      'pepper and backup paths must be distinct',
    );
  }
  const backupProof = authority(backupRoot, [backupPath]);
  const targetProof = authority(deploymentRoot, [pepperPath]);
  const backup = readPepper(backupPath, backupProof.uid);
  try {
    publishNoReplace(pepperPath, backup.material, targetProof.identities);
    sameIdentity(backup.identity);
    verifyAuthority(backupProof.identities);
    return summary(backup.material);
  } finally {
    backup.material.fill(0);
  }
}
