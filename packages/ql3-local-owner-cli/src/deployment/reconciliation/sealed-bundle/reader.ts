import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { LocalDeploymentConfigurationError } from '../../foundation/error';
import { validatePrivateDirectory } from '../../foundation/files';
import {
  readLocalReconciliationCaptureTerminal,
  type LocalReconciliationCaptureManifest,
  type LocalReconciliationCaptureReceipt,
} from '../bundle';
import { localReconciliationCaptureDirectory } from '../preparation';
import { localReconciliationCaptureAssetFileName } from '../stableCopy';

const HASH_BUFFER_BYTES = 64 * 1024;

export type LocalReconciliationSealedDatabaseKind = 'legacy' | 'target';
export type LocalReconciliationSealedDatabaseMode =
  | 'main_only_immutable'
  | 'wal_shm_readonly'
  | 'manual_required';

export interface LocalReconciliationSealedDatabaseTopology {
  readonly kind: LocalReconciliationSealedDatabaseKind;
  readonly mode: LocalReconciliationSealedDatabaseMode;
  readonly reason:
    | null
    | 'hot_journal'
    | 'unpaired_wal_shm';
}

export interface LocalReconciliationSealedBundle {
  readonly captureRoot: string;
  readonly captureDirectory: string;
  readonly assetsDirectory: string;
  readonly manifest: Readonly<LocalReconciliationCaptureManifest>;
  readonly receipt: Readonly<LocalReconciliationCaptureReceipt>;
  readonly fingerprintDigest: string;
  readonly target: Readonly<LocalReconciliationSealedDatabaseTopology>;
  readonly legacy: Readonly<LocalReconciliationSealedDatabaseTopology>;
}

export interface LocalReconciliationSealedBundleReaderDependencies {
  readonly beforeDatabaseOpen?: (
    kind: LocalReconciliationSealedDatabaseKind,
    mode: Exclude<LocalReconciliationSealedDatabaseMode, 'manual_required'>,
    cacheKiB: 2_048 | 8_192,
  ) => void;
  readonly afterDatabaseClose?: (
    kind: LocalReconciliationSealedDatabaseKind,
  ) => void;
}

function configurationError(message: string, cause?: unknown): never {
  throw new LocalDeploymentConfigurationError(message, { cause });
}

function validateSealedDirectory(directory: string, uid: number): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    return configurationError('sealed capture assets are unavailable', error);
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o500 ||
    fs.realpathSync(directory) !== directory
  ) {
    configurationError('sealed capture assets identity drifted');
  }
}

function hashDescriptor(descriptor: number, bytes: number): string {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let offset = 0;
  while (offset < bytes) {
    const count = fs.readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.byteLength, bytes - offset),
      offset,
    );
    if (count < 1) configurationError('sealed capture asset read stalled');
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  return hash.digest('hex');
}

function assetFingerprint(
  assetsDirectory: string,
  asset: LocalReconciliationCaptureManifest['assets'][number],
  uid: number,
): Readonly<Record<string, string | number>> {
  const filePath = path.join(
    assetsDirectory,
    localReconciliationCaptureAssetFileName(asset.logicalName),
  );
  let descriptor: number | undefined;
  try {
    const pathStat = fs.lstatSync(filePath, { bigint: true });
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !opened.isFile() ||
      pathStat.dev !== opened.dev ||
      pathStat.ino !== opened.ino ||
      opened.uid !== BigInt(uid) ||
      opened.nlink !== 1n ||
      (opened.mode & 0o777n) !== 0o400n ||
      opened.size !== BigInt(asset.bytes) ||
      opened.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      fs.realpathSync(filePath) !== filePath
    ) {
      configurationError('sealed capture asset identity drifted');
    }
    const sha256 = hashDescriptor(descriptor, Number(opened.size));
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      sha256 !== asset.sha256 ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.uid !== after.uid ||
      opened.gid !== after.gid ||
      opened.mode !== after.mode ||
      opened.nlink !== after.nlink ||
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs
    ) {
      configurationError('sealed capture asset drifted while reading');
    }
    return Object.freeze({
      logicalName: asset.logicalName,
      device: opened.dev.toString(),
      inode: opened.ino.toString(),
      uid: Number(opened.uid),
      gid: Number(opened.gid),
      mode: Number(opened.mode),
      links: Number(opened.nlink),
      bytes: Number(opened.size),
      modifiedAtNs: opened.mtimeNs.toString(),
      changedAtNs: opened.ctimeNs.toString(),
      sha256,
    });
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('sealed capture asset is unavailable', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fingerprint(
  assetsDirectory: string,
  manifest: Readonly<LocalReconciliationCaptureManifest>,
  uid: number,
): string {
  validateSealedDirectory(assetsDirectory, uid);
  const assets = manifest.assets.map((asset) =>
    assetFingerprint(assetsDirectory, asset, uid),
  );
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(assets), 'utf8')
    .digest('hex');
}

