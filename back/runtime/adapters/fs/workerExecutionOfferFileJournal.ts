import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { lock } from 'proper-lockfile';
import {
  MAX_WORKER_EXECUTION_OFFER_JOURNAL_ENTRIES,
  MAX_WORKER_EXECUTION_OFFER_JOURNAL_PAGE_SIZE,
  MAX_WORKER_EXECUTION_OFFER_RECORD_BYTES,
  cloneWorkerExecutionOfferJournalRecord,
  parseWorkerExecutionOfferJournalRecord,
  serializeWorkerExecutionOfferJournalRecord,
  type WorkerExecutionOfferJournalRecord,
} from '../../domain/workerExecutionOffer';
import { assertRunDispatchOfferId } from '../../domain/runDispatchOffer';
import type {
  WorkerExecutionOfferJournal,
  WorkerExecutionOfferJournalCreateResult,
  WorkerExecutionOfferJournalPage,
} from '../../ports/workerExecutionOfferJournal';
import type {
  WorkerExecutionOfferJournalOwnership,
  WorkerExecutionOfferJournalOwnershipState,
} from '../../ports/workerExecutionOfferJournalOwnership';

const JOURNAL_FILE_PATTERN = /^([0-9a-f]{64})\.json$/;

export const MIN_WORKER_OFFER_JOURNAL_LOCK_STALE_MS = 5_000;
export const MAX_WORKER_OFFER_JOURNAL_LOCK_STALE_MS = 5 * 60_000;

export interface WorkerExecutionOfferLockProvider {
  acquire(options: {
    root: string;
    lockfilePath: string;
    staleMs: number;
    updateMs: number;
    onCompromised(error: Error): void;
  }): Promise<() => Promise<void>>;
}

const properLockProvider: WorkerExecutionOfferLockProvider = {
  acquire(options) {
    return lock(options.root, {
      stale: options.staleMs,
      update: options.updateMs,
      retries: 0,
      realpath: true,
      lockfilePath: options.lockfilePath,
      onCompromised: options.onCompromised,
    });
  },
};

export class WorkerExecutionOfferJournalCapacityError extends Error {
  constructor(readonly maximumEntries: number) {
    super(`Worker execution offer journal reached ${maximumEntries} entries`);
    this.name = 'WorkerExecutionOfferJournalCapacityError';
  }
}

export class WorkerExecutionOfferJournalRevisionError extends Error {
  constructor(readonly offerId: string) {
    super(`Worker execution offer journal revision changed for ${offerId}`);
    this.name = 'WorkerExecutionOfferJournalRevisionError';
  }
}

export class WorkerExecutionOfferJournalNotFoundError extends Error {
  constructor(readonly offerId: string) {
    super(`Worker execution offer journal entry ${offerId} was not found`);
    this.name = 'WorkerExecutionOfferJournalNotFoundError';
  }
}

export class WorkerExecutionOfferJournalOwnershipError extends Error {
  constructor(
    readonly reason: 'already_owned' | 'not_owned' | 'compromised',
    readonly cause?: unknown,
  ) {
    super(`Worker execution offer journal ownership failed: ${reason}`);
    this.name = 'WorkerExecutionOfferJournalOwnershipError';
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === code
  );
}

