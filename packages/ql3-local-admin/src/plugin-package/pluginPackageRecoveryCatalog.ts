import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { constants, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  normalizePluginPackageManifest,
  type PluginPackageManifest,
} from '@qinglong/runtime-core/plugin-package';
import {
  inspectPluginPackageBundle,
  PLUGIN_PACKAGE_SIGNATURE_SCHEMA,
  PluginPackagePublisherTrustRegistry,
  type PluginPackageSignature,
} from '@qinglong/runtime-core/plugin-package-bundle';
import {
  normalizePluginPackageLock,
  type PluginPackageLock,
  type PluginPackageSourceLock,
} from '@qinglong/runtime-core/plugin-package-install';
import {
  createLocalPluginPackagePublisherTrustRegistry,
  localPluginPackagePublisherKeyRevocationImpactDigest,
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
} from './pluginPackagePublisherTrust';

export {
  createLocalPluginPackagePublisherTrustRegistry,
  LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA,
} from './pluginPackagePublisherTrust';

export const LOCAL_PLUGIN_PACKAGE_RECOVERY_SOURCE_SCHEMA =
  'qinglong/local-plugin-package-recovery-source@v1' as const;
export const MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_ENTRIES = 64;
export const MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_BUNDLES = 64;

const MAX_ROOT_ENTRIES = 128;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_PATH_BYTES = 4_096;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ENTRY_PATTERN = /^([0-9a-f]{64})\.json$/;
const BUNDLE_PATTERN = /^([0-9a-f]{64})\.bundle$/;
const CATALOG_TEMPORARY_PATTERN = /^\.qlpkg-catalog-[0-9a-f]{32}\.tmp$/;
const BUNDLE_TEMPORARY_PATTERN = /^\.qlpkg-bundle-[0-9a-f]{32}\.tmp$/;

export interface PublishLocalPluginPackageRecoveryCatalogOptions {
  readonly catalogRoot: string;
  readonly bundleRoot: string;
  readonly sourceBundlePath: string;
  readonly lock: PluginPackageLock;
  readonly manifest: PluginPackageManifest;
  readonly signature: PluginPackageSignature;
  readonly trust: PluginPackagePublisherTrustRegistry;
  readonly beforePublish?: () => void | Promise<void>;
  readonly confirmPublicationAllowed?: () => void | Promise<void>;
}

export interface LocalPluginPackageRecoveryCatalogPublisherKeyAnalysis {
  readonly catalogEntryCount: number;
  readonly bundleCount: number;
  readonly matchingEntryCount: number;
  readonly unresolvedTransactions: number;
}

export interface LocalPluginPackageRecoveryCatalogPublisherKeyImpact
  extends LocalPluginPackageRecoveryCatalogPublisherKeyAnalysis {
  readonly impactedLockDigests: readonly string[];
  readonly impactDigest: string;
}

export interface PublishedLocalPluginPackageRecoveryCatalogEntry {
  readonly status: 'published' | 'existing';
  readonly lockDigest: string;
  readonly artifactDigest: string;
}

export interface LocalPluginPackageRecoveryCatalogInspection {
  readonly lockDigests: readonly string[];
  readonly entryCount: number;
  readonly bundleCount: number;
  readonly unresolvedTransactions: number;
}

export interface CollectLocalPluginPackageRecoveryCatalogOptions {
  readonly catalogRoot: string;
  readonly bundleRoot: string;
  readonly candidateLockDigests: readonly string[];
  readonly maxDeletes: number;
  readonly beforeDelete?: () => void | Promise<void>;
}

export interface CollectedLocalPluginPackageRecoveryCatalog {
  readonly removedEntries: number;
  readonly removedBundles: number;
  readonly removedTransactions: number;
  readonly remaining: boolean;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly uid: number;
  readonly device: bigint;
  readonly inode: bigint;
  readonly entries: readonly string[];
}

interface DeletionCandidate {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: number;
  readonly mode: number;
  readonly kind: 'entry' | 'bundle' | 'transaction';
}

interface RecoverySourceEntry {
  readonly schema: typeof LOCAL_PLUGIN_PACKAGE_RECOVERY_SOURCE_SCHEMA;
  readonly lockDigest: string;
  readonly source: Readonly<PluginPackageSourceLock>;
  readonly bundlePath: string;
  readonly manifest: Readonly<PluginPackageManifest>;
  readonly signature: Readonly<PluginPackageSignature>;
}

