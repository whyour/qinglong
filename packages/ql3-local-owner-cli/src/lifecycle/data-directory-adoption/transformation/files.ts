import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { LocalDataDirectoryAdoptionConfigurationError } from '../contract';
import {
  assertPrivateDirectory,
  rootAuthority,
  sameStat,
  sortedNames,
  stableFileDigest,
  syncDirectory,
  type RootAuthority,
} from '../filesystem';
import type {
  TransformLocalDataDirectoryAdoptionCommand,
  VerifyLocalDataDirectoryAdoptionTransformationCommand,
} from '../contract';

const MAX_RELATIVE_PATH_BYTES = 4_096;

export interface TransformationAuthority extends RootAuthority {
  readonly transformationRoot: string;
}

export interface PrivateTreeEvidence {
  readonly entries: number;
  readonly directories: number;
  readonly files: number;
  readonly bytes: number;
  readonly digest: string;
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

function assertMissing(candidate: string): void {
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
      'transformationRoot cannot be inspected',
      error,
    );
  }
  throw new LocalDataDirectoryAdoptionConfigurationError(
    'transformationRoot must not already exist',
  );
}

export function transformationAuthority(
  options:
    | TransformLocalDataDirectoryAdoptionCommand['options']
    | VerifyLocalDataDirectoryAdoptionTransformationCommand['options'],
  requireMissing: boolean,
): Readonly<TransformationAuthority> {
  const stage = rootAuthority(
    {
      deploymentRoot: options.deploymentRoot,
      dataRoot: options.dataRoot,
      stagingRoot: options.stagingRoot,
      profile: options.profile,
      sqlite: options.sqlite,
      expectedManifestDigest: options.expectedManifestDigest,
    },
    false,
  );
  const target = options.transformationRoot;
  if (
    !inside(stage.deploymentRoot, target) ||
    target === stage.dataRoot ||
    target === stage.stagingRoot ||
    inside(stage.dataRoot, target) ||
    inside(target, stage.dataRoot) ||
    inside(stage.stagingRoot, target) ||
    inside(target, stage.stagingRoot)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      'transformationRoot must be isolated inside deploymentRoot',
    );
  }
  assertPrivateDirectory(
    path.dirname(target),
    stage.uid,
    'transformationRoot parent',
  );
  if (requireMissing) assertMissing(target);
  else assertPrivateDirectory(target, stage.uid, 'transformationRoot');
  return Object.freeze({ ...stage, transformationRoot: target });
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
      'transformation relative path is invalid',
    );
  }
}

function privateFileStat(
  filePath: string,
  uid: number,
  label: string,
): fs.BigIntStats {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.uid !== BigInt(uid) ||
    (stat.mode & 0o777n) !== 0o600n
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      `${label} identity or mode is invalid`,
    );
  }
  return stat;
}

export function optionalPrivateDirectory(
  directoryPath: string,
  uid: number,
  label: string,
): fs.BigIntStats | null {
  try {
    return assertPrivateDirectory(directoryPath, uid, label);
  } catch (error) {
    if (
      error instanceof LocalDataDirectoryAdoptionConfigurationError &&
      error.cause &&
      typeof error.cause === 'object' &&
      'code' in error.cause &&
      error.cause.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

export function readStablePrivateUtf8File(
  filePath: string,
  uid: number,
  maximumBytes: number,
  label: string,
): string {
  const expected = privateFileStat(filePath, uid, label);
  if (
    expected.size < 0n ||
    expected.size > BigInt(maximumBytes) ||
    expected.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new LocalDataDirectoryAdoptionConfigurationError(
      `${label} exceeds its byte budget`,
    );
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let bytes: Buffer | undefined;
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStat(expected, before)) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        `${label} identity changed before reading`,
      );
    }
    bytes = fs.readFileSync(descriptor);
    if (!sameStat(before, fs.fstatSync(descriptor, { bigint: true }))) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        `${label} changed while reading`,
      );
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof LocalDataDirectoryAdoptionConfigurationError) {
      throw error;
    }
    throw new LocalDataDirectoryAdoptionConfigurationError(
      `${label} is not valid UTF-8`,
      error,
    );
  } finally {
    bytes?.fill(0);
    fs.closeSync(descriptor);
  }
}

export function writePrivateJson(filePath: string, value: object): void {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  try {
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
    bytes.fill(0);
    fs.closeSync(descriptor);
  }
}

export function summarizePrivateTree(
  root: string,
  uid: number,
): Readonly<PrivateTreeEvidence> {
  const rootStat = assertPrivateDirectory(
    root,
    uid,
    'transformation input category',
  );
  let entries = 0;
  let directories = 0;
  let files = 0;
  let bytes = 0;
  const hash = crypto.createHash('sha256');
  const visit = (directoryPath: string, expected: fs.BigIntStats): void => {
    for (const name of sortedNames(directoryPath)) {
      const entryPath = path.join(directoryPath, name);
      const relative = path.relative(root, entryPath);
      assertRelativePath(relative);
      const stat = fs.lstatSync(entryPath, { bigint: true });
      entries += 1;
      if (
        stat.isSymbolicLink() ||
        stat.uid !== BigInt(uid) ||
        (stat.mode & 0o777n) !== (stat.isDirectory() ? 0o700n : 0o600n)
      ) {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'transformation input identity or mode is invalid',
        );
      }
      const canonical = relative.split(path.sep).join('/');
      if (stat.isDirectory()) {
        directories += 1;
        hash.update(
          `${JSON.stringify({ relative: canonical, kind: 'directory' })}\n`,
        );
        visit(entryPath, stat);
      } else if (stat.isFile() && stat.nlink === 1n) {
        if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new LocalDataDirectoryAdoptionConfigurationError(
            'transformation input file size is unsupported',
          );
        }
        const count = Number(stat.size);
        if (!Number.isSafeInteger(bytes + count)) {
          throw new LocalDataDirectoryAdoptionConfigurationError(
            'transformation input byte total is unsupported',
          );
        }
        bytes += count;
        files += 1;
        hash.update(
          `${JSON.stringify({
            relative: canonical,
            kind: 'file',
            bytes: count,
            contentDigest: stableFileDigest(entryPath, stat),
          })}\n`,
        );
      } else {
        throw new LocalDataDirectoryAdoptionConfigurationError(
          'transformation input entry kind is invalid',
        );
      }
    }
    if (!sameStat(expected, fs.lstatSync(directoryPath, { bigint: true }))) {
      throw new LocalDataDirectoryAdoptionConfigurationError(
        'transformation input directory changed while reading',
      );
    }
  };
  visit(root, rootStat);
  return Object.freeze({
    entries,
    directories,
    files,
    bytes,
    digest: hash.digest('hex'),
  });
}

export function finishPrivateDirectory(directoryPath: string): void {
  syncDirectory(directoryPath);
}
