import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { backup, type DatabaseSync } from 'node:sqlite';

import {
  assertLocalSqliteOptions,
  assertLocalSqlitePathBoundary,
  openLocalSqliteClient,
  type LocalSqliteDatabaseOptions,
} from '../storage/config';
import {
  auditLocalSqliteReadiness,
  LOCAL_SQLITE_CONTRACT_VERSION,
} from './readiness';

export const LOCAL_SQLITE_WRITE_CONTRACT_VERSION =
  LOCAL_SQLITE_CONTRACT_VERSION;

const MAX_PATH_BYTES = 4_096;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface LocalSqliteRolloutBackupOptions
  extends LocalSqliteDatabaseOptions {
  readonly backupPath: string;
}

export interface LocalSqliteRolloutBackupEvidence {
  readonly status: 'prepared' | 'existing';
  readonly contractVersion: typeof LOCAL_SQLITE_CONTRACT_VERSION;
  readonly writeContractVersion: typeof LOCAL_SQLITE_WRITE_CONTRACT_VERSION;
  readonly sha256: string;
  readonly bytes: number;
  readonly pageCount: number;
  readonly pageSize: number;
}

export interface LocalSqliteSnapshotEvidence {
  readonly contractVersion: typeof LOCAL_SQLITE_CONTRACT_VERSION;
  readonly sha256: string;
  readonly bytes: number;
  readonly pageCount: number;
  readonly pageSize: number;
}

export interface LocalSqliteRestoreOptions extends LocalSqliteDatabaseOptions {
  readonly sourceSnapshotPath: string;
  readonly restoreStagePath: string;
  readonly replacedDatabasePath: string;
  readonly expectedCurrentSha256: string;
  readonly expectedSourceSha256: string;
  readonly preserveDatabaseIdentity?: boolean;
}

export interface LocalSqliteRestoreEvidence
  extends LocalSqliteSnapshotEvidence {
  readonly status: 'restored' | 'existing';
}

export interface LocalSqliteRestoreDependencies {
  readonly copySnapshot?: (sourcePath: string, targetPath: string) => void;
  readonly rewriteSnapshot?: (sourcePath: string, targetPath: string) => void;
}

export interface LocalSqliteChangeObserver {
  changed(): boolean;
  close(): void;
}

export interface LocalSqliteRolloutBackupDependencies {
  readonly performBackup?: typeof backup;
}

function configurationError(message: string, cause?: unknown): never {
  const error = new TypeError(
    `Local SQLite rollout safety is invalid: ${message}`,
    { cause },
  );
  error.name = 'LocalSqliteRolloutSafetyError';
  throw error;
}

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== process.geteuid()
  ) {
    configurationError('a stable POSIX UID is required');
  }
  return process.getuid();
}

function normalizedAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    configurationError(`${label} must be a normalized absolute non-root path`);
  }
  return value;
}

function validatePrivateDirectory(
  directory: string,
  uid: number,
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
    (stat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(directory) !== directory
  ) {
    configurationError(
      `${label} must be a canonical current-UID 0700 directory`,
    );
  }
}

function validateDatabaseFile(
  filePath: string,
  uid: number,
  label: string,
): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    configurationError(`${label} is unavailable`, error);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    !Number.isSafeInteger(stat.size) ||
    fs.realpathSync(filePath) !== filePath
  ) {
    configurationError(
      `${label} must be a canonical current-UID 0600 regular file`,
    );
  }
  return stat;
}

function syncFile(filePath: string): void {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    for (;;) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function pragmaInteger(
  client: DatabaseSync,
  pragma: 'data_version' | 'page_count' | 'page_size',
): number {
  const row = client.prepare(`PRAGMA ${pragma}`).get() as
    | Record<string, unknown>
    | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    configurationError(`${pragma} is invalid`);
  }
  return value as number;
}