export class LocalPluginPackageRecoveryCatalogPublicationError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_PUBLICATION_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(
      `Local Plugin Package recovery catalog publication is invalid: ${message}`,
      options,
    );
    this.name = 'LocalPluginPackageRecoveryCatalogPublicationError';
  }
}

export class LocalPluginPackageRecoveryCatalogPublicationConflictError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_PUBLICATION_CONFLICT';

  constructor() {
    super(
      'Local Plugin Package recovery catalog already has different content',
    );
    this.name = 'LocalPluginPackageRecoveryCatalogPublicationConflictError';
  }
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      `${label} must be an object`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true,
    )
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      `${label} must contain enumerable data properties`,
    );
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      `${label} shape is invalid`,
    );
  }
}

function absolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.parse(value).root === value
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      `${label} must be a normalized bounded absolute non-root path`,
    );
  }
  return value;
}

function currentUid(): number {
  if (
    typeof process.getuid !== 'function' ||
    typeof process.geteuid !== 'function' ||
    process.getuid() !== process.geteuid()
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'real and effective POSIX users must match',
    );
  }
  return process.getuid();
}

function directory(
  candidate: string,
  kind: 'catalog' | 'bundle',
): DirectoryIdentity {
  const root = absolutePath(candidate, `${kind}Root`);
  const uid = currentUid();
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(root, { bigint: true });
  } catch (error) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      `${kind} root is unavailable`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    (Number(stat.mode) & 0o777) !== 0o700 ||
    fs.realpathSync(root) !== root
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      `${kind} root must be an owner-only non-symlink directory`,
    );
  }
  const entries = fs.readdirSync(root).sort();
  const finalPattern = kind === 'catalog' ? ENTRY_PATTERN : BUNDLE_PATTERN;
  const temporaryPattern =
    kind === 'catalog' ? CATALOG_TEMPORARY_PATTERN : BUNDLE_TEMPORARY_PATTERN;
  const finalCount = entries.filter((entry) => finalPattern.test(entry)).length;
  const temporaryCount = entries.filter((entry) =>
    temporaryPattern.test(entry),
  ).length;
  if (
    entries.length > MAX_ROOT_ENTRIES ||
    finalCount >
      (kind === 'catalog'
        ? MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_ENTRIES
        : MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_BUNDLES) ||
    temporaryCount > MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_ENTRIES ||
    entries.some(
      (entry) => !finalPattern.test(entry) && !temporaryPattern.test(entry),
    )
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      `${kind} root contains unbounded or unknown entries`,
    );
  }
  return Object.freeze({
    path: root,
    uid,
    device: stat.dev,
    inode: stat.ino,
    entries: Object.freeze(entries),
  });
}

function revalidateDirectory(identity: DirectoryIdentity): void {
  const stat = fs.lstatSync(identity.path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== identity.uid ||
    (Number(stat.mode) & 0o777) !== 0o700 ||
    stat.dev !== identity.device ||
    stat.ino !== identity.inode ||
    fs.realpathSync(identity.path) !== identity.path
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog authority root identity changed',
    );
  }
}

