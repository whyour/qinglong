import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertApiCredentialPepperKeyId } from '@qinglong/runtime-core/api-credential';
import { assertApiCredentialPepper } from '@qinglong/runtime-core/api-credential-token';
import { MAX_LOCAL_OWNER_PEPPER_KEYS } from '@qinglong/runtime-core/local-owner-pepper';
import {
  LocalOwnerPepperConfigurationError,
  LocalOwnerPepperUnavailableError,
  backupLocalOwnerPepper,
  provisionLocalOwnerPepper,
  restoreLocalOwnerPepper,
  type LocalOwnerPepperSummary,
} from './pepperFile';

const MAX_PATH_BYTES = 4096;
const KEY_SUFFIX = '.pepper';

interface DirectoryIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: number;
  readonly mode: number;
}

export interface LocalOwnerPepperKeyMaterial {
  readonly pepperKeyId: string;
  readonly pepper: string;
  readonly summary: Readonly<LocalOwnerPepperSummary>;
}

export interface LocalOwnerPepperKeyringSummary {
  readonly version: 1;
  readonly keyIds: readonly string[];
}

export interface ProvisionLocalOwnerPepperKeyOptions {
  readonly keyringDirectory: string;
  readonly pepperKeyId: string;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface BackupLocalOwnerPepperKeyOptions {
  readonly keyringDirectory: string;
  readonly backupDirectory: string;
  readonly pepperKeyId: string;
}

export interface RestoreLocalOwnerPepperKeyOptions {
  readonly keyringDirectory: string;
  readonly backupDirectory: string;
  readonly pepperKeyId: string;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function boundedDirectory(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value) < 1 ||
    Buffer.byteLength(value) > MAX_PATH_BYTES
  ) {
    throw new LocalOwnerPepperConfigurationError(
      'keyringDirectory must be a normalized bounded absolute path',
    );
  }
  return value;
}

function keyId(value: unknown): string {
  try {
    assertApiCredentialPepperKeyId(value as string);
  } catch {
    throw new LocalOwnerPepperConfigurationError('pepperKeyId is invalid');
  }
  return value as string;
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

function directoryIdentity(directory: string): DirectoryIdentity {
  const uid = currentUid();
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    throw new LocalOwnerPepperUnavailableError(error);
  }
  const mode = Number(stat.mode) & 0o777;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    mode !== 0o700
  ) {
    throw new LocalOwnerPepperUnavailableError();
  }
  return Object.freeze({
    path: directory,
    device: stat.dev,
    inode: stat.ino,
    uid,
    mode,
  });
}

function verifyDirectory(expected: DirectoryIdentity): void {
  const current = directoryIdentity(expected.path);
  if (
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.uid !== expected.uid ||
    current.mode !== expected.mode
  ) {
    throw new LocalOwnerPepperUnavailableError();
  }
}

function fileName(pepperKeyId: string): string {
  return `${Buffer.from(pepperKeyId, 'utf8').toString(
    'base64url',
  )}${KEY_SUFFIX}`;
}

