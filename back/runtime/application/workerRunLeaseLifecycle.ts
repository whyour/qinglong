import {
  RunDispatchLeaseFenceRejectedError,
  assertRunDispatchLeaseRecord,
  type RunDispatchLeaseRecord,
  type RunDispatchReleaseReason,
} from '../domain/runDispatchLease';
import type { WorkerRecord } from '../domain/worker';
import type { WorkerRunLeaseClient } from '../ports/workerRunLeaseClient';

export const MIN_WORKER_RUN_LEASE_RETRY_MS = 100;
export const MAX_WORKER_RUN_LEASE_RETRY_MS = 5_000;
export const MAX_WORKER_RUN_LEASE_STOP_TIMEOUT_MS = 60_000;

interface ScheduledTimer {
  unref?: () => void;
}

export interface WorkerRunLeaseScheduler {
  setTimeout(callback: () => void, delayMs: number): ScheduledTimer;
  clearTimeout(timer: ScheduledTimer): void;
}

export type WorkerRunLeaseLossReason =
  | 'lease_expired'
  | 'fenced'
  | 'worker_session_replaced'
  | 'worker_unavailable'
  | 'invalid_renewal';

export interface WorkerRunLeaseLoss {
  lease: RunDispatchLeaseRecord;
  reason: WorkerRunLeaseLossReason;
  error?: unknown;
}

export interface WorkerRunLeaseLifecycleOptions {
  currentSession(): WorkerRecord | undefined;
  clock?: { now(): number };
  scheduler?: WorkerRunLeaseScheduler;
  retryDelayMs?: number;
  stopTimeoutMs?: number;
  onRenewed?: (lease: RunDispatchLeaseRecord) => void;
  onLost?: (loss: WorkerRunLeaseLoss) => void;
  onError?: (error: unknown) => void;
}

export type WorkerRunLeaseStopResult = 'stopped' | 'not_started' | 'timed_out';

interface TrackedLease {
  lease: RunDispatchLeaseRecord;
  renewAtMs: number;
}

const defaultScheduler: WorkerRunLeaseScheduler = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

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

function cloneLease(lease: RunDispatchLeaseRecord): RunDispatchLeaseRecord {
  return { ...lease };
}

function renewalTime(lease: RunDispatchLeaseRecord): number {
  const duration = lease.expiresAtMs - lease.renewedAtMs;
  if (!Number.isSafeInteger(duration) || duration < 2) {
    throw new TypeError('Run dispatch lease renewal window is invalid');
  }
  return lease.renewedAtMs + Math.floor(duration / 2);
}

export class WorkerRunLeaseLifecycle {
  private readonly currentSessionProvider: WorkerRunLeaseLifecycleOptions['currentSession'];
  private readonly clock: { now(): number };
  private readonly scheduler: WorkerRunLeaseScheduler;
  private readonly retryDelayMs: number;
  private readonly stopTimeoutMs: number;
  private readonly onRenewed?: WorkerRunLeaseLifecycleOptions['onRenewed'];
  private readonly onLost?: WorkerRunLeaseLifecycleOptions['onLost'];
  private readonly onError?: WorkerRunLeaseLifecycleOptions['onError'];
  private readonly tracked = new Map<string, TrackedLease>();
  private started = false;
  private releasing = false;
  private timer?: ScheduledTimer;
  private inFlight?: Promise<void>;

  constructor(
    private readonly client: WorkerRunLeaseClient,
    options: WorkerRunLeaseLifecycleOptions,
  ) {
    this.currentSessionProvider = options.currentSession;
    this.clock = options.clock ?? Date;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.onRenewed = options.onRenewed;
    this.onLost = options.onLost;
    this.onError = options.onError;
    assertIntegerBetween(
      'retryDelayMs',
      this.retryDelayMs,
      MIN_WORKER_RUN_LEASE_RETRY_MS,
      MAX_WORKER_RUN_LEASE_RETRY_MS,
    );
    assertIntegerBetween(
      'stopTimeoutMs',
      this.stopTimeoutMs,
      1,
      MAX_WORKER_RUN_LEASE_STOP_TIMEOUT_MS,
    );
  }

  start(): boolean {
    if (this.started || this.releasing) return false;
    this.started = true;
    this.schedule();
    return true;
  }