function syncDirectory(directoryPath: string): void {
  const descriptor = fs.openSync(directoryPath, constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readPrivateText(
  filePath: string,
  uid: number,
  maxBytes = MAX_ENTRY_BYTES,
): string {
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
      throw new LocalPluginPackageRecoveryCatalogPublicationError(
        'catalog entry is not a bounded private regular file',
      );
    }
    descriptor = fs.openSync(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
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
      throw new LocalPluginPackageRecoveryCatalogPublicationError(
        'catalog entry identity changed while opening',
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
      throw new LocalPluginPackageRecoveryCatalogPublicationError(
        'catalog entry identity changed while reading',
      );
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      material.subarray(0, offset),
    );
  } catch (error) {
    if (error instanceof LocalPluginPackageRecoveryCatalogPublicationError) {
      throw error;
    }
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog entry cannot be read',
      { cause: error instanceof Error ? error : undefined },
    );
  } finally {
    material?.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sourceLock(value: unknown): Readonly<PluginPackageSourceLock> {
  const source = dataRecord(value, 'source');
  exactKeys(
    source,
    ['artifactBytes', 'artifactDigest', 'contentDigest', 'kind', 'locator'],
    'source',
  );
  if (
    (source.kind !== 'offline' && source.kind !== 'oci') ||
    typeof source.locator !== 'string' ||
    source.locator.length === 0 ||
    Buffer.byteLength(source.locator, 'utf8') > MAX_PATH_BYTES ||
    typeof source.artifactDigest !== 'string' ||
    !DIGEST_PATTERN.test(source.artifactDigest) ||
    !Number.isSafeInteger(source.artifactBytes) ||
    (source.artifactBytes as number) < 1 ||
    typeof source.contentDigest !== 'string' ||
    !DIGEST_PATTERN.test(source.contentDigest)
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'source lock is invalid',
    );
  }
  return Object.freeze({
    kind: source.kind,
    locator: source.locator,
    artifactDigest: source.artifactDigest,
    artifactBytes: source.artifactBytes as number,
    contentDigest: source.contentDigest,
  });
}

function signature(value: unknown): Readonly<PluginPackageSignature> {
  const candidate = dataRecord(value, 'signature');
  exactKeys(
    candidate,
    ['keyId', 'publisher', 'schema', 'signature'],
    'signature',
  );
  if (
    candidate.schema !== PLUGIN_PACKAGE_SIGNATURE_SCHEMA ||
    typeof candidate.publisher !== 'string' ||
    candidate.publisher.length === 0 ||
    typeof candidate.keyId !== 'string' ||
    candidate.keyId.length === 0 ||
    typeof candidate.signature !== 'string' ||
    candidate.signature.length === 0
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'signature is invalid',
    );
  }
  return Object.freeze({
    schema: PLUGIN_PACKAGE_SIGNATURE_SCHEMA,
    publisher: candidate.publisher,
    keyId: candidate.keyId,
    signature: candidate.signature,
  });
}

function parseEntry(
  text: string,
  bundleRoot: string,
): Readonly<RecoverySourceEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog entry JSON is invalid',
      { cause: error instanceof Error ? error : undefined },
    );
  }
  const value = dataRecord(parsed, 'catalog entry');
  exactKeys(
    value,
    ['bundlePath', 'lockDigest', 'manifest', 'schema', 'signature', 'source'],
    'catalog entry',
  );
  const source = sourceLock(value.source);
  if (
    value.schema !== LOCAL_PLUGIN_PACKAGE_RECOVERY_SOURCE_SCHEMA ||
    typeof value.lockDigest !== 'string' ||
    !DIGEST_PATTERN.test(value.lockDigest)
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog entry identity is invalid',
    );
  }
  const expectedBundlePath = path.join(
    bundleRoot,
    `${source.artifactDigest}.bundle`,
  );
  if (value.bundlePath !== expectedBundlePath) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog entry bundle path is not content addressed',
    );
  }
  return Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_RECOVERY_SOURCE_SCHEMA,
    lockDigest: value.lockDigest,
    source,
    bundlePath: expectedBundlePath,
    manifest: normalizePluginPackageManifest(
      value.manifest as PluginPackageManifest,
    ),
    signature: signature(value.signature),
  });
}

function canonicalEntry(value: Readonly<RecoverySourceEntry>): string {
  return `${JSON.stringify(value)}\n`;
}

function recoveryEntry(
  lock: Readonly<PluginPackageLock>,
  bundleRoot: string,
  manifest: Readonly<PluginPackageManifest>,
  signatureValue: Readonly<PluginPackageSignature>,
): Readonly<RecoverySourceEntry> {
  return Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_RECOVERY_SOURCE_SCHEMA,
    lockDigest: lock.lockDigest,
    source: lock.source,
    bundlePath: path.join(bundleRoot, `${lock.source.artifactDigest}.bundle`),
    manifest,
    signature: signatureValue,
  });
}

