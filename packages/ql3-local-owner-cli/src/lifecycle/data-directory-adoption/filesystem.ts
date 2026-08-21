import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  LocalDataDirectoryAdoptionConfigurationError,
  type StageLocalDataDirectoryAdoptionCommand,
  type VerifyLocalDataDirectoryAdoptionCommand,
} from './contract';

const HASH_BUFFER_BYTES = 64 * 1024;
const MAX_RELATIVE_PATH_BYTES = 4_096;

export interface RootAuthority {
  readonly uid: number;
  readonly deploymentRoot: string;
  readonly dataRoot: string;
  readonly stagingRoot: string;
}

export interface CopyBudget {
  readonly maxEntries: number;
  readonly maxHashedBytes: number;
  readonly maxFileBytes: number;
  readonly maxDepth: number;
}

export interface MutableCopyBudget {
  entries: number;
  bytes: number;
}

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== process.geteuid()
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'real and effective POSIX users must match',
    );
  }
  return process.getuid();
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function assertPrivateDirectory(
  directoryPath: string,
  uid: number,
  label: string,
): fs.BigIntStats {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(directoryPath, { bigint: true });
  } catch (error) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      `${label} is unavailable`,
      error,
    );
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(uid) ||
    (stat.mode & 0o777n) !== 0o700n ||
    fs.realpathSync(directoryPath) !== directoryPath
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      `${label} must be an owner-controlled 0700 canonical directory`,
    );
  }
  return stat;
}

function assertMissing(candidate: string, label: string): void {
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    throw new LocalDataDirectoryAdoptionConfigurationError(
      `${label} cannot be inspected`,
      error,
    );
  }
  throw new LocalDataDirectoryAdoptionConfigurationError(
    `${label} must not already exist`,
  );
}

export function rootAuthority(
  options:
    | StageLocalDataDirectoryAdoptionCommand['options']
    | VerifyLocalDataDirectoryAdoptionCommand['options'],
  requireMissing: boolean,
): Readonly<RootAuthority> {
  const uid = currentUid();
  assertPrivateDirectory(options.deploymentRoot, uid, 'deploymentRoot');
  if (
    !inside(options.deploymentRoot, options.stagingRoot) ||
    options.dataRoot === options.stagingRoot ||
    inside(options.dataRoot, options.stagingRoot) ||
    inside(options.stagingRoot, options.dataRoot)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'stagingRoot must be isolated inside deploymentRoot',
    );
  }
  const stagingParent = path.dirname(options.stagingRoot);
  if (
    stagingParent !== options.deploymentRoot &&
    !inside(options.deploymentRoot, stagingParent)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'stagingRoot parent must remain inside deploymentRoot',
    );
  }
  assertPrivateDirectory(stagingParent, uid, 'stagingRoot parent');
  const expectedSource = path.join(options.dataRoot, 'db', 'database.sqlite');
  if (options.sqlite.sourcePath !== expectedSource) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'SQLite activation source must be the reviewed primary database',
    );
  }
  for (const candidate of [
    options.sqlite.targetPath,
    options.sqlite.recoveryPath,
    options.sqlite.manifestPath,
    options.sqlite.activationPath,
  ]) {
    if (candidate === options.dataRoot || inside(options.dataRoot, candidate)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'SQLite adoption evidence must remain outside dataRoot',
      );
    }
  }
  if (requireMissing) assertMissing(options.stagingRoot, 'stagingRoot');
  else assertPrivateDirectory(options.stagingRoot, uid, 'stagingRoot');
  return Object.freeze({
    uid,
    deploymentRoot: options.deploymentRoot,
    dataRoot: options.dataRoot,
    stagingRoot: options.stagingRoot,
  });
}

export function sameStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function sortedNames(directoryPath: string): readonly string[] {
  return fs
    .readdirSync(directoryPath)
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
    );
}

function assertRelativePath(value: string): void {
  if (
    value.length < 1 ||
    path.isAbsolute(value) ||
    value === '..' ||
    value.startsWith(`..${path.sep}`) ||
    Buffer.byteLength(value, 'utf8') > MAX_RELATIVE_PATH_BYTES
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'payload relative path is invalid or too long',
    );
  }
}

