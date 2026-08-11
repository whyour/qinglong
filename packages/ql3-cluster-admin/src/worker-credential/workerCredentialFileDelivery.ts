/** POSIX file-backed Worker credential delivery adapter boundary. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  WorkerCredentialDeliveryConflictError,
  WorkerCredentialDeliveryUnavailableError,
  normalizeWorkerCredentialDeliveryIntent,
  normalizeWorkerCredentialDeliveryRecord,
  workerCredentialDeliveryTokenDigest,
  type WorkerCredentialDeliveryIntent,
  type WorkerCredentialDeliveryRecord,
} from '@qinglong/runtime-core/worker-credential-delivery';
import type {
  WorkerCredentialStagedSecretInventoryAdapter,
  WorkerCredentialStagedSecretPage,
} from './workerCredentialDelivery';

const MAX_PATH_BYTES = 4096;
const MAX_STAGE_BYTES = 8192;
const MAX_STAGE_HEADER_BYTES = 4096;
const MAX_TOKEN_BYTES = 256;
export const MAX_WORKER_CREDENTIAL_FILE_STAGES = 128;
export const MAX_WORKER_CREDENTIAL_FILE_STAGE_PAGE_SIZE = 64;
const STAGE_MAGIC = Buffer.from(
  'qinglong/worker-credential-file-stage@v1\n',
  'ascii',
);
const TARGET_DIGEST_DOMAIN = Buffer.from(
  'qinglong/worker-credential-file-target@v1\0',
  'utf8',
);
const PUBLICATION_DIGEST_DOMAIN = Buffer.from(
  'qinglong/worker-credential-file-publication@v1\0',
  'utf8',
);
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STAGE_NAME =
  /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.stage$/;
const STAGE_TEMP_NAME =
  /^\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[0-9a-f-]{36}\.tmp$/;
const TOKEN =
  /^ql3w_([A-Za-z0-9][A-Za-z0-9._:-]{0,63})_([A-Za-z0-9_-]{43})$/;
const TARGET_LOCK_NAME = '.ql3-worker-credential-delivery.lock';

export interface WorkerCredentialFileDeliveryAdapterOptions {
  /** Dedicated private 0700 directory containing bounded durable stages. */
  readonly stageDirectory: string;
  /** Atomically replaceable 0600 ql3w token file read by worker-runtime. */
  readonly targetTokenFile: string;
}

export type WorkerCredentialFileStagePage = WorkerCredentialStagedSecretPage;

interface ParsedToken {
  readonly credentialId: string;
  readonly tokenDigest: string;
}

interface StagedSecret {
  readonly intent: Readonly<WorkerCredentialDeliveryIntent>;
  readonly token: Buffer;
}

interface OwnedTargetLock {
  readonly device: bigint;
  readonly inode: bigint;
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT',
  );
}

function isExists(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EEXIST',
  );
}

function boundedAbsolutePath(value: string, name: string): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.parse(value).root === value ||
    path.normalize(value) !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES
  ) {
    throw new TypeError(`${name} must be a bounded canonical absolute path`);
  }
  return value;
}

class PrivateDirectoryAuthority {
  readonly directory: string;
  readonly uid: number;
  readonly device: bigint;
  readonly inode: bigint;

  constructor(directory: string, name: string) {
    this.directory = boundedAbsolutePath(directory, name);
    if (typeof process.getuid !== 'function') {
      throw new TypeError(`${name} requires a POSIX process identity`);
    }
    this.uid = process.getuid();
    const stat = fs.lstatSync(this.directory, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      Number(stat.uid) !== this.uid ||
      (Number(stat.mode) & 0o777) !== 0o700
    ) {
      throw new TypeError(`${name} must be a private owned real directory`);
    }
    this.device = stat.dev;
    this.inode = stat.ino;
  }

  verify(): void {
    const stat = fs.lstatSync(this.directory, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      Number(stat.uid) !== this.uid ||
      (Number(stat.mode) & 0o777) !== 0o700 ||
      stat.dev !== this.device ||
      stat.ino !== this.inode
    ) {
      throw new WorkerCredentialDeliveryUnavailableError();
    }
  }

