import {
  assertApprovedActionPageSize,
  type ApprovedActionDispatchCursor,
} from '../domain/approvedActionDispatchExecution';
import {
  assertApprovedActionRecoveryPageSize,
  type ApprovedActionRecoveryCursor,
} from '../domain/approvedActionRecovery';
import type {
  ApprovedActionDispatchBatchSummary,
  ApprovedActionDispatcher,
} from './approvedActionDispatcher';
import type {
  ApprovedActionRecoveryBatchSummary,
  ApprovedActionRecoveryReconciler,
} from './approvedActionRecoveryReconciler';

export const MAX_APPROVED_ACTION_RUNTIME_PAGES_PER_PHASE = 64;

export type ApprovedActionRuntimePhaseStopReason =
  | 'complete'
  | 'page_limit'
  | 'cursor_stalled';

export interface ApprovedActionDispatchCycleOptions {
  cursor?: ApprovedActionDispatchCursor;
  pageSize?: number;
  maxPages?: number;
}

export interface ApprovedActionRecoveryCycleOptions {
  cursor?: ApprovedActionRecoveryCursor;
  pageSize?: number;
  maxPages?: number;
}

export interface ApprovedActionRuntimeCycleOptions {
  dispatch?: ApprovedActionDispatchCycleOptions;
  recovery?: ApprovedActionRecoveryCycleOptions;
}

export interface ApprovedActionDispatchCycleSummary
  extends Omit<ApprovedActionDispatchBatchSummary, 'truncated' | 'nextCursor'> {
  pages: number;
  stopReason: ApprovedActionRuntimePhaseStopReason;
  remaining: boolean;
  nextCursor?: Readonly<ApprovedActionDispatchCursor>;
}

export interface ApprovedActionRecoveryCycleSummary
  extends Omit<ApprovedActionRecoveryBatchSummary, 'truncated' | 'nextCursor'> {
  pages: number;
  stopReason: ApprovedActionRuntimePhaseStopReason;
  remaining: boolean;
  nextCursor?: Readonly<ApprovedActionRecoveryCursor>;
}

export interface ApprovedActionRuntimeCycleSummary {
  recovery: Readonly<ApprovedActionRecoveryCycleSummary>;
  dispatch: Readonly<ApprovedActionDispatchCycleSummary>;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    keys.length === canonical.length &&
    keys.every((key, index) => key === canonical[index])
  );
}

function assertOptionsObject(
  name: string,
  value: unknown,
): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertMaxPages(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_APPROVED_ACTION_RUNTIME_PAGES_PER_PHASE
  ) {
    throw new RangeError(
      'maxPages must be between 1 and MAX_APPROVED_ACTION_RUNTIME_PAGES_PER_PHASE',
    );
  }
}

function sameDispatchCursor(
  left: ApprovedActionDispatchCursor | undefined,
  right: Readonly<ApprovedActionDispatchCursor>,
): boolean {
  return (
    left !== undefined &&
    left.eligibleAtMs === right.eligibleAtMs &&
    left.dispatchId === right.dispatchId
  );
}

function sameRecoveryCursor(
  left: ApprovedActionRecoveryCursor | undefined,
  right: Readonly<ApprovedActionRecoveryCursor>,
): boolean {
  return (
    left !== undefined &&
    left.nextScanAtMs === right.nextScanAtMs &&
    left.dispatchId === right.dispatchId
  );
}

function normalizeDispatchOptions(
  value: ApprovedActionDispatchCycleOptions = {},
): Required<Pick<ApprovedActionDispatchCycleOptions, 'pageSize' | 'maxPages'>> &
  Pick<ApprovedActionDispatchCycleOptions, 'cursor'> {
  assertOptionsObject('dispatch cycle options', value);
  const expectedKeys = [
    ...(value.cursor === undefined ? [] : ['cursor']),
    ...(value.pageSize === undefined ? [] : ['pageSize']),
    ...(value.maxPages === undefined ? [] : ['maxPages']),
  ];
  if (!exactKeys(value, expectedKeys)) {
    throw new TypeError('dispatch cycle options shape is invalid');
  }
  const pageSize = value.pageSize ?? 16;
  const maxPages = value.maxPages ?? 4;
  assertApprovedActionPageSize(pageSize);
  assertMaxPages(maxPages);
  return {
    pageSize,
    maxPages,
    ...(value.cursor === undefined ? {} : { cursor: { ...value.cursor } }),
  };
}

function normalizeRecoveryOptions(
  value: ApprovedActionRecoveryCycleOptions = {},
): Required<Pick<ApprovedActionRecoveryCycleOptions, 'pageSize' | 'maxPages'>> &
  Pick<ApprovedActionRecoveryCycleOptions, 'cursor'> {
  assertOptionsObject('recovery cycle options', value);
  const expectedKeys = [
    ...(value.cursor === undefined ? [] : ['cursor']),
    ...(value.pageSize === undefined ? [] : ['pageSize']),
    ...(value.maxPages === undefined ? [] : ['maxPages']),
  ];
  if (!exactKeys(value, expectedKeys)) {
    throw new TypeError('recovery cycle options shape is invalid');
  }
  const pageSize = value.pageSize ?? 16;
  const maxPages = value.maxPages ?? 4;
  assertApprovedActionRecoveryPageSize(pageSize);
  assertMaxPages(maxPages);
  return {
    pageSize,
    maxPages,
    ...(value.cursor === undefined ? {} : { cursor: { ...value.cursor } }),
  };
}

