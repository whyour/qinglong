// Remote Execution owns the private atomic offer journal and its single-owner fence.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { lock } from 'proper-lockfile';
import { assertRunDispatchId } from '@qinglong/runtime-core/run-dispatch-lease';
import { createClusterRemoteExecutionOffer } from '@qinglong/runtime-core/remote-dispatch';
import {
  DEFAULT_WORKER_REMOTE_OFFER_INBOX_ENTRIES,
  MAX_WORKER_REMOTE_OFFER_INBOX_ENTRIES,
  MAX_WORKER_REMOTE_OFFER_RECORD_BYTES,
  normalizeWorkerRemoteOfferClaimRecord,
  sameWorkerRemoteOfferAuthority,
  type WorkerRemoteOfferClaimRecord,
  type WorkerRemoteOfferDeliveryJournal,
  type WorkerRemoteOfferInboxAcceptResult,
} from './remoteOfferDelivery';
import type { ClusterRemoteExecutionOffer } from '@qinglong/runtime-core/remote-dispatch';
import {
  assertWorkerRemoteExecutionInboxTransition,
  createWorkerRemoteExecutionInboxRecord,
  normalizeWorkerRemoteExecutionInboxRecord,
  WorkerRemoteExecutionInboxError,
  type WorkerRemoteExecutionInbox,
  type WorkerRemoteExecutionInboxPage,
  type WorkerRemoteExecutionInboxRecord,
} from './executionInbox';

const OFFER_FILE = /^([A-Za-z0-9._:-]{1,128})\.json$/;
const MIN_OWNERSHIP_STALE_MS = 5_000;
const MAX_OWNERSHIP_STALE_MS = 5 * 60_000;

export interface WorkerRemoteOfferFileJournalOptions {
  readonly rootDirectory: string;
  readonly maximumEntries?: number;
  readonly ownershipStaleMs?: number;
}