async function openPrivateBundle(
  bundlePath: string,
  uid: number,
  expectedBytes: number,
): Promise<Readonly<{ handle: FileHandle; identity: fs.BigIntStats }>> {
  const sourcePath = absolutePath(bundlePath, 'sourceBundlePath');
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(sourcePath, { bigint: true });
  } catch (error) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'source bundle is unavailable',
      { cause: error instanceof Error ? error : undefined },
    );
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    Number(before.uid) !== uid ||
    (Number(before.mode) & 0o077) !== 0 ||
    (Number(before.mode) & 0o111) !== 0 ||
    before.size !== BigInt(expectedBytes)
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'source bundle must be an exact owner-only regular file',
    );
  }
  const handle = await fs.promises.open(
    sourcePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const opened = await handle.stat({ bigint: true });
  if (
    !opened.isFile() ||
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    opened.size !== before.size ||
    Number(opened.uid) !== uid ||
    (Number(opened.mode) & 0o077) !== 0 ||
    (Number(opened.mode) & 0o111) !== 0
  ) {
    await handle.close();
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'source bundle identity changed while opening',
    );
  }
  return Object.freeze({ handle, identity: opened });
}

async function* copyChunks(
  source: FileHandle,
  target: FileHandle | undefined,
  expectedBytes: number,
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  while (offset < expectedBytes) {
    const buffer = Buffer.allocUnsafe(
      Math.min(64 * 1024, expectedBytes - offset),
    );
    try {
      const { bytesRead } = await source.read(
        buffer,
        0,
        buffer.byteLength,
        offset,
      );
      if (bytesRead === 0) {
        throw new LocalPluginPackageRecoveryCatalogPublicationError(
          'source bundle ended while reading',
        );
      }
      if (target) {
        let written = 0;
        while (written < bytesRead) {
          const result = await target.write(
            buffer,
            written,
            bytesRead - written,
            offset + written,
          );
          if (result.bytesWritten === 0) {
            throw new LocalPluginPackageRecoveryCatalogPublicationError(
              'materialized bundle write stalled',
            );
          }
          written += result.bytesWritten;
        }
      }
      offset += bytesRead;
      yield buffer.subarray(0, bytesRead);
    } finally {
      buffer.fill(0);
    }
  }
}

async function verifyBundle(
  bundlePath: string,
  temporaryPath: string | undefined,
  uid: number,
  lock: Readonly<PluginPackageLock>,
  manifest: Readonly<PluginPackageManifest>,
  signatureValue: Readonly<PluginPackageSignature>,
  trust: PluginPackagePublisherTrustRegistry,
): Promise<void> {
  const source = await openPrivateBundle(
    bundlePath,
    uid,
    lock.source.artifactBytes,
  );
  let target: FileHandle | undefined;
  try {
    if (temporaryPath) {
      target = await fs.promises.open(temporaryPath, 'wx', 0o600);
    }
    await inspectPluginPackageBundle({
      lock,
      manifest,
      signature: signatureValue,
      trust,
      observedAtMs: lock.createdAtMs,
      chunks: copyChunks(source.handle, target, lock.source.artifactBytes),
    });
    const after = await source.handle.stat({ bigint: true });
    if (
      after.dev !== source.identity.dev ||
      after.ino !== source.identity.ino ||
      after.size !== source.identity.size ||
      Number(after.uid) !== uid ||
      (Number(after.mode) & 0o077) !== 0 ||
      (Number(after.mode) & 0o111) !== 0
    ) {
      throw new LocalPluginPackageRecoveryCatalogPublicationError(
        'source bundle identity changed while reading',
      );
    }
    if (target) await target.sync();
  } finally {
    await target?.close().catch(() => undefined);
    await source.handle.close().catch(() => undefined);
  }
}

function writeEntry(
  catalog: DirectoryIdentity,
  entry: Readonly<RecoverySourceEntry>,
  temporaryPath: string,
): 'published' | 'existing' {
  const contents = canonicalEntry(entry);
  if (Buffer.byteLength(contents, 'utf8') > MAX_ENTRY_BYTES) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog entry exceeds its byte bound',
    );
  }
  const targetPath = path.join(catalog.path, `${entry.lockDigest}.json`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_TRUNC |
        (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0),
    );
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.uid !== catalog.uid ||
      (stat.mode & 0o777) !== 0o600
    ) {
      throw new LocalPluginPackageRecoveryCatalogPublicationError(
        'catalog transaction marker identity is invalid',
      );
    }
    fs.writeFileSync(descriptor, contents, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporaryPath, targetPath);
      syncDirectory(catalog.path);
      return 'published';
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error as { code?: string }).code !== 'EEXIST'
      ) {
        throw error;
      }
      if (readPrivateText(targetPath, catalog.uid) !== contents) {
        throw new LocalPluginPackageRecoveryCatalogPublicationConflictError();
      }
      return 'existing';
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function existingFinalCount(
  identity: DirectoryIdentity,
  pattern: RegExp,
): number {
  return identity.entries.filter((entry) => pattern.test(entry)).length;
}

