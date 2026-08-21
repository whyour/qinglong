import fs from 'node:fs';

import {
  LocalDataDirectoryApplicationCommitError,
  normalizeLocalDataDirectoryApplicationCommit,
  type LocalDataDirectoryApplicationCommit,
} from '@qinglong/local-sqlite/data-directory-application-commit';

import {
  LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V4,
  type LocalApplicationProcessConfig,
} from './processConfig';

const MAX_COMMIT_BYTES = 64 * 1024;

export class LocalApplicationLegacyDataCommitmentError extends Error {
  readonly code = 'QL3_LOCAL_APPLICATION_LEGACY_DATA_COMMITMENT_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(
      `Local application legacy data commitment is invalid: ${message}`,
      options,
    );
    this.name = 'LocalApplicationLegacyDataCommitmentError';
  }
}

function currentIdentity(): Readonly<{ uid: number; gid: number }> {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    typeof process.getgid !== 'function' ||
    typeof process.getegid !== 'function' ||
    process.getuid() !== process.geteuid() ||
    process.getgid() !== process.getegid()
  ) {
    throw new LocalApplicationLegacyDataCommitmentError(
      'real and effective POSIX identities must match',
    );
  }
  return Object.freeze({ uid: process.getuid(), gid: process.getgid() });
}

function readCommit(
  filePath: string,
): Readonly<LocalDataDirectoryApplicationCommit> {
  const identity = currentIdentity();
  let descriptor: number | undefined;
  let bytes: Buffer | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      Number(opened.uid) !== identity.uid ||
      Number(opened.gid) !== identity.gid ||
      (Number(opened.mode) & 0o777) !== 0o600 ||
      opened.nlink !== 1n ||
      opened.size < 2n ||
      opened.size > BigInt(MAX_COMMIT_BYTES)
    ) {
      throw new LocalApplicationLegacyDataCommitmentError(
        'commit file identity is invalid',
      );
    }
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      offset !== bytes.byteLength ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      after.uid !== opened.uid ||
      after.gid !== opened.gid ||
      after.mode !== opened.mode ||
      after.nlink !== opened.nlink
    ) {
      throw new LocalApplicationLegacyDataCommitmentError(
        'commit file identity changed while reading',
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch (error) {
      throw new LocalApplicationLegacyDataCommitmentError(
        'commit file is not canonical UTF-8 JSON',
        { cause: error },
      );
    }
    try {
      return normalizeLocalDataDirectoryApplicationCommit(value);
    } catch (error) {
      if (error instanceof LocalDataDirectoryApplicationCommitError) {
        throw new LocalApplicationLegacyDataCommitmentError(
          'commit document is invalid',
          { cause: error },
        );
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof LocalApplicationLegacyDataCommitmentError) throw error;
    throw new LocalApplicationLegacyDataCommitmentError(
      'commit file cannot be read',
      { cause: error },
    );
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function verifyLocalApplicationLegacyDataCommitment(
  config: Readonly<LocalApplicationProcessConfig>,
): Readonly<LocalDataDirectoryApplicationCommit> | undefined {
  if (config.schema !== LOCAL_APPLICATION_PROCESS_CONFIG_SCHEMA_V4) {
    return undefined;
  }
  const binding = config.legacyDataApplication;
  if (binding === undefined) {
    throw new LocalApplicationLegacyDataCommitmentError(
      'v4 binding is unavailable',
    );
  }
  const commit = readCommit(binding.commitPath);
  if (
    commit.profile !== config.profile ||
    commit.commitDigest !== binding.expectedCommitDigest ||
    commit.receiptDigest !== binding.expectedReceiptDigest
  ) {
    throw new LocalApplicationLegacyDataCommitmentError(
      'commit does not match the application binding',
    );
  }
  return commit;
}
