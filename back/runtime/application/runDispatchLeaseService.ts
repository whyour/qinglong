import { v7 as uuidV7 } from 'uuid';
import {
  assertRunDispatchId,
  assertRunDispatchLeaseDuration,
  assertRunDispatchLeaseToken,
  assertRunDispatchLeaseVersion,
  assertRunDispatchWorkerFence,
  type RunDispatchReleaseReason,
} from '../domain/runDispatchLease';
import { assertWorkerId } from '../domain/worker';
import type {
  ClaimRunDispatchLeaseResult,
  ReleaseRunDispatchLeaseResult,
  RunDispatchLeaseRepository,
} from '../ports/runDispatchLeaseRepository';
import type { AuthenticatedWorkerPrincipal } from './workerControlService';
import { WorkerPrincipalMismatchError } from './workerControlService';

export interface RunDispatchLeaseServiceOptions {
  leaseDurationMs?: number;
  clock?: { now(): number };
  createEventId?: () => string;
}

export interface ClaimRunDispatchLeaseRequest {
  runId: string;
  attemptId: string;
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
  leaseToken: string;
}

export interface FencedRunDispatchLeaseRequest {
  attemptId: string;
  workerId: string;
  workerSessionId: string;
  workerGeneration: number;
  leaseGeneration: number;
  leaseToken: string;
  expectedVersion: number;
}

export interface ReleaseRunDispatchLeaseRequest
  extends FencedRunDispatchLeaseRequest {
  runId: string;
  reason: Exclude<RunDispatchReleaseReason, 'lease_expired'>;
}

export class RunDispatchLeaseService {
  private readonly leaseDurationMs: number;
  private readonly clock: { now(): number };
  private readonly createEventId: () => string;

  constructor(
    private readonly repository: RunDispatchLeaseRepository,
    options: RunDispatchLeaseServiceOptions = {},
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.clock = options.clock ?? Date;
    this.createEventId = options.createEventId ?? uuidV7;
    assertRunDispatchLeaseDuration(this.leaseDurationMs);
  }

  claim(
    principal: AuthenticatedWorkerPrincipal,
    request: ClaimRunDispatchLeaseRequest,
  ): Promise<ClaimRunDispatchLeaseResult> {
    this.assertPrincipal(principal, request.workerId);
    this.assertClaimRequest(request);
    return this.repository.claim({
      ...request,
      nowMs: this.now(),
      leaseDurationMs: this.leaseDurationMs,
      eventId: this.createEventId(),
    });
  }

  renew(
    principal: AuthenticatedWorkerPrincipal,
    request: FencedRunDispatchLeaseRequest,
  ) {
    this.assertPrincipal(principal, request.workerId);
    this.assertFenceRequest(request);
    return this.repository.renew({
      ...request,
      nowMs: this.now(),
      leaseDurationMs: this.leaseDurationMs,
    });
  }

  release(
    principal: AuthenticatedWorkerPrincipal,
    request: ReleaseRunDispatchLeaseRequest,
  ): Promise<ReleaseRunDispatchLeaseResult> {
    this.assertPrincipal(principal, request.workerId);
    this.assertFenceRequest(request);
    return this.repository.release({
      ...request,
      nowMs: this.now(),
      eventId: this.createEventId(),
    });
  }

  private now(): number {
    const nowMs = this.clock.now();
    assertRunDispatchLeaseVersion('nowMs', nowMs);
    return nowMs;
  }

  private assertPrincipal(
    principal: AuthenticatedWorkerPrincipal,
    workerId: string,
  ): void {
    assertWorkerId(principal.workerId);
    assertWorkerId(workerId);
    if (principal.workerId !== workerId) {
      throw new WorkerPrincipalMismatchError();
    }
  }

  private assertClaimRequest(request: ClaimRunDispatchLeaseRequest): void {
    assertRunDispatchId('runId', request.runId);
    assertRunDispatchId('attemptId', request.attemptId);
    assertRunDispatchWorkerFence(request);
    assertRunDispatchLeaseToken(request.leaseToken);
  }

  private assertFenceRequest(request: FencedRunDispatchLeaseRequest): void {
    assertRunDispatchId('attemptId', request.attemptId);
    assertRunDispatchWorkerFence(request);
    assertRunDispatchLeaseToken(request.leaseToken);
    assertRunDispatchLeaseVersion(
      'leaseGeneration',
      request.leaseGeneration,
      true,
    );
    assertRunDispatchLeaseVersion('expectedVersion', request.expectedVersion);
  }
}