async function inspectSnapshotFile(
  filePath: string,
  profile: LocalSqliteDatabaseOptions['profile'],
  uid: number,
  label: string,
): Promise<Readonly<LocalSqliteSnapshotEvidence>> {
  const stat = validateDatabaseFile(filePath, uid, label);
  const client = openLocalSqliteClient(
    {
      databasePath: filePath,
      profile,
    },
    true,
  );
  try {
    const readiness = await auditLocalSqliteReadiness(client);
    if (readiness.contractVersion !== LOCAL_SQLITE_CONTRACT_VERSION) {
      configurationError('rollout backup contract drifted');
    }
    const journal = client.prepare('PRAGMA journal_mode').get() as
      | { readonly journal_mode?: unknown }
      | undefined;
    if (journal?.journal_mode !== 'delete') {
      configurationError('SQLite snapshot must use delete journal mode');
    }
    const pageCount = pragmaInteger(client, 'page_count');
    const pageSize = pragmaInteger(client, 'page_size');
    const sha256 = sha256File(filePath);
    const allocatedBytes = pageCount * pageSize;
    if (
      !DIGEST_PATTERN.test(sha256) ||
      pageCount < 1 ||
      pageSize < 512 ||
      pageSize > 65_536 ||
      !Number.isSafeInteger(allocatedBytes) ||
      allocatedBytes < stat.size
    ) {
      configurationError('rollout backup evidence is invalid');
    }
    return Object.freeze({
      contractVersion: LOCAL_SQLITE_CONTRACT_VERSION,
      sha256,
      bytes: stat.size,
      pageCount,
      pageSize,
    });
  } finally {
    client.close();
  }
}

async function inspectBackup(
  options: Readonly<LocalSqliteRolloutBackupOptions>,
  backupPath: string,
  status: LocalSqliteRolloutBackupEvidence['status'],
  uid: number,
): Promise<Readonly<LocalSqliteRolloutBackupEvidence>> {
  const evidence = await inspectSnapshotFile(
    backupPath,
    options.profile,
    uid,
    'rollout backup',
  );
  return Object.freeze({
    status,
    writeContractVersion: LOCAL_SQLITE_WRITE_CONTRACT_VERSION,
    ...evidence,
  });
}

function assertOptions(
  options: Readonly<LocalSqliteRolloutBackupOptions>,
): Readonly<{ uid: number; backupPath: string; stagePath: string }> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const uid = currentUid();
  const databasePath = normalizedAbsolutePath(
    options.databasePath,
    'databasePath',
  );
  const backupPath = normalizedAbsolutePath(options.backupPath, 'backupPath');
  if (
    databasePath === backupPath ||
    path.dirname(databasePath) === backupPath ||
    path.dirname(backupPath) === databasePath
  ) {
    configurationError('databasePath and backupPath must not alias');
  }
  validatePrivateDirectory(
    path.dirname(databasePath),
    uid,
    'database directory',
  );
  validatePrivateDirectory(path.dirname(backupPath), uid, 'backup directory');
  validateDatabaseFile(databasePath, uid, 'source database');
  return Object.freeze({
    uid,
    backupPath,
    stagePath: path.join(
      path.dirname(backupPath),
      `.${path.basename(backupPath)}.ql3-backup-stage`,
    ),
  });
}

export async function inspectLocalSqliteRolloutBackup(
  options: Readonly<LocalSqliteRolloutBackupOptions>,
): Promise<Readonly<LocalSqliteRolloutBackupEvidence>> {
  const { uid, backupPath } = assertOptions(options);
  return inspectBackup(options, backupPath, 'existing', uid);
}

export async function inspectLocalSqliteSnapshot(
  options: Readonly<LocalSqliteDatabaseOptions>,
): Promise<Readonly<LocalSqliteSnapshotEvidence>> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const uid = currentUid();
  const databasePath = normalizedAbsolutePath(
    options.databasePath,
    'databasePath',
  );
  validatePrivateDirectory(
    path.dirname(databasePath),
    uid,
    'database directory',
  );
  return inspectSnapshotFile(
    databasePath,
    options.profile,
    uid,
    'SQLite snapshot',
  );
}

