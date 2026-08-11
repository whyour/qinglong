import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  PluginPackageActivationConflictError,
  PluginPackageActivationUnavailableError,
  normalizePluginPackageActivationIntent,
  type PluginPackageActivationIntent,
  type PluginPackageActivationObservation,
  type PluginPackageActivationPublisher,
} from '@qinglong/runtime-core/plugin-package-activation';
import type {
  PluginPackageResourceGeneration,
  PluginPackageResourceGenerationSource,
} from '@qinglong/runtime-core/plugin-package-resource-generation';
import {
  createPluginPackageActivationReceipt,
  normalizePluginPackageActivationReceipt,
  type PluginPackageActivationReceipt,
} from '@qinglong/runtime-core/plugin-package-install';

const ACTIVE_POINTER_SCHEMA = 'qinglong/plugin-package-active-pointer@v2';
const STAGE_RECEIPT_SCHEMA = 'qinglong/plugin-package-stage-receipt@v1';
const STAGE_REFERENCE_PREFIX = 'local-stage:';
const MAX_PATH_BYTES = 4096;
const MAX_STAGE_RECEIPT_BYTES = 64 * 1024;
const MAX_ACTIVE_POINTER_BYTES = 512 * 1024;
const MAX_STAGE_ENTRIES = 256;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BLOB_NAME_PATTERN = /^[0-9]{4}-[0-9a-f]{64}\.blob$/;
const ACTIVE_POINTER_NAME_PATTERN = /^[0-9a-f]{64}\.active\.json$/;

export interface LocalPluginPackageActivationPublisherOptions {
  /** Existing private 0700 directory created for Package staging. */
  readonly stagingRoot: string;
  /** Existing private 0700 directory containing active pointer files. */
  readonly activationRoot: string;
  /** Explicit clock used only when a new pointer wins publication. */
  readonly now: () => number;
}

interface DirectoryAuthority {
  readonly path: string;
  readonly uid: number;
  readonly device: bigint;
  readonly inode: bigint;
}

interface ActivePointer {
  readonly schema: typeof ACTIVE_POINTER_SCHEMA;
  readonly intent: Readonly<PluginPackageActivationIntent>;
  readonly receipt: Readonly<PluginPackageActivationReceipt>;
}

interface OwnedLock {
  readonly device: bigint;
  readonly inode: bigint;
}

function isCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === code,
  );
}

function boundedAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new TypeError(`${label} must be a bounded canonical absolute path`);
  }
  return value;
}

function directoryAuthority(value: unknown, label: string): DirectoryAuthority {
  const directory = boundedAbsolutePath(value, label);
  if (typeof process.getuid !== 'function') {
    throw new TypeError(`${label} requires a POSIX process identity`);
  }
  const uid = process.getuid();
  const stat = fs.lstatSync(directory, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== uid ||
    (Number(stat.mode) & 0o777) !== 0o700
  ) {
    throw new TypeError(`${label} must be a private owned real directory`);
  }
  return Object.freeze({
    path: directory,
    uid,
    device: stat.dev,
    inode: stat.ino,
  });
}

function verifyDirectory(authority: DirectoryAuthority): void {
  const stat = fs.lstatSync(authority.path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    Number(stat.uid) !== authority.uid ||
    (Number(stat.mode) & 0o777) !== 0o700 ||
    stat.dev !== authority.device ||
    stat.ino !== authority.inode
  ) {
    throw new PluginPackageActivationUnavailableError();
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
    throw new PluginPackageActivationConflictError();
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
    throw new PluginPackageActivationConflictError();
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new PluginPackageActivationConflictError();
  }
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new PluginPackageActivationConflictError();
  }
  return value;
}

function boundedInteger(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 256 * 1024 * 1024
  ) {
    throw new PluginPackageActivationConflictError();
  }
  return value as number;
}

