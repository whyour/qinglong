import type { WorkerExecutionOfferJournalState } from '../domain/workerExecutionOffer';
import type { CompletionReceiptStore } from '../ports/completionReceiptStore';
import type {
  WorkerExecutionOfferJournal,
  WorkerExecutionOfferJournalPage,
} from '../ports/workerExecutionOfferJournal';

export const MIN_WORKER_OFFER_TERMINAL_RETENTION_MS = 60_000;
export const MAX_WORKER_OFFER_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const MAX_WORKER_OFFER_RETENTION_REMOVALS = 64;

export type WorkerExecutionOfferRetentionEntryOutcome =
  | 'removed'
  | 'already_absent'
  | 'receipt_cleanup_failed'
  | 'journal_remove_failed';

export interface WorkerExecutionOfferRetentionEntry {
  offerId: string;
  attemptId: string;
  state: Extract<
    WorkerExecutionOfferJournalState,
    'completion_acknowledged' | 'start_failure_acknowledged'
  >;
  outcome: WorkerExecutionOfferRetentionEntryOutcome;
}

export interface WorkerExecutionOfferRetentionResult {
  status: 'complete' | 'page_complete' | 'removal_budget_exhausted';
  observedAtMs: number;
  recordsScanned: number;
  eligibleRecords: number;
  removalsAttempted: number;
  recordsRemoved: number;
  retainedRecords: number;
  failedRecords: number;
  entries: readonly WorkerExecutionOfferRetentionEntry[];
  nextAfterOfferId?: string;
}

export interface WorkerExecutionOfferJournalRetentionOptions {
  completionRetentionMs: number;
  startFailureRetentionMs: number;
  pageSize?: number;
  maximumRemovals?: number;
  clock?: { now(): number };
}

export class InvalidWorkerExecutionOfferRetentionPageError extends Error {
  constructor(message: string) {
    super(`Worker offer retention page is invalid: ${message}`);
    this.name = 'InvalidWorkerExecutionOfferRetentionPageError';
  }
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

/** One bounded retention page; callers own cadence and cursor persistence. */
export class WorkerExecutionOfferJournalRetentionService {
  private readonly completionRetentionMs: number;
  private readonly startFailureRetentionMs: number;
  private readonly pageSize: number;
  private readonly maximumRemovals: number;
  private readonly clock: { now(): number };

  constructor(
    private readonly journal: Pick<
      WorkerExecutionOfferJournal,
      'list' | 'remove'
    >,
    private readonly receipts: Pick<CompletionReceiptStore, 'remove'>,
    options: WorkerExecutionOfferJournalRetentionOptions,
  ) {
    this.completionRetentionMs = options.completionRetentionMs;
    this.startFailureRetentionMs = options.startFailureRetentionMs;
    this.pageSize = options.pageSize ?? 16;
    this.maximumRemovals = options.maximumRemovals ?? 8;
    this.clock = options.clock ?? Date;
    assertIntegerBetween(
      'completionRetentionMs',
      this.completionRetentionMs,
      MIN_WORKER_OFFER_TERMINAL_RETENTION_MS,
      MAX_WORKER_OFFER_TERMINAL_RETENTION_MS,
    );
    assertIntegerBetween(
      'startFailureRetentionMs',
      this.startFailureRetentionMs,
      MIN_WORKER_OFFER_TERMINAL_RETENTION_MS,
      MAX_WORKER_OFFER_TERMINAL_RETENTION_MS,
    );
    assertIntegerBetween('pageSize', this.pageSize, 1, 64);
    assertIntegerBetween(
      'maximumRemovals',
      this.maximumRemovals,
      1,
      Math.min(this.pageSize, MAX_WORKER_OFFER_RETENTION_REMOVALS),
    );
  }