function assertNoRestoreSidecars(databasePath: string, uid: number): void {
  for (const suffix of ['-wal', '-shm']) {
    const sidecarPath = `${databasePath}${suffix}`;
    if (!fs.existsSync(sidecarPath)) continue;
    const stat = fs.lstatSync(sidecarPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1
    ) {
      configurationError('SQLite restore sidecar identity drifted');
    }
    configurationError('SQLite restore requires closed checkpointed sidecars');
  }
}

export async function checkpointLocalSqliteForRestore(
  options: Readonly<LocalSqliteDatabaseOptions>,
): Promise<Readonly<LocalSqliteSnapshotEvidence>> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const uid = currentUid();
  const databasePath = normalizedAbsolutePath(
    options.databasePath,
    'databasePath',
  );
  validatePrivateDirectory(
    path.dirname(databasePath),
    uid,
    'database directory',
  );
  validateDatabaseFile(databasePath, uid, 'source database');
  const inspection = openLocalSqliteClient(options, true);
  let observedJournal: unknown;
  try {
    await auditLocalSqliteReadiness(inspection);
    observedJournal = (
      inspection.prepare('PRAGMA journal_mode').get() as
        | { readonly journal_mode?: unknown }
        | undefined
    )?.journal_mode;
  } finally {
    inspection.close();
  }
  if (observedJournal === 'delete') {
    assertNoRestoreSidecars(databasePath, uid);
    syncFile(databasePath);
    syncDirectory(path.dirname(databasePath));
    return inspectSnapshotFile(
      databasePath,
      options.profile,
      uid,
      'checkpointed database',
    );
  }
  if (observedJournal !== 'wal') {
    configurationError('SQLite restore source journal mode is invalid');
  }
  const client = openLocalSqliteClient(options, false);
  try {
    await auditLocalSqliteReadiness(client);
    const row = client.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      | {
          readonly busy?: unknown;
          readonly log?: unknown;
          readonly checkpointed?: unknown;
        }
      | undefined;
    if (
      row?.busy !== 0 ||
      !Number.isSafeInteger(row.log) ||
      !Number.isSafeInteger(row.checkpointed) ||
      (row.log as number) < -1 ||
      (row.checkpointed as number) < -1 ||
      ((row.log as number) >= 0 && row.log !== row.checkpointed)
    ) {
      configurationError('SQLite restore checkpoint did not converge');
    }
    const journal = client.prepare('PRAGMA journal_mode = DELETE').get() as
      | { readonly journal_mode?: unknown }
      | undefined;
    if (journal?.journal_mode !== 'delete') {
      configurationError('SQLite restore checkpoint did not become standalone');
    }
  } finally {
    client.close();
  }
  assertNoRestoreSidecars(databasePath, uid);
  syncFile(databasePath);
  syncDirectory(path.dirname(databasePath));
  return inspectSnapshotFile(
    databasePath,
    options.profile,
    uid,
    'checkpointed database',
  );
}