export class WorkerRemoteOfferFileJournalError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'not_owned'
      | 'already_owned'
      | 'ownership_compromised'
      | 'unsafe_storage'
      | 'capacity_exhausted'
      | 'claim_revision_conflict'
      | 'offer_revision_conflict'
      | 'invalid_transition'
      | 'offer_conflict',
  ) {
    super(`Worker remote offer file journal failed: ${reason}`);
    this.name = 'WorkerRemoteOfferFileJournalError';
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function safeDirectory(path: string): Promise<void> {
  try {
    let created = false;
    try {
      await lstat(path);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
      await mkdir(path, { recursive: true, mode: 0o700 });
      created = true;
    }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new WorkerRemoteOfferFileJournalError('unsafe_storage');
    }
    if (created) await chmod(path, 0o700);
  } catch (error) {
    if (error instanceof WorkerRemoteOfferFileJournalError) throw error;
    throw new WorkerRemoteOfferFileJournalError('unsafe_storage');
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function serialize(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_WORKER_REMOTE_OFFER_RECORD_BYTES) {
    bytes.fill(0);
    throw new WorkerRemoteOfferFileJournalError('unsafe_storage');
  }
  return bytes;
}

async function readJson(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < 2 ||
      stat.size > MAX_WORKER_REMOTE_OFFER_RECORD_BYTES ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new WorkerRemoteOfferFileJournalError('unsafe_storage');
    }
    const bytes = await handle.readFile();
    try {
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined;
    if (error instanceof WorkerRemoteOfferFileJournalError) throw error;
    throw new WorkerRemoteOfferFileJournalError('unsafe_storage');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class WorkerRemoteOfferFileJournal
  implements WorkerRemoteOfferDeliveryJournal, WorkerRemoteExecutionInbox {
  private readonly rootDirectory: string;
  private readonly offersDirectory: string;
  private readonly maximumEntries: number;
  private readonly ownershipStaleMs: number;
  private releaseOwnershipLock?: () => Promise<void>;
  private compromised = false;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: WorkerRemoteOfferFileJournalOptions) {
    if (
      !options ||
      typeof options.rootDirectory !== 'string' ||
      !isAbsolute(options.rootDirectory) ||
      options.rootDirectory.length > 4096 ||
      /[\0\r\n]/.test(options.rootDirectory)
    ) {
      throw new WorkerRemoteOfferFileJournalError('invalid_configuration');
    }
    const maximumEntries =
      options.maximumEntries ?? DEFAULT_WORKER_REMOTE_OFFER_INBOX_ENTRIES;
    if (
      !Number.isSafeInteger(maximumEntries) ||
      maximumEntries < 1 ||
      maximumEntries > MAX_WORKER_REMOTE_OFFER_INBOX_ENTRIES
    ) {
      throw new WorkerRemoteOfferFileJournalError('invalid_configuration');
    }
    const ownershipStaleMs = options.ownershipStaleMs ?? 30_000;
    if (
      !Number.isSafeInteger(ownershipStaleMs) ||
      ownershipStaleMs < MIN_OWNERSHIP_STALE_MS ||
      ownershipStaleMs > MAX_OWNERSHIP_STALE_MS
    ) {
      throw new WorkerRemoteOfferFileJournalError('invalid_configuration');
    }
    this.rootDirectory = options.rootDirectory;
    this.offersDirectory = join(options.rootDirectory, 'offers');
    this.maximumEntries = maximumEntries;
    this.ownershipStaleMs = ownershipStaleMs;
  }

  async acquireOwnership(): Promise<void> {
    if (this.releaseOwnershipLock) {
      throw new WorkerRemoteOfferFileJournalError('already_owned');
    }
    await safeDirectory(this.rootDirectory);
    await safeDirectory(this.offersDirectory);
    try {
      this.compromised = false;
      this.releaseOwnershipLock = await lock(this.rootDirectory, {
        stale: this.ownershipStaleMs,
        update: Math.floor(this.ownershipStaleMs / 2),
        retries: 0,
        realpath: true,
        lockfilePath: join(this.rootDirectory, '.owner.lock'),
        onCompromised: () => {
          this.compromised = true;
          this.releaseOwnershipLock = undefined;
        },
      });
    } catch {
      throw new WorkerRemoteOfferFileJournalError('already_owned');
    }
  }

  async releaseOwnership(): Promise<void> {
    this.assertOwned();
    const release = this.releaseOwnershipLock!;
    this.releaseOwnershipLock = undefined;
    await this.mutationTail.catch(() => undefined);
    try {
      await release();
    } catch {
      throw new WorkerRemoteOfferFileJournalError('ownership_compromised');
    }
  }

  async readPendingClaim(): Promise<WorkerRemoteOfferClaimRecord | undefined> {
    this.assertOwned();
    const value = await readJson(join(this.rootDirectory, 'pending-claim.json'));
    if (value === undefined) return undefined;
    return normalizeWorkerRemoteOfferClaimRecord(
      value as WorkerRemoteOfferClaimRecord,
    );
  }

  createPendingClaim(
    record: WorkerRemoteOfferClaimRecord,
  ): Promise<WorkerRemoteOfferClaimRecord> {
    return this.mutate(async () => {
      const candidate = normalizeWorkerRemoteOfferClaimRecord(record);
      const existing = await this.readPendingClaim();
      if (existing) {
        if (!this.sameClaim(existing, candidate)) {
          throw new WorkerRemoteOfferFileJournalError('offer_conflict');
        }
        return existing;
      }
      await this.writeFirst(join(this.rootDirectory, 'pending-claim.json'), candidate);
      return candidate;
    });
  }

  replacePendingClaim(
    record: WorkerRemoteOfferClaimRecord,
    expectedRevision: number,
  ): Promise<WorkerRemoteOfferClaimRecord> {
    return this.mutate(async () => {
      const candidate = normalizeWorkerRemoteOfferClaimRecord(record);
      const existing = await this.readPendingClaim();
      if (
        !existing ||
        existing.revision !== expectedRevision ||
        candidate.revision !== expectedRevision + 1 ||
        !this.sameClaim(existing, candidate)
      ) {
        throw new WorkerRemoteOfferFileJournalError('claim_revision_conflict');
      }
      await this.writeReplacement(
        join(this.rootDirectory, 'pending-claim.json'),
        candidate,
      );
      return candidate;
    });
  }

  clearPendingClaim(offerId: string, expectedRevision: number): Promise<void> {
    return this.mutate(async () => {
      assertRunDispatchId('offerId', offerId);
      const existing = await this.readPendingClaim();
      if (
        !existing ||
        existing.offerId !== offerId ||
        existing.revision !== expectedRevision
      ) {
        throw new WorkerRemoteOfferFileJournalError('claim_revision_conflict');
      }
      try {
        await unlink(join(this.rootDirectory, 'pending-claim.json'));
        await syncDirectory(this.rootDirectory);
      } catch {
        throw new WorkerRemoteOfferFileJournalError('unsafe_storage');
      }
    });
  }

  acceptOffer(
    delivered: ClusterRemoteExecutionOffer,
    acceptedAtMs: number,
  ): Promise<WorkerRemoteOfferInboxAcceptResult> {
    return this.mutate(async () => {
      const offer = createClusterRemoteExecutionOffer(delivered);
      const existing = await this.readOffer(offer.offerId);
      if (existing) {
        if (!sameWorkerRemoteOfferAuthority(existing.offer, offer)) {
          throw new WorkerRemoteOfferFileJournalError('offer_conflict');
        }
        if (offer.lease.version > existing.offer.lease.version) {
          const updated = normalizeWorkerRemoteExecutionInboxRecord({
            ...existing,
            revision: existing.revision + 1,
            offer,
            updatedAtMs: acceptedAtMs,
          });
          this.assertOfferTransition(existing, updated);
          await this.writeReplacement(this.offerPath(offer.offerId), updated);
          return Object.freeze({ status: 'replayed' as const, record: updated });
        }
        return Object.freeze({ status: 'replayed' as const, record: existing });
      }
      const names = await this.offerNames();
      if (names.length >= this.maximumEntries) {
        throw new WorkerRemoteOfferFileJournalError('capacity_exhausted');
      }
      const record = createWorkerRemoteExecutionInboxRecord(offer, acceptedAtMs);
      await this.writeFirst(this.offerPath(offer.offerId), record);
      return Object.freeze({ status: 'accepted' as const, record });
    });
  }

  async readOffer(
    offerId: string,
  ): Promise<WorkerRemoteExecutionInboxRecord | undefined> {
    this.assertOwned();
    const value = await readJson(this.offerPath(offerId));
    if (value === undefined) return undefined;
    return normalizeWorkerRemoteExecutionInboxRecord(
      value as WorkerRemoteExecutionInboxRecord,
    );
  }

  replaceOffer(
    record: WorkerRemoteExecutionInboxRecord,
    expectedRevision: number,
  ): Promise<void> {
    return this.mutate(async () => {
      const candidate = normalizeWorkerRemoteExecutionInboxRecord(record);
      const existing = await this.readOffer(candidate.offer.offerId);
      if (
        !existing ||
        existing.revision !== expectedRevision ||
        candidate.revision !== expectedRevision + 1
      ) {
        throw new WorkerRemoteOfferFileJournalError('offer_revision_conflict');
      }
      this.assertOfferTransition(existing, candidate);
      await this.writeReplacement(this.offerPath(candidate.offer.offerId), candidate);
    });
  }

  async listOffers(options: Readonly<{
    afterOfferId?: string;
    limit?: number;
  }> = {}): Promise<WorkerRemoteExecutionInboxPage> {
    this.assertOwned();
    const limit = options.limit ?? 16;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
      throw new WorkerRemoteOfferFileJournalError('invalid_configuration');
    }
    if (options.afterOfferId !== undefined) {
      this.offerPath(options.afterOfferId);
    }
    const names = await this.offerNames();
    const selected = names
      .filter((offerId) =>
        options.afterOfferId === undefined || offerId > options.afterOfferId)
      .slice(0, limit);
    const records: WorkerRemoteExecutionInboxRecord[] = [];
    for (const offerId of selected) {
      const record = await this.readOffer(offerId);
      if (!record) {
        throw new WorkerRemoteOfferFileJournalError('unsafe_storage');
      }
      records.push(record);
    }
    const hasMore = selected.length > 0 &&
      names.some((offerId) => offerId > selected[selected.length - 1]!);
    return Object.freeze({
      records: Object.freeze(records),
      ...(hasMore
        ? { nextAfterOfferId: selected[selected.length - 1]! }
        : {}),
    });
  }

  private assertOfferTransition(
    previous: WorkerRemoteExecutionInboxRecord,
    next: WorkerRemoteExecutionInboxRecord,
  ): void {
    try {
      assertWorkerRemoteExecutionInboxTransition(previous, next);
    } catch (error) {
      if (
        error instanceof WorkerRemoteExecutionInboxError &&
        error.reason === 'revision_conflict'
      ) {
        throw new WorkerRemoteOfferFileJournalError('offer_revision_conflict');
      }
      if (
        error instanceof WorkerRemoteExecutionInboxError &&
        error.reason === 'invalid_transition'
      ) {
        throw new WorkerRemoteOfferFileJournalError('invalid_transition');
      }
      throw new WorkerRemoteOfferFileJournalError('offer_conflict');
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOwned();
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertOwned(): void {
    if (this.compromised) {
      throw new WorkerRemoteOfferFileJournalError('ownership_compromised');
    }
    if (!this.releaseOwnershipLock) {
      throw new WorkerRemoteOfferFileJournalError('not_owned');
    }
  }

  private sameClaim(
    left: WorkerRemoteOfferClaimRecord,
    right: WorkerRemoteOfferClaimRecord,
  ): boolean {
    return (
      left.workerId === right.workerId &&
      left.workerSessionId === right.workerSessionId &&
      left.workerGeneration === right.workerGeneration &&
      left.offerId === right.offerId &&
      left.leaseToken === right.leaseToken
    );
  }

  private offerPath(offerId: string): string {
    assertRunDispatchId('offerId', offerId);
    if (!/^[A-Za-z0-9._:-]+$/.test(offerId)) {
      throw new WorkerRemoteOfferFileJournalError('offer_conflict');
    }
    return join(this.offersDirectory, `${offerId}.json`);
  }

  private async offerNames(): Promise<string[]> {
    this.assertOwned();
    let entries;
    try {
      entries = await readdir(this.offersDirectory, { withFileTypes: true });
    } catch {
      throw new WorkerRemoteOfferFileJournalError('unsafe_storage');
    }
    const names: string[] = [];
    for (const entry of entries) {
      const match = OFFER_FILE.exec(entry.name);
      if (!entry.isFile() || !match) {
        throw new WorkerRemoteOfferFileJournalError('unsafe_storage');
      }
      names.push(match[1]!);
    }
    return names.sort();
  }

  private temporary(target: string): string {
    return join(
      this.rootDirectory,
      `.${target.split('/').at(-1)}.${randomBytes(16).toString('hex')}.tmp`,
    );
  }

  private async writeFirst(target: string, value: unknown): Promise<void> {
    const temporary = this.temporary(target);
    const bytes = serialize(value);
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
      await link(temporary, target);
      await syncDirectory(target.startsWith(this.offersDirectory)
        ? this.offersDirectory
        : this.rootDirectory);
    } catch (error) {
      if (isCode(error, 'EEXIST')) {
        throw new WorkerRemoteOfferFileJournalError('offer_conflict');
      }
      if (error instanceof WorkerRemoteOfferFileJournalError) throw error;
      throw new WorkerRemoteOfferFileJournalError('unsafe_storage');
    } finally {
      bytes.fill(0);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async writeReplacement(target: string, value: unknown): Promise<void> {
    const temporary = this.temporary(target);
    const bytes = serialize(value);
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      await syncDirectory(target.startsWith(this.offersDirectory)
        ? this.offersDirectory
        : this.rootDirectory);
    } catch (error) {
      if (error instanceof WorkerRemoteOfferFileJournalError) throw error;
      throw new WorkerRemoteOfferFileJournalError('unsafe_storage');
    } finally {
      bytes.fill(0);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