function readPrivateFile(
  authority: DirectoryAuthority,
  filePath: string,
  maximumBytes: number,
  allowEmpty = false,
): Buffer {
  verifyDirectory(authority);
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (
      !stat.isFile() ||
      Number(stat.uid) !== authority.uid ||
      (Number(stat.mode) & 0o777) !== 0o600 ||
      (!allowEmpty && stat.size < 1n) ||
      stat.size > BigInt(maximumBytes)
    ) {
      throw new PluginPackageActivationUnavailableError();
    }
    const material = Buffer.alloc(Number(stat.size));
    const bytesRead = fs.readSync(
      descriptor,
      material,
      0,
      material.byteLength,
      0,
    );
    if (bytesRead !== material.byteLength) {
      throw new PluginPackageActivationUnavailableError();
    }
    return material;
  } finally {
    fs.closeSync(descriptor);
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function preserveDomainError(error: unknown): never {
  if (
    error instanceof PluginPackageActivationConflictError ||
    error instanceof PluginPackageActivationUnavailableError
  ) {
    throw error;
  }
  throw new PluginPackageActivationUnavailableError({
    cause: error instanceof Error ? error : undefined,
  });
}

export class LocalPluginPackageActivationPublisher
  implements
    PluginPackageActivationPublisher,
    PluginPackageResourceGenerationSource
{
  readonly #staging: DirectoryAuthority;
  readonly #activation: DirectoryAuthority;
  readonly #now: () => number;

  constructor(options: LocalPluginPackageActivationPublisherOptions) {
    const value = dataRecord(options, 'activation publisher options');
    exactKeys(value, ['stagingRoot', 'activationRoot', 'now']);
    if (typeof options.now !== 'function') {
      throw new TypeError('Plugin Package activation clock is invalid');
    }
    this.#staging = directoryAuthority(
      options.stagingRoot,
      'Plugin Package staging root',
    );
    this.#activation = directoryAuthority(
      options.activationRoot,
      'Plugin Package activation root',
    );
    if (
      this.#staging.device === this.#activation.device &&
      this.#staging.inode === this.#activation.inode
    ) {
      throw new TypeError(
        'Plugin Package staging and activation roots must differ',
      );
    }
    this.#now = options.now;
  }

  #pointerKey(
    intent: Readonly<
      Pick<PluginPackageActivationIntent, 'projectId' | 'packageName'>
    >,
  ): string {
    return createHash('sha256')
      .update('qinglong/plugin-package-active-pointer-key@v1\0', 'utf8')
      .update(intent.projectId, 'utf8')
      .update('\0', 'utf8')
      .update(intent.packageName, 'utf8')
      .digest('hex');
  }

  #pointerPath(
    intent: Readonly<
      Pick<PluginPackageActivationIntent, 'projectId' | 'packageName'>
    >,
  ): string {
    return path.join(
      this.#activation.path,
      `${this.#pointerKey(intent)}.active.json`,
    );
  }

  #lockPath(intent: Readonly<PluginPackageActivationIntent>): string {
    return path.join(
      this.#activation.path,
      `.${this.#pointerKey(intent)}.lock`,
    );
  }

  #assertStage(intent: Readonly<PluginPackageActivationIntent>): void {
    verifyDirectory(this.#staging);
    if (intent.stageRef !== `${STAGE_REFERENCE_PREFIX}${intent.lockDigest}`) {
      throw new PluginPackageActivationConflictError();
    }
    const stageDirectory = path.join(this.#staging.path, intent.lockDigest);
    const stageStat = fs.lstatSync(stageDirectory, { bigint: true });
    if (
      !stageStat.isDirectory() ||
      stageStat.isSymbolicLink() ||
      Number(stageStat.uid) !== this.#staging.uid ||
      (Number(stageStat.mode) & 0o777) !== 0o700
    ) {
      throw new PluginPackageActivationUnavailableError();
    }
    const receiptBytes = readPrivateFile(
      Object.freeze({
        path: stageDirectory,
        uid: this.#staging.uid,
        device: stageStat.dev,
        inode: stageStat.ino,
      }),
      path.join(stageDirectory, 'receipt.json'),
      MAX_STAGE_RECEIPT_BYTES,
    );
    try {
      if (
        createHash('sha256').update(receiptBytes).digest('hex') !==
        intent.stageEvidenceDigest
      ) {
        throw new PluginPackageActivationConflictError();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(receiptBytes.toString('utf8'));
      } catch {
        throw new PluginPackageActivationConflictError();
      }
      const receipt = dataRecord(parsed, 'stage receipt');
      exactKeys(receipt, ['schema', 'lockDigest', 'inspection', 'entries']);
      const inspection = dataRecord(receipt.inspection, 'stage inspection');
      const entries = receipt.entries;
      if (
        receipt.schema !== STAGE_RECEIPT_SCHEMA ||
        receipt.lockDigest !== intent.lockDigest ||
        inspection.lockDigest !== intent.lockDigest ||
        inspection.contentDigest !== intent.contentDigest ||
        !Array.isArray(entries) ||
        entries.length < 1 ||
        entries.length > MAX_STAGE_ENTRIES
      ) {
        throw new PluginPackageActivationConflictError();
      }
      const directoryEntries = fs.readdirSync(stageDirectory).sort();
      if (
        directoryEntries.length !== 2 ||
        directoryEntries[0] !== 'blobs' ||
        directoryEntries[1] !== 'receipt.json'
      ) {
        throw new PluginPackageActivationUnavailableError();
      }
      const blobDirectory = path.join(stageDirectory, 'blobs');
      const blobStat = fs.lstatSync(blobDirectory, { bigint: true });
      if (
        !blobStat.isDirectory() ||
        blobStat.isSymbolicLink() ||
        Number(blobStat.uid) !== this.#staging.uid ||
        (Number(blobStat.mode) & 0o777) !== 0o700
      ) {
        throw new PluginPackageActivationUnavailableError();
      }
      const blobAuthority = Object.freeze({
        path: blobDirectory,
        uid: this.#staging.uid,
        device: blobStat.dev,
        inode: blobStat.ino,
      });
      const expectedNames: string[] = [];
      for (const entryValue of entries) {
        const entry = dataRecord(entryValue, 'stage entry');
        exactKeys(entry, ['path', 'bytes', 'digest', 'blob']);
        const blob = typeof entry.blob === 'string' ? entry.blob : '';
        if (!BLOB_NAME_PATTERN.test(blob)) {
          throw new PluginPackageActivationConflictError();
        }
        const bytes = boundedInteger(entry.bytes);
        const entryDigest = digest(entry.digest);
        const material = readPrivateFile(
          blobAuthority,
          path.join(blobDirectory, blob),
          bytes,
          true,
        );
        try {
          if (
            material.byteLength !== bytes ||
            createHash('sha256').update(material).digest('hex') !== entryDigest
          ) {
            throw new PluginPackageActivationConflictError();
          }
        } finally {
          material.fill(0);
        }
        expectedNames.push(blob);
      }
      expectedNames.sort();
      const actualNames = fs.readdirSync(blobDirectory).sort();
      if (
        actualNames.length !== expectedNames.length ||
        actualNames.some((name, index) => name !== expectedNames[index])
      ) {
        throw new PluginPackageActivationUnavailableError();
      }
    } finally {
      receiptBytes.fill(0);
    }
  }

  #readPointer(
    identity: Readonly<
      Pick<PluginPackageActivationIntent, 'projectId' | 'packageName'>
    >,
  ): Readonly<ActivePointer> | null {
    verifyDirectory(this.#activation);
    let bytes: Buffer;
    try {
      bytes = readPrivateFile(
        this.#activation,
        this.#pointerPath(identity),
        MAX_ACTIVE_POINTER_BYTES,
      );
    } catch (error) {
      if (isCode(error, 'ENOENT')) return null;
      throw error;
    }
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new PluginPackageActivationConflictError();
      }
      const pointer = dataRecord(parsed, 'active pointer');
      exactKeys(pointer, ['schema', 'intent', 'receipt']);
      const pointerIntent = normalizePluginPackageActivationIntent(
        pointer.intent,
      );
      const receipt = normalizePluginPackageActivationReceipt(pointer.receipt);
      if (
        pointer.schema !== ACTIVE_POINTER_SCHEMA ||
        pointerIntent.projectId !== identity.projectId ||
        pointerIntent.packageName !== identity.packageName ||
        receipt.intentDigest !== pointerIntent.intentDigest ||
        receipt.generation !== pointerIntent.targetGeneration ||
        receipt.contentDigest !== pointerIntent.contentDigest ||
        `${JSON.stringify(pointer)}\n` !== bytes.toString('utf8')
      ) {
        throw new PluginPackageActivationConflictError();
      }
      return Object.freeze({
        schema: ACTIVE_POINTER_SCHEMA,
        intent: pointerIntent,
        receipt,
      });
    } finally {
      bytes.fill(0);
    }
  }

  #observe(
    intent: Readonly<PluginPackageActivationIntent>,
  ): Readonly<PluginPackageActivationObservation> {
    this.#assertStage(intent);
    const pointer = this.#readPointer(intent);
    if (!pointer) {
      if (intent.previousActiveLockDigest !== null) {
        throw new PluginPackageActivationConflictError();
      }
      return Object.freeze({ status: 'not_published' });
    }
    if (same(pointer.intent, intent)) {
      return Object.freeze({
        status: 'published',
        receipt: pointer.receipt,
      });
    }
    if (
      pointer.intent.projectId === intent.projectId &&
      pointer.intent.packageName === intent.packageName &&
      pointer.intent.lockDigest === intent.previousActiveLockDigest
    ) {
      return Object.freeze({ status: 'not_published' });
    }
    throw new PluginPackageActivationConflictError();
  }

  async inspect(
    value: Readonly<PluginPackageActivationIntent>,
  ): Promise<Readonly<PluginPackageActivationObservation>> {
    try {
      return this.#observe(normalizePluginPackageActivationIntent(value));
    } catch (error) {
      return preserveDomainError(error);
    }
  }

  async findActiveResourceGeneration(
    projectId: string,
    packageName: string,
  ): Promise<Readonly<PluginPackageResourceGeneration> | null> {
    if (
      typeof projectId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectId) ||
      typeof packageName !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(packageName)
    ) {
      throw new TypeError('Plugin Package active resource identity is invalid');
    }
    try {
      return (
        this.#readPointer(Object.freeze({ projectId, packageName }))?.intent
          .resourceGeneration ?? null
      );
    } catch (error) {
      return preserveDomainError(error);
    }
  }

  async publish(
    value: Readonly<PluginPackageActivationIntent>,
  ): Promise<Readonly<PluginPackageActivationReceipt>> {
    const intent = normalizePluginPackageActivationIntent(value);
    let descriptor: number | undefined;
    let ownedLock: OwnedLock | undefined;
    let temporaryPath: string | undefined;
    const lockPath = this.#lockPath(intent);
    try {
      const first = this.#observe(intent);
      if (first.status === 'published') return first.receipt;
      verifyDirectory(this.#activation);
      descriptor = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const lockStat = fs.fstatSync(descriptor, { bigint: true });
      if (
        !lockStat.isFile() ||
        Number(lockStat.uid) !== this.#activation.uid ||
        (Number(lockStat.mode) & 0o777) !== 0o600 ||
        lockStat.nlink !== 1n
      ) {
        throw new PluginPackageActivationUnavailableError();
      }
      ownedLock = Object.freeze({
        device: lockStat.dev,
        inode: lockStat.ino,
      });
      fs.writeFileSync(descriptor, `${intent.intentDigest}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      syncDirectory(this.#activation.path);

      const second = this.#observe(intent);
      if (second.status === 'published') return second.receipt;
      const activatedAtMs = this.#now();
      if (!Number.isSafeInteger(activatedAtMs) || activatedAtMs < 0) {
        throw new PluginPackageActivationUnavailableError();
      }
      const receipt = createPluginPackageActivationReceipt({
        activationRef: `local-active:${this.#pointerKey(intent)}`,
        intentDigest: intent.intentDigest,
        generation: intent.targetGeneration,
        contentDigest: intent.contentDigest,
        activatedAtMs,
      });
      const pointer: Readonly<ActivePointer> = Object.freeze({
        schema: ACTIVE_POINTER_SCHEMA,
        intent,
        receipt,
      });
      const serialized = `${JSON.stringify(pointer)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > MAX_ACTIVE_POINTER_BYTES) {
        throw new PluginPackageActivationUnavailableError();
      }
      temporaryPath = path.join(
        this.#activation.path,
        `.${this.#pointerKey(intent)}.${randomBytes(16).toString('hex')}.tmp`,
      );
      descriptor = fs.openSync(
        temporaryPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      fs.writeFileSync(descriptor, serialized, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, this.#pointerPath(intent));
      temporaryPath = undefined;
      syncDirectory(this.#activation.path);
      const final = this.#observe(intent);
      if (final.status !== 'published') {
        throw new PluginPackageActivationUnavailableError();
      }
      return final.receipt;
    } catch (error) {
      return preserveDomainError(error);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (temporaryPath) {
        try {
          fs.unlinkSync(temporaryPath);
          syncDirectory(this.#activation.path);
        } catch {
          // A non-published private temporary file requires explicit repair.
        }
      }
      if (ownedLock) {
        try {
          const lockStat = fs.lstatSync(lockPath, { bigint: true });
          if (
            lockStat.isFile() &&
            !lockStat.isSymbolicLink() &&
            Number(lockStat.uid) === this.#activation.uid &&
            (Number(lockStat.mode) & 0o777) === 0o600 &&
            lockStat.dev === ownedLock.device &&
            lockStat.ino === ownedLock.inode
          ) {
            fs.unlinkSync(lockPath);
            syncDirectory(this.#activation.path);
          }
        } catch {
          // A missing or replaced owned lock is left for explicit repair.
        }
      }
    }
  }
}

export function isLocalPluginPackageActivePointerName(value: string): boolean {
  return ACTIVE_POINTER_NAME_PATTERN.test(value);
}
