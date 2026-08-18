// Remote execution owns cancellation delivery to the Worker that already holds
// the exact RunDispatchLease. This layer adds no timer, queue, or connection.
import { randomUUID } from 'node:crypto';
import {
  MAX_CANCELLATION_DISPATCH_LEASE_MS,
  type CancellationDispatchRepository,
} from '@qinglong/runtime-core/cancellation-dispatch';
import {
  RemoteWorkerLeaseControlUnavailableError,
  type RemoteWorkerLeaseControlCommand,
  type RemoteWorkerLeaseControlResult,
} from '@qinglong/runtime-core/remote-worker-lease-control';

export type ClusterRemoteWorkerCancellationDispatchObservation = Readonly<{
  readonly status:
    | 'dispatched'
    | 'already_dispatched'
    | 'untracked'
    | 'deferred'
    | 'blocked';
}>;

export interface ClusterRemoteWorkerCancellationDispatchControlOptions {
  readonly ownerId: string;
  readonly leaseDurationMs?: number;
  readonly createLeaseToken?: () => string;
  readonly createEventId?: () => string;
  readonly onObservation?: (
    observation: ClusterRemoteWorkerCancellationDispatchObservation,
  ) => void | Promise<void>;
  readonly onDiagnostic?: (error: unknown) => void | Promise<void>;
}

export class ClusterRemoteWorkerCancellationDispatchError extends Error {
  readonly code = 'CLUSTER_REMOTE_CANCELLATION_DISPATCH_FAILED';

  constructor(
    readonly reason:
      | 'invalid_configuration'
      | 'claim_failed'
      | 'result_failed'
      | 'delivery_deferred'
      | 'delivery_blocked',
    options?: ErrorOptions,
  ) {
    super(`Cluster Remote Worker cancellation dispatch failed: ${reason}`, options);
    this.name = 'ClusterRemoteWorkerCancellationDispatchError';
  }
}

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OPTION_KEYS = new Set([
  'createEventId',
  'createLeaseToken',
  'leaseDurationMs',
  'onDiagnostic',
  'onObservation',
  'ownerId',
]);

function invalidConfiguration(): never {
  throw new ClusterRemoteWorkerCancellationDispatchError(
    'invalid_configuration',
  );
}

function capability(factory: () => string, name: string): string {
  let value: unknown;
  try {
    value = factory();
  } catch (error) {
    throw new ClusterRemoteWorkerCancellationDispatchError(
      'claim_failed',
      { cause: error },
    );
  }
  const maximum = name === 'eventId' ? 36 : 128;
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ClusterRemoteWorkerCancellationDispatchError('claim_failed');
  }
  return value;
}

/**
 * Converts the existing caller-driven Worker lease-control tick into the only
 * Cluster cancellation delivery path. A stop response is released only after
 * its durable CancellationDispatch is settled, while Workflow-scoped timeout
 * stops remain valid without forging a Run cancellation record.
 */
export class ClusterRemoteWorkerCancellationDispatchControl {
  private readonly ownerId: string;
  private readonly leaseDurationMs: number;
  private readonly createLeaseToken: () => string;
  private readonly createEventId: () => string;
  private readonly onObservation?: ClusterRemoteWorkerCancellationDispatchControlOptions['onObservation'];
  private readonly onDiagnostic?: ClusterRemoteWorkerCancellationDispatchControlOptions['onDiagnostic'];

