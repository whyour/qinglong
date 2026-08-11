import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  type PluginPackageManifest,
  normalizePluginPackageManifest,
} from '@qinglong/runtime-core/plugin-package';
import {
  type PluginPackageBundleEntry,
  type PluginPackageBundleInspection,
  type PluginPackageBundleSink,
  type PluginPackagePublisherSignatureEvidence,
  type PluginPackagePublisherTrustRegistry,
  type PluginPackageSignature,
  PLUGIN_PACKAGE_BUNDLE_MEDIA_TYPE,
  inspectPluginPackageBundle,
  pluginPackageContentTreeDigest,
  verifyPluginPackagePublisherSignature,
} from '@qinglong/runtime-core/plugin-package-bundle';
import {
  type PluginPackageLock,
  normalizePluginPackageLock,
} from '@qinglong/runtime-core/plugin-package-install';

const STAGING_RECEIPT_SCHEMA = 'qinglong/plugin-package-stage-receipt@v1';
const STAGING_REFERENCE_PREFIX = 'local-stage:';
const MAX_STAGING_ROOT_ENTRIES = 64;
const MAX_STAGING_RECEIPT_BYTES = 64 * 1024;
const LOCK_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TEMPORARY_DIRECTORY_PATTERN = /^\.qlpkg-[0-9a-f]{32}$/;
const BLOB_NAME_PATTERN = /^[0-9]{4}-[0-9a-f]{64}\.blob$/;

export interface StagePluginPackageFromFileOptions {
  readonly bundlePath: string;
  readonly stagingRoot: string;
  readonly lock: PluginPackageLock;
  readonly manifest: PluginPackageManifest;
  readonly signature: PluginPackageSignature;
  readonly trust: PluginPackagePublisherTrustRegistry;
  readonly observedAtMs: number;
}

export interface StagedPluginPackage {
  readonly status: 'staged' | 'existing';
  readonly stageRef: string;
  readonly directory: string;
  readonly receiptDigest: string;
  readonly inspection: Readonly<PluginPackageBundleInspection>;
}

interface StagingReceiptEntry extends PluginPackageBundleEntry {
  readonly blob: string;
}

interface StagingReceipt {
  readonly schema: typeof STAGING_RECEIPT_SCHEMA;
  readonly lockDigest: string;
  readonly inspection: Readonly<PluginPackageBundleInspection>;
  readonly entries: readonly Readonly<StagingReceiptEntry>[];
}

export class InvalidPluginPackageStagingError extends Error {
  readonly code = 'PLUGIN_PACKAGE_STAGING_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(`Plugin Package staging is invalid: ${message}`, options);
    this.name = 'InvalidPluginPackageStagingError';
  }
}

export class PluginPackageStagingUnavailableError extends Error {
  readonly code = 'PLUGIN_PACKAGE_STAGING_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Plugin Package staging is unavailable', options);
    this.name = 'PluginPackageStagingUnavailableError';
  }
}

function isCode(error: unknown, ...codes: string[]): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    codes.includes((error as { code?: string }).code ?? '')
  );
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidPluginPackageStagingError(`${label} must be an object`);
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
    throw new InvalidPluginPackageStagingError(
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
    throw new InvalidPluginPackageStagingError(`${label} shape is invalid`);
  }
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    throw new InvalidPluginPackageStagingError(
      'local staging requires a POSIX process identity',
    );
  }
  return process.getuid();
}

function boundedAbsolute(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    throw new InvalidPluginPackageStagingError(
      `${label} must be a bounded non-root absolute path`,
    );
  }
  return path.normalize(value);
}

async function privateDirectory(value: string, uid: number): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(value);
  } catch (error) {
    throw new InvalidPluginPackageStagingError(
      'staging root must already exist',
      { cause: error instanceof Error ? error : undefined },
    );
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new InvalidPluginPackageStagingError(
      'staging root must be one owner-only directory',
    );
  }
  if ((await fs.realpath(value)) !== value) {
    throw new InvalidPluginPackageStagingError(
      'staging root must not traverse symbolic links',
    );
  }
  const entries = await fs.readdir(value);
  if (
    entries.length > MAX_STAGING_ROOT_ENTRIES ||
    entries.some(
      (entry) =>
        !LOCK_DIGEST_PATTERN.test(entry) &&
        !TEMPORARY_DIRECTORY_PATTERN.test(entry),
    )
  ) {
    throw new InvalidPluginPackageStagingError(
      'staging root contains unbounded or unknown entries',
    );
  }
  if (entries.some((entry) => TEMPORARY_DIRECTORY_PATTERN.test(entry))) {
    throw new InvalidPluginPackageStagingError(
      'staging root contains an unresolved temporary transaction',
    );
  }
}