export async function createLocalSqliteRolloutBackup(
  options: Readonly<LocalSqliteRolloutBackupOptions>,
  dependencies: LocalSqliteRolloutBackupDependencies = {},
): Promise<Readonly<LocalSqliteRolloutBackupEvidence>> {
  const { uid, backupPath, stagePath } = assertOptions(options);
  if (fs.existsSync(backupPath)) {
    if (fs.existsSync(stagePath)) {
      const backupStat = fs.lstatSync(backupPath);
      const stageStat = fs.lstatSync(stagePath);
      if (
        !backupStat.isFile() ||
        backupStat.isSymbolicLink() ||
        !stageStat.isFile() ||
        stageStat.isSymbolicLink() ||
        backupStat.uid !== uid ||
        stageStat.uid !== uid ||
        (backupStat.mode & 0o777) !== 0o600 ||
        (stageStat.mode & 0o777) !== 0o600 ||
        backupStat.dev !== stageStat.dev ||
        backupStat.ino !== stageStat.ino ||
        backupStat.nlink !== 2 ||
        stageStat.nlink !== 2
      ) {
        configurationError('rollout backup and stage identity drifted');
      }
      fs.unlinkSync(stagePath);
      syncDirectory(path.dirname(stagePath));
    }
    return inspectBackup(options, backupPath, 'existing', uid);
  }
  if (fs.existsSync(stagePath)) {
    try {
      await inspectBackup(options, stagePath, 'prepared', uid);
    } catch {
      fs.unlinkSync(stagePath);
      syncDirectory(path.dirname(stagePath));
    }
  }
  if (!fs.existsSync(stagePath)) {
    const source = openLocalSqliteClient(options, true);
    try {
      await (dependencies.performBackup ?? backup)(source, stagePath, {
        rate: options.profile === 'edge' ? 16 : 64,
      });
    } catch (error) {
      if (fs.existsSync(stagePath)) {
        fs.unlinkSync(stagePath);
        syncDirectory(path.dirname(stagePath));
      }
      configurationError('rollout backup could not be created', error);
    } finally {
      source.close();
    }
    const normalizer = openLocalSqliteClient(
      {
        databasePath: stagePath,
        profile: 'edge',
        ...(options.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: options.busyTimeoutMs }),
      },
      false,
    );
    normalizer.close();
    fs.chmodSync(stagePath, 0o600);
    syncFile(stagePath);
  }
  const evidence = await inspectBackup(options, stagePath, 'prepared', uid);
  if (fs.existsSync(backupPath)) {
    configurationError('rollout backup target appeared concurrently');
  }
  try {
    fs.linkSync(stagePath, backupPath);
  } catch (error) {
    configurationError('rollout backup target appeared concurrently', error);
  }
  syncDirectory(path.dirname(backupPath));
  fs.unlinkSync(stagePath);
  syncDirectory(path.dirname(backupPath));
  const published = await inspectBackup(options, backupPath, 'prepared', uid);
  if (
    published.sha256 !== evidence.sha256 ||
    published.bytes !== evidence.bytes ||
    published.pageCount !== evidence.pageCount ||
    published.pageSize !== evidence.pageSize
  ) {
    configurationError('published rollout backup drifted');
  }
  return published;
}

export function openLocalSqliteChangeObserver(
  options: Readonly<LocalSqliteDatabaseOptions>,
): Readonly<LocalSqliteChangeObserver> {
  assertLocalSqliteOptions(options);
  assertLocalSqlitePathBoundary(options.databasePath, false);
  const uid = currentUid();
  validatePrivateDirectory(
    path.dirname(options.databasePath),
    uid,
    'database directory',
  );
  validateDatabaseFile(options.databasePath, uid, 'source database');
  const client = openLocalSqliteClient(options, true);
  const initialDataVersion = pragmaInteger(client, 'data_version');
  let closed = false;
  return Object.freeze({
    changed(): boolean {
      if (closed) configurationError('change observer is closed');
      return pragmaInteger(client, 'data_version') !== initialDataVersion;
    },
    close(): void {
      if (closed) return;
      closed = true;
      client.close();
    },
  });
}

function sameSnapshot(
  left: Readonly<LocalSqliteSnapshotEvidence>,
  right: Readonly<LocalSqliteSnapshotEvidence>,
): boolean {
  return (
    left.contractVersion === right.contractVersion &&
    left.sha256 === right.sha256 &&
    left.bytes === right.bytes &&
    left.pageCount === right.pageCount &&
    left.pageSize === right.pageSize
  );
}