export async function publishLocalPluginPackageRecoveryCatalogEntry(
  value: PublishLocalPluginPackageRecoveryCatalogOptions,
): Promise<Readonly<PublishedLocalPluginPackageRecoveryCatalogEntry>> {
  const options = dataRecord(value, 'publication options');
  const optional = Object.hasOwn(options, 'beforePublish')
    ? ['beforePublish']
    : [];
  if (Object.hasOwn(options, 'confirmPublicationAllowed')) {
    optional.push('confirmPublicationAllowed');
  }
  exactKeys(
    options,
    [
      'bundleRoot',
      'catalogRoot',
      'lock',
      'manifest',
      'signature',
      'sourceBundlePath',
      'trust',
      ...optional,
    ],
    'publication options',
  );
  const lock = normalizePluginPackageLock(value.lock);
  const manifest = normalizePluginPackageManifest(value.manifest);
  const signatureValue = signature(value.signature);
  if (
    !(value.trust instanceof PluginPackagePublisherTrustRegistry) ||
    (value.beforePublish !== undefined &&
      typeof value.beforePublish !== 'function') ||
    (value.confirmPublicationAllowed !== undefined &&
      typeof value.confirmPublicationAllowed !== 'function')
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'publication authority is invalid',
    );
  }
  const catalog = directory(value.catalogRoot, 'catalog');
  const bundles = directory(value.bundleRoot, 'bundle');
  const sourceBundlePath = absolutePath(
    value.sourceBundlePath,
    'sourceBundlePath',
  );
  if (
    catalog.path === bundles.path ||
    catalog.path === sourceBundlePath ||
    bundles.path === sourceBundlePath
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'publication authority paths must be distinct',
    );
  }
  const entry = recoveryEntry(lock, bundles.path, manifest, signatureValue);
  const targetPath = entry.bundlePath;
  const targetExists = fs.existsSync(targetPath);
  const entryExists = fs.existsSync(
    path.join(catalog.path, `${lock.lockDigest}.json`),
  );
  if (
    !entryExists &&
    existingFinalCount(catalog, ENTRY_PATTERN) >=
      MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_ENTRIES
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog entry capacity is exhausted',
    );
  }
  if (
    !targetExists &&
    existingFinalCount(bundles, BUNDLE_PATTERN) >=
      MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_BUNDLES
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog bundle capacity is exhausted',
    );
  }
  if (catalog.entries.length >= MAX_ROOT_ENTRIES) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog transaction capacity is exhausted',
    );
  }
  const catalogTemporaryPath = path.join(
    catalog.path,
    `.qlpkg-catalog-${randomBytes(16).toString('hex')}.tmp`,
  );
  const temporaryPath = path.join(
    bundles.path,
    `.qlpkg-bundle-${randomBytes(16).toString('hex')}.tmp`,
  );
  let catalogMarker: number | undefined;
  try {
    catalogMarker = fs.openSync(
      catalogTemporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    fs.fsyncSync(catalogMarker);
    fs.closeSync(catalogMarker);
    catalogMarker = undefined;
    syncDirectory(catalog.path);
    await value.confirmPublicationAllowed?.();
    await verifyBundle(
      sourceBundlePath,
      temporaryPath,
      bundles.uid,
      lock,
      manifest,
      signatureValue,
      value.trust,
    );
    await value.beforePublish?.();
    await value.confirmPublicationAllowed?.();
    revalidateDirectory(catalog);
    revalidateDirectory(bundles);
    try {
      fs.linkSync(temporaryPath, targetPath);
      syncDirectory(bundles.path);
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error as { code?: string }).code !== 'EEXIST'
      ) {
        throw error;
      }
      await verifyBundle(
        targetPath,
        undefined,
        bundles.uid,
        lock,
        manifest,
        signatureValue,
        value.trust,
      );
    }
    revalidateDirectory(catalog);
    revalidateDirectory(bundles);
    const status = writeEntry(catalog, entry, catalogTemporaryPath);
    fs.unlinkSync(temporaryPath);
    syncDirectory(bundles.path);
    fs.unlinkSync(catalogTemporaryPath);
    syncDirectory(catalog.path);
    return Object.freeze({
      status,
      lockDigest: lock.lockDigest,
      artifactDigest: lock.source.artifactDigest,
    });
  } catch (error) {
    if (catalogMarker !== undefined) {
      fs.closeSync(catalogMarker);
      catalogMarker = undefined;
    }
    try {
      fs.unlinkSync(temporaryPath);
      syncDirectory(bundles.path);
    } catch {
      // An unresolved private transaction is deliberately visible to GC.
    }
    try {
      fs.unlinkSync(catalogTemporaryPath);
      syncDirectory(catalog.path);
    } catch {
      // An unresolved private transaction is deliberately visible to GC.
    }
    if (
      error instanceof LocalPluginPackageRecoveryCatalogPublicationError ||
      error instanceof LocalPluginPackageRecoveryCatalogPublicationConflictError
    ) {
      throw error;
    }
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog publication is unavailable',
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

function entries(
  catalog: DirectoryIdentity,
  bundleRoot: string,
): readonly Readonly<RecoverySourceEntry>[] {
  return Object.freeze(
    catalog.entries
      .filter((entry) => ENTRY_PATTERN.test(entry))
      .map((name) => {
        const lockDigest = ENTRY_PATTERN.exec(name)?.[1];
        const value = parseEntry(
          readPrivateText(path.join(catalog.path, name), catalog.uid),
          bundleRoot,
        );
        if (value.lockDigest !== lockDigest) {
          throw new LocalPluginPackageRecoveryCatalogPublicationError(
            'catalog filename does not match its entry',
          );
        }
        return value;
      }),
  );
}

export function inspectLocalPluginPackageRecoveryCatalog(
  value: Readonly<{ catalogRoot: string; bundleRoot: string }>,
): Readonly<LocalPluginPackageRecoveryCatalogInspection> {
  const options = dataRecord(value, 'inspection options');
  exactKeys(options, ['bundleRoot', 'catalogRoot'], 'inspection options');
  const catalog = directory(value.catalogRoot, 'catalog');
  const bundles = directory(value.bundleRoot, 'bundle');
  if (catalog.path === bundles.path) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog roots must be distinct',
    );
  }
  const sourceEntries = entries(catalog, bundles.path);
  return Object.freeze({
    lockDigests: Object.freeze(
      sourceEntries.map((entry) => entry.lockDigest).sort(),
    ),
    entryCount: sourceEntries.length,
    bundleCount: existingFinalCount(bundles, BUNDLE_PATTERN),
    unresolvedTransactions:
      catalog.entries.filter((entry) => CATALOG_TEMPORARY_PATTERN.test(entry))
        .length +
      bundles.entries.filter((entry) => BUNDLE_TEMPORARY_PATTERN.test(entry))
        .length,
  });
}

