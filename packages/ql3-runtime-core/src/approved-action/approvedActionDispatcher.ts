import { randomUUID } from 'node:crypto';

import {
  approvedActionExecutionEffectiveStatus,
  type ApprovedActionExecutionCursor,
  type ApprovedActionExecutionRecord,
  type ApprovedActionExecutionRepository,
  type ApprovedActionExecutionSnapshot,
} from './approvedActionExecution';
import type { ApprovedActionDispatchRecord } from './approvedAction';

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const DEFAULT_BATCH_SIZE = 4;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESULT_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export type ApprovedActionHandlerInspection =
  | Readonly<{ status: 'ready'; actionDigest: string }>
  | Readonly<{ status: 'retry' | 'blocked'; resultCode: string }>;

export interface ApprovedActionHandlerExecutionContext {
  readonly dispatch: Readonly<ApprovedActionDispatchRecord>;
  readonly execution: Readonly<ApprovedActionExecutionRecord>;
  readonly idempotencyKey: string;
  readonly fence: Readonly<{
    owner: string;
    leaseToken: string;
    version: number;
  }>;
}

export interface ApprovedActionHandlerResult {
  readonly outcome: 'succeeded' | 'failed' | 'indeterminate';
  readonly resultCode: string;
  readonly resultDigest?: string;
}

export interface ApprovedActionHandler {
  readonly actionType: string;
  inspect(
    dispatch: Readonly<ApprovedActionDispatchRecord>,
  ): Promise<ApprovedActionHandlerInspection>;
  execute(
    context: Readonly<ApprovedActionHandlerExecutionContext>,
  ): Promise<Readonly<ApprovedActionHandlerResult>>;
}

export interface ApprovedActionDispatcherOptions {
  readonly owner: string;
  readonly leaseDurationMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly defaultBatchSize?: number;
  readonly clock?: () => number;
  readonly createId?: () => string;
}

export interface ApprovedActionDispatchBatchSummary {
  readonly scanned: number;
  readonly claimed: number;
  readonly started: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly blocked: number;
  readonly retrying: number;
  readonly deferred: number;
  readonly recoveryRequired: number;
  readonly alreadyTerminal: number;
  readonly unavailable: number;
  readonly truncated: boolean;
  readonly nextCursor?: Readonly<ApprovedActionExecutionCursor>;
}

interface MutableSummary {
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
  nextCursor?: Readonly<ApprovedActionExecutionCursor>;
}

