import fs from 'node:fs';
import path from 'node:path';

export type LocalApplicationLifecycleReceiptFailure = (
  message: string,
  cause?: unknown,
) => never;

interface DirectoryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: number;
  readonly mode: number;
}

function isCode(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

function currentUid(fail: LocalApplicationLifecycleReceiptFailure): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== process.geteuid()
  ) {
    fail('real and effective POSIX users must match');
  }
  return process.getuid();
}

function privateDirectoryIdentity(
  directory: string,
  uid: number,
  fail: LocalApplicationLifecycleReceiptFailure,
): DirectoryIdentity {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    fail('receipt directory cannot be read', error);
  }
  const mode = Number(stat.mode) & 0o777;
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    (mode & 0o022) !== 0
  ) {
    fail('receipt directory must be an owner-controlled regular directory');
  }
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    uid,
    mode,
  });
}

function verifyDirectoryIdentity(
  directory: string,
  expected: Readonly<DirectoryIdentity>,
  fail: LocalApplicationLifecycleReceiptFailure,
): void {
  const current = privateDirectoryIdentity(directory, expected.uid, fail);
  if (
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.mode !== expected.mode
  ) {
    fail('receipt directory identity changed');
  }
}

function openStage(
  stagePath: string,
  uid: number,
  maximumBytes: number,
  fail: LocalApplicationLifecycleReceiptFailure,
): {
  readonly descriptor: number;
  readonly device: bigint;
  readonly inode: bigint;
} {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      stagePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (!isCode(error, 'EEXIST'))
      fail('receipt stage cannot be created', error);
    let before: fs.BigIntStats;
    try {
      before = fs.lstatSync(stagePath, { bigint: true });
    } catch (readError) {
      fail('existing receipt stage cannot be read', readError);
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      Number(before.uid) !== uid ||
      (Number(before.mode) & 0o777) !== 0o600 ||
      before.nlink !== 1n ||
      before.size > BigInt(maximumBytes)
    ) {
      fail('existing receipt stage is not a private regular file');
    }
    try {
      descriptor = fs.openSync(
        stagePath,
        fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
    } catch (openError) {
      fail('existing receipt stage cannot be opened', openError);
    }
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      Number(opened.uid) !== uid ||
      (Number(opened.mode) & 0o777) !== 0o600 ||
      opened.nlink !== 1n
    ) {
      fs.closeSync(descriptor);
      fail('receipt stage identity changed while opening');
    }
    fs.ftruncateSync(descriptor, 0);
  }
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (
    !opened.isFile() ||
    Number(opened.uid) !== uid ||
    (Number(opened.mode) & 0o777) !== 0o600 ||
    opened.nlink !== 1n
  ) {
    fs.closeSync(descriptor);
    fail('receipt stage is not a private regular file');
  }
  return Object.freeze({
    descriptor,
    device: opened.dev,
    inode: opened.ino,
  });
}

function writeAll(
  descriptor: number,
  material: Buffer,
  fail: LocalApplicationLifecycleReceiptFailure,
): void {
  let offset = 0;
  while (offset < material.byteLength) {
    const written = fs.writeSync(
      descriptor,
      material,
      offset,
      material.byteLength - offset,
    );
    if (written < 1) fail('receipt stage write made no progress');
    offset += written;
  }
}

function bestEffortSyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch {
    // Atomic visibility is already established. Some supported filesystems
    // reject directory fsync, so power-loss durability remains best effort.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function publishLocalApplicationLifecycleReceiptFile(options: {
  readonly targetPath: string;
  readonly contents: string;
  readonly maximumBytes: number;
  readonly fail: LocalApplicationLifecycleReceiptFailure;
  readonly isFailure: (error: unknown) => boolean;
}): string {
  const directory = path.dirname(options.targetPath);
  const stagePath = `${options.targetPath}.stage`;
  const uid = currentUid(options.fail);
  const directoryIdentity = privateDirectoryIdentity(
    directory,
    uid,
    options.fail,
  );
  const material = Buffer.from(options.contents, 'utf8');
  if (material.byteLength < 1 || material.byteLength > options.maximumBytes) {
    material.fill(0);
    options.fail('serialized receipt exceeds its byte limit');
  }
  let descriptor: number | undefined;
  try {
    const stage = openStage(stagePath, uid, options.maximumBytes, options.fail);
    descriptor = stage.descriptor;
    writeAll(descriptor, material, options.fail);
    fs.fsyncSync(descriptor);
    const written = fs.fstatSync(descriptor, { bigint: true });
    if (
      written.dev !== stage.device ||
      written.ino !== stage.inode ||
      written.size !== BigInt(material.byteLength) ||
      written.nlink !== 1n
    ) {
      options.fail('receipt stage identity changed while writing');
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    verifyDirectoryIdentity(directory, directoryIdentity, options.fail);
    fs.renameSync(stagePath, options.targetPath);
    const published = fs.lstatSync(options.targetPath, { bigint: true });
    if (
      !published.isFile() ||
      published.isSymbolicLink() ||
      published.dev !== stage.device ||
      published.ino !== stage.inode ||
      Number(published.uid) !== uid ||
      (Number(published.mode) & 0o777) !== 0o600 ||
      published.nlink !== 1n ||
      published.size !== BigInt(material.byteLength)
    ) {
      options.fail('published receipt identity is invalid');
    }
    bestEffortSyncDirectory(directory);
    return options.targetPath;
  } catch (error) {
    if (options.isFailure(error)) throw error;
    return options.fail('receipt cannot be published', error);
  } finally {
    material.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
