import { v7 as uuidV7 } from 'uuid';
import {
  assertApprovedActionLeaseDuration,
  assertApprovedActionLeaseIdentity,
  assertApprovedActionPageSize,
  assertApprovedActionResultCode,
  type ApprovedActionDispatchCursor,
  type ApprovedActionDispatchExecutionRecord,
} from '../domain/approvedActionDispatchExecution';
import type { ApprovedActionHandler } from '../ports/approvedActionHandler';
import type { ApprovedActionDispatchRepository } from '../ports/approvedActionDispatchRepository';

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;

export interface ApprovedActionDispatcherOptions {
  owner: string;
  leaseDurationMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  clock?: () => number;
  createId?: () => string;
}

export interface ApprovedActionDispatchBatchSummary {
  scanned: number;
  claimed: number;
  started: number;
  succeeded: number;
  failed: number;
  blocked: number;
  retrying: number;
  deferred: number;
  recoveryRequired: number;
  alreadyTerminal: number;
  unavailable: number;
  truncated: boolean;
  nextCursor?: Readonly<ApprovedActionDispatchCursor>;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    keys.length === canonical.length &&
    keys.every((key, index) => key === canonical[index])
  );
}

export class ApprovedActionDispatcher {
  private readonly handlers = new Map<string, ApprovedActionHandler>();
  private readonly owner: string;
  private readonly leaseDurationMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly clock: () => number;
  private readonly createId: () => string;

  constructor(
    private readonly repository: ApprovedActionDispatchRepository,
    handlers: readonly ApprovedActionHandler[],
    options: ApprovedActionDispatcherOptions,
  ) {
    assertApprovedActionLeaseIdentity(options.owner);
    this.owner = options.owner;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.clock = options.clock ?? Date.now;
    this.createId = options.createId ?? uuidV7;
    assertApprovedActionLeaseDuration(this.leaseDurationMs);
    assertPositiveInteger('retryBaseMs', this.retryBaseMs);
    assertPositiveInteger('retryMaxMs', this.retryMaxMs);
    if (this.retryMaxMs < this.retryBaseMs) {
      throw new RangeError(
        'retryMaxMs must be greater than or equal to retryBaseMs',
      );
    }
    for (const handler of handlers) {
      if (
        !handler ||
        typeof handler !== 'object' ||
        typeof handler.actionType !== 'string' ||
        handler.actionType.length < 1 ||
        handler.actionType.length > 64 ||
        typeof handler.inspect !== 'function' ||
        typeof handler.execute !== 'function'
      ) {
        throw new TypeError('Approved action handler is invalid');
      }
      if (this.handlers.has(handler.actionType)) {
        throw new TypeError(
          `Duplicate approved action handler: ${handler.actionType}`,
        );
      }
      this.handlers.set(handler.actionType, handler);
    }
  }