  sync(): void {
    this.verify();
    const descriptor = fs.openSync(this.directory, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
}

function readPrivateFile(
  authority: PrivateDirectoryAuthority,
  filePath: string,
  maximumBytes: number,
): Buffer {
  authority.verify();
  const before = fs.lstatSync(filePath, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    Number(before.uid) !== authority.uid ||
    (Number(before.mode) & 0o777) !== 0o600 ||
    before.size < 1n ||
    before.size > BigInt(maximumBytes)
  ) {
    throw new WorkerCredentialDeliveryUnavailableError();
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new WorkerCredentialDeliveryUnavailableError();
    }
    const bytes = fs.readFileSync(descriptor);
    if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
      bytes.fill(0);
      throw new WorkerCredentialDeliveryUnavailableError();
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseToken(bytes: Buffer): ParsedToken {
  let visible = bytes;
  if (visible[visible.byteLength - 1] === 0x0a) {
    visible = visible.subarray(0, -1);
  }
  if (
    visible.byteLength < 1 ||
    visible.byteLength > MAX_TOKEN_BYTES ||
    visible.includes(0x0a) ||
    visible.some((byte) => byte > 0x7f)
  ) {
    throw new WorkerCredentialDeliveryUnavailableError();
  }
  const match = TOKEN.exec(visible.toString('ascii'));
  if (!match) throw new WorkerCredentialDeliveryUnavailableError();
  return Object.freeze({
    credentialId: match[1]!,
    tokenDigest: workerCredentialDeliveryTokenDigest(visible),
  });
}

function sameIntent(
  left: Readonly<WorkerCredentialDeliveryIntent>,
  right: Readonly<WorkerCredentialDeliveryIntent>,
): boolean {
  return (
    left.deliveryId === right.deliveryId &&
    left.workerId === right.workerId &&
    left.credentialId === right.credentialId &&
    left.credentialVersion === right.credentialVersion &&
    left.previousCredentialId === right.previousCredentialId &&
    left.secretDigest === right.secretDigest &&
    left.tokenDigest === right.tokenDigest &&
    left.deploymentTargetDigest === right.deploymentTargetDigest &&
    left.deploymentGeneration === right.deploymentGeneration &&
    left.stagedAtMs === right.stagedAtMs
  );
}

function recordMatchesIntent(
  record: Readonly<WorkerCredentialDeliveryRecord>,
  intent: Readonly<WorkerCredentialDeliveryIntent>,
): boolean {
  return sameIntent(record, intent);
}

function preserveDomainError(error: unknown): never {
  if (
    error instanceof WorkerCredentialDeliveryConflictError ||
    error instanceof WorkerCredentialDeliveryUnavailableError
  ) {
    throw error;
  }
  throw new WorkerCredentialDeliveryUnavailableError();
}

/**
 * Concrete short-lived POSIX adapter for Docker bind mounts, systemd services,
 * and controlled shared volumes. It owns no timer, socket, database or cache.
 */
export class WorkerCredentialFileDeliveryAdapter
  implements WorkerCredentialStagedSecretInventoryAdapter {
  readonly deploymentTargetDigest: string;
  private readonly stages: PrivateDirectoryAuthority;
  private readonly targetParent: PrivateDirectoryAuthority;
  private readonly targetTokenFile: string;
  private readonly targetLockFile: string;

  constructor(options: WorkerCredentialFileDeliveryAdapterOptions) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(options, 'stageDirectory') ||
      !Object.prototype.hasOwnProperty.call(options, 'targetTokenFile')
    ) {
      throw new TypeError('Worker credential file delivery options are invalid');
    }
    this.stages = new PrivateDirectoryAuthority(
      options.stageDirectory,
      'Worker credential stage directory',
    );
    this.targetTokenFile = boundedAbsolutePath(
      options.targetTokenFile,
      'Worker credential target token file',
    );
    const targetName = path.basename(this.targetTokenFile);
    if (targetName === '.' || targetName === '..' || targetName.startsWith('.ql3w-')) {
      throw new TypeError('Worker credential target token name is invalid');
    }
    this.targetParent = new PrivateDirectoryAuthority(
      path.dirname(this.targetTokenFile),
      'Worker credential target directory',
    );
    if (
      this.stages.device === this.targetParent.device &&
      this.stages.inode === this.targetParent.inode
    ) {
      throw new TypeError('Worker credential stage and target directories must differ');
    }
    this.targetLockFile = path.join(
      this.targetParent.directory,
      TARGET_LOCK_NAME,
    );
    this.deploymentTargetDigest = createHash('sha256')
      .update(TARGET_DIGEST_DOMAIN)
      .update(this.targetTokenFile, 'utf8')
      .update('\0', 'utf8')
      .update(String(this.targetParent.uid), 'utf8')
      .update('\0', 'utf8')
      .update(this.targetParent.device.toString(), 'utf8')
      .update('\0', 'utf8')
      .update(this.targetParent.inode.toString(), 'utf8')
      .digest('hex');
  }

  private stagePath(deliveryId: string): string {
    if (!UUID_V4.test(deliveryId)) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    return path.join(this.stages.directory, `${deliveryId}.stage`);
  }

  private verifyStageCapacity(): void {
    this.stages.verify();
    const directory = fs.opendirSync(this.stages.directory);
    let count = 0;
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        count += 1;
        if (
          count >= MAX_WORKER_CREDENTIAL_FILE_STAGES ||
          !STAGE_NAME.test(entry.name)
        ) {
          throw new WorkerCredentialDeliveryUnavailableError();
        }
      }
    } finally {
      directory.closeSync();
    }
  }

  private stableStageNames(): readonly string[] {
    this.stages.verify();
    const directory = fs.opendirSync(this.stages.directory);
    const names: string[] = [];
    let entries = 0;
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        entries += 1;
        if (entries > MAX_WORKER_CREDENTIAL_FILE_STAGES) {
          throw new WorkerCredentialDeliveryUnavailableError();
        }
        const match = STAGE_NAME.exec(entry.name);
        if (match) {
          names.push(match[1]!);
          continue;
        }
        if (STAGE_TEMP_NAME.test(entry.name)) {
          throw new WorkerCredentialDeliveryUnavailableError();
        }
        throw new WorkerCredentialDeliveryUnavailableError();
      }
    } finally {
      directory.closeSync();
    }
    return Object.freeze(names.sort());
  }

  private normalizeIntent(
    value: WorkerCredentialDeliveryIntent,
  ): Readonly<WorkerCredentialDeliveryIntent> {
    const intent = normalizeWorkerCredentialDeliveryIntent(value);
    if (intent.deploymentTargetDigest !== this.deploymentTargetDigest) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    return intent;
  }

  private readStage(deliveryId: string): StagedSecret {
    const material = readPrivateFile(
      this.stages,
      this.stagePath(deliveryId),
      MAX_STAGE_BYTES,
    );
    let token: Buffer | undefined;
    try {
      if (!material.subarray(0, STAGE_MAGIC.byteLength).equals(STAGE_MAGIC)) {
        throw new WorkerCredentialDeliveryUnavailableError();
      }
      const headerEnd = material.indexOf(0x0a, STAGE_MAGIC.byteLength);
      const headerBytes = headerEnd - STAGE_MAGIC.byteLength;
      if (
        headerEnd < STAGE_MAGIC.byteLength ||
        headerBytes < 2 ||
        headerBytes > MAX_STAGE_HEADER_BYTES ||
        headerEnd + 1 >= material.byteLength
      ) {
        throw new WorkerCredentialDeliveryUnavailableError();
      }
      const intent = this.normalizeIntent(
        JSON.parse(
          material
            .subarray(STAGE_MAGIC.byteLength, headerEnd)
            .toString('utf8'),
        ),
      );
      if (intent.deliveryId !== deliveryId) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      token = Buffer.from(material.subarray(headerEnd + 1));
      const parsed = parseToken(token);
      if (
        parsed.credentialId !== intent.credentialId ||
        parsed.tokenDigest !== intent.tokenDigest
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      const result = Object.freeze({ intent, token });
      token = undefined;
      return result;
    } finally {
      token?.fill(0);
      material.fill(0);
    }
  }

  private optionalStage(deliveryId: string): StagedSecret | null {
    try {
      return this.readStage(deliveryId);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private optionalTarget(): ParsedToken | null {
    let material: Buffer | undefined;
    try {
      material = readPrivateFile(
        this.targetParent,
        this.targetTokenFile,
        MAX_TOKEN_BYTES,
      );
      return parseToken(material);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    } finally {
      material?.fill(0);
    }
  }

  private publicationDigest(
    delivery: Readonly<WorkerCredentialDeliveryRecord>,
  ): string {
    return createHash('sha256')
      .update(PUBLICATION_DIGEST_DOMAIN)
      .update(JSON.stringify({
        deliveryId: delivery.deliveryId,
        workerId: delivery.workerId,
        credentialId: delivery.credentialId,
        credentialVersion: delivery.credentialVersion,
        previousCredentialId: delivery.previousCredentialId,
        tokenDigest: delivery.tokenDigest,
        deploymentTargetDigest: delivery.deploymentTargetDigest,
        deploymentGeneration: delivery.deploymentGeneration,
      }), 'utf8')
      .digest('hex');
  }

  private assertTargetFence(
    delivery: Readonly<WorkerCredentialDeliveryRecord>,
    target: ParsedToken | null,
  ): 'published' | 'replace' {
    if (
      target?.credentialId === delivery.credentialId &&
      target.tokenDigest === delivery.tokenDigest
    ) {
      return 'published';
    }
    if (
      target?.credentialId === delivery.credentialId ||
      (delivery.previousCredentialId === null && target !== null) ||
      (delivery.previousCredentialId !== null &&
        target?.credentialId !== delivery.previousCredentialId)
    ) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    return 'replace';
  }

  private acquireTargetLock(deliveryId: string): OwnedTargetLock {
    this.targetParent.verify();
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        this.targetLockFile,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      fs.writeFileSync(descriptor, `${JSON.stringify({ deliveryId })}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      const stat = fs.fstatSync(descriptor, { bigint: true });
      fs.closeSync(descriptor);
      descriptor = undefined;
      this.targetParent.sync();
      return Object.freeze({ device: stat.dev, inode: stat.ino });
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (isExists(error)) throw new WorkerCredentialDeliveryUnavailableError();
      preserveDomainError(error);
    }
  }

  private releaseTargetLock(lock: OwnedTargetLock): void {
    try {
      const stat = fs.lstatSync(this.targetLockFile, { bigint: true });
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        Number(stat.uid) !== this.targetParent.uid ||
        (Number(stat.mode) & 0o777) !== 0o600 ||
        stat.dev !== lock.device ||
        stat.ino !== lock.inode
      ) {
        return;
      }
      fs.unlinkSync(this.targetLockFile);
      this.targetParent.sync();
    } catch {
      // A stale lock fails future rotations closed and requires explicit repair.
    }
  }

  async inspect(
    deliveryId: string,
  ): Promise<Readonly<WorkerCredentialDeliveryIntent> | null> {
    let staged: StagedSecret | null = null;
    try {
      staged = this.optionalStage(deliveryId);
      return staged?.intent ?? null;
    } catch (error) {
      return preserveDomainError(error);
    } finally {
      staged?.token.fill(0);
    }
  }

  async listStaged(
    options: Readonly<{ afterDeliveryId?: string; limit?: number }> = {},
  ): Promise<Readonly<WorkerCredentialFileStagePage>> {
    try {
      if (
        !options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        Object.keys(options).some(
          (key) => key !== 'afterDeliveryId' && key !== 'limit',
        )
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      const limit = options.limit ?? 16;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_WORKER_CREDENTIAL_FILE_STAGE_PAGE_SIZE ||
        (options.afterDeliveryId !== undefined &&
          !UUID_V4.test(options.afterDeliveryId))
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      const names = this.stableStageNames().filter(
        (name) =>
          options.afterDeliveryId === undefined ||
          name > options.afterDeliveryId,
      );
      const selected = names.slice(0, limit + 1);
      const stages: Readonly<WorkerCredentialDeliveryIntent>[] = [];
      for (const deliveryId of selected.slice(0, limit)) {
        const staged = this.readStage(deliveryId);
        try {
          stages.push(staged.intent);
        } finally {
          staged.token.fill(0);
        }
      }
      const truncated = selected.length > limit;
      return Object.freeze({
        stages: Object.freeze(stages),
        truncated,
        ...(truncated
          ? { nextCursor: stages[stages.length - 1]!.deliveryId }
          : {}),
      });
    } catch (error) {
      return preserveDomainError(error);
    }
  }

  async stage(
    value: Readonly<WorkerCredentialDeliveryIntent>,
    token: Buffer,
  ): Promise<void> {
    let serialized: Buffer | undefined;
    let descriptor: number | undefined;
    const intent = this.normalizeIntent(value);
    const parsed = Buffer.isBuffer(token) ? parseToken(token) : null;
    if (
      !parsed ||
      parsed.credentialId !== intent.credentialId ||
      parsed.tokenDigest !== intent.tokenDigest
    ) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    const targetPath = this.stagePath(intent.deliveryId);
    const temporaryPath = path.join(
      this.stages.directory,
      `.${intent.deliveryId}.${randomUUID()}.tmp`,
    );
    try {
      const existing = this.optionalStage(intent.deliveryId);
      if (existing) {
        try {
          if (!sameIntent(existing.intent, intent)) {
            throw new WorkerCredentialDeliveryConflictError();
          }
          return;
        } finally {
          existing.token.fill(0);
        }
      }
      this.verifyStageCapacity();
      const header = Buffer.from(JSON.stringify(intent), 'utf8');
      if (header.byteLength > MAX_STAGE_HEADER_BYTES) {
        throw new WorkerCredentialDeliveryUnavailableError();
      }
      serialized = Buffer.concat([
        STAGE_MAGIC,
        header,
        Buffer.from('\n', 'ascii'),
        token,
      ]);
      header.fill(0);
      if (serialized.byteLength > MAX_STAGE_BYTES) {
        throw new WorkerCredentialDeliveryUnavailableError();
      }
      descriptor = fs.openSync(
        temporaryPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      fs.writeFileSync(descriptor, serialized);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      try {
        fs.linkSync(temporaryPath, targetPath);
        this.stages.sync();
      } catch (error) {
        if (!isExists(error)) throw error;
      }
      try {
        fs.unlinkSync(temporaryPath);
        this.stages.sync();
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const winner = this.readStage(intent.deliveryId);
      try {
        if (!sameIntent(winner.intent, intent)) {
          throw new WorkerCredentialDeliveryConflictError();
        }
      } finally {
        winner.token.fill(0);
      }
    } catch (error) {
      return preserveDomainError(error);
    } finally {
      serialized?.fill(0);
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporaryPath);
        this.stages.sync();
      } catch {
        // The no-replace stage, if published, remains authoritative.
      }
    }
  }

  async publish(
    value: Readonly<WorkerCredentialDeliveryRecord>,
  ): Promise<Readonly<{ publicationDigest: string }>> {
    const delivery = normalizeWorkerCredentialDeliveryRecord(value);
    if (
      delivery.state !== 'credential_committed' ||
      delivery.version !== 1 ||
      delivery.deploymentTargetDigest !== this.deploymentTargetDigest
    ) {
      throw new WorkerCredentialDeliveryConflictError();
    }
    let staged: StagedSecret | null = null;
    let temporaryPath: string | undefined;
    let descriptor: number | undefined;
    let targetLock: OwnedTargetLock | undefined;
    try {
      staged = this.optionalStage(delivery.deliveryId);
      if (!staged || !recordMatchesIntent(delivery, staged.intent)) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      if (this.assertTargetFence(delivery, this.optionalTarget()) === 'published') {
        return Object.freeze({
          publicationDigest: this.publicationDigest(delivery),
        });
      }
      targetLock = this.acquireTargetLock(delivery.deliveryId);
      if (this.assertTargetFence(delivery, this.optionalTarget()) === 'published') {
        return Object.freeze({
          publicationDigest: this.publicationDigest(delivery),
        });
      }
      temporaryPath = path.join(
        this.targetParent.directory,
        `.ql3w-${delivery.deliveryId}-${randomUUID()}.tmp`,
      );
      descriptor = fs.openSync(
        temporaryPath,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      fs.writeFileSync(descriptor, staged.token);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, this.targetTokenFile);
      temporaryPath = undefined;
      this.targetParent.sync();
      if (this.assertTargetFence(delivery, this.optionalTarget()) !== 'published') {
        throw new WorkerCredentialDeliveryUnavailableError();
      }
      return Object.freeze({
        publicationDigest: this.publicationDigest(delivery),
      });
    } catch (error) {
      return preserveDomainError(error);
    } finally {
      staged?.token.fill(0);
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (temporaryPath) {
        try {
          fs.unlinkSync(temporaryPath);
          this.targetParent.sync();
        } catch {
          // The target was never published from this temporary path.
        }
      }
      if (targetLock) this.releaseTargetLock(targetLock);
    }
  }

  async discard(value: Readonly<WorkerCredentialDeliveryIntent>): Promise<void> {
    const intent = this.normalizeIntent(value);
    let staged: StagedSecret | null = null;
    try {
      staged = this.optionalStage(intent.deliveryId);
      if (!staged) return;
      if (!sameIntent(staged.intent, intent)) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      const target = this.optionalTarget();
      if (
        target?.credentialId === intent.credentialId &&
        target.tokenDigest === intent.tokenDigest
      ) {
        throw new WorkerCredentialDeliveryConflictError();
      }
      fs.unlinkSync(this.stagePath(intent.deliveryId));
      this.stages.sync();
    } catch (error) {
      preserveDomainError(error);
    } finally {
      staged?.token.fill(0);
    }
  }
}
