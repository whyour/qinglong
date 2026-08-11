// Remote Execution owns the caller-driven offer supervision and drain lifecycle.
import type { WorkerRemoteExecutionInbox } from './executionInbox';
import type {
  WorkerRemoteExecutionInboxProcessor,
  WorkerRemoteExecutionProcessResult,
  WorkerRemoteExecutionSession,
} from './executionInboxProcessor';
import type {
  WorkerRemoteOfferPullCoordinator,
  WorkerRemoteOfferPullResult,
} from './remoteOfferDelivery';
import type {
  WorkerRemoteExecutionControlCoordinator,
  WorkerRemoteExecutionControlResult,
} from '../execution/workerExecutionControlCoordinator';

export interface WorkerRemoteExecutionLifecycleJournal
  extends WorkerRemoteExecutionInbox {
  acquireOwnership(): Promise<void>;
  releaseOwnership(): Promise<void>;
}

export interface WorkerRemoteExecutionHeadlessLifecycleOptions {
  readonly journal: WorkerRemoteExecutionLifecycleJournal;
  readonly offers: Pick<WorkerRemoteOfferPullCoordinator, 'pull'>;
  readonly processor: Pick<WorkerRemoteExecutionInboxProcessor, 'process'>;
  readonly control: Pick<WorkerRemoteExecutionControlCoordinator, 'reconcile'>;
  readonly currentSession: () => WorkerRemoteExecutionSession | undefined;
  readonly maximumRecordsPerTick?: number;
  readonly maximumSupervisionRecordsPerTick?: number;
  readonly now?: () => number;
}

export type WorkerRemoteExecutionLifecycleTickResult =
  | Readonly<{
      status: 'reconciling';
      processed: number;
      nextAfterOfferId: string;
    }>
  | Readonly<{
      status: 'reconciled';
      processed: number;
    }>
  | Readonly<{
      status: 'recovery_required';
      offerId: string;
    }>
  | Readonly<{
      status: 'session_unavailable';
    }>
  | Readonly<{
      status: 'draining';
    }>
  | Readonly<{
      status: 'processed';
      offerId: string;
      execution: WorkerRemoteExecutionProcessResult;
      pull?: WorkerRemoteOfferPullResult;
    }>
  | Readonly<{
      status: 'pull_result';
      pull: WorkerRemoteOfferPullResult;
    }>;

export class WorkerRemoteExecutionLifecycleError extends Error {
  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'inactive'
      | 'stopping'
      | 'draining',
  ) {
    super(`Worker remote execution lifecycle failed: ${reason}`);
    this.name = 'WorkerRemoteExecutionLifecycleError';
  }
}

type Mode = 'inactive' | 'running' | 'stopping';

export class WorkerRemoteExecutionHeadlessLifecycle {
  private readonly journal: WorkerRemoteExecutionLifecycleJournal;
  private readonly offers: Pick<WorkerRemoteOfferPullCoordinator, 'pull'>;
  private readonly processor: Pick<WorkerRemoteExecutionInboxProcessor, 'process'>;
  private readonly control: Pick<
    WorkerRemoteExecutionControlCoordinator,
    'reconcile'
  >;
  private readonly currentSessionProvider: () =>
    WorkerRemoteExecutionSession | undefined;
  private readonly maximumRecordsPerTick: number;
  private readonly maximumSupervisionRecordsPerTick: number;
  private readonly nowProvider: () => number;
  private mode: Mode = 'inactive';
  private draining = false;
  private startupAfterOfferId?: string;
  private startupComplete = false;
  private supervisionAfterOfferId?: string;
  private retryOfferId?: string;
  private recoveryOfferId?: string;
  private inFlight?: Promise<WorkerRemoteExecutionLifecycleTickResult>;
  private stopController?: AbortController;
  private drainOperation?: Promise<void>;
  private stopOperation?: Promise<void>;