function rewriteSnapshotFilePreservingIdentity(
  sourcePath: string,
  targetPath: string,
): void {
  const targetIdentity = fs.lstatSync(targetPath, { bigint: true });
  let sourceDescriptor: number | undefined;
  let targetDescriptor: number | undefined;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    sourceDescriptor = fs.openSync(
      sourcePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    targetDescriptor = fs.openSync(
      targetPath,
      fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    );
    const openedTarget = fs.fstatSync(targetDescriptor, { bigint: true });
    if (
      !openedTarget.isFile() ||
      openedTarget.dev !== targetIdentity.dev ||
      openedTarget.ino !== targetIdentity.ino ||
      openedTarget.nlink !== 1n
    ) {
      configurationError('identity-preserving restore target drifted');
    }
    for (;;) {
      const count = fs.readSync(
        sourceDescriptor,
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (count === 0) break;
      let offset = 0;
      while (offset < count) {
        const written = fs.writeSync(
          targetDescriptor,
          buffer,
          offset,
          count - offset,
          null,
        );
        if (written < 1) {
          configurationError('identity-preserving restore write stalled');
        }
        offset += written;
      }
    }
    fs.fsyncSync(targetDescriptor);
    const writtenTarget = fs.fstatSync(targetDescriptor, { bigint: true });
    if (
      writtenTarget.dev !== targetIdentity.dev ||
      writtenTarget.ino !== targetIdentity.ino ||
      writtenTarget.nlink !== 1n
    ) {
      configurationError('identity-preserving restore target changed');
    }
  } finally {
    buffer.fill(0);
    if (targetDescriptor !== undefined) fs.closeSync(targetDescriptor);
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
  }
}

async function restoreSnapshotPreservingIdentity(
  options: Readonly<LocalSqliteRestoreOptions>,
  dependencies: LocalSqliteRestoreDependencies,
  input: Readonly<{
    uid: number;
    databasePath: string;
    sourceSnapshotPath: string;
    restoreStagePath: string;
    replacedDatabasePath: string;
    source: Readonly<LocalSqliteSnapshotEvidence>;
  }>,
): Promise<Readonly<LocalSqliteRestoreEvidence>> {
  if (!fs.existsSync(input.databasePath)) {
    configurationError(
      'identity-preserving restore requires the activated database inode',
    );
  }
  const targetIdentity = fs.lstatSync(input.databasePath);
  if (
    !targetIdentity.isFile() ||
    targetIdentity.isSymbolicLink() ||
    targetIdentity.uid !== input.uid ||
    (targetIdentity.mode & 0o777) !== 0o600 ||
    targetIdentity.nlink !== 1 ||
    fs.realpathSync(input.databasePath) !== input.databasePath
  ) {
    configurationError('identity-preserving restore database is invalid');
  }
  let current: Readonly<LocalSqliteSnapshotEvidence> | undefined;
  try {
    current = await inspectSnapshotFile(
      input.databasePath,
      options.profile,
      input.uid,
      'restore current database',
    );
  } catch (error) {
    if (
      !fs.existsSync(input.restoreStagePath) ||
      !fs.existsSync(input.replacedDatabasePath)
    ) {
      throw error;
    }
  }
  const restoredAtEntry =
    current !== undefined && sameSnapshot(current, input.source);
  if (
    current !== undefined &&
    !restoredAtEntry &&
    current.sha256 !== options.expectedCurrentSha256
  ) {
    configurationError('restore current database drifted');
  }

  if (!fs.existsSync(input.restoreStagePath) && !restoredAtEntry) {
    try {
      (
        dependencies.copySnapshot ??
        ((sourcePath: string, targetPath: string) =>
          fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL))
      )(input.sourceSnapshotPath, input.restoreStagePath);
      fs.chmodSync(input.restoreStagePath, 0o600);
      syncFile(input.restoreStagePath);
      syncDirectory(path.dirname(input.restoreStagePath));
    } catch (error) {
      if (fs.existsSync(input.restoreStagePath)) {
        try {
          fs.unlinkSync(input.restoreStagePath);
          syncDirectory(path.dirname(input.restoreStagePath));
        } catch {
          // A deterministic stage remains fail-closed for exact replay.
        }
      }
      configurationError('restore stage could not be created', error);
    }
  }
  if (fs.existsSync(input.restoreStagePath)) {
    const staged = await inspectSnapshotFile(
      input.restoreStagePath,
      options.profile,
      input.uid,
      'restore stage',
    );
    if (!sameSnapshot(staged, input.source)) {
      configurationError('restore stage drifted');
    }
  }

  if (!restoredAtEntry && !fs.existsSync(input.replacedDatabasePath)) {
    if (current === undefined) {
      configurationError('restore replacement evidence is unavailable');
    }
    try {
      fs.copyFileSync(
        input.databasePath,
        input.replacedDatabasePath,
        fs.constants.COPYFILE_EXCL,
      );
      fs.chmodSync(input.replacedDatabasePath, 0o600);
      syncFile(input.replacedDatabasePath);
      syncDirectory(path.dirname(input.replacedDatabasePath));
    } catch (error) {
      configurationError(
        'restore replacement evidence cannot be created',
        error,
      );
    }
  }
  if (fs.existsSync(input.replacedDatabasePath)) {
    const replaced = await inspectSnapshotFile(
      input.replacedDatabasePath,
      options.profile,
      input.uid,
      'replaced database',
    );
    if (replaced.sha256 !== options.expectedCurrentSha256) {
      configurationError('replaced database evidence drifted');
    }
  }

  if (!restoredAtEntry) {
    try {
      (dependencies.rewriteSnapshot ?? rewriteSnapshotFilePreservingIdentity)(
        input.restoreStagePath,
        input.databasePath,
      );
    } catch (error) {
      configurationError(
        'identity-preserving restore write could not complete',
        error,
      );
    }
  }
  const afterIdentity = validateDatabaseFile(
    input.databasePath,
    input.uid,
    'identity-preserving restored database',
  );
  if (
    afterIdentity.dev !== targetIdentity.dev ||
    afterIdentity.ino !== targetIdentity.ino
  ) {
    configurationError('identity-preserving restore changed the target inode');
  }
  const restored = await inspectSnapshotFile(
    input.databasePath,
    options.profile,
    input.uid,
    'restored database',
  );
  if (!sameSnapshot(restored, input.source)) {
    configurationError('restored database drifted');
  }
  for (const evidencePath of [
    input.restoreStagePath,
    input.replacedDatabasePath,
  ]) {
    if (!fs.existsSync(evidencePath)) continue;
    fs.unlinkSync(evidencePath);
    syncDirectory(path.dirname(evidencePath));
  }
  return Object.freeze({
    status: restoredAtEntry ? ('existing' as const) : ('restored' as const),
    ...restored,
  });
}

