import fs from 'node:fs';
import path from 'node:path';

import { readPrivateLocalJsonFile } from '@qinglong/local-command-file';
import { createLocalPluginPackageFileStageProvider } from '@qinglong/local-admin/package-installation';
import { assertLocalPluginPackagePublisherKeyPublicationAllowed } from '@qinglong/local-admin/package-publisher-trust';
import type { PluginPackageManifest } from '@qinglong/runtime-core/plugin-package';
import {
  PluginPackagePublisherTrustRegistry,
  type PluginPackagePublisherKeyDefinition,
  type PluginPackageSignature,
} from '@qinglong/runtime-core/plugin-package-bundle';
import {
  normalizePluginPackageLock,
  type PluginPackageLock,
  type PluginPackageSourceLock,
} from '@qinglong/runtime-core/plugin-package-install';
import type { PluginPackageStageProvider } from '@qinglong/runtime-core/plugin-package-installation';

export const LOCAL_PLUGIN_PACKAGE_RECOVERY_SOURCE_SCHEMA =
  'qinglong/local-plugin-package-recovery-source@v1' as const;
export const LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA =
  'qinglong/plugin-package-publisher-trust@v1' as const;
export const MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_ENTRIES = 64;
export const MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_BUNDLES = 64;

const MAX_PATH_BYTES = 4_096;
const MAX_SOURCE_FILE_BYTES = 256 * 1024;
const MAX_TRUST_FILE_BYTES = 256 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_FILE_PATTERN = /^([0-9a-f]{64})\.json$/;
const BUNDLE_FILE_PATTERN = /^([0-9a-f]{64})\.bundle$/;

export interface LocalPluginPackageRecoveryCatalogOptions {
  readonly catalogRoot: string;
  readonly bundleRoot: string;
  readonly publisherTrustFilePath: string;
  readonly stagingRoot: string;
}

interface LocalPluginPackageRecoverySource {
  readonly schema: typeof LOCAL_PLUGIN_PACKAGE_RECOVERY_SOURCE_SCHEMA;
  readonly lockDigest: string;
  readonly source: Readonly<PluginPackageSourceLock>;
  readonly bundlePath: string;
  readonly manifest: PluginPackageManifest;
  readonly signature: PluginPackageSignature;
}

export class LocalPluginPackageRecoveryCatalogError extends Error {
  readonly code = 'QL3_LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(
      `Local Plugin Package recovery catalog is invalid: ${message}`,
      options,
    );
    this.name = 'LocalPluginPackageRecoveryCatalogError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new LocalPluginPackageRecoveryCatalogError(
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
    throw new LocalPluginPackageRecoveryCatalogError(
      `${label} must contain enumerable data properties`,
    );
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new LocalPluginPackageRecoveryCatalogError(
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
    throw new LocalPluginPackageRecoveryCatalogError(
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
    throw new LocalPluginPackageRecoveryCatalogError(
      'real and effective POSIX users must match',
    );
  }
  return process.getuid();
}

interface CatalogDirectoryIdentity {
  readonly path: string;
  readonly uid: number;
  readonly device: bigint;
  readonly inode: bigint;
}

function privateDirectory(
  candidate: string,
  kind: 'catalog' | 'bundle',
): Readonly<CatalogDirectoryIdentity> {
  const directoryPath = absolutePath(candidate, `${kind}Root`);
  const uid = currentUid();
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(directoryPath, { bigint: true });
  } catch (error) {
    throw new LocalPluginPackageRecoveryCatalogError(
      `${kind} root is unavailable`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    (Number(stat.mode) & 0o777) !== 0o700 ||
    fs.realpathSync(directoryPath) !== directoryPath
  ) {
    throw new LocalPluginPackageRecoveryCatalogError(
      `${kind} root must be an owner-only non-symlink directory`,
    );
  }
  const entries = fs.readdirSync(directoryPath);
  const pattern =
    kind === 'catalog' ? SOURCE_FILE_PATTERN : BUNDLE_FILE_PATTERN;
  const maximum =
    kind === 'catalog'
      ? MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_CATALOG_ENTRIES
      : MAX_LOCAL_PLUGIN_PACKAGE_RECOVERY_BUNDLES;
  if (
    entries.length > maximum ||
    entries.some((entry) => !pattern.test(entry))
  ) {
    throw new LocalPluginPackageRecoveryCatalogError(
      `${kind} root contains unbounded or unknown entries`,
    );
  }
  return Object.freeze({
    path: directoryPath,
    uid,
    device: stat.dev,
    inode: stat.ino,
  });
}

function revalidateCatalogDirectory(
  identity: Readonly<CatalogDirectoryIdentity>,
): void {
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
    throw new LocalPluginPackageRecoveryCatalogError(
      'catalog root identity changed while reading',
    );
  }
}

function sourceLock(value: unknown): Readonly<PluginPackageSourceLock> {
  const source = record(value, 'source');
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
    throw new LocalPluginPackageRecoveryCatalogError('source lock is invalid');
  }
  return Object.freeze({
    kind: source.kind,
    locator: source.locator,
    artifactDigest: source.artifactDigest,
    artifactBytes: source.artifactBytes as number,
    contentDigest: source.contentDigest,
  });
}

function sourceMatches(
  left: Readonly<PluginPackageSourceLock>,
  right: Readonly<PluginPackageSourceLock>,
): boolean {
  return (
    left.kind === right.kind &&
    left.locator === right.locator &&
    left.artifactDigest === right.artifactDigest &&
    left.artifactBytes === right.artifactBytes &&
    left.contentDigest === right.contentDigest
  );
}