  constructor(
    private readonly leaseControl: Readonly<{
      control(
        command: RemoteWorkerLeaseControlCommand,
      ): Promise<Readonly<RemoteWorkerLeaseControlResult>>;
    }>,
    private readonly dispatches: CancellationDispatchRepository,
    options: ClusterRemoteWorkerCancellationDispatchControlOptions,
  ) {
    if (
      typeof leaseControl?.control !== 'function' ||
      typeof dispatches?.claim !== 'function' ||
      typeof dispatches?.recordResult !== 'function' ||
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => !OPTION_KEYS.has(key)) ||
      !OWNER_PATTERN.test(options.ownerId ?? '') ||
      (options.leaseDurationMs !== undefined &&
        (!Number.isSafeInteger(options.leaseDurationMs) ||
          options.leaseDurationMs < 1 ||
          options.leaseDurationMs > MAX_CANCELLATION_DISPATCH_LEASE_MS)) ||
      (options.createLeaseToken !== undefined &&
        typeof options.createLeaseToken !== 'function') ||
      (options.createEventId !== undefined &&
        typeof options.createEventId !== 'function') ||
      (options.onObservation !== undefined &&
        typeof options.onObservation !== 'function') ||
      (options.onDiagnostic !== undefined &&
        typeof options.onDiagnostic !== 'function')
    ) {
      invalidConfiguration();
    }
    this.ownerId = options.ownerId;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.createLeaseToken = options.createLeaseToken ?? randomUUID;
    this.createEventId = options.createEventId ?? randomUUID;
    this.onObservation = options.onObservation;
    this.onDiagnostic = options.onDiagnostic;
  }

  async control(
    command: RemoteWorkerLeaseControlCommand,
  ): Promise<Readonly<RemoteWorkerLeaseControlResult>> {
    const result = await this.leaseControl.control(command);
    if (result.status !== 'stop_requested') return result;

    let claim: Awaited<ReturnType<CancellationDispatchRepository['claim']>>;
    try {
      claim = await this.dispatches.claim({
        runId: result.runId,
        attemptId: result.attemptId,
        requestedAtMs: result.stop!.requestedAtMs,
        owner: this.ownerId,
        leaseToken: capability(this.createLeaseToken, 'leaseToken'),
        leaseDurationMs: this.leaseDurationMs,
      });
    } catch (error) {
      return this.unavailable('claim_failed', error);
    }

    if (claim.status === 'not_eligible') {
      // Workflow Task timeout is represented by its own event and does not set
      // Run.cancel_requested_at_ms. The already-fenced Worker stop must remain
      // deliverable without inventing a Run-level cancellation fact.
      this.observe('untracked');
      return result;
    }
    if (claim.status === 'dispatched') {
      this.observe('already_dispatched');
      return result;
    }
    if (claim.status === 'leased' || claim.status === 'not_due') {
      this.observe('deferred');
      return this.unavailable('delivery_deferred');
    }
    if (claim.status === 'blocked') {
      this.observe('blocked');
      return this.unavailable('delivery_blocked');
    }
    if (claim.status !== 'claimed') {
      return this.unavailable('claim_failed');
    }

    try {
      const settled = await this.dispatches.recordResult({
        runId: result.runId,
        attemptId: result.attemptId,
        owner: this.ownerId,
        leaseToken: claim.leaseToken,
        expectedVersion: claim.dispatch.version,
        result: 'termination_requested',
        eventId: capability(this.createEventId, 'eventId'),
      });
      if (
        settled.dispatch.status !== 'dispatched' ||
        settled.dispatch.lastResult !== 'termination_requested' ||
        settled.event.type !== 'run.cancel_dispatched'
      ) {
        return this.unavailable('result_failed');
      }
    } catch (error) {
      return this.unavailable('result_failed', error);
    }
    this.observe('dispatched');
    return result;
  }

  private unavailable(
    reason: Exclude<
      ClusterRemoteWorkerCancellationDispatchError['reason'],
      'invalid_configuration'
    >,
    cause?: unknown,
  ): never {
    const error = new ClusterRemoteWorkerCancellationDispatchError(reason, {
      ...(cause === undefined ? {} : { cause }),
    });
    this.diagnostic(error);
    throw new RemoteWorkerLeaseControlUnavailableError({ cause: error });
  }

  private observe(
    status: ClusterRemoteWorkerCancellationDispatchObservation['status'],
  ): void {
    if (!this.onObservation) return;
    void Promise.resolve(
      this.onObservation(Object.freeze({ status })),
    ).catch(() => undefined);
  }

  private diagnostic(error: unknown): void {
    if (!this.onDiagnostic) return;
    void Promise.resolve(this.onDiagnostic(error)).catch(() => undefined);
  }
}
