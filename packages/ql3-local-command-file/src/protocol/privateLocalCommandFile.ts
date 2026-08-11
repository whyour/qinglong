import fs from 'node:fs';
import path from 'node:path';

const MAX_COMMAND_FILE_BYTES = 16 * 1024;
export const MAX_PRIVATE_LOCAL_JSON_FILE_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 4096;

export interface ReadPrivateLocalJsonFileOptions {
  readonly maxBytes: number;
}

export class PrivateLocalCommandFileError extends TypeError {
  readonly code = 'PRIVATE_LOCAL_COMMAND_FILE_INVALID';

  constructor(message: string, readonly cause?: unknown) {
    super(`Private local command file is invalid: ${message}`);
    this.name = 'PrivateLocalCommandFileError';
  }
}

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function'
  ) {
    throw new PrivateLocalCommandFileError(
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
    throw new PrivateLocalCommandFileError(
      'real and effective POSIX users must match',
    );
  }
  return uid;
}

function commandPath(value: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    Buffer.byteLength(value) < 1 ||
    Buffer.byteLength(value) > MAX_PATH_BYTES ||
    value.includes('\0') ||
    path.normalize(value) !== value
  ) {
    throw new PrivateLocalCommandFileError(
      'path must be normalized, bounded and absolute',
    );
  }
  return value;
}

function readLimit(value: ReadPrivateLocalJsonFileOptions): number {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes < 1 ||
    value.maxBytes > MAX_PRIVATE_LOCAL_JSON_FILE_BYTES
  ) {
    throw new PrivateLocalCommandFileError('read options are invalid');
  }
  return value.maxBytes;
}

export function readPrivateLocalJsonFile(
  candidatePath: string,
  options: ReadPrivateLocalJsonFileOptions,
): unknown {
  const filePath = commandPath(candidatePath);
  const maxBytes = readLimit(options);
  const uid = currentUid();
  let descriptor: number | undefined;
  let material: Buffer | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      (Number(before.mode) & 0o777) !== 0o600 ||
      before.size < 1n ||
      before.size > BigInt(maxBytes)
    ) {
      throw new PrivateLocalCommandFileError(
        'file must be a bounded private regular file',
      );
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      Number(opened.uid) !== uid ||
      (Number(opened.mode) & 0o777) !== 0o600
    ) {
      throw new PrivateLocalCommandFileError(
        'file identity changed while opening',
      );
    }
    material = Buffer.allocUnsafe(Number(opened.size) + 1);
    let offset = 0;
    while (offset < material.byteLength) {
      const bytesRead = fs.readSync(
        descriptor,
        material,
        offset,
        material.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      offset !== Number(opened.size) ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      Number(after.uid) !== uid ||
      (Number(after.mode) & 0o777) !== 0o600
    ) {
      throw new PrivateLocalCommandFileError(
        'file identity changed while reading',
      );
    }
    material = material.subarray(0, offset);
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(material),
    ) as unknown;
  } catch (error) {
    if (error instanceof PrivateLocalCommandFileError) throw error;
    throw new PrivateLocalCommandFileError('file cannot be read', error);
  } finally {
    material?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readPrivateLocalCommandFile(candidatePath: string): unknown {
  return readPrivateLocalJsonFile(candidatePath, {
    maxBytes: MAX_COMMAND_FILE_BYTES,
  });
}