function assertIntegerBetween(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

/**
 * Worker-local restart journal. One bounded file per offer avoids a database or
 * sidecar on edge devices. The Worker runtime must exclusively own this root.
 */
export class WorkerExecutionOfferFileJournal
  implements WorkerExecutionOfferJournal, WorkerExecutionOfferJournalOwnership
{
  private readonly maximumEntries: number;
  private readonly ownershipStaleMs: number;
  private readonly lockProvider: WorkerExecutionOfferLockProvider;
  private readonly onOwnershipCompromised?: (error: Error) => void;
  private ownerState: WorkerExecutionOfferJournalOwnershipState = 'unowned';
  private releaseOwner?: () => Promise<void>;
  private ownershipError?: Error;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    options: {
      maximumEntries?: number;
      ownershipStaleMs?: number;
      lockProvider?: WorkerExecutionOfferLockProvider;
      onOwnershipCompromised?: (error: Error) => void;
    } = {},
  ) {
    if (!path.isAbsolute(root)) {
      throw new RangeError(
        'Worker execution offer journal root must be absolute',
      );
    }
    this.maximumEntries = options.maximumEntries ?? 64;
    assertIntegerBetween(
      'maximumEntries',
      this.maximumEntries,
      1,
      MAX_WORKER_EXECUTION_OFFER_JOURNAL_ENTRIES,
    );
    this.ownershipStaleMs = options.ownershipStaleMs ?? 30_000;
    assertIntegerBetween(
      'ownershipStaleMs',
      this.ownershipStaleMs,
      MIN_WORKER_OFFER_JOURNAL_LOCK_STALE_MS,
      MAX_WORKER_OFFER_JOURNAL_LOCK_STALE_MS,
    );
    this.lockProvider = options.lockProvider ?? properLockProvider;
    this.onOwnershipCompromised = options.onOwnershipCompromised;
  }

  ownershipState(): WorkerExecutionOfferJournalOwnershipState {
    return this.ownerState;
  }

  async acquireOwnership(): Promise<'acquired' | 'already_owned'> {
    if (this.ownerState === 'owned') return 'already_owned';
    if (this.ownerState === 'releasing') {
      throw new WorkerExecutionOfferJournalOwnershipError('not_owned');
    }
    if (this.ownerState === 'compromised') {
      throw new WorkerExecutionOfferJournalOwnershipError(
        'compromised',
        this.ownershipError,
      );
    }
    await this.ensureRoot();
    try {
      const release = await this.lockProvider.acquire({
        root: this.root,
        lockfilePath: path.join(this.root, '.owner.lock'),
        staleMs: this.ownershipStaleMs,
        updateMs: Math.max(1_000, Math.floor(this.ownershipStaleMs / 2)),
        onCompromised: (error) => this.compromiseOwnership(error),
      });
      this.releaseOwner = release;
      this.ownerState = 'owned';
      return 'acquired';
    } catch (error) {
      if (isCode(error, 'ELOCKED')) {
        throw new WorkerExecutionOfferJournalOwnershipError(
          'already_owned',
          error,
        );
      }
      throw error;
    }
  }

  async releaseOwnership(): Promise<'released' | 'not_owned' | 'compromised'> {
    if (this.ownerState === 'unowned') return 'not_owned';
    if (this.ownerState === 'compromised') return 'compromised';
    if (this.ownerState === 'releasing') return 'not_owned';
    while (true) {
      const pending = this.mutationTail;
      await pending;
      if (pending === this.mutationTail) break;
    }
    const ownerStateAfterMutations = this.ownershipState();
    if (ownerStateAfterMutations === 'compromised') return 'compromised';
    if (ownerStateAfterMutations !== 'owned') return 'not_owned';
    const release = this.releaseOwner;
    if (!release) {
      this.compromiseOwnership(
        new Error('Worker offer journal owner release capability is missing'),
      );
      return 'compromised';
    }
    this.ownerState = 'releasing';
    try {
      await release();
      this.releaseOwner = undefined;
      this.ownerState = 'unowned';
      return 'released';
    } catch (error) {
      const compromised =
        error instanceof Error
          ? error
          : new Error('Worker offer journal owner release failed');
      this.compromiseOwnership(compromised);
      throw new WorkerExecutionOfferJournalOwnershipError('compromised', error);
    }
  }

  async create(
    record: WorkerExecutionOfferJournalRecord,
  ): Promise<WorkerExecutionOfferJournalCreateResult> {
    this.assertOwned();
    const candidate = cloneWorkerExecutionOfferJournalRecord(record);
    if (candidate.revision !== 0 || candidate.state !== 'accepted') {
      throw new TypeError(
        'A new Worker offer journal entry must be accepted at revision zero',
      );
    }
    return this.serializeMutation(async () => {
      const target = this.target(candidate.offer.offerId);
      if (await this.exists(target)) return 'exists';
      const names = await this.entryNames();
      if (names.length >= this.maximumEntries) {
        throw new WorkerExecutionOfferJournalCapacityError(this.maximumEntries);
      }
      const temporary = this.temporary(candidate.offer.offerId);
      try {
        await this.writeTemporary(temporary, candidate);
        this.assertOwned();
        await fs.link(temporary, target);
        await this.bestEffortSyncDirectory();
        return 'created';
      } catch (error) {
        if (isCode(error, 'EEXIST')) return 'exists';
        throw error;
      } finally {
        await this.bestEffortUnlink(temporary);
      }
    });
  }

  async read(
    offerId: string,
  ): Promise<WorkerExecutionOfferJournalRecord | undefined> {
    this.assertOwned();
    assertRunDispatchOfferId(offerId);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(
        this.target(offerId),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (isCode(error, 'ENOENT')) return undefined;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new TypeError(
          'Worker execution offer journal entry must be a regular file',
        );
      }
      const bytes = Buffer.allocUnsafe(
        MAX_WORKER_EXECUTION_OFFER_RECORD_BYTES + 1,
      );
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_WORKER_EXECUTION_OFFER_RECORD_BYTES) {
        throw new TypeError(
          'Worker execution offer journal entry exceeds the byte limit',
        );
      }
      const record = parseWorkerExecutionOfferJournalRecord(
        bytes.subarray(0, bytesRead),
      );
      if (record.offer.offerId !== offerId) {
        throw new TypeError(
          'Worker offer journal path and payload do not match',
        );
      }
      return record;
    } finally {
      await handle.close();
    }
  }

  async replace(
    record: WorkerExecutionOfferJournalRecord,
    expectedRevision: number,
  ): Promise<void> {
    this.assertOwned();
    const candidate = cloneWorkerExecutionOfferJournalRecord(record);
    assertIntegerBetween(
      'expectedRevision',
      expectedRevision,
      0,
      Number.MAX_SAFE_INTEGER - 1,
    );
    if (candidate.revision !== expectedRevision + 1) {
      throw new TypeError('Replacement journal revision must increment by one');
    }
    await this.serializeMutation(async () => {
      const current = await this.read(candidate.offer.offerId);
      if (!current) {
        throw new WorkerExecutionOfferJournalNotFoundError(
          candidate.offer.offerId,
        );
      }
      if (current.revision !== expectedRevision) {
        throw new WorkerExecutionOfferJournalRevisionError(
          candidate.offer.offerId,
        );
      }
      const temporary = this.temporary(candidate.offer.offerId);
      try {
        await this.writeTemporary(temporary, candidate);
        this.assertOwned();
        await fs.rename(temporary, this.target(candidate.offer.offerId));
        await this.bestEffortSyncDirectory();
      } finally {
        await this.bestEffortUnlink(temporary);
      }
    });
  }

  async remove(offerId: string, expectedRevision?: number): Promise<boolean> {
    this.assertOwned();
    assertRunDispatchOfferId(offerId);
    if (expectedRevision !== undefined) {
      assertIntegerBetween(
        'expectedRevision',
        expectedRevision,
        0,
        Number.MAX_SAFE_INTEGER,
      );
    }
    return this.serializeMutation(async () => {
      if (expectedRevision !== undefined) {
        const current = await this.read(offerId);
        if (!current) return false;
        if (current.revision !== expectedRevision) {
          throw new WorkerExecutionOfferJournalRevisionError(offerId);
        }
      }
      try {
        this.assertOwned();
        await fs.unlink(this.target(offerId));
        await this.bestEffortSyncDirectory();
        return true;
      } catch (error) {
        if (isCode(error, 'ENOENT')) return false;
        throw error;
      }
    });
  }

  async list(
    options: { afterOfferId?: string; limit?: number } = {},
  ): Promise<WorkerExecutionOfferJournalPage> {
    this.assertOwned();
    if (options.afterOfferId !== undefined) {
      assertRunDispatchOfferId(options.afterOfferId);
    }
    const limit = options.limit ?? 32;
    assertIntegerBetween(
      'limit',
      limit,
      1,
      MAX_WORKER_EXECUTION_OFFER_JOURNAL_PAGE_SIZE,
    );
    const names = await this.entryNames();
    const offerIds = names
      .map((name) => JOURNAL_FILE_PATTERN.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .filter(
        (offerId) =>
          options.afterOfferId === undefined || offerId > options.afterOfferId,
      )
      .sort();
    const selected = offerIds.slice(0, limit + 1);
    const hasMore = selected.length > limit;
    const pageIds = selected.slice(0, limit);
    const records: WorkerExecutionOfferJournalRecord[] = [];
    for (const offerId of pageIds) {
      const record = await this.read(offerId);
      if (!record) {
        throw new WorkerExecutionOfferJournalRevisionError(offerId);
      }
      records.push(record);
    }
    return {
      records,
      ...(hasMore && pageIds.length
        ? { nextAfterOfferId: pageIds[pageIds.length - 1] }
        : {}),
    };
  }

  private target(offerId: string): string {
    assertRunDispatchOfferId(offerId);
    return path.join(this.root, `${offerId}.json`);
  }

  private temporary(offerId: string): string {
    return path.join(
      this.root,
      `.${offerId}.${randomBytes(16).toString('hex')}.tmp`,
    );
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new TypeError(
        'Worker execution offer journal root must be a real directory',
      );
    }
    await fs.chmod(this.root, 0o700);
  }

  private assertOwned(): void {
    if (this.ownerState === 'owned') return;
    throw new WorkerExecutionOfferJournalOwnershipError(
      this.ownerState === 'compromised' ? 'compromised' : 'not_owned',
      this.ownershipError,
    );
  }

  private compromiseOwnership(error: Error): void {
    this.ownershipError = error;
    this.releaseOwner = undefined;
    this.ownerState = 'compromised';
    try {
      this.onOwnershipCompromised?.(error);
    } catch {
      // Ownership loss must remain visible even if diagnostics fail.
    }
  }

  private async entryNames(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (error) {
      if (isCode(error, 'ENOENT')) return [];
      throw error;
    }
    const entries = names.filter((name) => JOURNAL_FILE_PATTERN.test(name));
    if (entries.length > this.maximumEntries) {
      throw new WorkerExecutionOfferJournalCapacityError(this.maximumEntries);
    }
    return entries;
  }

  private async writeTemporary(
    temporary: string,
    record: WorkerExecutionOfferJournalRecord,
  ): Promise<void> {
    const serialized = serializeWorkerExecutionOfferJournalRecord(record);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async exists(target: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile()) {
        throw new TypeError(
          'Worker execution offer journal target must be a regular file',
        );
      }
      return true;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  private async bestEffortUnlink(target: string): Promise<void> {
    try {
      await fs.unlink(target);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) {
        // Temp cleanup is diagnostic-only; the atomically published record wins.
      }
    }
  }

  private async bestEffortSyncDirectory(): Promise<void> {
    try {
      const handle = await fs.open(this.root, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Some supported filesystems cannot fsync directories.
    }
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
