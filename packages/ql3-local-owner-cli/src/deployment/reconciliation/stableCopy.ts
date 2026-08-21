import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LocalDeploymentConfigurationError } from '../foundation/error';
import { syncPublishedDirectory } from '../foundation/files';
import { cutoverDigest } from '../cutover/targetEvidence';
import type { LocalReconciliationCaptureIntent } from './preparation';

const COPY_BUFFER_BYTES = 64 * 1024;
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

export interface LocalReconciliationCaptureSourceAsset {
  readonly logicalName:
    | 'target-main'
    | 'target-wal'
    | 'target-shm'
    | 'target-journal'
    | 'legacy-main'
    | 'legacy-wal'
    | 'legacy-shm'
    | 'legacy-journal'
    | 'recovery-main';
  readonly sourcePath: string;
  readonly requireNonEmpty: boolean;
}

export interface LocalReconciliationCapturedAsset {
  readonly logicalName: LocalReconciliationCaptureSourceAsset['logicalName'];
  readonly bytes: number;
  readonly sha256: string;
  readonly sourceIdentityDigest: string;
}

export interface LocalReconciliationStableCopyResult {
  readonly manifest: Readonly<LocalReconciliationCapturedAsset>;
  readonly sourceSnapshot: Readonly<{
    path: string;
    device: string;
    inode: string;
    uid: number;
    gid: number;
    mode: number;
    links: number;
    bytes: number;
    modifiedAtNs: string;
    changedAtNs: string;
  }>;
}

export interface LocalReconciliationStableCopyDependencies {
  readonly write?: (
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => number;
  readonly unlink?: (filePath: string) => void;
}

const CAPTURE_ASSET_FILE_NAMES: Readonly<
  Record<LocalReconciliationCaptureSourceAsset['logicalName'], string>
> = Object.freeze({
  'target-main': 'target.sqlite',
  'target-wal': 'target.sqlite-wal',
  'target-shm': 'target.sqlite-shm',
  'target-journal': 'target.sqlite-journal',
  'legacy-main': 'legacy.sqlite',
  'legacy-wal': 'legacy.sqlite-wal',
  'legacy-shm': 'legacy.sqlite-shm',
  'legacy-journal': 'legacy.sqlite-journal',
  'recovery-main': 'recovery.sqlite',
});

export function localReconciliationCaptureAssetFileName(
  logicalName: LocalReconciliationCaptureSourceAsset['logicalName'],
): string {
  return CAPTURE_ASSET_FILE_NAMES[logicalName];
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function sidecarExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return configurationError('SQLite sidecar cannot be inspected', error);
  }
}

export function localReconciliationSidecarSnapshot(
  mainPath: string,
): readonly boolean[] {
  return Object.freeze(
    SIDECAR_SUFFIXES.map((suffix) => sidecarExists(`${mainPath}${suffix}`)),
  );
}

export function localReconciliationCaptureAssetPlan(
  intent: Readonly<LocalReconciliationCaptureIntent>,
): Readonly<{
  assets: readonly Readonly<LocalReconciliationCaptureSourceAsset>[];
  targetSidecars: readonly boolean[];
  legacySidecars: readonly boolean[];
}> {
  const targetSidecars = localReconciliationSidecarSnapshot(
    intent.command.request.targetDatabasePath,
  );
  const legacySidecars = localReconciliationSidecarSnapshot(
    intent.command.request.legacySourcePath,
  );
  const assets: LocalReconciliationCaptureSourceAsset[] = [
    {
      logicalName: 'target-main',
      sourcePath: intent.command.request.targetDatabasePath,
      requireNonEmpty: true,
    },
    ...SIDECAR_SUFFIXES.flatMap((suffix, index) =>
      targetSidecars[index]
        ? [
            {
              logicalName: `target-${suffix.slice(
                1,
              )}` as LocalReconciliationCaptureSourceAsset['logicalName'],
              sourcePath: `${intent.command.request.targetDatabasePath}${suffix}`,
              requireNonEmpty: false,
            },
          ]
        : [],
    ),
    {
      logicalName: 'legacy-main',
      sourcePath: intent.command.request.legacySourcePath,
      requireNonEmpty: true,
    },
    ...SIDECAR_SUFFIXES.flatMap((suffix, index) =>
      legacySidecars[index]
        ? [
            {
              logicalName: `legacy-${suffix.slice(
                1,
              )}` as LocalReconciliationCaptureSourceAsset['logicalName'],
              sourcePath: `${intent.command.request.legacySourcePath}${suffix}`,
              requireNonEmpty: false,
            },
          ]
        : [],
    ),
    {
      logicalName: 'recovery-main',
      sourcePath: intent.command.request.recoveryPath,
      requireNonEmpty: true,
    },
  ];
  return Object.freeze({
    assets: Object.freeze(assets.map((asset) => Object.freeze(asset))),
    targetSidecars,
    legacySidecars,
  });
}

function sameStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function validateSource(
  filePath: string,
  stat: fs.BigIntStats,
  uid: number,
  requireNonEmpty: boolean,
): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(uid) ||
    stat.nlink !== 1n ||
    (stat.mode & 0o077n) !== 0n ||
    (requireNonEmpty && stat.size < 1n) ||
    stat.size > BigInt(Number.MAX_SAFE_INTEGER) ||
    fs.realpathSync(filePath) !== filePath
  ) {
    configurationError('capture source identity is invalid');
  }
}

function sourceSnapshot(
  filePath: string,
  stat: fs.BigIntStats,
): LocalReconciliationStableCopyResult['sourceSnapshot'] {
  return Object.freeze({
    path: filePath,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode),
    links: Number(stat.nlink),
    bytes: Number(stat.size),
    modifiedAtNs: stat.mtimeNs.toString(),
    changedAtNs: stat.ctimeNs.toString(),
  });
}

function hashDescriptor(
  descriptor: number,
  bytes: number,
  buffer: Buffer,
): string {
  const hash = crypto.createHash('sha256');
  let offset = 0;
  while (offset < bytes) {
    const count = fs.readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.byteLength, bytes - offset),
      offset,
    );
    if (count < 1) configurationError('capture file read stalled');
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  return hash.digest('hex');
}

function hashPrefix(descriptor: number, bytes: number, buffer: Buffer): string {
  return hashDescriptor(descriptor, bytes, buffer);
}

function validateOutputDescriptor(
  descriptor: number,
  uid: number,
  allowedLinks: readonly bigint[],
  allowedModes: readonly bigint[] = [0o600n],
): fs.BigIntStats {
  const stat = fs.fstatSync(descriptor, { bigint: true });
  if (
    !stat.isFile() ||
    stat.uid !== BigInt(uid) ||
    !allowedModes.includes(stat.mode & 0o777n) ||
    !allowedLinks.includes(stat.nlink) ||
    stat.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    configurationError('capture output identity is invalid');
  }
  return stat;
}