export function analyzeLocalPluginPackageRecoveryCatalogPublisherKey(
  value: Readonly<{
    catalogRoot: string;
    bundleRoot: string;
    publisher: string;
    keyId: string;
  }>,
): Readonly<LocalPluginPackageRecoveryCatalogPublisherKeyAnalysis> {
  const options = dataRecord(value, 'publisher key analysis options');
  exactKeys(
    options,
    ['bundleRoot', 'catalogRoot', 'keyId', 'publisher'],
    'publisher key analysis options',
  );
  if (
    typeof value.publisher !== 'string' ||
    value.publisher.length === 0 ||
    Buffer.byteLength(value.publisher, 'utf8') > 256 ||
    value.publisher.includes('\0') ||
    typeof value.keyId !== 'string' ||
    value.keyId.length === 0 ||
    Buffer.byteLength(value.keyId, 'utf8') > 256 ||
    value.keyId.includes('\0')
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'publisher key identity is invalid',
    );
  }
  const catalog = directory(value.catalogRoot, 'catalog');
  const bundles = directory(value.bundleRoot, 'bundle');
  if (catalog.path === bundles.path) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog roots must be distinct',
    );
  }
  const sourceEntries = entries(catalog, bundles.path);
  return Object.freeze({
    catalogEntryCount: sourceEntries.length,
    bundleCount: existingFinalCount(bundles, BUNDLE_PATTERN),
    matchingEntryCount: sourceEntries.filter(
      (entry) =>
        entry.signature.publisher === value.publisher &&
        entry.signature.keyId === value.keyId,
    ).length,
    unresolvedTransactions:
      catalog.entries.filter((entry) => CATALOG_TEMPORARY_PATTERN.test(entry))
        .length +
      bundles.entries.filter((entry) => BUNDLE_TEMPORARY_PATTERN.test(entry))
        .length,
  });
}

