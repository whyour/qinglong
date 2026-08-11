import {
  ClusterRunCancellationConvergenceCoordinator,
  type ClusterRunCancellationConvergenceCycleResult,
  type ClusterRunCancellationConvergenceRepository,
} from '@qinglong/runtime-core/cluster-run-cancellation-convergence';
import type {
  PluginPackageWorkflowFrontierCursor,
  PluginPackageWorkflowFrontierRepository,
} from '@qinglong/runtime-core/plugin-package-workflow-frontier';
import type {
  PluginPackageWorkflowTaskAttemptAdmissionCursor,
  PluginPackageWorkflowTaskAttemptAdmissionRepository,
} from '@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission';

import type {
  LocalRunDispatcher,
  LocalRunDispatcherResult,
} from '../dispatch/dispatcher';
import type {
  LocalSchedulerCoordinator,
  LocalSchedulerCycleSummary,
} from './coordinator';

export interface LocalWorkflowSchedulerCoordinatorOptions {
  readonly cancellationPageSize: number;
  readonly cancellationMaxPages: number;
  readonly frontierPageSize: number;
  readonly frontierMaxPages: number;
  readonly taskAttemptPageSize: number;
  readonly taskAttemptMaxPages: number;
  readonly maxDispatches: number;
}

export interface LocalWorkflowSchedulerCycleSummary {
  readonly cancellation: Readonly<ClusterRunCancellationConvergenceCycleResult>;
  readonly frontierPages: number;
  readonly frontierScanned: number;
  readonly frontierAdvanced: number;
  readonly frontierTruncated: boolean;
  readonly taskAttemptPages: number;
  readonly taskAttemptsScanned: number;
  readonly taskAttemptsCreated: number;
  readonly taskAttemptsExisting: number;
  readonly taskAttemptsTruncated: boolean;
  readonly dispatches: number;
  readonly activated: number;
  readonly activationFailed: number;
  readonly dispatchIdle: boolean;
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function nextFrontierCursor(
  current: PluginPackageWorkflowFrontierCursor | undefined,
  next: PluginPackageWorkflowFrontierCursor | undefined,
): PluginPackageWorkflowFrontierCursor {
  if (
    !next ||
    (current !== undefined &&
      (next.admittedAtMs < current.admittedAtMs ||
        (next.admittedAtMs === current.admittedAtMs &&
          next.planDigest <= current.planDigest)))
  ) {
    throw new TypeError(
      'Local Workflow frontier continuation did not advance',
    );
  }
  return next;
}

function nextTaskAttemptCursor(
  current: PluginPackageWorkflowTaskAttemptAdmissionCursor | undefined,
  next: PluginPackageWorkflowTaskAttemptAdmissionCursor | undefined,
): PluginPackageWorkflowTaskAttemptAdmissionCursor {
  if (
    !next ||
    (current !== undefined &&
      (next.readyAtMs < current.readyAtMs ||
        (next.readyAtMs === current.readyAtMs &&
          next.stepRunId <= current.stepRunId)))
  ) {
    throw new TypeError(
      'Local Workflow Task Attempt continuation did not advance',
    );
  }
  return next;
}

/**
 * Reuses the existing Local scheduler cadence. It owns no timer, connection,
 * watcher, or per-Workflow state.
 */
export class LocalWorkflowSchedulerCoordinator {
  private readonly cancellation: ClusterRunCancellationConvergenceCoordinator;
  private readonly frontierPageSize: number;
  private readonly frontierMaxPages: number;
  private readonly taskAttemptPageSize: number;
  private readonly taskAttemptMaxPages: number;
  private readonly maxDispatches: number;
  private inFlight:
    | Promise<Readonly<LocalSchedulerCycleSummary>>
    | undefined;
  private latestWorkflow:
    | Readonly<LocalWorkflowSchedulerCycleSummary>
    | undefined;

  constructor(
    private readonly scheduler: Pick<LocalSchedulerCoordinator, 'scheduleOnce'>,
    cancellation: ClusterRunCancellationConvergenceRepository,
    private readonly frontier: PluginPackageWorkflowFrontierRepository,
    private readonly taskAttempts: PluginPackageWorkflowTaskAttemptAdmissionRepository,
    private readonly dispatcher: Pick<LocalRunDispatcher, 'dispatchOnce'>,
    options: LocalWorkflowSchedulerCoordinatorOptions,
  ) {
    if (
      typeof scheduler?.scheduleOnce !== 'function' ||
      typeof cancellation?.convergePage !== 'function' ||
      typeof frontier?.listCandidates !== 'function' ||
      typeof frontier?.advance !== 'function' ||
      typeof taskAttempts?.listCandidates !== 'function' ||
      typeof taskAttempts?.admit !== 'function' ||
      typeof dispatcher?.dispatchOnce !== 'function' ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options)
    ) {
      throw new TypeError(
        'Local Workflow scheduler coordinator is invalid',
      );
    }
    this.cancellation = new ClusterRunCancellationConvergenceCoordinator(
      cancellation,
      {
        pageSize: options.cancellationPageSize,
        maxPages: options.cancellationMaxPages,
      },
    );
    this.frontierPageSize = bounded(
      options.frontierPageSize,
      1,
      64,
      'Local Workflow frontier page size',
    );
    this.frontierMaxPages = bounded(
      options.frontierMaxPages,
      1,
      16,
      'Local Workflow frontier page limit',
    );
    this.taskAttemptPageSize = bounded(
      options.taskAttemptPageSize,
      1,
      64,
      'Local Workflow Task Attempt page size',
    );
    this.taskAttemptMaxPages = bounded(
      options.taskAttemptMaxPages,
      1,
      16,
      'Local Workflow Task Attempt page limit',
    );
    this.maxDispatches = bounded(
      options.maxDispatches,
      1,
      16,
      'Local Workflow dispatch limit',
    );
  }