async function openPrivateBundle(
  bundlePath: string,
  uid: number,
  expectedBytes: number,
): Promise<FileHandle> {
  let before;
  try {
    before = await fs.lstat(bundlePath);
  } catch (error) {
    throw new InvalidPluginPackageStagingError('bundle file is unavailable', {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== uid ||
    (before.mode & 0o077) !== 0 ||
    (before.mode & 0o111) !== 0 ||
    before.size !== expectedBytes
  ) {
    throw new InvalidPluginPackageStagingError(
      'bundle must be an exact owner-only regular file',
    );
  }
  let handle: FileHandle;
  try {
    handle = await fs.open(
      bundlePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw new InvalidPluginPackageStagingError('bundle file cannot be opened', {
      cause: error instanceof Error ? error : undefined,
    });
  }
  const opened = await handle.stat();
  if (
    !opened.isFile() ||
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    opened.uid !== uid ||
    (opened.mode & 0o077) !== 0 ||
    (opened.mode & 0o111) !== 0 ||
    opened.size !== expectedBytes
  ) {
    await handle.close();
    throw new InvalidPluginPackageStagingError(
      'bundle identity changed while opening',
    );
  }
  return handle;
}

async function* fileChunks(
  handle: FileHandle,
  expectedBytes: number,
): AsyncGenerator<Uint8Array> {
  let offset = 0;
  while (offset < expectedBytes) {
    const buffer = Buffer.allocUnsafe(
      Math.min(64 * 1024, expectedBytes - offset),
    );
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      offset,
    );
    if (bytesRead === 0) {
      throw new InvalidPluginPackageStagingError(
        'bundle ended while it was being staged',
      );
    }
    offset += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

function canonicalReceipt(receipt: Readonly<StagingReceipt>): string {
  return `${JSON.stringify(receipt)}\n`;
}

function receiptDigest(receipt: Readonly<StagingReceipt>): string {
  return createHash('sha256').update(canonicalReceipt(receipt)).digest('hex');
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

class OpaqueBlobStagingSink implements PluginPackageBundleSink {
  readonly #temporaryDirectory: string;
  readonly #blobDirectory: string;
  readonly #entries: StagingReceiptEntry[] = [];
  #currentHandle: FileHandle | undefined;
  #currentBlob: string | undefined;
  #currentBytes = 0;
  #receipt: Readonly<StagingReceipt> | undefined;

  constructor(temporaryDirectory: string) {
    this.#temporaryDirectory = temporaryDirectory;
    this.#blobDirectory = path.join(temporaryDirectory, 'blobs');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.#temporaryDirectory, { mode: 0o700 });
    await fs.mkdir(this.#blobDirectory, { mode: 0o700 });
  }

  async begin(entry: Readonly<{ path: string; bytes: number }>): Promise<void> {
    if (this.#currentHandle || this.#entries.length > 9_999) {
      throw new InvalidPluginPackageStagingError(
        'staging sink entry sequence is invalid',
      );
    }
    const pathDigest = createHash('sha256').update(entry.path).digest('hex');
    this.#currentBlob = `${this.#entries.length
      .toString()
      .padStart(4, '0')}-${pathDigest}.blob`;
    this.#currentBytes = 0;
    this.#currentHandle = await fs.open(
      path.join(this.#blobDirectory, this.#currentBlob),
      'wx',
      0o600,
    );
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.#currentHandle) {
      throw new InvalidPluginPackageStagingError(
        'staging sink has no active entry',
      );
    }
    await this.#currentHandle.writeFile(chunk);
    this.#currentBytes += chunk.byteLength;
  }

  async end(entry: Readonly<PluginPackageBundleEntry>): Promise<void> {
    if (
      !this.#currentHandle ||
      !this.#currentBlob ||
      this.#currentBytes !== entry.bytes
    ) {
      throw new InvalidPluginPackageStagingError(
        'staging sink entry boundary is invalid',
      );
    }
    await this.#currentHandle.sync();
    await this.#currentHandle.close();
    this.#currentHandle = undefined;
    this.#entries.push(Object.freeze({ ...entry, blob: this.#currentBlob }));
    this.#currentBlob = undefined;
    this.#currentBytes = 0;
  }

  async commit(
    inspection: Readonly<PluginPackageBundleInspection>,
  ): Promise<void> {
    if (
      this.#currentHandle ||
      this.#entries.length !== inspection.entries.length
    ) {
      throw new InvalidPluginPackageStagingError(
        'staging sink cannot commit incomplete entries',
      );
    }
    const receipt = Object.freeze({
      schema: STAGING_RECEIPT_SCHEMA,
      lockDigest: inspection.lockDigest,
      inspection,
      entries: Object.freeze(this.#entries),
    });
    const serialized = canonicalReceipt(receipt);
    if (Buffer.byteLength(serialized) > MAX_STAGING_RECEIPT_BYTES) {
      throw new InvalidPluginPackageStagingError(
        'staging receipt exceeds its byte budget',
      );
    }
    const handle = await fs.open(
      path.join(this.#temporaryDirectory, 'receipt.json'),
      'wx',
      0o600,
    );
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(this.#blobDirectory);
    await syncDirectory(this.#temporaryDirectory);
    this.#receipt = receipt;
  }

  async abort(): Promise<void> {
    await this.#currentHandle?.close().catch(() => undefined);
    this.#currentHandle = undefined;
  }

  receipt(): Readonly<StagingReceipt> {
    if (!this.#receipt) {
      throw new InvalidPluginPackageStagingError(
        'staging receipt is not committed',
      );
    }
    return this.#receipt;
  }

  blobNames(): readonly string[] {
    const values = this.#entries.map((entry) => entry.blob);
    if (this.#currentBlob) values.push(this.#currentBlob);
    return values;
  }
}

async function cleanupTemporary(
  temporaryDirectory: string,
  blobNames: readonly string[],
): Promise<void> {
  const parent = path.dirname(temporaryDirectory);
  if (
    !TEMPORARY_DIRECTORY_PATTERN.test(path.basename(temporaryDirectory)) ||
    path.dirname(path.join(parent, path.basename(temporaryDirectory))) !==
      parent
  ) {
    return;
  }
  const blobDirectory = path.join(temporaryDirectory, 'blobs');
  await Promise.all(
    blobNames.map((blob) =>
      BLOB_NAME_PATTERN.test(blob)
        ? fs.unlink(path.join(blobDirectory, blob)).catch(() => undefined)
        : Promise.resolve(),
    ),
  );
  await fs
    .unlink(path.join(temporaryDirectory, 'receipt.json'))
    .catch(() => undefined);
  await fs.rmdir(blobDirectory).catch(() => undefined);
  await fs.rmdir(temporaryDirectory).catch(() => undefined);
}

function parseReceipt(
  value: string,
  lock: Readonly<PluginPackageLock>,
  manifest: Readonly<PluginPackageManifest>,
  signature: Readonly<PluginPackagePublisherSignatureEvidence>,
): Readonly<StagingReceipt> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new InvalidPluginPackageStagingError('staging receipt is not JSON', {
      cause: error instanceof Error ? error : undefined,
    });
  }
  const receipt = dataRecord(parsed, 'staging receipt');
  exactKeys(
    receipt,
    ['schema', 'lockDigest', 'inspection', 'entries'],
    'receipt',
  );
  if (
    receipt.schema !== STAGING_RECEIPT_SCHEMA ||
    receipt.lockDigest !== lock.lockDigest
  ) {
    throw new InvalidPluginPackageStagingError(
      'staging receipt does not match its PackageLock',
    );
  }
  const inspection = dataRecord(receipt.inspection, 'receipt inspection');
  exactKeys(
    inspection,
    [
      'mediaType',
      'lockDigest',
      'packageName',
      'packageVersion',
      'artifactBytes',
      'artifactDigest',
      'manifestDigest',
      'contentBytes',
      'contentDigest',
      'entries',
      'signature',
    ],
    'receipt inspection',
  );
  if (
    inspection.mediaType !== PLUGIN_PACKAGE_BUNDLE_MEDIA_TYPE ||
    inspection.lockDigest !== lock.lockDigest ||
    inspection.packageName !== lock.packageName ||
    inspection.packageVersion !== lock.packageVersion ||
    inspection.artifactBytes !== lock.source.artifactBytes ||
    inspection.artifactDigest !== lock.source.artifactDigest ||
    inspection.manifestDigest !== lock.manifestDigest ||
    inspection.contentDigest !== lock.source.contentDigest ||
    !Array.isArray(receipt.entries) ||
    !Array.isArray(inspection.entries) ||
    receipt.entries.length !== inspection.entries.length
  ) {
    throw new InvalidPluginPackageStagingError(
      'staging receipt inspection is inconsistent',
    );
  }
  const receiptSignature = dataRecord(
    inspection.signature,
    'receipt signature evidence',
  );
  exactKeys(
    receiptSignature,
    [
      'publisher',
      'keyId',
      'signatureDigest',
      'keyNotBeforeMs',
      'keyNotAfterMs',
      'verifiedAtMs',
    ],
    'receipt signature evidence',
  );
  if (JSON.stringify(receiptSignature) !== JSON.stringify(signature)) {
    throw new InvalidPluginPackageStagingError(
      'staging receipt signature evidence is inconsistent',
    );
  }
  const expectedPaths = [
    'package.json',
    ...[
      ...manifest.spec.contents.tasks,
      ...manifest.spec.contents.workflows,
      ...manifest.spec.contents.prompts,
      ...manifest.spec.contents.tools,
    ].sort(),
  ];
  if (inspection.entries.length !== expectedPaths.length) {
    throw new InvalidPluginPackageStagingError(
      'staging receipt entry count is inconsistent',
    );
  }
  let contentBytes = 0;
  const normalizedInspectionEntries: PluginPackageBundleEntry[] = [];
  const normalizedReceiptEntries: StagingReceiptEntry[] = [];
  for (const [index, expectedPath] of expectedPaths.entries()) {
    const inspected = dataRecord(
      inspection.entries[index],
      'receipt inspected entry',
    );
    exactKeys(
      inspected,
      ['path', 'bytes', 'digest'],
      'receipt inspected entry',
    );
    const staged = dataRecord(receipt.entries[index], 'receipt staged entry');
    exactKeys(
      staged,
      ['path', 'bytes', 'digest', 'blob'],
      'receipt staged entry',
    );
    if (
      inspected.path !== expectedPath ||
      typeof inspected.bytes !== 'number' ||
      !Number.isSafeInteger(inspected.bytes) ||
      inspected.bytes < 0 ||
      typeof inspected.digest !== 'string' ||
      !LOCK_DIGEST_PATTERN.test(inspected.digest)
    ) {
      throw new InvalidPluginPackageStagingError(
        'staging receipt inspected entry is invalid',
      );
    }
    const expectedBlob = `${index.toString().padStart(4, '0')}-${createHash(
      'sha256',
    )
      .update(expectedPath)
      .digest('hex')}.blob`;
    if (
      staged.path !== inspected.path ||
      staged.bytes !== inspected.bytes ||
      staged.digest !== inspected.digest ||
      staged.blob !== expectedBlob
    ) {
      throw new InvalidPluginPackageStagingError(
        'staging receipt staged entry is inconsistent',
      );
    }
    if (index > 0) contentBytes += inspected.bytes;
    normalizedInspectionEntries.push(
      Object.freeze({
        path: expectedPath,
        bytes: inspected.bytes,
        digest: inspected.digest,
      }),
    );
    normalizedReceiptEntries.push(
      Object.freeze({
        path: expectedPath,
        bytes: inspected.bytes,
        digest: inspected.digest,
        blob: expectedBlob,
      }),
    );
  }
  if (
    inspection.contentBytes !== contentBytes ||
    pluginPackageContentTreeDigest(normalizedInspectionEntries.slice(1)) !==
      lock.source.contentDigest
  ) {
    throw new InvalidPluginPackageStagingError(
      'staging receipt content evidence is inconsistent',
    );
  }
  const normalizedInspection = Object.freeze({
    mediaType: PLUGIN_PACKAGE_BUNDLE_MEDIA_TYPE,
    lockDigest: lock.lockDigest,
    packageName: lock.packageName,
    packageVersion: lock.packageVersion,
    artifactBytes: lock.source.artifactBytes,
    artifactDigest: lock.source.artifactDigest,
    manifestDigest: lock.manifestDigest,
    contentBytes,
    contentDigest: lock.source.contentDigest,
    entries: Object.freeze(normalizedInspectionEntries),
    signature,
  });
  return Object.freeze({
    schema: STAGING_RECEIPT_SCHEMA,
    lockDigest: lock.lockDigest,
    inspection: normalizedInspection,
    entries: Object.freeze(normalizedReceiptEntries),
  });
}

async function readExistingStage(
  directory: string,
  lock: Readonly<PluginPackageLock>,
  manifest: Readonly<PluginPackageManifest>,
  signature: Readonly<PluginPackagePublisherSignatureEvidence>,
  uid: number,
): Promise<Readonly<StagingReceipt> | undefined> {
  let directoryStat;
  try {
    directoryStat = await fs.lstat(directory);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== uid ||
    (directoryStat.mode & 0o777) !== 0o700
  ) {
    throw new InvalidPluginPackageStagingError(
      'existing stage directory is not private',
    );
  }
  const receiptPath = path.join(directory, 'receipt.json');
  const receiptHandle = await fs.open(
    receiptPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let serialized: Buffer;
  try {
    const stat = await receiptHandle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size < 1 ||
      stat.size > MAX_STAGING_RECEIPT_BYTES
    ) {
      throw new InvalidPluginPackageStagingError(
        'existing staging receipt is not private and bounded',
      );
    }
    serialized = Buffer.allocUnsafe(stat.size);
    const { bytesRead } = await receiptHandle.read(
      serialized,
      0,
      serialized.byteLength,
      0,
    );
    if (bytesRead !== serialized.byteLength) {
      throw new InvalidPluginPackageStagingError(
        'existing staging receipt changed while reading',
      );
    }
  } finally {
    await receiptHandle.close();
  }
  const receipt = parseReceipt(
    serialized.toString('utf8'),
    lock,
    manifest,
    signature,
  );
  if (canonicalReceipt(receipt) !== serialized.toString('utf8')) {
    throw new InvalidPluginPackageStagingError(
      'existing staging receipt is not canonical',
    );
  }
  const directoryEntries = (await fs.readdir(directory)).sort();
  if (
    directoryEntries.length !== 2 ||
    directoryEntries[0] !== 'blobs' ||
    directoryEntries[1] !== 'receipt.json'
  ) {
    throw new InvalidPluginPackageStagingError(
      'existing stage contains unknown entries',
    );
  }
  const blobDirectory = path.join(directory, 'blobs');
  const blobStat = await fs.lstat(blobDirectory);
  if (
    !blobStat.isDirectory() ||
    blobStat.isSymbolicLink() ||
    blobStat.uid !== uid ||
    (blobStat.mode & 0o777) !== 0o700
  ) {
    throw new InvalidPluginPackageStagingError(
      'existing stage blob directory is not private',
    );
  }
  const blobNames = (await fs.readdir(blobDirectory)).sort();
  const expectedBlobNames = receipt.entries.map((entry) => entry.blob).sort();
  if (
    blobNames.length !== expectedBlobNames.length ||
    blobNames.some((name, index) => name !== expectedBlobNames[index])
  ) {
    throw new InvalidPluginPackageStagingError(
      'existing stage blob set is inconsistent',
    );
  }
  for (const [index, entry] of receipt.entries.entries()) {
    const inspected = receipt.inspection.entries[index];
    if (
      !inspected ||
      !BLOB_NAME_PATTERN.test(entry.blob) ||
      entry.path !== inspected.path ||
      entry.bytes !== inspected.bytes ||
      entry.digest !== inspected.digest
    ) {
      throw new InvalidPluginPackageStagingError(
        'existing stage entry metadata is inconsistent',
      );
    }
    const handle = await fs.open(
      path.join(blobDirectory, entry.blob),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.uid !== uid ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size !== entry.bytes
      ) {
        throw new InvalidPluginPackageStagingError(
          'existing stage blob is not private and exact',
        );
      }
      const hash = createHash('sha256');
      let offset = 0;
      while (offset < entry.bytes) {
        const buffer = Buffer.allocUnsafe(
          Math.min(64 * 1024, entry.bytes - offset),
        );
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.byteLength,
          offset,
        );
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (offset !== entry.bytes || hash.digest('hex') !== entry.digest) {
        throw new InvalidPluginPackageStagingError(
          'existing stage blob digest does not match',
        );
      }
    } finally {
      await handle.close();
    }
  }
  return receipt;
}

export async function stagePluginPackageFromFile(
  value: StagePluginPackageFromFileOptions,
): Promise<Readonly<StagedPluginPackage>> {
  const options = dataRecord(value, 'staging options');
  exactKeys(
    options,
    [
      'bundlePath',
      'stagingRoot',
      'lock',
      'manifest',
      'signature',
      'trust',
      'observedAtMs',
    ],
    'staging options',
  );
  const lock = normalizePluginPackageLock(value.lock);
  const manifest = normalizePluginPackageManifest(value.manifest);
  const bundlePath = boundedAbsolute(value.bundlePath, 'bundlePath');
  const stagingRoot = boundedAbsolute(value.stagingRoot, 'stagingRoot');
  const signature = verifyPluginPackagePublisherSignature(
    lock,
    value.signature,
    value.trust,
    value.observedAtMs,
  );
  const uid = currentUid();
  await privateDirectory(stagingRoot, uid);
  const finalDirectory = path.join(stagingRoot, lock.lockDigest);
  const existing = await readExistingStage(
    finalDirectory,
    lock,
    manifest,
    signature,
    uid,
  );
  if (existing) {
    return Object.freeze({
      status: 'existing',
      stageRef: `${STAGING_REFERENCE_PREFIX}${lock.lockDigest}`,
      directory: finalDirectory,
      receiptDigest: receiptDigest(existing),
      inspection: existing.inspection,
    });
  }

  const temporaryDirectory = path.join(
    stagingRoot,
    `.qlpkg-${randomBytes(16).toString('hex')}`,
  );
  const sink = new OpaqueBlobStagingSink(temporaryDirectory);
  let handle: FileHandle | undefined;
  try {
    await sink.initialize();
    handle = await openPrivateBundle(
      bundlePath,
      uid,
      lock.source.artifactBytes,
    );
    const inspection = await inspectPluginPackageBundle({
      lock,
      manifest,
      signature: value.signature,
      trust: value.trust,
      observedAtMs: value.observedAtMs,
      chunks: fileChunks(handle, lock.source.artifactBytes),
      sink,
    });
    await handle.close();
    handle = undefined;
    const receipt = sink.receipt();
    try {
      await fs.rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      if (!isCode(error, 'EEXIST', 'ENOTEMPTY')) throw error;
      await cleanupTemporary(temporaryDirectory, sink.blobNames());
      const raced = await readExistingStage(
        finalDirectory,
        lock,
        manifest,
        signature,
        uid,
      );
      if (!raced) throw error;
      return Object.freeze({
        status: 'existing',
        stageRef: `${STAGING_REFERENCE_PREFIX}${lock.lockDigest}`,
        directory: finalDirectory,
        receiptDigest: receiptDigest(raced),
        inspection: raced.inspection,
      });
    }
    await syncDirectory(stagingRoot);
    return Object.freeze({
      status: 'staged',
      stageRef: `${STAGING_REFERENCE_PREFIX}${lock.lockDigest}`,
      directory: finalDirectory,
      receiptDigest: receiptDigest(receipt),
      inspection,
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await sink.abort().catch(() => undefined);
    await cleanupTemporary(temporaryDirectory, sink.blobNames());
    if (error instanceof InvalidPluginPackageStagingError) throw error;
    throw new PluginPackageStagingUnavailableError({
      cause: error instanceof Error ? error : undefined,
    });
  }
}
