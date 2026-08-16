import fs from 'node:fs';
import path from 'node:path';

import { LocalDeploymentConfigurationError } from '../foundation/error';

const MAX_FILE_BYTES = 1024 * 1024;

export interface OwnedPrivateJson {
  readonly uid: number;
  readonly gid: number;
  readonly value: unknown;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function validateServiceBridgeDirectory(
  directory: string,
  uid: number,
  gid: number | undefined,
  mode: number,
  label: string,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    configurationError(`${label} is unavailable`, error);
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (gid !== undefined && stat.gid !== gid) ||
    (stat.mode & 0o777) !== mode ||
    fs.realpathSync(directory) !== directory
  ) {
    configurationError(`${label} identity is invalid`);
  }
}

export function ensureRootServiceBridgeDirectory(
  directory: string,
  label: string,
): 'prepared' | 'existing' {
  let created = false;
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      configurationError(`${label} cannot be created`, error);
    }
  }
  validateServiceBridgeDirectory(directory, 0, 0, 0o700, label);
  return created ? 'prepared' : 'existing';
}

function readExactFile(
  filePath: string,
  expected: Readonly<{
    uid?: number;
    gid?: number;
    mode: number;
    maximumBytes?: number;
  }>,
  label: string,
): Readonly<{ uid: number; gid: number; bytes: Buffer }> {
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath, { bigint: true });
    const maximumBytes = expected.maximumBytes ?? MAX_FILE_BYTES;
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      (expected.uid !== undefined && Number(before.uid) !== expected.uid) ||
      (expected.gid !== undefined && Number(before.gid) !== expected.gid) ||
      (Number(before.mode) & 0o777) !== expected.mode ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes) ||
      fs.realpathSync(filePath) !== filePath
    ) {
      configurationError(`${label} identity is invalid`);
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
      opened.uid !== before.uid ||
      opened.gid !== before.gid ||
      (Number(opened.mode) & 0o777) !== expected.mode ||
      opened.nlink !== 1n
    ) {
      configurationError(`${label} identity changed while opening`);
    }
    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (read === 0) break;
      offset += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      offset !== bytes.byteLength ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.uid !== opened.uid ||
      after.gid !== opened.gid ||
      (Number(after.mode) & 0o777) !== expected.mode ||
      after.nlink !== 1n
    ) {
      bytes.fill(0);
      configurationError(`${label} identity changed while reading`);
    }
    return Object.freeze({
      uid: Number(after.uid),
      gid: Number(after.gid),
      bytes,
    });
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError(`${label} cannot be read`, error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readOwnerPrivateJsonFile(
  filePath: string,
  label: string,
): Readonly<OwnedPrivateJson> {
  const material = readExactFile(filePath, { mode: 0o600 }, label);
  try {
    return Object.freeze({
      uid: material.uid,
      gid: material.gid,
      value: JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(material.bytes),
      ) as unknown,
    });
  } catch (error) {
    return configurationError(`${label} JSON is invalid`, error);
  } finally {
    material.bytes.fill(0);
  }
}

export function readServiceBridgeFile(
  filePath: string,
  expected: Readonly<{
    uid: number;
    gid: number;
    mode: number;
    maximumBytes?: number;
  }>,
  label: string,
): Buffer {
  return readExactFile(filePath, expected, label).bytes;
}

function stagePathFor(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.ql3-service-bridge-stage`,
  );
}

function validatePublishedFile(
  filePath: string,
  bytes: Buffer,
  mode: number,
  uid: number,
  gid: number,
  allowedLinks: readonly number[],
  label: string,
): fs.Stats {
  const stat = fs.lstatSync(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    stat.gid !== gid ||
    (stat.mode & 0o777) !== mode ||
    !allowedLinks.includes(stat.nlink) ||
    stat.size !== bytes.byteLength ||
    !bytes.equals(fs.readFileSync(filePath))
  ) {
    configurationError(`${label} drifted`);
  }
  return stat;
}

function writeOwnedStage(
  stagePath: string,
  bytes: Buffer,
  mode: number,
  uid: number,
  gid: number,
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
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.uid !== 0 || opened.nlink !== 1) {
      configurationError(`${label} stage identity is invalid`);
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = fs.writeSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
      );
      if (written < 1) configurationError(`${label} stage write stalled`);
      offset += written;
    }
    fs.fchownSync(descriptor, uid, gid);
    fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      !after.isFile() ||
      after.uid !== uid ||
      after.gid !== gid ||
      (after.mode & 0o777) !== mode ||
      after.nlink !== 1 ||
      after.size !== bytes.byteLength
    ) {
      configurationError(`${label} stage ownership is invalid`);
    }
  } catch (error) {
    if (created) {
      try {
        fs.unlinkSync(stagePath);
      } catch {
        // A deterministic stage is intentionally left fail-closed.
      }
    }
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    configurationError(`${label} stage cannot be written`, error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function publishServiceBridgeFile(
  targetPath: string,
  contents: string,
  mode: number,
  uid: number,
  gid: number,
  label: string,
): 'prepared' | 'existing' {
  const bytes = Buffer.from(contents, 'utf8');
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_FILE_BYTES) {
    configurationError(`${label} has an invalid size`);
  }
  const directory = path.dirname(targetPath);
  const stagePath = stagePathFor(targetPath);
  const existed = fs.existsSync(targetPath);
  if (existed) {
    validatePublishedFile(targetPath, bytes, mode, uid, gid, [1, 2], label);
  }
  if (fs.existsSync(stagePath)) {
    validatePublishedFile(
      stagePath,
      bytes,
      mode,
      uid,
      gid,
      [1, 2],
      `${label} stage`,
    );
  } else if (!existed) {
    writeOwnedStage(stagePath, bytes, mode, uid, gid, label);
  }
  if (!fs.existsSync(targetPath)) {
    try {
      fs.linkSync(stagePath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        configurationError(`${label} cannot be published`, error);
      }
    }
    fsyncDirectory(directory);
  }
  const target = validatePublishedFile(
    targetPath,
    bytes,
    mode,
    uid,
    gid,
    [1, 2],
    label,
  );
  if (fs.existsSync(stagePath)) {
    const stage = validatePublishedFile(
      stagePath,
      bytes,
      mode,
      uid,
      gid,
      [1, 2],
      `${label} stage`,
    );
    if (target.dev !== stage.dev || target.ino !== stage.ino) {
      configurationError(`${label} stage identity drifted`);
    }
    fs.unlinkSync(stagePath);
    fsyncDirectory(directory);
  }
  validatePublishedFile(targetPath, bytes, mode, uid, gid, [1], label);
  return existed ? 'existing' : 'prepared';
}