function topology(
  manifest: Readonly<LocalReconciliationCaptureManifest>,
  kind: LocalReconciliationSealedDatabaseKind,
): Readonly<LocalReconciliationSealedDatabaseTopology> {
  const names = new Set(manifest.assets.map((asset) => asset.logicalName));
  const wal = names.has(`${kind}-wal`);
  const shm = names.has(`${kind}-shm`);
  const journal = names.has(`${kind}-journal`);
  if (journal) {
    return Object.freeze({ kind, mode: 'manual_required', reason: 'hot_journal' });
  }
  if (wal !== shm) {
    return Object.freeze({
      kind,
      mode: 'manual_required',
      reason: 'unpaired_wal_shm',
    });
  }
  return Object.freeze({
    kind,
    mode: wal ? 'wal_shm_readonly' : 'main_only_immutable',
    reason: null,
  });
}

export function inspectLocalReconciliationSealedBundle(
  captureRoot: string,
  captureId: string,
  uid: number,
): Readonly<LocalReconciliationSealedBundle> {
  validatePrivateDirectory(captureRoot, uid, 'captureRoot');
  const captureDirectory = localReconciliationCaptureDirectory(
    captureRoot,
    captureId,
  );
  const assetsDirectory = path.join(captureDirectory, 'assets');
  const terminal = readLocalReconciliationCaptureTerminal(
    captureRoot,
    captureId,
    uid,
  );
  const fingerprintDigest = fingerprint(
    assetsDirectory,
    terminal.manifest,
    uid,
  );
  return Object.freeze({
    captureRoot,
    captureDirectory,
    assetsDirectory,
    manifest: terminal.manifest,
    receipt: terminal.receipt,
    fingerprintDigest,
    target: topology(terminal.manifest, 'target'),
    legacy: topology(terminal.manifest, 'legacy'),
  });
}

function databasePath(
  bundle: Readonly<LocalReconciliationSealedBundle>,
  kind: LocalReconciliationSealedDatabaseKind,
): string {
  return path.join(bundle.assetsDirectory, `${kind}.sqlite`);
}

function configureReadOnlyDatabase(
  client: DatabaseSync,
  profile: LocalReconciliationCaptureManifest['profile'],
): void {
  const cacheKiB = profile === 'edge' ? 2_048 : 8_192;
  client.enableDefensive(true);
  client.exec(
    `PRAGMA trusted_schema = OFF; PRAGMA query_only = ON; PRAGMA temp_store = MEMORY; PRAGMA mmap_size = 0; PRAGMA cache_size = -${cacheKiB}`,
  );
  const trustedSchema = client.prepare('PRAGMA trusted_schema').get() as
    | { readonly trusted_schema?: unknown }
    | undefined;
  const queryOnly = client.prepare('PRAGMA query_only').get() as
    | { readonly query_only?: unknown }
    | undefined;
  const tempStore = client.prepare('PRAGMA temp_store').get() as
    | { readonly temp_store?: unknown }
    | undefined;
  const mmapSize = client.prepare('PRAGMA mmap_size').get() as
    | { readonly mmap_size?: unknown }
    | undefined;
  const cacheSize = client.prepare('PRAGMA cache_size').get() as
    | { readonly cache_size?: unknown }
    | undefined;
  if (
    trustedSchema?.trusted_schema !== 0 ||
    queryOnly?.query_only !== 1 ||
    tempStore?.temp_store !== 2 ||
    mmapSize?.mmap_size !== 0 ||
    cacheSize?.cache_size !== -cacheKiB
  ) {
    configurationError('sealed SQLite read-only configuration drifted');
  }
}

export function withLocalReconciliationSealedDatabase<T>(
  bundle: Readonly<LocalReconciliationSealedBundle>,
  kind: LocalReconciliationSealedDatabaseKind,
  uid: number,
  dependencies: LocalReconciliationSealedBundleReaderDependencies,
  read: (client: DatabaseSync) => T,
): T | null {
  const current = inspectLocalReconciliationSealedBundle(
    bundle.captureRoot,
    bundle.receipt.captureId,
    uid,
  );
  if (
    current.receipt.bundleDigest !== bundle.receipt.bundleDigest ||
    current.fingerprintDigest !== bundle.fingerprintDigest
  ) {
    configurationError('sealed capture bundle drifted before SQLite open');
  }
  const selected = kind === 'target' ? current.target : current.legacy;
  if (selected.mode === 'manual_required') return null;
  const cacheKiB = current.manifest.profile === 'edge' ? 2_048 : 8_192;
  dependencies.beforeDatabaseOpen?.(kind, selected.mode, cacheKiB);
  const mainPath = databasePath(current, kind);
  const source =
    selected.mode === 'main_only_immutable'
      ? `file:${mainPath}?immutable=1`
      : mainPath;
  let client: DatabaseSync | undefined;
  let output: T;
  try {
    client = new DatabaseSync(source, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readOnly: true,
      timeout: 0,
    });
    configureReadOnlyDatabase(client, current.manifest.profile);
    output = read(client);
  } catch (error) {
    if (error instanceof LocalDeploymentConfigurationError) throw error;
    return configurationError('sealed SQLite inventory failed', error);
  } finally {
    if (client !== undefined) client.close();
    dependencies.afterDatabaseClose?.(kind);
  }
  const after = inspectLocalReconciliationSealedBundle(
    bundle.captureRoot,
    bundle.receipt.captureId,
    uid,
  );
  if (
    after.receipt.bundleDigest !== current.receipt.bundleDigest ||
    after.fingerprintDigest !== current.fingerprintDigest
  ) {
    configurationError('sealed capture bundle drifted after SQLite close');
  }
  return output;
}