  async sweep(
    options: {
      afterOfferId?: string;
    } = {},
  ): Promise<WorkerExecutionOfferRetentionResult> {
    const observedAtMs = this.now();
    const page = await this.journal.list({
      ...(options.afterOfferId === undefined
        ? {}
        : { afterOfferId: options.afterOfferId }),
      limit: this.pageSize,
    });
    this.assertPage(page, options.afterOfferId);

    const entries: WorkerExecutionOfferRetentionEntry[] = [];
    let recordsScanned = 0;
    let eligibleRecords = 0;
    let removalsAttempted = 0;
    let recordsRemoved = 0;
    let retainedRecords = 0;
    let failedRecords = 0;
    let lastProcessedOfferId = options.afterOfferId;

    for (const record of page.records) {
      if (
        record.state !== 'completion_acknowledged' &&
        record.state !== 'start_failure_acknowledged'
      ) {
        recordsScanned += 1;
        retainedRecords += 1;
        lastProcessedOfferId = record.offer.offerId;
        continue;
      }
      const settledAtMs =
        record.state === 'completion_acknowledged'
          ? record.completionAcknowledgedAtMs!
          : record.updatedAtMs;
      const retentionMs =
        record.state === 'completion_acknowledged'
          ? this.completionRetentionMs
          : this.startFailureRetentionMs;
      const due =
        settledAtMs <= observedAtMs &&
        observedAtMs - settledAtMs >= retentionMs;
      if (!due) {
        recordsScanned += 1;
        retainedRecords += 1;
        lastProcessedOfferId = record.offer.offerId;
        continue;
      }
      eligibleRecords += 1;
      if (removalsAttempted >= this.maximumRemovals) {
        return {
          status: 'removal_budget_exhausted',
          observedAtMs,
          recordsScanned,
          eligibleRecords,
          removalsAttempted,
          recordsRemoved,
          retainedRecords,
          failedRecords,
          entries,
          ...(lastProcessedOfferId === undefined
            ? {}
            : { nextAfterOfferId: lastProcessedOfferId }),
        };
      }
      recordsScanned += 1;
      removalsAttempted += 1;
      const offerId = record.offer.offerId;
      const attemptId = record.offer.candidate.attemptId;
      if (record.state === 'completion_acknowledged') {
        try {
          await this.receipts.remove(attemptId);
        } catch {
          failedRecords += 1;
          entries.push({
            offerId,
            attemptId,
            state: record.state,
            outcome: 'receipt_cleanup_failed',
          });
          lastProcessedOfferId = offerId;
          continue;
        }
      }
      try {
        const removed = await this.journal.remove(offerId, record.revision);
        if (removed) recordsRemoved += 1;
        entries.push({
          offerId,
          attemptId,
          state: record.state,
          outcome: removed ? 'removed' : 'already_absent',
        });
      } catch {
        failedRecords += 1;
        entries.push({
          offerId,
          attemptId,
          state: record.state,
          outcome: 'journal_remove_failed',
        });
      }
      lastProcessedOfferId = offerId;
    }

    return {
      status:
        page.nextAfterOfferId === undefined ? 'complete' : 'page_complete',
      observedAtMs,
      recordsScanned,
      eligibleRecords,
      removalsAttempted,
      recordsRemoved,
      retainedRecords,
      failedRecords,
      entries,
      ...(page.nextAfterOfferId === undefined
        ? {}
        : { nextAfterOfferId: page.nextAfterOfferId }),
    };
  }

  private assertPage(
    page: WorkerExecutionOfferJournalPage,
    afterOfferId: string | undefined,
  ): void {
    if (page.records.length > this.pageSize) {
      throw new InvalidWorkerExecutionOfferRetentionPageError(
        'record count exceeds pageSize',
      );
    }
    let previous = afterOfferId;
    for (const record of page.records) {
      if (previous !== undefined && record.offer.offerId <= previous) {
        throw new InvalidWorkerExecutionOfferRetentionPageError(
          'offer cursor did not advance',
        );
      }
      previous = record.offer.offerId;
    }
    if (
      page.nextAfterOfferId !== undefined &&
      (page.records.length !== this.pageSize ||
        page.records.length === 0 ||
        page.nextAfterOfferId !==
          page.records[page.records.length - 1].offer.offerId)
    ) {
      throw new InvalidWorkerExecutionOfferRetentionPageError(
        'resume cursor is inconsistent',
      );
    }
  }

  private now(): number {
    const nowMs = this.clock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError(
        'Worker offer retention clock returned an invalid time',
      );
    }
    return nowMs;
  }
}