export function syncDirectory(directoryPath: string): void {
  const descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writeExclusiveJson(filePath: string, value: object): void {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function copyStableFile(
  sourcePath: string,
  destinationPath: string,
  expected: fs.BigIntStats,
): void {
  const source = fs.openSync(
    sourcePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let destination: number | undefined;
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    const before = fs.fstatSync(source, { bigint: true });
    if (!before.isFile() || !sameStat(expected, before)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'source file identity changed before staging',
      );
    }
    destination = fs.openSync(destinationPath, 'wx', 0o600);
    for (;;) {
      const count = fs.readSync(source, buffer, 0, buffer.length, null);
      if (count === 0) break;
      let offset = 0;
      while (offset < count) {
        offset += fs.writeSync(
          destination,
          buffer,
          offset,
          count - offset,
          null,
        );
      }
    }
    fs.fsyncSync(destination);
    if (!sameStat(before, fs.fstatSync(source, { bigint: true }))) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'source file changed during staging',
      );
    }
  } finally {
    buffer.fill(0);
    if (destination !== undefined) fs.closeSync(destination);
    fs.closeSync(source);
  }
}

function shouldExcludeDatabaseEntry(
  category: string,
  relative: string,
): boolean {
  return (
    category === 'db' &&
    /^(?:database\.sqlite|database\.sqlite-(?:wal|shm|journal))$/.test(relative)
  );
}

export function copyCategory(
  sourceRoot: string,
  destinationRoot: string,
  category: string,
  uid: number,
  limits: Readonly<CopyBudget>,
  shared: MutableCopyBudget,
): void {
  const sourceCategory = path.join(sourceRoot, category);
  let categoryStat: fs.BigIntStats;
  try {
    categoryStat = fs.lstatSync(sourceCategory, { bigint: true });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }
  if (
    !categoryStat.isDirectory() ||
    categoryStat.isSymbolicLink() ||
    categoryStat.uid !== BigInt(uid) ||
    (categoryStat.mode & 0o022n) !== 0n
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'source category identity is unsafe',
    );
  }
  const destinationCategory = path.join(destinationRoot, category);
  fs.mkdirSync(destinationCategory, { mode: 0o700 });

  const visit = (
    sourceDirectory: string,
    destinationDirectory: string,
    expectedDirectory: fs.BigIntStats,
    depth: number,
  ): void => {
    if (depth > limits.maxDepth) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'source payload depth exceeds the Profile budget',
      );
    }
    for (const name of sortedNames(sourceDirectory)) {
      const sourceEntry = path.join(sourceDirectory, name);
      const categoryRelative = path.relative(sourceCategory, sourceEntry);
      assertRelativePath(categoryRelative);
      if (shouldExcludeDatabaseEntry(category, categoryRelative)) continue;
      shared.entries += 1;
      if (shared.entries > limits.maxEntries) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'source payload entry count exceeds the Profile budget',
        );
      }
      const destinationEntry = path.join(destinationDirectory, name);
      const stat = fs.lstatSync(sourceEntry, { bigint: true });
      if (
        stat.isSymbolicLink() ||
        stat.uid !== BigInt(uid) ||
        (stat.mode & 0o022n) !== 0n
      ) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'source payload entry identity is unsafe',
        );
      }
      if (stat.isDirectory()) {
        fs.mkdirSync(destinationEntry, { mode: 0o700 });
        visit(sourceEntry, destinationEntry, stat, depth + 1);
        syncDirectory(destinationEntry);
      } else if (stat.isFile() && stat.nlink === 1n) {
        if (
          stat.size < 0n ||
          stat.size > BigInt(limits.maxFileBytes) ||
          stat.size > BigInt(Number.MAX_SAFE_INTEGER)
        ) {
          throw new LocalDataDirectoryAdoptionConfigurationError(
            'source payload file exceeds the Profile budget',
          );
        }
        const bytes = Number(stat.size);
        if (
          !Number.isSafeInteger(shared.bytes + bytes) ||
          shared.bytes + bytes > limits.maxHashedBytes
        ) {
          throw new LocalDataDirectoryAdoptionConfigurationError(
            'source payload bytes exceed the Profile budget',
          );
        }
        shared.bytes += bytes;
        copyStableFile(sourceEntry, destinationEntry, stat);
      } else {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'source payload entry kind is unsafe',
        );
      }
    }
    if (
      !sameStat(
        expectedDirectory,
        fs.lstatSync(sourceDirectory, { bigint: true }),
      )
    ) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'source directory changed during staging',
      );
    }
  };

  visit(sourceCategory, destinationCategory, categoryStat, 1);
  syncDirectory(destinationCategory);
}

export function stableFileDigest(
  filePath: string,
  expected: fs.BigIntStats,
): string {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameStat(expected, before)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'staged file identity changed before verification',
      );
    }
    const hash = crypto.createHash('sha256');
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    if (!sameStat(before, fs.fstatSync(descriptor, { bigint: true }))) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'staged file changed during verification',
      );
    }
    return hash.digest('hex');
  } finally {
    buffer.fill(0);
    fs.closeSync(descriptor);
  }
}