export async function restoreLocalSqliteSnapshot(
  options: Readonly<LocalSqliteRestoreOptions>,
  dependencies: LocalSqliteRestoreDependencies = {},
): Promise<Readonly<LocalSqliteRestoreEvidence>> {
  assertLocalSqliteOptions(options);
  const uid = currentUid();
  const databasePath = normalizedAbsolutePath(
    options.databasePath,
    'databasePath',
  );
  const sourceSnapshotPath = normalizedAbsolutePath(
    options.sourceSnapshotPath,
    'sourceSnapshotPath',
  );
  const restoreStagePath = normalizedAbsolutePath(
    options.restoreStagePath,
    'restoreStagePath',
  );
  const replacedDatabasePath = normalizedAbsolutePath(
    options.replacedDatabasePath,
    'replacedDatabasePath',
  );
  if (
    !DIGEST_PATTERN.test(options.expectedCurrentSha256) ||
    !DIGEST_PATTERN.test(options.expectedSourceSha256) ||
    options.expectedCurrentSha256 === options.expectedSourceSha256 ||
    (options.preserveDatabaseIdentity !== undefined &&
      typeof options.preserveDatabaseIdentity !== 'boolean') ||
    new Set([
      databasePath,
      sourceSnapshotPath,
      restoreStagePath,
      replacedDatabasePath,
    ]).size !== 4
  ) {
    configurationError('SQLite restore identity is invalid');
  }
  for (const directory of new Set([
    path.dirname(databasePath),
    path.dirname(sourceSnapshotPath),
    path.dirname(restoreStagePath),
    path.dirname(replacedDatabasePath),
  ])) {
    validatePrivateDirectory(directory, uid, 'SQLite restore directory');
  }
  const databaseDirectoryStat = fs.statSync(path.dirname(databasePath));
  const replacedDirectoryStat = fs.statSync(path.dirname(replacedDatabasePath));
  if (databaseDirectoryStat.dev !== replacedDirectoryStat.dev) {
    configurationError('SQLite restore paths must share one filesystem');
  }
  const source = await inspectSnapshotFile(
    sourceSnapshotPath,
    options.profile,
    uid,
    'restore source snapshot',
  );
  if (source.sha256 !== options.expectedSourceSha256) {
    configurationError('restore source snapshot drifted');
  }
  assertNoRestoreSidecars(databasePath, uid);

  if (options.preserveDatabaseIdentity === true) {
    return restoreSnapshotPreservingIdentity(options, dependencies, {
      uid,
      databasePath,
      sourceSnapshotPath,
      restoreStagePath,
      replacedDatabasePath,
      source,
    });
  }

  let restoredAtEntry = false;
  if (fs.existsSync(databasePath)) {
    const current = await inspectSnapshotFile(
      databasePath,
      options.profile,
      uid,
      'restore current database',
    );
    if (sameSnapshot(current, source)) {
      restoredAtEntry = true;
    } else if (current.sha256 !== options.expectedCurrentSha256) {
      configurationError('restore current database drifted');
    }
  } else if (!fs.existsSync(replacedDatabasePath)) {
    configurationError('restore database and replacement evidence are absent');
  }

  if (!fs.existsSync(restoreStagePath) && !restoredAtEntry) {
    try {
      (
        dependencies.copySnapshot ??
        ((sourcePath: string, targetPath: string) =>
          fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL))
      )(sourceSnapshotPath, restoreStagePath);
      fs.chmodSync(restoreStagePath, 0o600);
      syncFile(restoreStagePath);
      syncDirectory(path.dirname(restoreStagePath));
    } catch (error) {
      if (fs.existsSync(restoreStagePath)) {
        try {
          fs.unlinkSync(restoreStagePath);
          syncDirectory(path.dirname(restoreStagePath));
        } catch {
          // A deterministic stage remains fail-closed for exact replay.
        }
      }
      configurationError('restore stage could not be created', error);
    }
  }
  if (fs.existsSync(restoreStagePath)) {
    const staged = await inspectSnapshotFile(
      restoreStagePath,
      options.profile,
      uid,
      'restore stage',
    );
    if (!sameSnapshot(staged, source)) {
      configurationError('restore stage drifted');
    }
  }

  if (!restoredAtEntry && fs.existsSync(databasePath)) {
    if (fs.existsSync(replacedDatabasePath)) {
      configurationError('restore replacement target appeared concurrently');
    }
    fs.renameSync(databasePath, replacedDatabasePath);
    syncDirectory(path.dirname(databasePath));
    if (path.dirname(replacedDatabasePath) !== path.dirname(databasePath)) {
      syncDirectory(path.dirname(replacedDatabasePath));
    }
  }
  if (fs.existsSync(replacedDatabasePath)) {
    const replaced = await inspectSnapshotFile(
      replacedDatabasePath,
      options.profile,
      uid,
      'replaced database',
    );
    if (replaced.sha256 !== options.expectedCurrentSha256) {
      configurationError('replaced database evidence drifted');
    }
  }
  if (!fs.existsSync(databasePath)) {
    if (!fs.existsSync(restoreStagePath)) {
      configurationError('restore stage is unavailable');
    }
    fs.renameSync(restoreStagePath, databasePath);
    syncDirectory(path.dirname(databasePath));
  } else if (fs.existsSync(restoreStagePath)) {
    fs.unlinkSync(restoreStagePath);
    syncDirectory(path.dirname(restoreStagePath));
  }
  const restored = await inspectSnapshotFile(
    databasePath,
    options.profile,
    uid,
    'restored database',
  );
  if (!sameSnapshot(restored, source)) {
    configurationError('restored database drifted');
  }
  if (fs.existsSync(replacedDatabasePath)) {
    fs.unlinkSync(replacedDatabasePath);
    syncDirectory(path.dirname(replacedDatabasePath));
  }
  return Object.freeze({
    status: restoredAtEntry ? ('existing' as const) : ('restored' as const),
    ...restored,
  });
}