function decodeFileName(value: string): string {
  if (!value.endsWith(KEY_SUFFIX)) {
    throw new LocalOwnerPepperUnavailableError();
  }
  const encoded = value.slice(0, -KEY_SUFFIX.length);
  let decoded: Buffer | undefined;
  try {
    decoded = Buffer.from(encoded, 'base64url');
    const result = decoded.toString('utf8');
    if (
      encoded.length === 0 ||
      decoded.toString('base64url') !== encoded ||
      fileName(keyId(result)) !== value
    ) {
      throw new LocalOwnerPepperUnavailableError();
    }
    return result;
  } catch (error) {
    if (error instanceof LocalOwnerPepperUnavailableError) throw error;
    throw new LocalOwnerPepperUnavailableError(error);
  } finally {
    decoded?.fill(0);
  }
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

function readKey(
  identity: DirectoryIdentity,
  pepperKeyId: string,
): Readonly<LocalOwnerPepperKeyMaterial> | null {
  verifyDirectory(identity);
  const target = path.join(identity.path, fileName(pepperKeyId));
  let descriptor: number | undefined;
  let material: Buffer | undefined;
  try {
    descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      Number(stat.uid) !== identity.uid ||
      (Number(stat.mode) & 0o777) !== 0o600 ||
      stat.size < 32n ||
      stat.size > 256n
    ) {
      throw new LocalOwnerPepperUnavailableError();
    }
    material = fs.readFileSync(descriptor);
    const pepper = material.toString('utf8');
    if (!/^[A-Za-z0-9_-]+$/.test(pepper)) {
      throw new LocalOwnerPepperUnavailableError();
    }
    assertApiCredentialPepper(pepper);
    verifyDirectory(identity);
    return Object.freeze({ pepperKeyId, pepper, summary: summary(material) });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      verifyDirectory(identity);
      return null;
    }
    if (error instanceof LocalOwnerPepperUnavailableError) throw error;
    throw new LocalOwnerPepperUnavailableError(error);
  } finally {
    material?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function audit(identity: DirectoryIdentity): readonly string[] {
  verifyDirectory(identity);
  const directory = fs.opendirSync(identity.path);
  const keys: string[] = [];
  try {
    for (let index = 0; index <= MAX_LOCAL_OWNER_PEPPER_KEYS; index += 1) {
      const entry = directory.readSync();
      if (!entry) break;
      if (index === MAX_LOCAL_OWNER_PEPPER_KEYS || !entry.isFile()) {
        throw new LocalOwnerPepperUnavailableError();
      }
      const id = decodeFileName(entry.name);
      if (keys.includes(id) || !readKey(identity, id)) {
        throw new LocalOwnerPepperUnavailableError();
      }
      keys.push(id);
    }
  } catch (error) {
    if (error instanceof LocalOwnerPepperUnavailableError) throw error;
    throw new LocalOwnerPepperUnavailableError(error);
  } finally {
    directory.closeSync();
  }
  verifyDirectory(identity);
  return Object.freeze(keys.sort());
}

export function localOwnerPepperKeyPath(
  keyringDirectory: string,
  pepperKeyId: string,
): string {
  return path.join(
    boundedDirectory(keyringDirectory),
    fileName(keyId(pepperKeyId)),
  );
}

export class LocalOwnerPepperKeyringFileProvider {
  private readonly identity: DirectoryIdentity;

  constructor(keyringDirectory: string) {
    this.identity = directoryIdentity(boundedDirectory(keyringDirectory));
    audit(this.identity);
  }

  inspect(): Readonly<LocalOwnerPepperKeyringSummary> {
    return Object.freeze({ version: 1, keyIds: audit(this.identity) });
  }

  resolve(pepperKeyId: string): Readonly<LocalOwnerPepperKeyMaterial> | null {
    return readKey(this.identity, keyId(pepperKeyId));
  }
}

export function provisionLocalOwnerPepperKey(
  options: ProvisionLocalOwnerPepperKeyOptions,
): Readonly<LocalOwnerPepperSummary> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, [
      'keyringDirectory',
      'pepperKeyId',
      ...(options.randomBytes === undefined ? [] : ['randomBytes']),
    ]) ||
    (options.randomBytes !== undefined &&
      typeof options.randomBytes !== 'function')
  ) {
    throw new LocalOwnerPepperConfigurationError('options shape is invalid');
  }
  const keyringDirectory = boundedDirectory(options.keyringDirectory);
  const identity = directoryIdentity(keyringDirectory);
  if (audit(identity).length >= MAX_LOCAL_OWNER_PEPPER_KEYS) {
    throw new LocalOwnerPepperUnavailableError();
  }
  const pepperKeyId = keyId(options.pepperKeyId);
  return provisionLocalOwnerPepper({
    deploymentRoot: keyringDirectory,
    pepperPath: localOwnerPepperKeyPath(keyringDirectory, pepperKeyId),
    ...(options.randomBytes === undefined
      ? {}
      : { randomBytes: options.randomBytes }),
  });
}

export function backupLocalOwnerPepperKey(
  options: BackupLocalOwnerPepperKeyOptions,
): Readonly<LocalOwnerPepperSummary> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, ['backupDirectory', 'keyringDirectory', 'pepperKeyId'])
  ) {
    throw new LocalOwnerPepperConfigurationError('options shape is invalid');
  }
  const keyringDirectory = boundedDirectory(options.keyringDirectory);
  const backupDirectory = boundedDirectory(options.backupDirectory);
  const pepperKeyId = keyId(options.pepperKeyId);
  return backupLocalOwnerPepper({
    deploymentRoot: keyringDirectory,
    pepperPath: localOwnerPepperKeyPath(keyringDirectory, pepperKeyId),
    backupRoot: backupDirectory,
    backupPath: localOwnerPepperKeyPath(backupDirectory, pepperKeyId),
  });
}

export function restoreLocalOwnerPepperKey(
  options: RestoreLocalOwnerPepperKeyOptions,
): Readonly<LocalOwnerPepperSummary> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, ['backupDirectory', 'keyringDirectory', 'pepperKeyId'])
  ) {
    throw new LocalOwnerPepperConfigurationError('options shape is invalid');
  }
  const keyringDirectory = boundedDirectory(options.keyringDirectory);
  const backupDirectory = boundedDirectory(options.backupDirectory);
  const pepperKeyId = keyId(options.pepperKeyId);
  return restoreLocalOwnerPepper({
    deploymentRoot: keyringDirectory,
    pepperPath: localOwnerPepperKeyPath(keyringDirectory, pepperKeyId),
    backupRoot: backupDirectory,
    backupPath: localOwnerPepperKeyPath(backupDirectory, pepperKeyId),
  });
}