function positiveInteger(
  value: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function identifier(value: string, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function resultCode(value: string): string {
  if (typeof value !== 'string' || !RESULT_CODE_PATTERN.test(value)) {
    throw new TypeError('Approved Action result code is invalid');
  }
  return value;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const required = new Set(expected);
  const allowed = new Set([...expected, ...optional]);
  const actual = Object.keys(value);
  return (
    expected.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => allowed.has(key)) &&
    [...required].length === expected.length
  );
}

function sameFence(
  snapshot: Readonly<ApprovedActionExecutionSnapshot>,
  owner: string,
  leaseToken: string,
  version: number,
): boolean {
  return (
    snapshot.execution.status === 'executing' &&
    snapshot.execution.leaseOwner === owner &&
    snapshot.execution.leaseToken === leaseToken &&
    snapshot.execution.version === version
  );
}

export class ApprovedActionDispatcher {
  readonly #handlers = new Map<string, ApprovedActionHandler>();
  readonly #owner: string;
  readonly #leaseDurationMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #defaultBatchSize: number;
  readonly #clock: () => number;
  readonly #createId: () => string;

  constructor(
    readonly repository: ApprovedActionExecutionRepository,
    handlers: readonly ApprovedActionHandler[],
    options: ApprovedActionDispatcherOptions,
  ) {
    if (
      !repository ||
      typeof repository.listDueExecutions !== 'function' ||
      typeof repository.claimExecution !== 'function' ||
      typeof repository.startExecution !== 'function' ||
      typeof repository.releaseExecutionBeforeStart !== 'function' ||
      typeof repository.completeExecution !== 'function' ||
      typeof repository.findExecutionByDispatchId !== 'function'
    ) {
      throw new TypeError('Approved Action execution repository is invalid');
    }
    if (!Array.isArray(handlers) || !options || typeof options !== 'object') {
      throw new TypeError('Approved Action dispatcher options are invalid');
    }
    this.#owner = identifier(options.owner, 'dispatcher owner');
    this.#leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      'lease duration',
      10 * 60 * 1000,
    );
    this.#retryBaseMs = positiveInteger(
      options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      'retry base',
    );
    this.#retryMaxMs = positiveInteger(
      options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
      'retry maximum',
    );
    if (this.#retryMaxMs < this.#retryBaseMs) {
      throw new RangeError('retry maximum precedes retry base');
    }
    this.#defaultBatchSize = positiveInteger(
      options.defaultBatchSize ?? DEFAULT_BATCH_SIZE,
      'default batch size',
      64,
    );
    this.#clock = options.clock ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    for (const handler of handlers) {
      if (
        !handler ||
        typeof handler !== 'object' ||
        typeof handler.actionType !== 'string' ||
        handler.actionType.length < 1 ||
        handler.actionType.length > 128 ||
        typeof handler.inspect !== 'function' ||
        typeof handler.execute !== 'function'
      ) {
        throw new TypeError('Approved Action handler is invalid');
      }
      if (this.#handlers.has(handler.actionType)) {
        throw new TypeError('Approved Action handler is duplicated');
      }
      this.#handlers.set(handler.actionType, handler);
    }
  }

  async dispatchBatch(
    options: Readonly<{
      cursor?: ApprovedActionExecutionCursor;
      limit?: number;
    }> = {},
  ): Promise<Readonly<ApprovedActionDispatchBatchSummary>> {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      !exactKeys(options, [], ['cursor', 'limit'])
    ) {
      throw new TypeError('Approved Action dispatch batch is invalid');
    }
    const limit = positiveInteger(
      options.limit ?? this.#defaultBatchSize,
      'batch size',
      64,
    );
    const page = await this.repository.listDueExecutions({
      nowMs: this.#now(),
      limit,
      actionTypes: Object.freeze([...this.#handlers.keys()].sort()),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    const summary: MutableSummary = {
      scanned: page.executions.length,
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
    for (const candidate of page.executions) {
      await this.#dispatchOne(candidate.dispatch.id, summary);
    }
    return Object.freeze({ ...summary });
  }

  async #dispatchOne(
    dispatchId: string,
    summary: MutableSummary,
  ): Promise<void> {
    const leaseToken = this.#id('lease token');
    let claim;
    try {
      claim = await this.repository.claimExecution({
        dispatchId,
        owner: this.#owner,
        leaseToken,
        nowMs: this.#now(),
        leaseDurationMs: this.#leaseDurationMs,
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
      if (claim.status === 'recovery_required') {
        summary.recoveryRequired += 1;
      } else if (
        claim.status === 'succeeded' ||
        claim.status === 'failed' ||
        claim.status === 'blocked'
      ) {
        summary.alreadyTerminal += 1;
      } else {
        summary.deferred += 1;
      }
      return;
    }
    summary.claimed += 1;
    const handler = this.#handlers.get(
      claim.snapshot.dispatch.action.actionType,
    );
    if (!handler) {
      await this.#release(
        claim.snapshot.execution,
        'handler_unavailable',
        false,
        summary,
      );
      return;
    }
    let inspection: ApprovedActionHandlerInspection;
    try {
      inspection = await handler.inspect(claim.snapshot.dispatch);
      this.#assertInspection(inspection);
    } catch {
      await this.#release(
        claim.snapshot.execution,
        'handler_inspection_failed',
        true,
        summary,
      );
      return;
    }
    if (inspection.status !== 'ready') {
      await this.#release(
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
      await this.#release(
        claim.snapshot.execution,
        'action_digest_mismatch',
        false,
        summary,
      );
      return;
    }

    let started: Readonly<ApprovedActionExecutionSnapshot>;
    try {
      started = await this.repository.startExecution({
        dispatchId,
        approvalRequestId: claim.snapshot.dispatch.approvalRequestId,
        actionDigest: inspection.actionDigest,
        owner: this.#owner,
        leaseToken,
        expectedVersion: claim.snapshot.execution.version,
        startedAtMs: this.#now(),
      });
    } catch {
      const converged = await this.#find(dispatchId);
      if (
        !converged ||
        !sameFence(
          converged,
          this.#owner,
          leaseToken,
          claim.snapshot.execution.version + 1,
        )
      ) {
        summary.unavailable += 1;
        if (
          converged?.execution.status === 'executing' ||
          (converged &&
            approvedActionExecutionEffectiveStatus(
              converged.execution,
              this.#now(),
            ) === 'recovery_required')
        ) {
          summary.recoveryRequired += 1;
        }
        return;
      }
      started = converged;
    }
    summary.started += 1;

    let result: Readonly<ApprovedActionHandlerResult>;
    try {
      result = await handler.execute(
        Object.freeze({
          dispatch: started.dispatch,
          execution: started.execution,
          idempotencyKey: started.dispatch.id,
          fence: Object.freeze({
            owner: this.#owner,
            leaseToken,
            version: started.execution.version,
          }),
        }),
      );
      this.#assertResult(result);
    } catch {
      result = Object.freeze({
        outcome: 'indeterminate',
        resultCode: 'handler_failed_after_start',
      });
    }

    const resultMutationId = this.#id('result mutation id');
    try {
      const completed = await this.repository.completeExecution({
        dispatchId,
        owner: this.#owner,
        leaseToken,
        expectedVersion: started.execution.version,
        resultMutationId,
        outcome: result.outcome,
        resultCode: result.resultCode,
        ...(result.resultDigest === undefined
          ? {}
          : { resultDigest: result.resultDigest }),
        completedAtMs: this.#now(),
      });
      this.#countCompletion(completed.execution, summary);
    } catch {
      const converged = await this.#find(dispatchId);
      if (
        converged &&
        converged.execution.resultMutationId === resultMutationId &&
        converged.execution.resultCode === result.resultCode &&
        converged.execution.resultDigest === (result.resultDigest ?? null)
      ) {
        this.#countCompletion(converged.execution, summary);
        return;
      }
      summary.unavailable += 1;
      summary.recoveryRequired += 1;
    }
  }

  async #release(
    execution: Readonly<ApprovedActionExecutionRecord>,
    code: string,
    retry: boolean,
    summary: MutableSummary,
  ): Promise<void> {
    const atMs = this.#now();
    try {
      const released = await this.repository.releaseExecutionBeforeStart({
        dispatchId: execution.dispatchId,
        owner: this.#owner,
        leaseToken: execution.leaseToken!,
        expectedVersion: execution.version,
        resultMutationId: this.#id('result mutation id'),
        resultCode: resultCode(code),
        atMs,
        ...(retry
          ? { retryAtMs: this.#nextRetryAt(atMs, execution.attemptCount) }
          : {}),
      });
      if (released.execution.status === 'retry_wait') summary.retrying += 1;
      else summary.blocked += 1;
    } catch {
      summary.unavailable += 1;
    }
  }

  async #find(
    dispatchId: string,
  ): Promise<Readonly<ApprovedActionExecutionSnapshot> | null> {
    try {
      return await this.repository.findExecutionByDispatchId(dispatchId);
    } catch {
      return null;
    }
  }

  #countCompletion(
    execution: Readonly<ApprovedActionExecutionRecord>,
    summary: MutableSummary,
  ): void {
    if (execution.status === 'succeeded') summary.succeeded += 1;
    else if (execution.status === 'failed') summary.failed += 1;
    else summary.blocked += 1;
  }

  #assertInspection(
    value: unknown,
  ): asserts value is ApprovedActionHandlerInspection {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Approved Action inspection is invalid');
    }
    if (
      'status' in value &&
      value.status === 'ready' &&
      exactKeys(value, ['status', 'actionDigest']) &&
      'actionDigest' in value &&
      typeof value.actionDigest === 'string' &&
      DIGEST_PATTERN.test(value.actionDigest)
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
      resultCode(value.resultCode);
      return;
    }
    throw new TypeError('Approved Action inspection is invalid');
  }

  #assertResult(value: unknown): asserts value is ApprovedActionHandlerResult {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !exactKeys(value, ['outcome', 'resultCode'], ['resultDigest']) ||
      !('outcome' in value) ||
      !['succeeded', 'failed', 'indeterminate'].includes(
        value.outcome as string,
      ) ||
      !('resultCode' in value) ||
      typeof value.resultCode !== 'string'
    ) {
      throw new TypeError('Approved Action result is invalid');
    }
    resultCode(value.resultCode);
    const digest =
      'resultDigest' in value ? (value.resultDigest as unknown) : undefined;
    if (
      (value.outcome === 'succeeded' &&
        (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest))) ||
      (value.outcome !== 'succeeded' && digest !== undefined)
    ) {
      throw new TypeError('Approved Action result digest is invalid');
    }
  }

  #nextRetryAt(atMs: number, attemptCount: number): number {
    const exponent = Math.max(0, Math.min(attemptCount - 1, 30));
    const delay = Math.min(
      this.#retryMaxMs,
      this.#retryBaseMs * 2 ** exponent,
    );
    return Math.min(Number.MAX_SAFE_INTEGER, atMs + delay);
  }

  #now(): number {
    const nowMs = this.#clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RangeError('Approved Action clock is invalid');
    }
    return nowMs;
  }

  #id(label: string): string {
    return identifier(this.#createId(), label);
  }
}
