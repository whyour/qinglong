import fs from 'node:fs';
import path from 'node:path';

import { LocalDeploymentConfigurationError } from './contract';

const MAX_PUBLISHED_FILE_BYTES = 64 * 1024;

export function validatePrivateDirectory(
  directory: string,
  uid: number,
  label: string,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    throw new LocalDeploymentConfigurationError(`${label} is unavailable`, {
      cause: error,
    });
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(directory) !== directory
  ) {
    throw new LocalDeploymentConfigurationError(
      `${label} must be a canonical current-UID 0700 directory`,
    );
  }
}

export function ensurePrivateDirectory(
  directory: string,
  uid: number,
  label: string,
): 'prepared' | 'existing' {
  let created = false;
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new LocalDeploymentConfigurationError(
        `${label} cannot be created`,
        { cause: error },
      );
    }
  }
  validatePrivateDirectory(directory, uid, label);
  return created ? 'prepared' : 'existing';
}

function boundedBytes(contents: string, label: string): Buffer {
  const bytes = Buffer.from(contents, 'utf8');
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_PUBLISHED_FILE_BYTES) {
    throw new LocalDeploymentConfigurationError(`${label} has an invalid size`);
  }
  return bytes;
}

function fileStat(
  filePath: string,
  bytes: Buffer,
  mode: number,
  uid: number,
  allowedLinks: readonly number[],
  label: string,
): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new LocalDeploymentConfigurationError(`${label} is unavailable`, {
      cause: error,
    });
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== mode ||
    !allowedLinks.includes(stat.nlink) ||
    stat.size !== bytes.byteLength
  ) {
    throw new LocalDeploymentConfigurationError(`${label} identity is invalid`);
  }
  const actual = fs.readFileSync(filePath);
  if (!bytes.equals(actual)) {
    throw new LocalDeploymentConfigurationError(`${label} content drifted`);
  }
  return stat;
}

function stagePathFor(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.ql3-deploy-stage`,
  );
}

export function preflightPublishedFile(
  targetPath: string,
  contents: string,
  mode: number,
  uid: number,
  label: string,
): void {
  const bytes = boundedBytes(contents, label);
  const stagePath = stagePathFor(targetPath);
  const targetExists = fs.existsSync(targetPath);
  const stageExists = fs.existsSync(stagePath);
  const targetStat = targetExists
    ? fileStat(targetPath, bytes, mode, uid, [1, 2], label)
    : null;
  const stageStat = stageExists
    ? fileStat(stagePath, bytes, mode, uid, [1, 2], `${label} stage`)
    : null;
  if (
    (targetStat?.nlink === 2 || stageStat?.nlink === 2) &&
    (!targetStat ||
      !stageStat ||
      targetStat.dev !== stageStat.dev ||
      targetStat.ino !== stageStat.ino)
  ) {
    throw new LocalDeploymentConfigurationError(
      `${label} stage identity drifted`,
    );
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeStage(
  stagePath: string,
  bytes: Buffer,
  mode: number,
  uid: number,
  label: string,
): void {
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(
      stagePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      mode,
    );
    created = true;
    fs.fchmodSync(descriptor, mode);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1) {
      throw new LocalDeploymentConfigurationError(
        `${label} stage identity is invalid`,
      );
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = fs.writeSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
      );
      if (written < 1) {
        throw new LocalDeploymentConfigurationError(
          `${label} stage write stalled`,
        );
      }
      offset += written;
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (created) {
      try {
        fs.unlinkSync(stagePath);
      } catch {
        // A failed cleanup leaves a deterministic fail-closed stage.
      }
    }
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    throw new LocalDeploymentConfigurationError(
      `${label} stage cannot be written`,
      { cause: error },
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function publishExactFile(
  targetPath: string,
  contents: string,
  mode: number,
  uid: number,
  label: string,
): 'prepared' | 'existing' {
  const bytes = boundedBytes(contents, label);
  const directory = path.dirname(targetPath);
  const stagePath = stagePathFor(targetPath);
  preflightPublishedFile(targetPath, contents, mode, uid, label);
  const existed = fs.existsSync(targetPath);
  if (!fs.existsSync(stagePath) && !existed) {
    writeStage(stagePath, bytes, mode, uid, label);
  }
  if (!fs.existsSync(targetPath)) {
    try {
      fs.linkSync(stagePath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new LocalDeploymentConfigurationError(
          `${label} cannot be published`,
          { cause: error },
        );
      }
    }
    fsyncDirectory(directory);
  }
  fileStat(targetPath, bytes, mode, uid, [1, 2], label);
  if (fs.existsSync(stagePath)) {
    const targetStat = fs.lstatSync(targetPath);
    const stageStat = fileStat(
      stagePath,
      bytes,
      mode,
      uid,
      [1, 2],
      `${label} stage`,
    );
    if (
      stageStat.nlink === 2 &&
      (targetStat.dev !== stageStat.dev || targetStat.ino !== stageStat.ino)
    ) {
      throw new LocalDeploymentConfigurationError(
        `${label} stage identity drifted`,
      );
    }
    fs.unlinkSync(stagePath);
    fsyncDirectory(directory);
  }
  fileStat(targetPath, bytes, mode, uid, [1], label);
  return existed ? 'existing' : 'prepared';
}

export function replaceExactFile(
  targetPath: string,
  expectedContents: string,
  nextContents: string,
  mode: number,
  uid: number,
  label: string,
): 'prepared' | 'existing' {
  const expectedBytes = boundedBytes(expectedContents, `${label} expected`);
  const nextBytes = boundedBytes(nextContents, `${label} next`);
  if (expectedBytes.equals(nextBytes)) {
    throw new LocalDeploymentConfigurationError(
      `${label} replacement must change content`,
    );
  }
  const directory = path.dirname(targetPath);
  const stagePath = stagePathFor(targetPath);
  let targetBytes: Buffer;
  try {
    targetBytes = fs.readFileSync(targetPath);
  } catch (error) {
    throw new LocalDeploymentConfigurationError(`${label} is unavailable`, {
      cause: error,
    });
  }
  if (targetBytes.equals(nextBytes)) {
    fileStat(targetPath, nextBytes, mode, uid, [1], label);
    if (fs.existsSync(stagePath)) {
      fileStat(stagePath, nextBytes, mode, uid, [1], `${label} stage`);
      fs.unlinkSync(stagePath);
      fsyncDirectory(directory);
    }
    return 'existing';
  }
  if (!targetBytes.equals(expectedBytes)) {
    throw new LocalDeploymentConfigurationError(
      `${label} content does not match the expected revision`,
    );
  }
  fileStat(targetPath, expectedBytes, mode, uid, [1], label);
  if (fs.existsSync(stagePath)) {
    fileStat(stagePath, nextBytes, mode, uid, [1], `${label} stage`);
  } else {
    writeStage(stagePath, nextBytes, mode, uid, label);
  }
  fileStat(targetPath, expectedBytes, mode, uid, [1], label);
  fs.renameSync(stagePath, targetPath);
  fsyncDirectory(directory);
  fileStat(targetPath, nextBytes, mode, uid, [1], label);
  return 'prepared';
}

export function syncPublishedDirectory(directory: string): void {
  fsyncDirectory(directory);
}
