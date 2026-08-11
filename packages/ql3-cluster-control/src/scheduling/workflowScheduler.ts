// Scheduling owns Workflow frontier and Task Attempt admission on the shared cadence.
import type {
  PluginPackageWorkflowFrontierCursor,
  PluginPackageWorkflowFrontierRepository,
} from '@qinglong/runtime-core/plugin-package-workflow-frontier';
import type {
  PluginPackageWorkflowTaskAttemptAdmissionCursor,
  PluginPackageWorkflowTaskAttemptAdmissionRepository,
} from '@qinglong/runtime-core/plugin-package-workflow-task-attempt-admission';

import type {
  ClusterSchedulerCoordinator,
  ClusterSchedulerCycleSummary,
} from './scheduler';

export interface ClusterWorkflowSchedulerOptions {
  readonly frontierPageSize: number;
  readonly frontierMaxPages: number;
  readonly taskAttemptPageSize: number;
  readonly taskAttemptMaxPages: number;
}

export interface ClusterWorkflowSchedulerCycleSummary {
  readonly frontierPages: number;
  readonly frontierScanned: number;
  readonly frontierAdvanced: number;
  readonly frontierTruncated: boolean;
  readonly taskAttemptPages: number;
  readonly taskAttemptsScanned: number;
  readonly taskAttemptsCreated: number;
  readonly taskAttemptsExisting: number;
  readonly taskAttemptsTruncated: boolean;
}

function bounded(
  label: string,
  value: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum}`);
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
      'Cluster Workflow frontier continuation did not advance',
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
      'Cluster Workflow Task Attempt continuation did not advance',
    );
  }
  return next;
}

/**
 * Extends the existing Cluster Scheduler cadence with Workflow frontier and
 * Task Attempt admission. It owns no timer, connection, watcher, or
 * per-Workflow state.
 */
export class ClusterWorkflowSchedulerCoordinator {
  private readonly frontierPageSize: number;
  private readonly frontierMaxPages: number;
  private readonly taskAttemptPageSize: number;
  private readonly taskAttemptMaxPages: number;
  private inFlight: Promise<ClusterSchedulerCycleSummary> | undefined;
  private latestWorkflow:
    | Readonly<ClusterWorkflowSchedulerCycleSummary>
    | undefined;

  constructor(
    private readonly scheduler: Pick<
      ClusterSchedulerCoordinator,
      'scheduleOnce'
    >,
    private readonly frontier: PluginPackageWorkflowFrontierRepository,
    private readonly taskAttempts: PluginPackageWorkflowTaskAttemptAdmissionRepository,
    options: ClusterWorkflowSchedulerOptions,
  ) {
    if (
      typeof scheduler?.scheduleOnce !== 'function' ||
      typeof frontier?.listCandidates !== 'function' ||
      typeof frontier?.advance !== 'function' ||
      typeof taskAttempts?.listCandidates !== 'function' ||
      typeof taskAttempts?.admit !== 'function' ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options)
    ) {
      throw new TypeError('Cluster Workflow scheduler is invalid');
    }
    this.frontierPageSize = bounded(
      'Cluster Workflow frontier page size',
      options.frontierPageSize,
      64,
    );
    this.frontierMaxPages = bounded(
      'Cluster Workflow frontier page limit',
      options.frontierMaxPages,
      16,
    );
    this.taskAttemptPageSize = bounded(
      'Cluster Workflow Task Attempt page size',
      options.taskAttemptPageSize,
      64,
    );
    this.taskAttemptMaxPages = bounded(
      'Cluster Workflow Task Attempt page limit',
      options.taskAttemptMaxPages,
      16,
    );
  }

  scheduleOnce(): Promise<ClusterSchedulerCycleSummary> {
    if (this.inFlight) return this.inFlight;
    const work = this.runCycle().finally(() => {
      if (this.inFlight === work) this.inFlight = undefined;
    });
    this.inFlight = work;
    return work;
  }

  latestWorkflowSummary():
    | Readonly<ClusterWorkflowSchedulerCycleSummary>
    | undefined {
    return this.latestWorkflow;
  }

  private async runCycle(): Promise<ClusterSchedulerCycleSummary> {
    const scheduler = await this.scheduler.scheduleOnce();
    const frontier = await this.advanceFrontier();
    const taskAttempts = await this.admitTaskAttempts();
    this.latestWorkflow = Object.freeze({
      ...frontier,
      ...taskAttempts,
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
    for (let index = 0; index < this.frontierMaxPages; index += 1) {
      const page = await this.frontier.listCandidates({
        limit: this.frontierPageSize,
        ...(after === undefined ? {} : { after }),
      });
      if (page.candidates.length > this.frontierPageSize) {
        throw new RangeError(
          'Cluster Workflow frontier exceeded its page size',
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
    for (let index = 0; index < this.taskAttemptMaxPages; index += 1) {
      const page = await this.taskAttempts.listCandidates({
        limit: this.taskAttemptPageSize,
        ...(after === undefined ? {} : { after }),
      });
      if (page.candidates.length > this.taskAttemptPageSize) {
        throw new RangeError(
          'Cluster Workflow Task Attempt source exceeded its page size',
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
}
