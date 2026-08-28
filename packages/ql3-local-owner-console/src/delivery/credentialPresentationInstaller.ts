import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeLocalOwnerBootstrapSecretDeliveryRecord } from './secret-delivery/ceremonyContracts';
import { formatApiCredentialToken } from '@qinglong/runtime-core/api-credential-token';

const MAX_PATH_BYTES = 4096;
const MAX_DELIVERY_BYTES = 4 * 1024;
const MAX_PRESENTATION_BYTES = 1024;

export interface InstallLocalOwnerCredentialPresentationOptions {
  readonly deploymentRoot: string;
  readonly deliveryFilePath: string;
  readonly destinationFilePath: string;
}

export interface LocalOwnerCredentialPresentationInstallSummary {
  readonly status: 'installed' | 'existing';
  readonly credentialMutationId: string;
}

export class LocalOwnerCredentialPresentationInstallError extends Error {
  readonly code = 'LOCAL_OWNER_CREDENTIAL_PRESENTATION_INSTALL_FAILED';

  constructor(message: string, readonly cause?: unknown) {
    super(`Local Owner credential presentation install failed: ${message}`);
    this.name = 'LocalOwnerCredentialPresentationInstallError';
  }
}

interface PrivateFile {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
}

function boundedPath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new LocalOwnerCredentialPresentationInstallError(
      `${label} must be a bounded normalized absolute non-root path`,
    );
  }
  return value;
}

function uid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== process.geteuid()
  ) {
    throw new LocalOwnerCredentialPresentationInstallError(
      'a stable POSIX user is required',
    );
  }
  return process.getuid();
}

function descendant(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new LocalOwnerCredentialPresentationInstallError(
      `${label} must be a descendant of deploymentRoot`,
    );
  }
}

function privateDirectory(
  directoryPath: string,
  ownerUid: number,
): PrivateFile {
  const stat = fs.lstatSync(directoryPath, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== ownerUid ||
    (Number(stat.mode) & 0o777) !== 0o700
  ) {
    throw new LocalOwnerCredentialPresentationInstallError(
      'authority directories must be private owned real directories',
    );
  }
  return Object.freeze({ device: stat.dev, inode: stat.ino, size: stat.size });
}

function privateFile(
  filePath: string,
  ownerUid: number,
  maximumBytes: number,
): PrivateFile {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== ownerUid ||
    (Number(stat.mode) & 0o777) !== 0o600 ||
    stat.size < 1n ||
    stat.size > BigInt(maximumBytes)
  ) {
    throw new LocalOwnerCredentialPresentationInstallError(
      'authority files must be bounded private owned regular files',
    );
  }
  return Object.freeze({ device: stat.dev, inode: stat.ino, size: stat.size });
}

function sameDirectory(
  directoryPath: string,
  ownerUid: number,
  expected: PrivateFile,
): void {
  const current = privateDirectory(directoryPath, ownerUid);
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new LocalOwnerCredentialPresentationInstallError(
      'destination directory identity changed during installation',
    );
  }
}

function readPrivateJson(
  filePath: string,
  ownerUid: number,
  maximumBytes: number,
): unknown {
  const expected = privateFile(filePath, ownerUid, maximumBytes);
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let material: Buffer | undefined;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== expected.device ||
      opened.ino !== expected.inode ||
      opened.size !== expected.size
    ) {
      throw new LocalOwnerCredentialPresentationInstallError(
        'authority file identity changed while opening',
      );
    }
    material = fs.readFileSync(descriptor);
    return JSON.parse(material.toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof LocalOwnerCredentialPresentationInstallError) {
      throw error;
    }
    throw new LocalOwnerCredentialPresentationInstallError(
      'authority file is invalid',
      error,
    );
  } finally {
    material?.fill(0);
    fs.closeSync(descriptor);
  }
}

function presentation(value: unknown): Readonly<{
  schemaVersion: 1;
  kind: 'qinglong3-local-identity-credential-presentation';
  token: string;
}> {
  const record = normalizeLocalOwnerBootstrapSecretDeliveryRecord(value);
  if (record.kind !== 'credential') {
    throw new LocalOwnerCredentialPresentationInstallError(
      'delivery is not a credential record',
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'qinglong3-local-identity-credential-presentation',
    token: formatApiCredentialToken(record.credentialId, record.secret),
  });
}