  constructor(options: WorkerRemoteExecutionHeadlessLifecycleOptions) {
    if (
      !options ||
      typeof options.journal?.acquireOwnership !== 'function' ||
      typeof options.journal?.releaseOwnership !== 'function' ||
      typeof options.journal?.listOffers !== 'function' ||
      typeof options.offers?.pull !== 'function' ||
      typeof options.processor?.process !== 'function' ||
      typeof options.control?.reconcile !== 'function' ||
      typeof options.currentSession !== 'function'
    ) {
      throw new WorkerRemoteExecutionLifecycleError('invalid_configuration');
    }
    const maximumRecordsPerTick = options.maximumRecordsPerTick ?? 16;
    const maximumSupervisionRecordsPerTick =
      options.maximumSupervisionRecordsPerTick ?? maximumRecordsPerTick;
    if (
      !Number.isSafeInteger(maximumRecordsPerTick) ||
      maximumRecordsPerTick < 1 ||
      maximumRecordsPerTick > 64
      || !Number.isSafeInteger(maximumSupervisionRecordsPerTick)
      || maximumSupervisionRecordsPerTick < 1
      || maximumSupervisionRecordsPerTick > 64
    ) {
      throw new WorkerRemoteExecutionLifecycleError('invalid_configuration');
    }
    this.journal = options.journal;
    this.offers = options.offers;
    this.processor = options.processor;
    this.control = options.control;
    this.currentSessionProvider = options.currentSession;
    this.maximumRecordsPerTick = maximumRecordsPerTick;
    this.maximumSupervisionRecordsPerTick = maximumSupervisionRecordsPerTick;
    this.nowProvider = options.now ?? Date.now;
  }

  async start(): Promise<'started' | 'already_started'> {
    if (this.mode === 'running') return 'already_started';
    if (this.mode === 'stopping') {
      throw new WorkerRemoteExecutionLifecycleError('stopping');
    }
    await this.journal.acquireOwnership();
    this.mode = 'running';
    this.startupAfterOfferId = undefined;
    this.startupComplete = false;
    this.supervisionAfterOfferId = undefined;
    this.retryOfferId = undefined;
    this.recoveryOfferId = undefined;
    this.draining = false;
    this.drainOperation = undefined;
    this.stopController = new AbortController();
    return 'started';
  }

  beginDrain(): Promise<void> {
    if (this.mode === 'stopping') {
      return Promise.reject(
        new WorkerRemoteExecutionLifecycleError('stopping'),
      );
    }
    if (this.mode !== 'running' || !this.stopController) {
      return Promise.reject(
        new WorkerRemoteExecutionLifecycleError('inactive'),
      );
    }
    if (this.drainOperation) return this.drainOperation;
    if (this.draining) return Promise.resolve();
    this.draining = true;
    this.stopController.abort(
      new WorkerRemoteExecutionLifecycleError('draining'),
    );
    const operation = (async () => {
      await this.inFlight?.catch(() => undefined);
      if (this.mode === 'running') this.stopController = new AbortController();
    })().finally(() => {
      if (this.drainOperation === operation) this.drainOperation = undefined;
    });
    this.drainOperation = operation;
    return operation;
  }

