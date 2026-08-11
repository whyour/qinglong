import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  pluginPackageContentTreeDigest,
  type PluginPackageContentEntryDescriptor,
} from '@qinglong/runtime-core/plugin-package-bundle';
import {
  normalizePluginPackageResourceGeneration,
  type PluginPackageResourceGeneration,
} from '@qinglong/runtime-core/plugin-package-resource-generation';
import type {
  PluginPackageResourceByteReader,
  PluginPackageResourceByteSource,
} from '@qinglong/runtime-core/plugin-package-resource-materialization';

const STAGE_RECEIPT_SCHEMA = 'qinglong/plugin-package-stage-receipt@v1';
const STAGE_RECEIPT_BYTES = 64 * 1024;
const MAX_STAGE_ENTRIES = 257;
const DIGEST = /^[0-9a-f]{64}$/;
const BLOB = /^[0-9]{4}-[0-9a-f]{64}\.blob$/;

export interface LocalPluginPackageResourceByteSourceOptions {
  /** Existing owner-only 0700 root used by Package staging. */
  readonly stagingRoot: string;
}

export class InvalidLocalPluginPackageResourceSourceError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_RESOURCE_SOURCE_INVALID';

  constructor(message: string) {
    super(`Local Plugin Package resource source is invalid: ${message}`);
    this.name = 'InvalidLocalPluginPackageResourceSourceError';
  }
}

export class LocalPluginPackageResourceSourceUnavailableError extends Error {
  readonly code = 'LOCAL_PLUGIN_PACKAGE_RESOURCE_SOURCE_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super('Local Plugin Package resource source is unavailable', options);
    this.name = 'LocalPluginPackageResourceSourceUnavailableError';
  }
}

interface DirectoryAuthority {
  readonly path: string;
  readonly uid: number;
  readonly device: bigint;
  readonly inode: bigint;
}

interface ReceiptEntry extends PluginPackageContentEntryDescriptor {
  readonly blob: string;
}

function invalid(message: string): never {
  throw new InvalidLocalPluginPackageResourceSourceError(message);
}

function unavailable(error: unknown): never {
  throw new LocalPluginPackageResourceSourceUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return invalid(`${label} must be an object`);
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
    invalid(`${label} shape is invalid`);
  }
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') {
    return invalid('POSIX process identity is required');
  }
  return process.getuid();
}

function absoluteRoot(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 4096
  ) {
    return invalid('staging root must be a bounded non-root absolute path');
  }
  return path.normalize(value);
}

async function directoryAuthority(
  value: string,
  uid: number,
  label: string,
  expectedDevice?: bigint,
): Promise<Readonly<DirectoryAuthority>> {
  const stat = await fs.lstat(value, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    (Number(stat.mode) & 0o777) !== 0o700 ||
    (expectedDevice !== undefined && stat.dev !== expectedDevice)
  ) {
    return invalid(`${label} is not an owner-only directory`);
  }
  return Object.freeze({
    path: value,
    uid,
    device: stat.dev,
    inode: stat.ino,
  });
}

async function verifyDirectory(
  authority: Readonly<DirectoryAuthority>,
): Promise<void> {
  const stat = await fs.lstat(authority.path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== authority.uid ||
    (Number(stat.mode) & 0o777) !== 0o700 ||
    stat.dev !== authority.device ||
    stat.ino !== authority.inode
  ) {
    invalid('staging directory authority changed');
  }
}

async function privateFile(
  authority: Readonly<DirectoryAuthority>,
  filePath: string,
  maximumBytes: number,
  expectedBytes?: number,
): Promise<Buffer> {
  await verifyDirectory(authority);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat({ bigint: true });
    const bytes = Number(before.size);
    if (
      !before.isFile() ||
      Number(before.uid) !== authority.uid ||
      (Number(before.mode) & 0o777) !== 0o600 ||
      before.dev !== authority.device ||
      bytes < 1 ||
      bytes > maximumBytes ||
      (expectedBytes !== undefined && bytes !== expectedBytes)
    ) {
      return invalid('staged file is not private, bounded and exact');
    }
    const material = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      material.byteLength !== bytes
    ) {
      material.fill(0);
      return invalid('staged file changed while it was read');
    }
    await verifyDirectory(authority);
    return material;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function strictJson(value: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return invalid('stage receipt is not strict UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    return invalid('stage receipt is not JSON');
  }
}

