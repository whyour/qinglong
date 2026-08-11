import type { WorkerExecutionOfferJournalState } from '../domain/workerExecutionOffer';
import type { WorkerRecord } from '../domain/worker';
import type { WorkerExecutionOfferJournal } from '../ports/workerExecutionOfferJournal';

export const MAX_WORKER_OFFER_STARTUP_AUDIT_PAGES = 16;

export type WorkerExecutionOfferStartupCategory =
  | 'settled_start_failure'
  | 'settled_completion'
  | 'redelivery_required'
  | 'fenced_without_local_execution'
  | 'expired_without_local_execution'
  | 'launch_reconciliation_required'
  | 'execution_reconciliation_required';

export interface WorkerExecutionOfferStartupAuditEntry {
  offerId: string;
  attemptId: string;
  state: WorkerExecutionOfferJournalState;
  category: WorkerExecutionOfferStartupCategory;
}

export interface WorkerExecutionOfferStartupAuditResult {
  status: 'ready' | 'reconciliation_required' | 'scan_budget_exhausted';
  observedAtMs: number;
  pagesScanned: number;
  recordsScanned: number;
  counts: Readonly<Record<WorkerExecutionOfferStartupCategory, number>>;
  entries: readonly WorkerExecutionOfferStartupAuditEntry[];
  nextAfterOfferId?: string;
}

export interface WorkerExecutionOfferStartupAuditorOptions {
  pageSize?: number;
  maxPages?: number;
  clock?: { now(): number };
}

export class InvalidWorkerExecutionOfferStartupPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorkerExecutionOfferStartupPageError';
  }
}

const CATEGORIES: readonly WorkerExecutionOfferStartupCategory[] = [
  'settled_start_failure',
  'settled_completion',
  'redelivery_required',
  'fenced_without_local_execution',
  'expired_without_local_execution',
  'launch_reconciliation_required',
  'execution_reconciliation_required',
];

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
 * Read-only startup gate. It never resumes an ACK or starts/stops an Executor;
 * the future recovery coordinator must act on these low-sensitive categories.
 */
export class WorkerExecutionOfferStartupAuditor {
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly clock: { now(): number };

  constructor(
    private readonly journal: Pick<WorkerExecutionOfferJournal, 'list'>,
    options: WorkerExecutionOfferStartupAuditorOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 16;
    this.maxPages = options.maxPages ?? 4;
    this.clock = options.clock ?? Date;
    assertIntegerBetween('pageSize', this.pageSize, 1, 64);
    assertIntegerBetween(
      'maxPages',
      this.maxPages,
      1,
      MAX_WORKER_OFFER_STARTUP_AUDIT_PAGES,
    );
    if (this.pageSize * this.maxPages > 1024) {
      throw new RangeError(
        'Worker offer startup audit budget must not exceed 1024 records',
      );
    }
  }

  async audit(
    currentSession: WorkerRecord,
  ): Promise<WorkerExecutionOfferStartupAuditResult> {
    const observedAtMs = this.now();
    const counts = Object.fromEntries(
      CATEGORIES.map((category) => [category, 0]),
    ) as Record<WorkerExecutionOfferStartupCategory, number>;
    const entries: WorkerExecutionOfferStartupAuditEntry[] = [];
    const seen = new Set<string>();
    let afterOfferId: string | undefined;
    let pagesScanned = 0;

    while (pagesScanned < this.maxPages) {
      const page = await this.journal.list({
        ...(afterOfferId === undefined ? {} : { afterOfferId }),
        limit: this.pageSize,
      });
      pagesScanned += 1;
      if (page.records.length > this.pageSize) {
        throw new InvalidWorkerExecutionOfferStartupPageError(
          'Worker offer startup page exceeds the requested limit',
        );
      }
      let previousOfferId = afterOfferId;
      for (const record of page.records) {
        const offerId = record.offer.offerId;
        if (
          seen.has(offerId) ||
          (previousOfferId !== undefined && offerId <= previousOfferId)
        ) {
          throw new InvalidWorkerExecutionOfferStartupPageError(
            'Worker offer startup cursor did not advance',
          );
        }
        seen.add(offerId);
        previousOfferId = offerId;
        const category = this.classify(record, currentSession, observedAtMs);
        counts[category] += 1;
        entries.push({
          offerId,
          attemptId: record.offer.candidate.attemptId,
          state: record.state,
          category,
        });
      }

      if (page.nextAfterOfferId === undefined) {
        return this.result(counts, entries, observedAtMs, pagesScanned);
      }
      if (
        page.records.length !== this.pageSize ||
        page.records.length === 0 ||
        page.nextAfterOfferId !==
          page.records[page.records.length - 1].offer.offerId ||
        (afterOfferId !== undefined && page.nextAfterOfferId <= afterOfferId)
      ) {
        throw new InvalidWorkerExecutionOfferStartupPageError(
          'Worker offer startup page returned an invalid resume cursor',
        );
      }
      afterOfferId = page.nextAfterOfferId;
    }

    return {
      status: 'scan_budget_exhausted',
      observedAtMs,
      pagesScanned,
      recordsScanned: entries.length,
      counts,
      entries,
      ...(afterOfferId === undefined ? {} : { nextAfterOfferId: afterOfferId }),
    };
  }

  private classify(
    record: Awaited<
      ReturnType<WorkerExecutionOfferJournal['list']>
    >['records'][number],
    currentSession: WorkerRecord,
    observedAtMs: number,
  ): WorkerExecutionOfferStartupCategory {
    if (record.state === 'start_failure_acknowledged') {
      return 'settled_start_failure';
    }
    if (record.state === 'completion_acknowledged') {
      return 'settled_completion';
    }
    if (record.state === 'launching' || record.state === 'recovery_required') {
      return 'launch_reconciliation_required';
    }
    if (record.state === 'started' || record.state === 'running_acknowledged') {
      return 'execution_reconciliation_required';
    }
    const sameSession =
      record.offer.worker.id === currentSession.id &&
      record.offer.worker.sessionId === currentSession.sessionId &&
      record.offer.worker.generation === currentSession.generation;
    if (!sameSession) return 'fenced_without_local_execution';
    if (
      record.offer.lease.expiresAtMs <= observedAtMs ||
      currentSession.leaseExpiresAtMs <= observedAtMs ||
      currentSession.status === 'offline'
    ) {
      return 'expired_without_local_execution';
    }
    return 'redelivery_required';
  }

  private result(
    counts: Record<WorkerExecutionOfferStartupCategory, number>,
    entries: WorkerExecutionOfferStartupAuditEntry[],
    observedAtMs: number,
    pagesScanned: number,
  ): WorkerExecutionOfferStartupAuditResult {
    const requiresReconciliation =
      counts.launch_reconciliation_required > 0 ||
      counts.execution_reconciliation_required > 0;
    return {
      status: requiresReconciliation ? 'reconciliation_required' : 'ready',
      observedAtMs,
      pagesScanned,
      recordsScanned: entries.length,
      counts,
      entries,
    };
  }

  private now(): number {
    const observedAtMs = this.clock.now();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new TypeError(
        'Worker offer startup audit clock returned an invalid time',
      );
    }
    return observedAtMs;
  }
}
