// Scheduling owns bounded trigger claiming and the single non-overlapping lifecycle timer.
import { randomUUID } from 'node:crypto';
import {
  MAX_CLUSTER_SCHEDULE_CLAIM_LEASE_MS,
  MIN_CLUSTER_SCHEDULE_CLAIM_LEASE_MS,
  resolveClusterScheduleDecision,
  type ClusterScheduleStore,
} from '@qinglong/runtime-core/cluster-scheduler';
import type { LocalCronNextOccurrence } from '@qinglong/runtime-core/local-scheduler';
import { cronerClusterNextOccurrence } from './cronerSchedule';

export const MAX_CLUSTER_SCHEDULE_CLAIMS_PER_CYCLE = 256;

export interface ClusterSchedulerCoordinatorOptions {
  readonly ownerId: string;
  readonly claimLeaseMs?: number;
  readonly maxClaimsPerCycle?: number;
  readonly misfireGraceMs?: number;
  readonly createId?: () => string;
  readonly nextOccurrence?: LocalCronNextOccurrence;
  readonly onAdmitted?: (
    runId: string,
    attemptId: string,
  ) => void | Promise<void>;
}

export interface ClusterSchedulerCycleSummary {
  readonly firstClaimAcquiredAtMs: number | null;
  readonly lastClaimAcquiredAtMs: number | null;
  readonly claimed: number;
  readonly initialized: number;
  readonly skipped: number;
  readonly admitted: number;
  readonly raced: number;
  readonly saturated: boolean;
}

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COORDINATOR_OPTION_KEYS = new Set([
  'claimLeaseMs',
  'createId',
  'maxClaimsPerCycle',
  'misfireGraceMs',
  'nextOccurrence',
  'onAdmitted',
  'ownerId',
]);

export class ClusterSchedulerCoordinator {
  private readonly ownerId: string;
  private readonly claimLeaseMs: number;
  private readonly maxClaimsPerCycle: number;
  private readonly misfireGraceMs: number;
  private readonly createId: () => string;
  private readonly nextOccurrence: LocalCronNextOccurrence;
  private readonly onAdmitted?: ClusterSchedulerCoordinatorOptions['onAdmitted'];

  constructor(
    private readonly schedules: ClusterScheduleStore,
    options: ClusterSchedulerCoordinatorOptions,
  ) {
    this.ownerId = options?.ownerId ?? '';
    this.claimLeaseMs = options?.claimLeaseMs ?? 30_000;
    this.maxClaimsPerCycle = options?.maxClaimsPerCycle ?? 16;
    this.misfireGraceMs = options?.misfireGraceMs ?? 30_000;
    this.createId = options?.createId ?? randomUUID;
    this.nextOccurrence =
      options?.nextOccurrence ?? cronerClusterNextOccurrence;
    this.onAdmitted = options?.onAdmitted;
    if (
      !schedules ||
      typeof schedules.claimNextClusterSchedule !== 'function' ||
      typeof schedules.commitClusterScheduleDecision !== 'function' ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => !COORDINATOR_OPTION_KEYS.has(key)) ||
      !OWNER_PATTERN.test(this.ownerId) ||
      !Number.isSafeInteger(this.claimLeaseMs) ||
      this.claimLeaseMs < MIN_CLUSTER_SCHEDULE_CLAIM_LEASE_MS ||
      this.claimLeaseMs > MAX_CLUSTER_SCHEDULE_CLAIM_LEASE_MS ||
      !Number.isSafeInteger(this.maxClaimsPerCycle) ||
      this.maxClaimsPerCycle < 1 ||
      this.maxClaimsPerCycle > MAX_CLUSTER_SCHEDULE_CLAIMS_PER_CYCLE ||
      !Number.isSafeInteger(this.misfireGraceMs) ||
      this.misfireGraceMs < 0 ||
      this.misfireGraceMs > 5 * 60_000 ||
      typeof this.createId !== 'function' ||
      typeof this.nextOccurrence !== 'function' ||
      (this.onAdmitted !== undefined && typeof this.onAdmitted !== 'function')
    ) {
      throw new TypeError('Cluster scheduler coordinator options are invalid');
    }
  }

  async scheduleOnce(): Promise<ClusterSchedulerCycleSummary> {
    const stats: {
      firstClaimAcquiredAtMs: number | null;
      lastClaimAcquiredAtMs: number | null;
      claimed: number;
      initialized: number;
      skipped: number;
      admitted: number;
      raced: number;
      saturated: boolean;
    } = {
      firstClaimAcquiredAtMs: null,
      lastClaimAcquiredAtMs: null,
      claimed: 0,
      initialized: 0,
      skipped: 0,
      admitted: 0,
      raced: 0,
      saturated: false,
    };
    while (stats.claimed < this.maxClaimsPerCycle) {
      const claimToken = this.createId();
      const claimed = await this.schedules.claimNextClusterSchedule({
        ownerId: this.ownerId,
        claimToken,
        leaseMs: this.claimLeaseMs,
      });
      if (!claimed) break;
      if (
        claimed.claimOwner !== this.ownerId ||
        claimed.claimToken !== claimToken ||
        claimed.claimExpiresAtMs !==
          claimed.claimAcquiredAtMs + this.claimLeaseMs
      ) {
        throw new TypeError('Cluster scheduler store returned a foreign claim');
      }
      stats.claimed += 1;
      stats.firstClaimAcquiredAtMs ??= claimed.claimAcquiredAtMs;
      stats.lastClaimAcquiredAtMs = claimed.claimAcquiredAtMs;
      const decision = resolveClusterScheduleDecision(
        claimed,
        this.misfireGraceMs,
        this.nextOccurrence,
      );
      const admitted = decision.disposition === 'admit';
      const result = await this.schedules.commitClusterScheduleDecision({
        claim: claimed,
        decision,
        ...(admitted
          ? {
              runId: this.createId(),
              attemptId: this.createId(),
              createdEventId: this.createId(),
              queuedEventId: this.createId(),
            }
          : {}),
      });
      if (result.status === 'raced') {
        stats.raced += 1;
        continue;
      }
      if (result.disposition === 'initialize') stats.initialized += 1;
      if (result.disposition === 'skip') stats.skipped += 1;
      if (result.status === 'admitted') {
        stats.admitted += 1;
        await this.onAdmitted?.(result.runId, result.attemptId);
      }
    }
    stats.saturated = stats.claimed === this.maxClaimsPerCycle;
    return Object.freeze(stats);
  }
}