function receiptEntries(
  value: unknown,
  generation: Readonly<PluginPackageResourceGeneration>,
): readonly Readonly<ReceiptEntry>[] {
  const receipt = dataRecord(value, 'stage receipt');
  exactKeys(
    receipt,
    ['schema', 'lockDigest', 'inspection', 'entries'],
    'stage receipt',
  );
  const inspection = dataRecord(receipt.inspection, 'stage inspection');
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
    'stage inspection',
  );
  const signature = dataRecord(inspection.signature, 'signature evidence');
  exactKeys(
    signature,
    [
      'publisher',
      'keyId',
      'signatureDigest',
      'keyNotBeforeMs',
      'keyNotAfterMs',
      'verifiedAtMs',
    ],
    'signature evidence',
  );
  if (
    receipt.schema !== STAGE_RECEIPT_SCHEMA ||
    receipt.lockDigest !== generation.lockDigest ||
    inspection.lockDigest !== generation.lockDigest ||
    inspection.packageName !== generation.packageName ||
    inspection.contentDigest !== generation.contentDigest ||
    !Array.isArray(inspection.entries) ||
    !Array.isArray(receipt.entries) ||
    inspection.entries.length !== receipt.entries.length ||
    receipt.entries.length < 1 ||
    receipt.entries.length > MAX_STAGE_ENTRIES
  ) {
    return invalid('stage receipt does not match active generation');
  }
  const expectedPaths = [
    'package.json',
    ...generation.resources.map((resource) => resource.path).sort(),
  ];
  if (expectedPaths.length !== receipt.entries.length) {
    return invalid('stage receipt entry set is incomplete');
  }
  const result: ReceiptEntry[] = [];
  let contentBytes = 0;
  for (const [index, expectedPath] of expectedPaths.entries()) {
    const inspected = dataRecord(
      inspection.entries[index],
      'inspected entry',
    );
    exactKeys(inspected, ['path', 'bytes', 'digest'], 'inspected entry');
    const staged = dataRecord(receipt.entries[index], 'staged entry');
    exactKeys(staged, ['path', 'bytes', 'digest', 'blob'], 'staged entry');
    const expectedBlob = `${index.toString().padStart(4, '0')}-${createHash(
      'sha256',
    )
      .update(expectedPath)
      .digest('hex')}.blob`;
    if (
      inspected.path !== expectedPath ||
      !Number.isSafeInteger(inspected.bytes) ||
      (inspected.bytes as number) < 1 ||
      (inspected.bytes as number) > 4 * 1024 * 1024 ||
      typeof inspected.digest !== 'string' ||
      !DIGEST.test(inspected.digest) ||
      staged.path !== inspected.path ||
      staged.bytes !== inspected.bytes ||
      staged.digest !== inspected.digest ||
      staged.blob !== expectedBlob ||
      !BLOB.test(expectedBlob)
    ) {
      return invalid('stage receipt entry is invalid or inconsistent');
    }
    const entry = Object.freeze({
      path: expectedPath,
      bytes: inspected.bytes as number,
      digest: inspected.digest,
      blob: expectedBlob,
    });
    if (index > 0) contentBytes += entry.bytes;
    result.push(entry);
  }
  if (
    inspection.contentBytes !== contentBytes ||
    pluginPackageContentTreeDigest(
      result.slice(1).map(({ path, bytes, digest }) =>
        Object.freeze({ path, bytes, digest }),
      ),
    ) !== generation.contentDigest
  ) {
    return invalid('stage receipt content tree is inconsistent');
  }
  return Object.freeze(result);
}

class LocalResourceByteReader implements PluginPackageResourceByteReader {
  readonly #stage: Readonly<DirectoryAuthority>;
  readonly #blobs: Readonly<DirectoryAuthority>;
  readonly #entries: Map<string, Readonly<ReceiptEntry>>;
  readonly #readPaths = new Set<string>();
  #closed = false;