export function analyzeLocalPluginPackageRecoveryCatalogPublisherKeyImpact(
  value: Readonly<{
    catalogRoot: string;
    bundleRoot: string;
    publisher: string;
    keyId: string;
  }>,
): Readonly<LocalPluginPackageRecoveryCatalogPublisherKeyImpact> {
  const options = dataRecord(value, 'publisher key impact options');
  exactKeys(
    options,
    ['bundleRoot', 'catalogRoot', 'keyId', 'publisher'],
    'publisher key impact options',
  );
  if (
    typeof value.publisher !== 'string' ||
    value.publisher.length === 0 ||
    Buffer.byteLength(value.publisher, 'utf8') > 256 ||
    value.publisher.includes('\0') ||
    typeof value.keyId !== 'string' ||
    value.keyId.length === 0 ||
    Buffer.byteLength(value.keyId, 'utf8') > 256 ||
    value.keyId.includes('\0')
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'publisher key identity is invalid',
    );
  }
  const catalog = directory(value.catalogRoot, 'catalog');
  const bundles = directory(value.bundleRoot, 'bundle');
  if (catalog.path === bundles.path) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog roots must be distinct',
    );
  }
  const sourceEntries = entries(catalog, bundles.path);
  const impactedLockDigests = Object.freeze(
    sourceEntries
      .filter(
        (entry) =>
          entry.signature.publisher === value.publisher &&
          entry.signature.keyId === value.keyId,
      )
      .map((entry) => entry.lockDigest)
      .sort(),
  );
  const result = Object.freeze({
    catalogEntryCount: sourceEntries.length,
    bundleCount: existingFinalCount(bundles, BUNDLE_PATTERN),
    matchingEntryCount: impactedLockDigests.length,
    unresolvedTransactions:
      catalog.entries.filter((entry) => CATALOG_TEMPORARY_PATTERN.test(entry))
        .length +
      bundles.entries.filter((entry) => BUNDLE_TEMPORARY_PATTERN.test(entry))
        .length,
    impactedLockDigests,
  });
  return Object.freeze({
    ...result,
    impactDigest: localPluginPackagePublisherKeyRevocationImpactDigest({
      publisher: value.publisher,
      keyId: value.keyId,
      ...result,
    }),
  });
}

function deletionCandidate(
  candidatePath: string,
  kind: DeletionCandidate['kind'],
  uid: number,
): DeletionCandidate {
  const stat = fs.lstatSync(candidatePath, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    (Number(stat.mode) & 0o777) !== 0o600
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'collection candidate is not a private regular file',
    );
  }
  return Object.freeze({
    path: candidatePath,
    device: stat.dev,
    inode: stat.ino,
    uid,
    mode: Number(stat.mode) & 0o777,
    kind,
  });
}

function unlinkCandidate(candidate: DeletionCandidate): void {
  const stat = fs.lstatSync(candidate.path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.dev !== candidate.device ||
    stat.ino !== candidate.inode ||
    Number(stat.uid) !== candidate.uid ||
    (Number(stat.mode) & 0o777) !== candidate.mode
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'collection candidate identity changed',
    );
  }
  fs.unlinkSync(candidate.path);
}

function bundleReferenced(
  catalogRoot: string,
  bundleRoot: string,
  bundlePath: string,
): boolean {
  const catalog = directory(catalogRoot, 'catalog');
  return entries(catalog, bundleRoot).some(
    (entry) => entry.bundlePath === bundlePath,
  );
}