export interface ClusterSchedulerLifecycleOptions {
  readonly intervalMs: number;
  readonly stopTimeoutMs: number;
  readonly onDiagnostic?: (
    error: unknown,
    summary?: ClusterSchedulerCycleSummary,
  ) => void | Promise<void>;
}

export interface ClusterSchedulerLifecycleStopSummary {
  readonly status: 'stopped' | 'timed_out';
}

export class ClusterSchedulerLifecycle {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<ClusterSchedulerCycleSummary> | undefined;
  private stopPromise:
    | Promise<ClusterSchedulerLifecycleStopSummary>
    | undefined;
  private running = false;
  private stopping = false;

  constructor(
    private readonly scheduler: Pick<
      ClusterSchedulerCoordinator,
      'scheduleOnce'
    >,
    private readonly options: ClusterSchedulerLifecycleOptions,
  ) {
    if (
      !scheduler ||
      typeof scheduler.scheduleOnce !== 'function' ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 250 ||
      options.intervalMs > 60 * 60_000 ||
      !Number.isSafeInteger(options.stopTimeoutMs) ||
      options.stopTimeoutMs < 100 ||
      options.stopTimeoutMs > 30_000 ||
      (options.onDiagnostic !== undefined &&
        typeof options.onDiagnostic !== 'function')
    ) {
      throw new TypeError('Cluster scheduler lifecycle options are invalid');
    }
  }

  start(): 'started' {
    if (!this.running && !this.stopping) {
      this.running = true;
      this.schedule();
    }
    return 'started';
  }

  runOnce(): Promise<ClusterSchedulerCycleSummary> {
    if (this.stopping) {
      return Promise.reject(
        new Error('Cluster scheduler lifecycle is stopping'),
      );
    }
    if (this.inFlight) return this.inFlight;
    const work = this.scheduler.scheduleOnce().finally(() => {
      if (this.inFlight === work) this.inFlight = undefined;
    });
    this.inFlight = work;
    return work;
  }

  stopAndDrain(): Promise<ClusterSchedulerLifecycleStopSummary> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.stopPromise = (async () => {
      const work = this.inFlight;
      if (!work) return Object.freeze({ status: 'stopped' as const });
      let timeout: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          work.then(
            () => Object.freeze({ status: 'stopped' as const }),
            () => Object.freeze({ status: 'stopped' as const }),
          ),
          new Promise<ClusterSchedulerLifecycleStopSummary>((resolve) => {
            timeout = setTimeout(
              () => resolve(Object.freeze({ status: 'timed_out' as const })),
              this.options.stopTimeoutMs,
            );
            timeout.unref?.();
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })();
    return this.stopPromise;
  }

  private schedule(): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.running) return;
      void this.runOnce()
        .then((summary) => this.diagnostic(undefined, summary))
        .catch((error) => this.diagnostic(error))
        .finally(() => this.schedule());
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  private async diagnostic(
    error: unknown,
    summary?: ClusterSchedulerCycleSummary,
  ): Promise<void> {
    if (this.stopping) return;
    try {
      await this.options.onDiagnostic?.(error, summary);
    } catch {
      // Diagnostics cannot own or stop scheduling.
    }
  }
}