function verifyPublishedAsset(
  targetPath: string,
  uid: number,
  expectedBytes: number,
  expectedSha256: string,
  buffer: Buffer,
  allowedLinks: readonly bigint[] = [1n],
  allowedModes: readonly bigint[] = [0o600n],
): void {
  let descriptor: number | undefined;
  try {
    const pathStat = fs.lstatSync(targetPath, { bigint: true });
    descriptor = fs.openSync(
      targetPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = validateOutputDescriptor(
      descriptor,
      uid,
      allowedLinks,
      allowedModes,
    );
    if (
      pathStat.isSymbolicLink() ||
      !sameStat(pathStat, opened) ||
      Number(opened.size) !== expectedBytes ||
      fs.realpathSync(targetPath) !== targetPath ||
      hashDescriptor(descriptor, expectedBytes, buffer) !== expectedSha256 ||
      !sameStat(opened, fs.fstatSync(descriptor, { bigint: true }))
    ) {
      configurationError('published capture asset drifted');
    }
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    configurationError('published capture asset cannot be verified', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function appendSourceToStage(
  sourceDescriptor: number,
  stageDescriptor: number,
  start: number,
  total: number,
  buffer: Buffer,
  write: NonNullable<LocalReconciliationStableCopyDependencies['write']>,
): void {
  let sourceOffset = start;
  while (sourceOffset < total) {
    const count = fs.readSync(
      sourceDescriptor,
      buffer,
      0,
      Math.min(buffer.byteLength, total - sourceOffset),
      sourceOffset,
    );
    if (count < 1) configurationError('capture source read stalled');
    let written = 0;
    while (written < count) {
      const countWritten = write(
        stageDescriptor,
        buffer,
        written,
        count - written,
        sourceOffset + written,
      );
      if (countWritten < 1) configurationError('capture stage write stalled');
      written += countWritten;
    }
    sourceOffset += count;
  }
}

export function copyLocalReconciliationAsset(
  asset: Readonly<LocalReconciliationCaptureSourceAsset>,
  assetsDirectory: string,
  uid: number,
  dependencies: LocalReconciliationStableCopyDependencies = {},
): Readonly<LocalReconciliationStableCopyResult> {
  const publishedName = localReconciliationCaptureAssetFileName(
    asset.logicalName,
  );
  const targetPath = path.join(assetsDirectory, publishedName);
  const stagePath = path.join(
    assetsDirectory,
    `.${publishedName}.ql3-capture-stage`,
  );
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  const unlink = dependencies.unlink ?? fs.unlinkSync;
  let sourceDescriptor: number | undefined;
  let stageDescriptor: number | undefined;
  let createdStage = false;
  try {
    const pathStat = fs.lstatSync(asset.sourcePath, { bigint: true });
    sourceDescriptor = fs.openSync(
      asset.sourcePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(sourceDescriptor, { bigint: true });
    validateSource(asset.sourcePath, pathStat, uid, asset.requireNonEmpty);
    if (!sameStat(pathStat, opened)) {
      configurationError('capture source changed while opening');
    }
    const bytes = Number(opened.size);
    const sha256 = hashDescriptor(sourceDescriptor, bytes, buffer);
    if (!sameStat(opened, fs.fstatSync(sourceDescriptor, { bigint: true }))) {
      configurationError('capture source changed while hashing');
    }
    const identityPayload = Object.freeze({
      pathDigest: crypto
        .createHash('sha256')
        .update(asset.sourcePath, 'utf8')
        .digest('hex'),
      device: opened.dev.toString(),
      inode: opened.ino.toString(),
      uid: Number(opened.uid),
      gid: Number(opened.gid),
      mode: Number(opened.mode),
      links: Number(opened.nlink),
      bytes,
      modifiedAtNs: opened.mtimeNs.toString(),
      changedAtNs: opened.ctimeNs.toString(),
    });
    const manifest = Object.freeze({
      logicalName: asset.logicalName,
      bytes,
      sha256,
      sourceIdentityDigest: cutoverDigest(identityPayload),
    });
    if (fs.existsSync(targetPath)) {
      if (fs.existsSync(stagePath)) {
        const target = fs.lstatSync(targetPath, { bigint: true });
        const stage = fs.lstatSync(stagePath, { bigint: true });
        if (
          target.isSymbolicLink() ||
          stage.isSymbolicLink() ||
          target.nlink !== 2n ||
          stage.nlink !== 2n ||
          target.dev !== stage.dev ||
          target.ino !== stage.ino ||
          fs.realpathSync(stagePath) !== stagePath
        ) {
          configurationError('linked capture stage identity drifted');
        }
        verifyPublishedAsset(targetPath, uid, bytes, sha256, buffer, [2n]);
        verifyPublishedAsset(stagePath, uid, bytes, sha256, buffer, [2n]);
        unlink(stagePath);
        syncPublishedDirectory(assetsDirectory);
      }
      verifyPublishedAsset(targetPath, uid, bytes, sha256, buffer);
      return Object.freeze({
        manifest,
        sourceSnapshot: sourceSnapshot(asset.sourcePath, opened),
      });
    }

    try {
      stageDescriptor = fs.openSync(
        stagePath,
        fs.constants.O_RDWR |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      createdStage = true;
      fs.fchmodSync(stageDescriptor, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      stageDescriptor = fs.openSync(
        stagePath,
        fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
      );
    }
    const stage = validateOutputDescriptor(stageDescriptor, uid, [1n]);
    const stagedBytes = Number(stage.size);
    if (stagedBytes > bytes) {
      configurationError('capture stage exceeds its exact source');
    }
    if (stagedBytes > 0) {
      const stagedHash = hashDescriptor(stageDescriptor, stagedBytes, buffer);
      const sourcePrefixHash = hashPrefix(
        sourceDescriptor,
        stagedBytes,
        buffer,
      );
      if (stagedHash !== sourcePrefixHash) {
        configurationError('capture stage does not match its exact source');
      }
    }
    appendSourceToStage(
      sourceDescriptor,
      stageDescriptor,
      stagedBytes,
      bytes,
      buffer,
      dependencies.write ?? fs.writeSync,
    );
    fs.fsyncSync(stageDescriptor);
    const completed = validateOutputDescriptor(stageDescriptor, uid, [1n]);
    if (
      Number(completed.size) !== bytes ||
      hashDescriptor(stageDescriptor, bytes, buffer) !== sha256 ||
      !sameStat(opened, fs.fstatSync(sourceDescriptor, { bigint: true }))
    ) {
      configurationError('capture stage or source drifted');
    }
    fs.closeSync(stageDescriptor);
    stageDescriptor = undefined;
    try {
      fs.linkSync(stagePath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    syncPublishedDirectory(assetsDirectory);
    const linked = fs.lstatSync(stagePath, { bigint: true });
    const target = fs.lstatSync(targetPath, { bigint: true });
    if (
      linked.nlink !== 2n ||
      linked.dev !== target.dev ||
      linked.ino !== target.ino
    ) {
      configurationError('capture asset publication identity drifted');
    }
    unlink(stagePath);
    syncPublishedDirectory(assetsDirectory);
    verifyPublishedAsset(targetPath, uid, bytes, sha256, buffer);
    return Object.freeze({
      manifest,
      sourceSnapshot: sourceSnapshot(asset.sourcePath, opened),
    });
  } catch (error) {
    if (stageDescriptor !== undefined) {
      fs.closeSync(stageDescriptor);
      stageDescriptor = undefined;
    }
    if (createdStage) {
      try {
        unlink(stagePath);
        syncPublishedDirectory(assetsDirectory);
      } catch {
        // A cleanup failure leaves an exact-prefix stage for bounded replay.
      }
    }
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('capture asset cannot be published', error);
  } finally {
    buffer.fill(0);
    if (stageDescriptor !== undefined) fs.closeSync(stageDescriptor);
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
  }
}

export function verifyLocalReconciliationSourceSnapshot(
  snapshot: LocalReconciliationStableCopyResult['sourceSnapshot'],
): void {
  try {
    const stat = fs.lstatSync(snapshot.path, { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.dev.toString() !== snapshot.device ||
      stat.ino.toString() !== snapshot.inode ||
      Number(stat.uid) !== snapshot.uid ||
      Number(stat.gid) !== snapshot.gid ||
      Number(stat.mode) !== snapshot.mode ||
      Number(stat.nlink) !== snapshot.links ||
      Number(stat.size) !== snapshot.bytes ||
      stat.mtimeNs.toString() !== snapshot.modifiedAtNs ||
      stat.ctimeNs.toString() !== snapshot.changedAtNs ||
      fs.realpathSync(snapshot.path) !== snapshot.path
    ) {
      configurationError('capture source changed before bundle publication');
    }
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    configurationError('capture source cannot be reverified', error);
  }
}

export function verifyLocalReconciliationSidecarPlan(
  intent: Readonly<LocalReconciliationCaptureIntent>,
  targetSidecars: readonly boolean[],
  legacySidecars: readonly boolean[],
): void {
  const currentTarget = localReconciliationSidecarSnapshot(
    intent.command.request.targetDatabasePath,
  );
  const currentLegacy = localReconciliationSidecarSnapshot(
    intent.command.request.legacySourcePath,
  );
  if (
    targetSidecars.some((value, index) => value !== currentTarget[index]) ||
    legacySidecars.some((value, index) => value !== currentLegacy[index])
  ) {
    configurationError('SQLite sidecar set changed during capture');
  }
}

export function verifyLocalReconciliationPublishedAsset(
  asset: Readonly<LocalReconciliationCapturedAsset>,
  assetsDirectory: string,
  uid: number,
  allowedModes: readonly bigint[] = [0o600n],
): void {
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  try {
    verifyPublishedAsset(
      path.join(
        assetsDirectory,
        localReconciliationCaptureAssetFileName(asset.logicalName),
      ),
      uid,
      asset.bytes,
      asset.sha256,
      buffer,
      [1n],
      allowedModes,
    );
  } finally {
    buffer.fill(0);
  }
}