  async dispatchBatch(
    options: { cursor?: ApprovedActionDispatchCursor; limit?: number } = {},
  ): Promise<Readonly<ApprovedActionDispatchBatchSummary>> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Approved action dispatch options must be an object');
    }
    if (
      !exactKeys(
        options,
        options.cursor === undefined && options.limit === undefined
          ? []
          : [
              ...(options.cursor === undefined ? [] : ['cursor']),
              ...(options.limit === undefined ? [] : ['limit']),
            ],
      )
    ) {
      throw new TypeError('Approved action dispatch options shape is invalid');
    }
    const limit = options.limit ?? 16;
    assertApprovedActionPageSize(limit);
    const observedAtMs = this.now();
    const page = await this.repository.listDue({
      nowMs: observedAtMs,
      limit,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    const summary: ApprovedActionDispatchBatchSummary = {
      scanned: page.dispatches.length,
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
      truncated: page.truncated,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
    for (const candidate of page.dispatches) {
      await this.dispatchOne(candidate.dispatch.id, summary);
    }
    return Object.freeze(summary);
  }

  private async dispatchOne(
    dispatchId: string,
    summary: ApprovedActionDispatchBatchSummary,
  ): Promise<void> {
    const claimedAtMs = this.now();
    let claim;
    try {
      claim = await this.repository.claim({
        dispatchId,
        owner: this.owner,
        leaseToken: this.createId(),
        nowMs: claimedAtMs,
        leaseDurationMs: this.leaseDurationMs,
      });
    } catch {
      summary.unavailable += 1;
      return;
    }
    if (claim.status === 'not_found') {
      summary.unavailable += 1;
      return;
    }
    if (claim.status !== 'claimed') {
      if (claim.status === 'recovery_required') summary.recoveryRequired += 1;
      else if (
        claim.status === 'succeeded' ||
        claim.status === 'failed' ||
        claim.status === 'blocked'
      ) {
        summary.alreadyTerminal += 1;
      } else summary.deferred += 1;
      return;
    }
    summary.claimed += 1;
    const handler = this.handlers.get(
      claim.snapshot.dispatch.action.actionType,
    );
    if (!handler) {
      await this.releasePreflight(
        claim.snapshot.execution,
        'handler_unavailable',
        true,
        summary,
      );
      return;
    }
    let inspection;
    try {
      inspection = await handler.inspect(claim.snapshot.dispatch);
      this.assertInspection(inspection);
    } catch {
      await this.releasePreflight(
        claim.snapshot.execution,
        'handler_inspection_failed',
        true,
        summary,
      );
      return;
    }
    if (inspection.status !== 'ready') {
      await this.releasePreflight(
        claim.snapshot.execution,
        inspection.resultCode,
        inspection.status === 'retry',
        summary,
      );
      return;
    }
    if (
      inspection.actionDigest !== claim.snapshot.dispatch.action.actionDigest
    ) {
      await this.releasePreflight(
        claim.snapshot.execution,
        'action_digest_mismatch',
        false,
        summary,
      );
      return;
    }

    let started;
    try {
      const startedAtMs = this.now();
      started = await this.repository.start({
        dispatchId,
        approvalRequestId: claim.snapshot.dispatch.approvalRequestId,
        actionDigest: inspection.actionDigest,
        owner: this.owner,
        leaseToken: claim.snapshot.execution.leaseToken!,
        expectedVersion: claim.snapshot.execution.version,
        startedAtMs,
      });
      summary.started += 1;
    } catch {
      summary.unavailable += 1;
      return;
    }

    let outcome: 'succeeded' | 'failed' | 'indeterminate';
    let resultCode: string;
    try {
      const result = await handler.execute(
        Object.freeze({
          dispatch: started.dispatch,
          execution: started.execution,
          idempotencyKey: started.dispatch.id,
          fence: Object.freeze({
            owner: this.owner,
            leaseToken: started.execution.leaseToken!,
            version: started.execution.version,
          }),
        }),
      );
      this.assertExecutionResult(result);
      outcome = result.outcome;
      resultCode = result.resultCode;
    } catch {
      outcome = 'indeterminate';
      resultCode = 'handler_failed_after_start';
    }
    try {
      const completed = await this.repository.complete({
        dispatchId,
        owner: this.owner,
        leaseToken: started.execution.leaseToken!,
        expectedVersion: started.execution.version,
        resultMutationId: this.createId(),
        outcome,
        resultCode,
        completedAtMs: this.now(),
      });
      if (completed.execution.status === 'succeeded') summary.succeeded += 1;
      else if (completed.execution.status === 'failed') summary.failed += 1;
      else summary.blocked += 1;
    } catch {
      summary.unavailable += 1;
      summary.recoveryRequired += 1;
    }
  }

  private async releasePreflight(
    execution: Readonly<ApprovedActionDispatchExecutionRecord>,
    resultCode: string,
    retry: boolean,
    summary: ApprovedActionDispatchBatchSummary,
  ): Promise<void> {
    try {
      const atMs = this.now();
      const released = await this.repository.releaseBeforeStart({
        dispatchId: execution.dispatchId,
        owner: this.owner,
        leaseToken: execution.leaseToken!,
        expectedVersion: execution.version,
        resultMutationId: this.createId(),
        resultCode,
        atMs,
        ...(retry
          ? { retryAtMs: this.nextRetryAt(atMs, execution.attemptCount) }
          : {}),
      });
      if (released.execution.status === 'retry_wait') summary.retrying += 1;
      else summary.blocked += 1;
    } catch {
      summary.unavailable += 1;
    }
  }

  private assertInspection(
    value: unknown,
  ): asserts value is Awaited<ReturnType<ApprovedActionHandler['inspect']>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Approved action inspection is invalid');
    }
    if (
      'status' in value &&
      value.status === 'ready' &&
      exactKeys(value, ['status', 'actionDigest']) &&
      'actionDigest' in value &&
      typeof value.actionDigest === 'string' &&
      /^[0-9a-f]{64}$/.test(value.actionDigest)
    ) {
      return;
    }
    if (
      'status' in value &&
      (value.status === 'retry' || value.status === 'blocked') &&
      exactKeys(value, ['status', 'resultCode']) &&
      'resultCode' in value &&
      typeof value.resultCode === 'string'
    ) {
      assertApprovedActionResultCode(value.resultCode);
      return;
    }
    throw new TypeError('Approved action inspection is invalid');
  }

  private assertExecutionResult(
    value: unknown,
  ): asserts value is Awaited<ReturnType<ApprovedActionHandler['execute']>> {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !exactKeys(value, ['outcome', 'resultCode']) ||
      !('outcome' in value) ||
      !['succeeded', 'failed', 'indeterminate'].includes(
        value.outcome as string,
      ) ||
      !('resultCode' in value) ||
      typeof value.resultCode !== 'string'
    ) {
      throw new TypeError('Approved action execution result is invalid');
    }
    assertApprovedActionResultCode(value.resultCode);
  }

  private nextRetryAt(atMs: number, attemptCount: number): number {
    const exponent = Math.max(0, Math.min(attemptCount - 1, 30));
    const delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
    return Math.min(Number.MAX_SAFE_INTEGER, atMs + delay);
  }

  private now(): number {
    const nowMs = this.clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RangeError('clock must return a non-negative safe integer');
    }
    return nowMs;
  }
}