export async function collectLocalPluginPackageRecoveryCatalog(
  value: CollectLocalPluginPackageRecoveryCatalogOptions,
): Promise<Readonly<CollectedLocalPluginPackageRecoveryCatalog>> {
  const options = dataRecord(value, 'collection options');
  const optional = Object.hasOwn(options, 'beforeDelete')
    ? ['beforeDelete']
    : [];
  exactKeys(
    options,
    [
      'bundleRoot',
      'candidateLockDigests',
      'catalogRoot',
      'maxDeletes',
      ...optional,
    ],
    'collection options',
  );
  if (
    !Array.isArray(value.candidateLockDigests) ||
    value.candidateLockDigests.length >
      MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_ENTRIES ||
    value.candidateLockDigests.some(
      (digest) => typeof digest !== 'string' || !DIGEST_PATTERN.test(digest),
    ) ||
    new Set(value.candidateLockDigests).size !==
      value.candidateLockDigests.length ||
    !Number.isSafeInteger(value.maxDeletes) ||
    value.maxDeletes < 1 ||
    value.maxDeletes > MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_ENTRIES ||
    (value.beforeDelete !== undefined &&
      typeof value.beforeDelete !== 'function')
  ) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'collection bounds are invalid',
    );
  }
  const catalog = directory(value.catalogRoot, 'catalog');
  const bundles = directory(value.bundleRoot, 'bundle');
  if (catalog.path === bundles.path) {
    throw new LocalPluginPackageRecoveryCatalogPublicationError(
      'catalog roots must be distinct',
    );
  }
  const sourceEntries = entries(catalog, bundles.path);
  const entryByDigest = new Map(
    sourceEntries.map((entry) => [entry.lockDigest, entry]),
  );
  const plan: DeletionCandidate[] = [];
  for (const name of catalog.entries) {
    if (CATALOG_TEMPORARY_PATTERN.test(name)) {
      plan.push(
        deletionCandidate(
          path.join(catalog.path, name),
          'transaction',
          catalog.uid,
        ),
      );
    }
  }
  for (const name of bundles.entries) {
    if (BUNDLE_TEMPORARY_PATTERN.test(name)) {
      plan.push(
        deletionCandidate(
          path.join(bundles.path, name),
          'transaction',
          bundles.uid,
        ),
      );
    }
  }
  for (const lockDigest of [...value.candidateLockDigests].sort()) {
    if (!entryByDigest.has(lockDigest)) continue;
    plan.push(
      deletionCandidate(
        path.join(catalog.path, `${lockDigest}.json`),
        'entry',
        catalog.uid,
      ),
    );
  }
  const retainedBundlePaths = new Set(
    sourceEntries
      .filter((entry) => !value.candidateLockDigests.includes(entry.lockDigest))
      .map((entry) => entry.bundlePath),
  );
  for (const name of bundles.entries) {
    const match = BUNDLE_PATTERN.exec(name);
    if (!match) continue;
    const bundlePath = path.join(bundles.path, name);
    if (!retainedBundlePaths.has(bundlePath)) {
      plan.push(deletionCandidate(bundlePath, 'bundle', bundles.uid));
    }
  }
  if (plan.length > 0) await value.beforeDelete?.();
  revalidateDirectory(catalog);
  revalidateDirectory(bundles);
  let removedEntries = 0;
  let removedBundles = 0;
  let removedTransactions = 0;
  let consumed = 0;
  for (const candidate of plan) {
    if (consumed >= value.maxDeletes) break;
    if (
      candidate.kind === 'bundle' &&
      bundleReferenced(catalog.path, bundles.path, candidate.path)
    ) {
      continue;
    }
    try {
      unlinkCandidate(candidate);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }
    consumed += 1;
    if (candidate.kind === 'entry') removedEntries += 1;
    else if (candidate.kind === 'bundle') removedBundles += 1;
    else removedTransactions += 1;
  }
  if (consumed > 0) {
    syncDirectory(catalog.path);
    syncDirectory(bundles.path);
  }
  return Object.freeze({
    removedEntries,
    removedBundles,
    removedTransactions,
    remaining: plan.length > consumed,
  });
}
