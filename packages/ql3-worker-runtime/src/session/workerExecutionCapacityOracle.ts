// Session ownership: derive advertised capacity from the durable execution journal.
import { assertWorkerConcurrency } from '@qinglong/runtime-core/worker-session';
import type {
  WorkerRemoteExecutionInboxPage,
  WorkerRemoteExecutionInboxRecord,
} from '../remote-execution/executionInbox';
import {
  MAX_WORKER_REMOTE_OFFER_INBOX_ENTRIES,
  type WorkerRemoteOfferClaimRecord,
} from '../remote-execution/remoteOfferDelivery';

const SETTLED_STATES = new Set<WorkerRemoteExecutionInboxRecord['state']>([
  'start_failure_acknowledged',
  'completion_acknowledged',
]);

export interface WorkerExecutionCapacityJournal {
  listOffers(options: Readonly<{
    afterOfferId?: string;
    limit?: number;
  }>): Promise<WorkerRemoteExecutionInboxPage>;
  readPendingClaim(): Promise<WorkerRemoteOfferClaimRecord | undefined>;
}

export interface WorkerExecutionCapacityOracleOptions {
  readonly journal: WorkerExecutionCapacityJournal;
  readonly maxConcurrentRuns: number;
}

export type WorkerExecutionCapacityMode =
  | 'reconciling'
  | 'registering'
  | 'active'
  | 'draining'
  | 'recovery_required'
  | 'offline';

export class WorkerExecutionCapacityOracleError extends Error {
  constructor(readonly reason: 'invalid_configuration' | 'invalid_transition') {
    super(`Worker execution capacity oracle failed: ${reason}`);
    this.name = 'WorkerExecutionCapacityOracleError';
  }
}

/**
 * Derives advertised capacity exclusively from the owned execution journal.
 * It has no timer and never treats a deployment-supplied slot count as truth.
 */
export class WorkerExecutionCapacityOracle {
  private readonly journal: WorkerExecutionCapacityJournal;
  private readonly maxConcurrentRuns: number;
  private modeValue: WorkerExecutionCapacityMode = 'reconciling';
  private operation?: Promise<number>;

  constructor(options: WorkerExecutionCapacityOracleOptions) {
    if (
      !options ||
      typeof options.journal?.listOffers !== 'function' ||
      typeof options.journal?.readPendingClaim !== 'function'
    ) throw new WorkerExecutionCapacityOracleError('invalid_configuration');
    try {
      assertWorkerConcurrency(options.maxConcurrentRuns, 0);
    } catch {
      throw new WorkerExecutionCapacityOracleError('invalid_configuration');
    }
    this.journal = options.journal;
    this.maxConcurrentRuns = options.maxConcurrentRuns;
  }

  mode(): WorkerExecutionCapacityMode {
    return this.modeValue;
  }

  prepareRegistration(): void {
    this.transition('reconciling', 'registering');
  }

  activate(): void {
    this.transition('registering', 'active');
  }

  beginDrain(): void {
    if (
      this.modeValue === 'draining' ||
      this.modeValue === 'offline'
    ) return;
    this.transition('active', 'draining');
  }

  failClosed(): void {
    this.modeValue = 'recovery_required';
  }

  offline(): void {
    if (this.modeValue === 'offline') return;
    this.transition('draining', 'offline');
  }

  availableSlots(): Promise<number> {
    if (
      this.modeValue !== 'registering' &&
      this.modeValue !== 'active'
    ) return Promise.resolve(0);
    if (this.operation) return this.operation;
    const operation = this.readAvailableSlots().finally(() => {
      if (this.operation === operation) this.operation = undefined;
    });
    this.operation = operation;
    return operation;
  }

  private async readAvailableSlots(): Promise<number> {
    let afterOfferId: string | undefined;
    let observed = 0;
    const active = new Set<string>();
    do {
      const page = await this.journal.listOffers({
        ...(afterOfferId === undefined ? {} : { afterOfferId }),
        limit: 64,
      });
      observed += page.records.length;
      if (observed > MAX_WORKER_REMOTE_OFFER_INBOX_ENTRIES) {
        this.failClosed();
        return 0;
      }
      for (const record of page.records) {
        if (record.state === 'recovery_required') {
          this.failClosed();
          return 0;
        }
        if (!SETTLED_STATES.has(record.state)) {
          active.add(record.offer.offerId);
        }
      }
      afterOfferId = page.nextAfterOfferId;
    } while (afterOfferId !== undefined);
    const pending = await this.journal.readPendingClaim();
    if (pending !== undefined) active.add(pending.offerId);
    return Math.max(0, this.maxConcurrentRuns - active.size);
  }

  private transition(
    expected: WorkerExecutionCapacityMode,
    next: WorkerExecutionCapacityMode,
  ): void {
    if (this.modeValue !== expected) {
      throw new WorkerExecutionCapacityOracleError('invalid_transition');
    }
    this.modeValue = next;
  }
}