  tick(signal?: AbortSignal): Promise<WorkerRemoteExecutionLifecycleTickResult> {
    if (this.mode === 'stopping') {
      return Promise.reject(
        new WorkerRemoteExecutionLifecycleError('stopping'),
      );
    }
    if (this.mode !== 'running' || !this.stopController) {
      return Promise.reject(
        new WorkerRemoteExecutionLifecycleError('inactive'),
      );
    }
    if (this.inFlight) return this.inFlight;
    const combinedSignal = signal === undefined
      ? this.stopController.signal
      : AbortSignal.any([signal, this.stopController.signal]);
    const operation = this.tickOnce(combinedSignal).finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
    });
    this.inFlight = operation;
    return operation;
  }

  stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;
    if (this.mode === 'inactive') return Promise.resolve();
    this.mode = 'stopping';
    this.stopController?.abort(
      new WorkerRemoteExecutionLifecycleError('stopping'),
    );
    const operation = (async () => {
      try {
        await this.drainOperation?.catch(() => undefined);
        await this.inFlight?.catch(() => undefined);
        await this.journal.releaseOwnership();
      } finally {
        this.mode = 'inactive';
        this.draining = false;
        this.stopController = undefined;
        this.drainOperation = undefined;
        this.stopOperation = undefined;
      }
    })();
    this.stopOperation = operation;
    return operation;
  }

  private async tickOnce(
    signal: AbortSignal,
  ): Promise<WorkerRemoteExecutionLifecycleTickResult> {
    if (this.recoveryOfferId) {
      return Object.freeze({
        status: 'recovery_required' as const,
        offerId: this.recoveryOfferId,
      });
    }
    if (!this.startupComplete) {
      return this.reconcileStartupPage();
    }
    if (this.retryOfferId) {
      const offerId = this.retryOfferId;
      const execution = await this.processor.process(offerId);
      return this.observeExecution(offerId, execution);
    }
    const supervision = await this.supervisePage();
    if (supervision) return supervision;
    if (this.draining) {
      return Object.freeze({ status: 'draining' as const });
    }
    const session = this.currentSessionProvider();
    const now = this.nowProvider();
    if (
      !session ||
      session.status !== 'available' ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      session.leaseExpiresAtMs <= now
    ) {
      return Object.freeze({ status: 'session_unavailable' as const });
    }
    if (signal.aborted) throw signal.reason;
    const pull = await this.offers.pull(session, signal);
    if (pull.status !== 'accepted' && pull.status !== 'replayed') {
      return Object.freeze({ status: 'pull_result' as const, pull });
    }
    this.retryOfferId = pull.offerId;
    const execution = await this.processor.process(pull.offerId);
    return this.observeExecution(pull.offerId, execution, pull);
  }

  private async supervisePage(): Promise<
    WorkerRemoteExecutionLifecycleTickResult | undefined
  > {
    const page = await this.journal.listOffers({
      ...(this.supervisionAfterOfferId === undefined
        ? {}
        : { afterOfferId: this.supervisionAfterOfferId }),
      limit: this.maximumSupervisionRecordsPerTick,
    });
    for (const record of page.records) {
      if (record.state === 'recovery_required') {
        this.recoveryOfferId = record.offer.offerId;
        return Object.freeze({
          status: 'recovery_required' as const,
          offerId: record.offer.offerId,
        });
      }
      if (
        record.state !== 'launching' &&
        record.state !== 'started' &&
        record.state !== 'running_acknowledged'
      ) continue;
      const control = await this.control.reconcile(record.offer.offerId);
      if (this.controlRequiresRecovery(control)) {
        this.recoveryOfferId = record.offer.offerId;
        return Object.freeze({
          status: 'recovery_required' as const,
          offerId: record.offer.offerId,
        });
      }
    }
    this.supervisionAfterOfferId = page.nextAfterOfferId;
    return undefined;
  }

  private controlRequiresRecovery(
    result: WorkerRemoteExecutionControlResult,
  ): boolean {
    return result.status === 'lease_expired' ||
      result.status === 'terminal' ||
      result.status === 'completion_terminal';
  }

  private async reconcileStartupPage(): Promise<
    WorkerRemoteExecutionLifecycleTickResult
  > {
    const page = await this.journal.listOffers({
      ...(this.startupAfterOfferId === undefined
        ? {}
        : { afterOfferId: this.startupAfterOfferId }),
      limit: this.maximumRecordsPerTick,
    });
    let processed = 0;
    for (const record of page.records) {
      if (record.state === 'recovery_required') {
        this.recoveryOfferId = record.offer.offerId;
        return Object.freeze({
          status: 'recovery_required' as const,
          offerId: record.offer.offerId,
        });
      }
      if (
        record.state === 'accepted' ||
        record.state === 'starting_acknowledged' ||
        record.state === 'launching' ||
        record.state === 'started' ||
        record.state === 'start_failed'
      ) {
        const execution = await this.processor.process(record.offer.offerId);
        processed += 1;
        const observed = this.observeExecution(record.offer.offerId, execution);
        if (observed.status === 'recovery_required') return observed;
      }
    }
    if (page.nextAfterOfferId !== undefined) {
      this.startupAfterOfferId = page.nextAfterOfferId;
      return Object.freeze({
        status: 'reconciling' as const,
        processed,
        nextAfterOfferId: page.nextAfterOfferId,
      });
    }
    this.startupAfterOfferId = undefined;
    this.startupComplete = true;
    return Object.freeze({
      status: 'reconciled' as const,
      processed,
    });
  }

  private observeExecution(
    offerId: string,
    execution: WorkerRemoteExecutionProcessResult,
    pull?: WorkerRemoteOfferPullResult,
  ): WorkerRemoteExecutionLifecycleTickResult {
    if (execution.status === 'recovery_required') {
      this.recoveryOfferId = offerId;
      this.retryOfferId = undefined;
      return Object.freeze({
        status: 'recovery_required' as const,
        offerId,
      });
    }
    this.retryOfferId = undefined;
    return Object.freeze({
      status: 'processed' as const,
      offerId,
      execution,
      ...(pull === undefined ? {} : { pull }),
    });
  }
}