function existingPresentation(
  filePath: string,
  ownerUid: number,
  expected: ReturnType<typeof presentation>,
): boolean {
  const current = readPrivateJson(filePath, ownerUid, MAX_PRESENTATION_BYTES);
  return JSON.stringify(current) === JSON.stringify(expected);
}

function syncDirectory(directoryPath: string): void {
  const descriptor = fs.openSync(directoryPath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function installLocalOwnerCredentialPresentation(
  options: InstallLocalOwnerCredentialPresentationOptions,
): Readonly<LocalOwnerCredentialPresentationInstallSummary> {
  try {
    const deploymentRoot = boundedPath(
      options?.deploymentRoot,
      'deploymentRoot',
    );
    const deliveryFilePath = boundedPath(
      options?.deliveryFilePath,
      'deliveryFilePath',
    );
    const destinationFilePath = boundedPath(
      options?.destinationFilePath,
      'destinationFilePath',
    );
    descendant(deploymentRoot, deliveryFilePath, 'deliveryFilePath');
    descendant(deploymentRoot, destinationFilePath, 'destinationFilePath');
    if (deliveryFilePath === destinationFilePath) {
      throw new LocalOwnerCredentialPresentationInstallError(
        'delivery and destination files must be distinct',
      );
    }
    const ownerUid = uid();
    const rootIdentity = privateDirectory(deploymentRoot, ownerUid);
    const destinationDirectory = path.dirname(destinationFilePath);
    const destinationDirectoryIdentity = privateDirectory(
      destinationDirectory,
      ownerUid,
    );
    const canonicalRoot = fs.realpathSync(deploymentRoot);
    const canonicalDelivery = fs.realpathSync(deliveryFilePath);
    const canonicalDestination = path.join(
      fs.realpathSync(destinationDirectory),
      path.basename(destinationFilePath),
    );
    descendant(canonicalRoot, canonicalDelivery, 'deliveryFilePath');
    descendant(canonicalRoot, canonicalDestination, 'destinationFilePath');
    const delivery = normalizeLocalOwnerBootstrapSecretDeliveryRecord(
      readPrivateJson(deliveryFilePath, ownerUid, MAX_DELIVERY_BYTES),
    );
    if (delivery.kind !== 'credential') {
      throw new LocalOwnerCredentialPresentationInstallError(
        'delivery is not a credential record',
      );
    }
    const expected = presentation(delivery);
    if (fs.existsSync(destinationFilePath)) {
      if (!existingPresentation(destinationFilePath, ownerUid, expected)) {
        throw new LocalOwnerCredentialPresentationInstallError(
          'destination conflicts with the delivered credential',
        );
      }
      return Object.freeze({
        status: 'existing',
        credentialMutationId: delivery.mutationId,
      });
    }
    const temporaryPath = path.join(
      destinationDirectory,
      `.owner-credential-presentation-${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        temporaryPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const serialized = `${JSON.stringify(expected)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > MAX_PRESENTATION_BYTES) {
        throw new LocalOwnerCredentialPresentationInstallError(
          'credential presentation exceeds its byte budget',
        );
      }
      fs.writeFileSync(descriptor, serialized, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      sameDirectory(
        destinationDirectory,
        ownerUid,
        destinationDirectoryIdentity,
      );
      fs.linkSync(temporaryPath, destinationFilePath);
      syncDirectory(destinationDirectory);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EEXIST' &&
        existingPresentation(destinationFilePath, ownerUid, expected)
      ) {
        return Object.freeze({
          status: 'existing',
          credentialMutationId: delivery.mutationId,
        });
      }
      if (error instanceof LocalOwnerCredentialPresentationInstallError) {
        throw error;
      }
      throw new LocalOwnerCredentialPresentationInstallError(
        'credential presentation could not be published',
        error,
      );
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporaryPath);
        syncDirectory(destinationDirectory);
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        ) {
          throw error;
        }
      }
    }
    sameDirectory(deploymentRoot, ownerUid, rootIdentity);
    sameDirectory(destinationDirectory, ownerUid, destinationDirectoryIdentity);
    if (!existingPresentation(destinationFilePath, ownerUid, expected)) {
      throw new LocalOwnerCredentialPresentationInstallError(
        'published credential presentation is invalid',
      );
    }
    return Object.freeze({
      status: 'installed',
      credentialMutationId: delivery.mutationId,
    });
  } catch (error) {
    if (error instanceof LocalOwnerCredentialPresentationInstallError) {
      throw error;
    }
    throw new LocalOwnerCredentialPresentationInstallError(
      'credential presentation installation failed closed',
      error,
    );
  }
}