  constructor(
    stage: Readonly<DirectoryAuthority>,
    blobs: Readonly<DirectoryAuthority>,
    entries: readonly Readonly<ReceiptEntry>[],
  ) {
    this.#stage = stage;
    this.#blobs = blobs;
    this.#entries = new Map(entries.map((entry) => [entry.path, entry]));
  }

  async read(pathValue: string, maximumBytesValue: number): Promise<Uint8Array> {
    if (this.#closed) return invalid('resource reader is closed');
    if (
      typeof pathValue !== 'string' ||
      !Number.isSafeInteger(maximumBytesValue) ||
      maximumBytesValue < 1 ||
      maximumBytesValue > 4 * 1024 * 1024 ||
      this.#readPaths.has(pathValue)
    ) {
      return invalid('resource read request is invalid or duplicated');
    }
    const entry = this.#entries.get(pathValue);
    if (!entry || entry.bytes > maximumBytesValue) {
      return invalid('resource read is unknown or exceeds its requested bound');
    }
    this.#readPaths.add(pathValue);
    try {
      await verifyDirectory(this.#stage);
      const material = await privateFile(
        this.#blobs,
        path.join(this.#blobs.path, entry.blob),
        maximumBytesValue,
        entry.bytes,
      );
      if (
        createHash('sha256').update(material).digest('hex') !== entry.digest
      ) {
        material.fill(0);
        return invalid('staged resource digest does not match its receipt');
      }
      return material;
    } catch (error) {
      if (error instanceof InvalidLocalPluginPackageResourceSourceError) {
        throw error;
      }
      return unavailable(error);
    }
  }

  close(): void {
    this.#closed = true;
    this.#entries.clear();
    this.#readPaths.clear();
  }
}

export class LocalPluginPackageResourceByteSource
  implements PluginPackageResourceByteSource
{
  readonly #stagingRoot: string;

  constructor(value: LocalPluginPackageResourceByteSourceOptions) {
    const options = dataRecord(value, 'resource source options');
    exactKeys(options, ['stagingRoot'], 'resource source options');
    this.#stagingRoot = absoluteRoot(value.stagingRoot);
    Object.freeze(this);
  }

  async open(
    generationValue: Readonly<PluginPackageResourceGeneration>,
  ): Promise<PluginPackageResourceByteReader> {
    let receiptMaterial: Buffer | undefined;
    try {
      const generation =
        normalizePluginPackageResourceGeneration(generationValue);
      const uid = currentUid();
      const root = await directoryAuthority(
        this.#stagingRoot,
        uid,
        'staging root',
      );
      if ((await fs.realpath(root.path)) !== root.path) {
        return invalid('staging root traverses a symbolic link');
      }
      const stage = await directoryAuthority(
        path.join(root.path, generation.lockDigest),
        uid,
        'stage directory',
        root.device,
      );
      const names = (await fs.readdir(stage.path)).sort();
      if (
        names.length !== 2 ||
        names[0] !== 'blobs' ||
        names[1] !== 'receipt.json'
      ) {
        return invalid('stage directory contains unknown entries');
      }
      const blobs = await directoryAuthority(
        path.join(stage.path, 'blobs'),
        uid,
        'stage blob directory',
        stage.device,
      );
      receiptMaterial = await privateFile(
        stage,
        path.join(stage.path, 'receipt.json'),
        STAGE_RECEIPT_BYTES,
      );
      const entries = receiptEntries(strictJson(receiptMaterial), generation);
      const actualBlobs = (await fs.readdir(blobs.path)).sort();
      const expectedBlobs = entries.map((entry) => entry.blob).sort();
      if (
        actualBlobs.length !== expectedBlobs.length ||
        actualBlobs.some((name, index) => name !== expectedBlobs[index])
      ) {
        return invalid('stage blob inventory is incomplete or contains extras');
      }
      await verifyDirectory(root);
      await verifyDirectory(stage);
      await verifyDirectory(blobs);
      return new LocalResourceByteReader(stage, blobs, entries);
    } catch (error) {
      if (error instanceof InvalidLocalPluginPackageResourceSourceError) {
        throw error;
      }
      return unavailable(error);
    } finally {
      receiptMaterial?.fill(0);
    }
  }
}