  track(lease: RunDispatchLeaseRecord): void {
    if (this.releasing) {
      throw new Error('Run leases cannot be tracked while release is active');
    }
    assertRunDispatchLeaseRecord(lease);
    if (lease.status !== 'leased') {
      throw new TypeError('Only an active Run dispatch lease can be tracked');
    }
    const nowMs = this.now();
    if (lease.expiresAtMs <= nowMs) {
      throw new TypeError('An expired Run dispatch lease cannot be tracked');
    }
    const session = this.currentSessionProvider();
    this.assertCurrentSession(lease, session, nowMs);
    const existing = this.tracked.get(lease.attemptId);
    if (existing && !this.sameAuthority(existing.lease, lease)) {
      throw new TypeError(
        `Run dispatch lease ${lease.attemptId} cannot replace a different authority`,
      );
    }
    if (
      !existing &&
      session &&
      this.tracked.size >= session.maxConcurrentRuns
    ) {
      throw new RangeError('Tracked Run leases exceed Worker concurrency');
    }
    this.tracked.set(lease.attemptId, {
      lease: cloneLease(lease),
      renewAtMs: renewalTime(lease),
    });
    this.clearTimer();
    this.schedule();
  }

  untrack(attemptId: string): RunDispatchLeaseRecord | undefined {
    const tracked = this.tracked.get(attemptId);
    if (!tracked) return undefined;
    this.tracked.delete(attemptId);
    this.clearTimer();
    this.schedule();
    return cloneLease(tracked.lease);
  }

  leases(): RunDispatchLeaseRecord[] {
    return [...this.tracked.values()]
      .map(({ lease }) => cloneLease(lease))
      .sort((left, right) => left.attemptId.localeCompare(right.attemptId));
  }

  async releaseAll(
    reason: Exclude<RunDispatchReleaseReason, 'lease_expired'> = 'shutdown',
  ): Promise<RunDispatchLeaseRecord[]> {
    if (this.releasing) {
      throw new Error('Run lease release is already active');
    }
    this.releasing = true;
    this.clearTimer();
    const released: RunDispatchLeaseRecord[] = [];
    try {
      await this.inFlight;
      this.clearTimer();
      for (const tracked of [...this.tracked.values()]) {
        if (this.tracked.get(tracked.lease.attemptId) !== tracked) continue;
        try {
          const result = await this.client.release({
            runId: tracked.lease.runId,
            ...this.fence(tracked.lease),
            reason,
          });
          this.assertRelease(tracked.lease, result.lease, reason);
          this.tracked.delete(tracked.lease.attemptId);
          released.push(cloneLease(result.lease));
        } catch (error) {
          if (error instanceof RunDispatchLeaseFenceRejectedError) {
            this.lose(tracked, 'fenced', error);
          } else {
            this.notifyError(error);
          }
        }
      }
    } finally {
      this.releasing = false;
      this.schedule();
    }
    return released;
  }

  async stop(): Promise<WorkerRunLeaseStopResult> {
    if (!this.started) return 'not_started';
    this.started = false;
    this.clearTimer();
    const deadline = Date.now() + this.stopTimeoutMs;
    if (!(await this.waitWithin(this.inFlight, deadline))) return 'timed_out';
    return 'stopped';
  }