function loadSource(
  catalogRoot: string,
  bundleRoot: string,
  lock: Readonly<PluginPackageLock>,
): Readonly<LocalPluginPackageRecoverySource> {
  const directory = privateDirectory(catalogRoot, 'catalog');
  const bundles = privateDirectory(bundleRoot, 'bundle');
  const fileName = `${lock.lockDigest}.json`;
  const sourcePath = path.join(directory.path, fileName);
  let value: unknown;
  try {
    value = readPrivateLocalJsonFile(sourcePath, {
      maxBytes: MAX_SOURCE_FILE_BYTES,
    });
  } catch (error) {
    throw new LocalPluginPackageRecoveryCatalogError(
      'locked source entry is unavailable',
      { cause: error instanceof Error ? error : undefined },
    );
  }
  revalidateCatalogDirectory(directory);
  const entry = record(value, 'source entry');
  exactKeys(
    entry,
    ['bundlePath', 'lockDigest', 'manifest', 'schema', 'signature', 'source'],
    'source entry',
  );
  const source = sourceLock(entry.source);
  const expectedBundlePath = path.join(
    bundles.path,
    `${source.artifactDigest}.bundle`,
  );
  if (
    entry.schema !== LOCAL_PLUGIN_PACKAGE_RECOVERY_SOURCE_SCHEMA ||
    entry.lockDigest !== lock.lockDigest ||
    !sourceMatches(source, lock.source) ||
    entry.bundlePath !== expectedBundlePath
  ) {
    throw new LocalPluginPackageRecoveryCatalogError(
      'source entry does not match its durable PackageLock',
    );
  }
  revalidateCatalogDirectory(bundles);
  return Object.freeze({
    schema: LOCAL_PLUGIN_PACKAGE_RECOVERY_SOURCE_SCHEMA,
    lockDigest: lock.lockDigest,
    source,
    bundlePath: expectedBundlePath,
    manifest: entry.manifest as PluginPackageManifest,
    signature: entry.signature as PluginPackageSignature,
  });
}

function loadTrust(filePath: string): PluginPackagePublisherTrustRegistry {
  let value: unknown;
  try {
    value = readPrivateLocalJsonFile(filePath, {
      maxBytes: MAX_TRUST_FILE_BYTES,
    });
  } catch (error) {
    throw new LocalPluginPackageRecoveryCatalogError(
      'publisher trust file is unavailable',
      { cause: error instanceof Error ? error : undefined },
    );
  }
  const trust = record(value, 'publisher trust');
  exactKeys(trust, ['keys', 'schema'], 'publisher trust');
  if (
    trust.schema !== LOCAL_PLUGIN_PACKAGE_PUBLISHER_TRUST_SCHEMA ||
    !Array.isArray(trust.keys)
  ) {
    throw new LocalPluginPackageRecoveryCatalogError(
      'publisher trust file shape is invalid',
    );
  }
  try {
    return new PluginPackagePublisherTrustRegistry(
      trust.keys as PluginPackagePublisherKeyDefinition[],
    );
  } catch (error) {
    throw new LocalPluginPackageRecoveryCatalogError(
      'publisher trust keys are invalid',
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

export function createLocalPluginPackageRecoveryCatalogStageProvider(
  value: LocalPluginPackageRecoveryCatalogOptions,
): PluginPackageStageProvider {
  const options = record(value, 'catalog options');
  exactKeys(
    options,
    ['bundleRoot', 'catalogRoot', 'publisherTrustFilePath', 'stagingRoot'],
    'catalog options',
  );
  const catalogRoot = absolutePath(value.catalogRoot, 'catalogRoot');
  const bundleRoot = absolutePath(value.bundleRoot, 'bundleRoot');
  const publisherTrustFilePath = absolutePath(
    value.publisherTrustFilePath,
    'publisherTrustFilePath',
  );
  const stagingRoot = absolutePath(value.stagingRoot, 'stagingRoot');
  const trustRoot = path.dirname(publisherTrustFilePath);
  if (
    path.basename(publisherTrustFilePath) !== 'current.json' ||
    catalogRoot === publisherTrustFilePath ||
    catalogRoot === stagingRoot ||
    catalogRoot === bundleRoot ||
    bundleRoot === publisherTrustFilePath ||
    bundleRoot === stagingRoot ||
    publisherTrustFilePath === stagingRoot
  ) {
    throw new LocalPluginPackageRecoveryCatalogError(
      'catalog authorities are invalid',
    );
  }
  return Object.freeze({
    async stage(lockValue: Readonly<PluginPackageLock>) {
      const lock = normalizePluginPackageLock(lockValue);
      const source = loadSource(catalogRoot, bundleRoot, lock);
      assertLocalPluginPackagePublisherKeyPublicationAllowed({
        trustRoot,
        publisher: source.signature.publisher,
        keyId: source.signature.keyId,
      });
      const trust = loadTrust(publisherTrustFilePath);
      const staged = await createLocalPluginPackageFileStageProvider({
        bundlePath: source.bundlePath,
        stagingRoot,
        manifest: source.manifest,
        signature: source.signature,
        trust,
        observedAtMs: lock.createdAtMs,
      }).stage(lock);
      assertLocalPluginPackagePublisherKeyPublicationAllowed({
        trustRoot,
        publisher: source.signature.publisher,
        keyId: source.signature.keyId,
      });
      return staged;
    },
  });
}
