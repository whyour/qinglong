// Scheduling owns recovery and lost-retry ordering inside the shared cadence.
import type {
  ClusterControlStartupRecoverySummary,
  ClusterRunLostRetryPageResult,
} from '@qinglong/runtime-core';

import type {
  ClusterSchedulerCoordinator,
  ClusterSchedulerCycleSummary,
} from './scheduler';

export interface ClusterRuntimeSchedulerMaintenanceSummary {
  readonly recovery: Readonly<ClusterControlStartupRecoverySummary>;
  readonly lostRetry: Readonly<ClusterRunLostRetryPageResult>;
}

/**
 * Reuses the scheduler's single non-overlapping cadence for runtime recovery
 * and lost retry. It owns no timer, connection, cursor or per-Run state.
 */
export class ClusterRuntimeSchedulerCoordinator {
  private inFlight: Promise<ClusterSchedulerCycleSummary> | undefined;
  private latestMaintenance:
    | Readonly<ClusterRuntimeSchedulerMaintenanceSummary>
    | undefined;

  constructor(
    private readonly recovery: Readonly<{
      reconcile(): Promise<ClusterControlStartupRecoverySummary>;
    }>,
    private readonly lostRetry: Readonly<{
      reconcile(): Promise<Readonly<ClusterRunLostRetryPageResult>>;
    }>,
    private readonly scheduler: Pick<
      ClusterSchedulerCoordinator,
      'scheduleOnce'
    >,
  ) {
    if (
      typeof recovery?.reconcile !== 'function' ||
      typeof lostRetry?.reconcile !== 'function' ||
      typeof scheduler?.scheduleOnce !== 'function'
    ) {
      throw new TypeError('Cluster runtime scheduler coordinator is invalid');
    }
  }

  scheduleOnce(): Promise<ClusterSchedulerCycleSummary> {
    if (this.inFlight) return this.inFlight;
    const work = this.runCycle().finally(() => {
      if (this.inFlight === work) this.inFlight = undefined;
    });
    this.inFlight = work;
    return work;
  }

  latestMaintenanceSummary():
    | Readonly<ClusterRuntimeSchedulerMaintenanceSummary>
    | undefined {
    return this.latestMaintenance;
  }

  private async runCycle(): Promise<ClusterSchedulerCycleSummary> {
    const recovery = await this.recovery.reconcile();
    const lostRetry = await this.lostRetry.reconcile();
    this.latestMaintenance = Object.freeze({ recovery, lostRetry });
    return this.scheduler.scheduleOnce();
  }
}
