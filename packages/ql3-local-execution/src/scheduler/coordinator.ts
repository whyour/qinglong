import { randomUUID } from 'node:crypto';
import {
  assertLocalSchedulePageSize,
  resolveLocalScheduleDecision,
  type LocalCronNextOccurrence,
  type LocalScheduleStore,
} from '@qinglong/runtime-core/local-scheduler';
import { cronerLocalNextOccurrence } from './croner';

export interface LocalSchedulerCoordinatorOptions {
  readonly pageSize?: number;
  readonly misfireGraceMs?: number;
  readonly clock?: () => number;
  readonly createId?: () => string;
  readonly nextOccurrence?: LocalCronNextOccurrence;
  readonly onAdmitted?: (
    runId: string,
    attemptId: string,
  ) => void | Promise<void>;
}

export interface LocalSchedulerCycleSummary {
  readonly observedAtMs: number;
  readonly scanned: number;
  readonly initialized: number;
  readonly skipped: number;
  readonly admitted: number;
  readonly raced: number;
  readonly truncated: boolean;
}

export class LocalSchedulerCoordinator {
  private readonly pageSize: number;
  private readonly misfireGraceMs: number;
  private readonly clock: () => number;
  private readonly createId: () => string;
  private readonly nextOccurrence: LocalCronNextOccurrence;
  private readonly onAdmitted?: LocalSchedulerCoordinatorOptions['onAdmitted'];

  constructor(
    private readonly schedules: LocalScheduleStore,
    options: LocalSchedulerCoordinatorOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 8;
    this.misfireGraceMs = options.misfireGraceMs ?? 30_000;
    this.clock = options.clock ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.nextOccurrence = options.nextOccurrence ?? cronerLocalNextOccurrence;
    this.onAdmitted = options.onAdmitted;
    assertLocalSchedulePageSize(this.pageSize);
    if (
      !Number.isSafeInteger(this.misfireGraceMs) ||
      this.misfireGraceMs < 0 ||
      this.misfireGraceMs > 5 * 60_000 ||
      typeof this.clock !== 'function' ||
      typeof this.createId !== 'function' ||
      typeof this.nextOccurrence !== 'function' ||
      (this.onAdmitted !== undefined && typeof this.onAdmitted !== 'function')
    ) {
      throw new TypeError('Local scheduler options are invalid');
    }
  }

  async scheduleOnce(): Promise<LocalSchedulerCycleSummary> {
    const observedAtMs = this.clock();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
      throw new TypeError('Local scheduler clock is invalid');
    }
    const page = await this.schedules.listLocalScheduleCandidates({
      observedAtMs,
      limit: this.pageSize,
    });
    if (page.candidates.length > this.pageSize) {
      throw new RangeError('Local scheduler source exceeded its page size');
    }
    const stats = {
      observedAtMs,
      scanned: 0,
      initialized: 0,
      skipped: 0,
      admitted: 0,
      raced: 0,
      truncated: page.truncated,
    };
    for (const candidate of page.candidates) {
      stats.scanned += 1;
      const decision = resolveLocalScheduleDecision(
        candidate,
        observedAtMs,
        this.misfireGraceMs,
        this.nextOccurrence,
      );
      const admitted = decision.disposition === 'admit';
      const result = await this.schedules.commitLocalScheduleDecision({
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
    return Object.freeze(stats);
  }
}