/**
 * Runs one bounded SQLite control-plane cycle. Recovery is deliberately first:
 * if the recovery index cannot be read, the cycle does not create more action
 * side effects. The class owns no timer and is safe to embed in other profiles.
 */
export class ApprovedActionRuntimeSupervisor {
  constructor(
    private readonly dispatcher: Pick<
      ApprovedActionDispatcher,
      'dispatchBatch'
    >,
    private readonly reconciler: Pick<
      ApprovedActionRecoveryReconciler,
      'reconcileBatch'
    >,
  ) {}

  async runCycle(
    options: ApprovedActionRuntimeCycleOptions = {},
  ): Promise<Readonly<ApprovedActionRuntimeCycleSummary>> {
    assertOptionsObject('approved action runtime options', options);
    const expectedKeys = [
      ...(options.dispatch === undefined ? [] : ['dispatch']),
      ...(options.recovery === undefined ? [] : ['recovery']),
    ];
    if (!exactKeys(options, expectedKeys)) {
      throw new TypeError('approved action runtime options shape is invalid');
    }
    const recoveryOptions = normalizeRecoveryOptions(options.recovery);
    const dispatchOptions = normalizeDispatchOptions(options.dispatch);
    const recovery = await this.runRecovery(recoveryOptions);
    const dispatch = await this.runDispatch(dispatchOptions);
    return Object.freeze({ recovery, dispatch });
  }

  private async runDispatch(
    options: ReturnType<typeof normalizeDispatchOptions>,
  ): Promise<Readonly<ApprovedActionDispatchCycleSummary>> {
    const total: ApprovedActionDispatchCycleSummary = {
      pages: 0,
      scanned: 0,
      claimed: 0,
      started: 0,
      succeeded: 0,
      failed: 0,
      blocked: 0,
      retrying: 0,
      deferred: 0,
      recoveryRequired: 0,
      alreadyTerminal: 0,
      unavailable: 0,
      stopReason: 'complete',
      remaining: false,
    };
    let cursor = options.cursor;
    for (let pageNumber = 0; pageNumber < options.maxPages; pageNumber += 1) {
      const page = await this.dispatcher.dispatchBatch({
        ...(cursor === undefined ? {} : { cursor }),
        limit: options.pageSize,
      });
      total.pages += 1;
      total.scanned += page.scanned;
      total.claimed += page.claimed;
      total.started += page.started;
      total.succeeded += page.succeeded;
      total.failed += page.failed;
      total.blocked += page.blocked;
      total.retrying += page.retrying;
      total.deferred += page.deferred;
      total.recoveryRequired += page.recoveryRequired;
      total.alreadyTerminal += page.alreadyTerminal;
      total.unavailable += page.unavailable;
      if (!page.truncated) return Object.freeze(total);
      if (!page.nextCursor || sameDispatchCursor(cursor, page.nextCursor)) {
        total.stopReason = 'cursor_stalled';
        total.remaining = true;
        if (page.nextCursor) total.nextCursor = { ...page.nextCursor };
        return Object.freeze(total);
      }
      cursor = { ...page.nextCursor };
      if (pageNumber === options.maxPages - 1) {
        total.stopReason = 'page_limit';
        total.remaining = true;
        total.nextCursor = cursor;
        return Object.freeze(total);
      }
    }
    return Object.freeze(total);
  }

  private async runRecovery(
    options: ReturnType<typeof normalizeRecoveryOptions>,
  ): Promise<Readonly<ApprovedActionRecoveryCycleSummary>> {
    const total: ApprovedActionRecoveryCycleSummary = {
      pages: 0,
      scanned: 0,
      claimed: 0,
      verifiedSucceeded: 0,
      verifiedFailed: 0,
      deferred: 0,
      manualRequired: 0,
      executionActive: 0,
      alreadyResolved: 0,
      unavailable: 0,
      stopReason: 'complete',
      remaining: false,
    };
    let cursor = options.cursor;
    for (let pageNumber = 0; pageNumber < options.maxPages; pageNumber += 1) {
      const page = await this.reconciler.reconcileBatch({
        ...(cursor === undefined ? {} : { cursor }),
        limit: options.pageSize,
      });
      total.pages += 1;
      total.scanned += page.scanned;
      total.claimed += page.claimed;
      total.verifiedSucceeded += page.verifiedSucceeded;
      total.verifiedFailed += page.verifiedFailed;
      total.deferred += page.deferred;
      total.manualRequired += page.manualRequired;
      total.executionActive += page.executionActive;
      total.alreadyResolved += page.alreadyResolved;
      total.unavailable += page.unavailable;
      if (!page.truncated) return Object.freeze(total);
      if (!page.nextCursor || sameRecoveryCursor(cursor, page.nextCursor)) {
        total.stopReason = 'cursor_stalled';
        total.remaining = true;
        if (page.nextCursor) total.nextCursor = { ...page.nextCursor };
        return Object.freeze(total);
      }
      cursor = { ...page.nextCursor };
      if (pageNumber === options.maxPages - 1) {
        total.stopReason = 'page_limit';
        total.remaining = true;
        total.nextCursor = cursor;
        return Object.freeze(total);
      }
    }
    return Object.freeze(total);
  }
}