  scheduleOnce(): Promise<Readonly<LocalSchedulerCycleSummary>> {
    if (this.inFlight) return this.inFlight;
    const work = this.runCycle().finally(() => {
      if (this.inFlight === work) this.inFlight = undefined;
    });
    this.inFlight = work;
    return work;
  }

  latestWorkflowSummary():
    | Readonly<LocalWorkflowSchedulerCycleSummary>
    | undefined {
    return this.latestWorkflow;
  }

  private async runCycle(): Promise<Readonly<LocalSchedulerCycleSummary>> {
    const cancellation = await this.cancellation.reconcile();
    const scheduler = await this.scheduler.scheduleOnce();
    const frontier = await this.advanceFrontier();
    const taskAttempts = await this.admitTaskAttempts();
    const dispatch = await this.dispatch();
    this.latestWorkflow = Object.freeze({
      cancellation,
      ...frontier,
      ...taskAttempts,
      ...dispatch,
    });
    return scheduler;
  }

  private async advanceFrontier(): Promise<Readonly<{
    frontierPages: number;
    frontierScanned: number;
    frontierAdvanced: number;
    frontierTruncated: boolean;
  }>> {
    let frontierPages = 0;
    let frontierScanned = 0;
    let frontierAdvanced = 0;
    let frontierTruncated = false;
    let after: PluginPackageWorkflowFrontierCursor | undefined;
    for (
      let index = 0;
      index < this.frontierMaxPages;
      index += 1
    ) {
      const page = await this.frontier.listCandidates({
        limit: this.frontierPageSize,
        ...(after === undefined ? {} : { after }),
      });
      if (page.candidates.length > this.frontierPageSize) {
        throw new RangeError(
          'Local Workflow frontier exceeded its page size',
        );
      }
      frontierPages += 1;
      frontierScanned += page.candidates.length;
      for (const candidate of page.candidates) {
        await this.frontier.advance(candidate.runId);
        frontierAdvanced += 1;
      }
      frontierTruncated = page.truncated;
      if (!page.truncated) break;
      after = nextFrontierCursor(after, page.next);
    }
    return Object.freeze({
      frontierPages,
      frontierScanned,
      frontierAdvanced,
      frontierTruncated,
    });
  }

  private async admitTaskAttempts(): Promise<Readonly<{
    taskAttemptPages: number;
    taskAttemptsScanned: number;
    taskAttemptsCreated: number;
    taskAttemptsExisting: number;
    taskAttemptsTruncated: boolean;
  }>> {
    let taskAttemptPages = 0;
    let taskAttemptsScanned = 0;
    let taskAttemptsCreated = 0;
    let taskAttemptsExisting = 0;
    let taskAttemptsTruncated = false;
    let after:
      | PluginPackageWorkflowTaskAttemptAdmissionCursor
      | undefined;
    for (
      let index = 0;
      index < this.taskAttemptMaxPages;
      index += 1
    ) {
      const page = await this.taskAttempts.listCandidates({
        limit: this.taskAttemptPageSize,
        ...(after === undefined ? {} : { after }),
      });
      if (page.candidates.length > this.taskAttemptPageSize) {
        throw new RangeError(
          'Local Workflow Task Attempt source exceeded its page size',
        );
      }
      taskAttemptPages += 1;
      taskAttemptsScanned += page.candidates.length;
      for (const candidate of page.candidates) {
        const admitted = await this.taskAttempts.admit(
          candidate.runId,
          candidate.stepRunId,
        );
        if (admitted.status === 'created') taskAttemptsCreated += 1;
        else taskAttemptsExisting += 1;
      }
      taskAttemptsTruncated = page.truncated;
      if (!page.truncated) break;
      after = nextTaskAttemptCursor(after, page.next);
    }
    return Object.freeze({
      taskAttemptPages,
      taskAttemptsScanned,
      taskAttemptsCreated,
      taskAttemptsExisting,
      taskAttemptsTruncated,
    });
  }

  private async dispatch(): Promise<Readonly<{
    dispatches: number;
    activated: number;
    activationFailed: number;
    dispatchIdle: boolean;
  }>> {
    let dispatches = 0;
    let activated = 0;
    let activationFailed = 0;
    let dispatchIdle = false;
    for (let index = 0; index < this.maxDispatches; index += 1) {
      const result: LocalRunDispatcherResult =
        await this.dispatcher.dispatchOnce();
      dispatches += 1;
      if (result.status === 'activated') activated += 1;
      else if (result.status === 'activation_failed') {
        activationFailed += 1;
      } else {
        dispatchIdle = true;
        break;
      }
    }
    return Object.freeze({
      dispatches,
      activated,
      activationFailed,
      dispatchIdle,
    });
  }
}
