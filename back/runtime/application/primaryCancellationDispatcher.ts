import { v7 as uuidV7 } from 'uuid';
import type { CancellationDispatchResult } from '../domain/cancellationDispatch';
import { RUN_CANCELLATION_REASONS } from '../domain/run';
import type { CancellationDispatchRepository } from '../ports/cancellationDispatchRepository';
import type { PersistedExecutionController } from '../ports/persistedExecutionController';
import type {
  PrimaryCancellationAttemptReference,
  PrimaryCancellationCursor,
  PrimaryCancellationSource,
} from '../ports/primaryCancellationSource';

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;

export interface PrimaryCancellationDispatchSummary {
  scanned: number;
  claimed: number;
  terminationRequested: number;
  alreadyExited: number;
  pending: number;
  ambiguous: number;
  blocked: number;
  deferred: number;
  alreadyResolved: number;
  notEligible: number;
  failed: number;
  truncated: boolean;
  unsafeAttemptOverflow: boolean;
  nextCursor?: PrimaryCancellationCursor;
}

export interface PrimaryCancellationDispatcherOptions {
  owner: string;
  leaseDurationMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  createId?: () => string;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

/** One bounded pass. The caller owns scheduling and pagination. */
export class PrimaryCancellationDispatcher {
  private readonly controllers = new Map<
    PersistedExecutionController['executorType'],
    PersistedExecutionController
  >();
  private readonly owner: string;
  private readonly leaseDurationMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly createId: () => string;

  constructor(
    private readonly source: PrimaryCancellationSource,
    private readonly dispatches: CancellationDispatchRepository,
    controllers: readonly PersistedExecutionController[],
    options: PrimaryCancellationDispatcherOptions,
  ) {
    if (!options.owner || options.owner.length > 128) {
      throw new RangeError('owner must be between 1 and 128 characters');
    }
    this.owner = options.owner;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.createId = options.createId ?? uuidV7;
    assertPositiveInteger('leaseDurationMs', this.leaseDurationMs);
    assertPositiveInteger('retryBaseMs', this.retryBaseMs);
    assertPositiveInteger('retryMaxMs', this.retryMaxMs);
    if (this.retryMaxMs < this.retryBaseMs) {
      throw new RangeError(
        'retryMaxMs must be greater than or equal to retryBaseMs',
      );
    }

    for (const controller of controllers) {
      if (this.controllers.has(controller.executorType)) {
        throw new Error(
          `Duplicate persisted Executor controller: ${controller.executorType}`,
        );
      }
      this.controllers.set(controller.executorType, controller);
    }
  }

  async dispatchBatch(
    options: { cursor?: PrimaryCancellationCursor; limit?: number } = {},
  ): Promise<PrimaryCancellationDispatchSummary> {
    const page = await this.source.listCandidates(options);
    const summary: PrimaryCancellationDispatchSummary = {
      scanned: page.candidates.length,
      claimed: 0,
      terminationRequested: 0,
      alreadyExited: 0,
      pending: 0,
      ambiguous: 0,
      blocked: 0,
      deferred: 0,
      alreadyResolved: 0,
      notEligible: 0,
      failed: 0,
      truncated: page.truncated,
      unsafeAttemptOverflow: page.unsafeAttemptOverflow,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
    if (page.unsafeAttemptOverflow) return summary;

    for (const candidate of page.candidates) {
      if (!RUN_CANCELLATION_REASONS.includes(candidate.reason)) {
        summary.pending += 1;
        continue;
      }
      if (candidate.attempts.length === 0) {
        summary.pending += 1;
        continue;
      }
      if (candidate.attempts.length > 1) {
        summary.ambiguous += 1;
        summary.pending += 1;
        continue;
      }

      const attempt = candidate.attempts[0];
      let claim;
      try {
        claim = await this.dispatches.claim({
          runId: candidate.runId,
          attemptId: attempt.attemptId,
          requestedAtMs: candidate.requestedAtMs,
          owner: this.owner,
          leaseToken: this.createId(),
          leaseDurationMs: this.leaseDurationMs,
        });
      } catch {
        summary.failed += 1;
        summary.pending += 1;
        continue;
      }
      if (claim.status === 'not_eligible') {
        summary.notEligible += 1;
        continue;
      }
      if (claim.status === 'leased' || claim.status === 'not_due') {
        summary.deferred += 1;
        summary.pending += 1;
        continue;
      }
      if (claim.status === 'dispatched') {
        summary.alreadyResolved += 1;
        continue;
      }
      if (claim.status === 'blocked') {
        summary.alreadyResolved += 1;
        summary.blocked += 1;
        continue;
      }
      if (claim.status !== 'claimed') {
        summary.failed += 1;
        summary.pending += 1;
        continue;
      }

      summary.claimed += 1;
      await this.dispatchClaimed(
        candidate.reason,
        candidate.requestedAtMs,
        attempt,
        claim.dispatch,
        claim.leaseToken,
        summary,
      );
    }
    return summary;
  }

  private async dispatchClaimed(
    reason: (typeof RUN_CANCELLATION_REASONS)[number],
    requestedAtMs: number,
    attempt: PrimaryCancellationAttemptReference,
    dispatch: Extract<
      Awaited<ReturnType<CancellationDispatchRepository['claim']>>,
      { status: 'claimed' }
    >['dispatch'],
    leaseToken: string,
    summary: PrimaryCancellationDispatchSummary,
  ): Promise<void> {
    const controller = this.controllers.get(attempt.executorType);
    if (!controller) {
      await this.record(
        attempt,
        dispatch,
        leaseToken,
        'controller_missing',
        summary,
      );
      return;
    }
    if (!attempt.executorHandle) {
      await this.record(
        attempt,
        dispatch,
        leaseToken,
        'handle_missing',
        summary,
      );
      return;
    }

    try {
      const result = await controller.stop({
        durableHandle: attempt.executorHandle,
        ...(attempt.pid === undefined ? {} : { expectedPid: attempt.pid }),
        reason: {
          kind: reason,
          requestedAtMs,
        },
      });
      await this.record(attempt, dispatch, leaseToken, result.status, summary);
      if (result.status === 'termination_requested') {
        summary.terminationRequested += 1;
      } else if (result.status === 'already_exited') {
        summary.alreadyExited += 1;
      } else {
        summary.blocked += 1;
      }
    } catch {
      summary.failed += 1;
      await this.record(
        attempt,
        dispatch,
        leaseToken,
        'dispatch_error',
        summary,
      );
    }
  }

  private async record(
    attempt: PrimaryCancellationAttemptReference,
    dispatch: Extract<
      Awaited<ReturnType<CancellationDispatchRepository['claim']>>,
      { status: 'claimed' }
    >['dispatch'],
    leaseToken: string,
    result: CancellationDispatchResult,
    summary: PrimaryCancellationDispatchSummary,
  ): Promise<void> {
    const retryable = [
      'controller_missing',
      'handle_missing',
      'dispatch_error',
    ].includes(result);
    try {
      await this.dispatches.recordResult({
        runId: dispatch.runId,
        attemptId: attempt.attemptId,
        owner: this.owner,
        leaseToken,
        expectedVersion: dispatch.version,
        result,
        ...(retryable
          ? { retryDelayMs: this.nextRetryDelay(dispatch.dispatchCount) }
          : {}),
        eventId: this.createId(),
      });
      if (retryable) summary.pending += 1;
    } catch {
      summary.failed += 1;
      summary.pending += 1;
    }
  }

  private nextRetryDelay(dispatchCount: number): number {
    const exponent = Math.max(0, Math.min(dispatchCount - 1, 30));
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
  }
}
