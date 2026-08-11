import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertApiCredentialPepperKeyId } from '@qinglong/runtime-core/api-credential';
import {
  LocalOwnerPepperConfigurationError,
  LocalOwnerPepperUnavailableError,
} from './pepperFile';
import { localOwnerPepperKeyPath } from './pepperKeyring';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

interface DirectoryIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: number;
}

export interface DestroyLocalOwnerPepperKeyOptions {
  readonly keyringDirectory: string;
  readonly pepperKeyId: string;
  readonly materialRole: 'runtime' | 'backup';
  readonly expectedMaterialDigest: string;
  readonly prepareMutationId: string;
}

export interface DestroyLocalOwnerPepperKeyResult {
  readonly status: 'destroyed' | 'absent';
  readonly pepperKeyId: string;
  readonly materialDigest: string;
  readonly destructionProofDigest: string;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
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
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    (Number(stat.mode) & 0o777) !== 0o700
  ) {
    throw new LocalOwnerPepperUnavailableError();
  }
  return Object.freeze({
    path: directory,
    device: stat.dev,
    inode: stat.ino,
    uid,
  });
}

function verifyDirectory(expected: DirectoryIdentity): void {
  const current = directoryIdentity(expected.path);
  if (
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.uid !== expected.uid
  ) {
    throw new LocalOwnerPepperUnavailableError();
  }
}

function proof(
  prepareMutationId: string,
  pepperKeyId: string,
  materialRole: 'runtime' | 'backup',
  materialDigest: string,
): string {
  return createHash('sha256')
    .update('qinglong.local-owner-pepper-material-destruction.v1\0', 'utf8')
    .update(prepareMutationId, 'utf8')
    .update('\0', 'utf8')
    .update(pepperKeyId, 'utf8')
    .update('\0', 'utf8')
    .update(materialRole, 'utf8')
    .update('\0', 'utf8')
    .update(materialDigest, 'utf8')
    .digest('hex');
}

function missing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export function destroyLocalOwnerPepperKey(
  options: DestroyLocalOwnerPepperKeyOptions,
): Readonly<DestroyLocalOwnerPepperKeyResult> {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !exactKeys(options, [
      'keyringDirectory',
      'pepperKeyId',
      'materialRole',
      'expectedMaterialDigest',
      'prepareMutationId',
    ]) ||
    typeof options.expectedMaterialDigest !== 'string' ||
    !DIGEST_PATTERN.test(options.expectedMaterialDigest) ||
    (options.materialRole !== 'runtime' && options.materialRole !== 'backup') ||
    typeof options.prepareMutationId !== 'string' ||
    !UUID_V4_PATTERN.test(options.prepareMutationId)
  ) {
    throw new LocalOwnerPepperConfigurationError('options shape is invalid');
  }
  try {
    assertApiCredentialPepperKeyId(options.pepperKeyId);
  } catch {
    throw new LocalOwnerPepperConfigurationError('pepperKeyId is invalid');
  }
  const target = localOwnerPepperKeyPath(
    options.keyringDirectory,
    options.pepperKeyId,
  );
  const directory = directoryIdentity(path.dirname(target));
  const destructionProofDigest = proof(
    options.prepareMutationId,
    options.pepperKeyId,
    options.materialRole,
    options.expectedMaterialDigest,
  );
  let descriptor: number | undefined;
  let material: Buffer | undefined;
  try {
    verifyDirectory(directory);
    try {
      descriptor = fs.openSync(
        target,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (!missing(error)) throw error;
      verifyDirectory(directory);
      return Object.freeze({
        status: 'absent' as const,
        pepperKeyId: options.pepperKeyId,
        materialDigest: options.expectedMaterialDigest,
        destructionProofDigest,
      });
    }
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      Number(opened.uid) !== directory.uid ||
      (Number(opened.mode) & 0o777) !== 0o600 ||
      opened.size < 32n ||
      opened.size > 256n
    ) {
      throw new LocalOwnerPepperUnavailableError();
    }
    material = fs.readFileSync(descriptor);
    const materialDigest = createHash('sha256')
      .update('qinglong.local-owner-pepper.summary.v1\0', 'utf8')
      .update(material)
      .digest('hex');
    if (materialDigest !== options.expectedMaterialDigest) {
      throw new LocalOwnerPepperUnavailableError();
    }
    verifyDirectory(directory);
    const current = fs.lstatSync(target, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      Number(current.uid) !== directory.uid ||
      (Number(current.mode) & 0o777) !== 0o600
    ) {
      throw new LocalOwnerPepperUnavailableError();
    }
    fs.unlinkSync(target);
    const directoryDescriptor = fs.openSync(directory.path, 'r');
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
    verifyDirectory(directory);
    try {
      fs.lstatSync(target);
      throw new LocalOwnerPepperUnavailableError();
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return Object.freeze({
      status: 'destroyed' as const,
      pepperKeyId: options.pepperKeyId,
      materialDigest: options.expectedMaterialDigest,
      destructionProofDigest,
    });
  } catch (error) {
    if (error instanceof LocalOwnerPepperUnavailableError) throw error;
    throw new LocalOwnerPepperUnavailableError(error);
  } finally {
    material?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