  private schedule(): void {
    if (
      !this.started ||
      this.releasing ||
      this.timer ||
      this.inFlight ||
      !this.tracked.size
    ) {
      return;
    }
    const nowMs = this.now();
    const nextAtMs = Math.min(
      ...[...this.tracked.values()].map((tracked) =>
        Math.min(tracked.renewAtMs, tracked.lease.expiresAtMs),
      ),
    );
    const timer = this.scheduler.setTimeout(() => {
      if (this.timer === timer) this.timer = undefined;
      this.runRenewals();
    }, Math.max(0, nextAtMs - nowMs));
    this.timer = timer;
    timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private runRenewals(): void {
    if (!this.started || this.releasing || this.inFlight) return;
    const operation = this.renewDue()
      .catch((error) => this.notifyError(error))
      .then(() => undefined)
      .finally(() => {
        if (this.inFlight === operation) this.inFlight = undefined;
        this.schedule();
      });
    this.inFlight = operation;
  }

  private async renewDue(): Promise<void> {
    const due = [...this.tracked.values()]
      .filter(
        (tracked) =>
          tracked.renewAtMs <= this.now() ||
          tracked.lease.expiresAtMs <= this.now(),
      )
      .sort((left, right) =>
        left.lease.attemptId.localeCompare(right.lease.attemptId),
      );
    for (const tracked of due) await this.renewOne(tracked);
  }

  private async renewOne(tracked: TrackedLease): Promise<void> {
    if (this.tracked.get(tracked.lease.attemptId) !== tracked) return;
    const nowMs = this.now();
    if (tracked.lease.expiresAtMs <= nowMs) {
      this.lose(tracked, 'lease_expired');
      return;
    }
    const session = this.currentSessionProvider();
    try {
      this.assertCurrentSession(tracked.lease, session, nowMs);
    } catch (error) {
      const reason =
        session && this.sameWorkerSession(tracked.lease, session)
          ? 'worker_unavailable'
          : 'worker_session_replaced';
      this.lose(tracked, reason, error);
      return;
    }
    try {
      const renewed = await this.client.renew(this.fence(tracked.lease));
      this.assertRenewal(tracked.lease, renewed, this.now());
      if (this.tracked.get(tracked.lease.attemptId) !== tracked) return;
      tracked.lease = cloneLease(renewed);
      tracked.renewAtMs = renewalTime(renewed);
      this.notifyRenewed(renewed);
    } catch (error) {
      if (error instanceof RunDispatchLeaseFenceRejectedError) {
        this.lose(tracked, 'fenced', error);
        return;
      }
      this.notifyError(error);
      const retryAtMs = this.now() + this.retryDelayMs;
      if (retryAtMs >= tracked.lease.expiresAtMs) {
        tracked.renewAtMs = tracked.lease.expiresAtMs;
      } else {
        tracked.renewAtMs = retryAtMs;
      }
    }
  }

  private assertRenewal(
    previous: RunDispatchLeaseRecord,
    renewed: RunDispatchLeaseRecord,
    nowMs: number,
  ): void {
    assertRunDispatchLeaseRecord(renewed);
    if (
      renewed.status !== 'leased' ||
      !this.sameAuthority(previous, renewed) ||
      renewed.version !== previous.version + 1 ||
      renewed.renewedAtMs < previous.renewedAtMs ||
      renewed.expiresAtMs <= nowMs
    ) {
      throw new TypeError(
        'Control plane returned an invalid Run lease renewal',
      );
    }
  }

  private assertRelease(
    previous: RunDispatchLeaseRecord,
    released: RunDispatchLeaseRecord,
    reason: RunDispatchReleaseReason,
  ): void {
    assertRunDispatchLeaseRecord(released);
    if (
      released.status !== 'released' ||
      !this.sameAuthority(previous, released) ||
      released.version !== previous.version + 1 ||
      released.releaseReason !== reason
    ) {
      throw new TypeError(
        'Control plane returned an invalid Run lease release',
      );
    }
  }

  private assertCurrentSession(
    lease: RunDispatchLeaseRecord,
    session: WorkerRecord | undefined,
    nowMs: number,
  ): asserts session is WorkerRecord {
    if (!session || !this.sameWorkerSession(lease, session)) {
      throw new TypeError(
        'Run lease does not belong to the current Worker session',
      );
    }
    if (
      (session.status !== 'online' && session.status !== 'draining') ||
      session.leaseExpiresAtMs <= nowMs
    ) {
      throw new TypeError('Current Worker session is unavailable');
    }
  }

  private sameWorkerSession(
    lease: RunDispatchLeaseRecord,
    session: WorkerRecord,
  ): boolean {
    return (
      lease.workerId === session.id &&
      lease.workerSessionId === session.sessionId &&
      lease.workerGeneration === session.generation
    );
  }

  private sameAuthority(
    left: RunDispatchLeaseRecord,
    right: RunDispatchLeaseRecord,
  ): boolean {
    return (
      left.attemptId === right.attemptId &&
      left.runId === right.runId &&
      left.workerId === right.workerId &&
      left.workerSessionId === right.workerSessionId &&
      left.workerGeneration === right.workerGeneration &&
      left.leaseGeneration === right.leaseGeneration &&
      left.leaseToken === right.leaseToken
    );
  }

  private fence(lease: RunDispatchLeaseRecord) {
    return {
      attemptId: lease.attemptId,
      workerId: lease.workerId,
      workerSessionId: lease.workerSessionId,
      workerGeneration: lease.workerGeneration,
      leaseGeneration: lease.leaseGeneration,
      leaseToken: lease.leaseToken,
      expectedVersion: lease.version,
    };
  }

  private now(): number {
    const nowMs = this.clock.now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError('Worker Run lease clock returned an invalid time');
    }
    return nowMs;
  }

  private lose(
    tracked: TrackedLease,
    reason: WorkerRunLeaseLossReason,
    error?: unknown,
  ): void {
    if (this.tracked.get(tracked.lease.attemptId) !== tracked) return;
    this.tracked.delete(tracked.lease.attemptId);
    try {
      this.onLost?.({
        lease: cloneLease(tracked.lease),
        reason,
        ...(error === undefined ? {} : { error }),
      });
    } catch (callbackError) {
      this.notifyError(callbackError);
    }
  }

  private notifyRenewed(lease: RunDispatchLeaseRecord): void {
    try {
      this.onRenewed?.(cloneLease(lease));
    } catch (error) {
      this.notifyError(error);
    }
  }

  private notifyError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics must not create a renewal failure loop.
    }
  }

  private async waitWithin(
    promise: Promise<unknown> | undefined,
    deadline: number,
  ): Promise<boolean> {
    if (!promise) return true;
    const remainingMs = Math.max(0, deadline - Date.now());
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), remainingMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return completed;
  }
}
